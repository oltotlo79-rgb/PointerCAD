import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { PLASTIC_BAR_PLAN_SCHEMA, PLASTIC_BAR_RESULT_SCHEMA, plasticBarReference, type PlasticBarPlan } from './plasticBar.js';
import { PLASTIC_BAR_INPUT_SCHEMA, plasticBarInputSha256, translatePlasticBar,
  type PlasticBarInput } from './plasticBarTranslation.js';
import { decodePlasticBar, isPlasticBarResult, PLASTIC_BAR_METHOD, PLASTIC_BAR_SCOPE, plasticBarResultMatches,
  readPlasticBarNative } from './plasticBarResults.js';

/** Benchmark constants stated for this test only (not a steel grade): E 200 GPa, sigma0 250 MPa, H 2 GPa. */
function plan(knots: readonly number[] = [0, 2.5e-3, 0, -2.5e-3, 0], stepsPerSegment = 1): PlasticBarPlan {
  return { schema: PLASTIC_BAR_PLAN_SCHEMA, lengthM: 1, areaM2: 1e-4,
    material: { youngPa: 200e9, poisson: 0.3, yieldStressPa: 250e6, hardeningModulusPa: 2e9,
      source: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' } },
    endDisplacementM: [...knots], stepsPerSegment };
}
function input(revision = 3, barPlan: PlasticBarPlan = plan()): PlasticBarInput {
  return { schema: PLASTIC_BAR_INPUT_SCHEMA, source: { documentId: 'plastic-bar-fixture', revision }, plan: barPlan };
}
interface RawSample {
  step: number; targetDisplacementM: number; endDisplacementM: number; strain: number; stressPa: number;
  plasticStrain: number; axialForceN: number;
}
/** Protocol-shaped runner output built from the reference: a shape fixture, explicitly not a native oracle. */
function rawSamples(barPlan: PlasticBarPlan): RawSample[] {
  return plasticBarReference(barPlan).map(sample => ({ step: sample.step, targetDisplacementM: sample.endDisplacementM,
    endDisplacementM: sample.endDisplacementM, strain: sample.strain, stressPa: sample.stressPa,
    plasticStrain: sample.plasticStrain, axialForceN: sample.axialForceN }));
}
/** The same aggregate rules as the runner: yielded and the scaled equilibrium mismatch are derived from samples. */
function rawFrom(samples: readonly RawSample[], barPlan: PlasticBarPlan = plan()): Record<string, unknown> {
  const area = barPlan.areaM2;
  const mismatch = samples.reduce((max, s) => Math.max(max, Math.abs(s.axialForceN - s.stressPa * area)), 0)
    / (barPlan.material.yieldStressPa * area);
  return { schema: PLASTIC_BAR_RESULT_SCHEMA, method: PLASTIC_BAR_METHOD, scope: PLASTIC_BAR_SCOPE,
    structuralCertification: false, samples: samples.map(s => ({ ...s })),
    yielded: samples.some(s => s.plasticStrain !== 0), maximumEquilibriumMismatch: mismatch };
}
function withSample(index: number, change: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const samples: Record<string, unknown>[] = rawSamples(plan()).map(s => ({ ...s }));
  samples[index] = { ...samples[index], ...change };
  const raw = rawFrom(rawSamples(plan()));
  return { ...raw, samples };
}

describe('strict plastic-bar result reader (used before any comparison)', () => {
  it('accepts the protocol-shaped fixture and reports zero reference deviation', () => {
    const read = readPlasticBarNative(rawFrom(rawSamples(plan())), plan());
    expect(read.samples).toHaveLength(4);
    expect(read.yielded).toBe(true);
    expect(read.referenceDeviation).toEqual({ stress: 0, plasticStrain: 0, force: 0, displacement: 0, strain: 0 });
  });

  it('rejects empty, non-finite, mistyped, extra, missing, miscounted and misnumbered output', () => {
    const base = rawFrom(rawSamples(plan()));
    const short = rawSamples(plan()).slice(0, 3);
    // Length 4 with index 2 never assigned (a hole), without `delete` on an array.
    const holey = new Array<unknown>(4);
    for (const index of [0, 1, 3]) holey[index] = rawSamples(plan())[index];
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['not an object', null, 'result must be an object'],
      ['empty samples', { ...base, samples: [] }, 'non-empty dense array'],
      ['holey samples', { ...base, samples: holey }, 'non-empty dense array'],
      ['one sample short', rawFrom(short), 'expected 4 samples, received 3'],
      ['NaN stress', withSample(1, { stressPa: Number.NaN }), 'samples[1].stressPa must be a finite number'],
      ['Infinity force', withSample(2, { axialForceN: Number.POSITIVE_INFINITY }), 'samples[2].axialForceN must be a finite number'],
      ['negative infinity strain', withSample(0, { strain: Number.NEGATIVE_INFINITY }), 'samples[0].strain must be a finite number'],
      ['numeric string', withSample(0, { plasticStrain: '0.001' }), 'samples[0].plasticStrain must be a finite number'],
      ['misnumbered step', withSample(3, { step: 3 }), 'samples[3].step must be 4'],
      ['target off schedule', withSample(1, { targetDisplacementM: 1e-3 }), 'differs from the plan schedule'],
      ['extra sample field', withSample(0, { note: 'x' }), 'must have exactly the fields'],
      ['missing top field', Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'yielded')), 'must have exactly the fields'],
      ['extra top field', { ...base, warnings: [] }, 'must have exactly the fields'],
      ['wrong schema', { ...base, schema: 'pointercad-oofem-plastic-bar-result/2' }, 'unsupported result schema'],
      ['wrong method', { ...base, method: 'local-return-mapping' }, 'unexpected method'],
      ['certification claim', { ...base, structuralCertification: true }, 'structuralCertification must be false'],
      ['yielded flag denies yielding', { ...base, yielded: false }, 'yielded must state'],
      ['tampered equilibrium measure', { ...base, maximumEquilibriumMismatch: 0.5e-8 }, 'does not match the samples'],
      ['NaN equilibrium measure', { ...base, maximumEquilibriumMismatch: Number.NaN }, 'maximumEquilibriumMismatch must be a finite number'],
    ];
    for (const [label, value, message] of cases) {
      expect(() => readPlasticBarNative(value, plan()), label).toThrow(message);
    }
  });

  it('rejects an elastic-only response that never yields (for example a linear material in place of MisesMat)', () => {
    const barPlan = plan();
    const elastic = rawSamples(barPlan).map(s => ({ ...s, stressPa: 200e9 * s.strain, plasticStrain: 0,
      axialForceN: 200e9 * s.strain * barPlan.areaM2 }));
    expect(() => readPlasticBarNative(rawFrom(elastic), barPlan)).toThrow('stress deviates from the independent reference');
  });

  it('applies the stated 1e-8 stress bound without loosening: 0.5e-8 sigma0 passes, 2e-8 sigma0 fails', () => {
    const barPlan = plan();
    const shifted = (fraction: number) => rawFrom(rawSamples(barPlan).map((s, index) => index !== 2 ? s : {
      ...s, stressPa: s.stressPa + fraction * 250e6, axialForceN: (s.stressPa + fraction * 250e6) * barPlan.areaM2 }));
    expect(readPlasticBarNative(shifted(0.5e-8), barPlan).referenceDeviation.stress).toBeLessThanOrEqual(1e-8);
    expect(() => readPlasticBarNative(shifted(2e-8), barPlan)).toThrow('stress deviates');
  });

  it('rejects a force that disagrees with stress x area beyond 1e-8 even when the stress matches', () => {
    const barPlan = plan();
    const samples = rawSamples(barPlan).map((s, index) => index !== 0 ? s : { ...s, axialForceN: s.axialForceN * (1 + 1e-6) });
    expect(() => readPlasticBarNative(rawFrom(samples), barPlan)).toThrow('end force and stress x area disagree');
  });
});

describe('yield, elastic unload and reverse yield through the decoded result', () => {
  // Independent hand derivation of the 1D return (E 200e9, sigma0 250e6, H 2e9, L 1), stated before execution;
  // relative bound 1e-12 covers the few rounded operations of each step.
  const expected = [
    { stressPa: 252475247.52475247, plasticStrain: 1.2376237623762376e-3 },
    { stressPa: -247524752.47524753, plasticStrain: 1.2376237623762376e-3 },
    { stressPa: -257376727.77178708, plasticStrain: -1.2131163611410645e-3 },
    { stressPa: 242623272.2282129, plasticStrain: -1.2131163611410645e-3 },
  ];
  it('keeps yield, elastic unload, reverse yield and elastic reload per step', async () => {
    const value = input();
    const result = decodePlasticBar(rawFrom(rawSamples(plan())), value, await plasticBarInputSha256(value));
    expect(result.yielded).toBe(true);
    expect(result.structuralCertification).toBe(false);
    result.samples.forEach((sample, index) => {
      expect(Math.abs(sample.stressPa - expected[index].stressPa)).toBeLessThanOrEqual(1e-12 * Math.abs(expected[index].stressPa));
      expect(Math.abs(sample.plasticStrain - expected[index].plasticStrain))
        .toBeLessThanOrEqual(1e-12 * Math.abs(expected[index].plasticStrain));
    });
    // Unload and reload are elastic: plastic strain is unchanged across steps 1->2 and 3->4.
    expect(result.samples[1].plasticStrain).toBe(result.samples[0].plasticStrain);
    expect(result.samples[3].plasticStrain).toBe(result.samples[2].plasticStrain);
  });
  it('reports no yielding below the yield strain', async () => {
    const value = input(3, plan([0, 1e-3, 0], 4));
    const result = decodePlasticBar(rawFrom(rawSamples(value.plan), value.plan), value, await plasticBarInputSha256(value));
    expect(result.yielded).toBe(false);
    expect(result.samples.every(sample => sample.plasticStrain === 0)).toBe(true);
  });
});

describe('plastic-bar protocol, stale and cancelled responses', () => {
  async function associated(revision = 3, barPlan: PlasticBarPlan = plan()) {
    const value = input(revision, barPlan);
    const hash = await plasticBarInputSha256(value);
    return { input: value, hash, result: decodePlasticBar(rawFrom(rawSamples(barPlan), barPlan), value, hash) };
  }

  it('binds the request to the document revision and keeps other schemas separate', async () => {
    const value = input();
    const identity = { documentId: 'plastic-bar-fixture', revision: 3, generation: 1, requestId: 'fem-1' };
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-plastic-bar-1d', identity, input: value })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-plastic-bar-1d', identity: { ...identity, revision: 2 },
      input: value })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-plastic-bar-1d', identity, input: bucklingFixture() })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-buckling-3d', identity, input: value })).toBe(false);
    expect(() => translatePlasticBar({ ...value, plan: { ...value.plan, stepsPerSegment: 0 } })).toThrow('stepsPerSegment');
    const { result } = await associated();
    expect(isPlasticBarResult(result)).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
  });

  it('rejects results of an earlier revision, another plan or another digest', async () => {
    const { input: value, hash, result } = await associated();
    expect(plasticBarResultMatches(result, value, hash)).toBe(true);
    const newer = await associated(4);
    expect(plasticBarResultMatches(result, newer.input, newer.hash)).toBe(false);
    const changed = await associated(3, plan([0, 2.5e-3, 0, -2.5e-3, 0], 2));
    expect(plasticBarResultMatches(result, changed.input, changed.hash)).toBe(false);
    const harder = { ...plan(), material: { ...plan().material, hardeningModulusPa: 3e9 } };
    const parameter = await associated(3, harder);
    expect(plasticBarResultMatches(result, parameter.input, parameter.hash)).toBe(false);
    expect(plasticBarResultMatches(result, value, 'f'.repeat(64))).toBe(false);
    expect(plasticBarResultMatches({ ...result, structuralCertification: true }, value, hash)).toBe(false);
    expect(plasticBarResultMatches({ ...result, samples: [...result.samples].reverse() }, value, hash)).toBe(false);
  });

  it('aborts a solving worker once and ignores a captured late result', async () => {
    const observed: { request: FemRequest | null } = { request: null };
    let terminations = 0;
    const worker: FemWorkerPort = { postMessage(message) { observed.request = message; },
      terminate() { terminations += 1; }, onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const signal = new AbortController();
    const { input: value, result } = await associated();
    const pending = client.analyzePlasticBar(value, { signal: signal.signal });
    const request = observed.request;
    if (request === null || worker.onmessage === null) throw new Error('No actual plastic-bar dispatch');
    expect(request.kind).toBe('analyze-plastic-bar-1d');
    const callback = worker.onmessage;
    callback(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity: request.identity, phase: 'solving' } }));
    signal.abort();
    callback(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(terminations).toBe(1);
    expect(worker.onmessage).toBeNull();
    client.dispose();
    expect(terminations).toBe(1);
  });

  it('supersedes on a parameter change and rejects the old result for the new plan', async () => {
    const workers: FemWorkerPort[] = [];
    const requests: FemRequest[] = [];
    const client = new FemClient(() => {
      const worker: FemWorkerPort = { postMessage(message) { requests.push(message); }, terminate: () => undefined,
        onmessage: null, onerror: null, onmessageerror: null };
      workers.push(worker);
      return worker;
    });
    const first = await associated();
    const firstPending = client.analyzePlasticBar(first.input);
    const firstCallback = workers[0].onmessage;
    const second = await associated(3, { ...plan(), material: { ...plan().material, hardeningModulusPa: 3e9 } });
    const secondPending = client.analyzePlasticBar(second.input);
    await expect(firstPending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    firstCallback?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[0].identity, result: first.result } }));
    workers[1].onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[1].identity, result: first.result } }));
    await expect(secondPending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    const thirdPending = client.analyzePlasticBar(second.input);
    workers[2].onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[2].identity, result: second.result } }));
    await expect(thirdPending).resolves.toMatchObject({ kind: 'result', result: second.result });
    client.dispose();
  });

  it('rejects an invalid replacement and closes the previous request; dispose cancels', async () => {
    let terminated = 0;
    const worker: FemWorkerPort = { postMessage: () => undefined, terminate() { terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const pending = client.analyzePlasticBar(input());
    await expect(client.analyzePlasticBar(input(3, { ...plan(), endDisplacementM: [0, 0.2] }))).rejects.toThrow('small-strain');
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    expect(terminated).toBe(1);
    const next = client.analyzePlasticBar(input());
    client.dispose();
    await expect(next).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    await expect(client.analyzePlasticBar(input())).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
});

describe('native order of the fixed plastic-bar runner (regression for the plastic1 defects A1 and A4)', () => {
  const source = readFileSync(new URL('./plasticBarAnalysis.py', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('def run_plastic_bar'));
  it('does not call postInitialize again after InstanciateProblem (A1)', () => {
    expect(code).not.toMatch(/\.postInitialize\(/u);
    expect(code.indexOf('problem.checkProblemConsistency()')).toBeLessThan(code.indexOf('problem.init()'));
  });
  it('configures the metastep before stepping and pre-initializes every step (A4)', () => {
    const configure = code.indexOf('problem.initMetaStepAttributes(');
    const loop = code.indexOf('for index in range(nsteps):');
    expect(configure).toBeGreaterThan(0);
    expect(configure).toBeLessThan(loop);
    const body = code.slice(loop);
    expect(body.indexOf('problem.preInitializeNextStep()')).toBeGreaterThan(0);
    expect(body.indexOf('problem.preInitializeNextStep()')).toBeLessThan(body.indexOf('problem.giveNextStep()'));
  });
  it('reads the equilibrated end force', () => {
    expect(code).toContain('fem.CharType.LastEquilibratedInternalForcesVector');
    expect(code).not.toMatch(/CharType\.InternalForcesVector/u);
  });
});
