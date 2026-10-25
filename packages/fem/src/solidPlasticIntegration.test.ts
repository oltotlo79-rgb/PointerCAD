import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { analyzeSolidPlastic, type PyodideRuntime } from './runtime.js';
import { analyzeSolidPlasticInBrowser } from './offlineBrowser.js';
import { readSolidPlasticPlan, SOLID_PLASTIC_PLAN_SCHEMA } from './solidPlastic.js';
import { SOLID_PLASTIC_INPUT_SCHEMA, solidPlasticInputSha256, type SolidPlasticInput } from './solidPlasticTranslation.js';
import { SOLID_PLASTIC_METHOD, SOLID_PLASTIC_RESULT_SCHEMA, SOLID_PLASTIC_SCOPE } from './solidPlasticResults.js';
import { decodeSolidPlastic, solidPlasticResultMatches } from './solidPlasticPublicResult.js';

vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({ file, bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })),
SOLID_PLASTIC_ASSETS: [{ file: 'solidPlasticAnalysis.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }],
NETGEN_ASSETS: [], SOLID_ASSETS: [] }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function input(revision = 1): SolidPlasticInput {
  return { schema: SOLID_PLASTIC_INPUT_SCHEMA, source: { documentId: 'plastic-contract', revision },
    plan: readSolidPlasticPlan({ schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa',
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [[0, 1, 2, 3]],
      material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
        source: { kind: 'user-supplied', reference: 'Contract fixture constants, not a standard material' } },
      prescribedMm: [{ node: 0, dof: 'x', valueMm: 0 }], forcesN: [], loadFactor: [0, 1, 0], stepsPerSegment: 2 }) };
}
/** Shape/ownership fixture only, not a native equilibrium or constitutive oracle. */
function raw() {
  return { schema: SOLID_PLASTIC_RESULT_SCHEMA, method: SOLID_PLASTIC_METHOD, scope: SOLID_PLASTIC_SCOPE,
    structuralCertification: false, yielded: false, records: [1, 0].map((loadFactor, index) => ({
      step: (index + 1) * 2, loadFactor, displacementMm: Array.from({ length: 4 }, () => [0, 0, 0]),
      elements: [{ stressMPa: [0, 0, 0, 0, 0, 0], strain: [0, 0, 0, 0, 0, 0], plasticStrain: [0, 0, 0, 0, 0, 0] }],
      freeResidualRatio: 0 })) };
}
function ports() {
  const workers: FemWorkerPort[] = [], requests: FemRequest[] = [], terminations: number[] = [];
  const client = new FemClient(() => {
    const index = workers.length;
    terminations.push(0);
    const port: FemWorkerPort = { postMessage: request => { requests.push(request); },
      terminate: () => { terminations[index] += 1; }, onmessage: null, onerror: null, onmessageerror: null };
    workers.push(port); return port;
  });
  return { client, workers, requests, terminations };
}
async function result(value = input()) { return decodeSolidPlastic(raw(), value, await solidPlasticInputSha256(value)); }
function reply(port: FemWorkerPort, request: FemRequest, value: unknown) {
  port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result: value } }));
}

describe('solid plastic public request and ownership', () => {
  it('dispatches the new mode and returns only a bound, validated result', async () => {
    const p = ports(), value = input(), answer = await result(value);
    const pending = p.client.analyzeSolidPlastic(value);
    expect(p.requests[0].kind).toBe('analyze-solid-plastic-tet4');
    expect(isRequest(p.requests[0])).toBe(true);
    expect(isRequest({ ...p.requests[0], identity: { ...p.requests[0].identity, revision: 0 } })).toBe(false);
    expect(isRequest({ ...p.requests[0], kind: 'analyze-solid-tet4' })).toBe(false);
    reply(p.workers[0], p.requests[0], answer);
    await expect(pending).resolves.toMatchObject({ kind: 'result', result: answer });
    expect(p.terminations).toEqual([1]); p.client.dispose();
  });

  it('copies the input before dispatch and hashing, including nested material provenance', async () => {
    const p = ports(), value = input(), answer = await result(value);
    const mutable = { ...value, source: { ...value.source }, plan: { ...value.plan, material: { ...value.plan.material,
      source: { ...value.plan.material.source } }, loadFactor: [...value.plan.loadFactor] } };
    const pending = p.client.analyzeSolidPlastic(mutable);
    mutable.source.revision = 9;
    mutable.plan.material.source.reference = 'changed after dispatch';
    mutable.plan.loadFactor[1] = 9;
    const request = p.requests[0];
    if (request.kind !== 'analyze-solid-plastic-tet4') throw new Error('Wrong dispatch');
    expect(request.input.source.revision).toBe(1);
    expect(request.input.plan.material.source.reference).toBe(value.plan.material.source.reference);
    expect(request.input.plan.loadFactor).toEqual([0, 1, 0]);
    reply(p.workers[0], request, answer);
    await expect(pending).resolves.toMatchObject({ kind: 'result' }); p.client.dispose();
  });

  it.each(['revision', 'hash', 'material', 'history', 'partial', 'nonfinite', 'unconverged', 'certification'] as const)('rejects %s output even with the current worker identity', async alteration => {
    const p = ports(), value = input(), answer = await result(value);
    const malformed = alteration === 'revision' ? { ...answer, input: input(2) }
      : alteration === 'hash' ? { ...answer, inputSha256: 'f'.repeat(64) }
      : alteration === 'material' ? { ...answer, input: { ...value, plan: { ...value.plan,
        material: { ...value.plan.material, hardeningModulusMPa: 3000 } } } }
      : alteration === 'history' ? { ...answer, records: [...answer.records].reverse() }
      : alteration === 'partial' ? { ...answer, records: answer.records.slice(0, 1) }
      : alteration === 'certification' ? { ...answer, structuralCertification: true }
      : { ...answer, records: answer.records.map((record, index) => index !== 0 ? record : { ...record,
        freeResidualRatio: alteration === 'nonfinite' ? Number.NaN : 1e-4 }) };
    const pending = p.client.analyzeSolidPlastic(value);
    reply(p.workers[0], p.requests[0], malformed);
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(p.terminations).toEqual([1]); p.client.dispose();
  });

  it('aborts while solving and ignores the captured callback, including delayed validation', async () => {
    const p = ports(), value = input(), answer = await result(value), controller = new AbortController();
    const pending = p.client.analyzeSolidPlastic(value, { signal: controller.signal });
    const callback = p.workers[0].onmessage, identity = p.requests[0].identity;
    callback?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity, phase: 'solving' } }));
    reply(p.workers[0], p.requests[0], answer);
    controller.abort();
    callback?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity, result: answer } }));
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(p.terminations).toEqual([1]); p.client.dispose();
  });

  it('supersedes both ways across qualification and plastic, then ignores the former callback', async () => {
    const p = ports(), answer = await result();
    const old = p.client.qualify('plastic-contract', 1);
    const plastic = p.client.analyzeSolidPlastic(input());
    await expect(old).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    const callback = p.workers[1].onmessage;
    const next = p.client.qualify('plastic-contract', 2);
    await expect(plastic).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    callback?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: p.requests[1].identity, result: answer } }));
    p.client.dispose(); await expect(next).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(p.terminations).toEqual([1, 1, 1]);
  });

  it('invalid replacements terminate the current request; an aborted signal creates no worker', async () => {
    const p = ports(), pending = p.client.analyzeSolidPlastic(input());
    await expect(p.client.analyzeSolidPlastic({ ...input(), plan: { ...input().plan, stepsPerSegment: 0 } })).rejects.toThrow('stepsPerSegment');
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    const controller = new AbortController(); controller.abort();
    await expect(p.client.analyzeSolidPlastic(input(), { signal: controller.signal })).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(p.workers).toHaveLength(1); expect(p.terminations).toEqual([1]); p.client.dispose();
  });

  it.each([false, true])('preserves the existing finite deadline (solving=%s)', async solving => {
    vi.useFakeTimers(); const p = ports(), pending = p.client.analyzeSolidPlastic(input());
    if (solving) p.workers[0].onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL,
      kind: 'phase', identity: p.requests[0].identity, phase: 'solving' } }));
    await vi.advanceTimersByTimeAsync(solving ? 60000 : 180000);
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'deadline' } });
    expect(p.terminations).toEqual([1]); p.client.dispose();
  });
});

describe('plastic runtime data and failure boundary (mock interpreter, not native qualification)', () => {
  function runtime(encoded: unknown) {
    const writes = new Map<string, string | Uint8Array>();
    const loadPackage = vi.fn<PyodideRuntime['loadPackage']>().mockResolvedValue(undefined);
    const runPython = vi.fn<PyodideRuntime['runPython']>().mockReturnValue(encoded);
    const instance: PyodideRuntime = { version: '0.29.3', FS: { mkdirTree: () => undefined,
      writeFile: (path, value) => { writes.set(path, value); } }, loadPackage, runPython };
    return { instance, writes, loadPackage, runPython };
  }
  const programs = { wrapper: Uint8Array.of(10), wheelLocation: '/fixed/oofem.whl' };
  it('writes the complete plan as JSON data and decodes the runtime output before returning', async () => {
    const r = runtime(JSON.stringify(raw())), value = input(), phases: string[] = [];
    const answer = await analyzeSolidPlastic(r.instance, value, programs, phase => { phases.push(phase); });
    expect(r.loadPackage).toHaveBeenCalledExactlyOnceWith('/fixed/oofem.whl', { checkIntegrity: true });
    const data = r.writes.get('/pcad_fem/solid-plastic-input.json');
    if (typeof data !== 'string') throw new Error('Missing input JSON');
    expect(JSON.parse(data)).toEqual(value.plan);
    expect(r.writes.get('/pcad_fem/solid_plastic_analysis.py')).toBe(programs.wrapper);
    expect(r.runPython).toHaveBeenCalledOnce();
    expect(phases).toEqual(['loading-packages', 'solving']);
    expect(solidPlasticResultMatches(answer, value, await solidPlasticInputSha256(value))).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: { documentId: 'plastic-contract',
      revision: 1, generation: 1, requestId: 'fem-1' }, result: answer })).toBe(true);
  });
  it.each([
    ['undefined', undefined], ['invalid JSON', '{'], ['oversized', 'x'.repeat(16000001)],
    ['incomplete', JSON.stringify({ ...raw(), records: [] })],
  ] as const)('refuses %s runtime output', async (_label, encoded) => {
    await expect(analyzeSolidPlastic(runtime(encoded).instance, input(), programs, () => undefined)).rejects.toThrow();
  });
  it('propagates an intermediate native exception without returning a partial history', async () => {
    const r = runtime(JSON.stringify(raw())), primary = new Error('step 3: no converged equilibrium');
    r.runPython.mockImplementation(() => { throw primary; });
    await expect(analyzeSolidPlastic(r.instance, input(), programs, () => undefined)).rejects.toBe(primary);
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s wrapper before any interpreter is created', async failure => {
    const phases: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => Promise.resolve(url.endsWith('/solidPlasticAnalysis.py')
        ? failure === 'missing' ? new Response(null, { status: 404 }) : new Response(Uint8Array.of(2))
        : new Response(Uint8Array.of(1))),
      importScripts: () => { throw new Error('No interpreter may start'); } });
    await expect(analyzeSolidPlasticInBrowser(input(), phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: solidPlasticAnalysis.py' : 'asset-corrupt: solidPlasticAnalysis.py');
    expect(phases).toEqual(['loading-assets']);
  });
});
