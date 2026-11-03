import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { analyzeShellInBrowser } from './offlineBrowser.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemIdentity, type FemRequest } from './protocol.js';
import type { PyodideRuntime } from './runtime.js';
import type { ShellAnalysisInput, ShellFixed6, ShellVector3 } from './shellAnalysisModel.js';
import { SHELL_NATIVE_KIND, shellNativeResponseBound } from './shellBinding.js';
import { analyzeShellNative } from './shellRuntime.js';
import { translateShellAnalysis } from './shellTranslation.js';

// Mock lifecycle only: fake Worker, fake Pyodide and one verified byte (0x01) per asset. These cases check ownership,
// binding and refusal; they carry no native numbers. Native TR_SHELL02 evidence is cadShellAnalysis.test.ts.
vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({
  file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
})) }));
vi.mock('./shellAssets.js', () => ({ SHELL_ASSETS: [{ file: 'shellAnalysis.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] }));
afterEach(() => { vi.unstubAllGlobals(); });

const fixedAll: ShellFixed6 = [true, true, true, true, true, true];
/** One triangle, two fully fixed nodes and a transverse force on the third: a valid bounded plan. */
function input(): ShellAnalysisInput {
  return { schema: 'pointercad-shell-tri3/1', source: { documentId: 'doc-shell', revision: 4, meshKey: 'sheet:4' },
    units: 'N-mm-MPa-rad', surface: 'explicit-reference-surface', nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    elements: [{ nodes: [0, 1, 2], materialId: 'steel', thicknessMm: 2, offsetMm: 0 }],
    materials: [{ id: 'steel', youngMPa: 210000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: fixedAll }, { node: 1, fixed: fixedAll }],
    nodalLoads: [{ node: 2, forceN: [0, 0, -1], momentNmm: [0, 0, 0] }] };
}
/** Independent fingerprint (node:crypto, not the product hash helper) of the plan JSON exactly as written for the wrapper. */
function fingerprint(value: ShellAnalysisInput): string {
  return createHash('sha256').update(JSON.stringify(translateShellAnalysis(value).plan)).digest('hex');
}
/** Native-shaped answer for lifecycle cases only: structurally complete, never decoded here, no numerical meaning. */
function rawFor(value: ShellAnalysisInput): Record<string, unknown> {
  const six = [0, 0, 0, 0, 0, 0];
  const point = { xyzMm: [1, 1, 0], IST_ShellForceTensor: six, IST_ShellMomentTensor: six, IST_ShellStrainTensor: six,
    IST_CurvatureTensor: six };
  return { schema: 'pointercad-shell-tri3-native/1', source: value.source, elementRecord: 'tr_shell02',
    elementClasses: value.elements.map(() => 'TR_SHELL02'), crossSectionClasses: value.elements.map(() => 'SimpleCrossSection'),
    displacement: value.nodes.map(() => six), reactions: value.nodes.map(() => six), freeResidualRelative: 0, balanceRelative: 0,
    minimumScaledPivot: 1, refactorizationDifferenceRelative: 0, integrationPoints: value.elements.map(() => [point, point, point, point]) };
}
/** The Worker's answer for `solved` (its fingerprint) carrying `raw`. */
function wire(solved: ShellAnalysisInput, raw: unknown = rawFor(solved)): { kind: typeof SHELL_NATIVE_KIND; planSha256: string; raw: unknown } {
  return { kind: SHELL_NATIVE_KIND, planSha256: fingerprint(solved), raw };
}
const resultMessage = (identity: FemIdentity, result: unknown): unknown => ({ protocol: FEM_PROTOCOL, kind: 'result', identity, result });
const doubled = (v: ShellVector3): ShellVector3 => [2 * v[0], 2 * v[1], 2 * v[2]];

class FakeWorker implements FemWorkerPort {
  readonly posted: FemRequest[] = [];
  terminated = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage(message: FemRequest): void { this.posted.push(structuredClone(message)); }
  terminate(): void { this.terminated += 1; }
  reply(data: unknown): void { this.onmessage?.(new MessageEvent('message', { data: structuredClone(data) })); }
}
function client(): { workers: FakeWorker[]; fem: FemClient } {
  const workers: FakeWorker[] = [];
  return { workers, fem: new FemClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }) };
}

describe('shell client lifecycle: one owned request, its full-input fingerprint, one Worker', () => {
  it('refuses invalid input before any Worker, supersedes the earlier request, and the Worker admission refuses it too', async () => {
    const { workers, fem } = client();
    try {
      const previous = fem.analyzeShell(input());
      await expect(fem.analyzeShell({ ...input(), elements: [{ nodes: [0, 1, 2], materialId: 'steel', thicknessMm: 2, offsetMm: 1 }] }))
        .rejects.toThrow('shell-offset');
      await expect(fem.analyzeShell({ ...input(), extra: 1 })).rejects.toThrow('shell-input');
      await expect(previous).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      expect(workers).toHaveLength(1);
      expect(workers[0].terminated).toBe(1);
    } finally { fem.dispose(); }
    const identity: FemIdentity = { documentId: 'doc-shell', revision: 4, generation: 1, requestId: 'fem-1' };
    const request = (value: unknown, at: FemIdentity): unknown => ({ protocol: FEM_PROTOCOL, kind: 'analyze-shell-tr-shell02', identity: at, input: value });
    expect(isRequest(request(input(), identity))).toBe(true);
    expect(isRequest(request({ ...input(), units: 'm' }, identity))).toBe(false);
    expect(isRequest(request(input(), { ...identity, revision: 3 }))).toBe(false);
  });

  it('accepts the answer for the exact same full input (control) and terminates the one-shot Worker', async () => {
    const { workers, fem } = client(), value = input(), phases: string[] = [];
    try {
      const pending = fem.analyzeShell(value, { onPhase: phase => { phases.push(phase); } });
      const [worker] = workers, request = worker.posted[0];
      if (request?.kind !== 'analyze-shell-tr-shell02') throw new Error('Missing shell Worker request');
      expect(isRequest(request)).toBe(true);
      expect(request.input).toEqual(value);
      worker.reply({ protocol: FEM_PROTOCOL, kind: 'phase', identity: request.identity, phase: 'solving' });
      const answer = wire(structuredClone(value));
      expect(isReply(resultMessage(request.identity, answer))).toBe(true);
      worker.reply(resultMessage(request.identity, answer));
      await expect(pending).resolves.toEqual({ kind: 'result', identity: request.identity, result: answer });
      expect(phases).toEqual(['solving']);
      expect(worker.terminated).toBe(1);
      expect(worker.onmessage).toBeNull();
    } finally { fem.dispose(); }
  });

  const refused: [string, (identity: FemIdentity, value: ShellAnalysisInput) => unknown][] = [
    ['the same source and counts with only the material changed', (identity, value) => resultMessage(identity,
      wire({ ...value, materials: value.materials.map(m => ({ ...m, youngMPa: 2 * m.youngMPa })) }, rawFor(value)))],
    ['the same source and counts with only the loads changed', (identity, value) => resultMessage(identity,
      wire({ ...value, nodalLoads: value.nodalLoads.map(load => ({ ...load, forceN: doubled(load.forceN) })) }, rawFor(value)))],
    ['an answer for an older revision', (identity, value) => resultMessage({ ...identity, revision: identity.revision - 1 }, wire(value))],
    ['an answer for another mesh', (identity, value) => resultMessage(identity,
      wire(value, { ...rawFor(value), source: { ...value.source, meshKey: 'other-mesh' } }))],
    ['an answer with another node count', (identity, value) => resultMessage(identity,
      wire(value, { ...rawFor(value), displacement: [[0, 0, 0, 0, 0, 0]] }))],
    ['a decoded result posed as raw', (identity, value) => resultMessage(identity, wire(value, { schema: 'pointercad-shell-tri3-result/1',
      source: value.source, element: { record: 'tr_shell02', className: 'TR_SHELL02', crossSection: 'SimpleCrossSection' },
      displacement: [], reactions: [], checks: {}, elements: [], recovery: {} }))],
    ['an answer without a native field', (identity, value) => resultMessage(identity,
      wire(value, Object.fromEntries(Object.entries(rawFor(value)).filter(([key]) => key !== 'reactions'))))],
    ['a malformed fingerprint', (identity, value) => resultMessage(identity, { ...wire(value), planSha256: 'not-a-digest' })],
  ];
  it.each(refused)('refuses %s and terminates the one Worker', async (_, answer) => {
    const { workers, fem } = client(), value = input();
    try {
      const pending = fem.analyzeShell(value), [worker] = workers;
      worker.reply(answer(worker.posted[0].identity, value));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
      expect(worker.terminated).toBe(1);
    } finally { fem.dispose(); }
  });

  it('keeps the first of duplicate answers and ignores replies after completion', async () => {
    const { workers, fem } = client(), value = input();
    try {
      const pending = fem.analyzeShell(value), [worker] = workers, identity = worker.posted[0].identity, answer = wire(value);
      worker.reply(resultMessage(identity, answer));
      worker.reply(resultMessage(identity, answer));
      await expect(pending).resolves.toMatchObject({ kind: 'result', result: answer });
      worker.reply(resultMessage(identity, wire(value, { ...rawFor(value), source: { ...value.source, meshKey: 'late' } })));
      expect(worker.terminated).toBe(1);
      expect(worker.onmessage).toBeNull();
    } finally { fem.dispose(); }
  });

  it('abort, supersession and dispose cancel and terminate; failure reply, message error and Worker creation are coded', async () => {
    const { workers, fem } = client(), control = new AbortController();
    try {
      const aborted = fem.analyzeShell(input(), { signal: control.signal });
      control.abort();
      await expect(aborted).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      const superseded = fem.analyzeShell(input());
      const failing = fem.analyzeShell(input());
      await expect(superseded).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      workers[2].reply({ protocol: FEM_PROTOCOL, kind: 'failure', identity: workers[2].posted[0].identity,
        failure: { code: 'solver-failed', message: 'shell-native: inconsistent native model' } });
      await expect(failing).resolves.toMatchObject({ kind: 'failed', failure: { code: 'solver-failed' } });
      const undecodable = fem.analyzeShell(input());
      workers[3].onmessageerror?.(new MessageEvent<unknown>('messageerror'));
      await expect(undecodable).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
      const disposed = fem.analyzeShell(input());
      fem.dispose();
      await expect(disposed).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
      expect(workers.map(worker => worker.terminated)).toEqual([1, 1, 1, 1, 1]);
    } finally { fem.dispose(); }
    const unborn = new FemClient(() => { throw new Error('Worker creation failed'); });
    try {
      await expect(unborn.analyzeShell(input())).resolves.toMatchObject({ kind: 'failed', failure: { code: 'worker-failed' } });
    } finally { unborn.dispose(); }
  });
});

class FakeRuntime implements PyodideRuntime {
  readonly version = '0.29.3';
  readonly files = new Map<string, string | Uint8Array>();
  readonly python: string[] = [];
  readonly packages: unknown[] = [];
  readonly FS = { mkdirTree: (): void => undefined,
    writeFile: (path: string, value: string | Uint8Array): void => { this.files.set(path, value); } };
  constructor(private readonly answer: () => unknown) {}
  runPython(source: string): unknown { this.python.push(source); return this.answer(); }
  loadPackage(packages: string | readonly string[], options?: { readonly checkIntegrity: boolean }): Promise<unknown> {
    this.packages.push([packages, options]);
    return Promise.resolve(undefined);
  }
}

describe('shell runtime: fixed wrapper, plan as JSON data, bounded answer returned undecoded (fake Pyodide)', () => {
  const wrapper = Uint8Array.of(35, 32, 102, 105, 120, 101, 100);
  const programs = { wrapper, wheelLocation: 'app://pointercad/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl' };
  it('writes only the plan JSON and the wrapper, runs fixed Python and fingerprints the full input it solved', async () => {
    const value: ShellAnalysisInput = { ...input(), source: { documentId: "doc'''\nimport os", revision: 4, meshKey: 'sheet:4' } };
    const runtime = new FakeRuntime(() => JSON.stringify(rawFor(value))), phases: string[] = [];
    const result = await analyzeShellNative(runtime, value, programs, phase => { phases.push(phase); });
    expect(phases).toEqual(['loading-packages', 'solving']);
    expect(runtime.packages).toEqual([[programs.wheelLocation, { checkIntegrity: true }]]);
    expect([...runtime.files.keys()]).toEqual(['/pcad_fem/shell-input.json', '/pcad_fem/shell_analysis.py']);
    expect(runtime.files.get('/pcad_fem/shell-input.json')).toBe(JSON.stringify(translateShellAnalysis(value).plan));
    expect(runtime.files.get('/pcad_fem/shell_analysis.py')).toBe(wrapper);
    expect(runtime.python).toHaveLength(1);
    expect(runtime.python[0]).toContain('from shell_analysis import run_shell_analysis');
    expect(runtime.python[0]).not.toContain('import os');
    expect(result).toEqual({ kind: SHELL_NATIVE_KIND, planSha256: fingerprint(value), raw: rawFor(value) });
  });
  it('refuses invalid input before loading packages, and an over-long or foreign answer after the run', async () => {
    const idle = new FakeRuntime(() => { throw new Error('The wrapper must not run'); });
    await expect(analyzeShellNative(idle, { ...input(), units: 'm' }, programs, () => undefined)).rejects.toThrow('shell-input');
    expect(idle.packages).toHaveLength(0);
    expect(idle.files.size).toBe(0);
    const value = input(), bound = shellNativeResponseBound(translateShellAnalysis(value).input);
    await expect(analyzeShellNative(new FakeRuntime(() => ' '.repeat(bound + 1)), value, programs, () => undefined))
      .rejects.toThrow('Invalid bounded shell response');
    await expect(analyzeShellNative(new FakeRuntime(() => JSON.stringify({ ...rawFor(value), source: { ...value.source, revision: 3 } })),
      value, programs, () => undefined)).rejects.toThrow('shell-native:');
  });
});

describe('shell offline boundary: input before assets, exactly the runtime and the fixed shell wrapper', () => {
  it('refuses invalid shell input before origin, assets or native initialization', async () => {
    const read = vi.fn(() => { throw new Error('Asset origin must not be read'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    const phases: string[] = [];
    const offset = { ...input(), elements: [{ nodes: [0, 1, 2], materialId: 'steel', thicknessMm: 2, offsetMm: 0.5 }] };
    await expect(analyzeShellInBrowser(offset, phase => { phases.push(phase); })).rejects.toThrow('shell-offset');
    await expect(analyzeShellInBrowser({}, phase => { phases.push(phase); })).rejects.toThrow('shell-input');
    expect(read).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
  });
  it.each(['missing', 'corrupt'] as const)('requests only FEM_ASSETS and shellAnalysis.py and refuses a %s wrapper before interpreter creation', async failure => {
    const phases: string[] = [], requested: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        requested.push(url);
        const shell = url.endsWith('/shellAnalysis.py');
        return Promise.resolve(shell && failure === 'missing' ? new Response(null, { status: 404 })
          : new Response(Uint8Array.of(shell ? 2 : 1)));
      }, importScripts: () => { throw new Error('No native interpreter may start'); } });
    await expect(analyzeShellInBrowser(input(), phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: shellAnalysis.py' : 'asset-corrupt: shellAnalysis.py');
    expect(phases).toEqual(['loading-assets']);
    expect(requested).toEqual(['pyodide.mjs', 'pyodide.asm.js', 'shellAnalysis.py'].map(file => 'https://pointercad.invalid/fem/assets/' + file));
  });
});
