import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { rotateModalVector } from './modal.testSupport.js';
import { transientAxialMatches, transientAxialResponse } from './transientAxial.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import { decodeBeamTransient } from './transientResults.js';
import { axialOscillator, cantileverPulse, transientHistory } from './transient.testSupport.js';
import { transientInputSha256, transientLoadFactor, transientOutputSteps, translateBeamTransient } from './transientTranslation.js';

const dt = 1e-4;
const history = transientHistory(dt, 8, [[0, 1], [8, 1]]);
/** Hand-chosen axial end displacement profile (m) of node-1 per grid step; node-0 is clamped. */
const profile = [0, 0.2, 0.5, 1, 0.4, -0.3, -0.8, -0.2, 0.1].map(value => value * 1e-4);
const young = 210e9;

function near(actual: number, expected: number, relative = 1e-12): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(relative * Math.max(Math.abs(expected), 1e-30));
}
function exactlyZero(value: number): void {
  expect(Math.abs(value)).toBe(0);
}

/** Protocol-only native response with prescribed original-node translations (not a numerical oracle of the solver):
 * the decoder still checks times, load factors, supports, rest at time 0 and the peak triple. */
async function decoded(input: BeamTransientInput, translation: (step: number, node: number) => Vector3): Promise<{
  readonly result: BeamTransientResult; readonly hash: string;
}> {
  const { plan } = translateBeamTransient(input);
  const steps = transientOutputSteps(input.history);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const last = input.history.loadFactor[input.history.loadFactor.length - 1].timeS;
  const zero: Vector3 = [0, 0, 0];
  let peak = 0, peakStep = 0, peakNode = plan.nodes[0].number;
  const samples = steps.map(step => {
    const timeS = step === 0 ? 0 : input.history.timeStepS * step;
    return { timeS, loadFactor: transientLoadFactor(input.history.loadFactor, Math.min(timeS, last)),
      nodes: original.map((node, index) => {
        const displacementM = translation(step, index);
        const size = Math.hypot(...displacementM);
        if (size > peak) { peak = size; peakStep = step; peakNode = node.number; }
        return { number: node.number, displacementM, rotationRad: zero, velocityMPerS: zero,
          angularVelocityRadPerS: zero, accelerationMPerS2: zero, angularAccelerationRadPerS2: zero };
      }) };
  });
  const hash = await transientInputSha256(input);
  const raw = { schema: 'pointercad-oofem-transient-result/1', normalizationLengthM: plan.normalizationLengthM,
    meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0,
    peakDisplacementM: peak, peakDisplacementTimeS: peakStep === 0 ? 0 : input.history.timeStepS * peakStep,
    peakDisplacementSolverNode: peakNode, peakRotationRad: 0, peakRotationTimeS: 0,
    peakRotationSolverNode: plan.nodes[0].number, samples };
  return { result: decodeBeamTransient(raw, input, hash), hash };
}
const tip = (map: (step: number) => Vector3) => (step: number, node: number): Vector3 => node === 1 ? map(step) : [0, 0, 0];

describe('member-mean linear axial strain and stress from sampled end translations (hand-derived)', () => {
  it('extension and compression: strain = du/L, stress = E strain, signed, with sample-only extrema and times', async () => {
    const input = axialOscillator(history);
    const { result } = await decoded(input, tip(step => [profile[step], 0, 0]));
    const axial = transientAxialResponse(result, input);
    expect(axial.measure).toBe('member-mean-linear-axial-from-sampled-end-translations/1');
    expect(axial.members).toHaveLength(1);
    const member = axial.members[0];
    expect([member.memberId, member.startNodeId, member.endNodeId]).toEqual(['member-0', 'node-0', 'node-1']);
    near(member.lengthM, 1);
    expect(member.axis).toEqual([1, 0, 0]);
    near(member.youngPa, young);
    // L = 1 m along +x, node-0 fixed: strain equals the tip x displacement in m.
    profile.forEach((value, step) => { near(member.strain[step], value); near(member.stressPa[step], young * value); });
    expect([member.maximum.sample, member.minimum.sample]).toEqual([3, 6]);
    expect([member.maximum.timeS, member.minimum.timeS]).toEqual([result.samples[3].timeS, result.samples[6].timeS]);
    near(member.maximum.strain, 1e-4);
    near(member.maximum.stressPa, 2.1e7);
    near(member.minimum.strain, -8e-5);
    near(member.minimum.stressPa, -1.68e7);
    expect(transientAxialMatches(axial, result)).toBe(true);
  });

  it('a tie keeps the first emitted sample; only emitted samples are searched', async () => {
    const input = axialOscillator(history);
    const values = [0, 0.5, 1, 0.5, 1, 0, 0, 0, 0].map(value => value * 1e-4);
    const { result } = await decoded(input, tip(step => [values[step], 0, 0]));
    const member = transientAxialResponse(result, input).members[0];
    expect([member.maximum.sample, member.minimum.sample]).toEqual([2, 0]);
    // With outputEvery 2 the odd steps are not emitted, so their values cannot become extrema.
    const sparse = axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 1]], 2));
    const odd = [0, 9, 0.1, 9, 0.3, 9, 0.2, 9, 0.1].map(value => value * 1e-4);
    const { result: thin } = await decoded(sparse, tip(step => [odd[step], 0, 0]));
    const extremes = transientAxialResponse(thin, sparse).members[0];
    expect(thin.samples.map(sample => sample.timeS)).toEqual([0, 2, 4, 6, 8].map(step => step === 0 ? 0 : dt * step));
    expect(extremes.maximum.sample).toBe(2);
    near(extremes.maximum.strain, 0.3e-4);
  });

  it('rigid translation of both ends gives exactly zero axial strain', async () => {
    const input: BeamTransientInput = { ...axialOscillator(history), supports: [
      { nodeId: 'node-0', restrained: [false, true, true, true, true, true] },
      { nodeId: 'node-1', restrained: [false, true, true, true, true, true] }] };
    const { result } = await decoded(input, step => [profile[step], 0, 0]);
    const member = transientAxialResponse(result, input).members[0];
    member.strain.forEach(exactlyZero);
    member.stressPa.forEach(exactlyZero);
    expect([member.maximum.sample, member.minimum.sample, member.maximum.timeS]).toEqual([0, 0, 0]);
  });

  it('bending-only tip translation (transverse to the axis) keeps the linear axial measure at zero', async () => {
    const input = cantileverPulse(history);
    const { result } = await decoded(input, tip(step => [0, 3 * profile[step], -2 * profile[step]]));
    const member = transientAxialResponse(result, input).members[0];
    expect(result.meshElements).toBe(4);
    member.strain.forEach(exactlyZero);
    exactlyZero(member.maximum.stressPa);
    exactlyZero(member.minimum.stressPa);
  });

  it('is frame invariant: the exactly rotated cantilever gives the same strain from the rotated end translation', async () => {
    const input = cantileverPulse(history, { rotated: true });
    const { result } = await decoded(input, tip(step => rotateModalVector([profile[step], 10 * profile[step], 0])));
    const member = transientAxialResponse(result, input).members[0];
    near(member.lengthM, 1, 1e-15);
    member.axis.forEach((component, axis) => near(component, rotateModalVector([1, 0, 0])[axis], 1e-15));
    profile.forEach((value, step) => {
      if (value === 0) expect(Math.abs(member.strain[step])).toBeLessThanOrEqual(1e-20);
      else near(member.strain[step], value, 1e-12);
    });
    expect([member.maximum.sample, member.minimum.sample]).toEqual([3, 6]);
  });

  it('N-mm input: positions in mm and E in N/mm2 give the same SI strain and stress', async () => {
    const input = axialOscillator(history, { millimetres: true });
    expect(input.geometry.units).toBe('N-mm');
    expect(input.geometry.materials[0].youngModulus).toBe(210000);
    const { result } = await decoded(input, tip(step => [profile[step], 0, 0]));
    const member = transientAxialResponse(result, input).members[0];
    near(member.lengthM, 1);
    near(member.youngPa, young);
    near(member.maximum.strain, 1e-4);
    near(member.maximum.stressPa, 2.1e7);
  });

  it('zero load: every strain and stress is zero and both extrema sit at time 0', async () => {
    const input = axialOscillator(transientHistory(dt, 8, [[0, 0], [8, 0]]));
    const { result } = await decoded(input, () => [0, 0, 0]);
    const member = transientAxialResponse(result, input).members[0];
    member.strain.forEach(exactlyZero);
    expect([member.maximum, member.minimum]).toEqual([{ sample: 0, timeS: 0, strain: 0, stressPa: 0 },
      { sample: 0, timeS: 0, strain: 0, stressPa: 0 }]);
  });

  it('rejects a result that is malformed or belongs to another input, and binds the measure to its result', async () => {
    const input = axialOscillator(history);
    const { result } = await decoded(input, tip(step => [profile[step], 0, 0]));
    const other = axialOscillator(transientHistory(dt, 8, [[0, 1], [8, 2]]));
    expect(() => transientAxialResponse(result, other)).toThrow('transient-axial');
    const tampered: BeamTransientResult = { ...result, samples: result.samples.map((sample, index) => index !== 2 ? sample
      : { ...sample, nodes: sample.nodes.map((node, nodeIndex) => nodeIndex !== 1 ? node
        : { ...node, displacementM: [profile[2], 1e-5, 0] }) }) };
    expect(() => transientAxialResponse(tampered, input)).toThrow('transient-axial');
    const axial = transientAxialResponse(result, input);
    expect(transientAxialMatches(null, result)).toBe(false);
    expect(transientAxialMatches(axial, { ...result, inputSha256: 'f'.repeat(64) })).toBe(false);
    expect(transientAxialMatches(axial, { ...result, analysisRevision: result.analysisRevision + 1 })).toBe(false);
    expect(transientAxialMatches(axial, { ...result, samples: result.samples.slice(0, -1) })).toBe(false);
    expect(transientAxialMatches({ ...axial, sampleTimesS: axial.sampleTimesS.map(time => time * 2) }, result)).toBe(false);
  });
});

describe('axial-2: finite derived values and content association with the displayed result', () => {
  // translateBeamTransient bounds E to (1e-30, 1e30] Pa, coordinates to 1e9 m and L to more than 1 nm, while the
  // decoder admits any finite displacement. So only displacement-driven overflow is reachable; these are such cases.
  it('rejects a stress overflow from a finite decoded displacement (E 2.1e11 Pa x strain 1e300)', async () => {
    const input = axialOscillator(history);
    const { result } = await decoded(input, tip(step => [step === 3 ? 1e300 : 0, 0, 0]));
    expect(() => transientAxialResponse(result, input)).toThrow('transient-axial: non-finite stress');
  });

  it('rejects a strain overflow when finite end translations differ by more than the largest double', async () => {
    const input: BeamTransientInput = { ...axialOscillator(history), supports: [
      { nodeId: 'node-0', restrained: [false, true, true, true, true, true] },
      { nodeId: 'node-1', restrained: [false, true, true, true, true, true] }] };
    const { result } = await decoded(input, (step, node) => [step === 2 ? (node === 1 ? 1e308 : -1e308) : 0, 0, 0]);
    expect(() => transientAxialResponse(result, input)).toThrow('transient-axial: non-finite strain');
  });

  it('keeps the largest finite case just below overflow (strain 8e296 -> stress 1.68e308 Pa)', async () => {
    const input = axialOscillator(history);
    const { result } = await decoded(input, tip(step => [step === 3 ? 8e296 : 0, 0, 0]));
    const member = transientAxialResponse(result, input).members[0];
    near(member.maximum.strain, 8e296);
    near(member.maximum.stressPa, 1.68e308);
    expect(Number.isFinite(member.maximum.stressPa)).toBe(true);
  });

  it('does not display derived values for a different result with the same digest, revision and time grid', async () => {
    const input = axialOscillator(history);
    const { result: first } = await decoded(input, tip(step => [profile[step], 0, 0]));
    const { result: second } = await decoded(input, tip(step => [2 * profile[step], 0, 0]));
    expect([second.inputSha256, second.analysisRevision, second.samples.map(sample => sample.timeS)])
      .toEqual([first.inputSha256, first.analysisRevision, first.samples.map(sample => sample.timeS)]);
    const axial = transientAxialResponse(first, input);
    expect(transientAxialMatches(axial, first)).toBe(true);
    expect(transientAxialMatches(axial, second)).toBe(false);
    expect(transientAxialMatches(transientAxialResponse(second, input), first)).toBe(false);
    // Content, not object identity: an equal copy of the same result still matches.
    expect(transientAxialMatches(axial, structuredClone(first))).toBe(true);
    const member = axial.members[0];
    for (const changed of [
      { ...member, stressPa: member.stressPa.map((value, index) => index === 3 ? value * 2 : value) },
      { ...member, maximum: { ...member.maximum, sample: 4 } },
      { ...member, youngPa: member.youngPa * 2 },
      { ...member, endSolverNode: member.startSolverNode },
    ]) expect(transientAxialMatches({ ...axial, members: [changed] }, first)).toBe(false);
  });
});
