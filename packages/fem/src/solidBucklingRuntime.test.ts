import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { analyzeSolidBucklingInBrowser } from './offlineBrowser.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { analyzeSolidBuckling, type PyodideRuntime } from './runtime.js';
import type { SolidVector3 } from './solidAnalysisModel.js';
import type { SolidBucklingInput } from './solidBucklingModel.js';
import { isSolidBucklingResult, solidBucklingResultMatches } from './solidBucklingPublicResult.js';
import { decodeSolidBuckling } from './solidBucklingResults.js';
import { solidBucklingInputSha256 } from './solidBucklingTranslation.js';
import { singleTetBenchmark, singleTetLoadFactors } from './solidBuckling.testSupport.js';

// One verified byte (0x01) for every fixed asset; solidBuckling.py is the asset under test.
vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({
  file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
})), SOLID_BUCKLING_ASSETS: [{ file: 'solidBuckling.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] }));
afterEach(() => { vi.unstubAllGlobals(); });

function input(revision = 3, loadN = 1000): SolidBucklingInput {
  const base = singleTetBenchmark({ loadN });
  return { ...base, reference: { ...base.reference, source: { ...base.reference.source, revision } } };
}
/** Native reply built only from the independent closed-form benchmark (solidBuckling.testSupport.ts). */
function native(value = input(), loadN = 1000) {
  const [lowest, second] = singleTetLoadFactors({ loadN });
  const shape = (free: SolidVector3): SolidVector3[] => [[0, 0, 0], free, [0, 0, 0], [0, 0, 0]];
  return { schema: 'pointercad-solid-tet4-buckling-native/1', source: value.reference.source, freeDofs: 2,
    referenceEquilibriumResidual: 1e-14, maximumElementInitialStressError: 1e-14,
    modes: [{ number: 1, loadFactor: lowest, normalizedResidual: 1e-15, shape: shape([0, 1, 0]) },
      { number: 2, loadFactor: second, normalizedResidual: 1e-15, shape: shape([1, 0, 0]) }] };
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

describe('solid buckling client lifecycle', () => {
  it('refuses invalid input before any Worker exists', async () => {
    const { workers, fem } = client();
    await expect(fem.analyzeSolidBuckling({ ...input(), modeCount: 3 })).rejects.toThrow('solid-buckling-supports');
    await expect(fem.analyzeSolidBuckling({ ...input(), extra: 1 })).rejects.toThrow('unexpected fields');
    expect(workers).toHaveLength(0);
  });
  it('accepts the current decoded result and terminates the one-shot Worker', async () => {
    const { workers, fem } = client(), value = input();
    const result = decodeSolidBuckling(native(value), value, await solidBucklingInputSha256(value));
    const pending = fem.analyzeSolidBuckling(value);
    const worker = workers[0], request = worker.posted[0];
    expect(request.kind).toBe('analyze-solid-buckling-tet4');
    expect(isRequest(request)).toBe(true);
    worker.reply({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result });
    const completion = await pending;
    expect(completion.kind).toBe('result');
    if (completion.kind === 'result') expect(completion.result.modes.map(mode => mode.loadFactor)).toEqual(singleTetLoadFactors());
    expect(worker.terminated).toBe(1);
  });
  it('refuses a stale revision and a result computed for another load level', async () => {
    const value = input();
    const staleInput = input(2), stale = decodeSolidBuckling(native(staleInput), staleInput, await solidBucklingInputSha256(staleInput));
    const heavier = input(3, 2000);
    const otherLoad = decodeSolidBuckling(native(heavier, 2000), heavier, await solidBucklingInputSha256(heavier));
    for (const reply of [stale, otherLoad]) {
      const { workers, fem } = client();
      const pending = fem.analyzeSolidBuckling(value);
      const request = workers[0].posted[0];
      workers[0].reply({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result: reply });
      const completion = await pending;
      expect(completion.kind === 'failed' && completion.failure.code).toBe('invalid-protocol');
      expect(workers[0].terminated).toBe(1);
    }
  });
  it('reports a native refusal as a solver failure, cancels by abort and supersession', async () => {
    const { workers, fem } = client(), value = input();
    const controller = new AbortController();
    const first = fem.analyzeSolidBuckling(value, { signal: controller.signal });
    controller.abort();
    expect(await first).toMatchObject({ kind: 'cancelled', reason: 'abort' });
    const second = fem.analyzeSolidBuckling(value);
    const third = fem.analyzeSolidBuckling(value);
    expect(await second).toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    workers[2].reply({ protocol: FEM_PROTOCOL, kind: 'failure', identity: workers[2].posted[0].identity,
      failure: { code: 'solver-failed', message: 'solid-buckling-no-positive-mode: 0 positive load factor(s) for 2 requested' } });
    expect(await third).toMatchObject({ kind: 'failed', failure: { code: 'solver-failed' } });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1, 1]);
  });
});

describe('solid buckling runtime and protocol boundary', () => {
  function runtime(reply: unknown) {
    const calls: string[] = [], files = new Map<string, string | Uint8Array>();
    const fake: PyodideRuntime = { version: '0.29.3', FS: { mkdirTree: path => { calls.push(`mkdir ${path}`); },
      writeFile: (path, data) => { files.set(path, data); } },
    runPython: () => { calls.push('run'); return reply; },
    loadPackage: () => { calls.push('load'); return Promise.resolve(undefined); } };
    return { fake, calls, files };
  }
  const programs = { wrapper: Uint8Array.of(1), wheelLocation: 'https://pointercad.invalid/fem/assets/oofem.whl' };
  it('validates before loading packages and writes exactly the static reference plan and wrapper', async () => {
    const invalid = runtime(JSON.stringify(native()));
    await expect(analyzeSolidBuckling(invalid.fake, { ...input(), modeCount: 0 }, programs, () => undefined)).rejects.toThrow('solid-buckling-modes');
    expect(invalid.calls).toEqual([]);
    const valid = runtime(JSON.stringify(native()));
    const result = await analyzeSolidBuckling(valid.fake, input(), programs, () => undefined);
    expect(valid.calls).toEqual(['load', 'mkdir /pcad_fem', 'run']);
    const plan: unknown = JSON.parse(String(valid.files.get('/pcad_fem/solid-buckling-input.json')));
    expect(plan).toMatchObject({ schema: 'pointercad-solid-tet4-buckling-plan/1', freeDofs: 2,
      reference: { schema: 'pointercad-solid-tet4-plan/1', forcesN: [[0, 0, 0], [-1000, 0, 0], [0, 0, 0], [0, 0, 0]],
        fixed: [[true, true, true], [false, false, true], [true, true, true], [true, true, true]] } });
    expect(valid.files.get('/pcad_fem/solid_buckling.py')).toBe(programs.wrapper);
    expect(isSolidBucklingResult(result)).toBe(true);
    expect(solidBucklingResultMatches(result, input(), result.inputSha256)).toBe(true);
    expect(solidBucklingResultMatches({ ...result, freeDofs: 3 }, input(), result.inputSha256)).toBe(false);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: { documentId: 'solid-buckling-doc', revision: 3, generation: 1,
      requestId: 'fem-1' }, result })).toBe(true);
  });
  it.each([
    ['non-string reply', 42],
    ['oversize reply', 'x'.repeat(10_000_001)],
    ['tension-signed reply', JSON.stringify({ ...native(), modes: native().modes.map(mode => ({ ...mode, loadFactor: -mode.loadFactor })) })],
    ['unqualified initial-stress reply', JSON.stringify({ ...native(), maximumElementInitialStressError: 1e-6 })],
  ])('refuses a %s instead of returning a fallback', async (_name, reply) => {
    await expect(analyzeSolidBuckling(runtime(reply).fake, input(), programs, () => undefined)).rejects.toThrow();
  });
  it('refuses requests whose identity differs from the reference source or that carry extra fields', () => {
    const identity = { documentId: 'solid-buckling-doc', revision: 3, generation: 1, requestId: 'fem-1' };
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-buckling-tet4', identity, input: input() })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-buckling-tet4', identity: { ...identity, revision: 2 }, input: input() })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-buckling-tet4', identity, input: input(), extra: 1 })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-buckling-tet4', identity, input: { ...input(), modeCount: 0 } })).toBe(false);
  });
});

describe('solid buckling offline assets', () => {
  it.each(['missing', 'corrupt'] as const)('refuses a %s solidBuckling.py before any interpreter starts', async failure => {
    const phases: string[] = [], requested: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        requested.push(url);
        const wrapper = url.endsWith('/solidBuckling.py');
        return Promise.resolve(wrapper && failure === 'missing' ? new Response(null, { status: 404 })
          : new Response(Uint8Array.of(wrapper ? 2 : 1)));
      }, importScripts: () => { throw new Error('No native interpreter may start'); } });
    await expect(analyzeSolidBucklingInBrowser(input(), phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: solidBuckling.py' : 'asset-corrupt: solidBuckling.py');
    expect(phases).toEqual(['loading-assets']);
    expect(requested).toContain('https://pointercad.invalid/fem/assets/solidBuckling.py');
    expect(requested.every(url => url.startsWith('https://pointercad.invalid/fem/assets/'))).toBe(true);
  });
});
