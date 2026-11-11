import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { analyzeFatigue } from './fatigue.js';
import { axialFatigueHistory, type AxialFatigueHistory } from './fatigueAxial.js';
import { transientAxialResponse, type TransientAxialResponse } from './transientAxial.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import { decodeBeamTransient } from './transientResults.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
import { transientInputSha256, transientLoadFactor, transientOutputSteps, translateBeamTransient } from './transientTranslation.js';

/* Expected values are hand-derived from the measure's definition, not from the adapter: the existing axial
 * oscillator member has L = 1 m along +x, node-0 clamped and E = 210e9 Pa, so a node-1 x translation u (m) gives
 * strain u, stress 210e9 * u Pa and 210e3 * u MPa. Translations are hand-chosen protocol data (as in
 * transientAxial.test.ts), not a solver oracle. */
const dt = 1e-4;
const history = transientHistory(dt, 8, [[0, 1], [8, 1]]);
const near = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12 * Math.max(Math.abs(expected), 1e-30));
};

/** Same protocol-only response builder as transientAxial.test.ts: prescribed original-node translations. */
async function decoded(input: BeamTransientInput, translation: (step: number, node: number) => Vector3): Promise<BeamTransientResult> {
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
  return decodeBeamTransient(raw, input, hash);
}
const tip = (values: readonly number[]) => (step: number, node: number): Vector3 => node === 1 ? [values[step] ?? 0, 0, 0] : [0, 0, 0];
async function measured(values: readonly number[]): Promise<{ result: BeamTransientResult; axial: TransientAxialResponse }> {
  const input = axialOscillator(history);
  const result = await decoded(input, tip(values));
  return { result, axial: transientAxialResponse(result, input) };
}
const selection = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ memberId: 'member-0', historyId: 'member-0 axial', sequence: 'once', repeats: 1, reference: 'Load case A', ...overrides });
function accepted(outcome: AxialFatigueHistory) {
  if (!outcome.ok) throw new Error(`${outcome.code} at ${outcome.path}`);
  return outcome;
}
const refused = (outcome: AxialFatigueHistory) => outcome.ok ? null : [outcome.code, outcome.path];

// Mixed tension and compression (x 1e-4 m): MPa = 21 x value.
const mixed = [0, 0.2, 0.5, 1, 0.4, -0.3, -0.8, -0.2, 0.1].map(value => value * 1e-4);
const mixedMpa = [0, 4.2, 10.5, 21, 8.4, -6.3, -16.8, -4.2, 2.1];

describe('member-mean axial stress to one fatigue history (hand-derived)', () => {
  it('converts the signed member-mean axial stress from Pa to MPa at every emitted sample, in order', async () => {
    const { result, axial } = await measured(mixed);
    const outcome = accepted(axialFatigueHistory(axial, result, selection()));
    expect(outcome.history.stressMpa).toHaveLength(mixedMpa.length);
    mixedMpa.forEach((value, index) => near(outcome.history.stressMpa[index] ?? Number.NaN, value));
    expect(outcome.history).toMatchObject({ id: 'member-0 axial', unit: 'MPa', sequence: 'once', repeats: 1,
      source: { kind: 'user-supplied', reference: 'Load case A' } });
    expect(outcome.history.source.condition).toContain('member-mean linear axial stress');
    expect(outcome.history.source.condition).toContain('bending, shear, torsion, local, combined and multiaxial stress are not included');
    expect(outcome.provenance).toMatchObject({ measure: 'member-mean-linear-axial-from-sampled-end-translations/1',
      stress: 'member-mean-linear-axial', excluded: 'bending-shear-torsion-local-combined-multiaxial',
      analysisId: result.analysisId, analysisRevision: result.analysisRevision, inputSha256: result.inputSha256,
      memberId: 'member-0', startNodeId: 'node-0', endNodeId: 'node-1', conversion: 'MPa = Pa / 1e6' });
    expect(outcome.provenance.sampleTimesS).toEqual(result.samples.map(sample => sample.timeS));
    near(outcome.provenance.youngPa, 210e9);
    near(outcome.provenance.lengthM, 1);
  });

  it('keeps the sign of tension-only and compression-only histories', async () => {
    const tension = await measured([0, 1, 2, 1, 0, 1, 2, 1, 0].map(value => value * 1e-5));
    const compression = await measured([0, -1, -2, -1, 0, -1, -2, -1, 0].map(value => value * 1e-5));
    const expected = [0, 2.1, 4.2, 2.1, 0, 2.1, 4.2, 2.1, 0];
    const up = accepted(axialFatigueHistory(tension.axial, tension.result, selection())).history.stressMpa;
    const down = accepted(axialFatigueHistory(compression.axial, compression.result, selection())).history.stressMpa;
    expected.forEach((value, index) => { near(up[index] ?? Number.NaN, value); near(down[index] ?? Number.NaN, -value); });
  });

  it('feeds analyzeFatigue: rainflow of 0,21,-16.8,2.1 MPa and Miner damage against an explicit test curve', async () => {
    const { result, axial } = await measured(mixed);
    const outcome = accepted(axialFatigueHistory(axial, result, selection()));
    const curve = { id: 'test curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
      referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null,
      source: { kind: 'user-supplied', reference: 'Test-only relation; not a material value', condition: 'Hand-derived example' } };
    const analysis = analyzeFatigue({ schema: 'pointercad-fatigue/1', curve, histories: [outcome.history] });
    if (!analysis.ok) throw new Error(analysis.code);
    // Reversals 0, 21, -16.8, 2.1: half 21 (0->21), then residual halves 37.8 and 18.9.
    const cycles = analysis.result.histories[0]?.cycles ?? [];
    expect(cycles.map(cycle => [cycle.count, cycle.fromIndex, cycle.toIndex])).toEqual([[0.5, 0, 3], [0.5, 3, 6], [0.5, 6, 8]]);
    [21, 37.8, 18.9].forEach((range, index) => near(cycles[index]?.rangeMpa ?? Number.NaN, range));
    near(analysis.result.damage, 0.5 * (0.21 ** 3 + 0.378 ** 3 + 0.189 ** 3) / 2e6);
  });

  it('carries an explicit periodic statement and its repeat count unchanged', async () => {
    const { result, axial } = await measured(mixed);
    const outcome = accepted(axialFatigueHistory(axial, result, selection({ sequence: 'repeated-periodic', repeats: 500 })));
    expect([outcome.history.sequence, outcome.history.repeats]).toEqual(['repeated-periodic', 500]);
  });
});

describe('refusals instead of guessing', () => {
  it('refuses another measure, a broken time grid and an unknown or duplicated member', async () => {
    const { result, axial } = await measured(mixed);
    expect(refused(axialFatigueHistory({ ...axial, measure: 'section-bending-stress/1' }, result, selection())))
      .toEqual(['fatigue-axial-measure', 'axial.measure']);
    const swapped = [...axial.sampleTimesS];
    [swapped[2], swapped[3]] = [swapped[3] ?? 0, swapped[2] ?? 0];
    expect(refused(axialFatigueHistory({ ...axial, sampleTimesS: swapped }, result, selection()))).toEqual(['fatigue-axial-times', 'axial.sampleTimesS[3]']);
    const repeated = [...axial.sampleTimesS];
    repeated[4] = repeated[3] ?? 0;
    expect(refused(axialFatigueHistory({ ...axial, sampleTimesS: repeated }, result, selection()))).toEqual(['fatigue-axial-times', 'axial.sampleTimesS[4]']);
    expect(refused(axialFatigueHistory(axial, result, selection({ memberId: 'member-9' })))).toEqual(['fatigue-axial-member', 'selection.memberId']);
    const twice = { ...axial, members: [...axial.members, ...axial.members] };
    expect(refused(axialFatigueHistory(twice, result, selection()))).toEqual(['fatigue-axial-member', 'selection.memberId']);
  });

  it('refuses a non-finite, short or edited series and a measure from another result', async () => {
    const { result, axial } = await measured(mixed);
    const member = axial.members[0];
    if (member === undefined) throw new Error('fixture member absent');
    const withSeries = (stressPa: readonly number[]) => ({ ...axial, members: [{ ...member, stressPa }] });
    expect(refused(axialFatigueHistory(withSeries([0, Number.NaN, ...member.stressPa.slice(2)]), result, selection())))
      .toEqual(['fatigue-axial-series', 'member.stressPa[1]']);
    expect(refused(axialFatigueHistory(withSeries(member.stressPa.slice(1)), result, selection()))).toEqual(['fatigue-axial-series', 'member.stressPa']);
    // A finite but edited value no longer belongs to the result.
    expect(refused(axialFatigueHistory(withSeries([0, 1, ...member.stressPa.slice(2)]), result, selection()))).toEqual(['fatigue-axial-binding', 'axial']);
    const other = await measured(mixed.map(value => value / 2));
    expect(refused(axialFatigueHistory(axial, other.result, selection()))).toEqual(['fatigue-axial-binding', 'axial']);
  });

  it('refuses an invalid selection and a converted value outside the fatigue input bound (no clipping)', async () => {
    const { result, axial } = await measured(mixed);
    expect(refused(axialFatigueHistory(axial, result, selection({ repeats: 3 })))).toEqual(['fatigue-axial-selection', 'selection.repeats']);
    expect(refused(axialFatigueHistory(axial, result, selection({ sequence: 'endless' })))).toEqual(['fatigue-axial-selection', 'selection.sequence']);
    expect(refused(axialFatigueHistory(axial, result, { ...selection(), stressScale: 2 }))).toEqual(['fatigue-axial-selection', 'selection']);
    expect(refused(axialFatigueHistory(axial, result, selection({ reference: ' ' })))).toEqual(['fatigue-axial-label', 'selection.reference']);
    // 0.1 m over 1 m: 210e9 * 0.1 Pa = 21000 MPa > 1e4 MPa at sample 1.
    const large = await measured([0, 0.1, 0, 0, 0, 0, 0, 0, 0]);
    expect(refused(axialFatigueHistory(large.axial, large.result, selection()))).toEqual(['fatigue-axial-bound', 'member.stressPa[1]']);
  });
});
