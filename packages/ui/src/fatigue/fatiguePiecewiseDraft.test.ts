import { describe, expect, it } from 'vitest';
import { analyzePiecewiseDraft, createPiecewiseDraft, editPiecewiseDraft, piecewiseProblem, piecewiseSavedInput,
  restorePiecewiseDraft, type FatiguePiecewiseDraft } from './fatiguePiecewiseDraft.js';

/* SYNTHETIC calibration (task180's analytically specified two-slope curve), not a steel standard, detail category or FAT
 * class: N = 1e5 (400/S)^3 down to 200 MPa, then N = 8e5 (200/S)^5 down to 1e8 cycles. */
const source = { kind: 'user-supplied', reference: 'synthetic test calibration (not a standard)', condition: 'unit test only' } as const;
const common = { stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only',
  curveSource: { reference: source.reference, condition: source.condition } } as const;
const histories = [
  { id: 'upper', unit: 'MPa', stressMpa: [125, -125], sequence: 'repeated-periodic', repeats: 2, source },
  { id: 'lower', unit: 'MPa', stressMpa: [80, -80], sequence: 'repeated-periodic', repeats: 3, source },
] as const;
function typed(): FatiguePiecewiseDraft {
  let draft = createPiecewiseDraft();
  draft = editPiecewiseDraft(draft, { kind: 'segment-add' });
  const values = [['400', '100000', '3'], ['200', '800000', '5']] as const;
  for (const [index, row] of values.entries()) {
    draft = editPiecewiseDraft(draft, { kind: 'segment-value', index, field: 'fromStress', source: row[0] });
    draft = editPiecewiseDraft(draft, { kind: 'segment-value', index, field: 'fromCycles', source: row[1] });
    draft = editPiecewiseDraft(draft, { kind: 'segment-value', index, field: 'slope', source: row[2] });
  }
  draft = editPiecewiseDraft(draft, { kind: 'end-cycles', source: '100000000' });
  draft = editPiecewiseDraft(draft, { kind: 'end', value: 'cutoff-at-end' });
  for (const field of ['material', 'detail', 'scope'] as const) draft = editPiecewiseDraft(draft, { kind: 'applicability', field, source: 'synthetic' });
  return draft;
}

describe('piecewise S-N calibration draft of the fatigue panel', () => {
  it('starts empty and adds and removes ordered rows; the last row stays', () => {
    const empty = createPiecewiseDraft();
    expect(empty.segments).toEqual([{ key: 'segment-1', fromStress: '', fromCycles: '', slope: '' }]);
    expect([empty.endCycles, empty.end, empty.applicability]).toEqual(['', '', { material: '', detail: '', scope: '' }]);
    expect(editPiecewiseDraft(empty, { kind: 'segment-remove', index: 0 })).toBe(empty);
    const two = editPiecewiseDraft(editPiecewiseDraft(empty, { kind: 'segment-add' }), { kind: 'segment-add' });
    expect(two.segments.map(row => row.key)).toEqual(['segment-1', 'segment-2', 'segment-3']);
    expect(editPiecewiseDraft(two, { kind: 'segment-remove', index: 1 }).segments.map(row => row.key)).toEqual(['segment-1', 'segment-3']);
  });

  it('sums Miner damage across both slopes as computed by hand', () => {
    const checked = analyzePiecewiseDraft(typed(), common, histories, []);
    if (!checked.ok) throw new Error(`${checked.key} at ${String(checked.field)}`);
    const expected = 2 / 409600 + 3 / 2441406.25;
    expect(Math.abs(checked.result.damage - expected) / expected).toBeLessThan(1e-12);
    expect([checked.result.codeCompliance, checked.result.structuralCertification]).toEqual([false, false]);
  });

  it('points an invalid value, an unordered row and a discontinuous knee at its own row', () => {
    const slope = editPiecewiseDraft(typed(), { kind: 'segment-value', index: 1, field: 'slope', source: '' });
    expect(piecewiseProblem(slope, common, histories, [])).toMatchObject({ ok: false, key: 'fatigue.error.field', field: 'piecewise:segment:1:slope' });
    const knee = editPiecewiseDraft(typed(), { kind: 'segment-value', index: 1, field: 'fromStress', source: '210' });
    expect(piecewiseProblem(knee, common, histories, [])).toMatchObject({ ok: false, key: 'fatigue.error.piecewiseContinuity', field: 'piecewise:segment:1' });
    const order = editPiecewiseDraft(typed(), { kind: 'segment-value', index: 1, field: 'fromCycles', source: '1000' });
    expect(piecewiseProblem(order, common, histories, [])).toMatchObject({ ok: false, key: 'fatigue.error.piecewiseOrder', field: 'piecewise:segment:1' });
    const detail = editPiecewiseDraft(typed(), { kind: 'applicability', field: 'detail', source: ' ' });
    expect(piecewiseProblem(detail, common, histories, [])).toMatchObject({ ok: false, key: 'fatigue.error.piecewiseApplicability', field: 'piecewise:detail' });
    const end = editPiecewiseDraft(typed(), { kind: 'end', value: '' });
    expect(piecewiseProblem(end, common, histories, [])).toMatchObject({ ok: false, key: 'fatigue.error.piecewiseEnd', field: 'piecewise:end' });
  });

  it('restores a saved version 5 input to a draft that builds exactly the same input', () => {
    const checked = piecewiseProblem(typed(), common, histories, []);
    if (!checked.ok) throw new Error(checked.key);
    const saved = piecewiseSavedInput(checked.problem, 'doc');
    expect(saved).toMatchObject({ schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'doc' } });
    const again = piecewiseProblem(restorePiecewiseDraft(saved), common, histories, []);
    expect(again).toEqual({ ok: true, problem: checked.problem });
  });
});
