import { describe, expect, it } from 'vitest';
import { createPiecewiseDraft, editPiecewiseDraft, type FatiguePiecewiseCommon, type FatiguePiecewiseDraft,
  type FatiguePiecewiseEdit } from './fatiguePiecewiseDraft.js';
import { analyzeDetailDraft, createDetailDraft, detailProblem, detailSavedInput, editDetailDraft, restoreDetailDraft,
  type FatigueDetailDraft, type FatigueDetailEdit } from './fatigueDetailDraft.js';
import type { FatigueHistoryDraft } from './fatigueSession.js';
import { relative } from './fatigue.testSupport.js';

/*
 * Expected values are written from published formulas, independently of the implementation. The S-N constants are TEST
 * calibrations copied from DNV-RP-C203 (2005, amended 2006) Table 2-1 (air; m = 3 to 1e7 cycles, then m = 5), not
 * product defaults: E (fillet weld throat shear, Table A-8) log a1 = 12.010, F1 (bolt in tension, Table A-2) log a1 = 11.699.
 * ISO metric tensile stress area As = pi/4 (d - 0.938194 P)^2 (ISO 898-1, as tabulated by Fastenal).
 */
const stressAt = (logA: number, slope: number, cycles: number): number => (10 ** logA / cycles) ** (1 / slope);
const COMMON: FatiguePiecewiseCommon = { stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  curveSource: { reference: 'DNV-RP-C203 (2005, amended 2006) Table 2-1, air', condition: 'unit test calibration only' } };
function calibration(logA1: number): FatiguePiecewiseDraft {
  const edits: FatiguePiecewiseEdit[] = [{ kind: 'segment-add' },
    { kind: 'segment-value', index: 0, field: 'fromStress', source: String(stressAt(logA1, 3, 1e5)) },
    { kind: 'segment-value', index: 0, field: 'fromCycles', source: '100000' }, { kind: 'segment-value', index: 0, field: 'slope', source: '3' },
    { kind: 'segment-value', index: 1, field: 'fromStress', source: String(stressAt(logA1, 3, 1e7)) },
    { kind: 'segment-value', index: 1, field: 'fromCycles', source: '10000000' }, { kind: 'segment-value', index: 1, field: 'slope', source: '5' },
    { kind: 'end-cycles', source: '100000000' }, { kind: 'end', value: 'none' },
    { kind: 'applicability', field: 'material', source: 'structural steel in air' },
    { kind: 'applicability', field: 'detail', source: 'DNV detail category (test)' },
    { kind: 'applicability', field: 'scope', source: 'unit test only' }];
  return edits.reduce(editPiecewiseDraft, createPiecewiseDraft());
}
const joint = (edits: readonly FatigueDetailEdit[]): FatigueDetailDraft => edits.reduce(editDetailDraft, createDetailDraft());
const row = (stress: string, sequence: FatigueHistoryDraft['sequence'], repeats: string): FatigueHistoryDraft =>
  ({ key: 'history-1', stress, sequence, repeats, source: { reference: 'hand-written test history', condition: 'unit test' }, imported: null });
const WELD: readonly FatigueDetailEdit[] = [{ kind: 'kind', value: 'weld' }, { kind: 'weld-area', value: 'fillet-throat-area' },
  { kind: 'weld-concentric', value: true }, { kind: 'value', field: 'weldSize', source: '5' },
  { kind: 'value', field: 'weldLength', source: '100' }, { kind: 'value', field: 'weldLines', source: '2' },
  { kind: 'quantity', value: 'weld-group-concentric-shear-force' }, { kind: 'location', source: 'lap joint, user hand calculation' },
  { kind: 'curve-stress', value: 'weld-fillet-throat-nominal-shear' }, { kind: 'force', key: 'history-1', source: '0, 80000' }];
const BOLT: readonly FatigueDetailEdit[] = [{ kind: 'kind', value: 'bolt' }, { kind: 'bolt-area', value: 'iso-metric-thread-tensile-stress-area' },
  { kind: 'value', field: 'boltDiameter', source: '20' }, { kind: 'value', field: 'boltPitch', source: '2.5' },
  { kind: 'quantity', value: 'bolt-total-axial-force' }, { kind: 'location', source: 'bolt B1, user joint analysis' },
  { kind: 'curve-stress', value: 'bolt-axial-normal-tensile-stress-area' }, { kind: 'force', key: 'history-1', source: '120000, 135000' }];

function life(draft: FatigueDetailDraft, curve: FatiguePiecewiseDraft, rows: readonly FatigueHistoryDraft[]): number {
  const analysis = analyzeDetailDraft(draft, curve, COMMON, rows, []);
  if (!analysis.ok) throw new Error(`${analysis.key} at ${analysis.field ?? ''}`);
  if (analysis.result.analysis.life.kind !== 'finite') throw new Error(analysis.result.analysis.life.kind);
  return analysis.result.analysis.life.spectrumRepetitions;
}
const refusal = (draft: FatigueDetailDraft, curve: FatiguePiecewiseDraft, rows: readonly FatigueHistoryDraft[]): unknown => {
  const checked = detailProblem(draft, curve, COMMON, rows, []);
  return checked.ok ? 'accepted' : [checked.key, checked.field];
};

describe('joint draft: independent known lives', () => {
  it('fillet weld group in shear on the throat area (2 x 5 mm x 100 mm, 0 -> 80 kN, curve E)', () => {
    // A = 1000 mm2, delta tau = 80 MPa (m = 3 line): N = 10^12.010 / 80^3 = 1.998619e6 cycles, one cycle per period.
    const analysis = analyzeDetailDraft(joint(WELD), calibration(12.010), COMMON, [row('', 'repeated-periodic', '1')], []);
    if (!analysis.ok) throw new Error(analysis.key);
    expect(analysis.result.areaMm2).toBe(1000);
    expect(analysis.result.stressHistories[0]?.stressMpa).toEqual([0, 80]);
    expect(relative(life(joint(WELD), calibration(12.010), [row('', 'repeated-periodic', '1')]), 10 ** 12.010 / 80 ** 3)).toBeLessThan(1e-9);
    expect(relative(life(joint(WELD), calibration(12.010), [row('', 'repeated-periodic', '1')]), 1.998619e6)).toBeLessThan(1e-6);
  });
  it('bolt M20 x 2.5 in tension on the tensile stress area (120 <-> 135 kN, 1000 periods, curve F1)', () => {
    const area = (Math.PI / 4) * (20 - 0.938194 * 2.5) ** 2;
    const cycles = 10 ** 11.699 / (15_000 / area) ** 3;
    const value = life(joint(BOLT), calibration(11.699), [row('', 'repeated-periodic', '1000')]);
    expect(relative(value, cycles / 1000)).toBeLessThan(1e-6);
    expect(relative(value, 2173.4)).toBeLessThan(1e-4);
  });
  it('the same weld from the stress already in the throat definition gives the same life', () => {
    const draft = joint([...WELD, { kind: 'quantity', value: 'detail-stress' }, { kind: 'loading-stress', value: 'weld-fillet-throat-nominal-shear' }]);
    expect(relative(life(draft, calibration(12.010), [row('0, 80', 'repeated-periodic', '1')]), 10 ** 12.010 / 80 ** 3)).toBeLessThan(1e-9);
  });
});

describe('joint draft: wrong area, definition, quantity or unit is refused at its field', () => {
  const rows = [row('', 'repeated-periodic', '1')];
  it('refuses the shank area against a tensile-stress-area calibration', () => {
    const draft = joint([...BOLT, { kind: 'bolt-area', value: 'nominal-shank-area' }]);
    expect(refusal(draft, calibration(11.699), rows)).toEqual(['fatigue.error.detailStressMismatch', 'detail:curveStress']);
  });
  it('refuses stress histories stated in another definition than the joint produces', () => {
    const draft = joint([...WELD, { kind: 'quantity', value: 'detail-stress' }, { kind: 'loading-stress', value: 'weld-fillet-leg-nominal-shear' }]);
    expect(refusal(draft, calibration(12.010), [row('0, 80', 'repeated-periodic', '1')]))
      .toEqual(['fatigue.error.detailStressMismatch', 'detail:loadingStress']);
  });
  it('does not derive a bolt force from an external joint force', () => {
    const draft = joint([...BOLT, { kind: 'quantity', value: 'joint-external-axial-force' }]);
    expect(refusal(draft, calibration(11.699), rows)).toEqual(['fatigue.error.detailLoadDistribution', 'detail:quantity']);
  });
  it('requires the explicit in-plane shear statement of a weld group', () => {
    expect(refusal(joint([...WELD, { kind: 'weld-concentric', value: false }]), calibration(12.010), rows))
      .toEqual(['fatigue.error.detailLoadPath', 'detail:weldConcentric']);
  });
  it('refuses dimensions whose area underflows to 0 mm2 (as geometry, at the first dimension)', () => {
    // Each dimension reads as the positive double 1e-200 mm through the ordinary expression reader.
    const draft = joint([...WELD, { kind: 'value', field: 'weldSize', source: '1/10^200' }, { kind: 'value', field: 'weldLength', source: '1/10^200' },
      { kind: 'value', field: 'weldLines', source: '1' }]);
    const checked = detailProblem(draft, calibration(12.010), COMMON, rows, []);
    expect(checked.ok ? 'accepted' : [checked.key, checked.field, checked.diagnostic]).toEqual(['fatigue.error.detailGeometry', 'detail:weldSize', null]);
  });
  it('never re-reads a typed MPa list as N: switching to a force quantity needs its own force list', () => {
    const stress = joint([...WELD, { kind: 'quantity', value: 'detail-stress' }, { kind: 'loading-stress', value: 'weld-fillet-throat-nominal-shear' },
      { kind: 'force', key: 'history-1', source: '' }]);
    expect(refusal(stress, calibration(12.010), [row('0, 80', 'repeated-periodic', '1')])).toBe('accepted');
    const force = editDetailDraft(stress, { kind: 'quantity', value: 'weld-group-concentric-shear-force' });
    expect(refusal(force, calibration(12.010), [row('0, 80', 'repeated-periodic', '1')]))
      .toEqual(['fatigue.error.detailForceLength', 'history:0:force']);
  });
  it('refuses a missing choice at its own field, and a kN-like entry in the force list', () => {
    expect(refusal(createDetailDraft(), calibration(12.010), rows)).toEqual(['fatigue.error.detailKind', 'detail:kind']);
    expect(refusal(joint([...WELD, { kind: 'curve-stress', value: '' }]), calibration(12.010), rows))
      .toEqual(['fatigue.error.detailStress', 'detail:curveStress']);
    expect(refusal(joint([...WELD, { kind: 'force', key: 'history-1', source: '0, 80kN' }]), calibration(12.010), rows))
      .toEqual(['fatigue.error.detailForceEntry', 'history:0:force']);
    expect(refusal(joint([...WELD, { kind: 'location', source: ' ' }]), calibration(12.010), rows))
      .toEqual(['fatigue.error.detailLocation', 'detail:location']);
  });
});

describe('joint draft: saved form and restore', () => {
  it('saves inputs only (version 6) and restores drafts that rebuild the same input', () => {
    const rows = [row('', 'repeated-periodic', '1000')];
    const checked = detailProblem(joint(BOLT), calibration(11.699), COMMON, rows, []);
    if (!checked.ok) throw new Error(checked.key);
    const saved = detailSavedInput(checked.input, 'document-1');
    if (!saved.ok) throw new Error(saved.diagnostic ?? saved.key);
    expect(saved.saved.schema).toBe('pointercad-fatigue-saved/6');
    expect(JSON.stringify(saved.saved)).not.toMatch(/"(?:areaMm2|stressHistories|damage|life|result|analysis)"/u);
    const restored = restoreDetailDraft(saved.saved);
    expect(restored.detail.values).toMatchObject({ boltDiameter: '20', boltPitch: '2.5' });
    expect(restored.detail.forces).toEqual({ 'history-1': '120000, 135000' });
    const again = detailProblem(restored.detail, restored.piecewise, COMMON, rows, []);
    expect(again.ok && JSON.stringify(again.input) === JSON.stringify(checked.input)).toBe(true);
  });
});
