import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { translateBeamBuckling } from './bucklingTranslation.js';
import { modalFixture } from './modal.testSupport.js';
import type { BeamTransientInput, TransientHistory } from './transientModel.js';
import { transientInputSha256, transientOutputSteps, translateBeamTransient } from './transientTranslation.js';
import { decodeBeamTransient, isBeamTransientResult, transientResultMatches } from './transientResults.js';
import { AXIAL_OSCILLATOR, axialOscillator, cantileverPulse, transientHistory } from './transient.testSupport.js';
import type { AnalysisPropertyEvidence } from '@pointercad/model/beam-analysis';

const dt = AXIAL_OSCILLATOR.period / 40;
const stepHistory = transientHistory(dt, 8, [[0, 1], [8, 1]]);

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => reverseObjectKeys(item));
  if (value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = Object.entries(value);
    return Object.fromEntries(entries.reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
}

/** Protocol-only shape for the axial oscillator, explicitly not a native numerical oracle. */
function syntheticRaw(input: BeamTransientInput) {
  const { plan } = translateBeamTransient(input);
  const zero = [0, 0, 0];
  // Independent statement of the returned steps: time 0, multiples of outputEvery and the last step once.
  const { stepCount, outputEvery } = input.history;
  const steps = [0, ...Array.from({ length: stepCount }, (_, index) => index + 1)
    .filter(step => step % outputEvery === 0 || step === stepCount)];
  return { schema: 'pointercad-oofem-transient-result/1', normalizationLengthM: plan.normalizationLengthM,
    meshNodes: 2, meshElements: 1, freeDofs: 1, maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0,
    peakDisplacementM: 0.5, peakDisplacementTimeS: dt * outputEvery, peakDisplacementSolverNode: 2,
    peakRotationRad: 0, peakRotationTimeS: 0, peakRotationSolverNode: 1,
    samples: steps.map(step => ({ timeS: step === 0 ? 0 : dt * step, loadFactor: 1, nodes: [
      { number: 1, displacementM: zero, rotationRad: zero, velocityMPerS: zero, angularVelocityRadPerS: zero,
        accelerationMPerS2: zero, angularAccelerationRadPerS2: zero },
      { number: 2, displacementM: [step === 0 ? 0 : 0.5, 0, 0], rotationRad: zero,
        velocityMPerS: [step === 0 ? 0 : 0.25, 0, 0], angularVelocityRadPerS: zero,
        accelerationMPerS2: [1, 0, 0], angularAccelerationRadPerS2: zero },
    ] })) };
}
async function associated(history: TransientHistory = stepHistory) {
  const input = axialOscillator(history);
  const hash = await transientInputSha256(input);
  return { input, hash, result: decodeBeamTransient(syntheticRaw(input), input, hash) };
}
const withHistory = (change: Partial<Record<keyof TransientHistory, unknown>>): unknown =>
  ({ ...axialOscillator(stepHistory), history: { ...stepHistory, ...change } });

describe('bounded linear transient core contract', () => {
  it('owns the input and builds a restrained plan with the explicit history', () => {
    const input = axialOscillator(stepHistory);
    const before = JSON.stringify(input);
    const prepared = translateBeamTransient(input);
    expect(prepared.plan.schema).toBe('pointercad-oofem-transient-plan/1');
    expect(prepared.plan.nodes).toHaveLength(2);
    expect(prepared.plan.nodes[0].restrained).toEqual([true, true, true, true, true, true]);
    expect(prepared.plan.nodes[1].restrained).toEqual([false, true, true, true, true, true]);
    expect(prepared.plan.nodes[1].load).toEqual([1000, 0, 0, 0, 0, 0]);
    expect(prepared.plan.history).toEqual(stepHistory);
    expect(prepared.input.history.loadFactor).not.toBe(input.history.loadFactor);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ['damping', { damping: 'rayleigh' }], ['initial state', { initialConditions: 'given' }],
    ['zero step', { timeStepS: 0 }], ['negative step', { timeStepS: -dt }], ['infinite step', { timeStepS: Number.POSITIVE_INFINITY }],
    ['boolean step', { timeStepS: true }], ['fractional count', { stepCount: 1.5 }], ['zero count', { stepCount: 0 }],
    ['too many steps', { stepCount: 4001 }], ['zero output interval', { outputEvery: 0 }],
    ['102 output samples', { stepCount: 101, loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 101, factor: 1 }] }],
    ['one sample', { loadFactor: [{ timeS: 0, factor: 1 }] }],
    ['duplicate time', { loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 0, factor: 1 }, { timeS: dt * 8, factor: 1 }] }],
    ['decreasing time', { loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 9, factor: 1 }, { timeS: dt * 8, factor: 1 }] }],
    ['negative first time', { loadFactor: [{ timeS: -dt, factor: 1 }, { timeS: dt * 8, factor: 1 }] }],
    ['late first time', { loadFactor: [{ timeS: dt, factor: 1 }, { timeS: dt * 8, factor: 1 }] }],
    ['short history', { loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 7, factor: 1 }] }],
    ['long history', { loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 9, factor: 1 }] }],
    ['nonfinite factor', { loadFactor: [{ timeS: 0, factor: Number.NaN }, { timeS: dt * 8, factor: 1 }] }],
    ['huge factor', { loadFactor: [{ timeS: 0, factor: 1.1e6 }, { timeS: dt * 8, factor: 1 }] }],
    ['extra sample field', { loadFactor: [{ timeS: 0, factor: 1, unit: 's' }, { timeS: dt * 8, factor: 1 }] }],
    ['257 samples', { stepCount: 256, outputEvery: 4,
      loadFactor: Array.from({ length: 257 }, (_, index) => ({ timeS: dt * index, factor: 1 })) }],
  ])('rejects an invalid history before worker creation: %s', (_label, change) => {
    expect(() => translateBeamTransient(withHistory(change))).toThrow();
  });

  it('rejects a missing or extra history field and invalid structural input', () => {
    const missing = Object.fromEntries(Object.entries(stepHistory).filter(([key]) => key !== 'outputEvery'));
    expect(() => translateBeamTransient({ ...axialOscillator(stepHistory), history: missing })).toThrow('transient-shape');
    expect(() => translateBeamTransient({ ...axialOscillator(stepHistory), history: { ...stepHistory, extra: 1 } })).toThrow('transient-shape');
    expect(() => translateBeamTransient({ ...axialOscillator(stepHistory), supports: [] })).toThrow('transient-input');
    expect(() => translateBeamTransient({ ...axialOscillator(stepHistory), referenceLoads: [] })).toThrow('transient-input');
  });

  it('accepts the exact output and step-count boundaries', () => {
    expect(translateBeamTransient(withHistory({ stepCount: 100,
      loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 100, factor: 1 }] })).input.history.stepCount).toBe(100);
    expect(translateBeamTransient(withHistory({ stepCount: 4000, outputEvery: 40,
      loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 4000, factor: 1 }] })).input.history.outputEvery).toBe(40);
    expect(() => translateBeamTransient(withHistory({ stepCount: 4000, outputEvery: 39,
      loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * 4000, factor: 1 }] }))).toThrow('transient-output');
  });

  it('rejects work beyond the stated step-count x free-DOF^2 bound', () => {
    const geometry = modalFixture({ free: true, modes: 1, segments: 32, split: true });
    const input = (stepCount: number): unknown => ({ schema: 'pointercad-beam-transient/1', geometry,
      supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
      referenceLoads: [{ id: 'tip', kind: 'nodal', nodeId: 'node-2', force: [0, 1, 0], moment: [0, 0, 0] }],
      history: transientHistory(1e-5, stepCount, [[0, 1], [stepCount, 1]], 40) });
    // 64 free nodes x 6 = 384 DOFs: 2000 x 384^2 = 2.9e8 is accepted, 4000 x 384^2 = 5.9e8 is not.
    expect(translateBeamTransient(input(2000)).plan.nodes).toHaveLength(65);
    expect(() => translateBeamTransient(input(4000))).toThrow('transient-budget');
  });

  it('binds the complete history into the input hash', async () => {
    const base = await transientInputSha256(axialOscillator(stepHistory));
    expect(await transientInputSha256(axialOscillator(stepHistory))).toBe(base);
    expect(await transientInputSha256(axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 2]])))).not.toBe(base);
    expect(await transientInputSha256(axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 1]], 2)))).not.toBe(base);
    expect(await transientInputSha256(axialOscillator(transientHistory(dt / 2, 16, [[0, 1], [16, 1]])))).not.toBe(base);
  });

  it('decodes an associated result and rejects inconsistent numerical metadata', async () => {
    const { input, hash, result } = await associated();
    expect(result.nativeTransientSolver).toBe(false);
    expect(result.method).toBe('oofem-beam3d-matrices-newmark-average-acceleration/1');
    expect(transientResultMatches(result, input, hash)).toBe(true);
    const raw = syntheticRaw(input);
    const sample = (index: number, change: Record<string, unknown>) => ({ ...raw,
      samples: raw.samples.map((value, position) => position === index ? { ...value, ...change } : value) });
    const tip = (index: number, change: Record<string, unknown>) => sample(index, {
      nodes: [raw.samples[index].nodes[0], { ...raw.samples[index].nodes[1], ...change }] });
    const invalid: readonly (readonly [string, unknown])[] = [
      ['equilibrium above 1e-8', { ...raw, maximumEquilibriumResidual: 1.0001e-8 }],
      ['nonfinite energy balance', { ...raw, maximumEnergyBalanceError: Number.NaN }],
      ['sample count', { ...raw, samples: raw.samples.slice(1) }],
      ['shifted time', sample(3, { timeS: dt * 3.5 })],
      ['load factor', sample(3, { loadFactor: 0.5 })],
      ['restrained motion', tip(3, { displacementM: [0.5, 1e-9, 0] })],
      ['restrained acceleration', tip(3, { angularAccelerationRadPerS2: [0, 0, 1e-9] })],
      ['not from rest', tip(0, { velocityMPerS: [1e-12, 0, 0] })],
      ['peak below a sample', { ...raw, peakDisplacementM: 0.4 }],
      ['peak not attained by its own sample', { ...raw, peakDisplacementM: 0.6 }],
      ['peak between grid times', { ...raw, peakDisplacementTimeS: dt * 1.5 }],
      ['peak after the duration', { ...raw, peakDisplacementTimeS: dt * 9 }],
      ['positive peak at rest', { ...raw, peakDisplacementTimeS: 0 }],
      ['peak at a non-mesh node', { ...raw, peakDisplacementSolverNode: 3 }],
      ['zero peak at a later time', { ...raw, peakRotationTimeS: dt }],
      ['zero peak at another node', { ...raw, peakRotationSolverNode: 2 }],
      ['missing peak time', Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'peakRotationTimeS'))],
      ['extra node field', tip(3, { extra: 1 })],
      ['free degree count', { ...raw, freeDofs: 2 }],
      ['non-finite sample load', { ...raw, samples: raw.samples.map((sample, index) =>
        index === 0 ? { ...sample, loadFactor: Number.NaN } : sample) }],
      ['sparse samples', { ...raw, samples: Object.assign(new Array(raw.samples.length), { 0: raw.samples[0] }) }],
      ['sparse nodes at rest', { ...raw, samples: raw.samples.map((sample, index) =>
        index === 0 ? { ...sample, nodes: new Array(sample.nodes.length) } : sample) }],
      ['wrong schema', { ...raw, schema: 'pointercad-oofem-buckling-result/1' }],
    ];
    for (const [label, value] of invalid) expect(() => decodeBeamTransient(value, input, hash), label).toThrow();
    expect(() => decodeBeamTransient(raw, input, 'not-a-hash')).toThrow();
  });

  it('accepts a single-time peak between returned samples and rejects a norm of different-time maxima', async () => {
    const sparse = transientHistory(dt, 8, [[0, 1], [8, 1]], 4);
    const sparseInput = axialOscillator(sparse);
    const sparseHash = await transientInputSha256(sparseInput);
    // Step 3 is not returned; a larger single-time magnitude there bounds the returned samples and is accepted.
    const between = { ...syntheticRaw(sparseInput), peakDisplacementM: 0.7, peakDisplacementTimeS: dt * 3 };
    expect(decodeBeamTransient(between, sparseInput, sparseHash).peakDisplacementTimeS).toBe(dt * 3);
    expect(() => decodeBeamTransient({ ...between, peakDisplacementTimeS: dt * 4 }, sparseInput, sparseHash)).toThrow();

    // Free cantilever tip: displacement [1,0,0] at step 1 and [0,1,0] at step 2, rotation [0,0,2] then [2,0,0].
    const history = transientHistory(1e-3, 2, [[0, 0], [2, 1]]);
    const input = cantileverPulse(history);
    const hash = await transientInputSha256(input);
    const { plan } = translateBeamTransient(input);
    const zero = [0, 0, 0];
    const node = (number: number, displacementM: number[], rotationRad: number[]) => ({ number, displacementM,
      rotationRad, velocityMPerS: zero, angularVelocityRadPerS: zero, accelerationMPerS2: zero, angularAccelerationRadPerS2: zero });
    const tip = [[zero, zero], [[1, 0, 0], [0, 0, 2]], [[0, 1, 0], [2, 0, 0]]];
    const raw = { schema: 'pointercad-oofem-transient-result/1', normalizationLengthM: plan.normalizationLengthM,
      meshNodes: plan.nodes.length, meshElements: plan.members.length, freeDofs: 24,
      maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0,
      peakDisplacementM: 1, peakDisplacementTimeS: 1e-3, peakDisplacementSolverNode: 2,
      peakRotationRad: 2, peakRotationTimeS: 1e-3, peakRotationSolverNode: 2,
      samples: [0, 1, 2].map(step => ({ timeS: step === 0 ? 0 : 1e-3 * step, loadFactor: step / 2,
        nodes: [node(1, zero, zero), node(2, tip[step][0], tip[step][1])] })) };
    const result = decodeBeamTransient(raw, input, hash);
    expect([result.peakDisplacementM, result.peakRotationRad]).toEqual([1, 2]);
    expect(transientResultMatches(result, input, hash)).toBe(true);
    for (const change of [{ peakDisplacementM: Math.SQRT2 }, { peakRotationRad: 2 * Math.SQRT2 },
      { peakDisplacementM: Math.SQRT2, peakDisplacementTimeS: 2e-3 }]) {
      expect(() => decodeBeamTransient({ ...raw, ...change }, input, hash), JSON.stringify(change)).toThrow();
    }
  });

  it('returns 1 + ceil(steps / interval) samples with the final step exactly once', () => {
    const accepted = (stepCount: number, outputEvery: number): boolean => {
      try {
        translateBeamTransient(withHistory({ stepCount, outputEvery,
          loadFactor: [{ timeS: 0, factor: 1 }, { timeS: dt * stepCount, factor: 1 }] }));
        return true;
      } catch { return false; }
    };
    expect([accepted(300, 3), accepted(301, 3), accepted(100, 1), accepted(101, 1)]).toEqual([true, false, true, false]);
    // 3961 / 40 is not divisible: 1 + 100 samples including the final step once, still accepted.
    expect([accepted(8, 8), accepted(8, 9), accepted(4000, 40), accepted(3961, 40)]).toEqual([true, false, true, true]);
    expect(transientOutputSteps({ ...stepHistory, stepCount: 10, outputEvery: 3 })).toEqual([0, 3, 6, 9, 10]);
    expect(transientOutputSteps({ ...stepHistory, stepCount: 9, outputEvery: 3 })).toEqual([0, 3, 6, 9]);
    expect(transientOutputSteps({ ...stepHistory, stepCount: 8, outputEvery: 8 })).toEqual([0, 8]);
  });

  it('rejects overflowing duration, unusable Newmark coefficients and malformed containers with stable prefixes', () => {
    const at = (timeStepS: number, stepCount: number): unknown => withHistory({ timeStepS, stepCount,
      outputEvery: Math.ceil(stepCount / 100), loadFactor: [{ timeS: 0, factor: 1 }, { timeS: timeStepS * stepCount, factor: 1 }] });
    expect(() => translateBeamTransient(at(1e306, 4000))).toThrow('transient-step');
    expect(() => translateBeamTransient(at(1e-160, 8))).toThrow('transient-step');
    expect(() => translateBeamTransient(at(1e-200, 8))).toThrow('transient-step');
    expect(translateBeamTransient(at(1e-9, 8)).input.history.timeStepS).toBe(1e-9);
    // beamAnalysis.py _validate_transient_history raises the same prefixes in the same order.
    const base = axialOscillator(stepHistory);
    for (const [history, prefix] of [
      [null, 'transient-shape: history'], [[], 'transient-shape: history'], ['history', 'transient-shape: history'],
      [{ ...stepHistory, loadFactor: {} }, 'transient-history'],
      [{ ...stepHistory, loadFactor: [null, { timeS: dt * 8, factor: 1 }] }, 'transient-shape: history.loadFactor[0]'],
      [{ ...stepHistory, loadFactor: [{ timeS: 0, factor: true }, { timeS: dt * 8, factor: 1 }] }, 'transient-number: history.loadFactor[0].factor'],
      [{ ...stepHistory, loadFactor: [{ timeS: '0', factor: 1 }, { timeS: dt * 8, factor: 1 }] }, 'transient-number: history.loadFactor[0].timeS'],
      [{ ...stepHistory, timeStepS: true }, 'transient-number: history.timeStepS'],
      [{ ...stepHistory, stepCount: true }, 'transient-steps'], [{ ...stepHistory, outputEvery: false }, 'transient-output'],
      [{ ...stepHistory, loadFactor: Object.assign(new Array(2), { 1: { timeS: dt * 8, factor: 1 } }) },
        'transient-shape: history.loadFactor'],
    ] as const) {
      expect(() => translateBeamTransient({ ...base, history }), JSON.stringify(history)).toThrow(prefix);
    }
  });

  it('rejects stale, foreign and reordered-array results but accepts reordered object keys', async () => {
    const { input, hash, result } = await associated();
    const reordered = reverseObjectKeys(result);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(result));
    expect(transientResultMatches(reordered, input, hash)).toBe(true);
    const other = axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 2]]));
    const invalid: readonly (readonly [string, unknown])[] = [
      ['changed source', { ...result, source: { ...result.source, geometryRevision: 'stale' } }],
      ['changed hash', { ...result, inputSha256: 'f'.repeat(64) }],
      ['claims a native transient solver', { ...result, nativeTransientSolver: true }],
      ['sample order', { ...result, samples: [...result.samples].reverse() }],
      ['missing certification flag', Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'structuralCertification'))],
    ];
    for (const [label, value] of invalid) expect(transientResultMatches(value, input, hash), label).toBe(false);
    expect(transientResultMatches(result, other, await transientInputSha256(other))).toBe(false);
    expect(transientResultMatches(result, input, 'f'.repeat(64))).toBe(false);
  });

  it('keeps the static, modal and buckling schemas separate and unchanged', async () => {
    const identity = { documentId: 'independent-modal-fixture', revision: 1, generation: 1, requestId: 'fem-1' };
    const buckling = bucklingFixture();
    const transient = cantileverPulse(transientHistory(1e-4, 10, [[0, 0], [10, 1]]));
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-buckling-3d', identity, input: buckling })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-modal-3d', identity, document: modalFixture() })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-transient-3d', identity, input: transient })).toBe(true);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-transient-3d', identity, input: buckling })).toBe(false);
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-buckling-3d', identity, input: transient })).toBe(false);
    expect(() => translateBeamBuckling(transient)).toThrow();
    expect(() => translateBeamTransient({ ...buckling, schema: 'pointercad-beam-transient/1' })).toThrow('transient-shape');
    const { result } = await associated();
    expect(isBeamTransientResult(result)).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
  });

  it('aborts a solving worker once and ignores a captured late result', async () => {
    const observed: { request: FemRequest | null } = { request: null };
    let terminations = 0;
    const worker: FemWorkerPort = { postMessage(value) { observed.request = value; },
      terminate() { terminations += 1; }, onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const signal = new AbortController();
    const { input, result } = await associated();
    const pending = client.analyzeTransient(input, { signal: signal.signal });
    const request = observed.request;
    if (request === null || worker.onmessage === null) throw new Error('No actual transient dispatch');
    expect(isRequest(request)).toBe(true);
    expect(request.kind).toBe('analyze-beam-transient-3d');
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

  it('supersedes an earlier request and rejects a result for a different history', async () => {
    const workers: FemWorkerPort[] = [];
    const requests: FemRequest[] = [];
    const client = new FemClient(() => {
      const worker: FemWorkerPort = { postMessage(value) { requests.push(value); }, terminate: () => undefined,
        onmessage: null, onerror: null, onmessageerror: null };
      workers.push(worker);
      return worker;
    });
    const first = await associated();
    const firstPending = client.analyzeTransient(first.input);
    const firstCallback = workers[0].onmessage;
    const secondInput = axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 2]]));
    const secondPending = client.analyzeTransient(secondInput);
    await expect(firstPending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    // The superseded worker's late result neither completes nor fails the newer request.
    firstCallback?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[0].identity, result: first.result } }));
    const secondCallback = workers[1].onmessage;
    if (secondCallback === null) throw new Error('No second dispatch');
    secondCallback(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[1].identity, result: first.result } }));
    await expect(secondPending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    const thirdPending = client.analyzeTransient(first.input);
    workers[2].onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: requests[2].identity, result: first.result } }));
    await expect(thirdPending).resolves.toMatchObject({ kind: 'result', result: first.result });
    client.dispose();
  });

  it('rejects an invalid replacement asynchronously and closes the previous request', async () => {
    let terminated = 0;
    const worker: FemWorkerPort = { postMessage: () => undefined, terminate() { terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null };
    const client = new FemClient(() => worker);
    const pending = client.analyzeTransient(axialOscillator(stepHistory));
    await expect(client.analyzeTransient(withHistory({ damping: 'rayleigh' }))).rejects.toThrow('transient-damping');
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    expect(terminated).toBe(1);
    client.dispose();
  });
});

describe('OOFEM model construction in the shipped wrapper', () => {
  // native6 trap: the Python factory never assigns EngngModel::startTime and the .out header formats it with
  // ctime(); libc asctime_r executes `unreachable` when that indeterminate date exceeds 26 bytes.
  it('suppresses the .out writer for every linearStatic model', () => {
    const source = readFileSync(new URL('./beamAnalysis.py', import.meta.url), 'utf8');
    const calls = [...source.matchAll(/fem\.linearStatic\(([^)]*)\)/g)].map(match => match[1]);
    expect(calls).toEqual([
      ...['analysis', 'modal-matrices', 'buckling-reference']
        .map(name => `nSteps=1, outFile='/pcad_fem/${name}.out', suppress_output=True`),
      'nSteps=1, outFile=out_file, suppress_output=True',
    ]);
    const helperCalls = [...source.matchAll(/_native_beam3d_problem\(([^)]*)\)/g)].map(match => match[1]);
    expect(helperCalls).toEqual(['fem, out_file', "fem, '/pcad_fem/transient-matrices.out'"]);
    const impact = readFileSync(new URL('./beamImpact.py', import.meta.url), 'utf8');
    const impactCalls = [...impact.matchAll(/_native_beam3d_problem\(([^)]*)\)/g)].map(match => match[1]);
    expect(impactCalls).toEqual(["fem, '/pcad_fem/impact-element-matrices.out'", "fem, '/pcad_fem/impact-matrices.out'"]);
    expect([...impact.matchAll(/fem\.linearStatic\(([^)]*)\)/g)]).toEqual([]);
    expect(impact).not.toMatch(/suppress_output\s*=\s*False/);
    expect(source.split('outFile=')).toHaveLength(5);
    expect(source).not.toMatch(/suppress_output\s*=\s*False/);
  });
});

describe('Rayleigh evidence is saved input metadata, not a numerical-plan field', () => {
  const damping = { kind: 'rayleigh' as const, massCoefficientPerS: 2, stiffnessCoefficientS: 0.001 };
  const evidence: AnalysisPropertyEvidence = { property: 'rayleigh', sourceId: 'synthetic-damping', sourceKind: 'user-provided',
    citation: 'Synthetic test table, row 1', materialConditionId: 's45c-normalized-reference',
    heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20, temperatureRange: { lower: 10, upper: 30, unit: 'degC' },
    units: { massCoefficientPerS: '1/s', stiffnessCoefficientS: 's' },
    testConditions: { description: 'Synthetic linear viscous test', parameters: { law: 'C=alpha*M+beta*K' } },
    validRange: { massCoefficientPerS: { lower: 0, upper: 4, unit: '1/s' },
      stiffnessCoefficientS: { lower: 0, upper: 0.002, unit: 's' } } };
  const plain = axialOscillator({ ...stepHistory, damping });
  const supplied = axialOscillator({ ...stepHistory, damping: { ...damping, evidence } });

  it('emits exactly the old Python plan bytes while preserving and hashing authored evidence', async () => {
    const before = new TextEncoder().encode(JSON.stringify(supplied));
    const prepared = translateBeamTransient(supplied);
    expect(JSON.stringify(prepared.plan)).toBe(JSON.stringify(translateBeamTransient(plain).plan));
    expect(Object.keys(prepared.plan.history.damping).sort()).toEqual(['kind', 'massCoefficientPerS', 'stiffnessCoefficientS']);
    expect(prepared.input).toEqual(supplied);
    expect(prepared.input.history.damping).not.toBe(supplied.history.damping);
    expect(JSON.stringify(prepared.input)).toContain('synthetic-damping');
    const hash = await transientInputSha256(supplied);
    expect(hash).not.toBe(await transientInputSha256(plain));
    expect(hash).toBe(await transientInputSha256(JSON.parse(JSON.stringify(supplied))));
    expect(await transientInputSha256(axialOscillator({ ...stepHistory,
      damping: { ...damping, evidence: { ...evidence, citation: 'Synthetic test table, row 2' } } }))).not.toBe(hash);
    expect(new TextEncoder().encode(JSON.stringify(supplied))).toEqual(before);
  });

  it('accepts the unchanged numerical reply and keeps result identity bound to evidence', async () => {
    const hash = await transientInputSha256(supplied);
    const raw = { ...syntheticRaw(supplied), schema: 'pointercad-oofem-transient-result/2', damping, dissipatedEnergyJ: 0 };
    const result = decodeBeamTransient(raw, supplied, hash);
    expect(isBeamTransientResult(result)).toBe(true);
    expect(transientResultMatches(result, supplied, hash)).toBe(true);
    expect(transientResultMatches(result, plain, await transientInputSha256(plain))).toBe(false);
    expect(result).toMatchObject({ damping });
    expect(JSON.stringify(result)).not.toContain('synthetic-damping');
    const identity = { documentId: 'independent-modal-fixture', revision: 1, generation: 1, requestId: 'evidence-1' };
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-transient-3d', identity, input: supplied })).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
  });

  it.each([
    ['unit-mismatch', { ...evidence, units: { ...evidence.units, stiffnessCoefficientS: '1/s' } }],
    ['condition-mismatch', { ...evidence, heatTreatment: '焼入焼戻・適用寸法未指定の参考値' }],
    ['outside-range', { ...evidence, temperatureC: 31 }],
    ['shape', undefined],
  ])('rejects %s before stripping evidence; the input stays unchanged', (code, invalid) => {
    const value = { ...plain, history: { ...plain.history, damping: { ...damping, evidence: invalid } } };
    const before = new TextEncoder().encode(JSON.stringify(value));
    expect(() => translateBeamTransient(value)).toThrow(expect.objectContaining({ code: `property-evidence-${code}` }));
    expect(new TextEncoder().encode(JSON.stringify(value))).toEqual(before);
  });
});
