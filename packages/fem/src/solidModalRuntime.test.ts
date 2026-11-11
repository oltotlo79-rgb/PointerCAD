import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { analyzeSolidModalInBrowser } from './offlineBrowser.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { analyzeSolidModal, type PyodideRuntime } from './runtime.js';
import type { SolidModalInput } from './solidModalModel.js';
import { isSolidModalResult, solidModalResultMatches } from './solidModalPublicResult.js';
import { decodeSolidModal } from './solidModalResults.js';
import { solidModalInputSha256 } from './solidModalTranslation.js';

// One verified byte (0x01) for every fixed asset; solidModal.py is the asset under test.
vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({
  file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
})), SOLID_MODAL_ASSETS: [{ file: 'solidModal.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const RHO = 7.85e-9;
const source = { documentId: 'doc', revision: 3, meshKey: 'tet:3' };
/** Unit tet (L = 10, nu = 0) with node 1 x and node 2 x free: K = diag(E L / 6, E L / 12),
 * M = rho V / 20 [[2, 1], [1, 2]], V = L^3 / 6, solved here in closed form. */
function input(revision = 3): SolidModalInput {
  return { schema: 'pointercad-solid-tet4-modal/1', source: { ...source, revision }, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }], modeCount: 2 };
}
function native(value = input()) {
  const volume = 1000 / 6, k1 = 205000 * 10 / 6, k2 = 205000 * 10 / 12, d = RHO * volume / 10, o = RHO * volume / 20;
  const a = d * d - o * o, b = d * (k1 + k2), root = Math.sqrt(b * b - 4 * a * k1 * k2);
  const larger = (b + root) / (2 * a);
  return { schema: 'pointercad-solid-tet4-modal-native/2', source: value.source, massMatrix: 'consistent', units: 'N-mm-MPa-t-s',
    modes: [k1 * k2 / (a * larger), larger].map((lambda, index) => {
      const v = [lambda * o, k1 - lambda * d], norm = Math.sqrt(d * v[0] * v[0] + 2 * o * v[0] * v[1] + d * v[1] * v[1]);
      return { number: index + 1, eigenvaluePerSecondSquared: lambda, frequencyHz: Math.sqrt(lambda) / (2 * Math.PI),
        normalizedResidual: 1e-15, massNormalizedShapePerSqrtT: [[0, 0, 0], [v[0] / norm, 0, 0], [v[1] / norm, 0, 0], [0, 0, 0]] };
    }),
    totalMassT: RHO * volume, rigidBodyModes: 0, freeDofs: 2, maximumMassOrthogonalityError: 1e-15,
    maximumRigidMotionResidual: 0, maximumElementMassError: 1e-15, reservedNumericBytes: 64256 };
}
class FakeWorker implements FemWorkerPort {
  readonly posted: FemRequest[] = [];
  terminated = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage(message: FemRequest): void { this.posted.push(message); }
  terminate(): void { this.terminated += 1; }
  reply(data: unknown): void { this.onmessage?.(new MessageEvent('message', { data })); }
}
function client() {
  const workers: FakeWorker[] = [];
  return { workers, fem: new FemClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }) };
}

describe('solid modal client lifecycle', () => {
  it('refuses invalid input before any Worker exists', async () => {
    const { workers, fem } = client();
    await expect(fem.analyzeSolidModal({ ...input(), modeCount: 3 })).rejects.toThrow('solid-modal-input');
    await expect(fem.analyzeSolidModal({ ...input(), extra: 1 })).rejects.toThrow('solid-input');
    expect(workers).toHaveLength(0);
  });
  it('accepts the current decoded result and terminates the one-shot Worker', async () => {
    const { workers, fem } = client(), value = input();
    const result = decodeSolidModal(native(value), value, await solidModalInputSha256(value));
    const phases: string[] = [];
    const pending = fem.analyzeSolidModal(value, { onPhase: phase => { phases.push(phase); } });
    const worker = workers[0], request = worker.posted[0];
    expect(request.kind).toBe('analyze-solid-modal-tet4');
    expect(isRequest(request)).toBe(true);
    worker.reply({ protocol: FEM_PROTOCOL, kind: 'phase', identity: request.identity, phase: 'solving' });
    worker.reply({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result });
    const completion = await pending;
    expect(completion.kind).toBe('result');
    if (completion.kind === 'result') expect(completion.result.modes[0].massNormalizedShapePerSqrtT[1][0]).toBe(result.modes[0].massNormalizedShapePerSqrtT[1][0]);
    expect(phases).toEqual(['solving']);
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
  });
  it('refuses a stale revision, a result for other material and a mismatched identity', async () => {
    const value = input();
    const staleInput = input(2), stale = decodeSolidModal(native(staleInput), staleInput, await solidModalInputSha256(staleInput));
    const heavy: SolidModalInput = { ...value, materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7851 }] };
    for (const reply of [stale, { ...decodeSolidModal(native(value), value, await solidModalInputSha256(value)), inputSha256: await solidModalInputSha256(heavy) }]) {
      const { workers, fem } = client();
      const pending = fem.analyzeSolidModal(value);
      const request = workers[0].posted[0];
      workers[0].reply({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result: reply });
      const completion = await pending;
      expect(completion.kind).toBe('failed');
      if (completion.kind === 'failed') expect(completion.failure.code).toBe('invalid-protocol');
      expect(workers[0].terminated).toBe(1);
    }
    const { workers, fem } = client();
    const pending = fem.analyzeSolidModal(value);
    const identity = { ...workers[0].posted[0].identity, generation: 99 };
    workers[0].reply({ protocol: FEM_PROTOCOL, kind: 'phase', identity, phase: 'solving' });
    const completion = await pending;
    expect(completion.kind === 'failed' && completion.failure.code).toBe('invalid-protocol');
  });
  it('cancels by abort and supersession, ignores the late reply and cleans up both Workers', async () => {
    const { workers, fem } = client(), value = input();
    const controller = new AbortController();
    const first = fem.analyzeSolidModal(value, { signal: controller.signal });
    controller.abort();
    expect(await first).toMatchObject({ kind: 'cancelled', reason: 'abort' });
    const second = fem.analyzeSolidModal(value);
    const third = fem.analyzeSolidModal(value);
    expect(await second).toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    const late = decodeSolidModal(native(value), value, await solidModalInputSha256(value));
    workers[1].reply({ protocol: FEM_PROTOCOL, kind: 'result', identity: workers[1].posted[0].identity, result: late });
    workers[2].reply({ protocol: FEM_PROTOCOL, kind: 'failure', identity: workers[2].posted[0].identity,
      failure: { code: 'solver-failed', message: 'solid-modal-mechanism: nonpositive or numerically unresolved elastic eigenvalue' } });
    expect(await third).toMatchObject({ kind: 'failed', failure: { code: 'solver-failed' } });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1, 1]);
    fem.dispose();
    expect(await fem.analyzeSolidModal(value)).toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
});

describe('solid modal runtime and protocol boundary', () => {
  function runtime(reply: unknown) {
    const calls: string[] = [], files = new Map<string, string | Uint8Array>();
    const fake: PyodideRuntime = { version: '0.29.3', FS: { mkdirTree: path => { calls.push(`mkdir ${path}`); },
      writeFile: (path, data) => { files.set(path, data); } },
    runPython: () => { calls.push('run'); return reply; },
    loadPackage: () => { calls.push('load'); return Promise.resolve(undefined); } };
    return { fake, calls, files };
  }
  const programs = { wrapper: Uint8Array.of(1), wheelLocation: 'https://pointercad.invalid/fem/assets/oofem.whl' };
  it('validates before loading packages and writes exactly the converted plan and wrapper', async () => {
    const invalid = runtime(JSON.stringify(native()));
    await expect(analyzeSolidModal(invalid.fake, { ...input(), nodes: [] }, programs, () => undefined)).rejects.toThrow('solid-input');
    expect(invalid.calls).toEqual([]);
    const valid = runtime(JSON.stringify(native()));
    const result = await analyzeSolidModal(valid.fake, input(), programs, () => undefined);
    expect(valid.calls).toEqual(['load', 'mkdir /pcad_fem', 'run']);
    const plan: unknown = JSON.parse(String(valid.files.get('/pcad_fem/solid-modal-input.json')));
    expect(plan).toMatchObject({ schema: 'pointercad-solid-tet4-modal-plan/2', source, materials: [{ densityTPerMm3: 7.85e-9 }] });
    expect(valid.files.get('/pcad_fem/solid_modal.py')).toBe(programs.wrapper);
    expect(isSolidModalResult(result)).toBe(true);
    expect(solidModalResultMatches(result, input(), result.inputSha256)).toBe(true);
    expect(solidModalResultMatches({ ...result, totalMassT: result.totalMassT * 1000 }, input(), result.inputSha256)).toBe(false);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: { documentId: 'doc', revision: 3, generation: 1, requestId: 'fem-1' }, result }))
      .toBe(true);
  });
  it.each([
    ['non-string reply', 42],
    ['oversize reply', 'x'.repeat(2_000_001)],
    ['physically wrong reply', JSON.stringify({ ...native(), totalMassT: 1 })],
  ])('refuses a %s instead of returning a fallback', async (_name, reply) => {
    await expect(analyzeSolidModal(runtime(reply).fake, input(), programs, () => undefined)).rejects.toThrow();
  });
  it('refuses requests whose identity differs from the input source or that carry extra fields', () => {
    const identity = { documentId: 'doc', revision: 3, generation: 1, requestId: 'fem-1' };
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-modal-tet4', identity, input: input() })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-modal-tet4', identity: { ...identity, revision: 2 }, input: input() })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-modal-tet4', identity, input: input(), extra: 1 })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-modal-tet4', identity, input: { ...input(), modeCount: 0 } })).toBe(false);
  });
});

describe('solid modal offline assets', () => {
  it.each(['missing', 'corrupt'] as const)('refuses a %s solidModal.py before any interpreter starts', async failure => {
    const phases: string[] = [], requested: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        requested.push(url);
        const modal = url.endsWith('/solidModal.py');
        return Promise.resolve(modal && failure === 'missing' ? new Response(null, { status: 404 })
          : new Response(Uint8Array.of(modal ? 2 : 1)));
      }, importScripts: () => { throw new Error('No native interpreter may start'); } });
    await expect(analyzeSolidModalInBrowser(input(), phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: solidModal.py' : 'asset-corrupt: solidModal.py');
    expect(phases).toEqual(['loading-assets']);
    expect(requested).toContain('https://pointercad.invalid/fem/assets/solidModal.py');
    expect(requested.every(url => url.startsWith('https://pointercad.invalid/fem/assets/'))).toBe(true);
  });
});
