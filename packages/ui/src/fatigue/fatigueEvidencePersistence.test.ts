import { describe, expect, it } from 'vitest';
import { readFatigueSavedInput } from '@pointercad/model/beam-analysis';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { editFatigueSession, fatigueDraftIsSaved, fatigueSavedInput, restoreFatigueSession, type FatigueEdit } from './fatigueSession.js';

// Synthetic ranges are intentionally broad, so a changed but still in-range coefficient must lose its old evidence.
const evidence = { property: 'sn', sourceId: 'synthetic-sn', sourceKind: 'user-provided',
  citation: 'Synthetic test table', materialConditionId: 's45c-normalized-reference',
  heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20,
  temperatureRange: { lower: 20, upper: 20, unit: 'degC' },
  units: { referenceStressMpa: 'MPa', referenceCycles: 'cycle', slope: '1' },
  testConditions: { description: 'Synthetic uniaxial test', parameters: { law: 'single-slope',
    stressDefinition: 'range', meanStressAssumption: 'mean-independent' } },
  validRange: { referenceStressMpa: { lower: 50, upper: 150, unit: 'MPa' },
    referenceCycles: { lower: 1e6, upper: 3e6, unit: 'cycle' }, slope: { lower: 2, upper: 4, unit: '1' } } };

function loaded() {
  const initial = fatigueSavedInput(edited(BASE_EDITS), [], 'fatigue-owner');
  if (!initial.ok) throw new Error('fixture must be valid');
  return readFatigueSavedInput({ ...initial.saved, curveEvidence: evidence }, 'fatigue');
}

describe('restored fatigue curve evidence', () => {
  it('also preserves evidence when a saved Goodman correction is edited independently', () => {
    const edits: FatigueEdit[] = [...BASE_EDITS,
      { kind: 'stress-definition', value: 'amplitude' }, { kind: 'mean-assumption', value: 'fully-reversed-only' },
      { kind: 'correction-mode', value: 'goodman' }, { kind: 'correction-applicability', value: true },
      { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '400 MPa' },
      { kind: 'correction-value', field: 'yieldStrengthMpa', source: '300 MPa' },
      { kind: 'correction-value', field: 'minimumCycles', source: '1001' },
      { kind: 'correction-source', field: 'reference', source: 'synthetic strength' },
      { kind: 'correction-source', field: 'condition', source: 'synthetic condition' }];
    const initial = fatigueSavedInput(edited(edits), [], 'fatigue-owner');
    if (!initial.ok) throw new Error('fixture must be valid');
    const correctionEvidence = { ...evidence, testConditions: { ...evidence.testConditions, parameters: {
      law: 'single-slope', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only' } } };
    const saved = readFatigueSavedInput({ ...initial.saved, curveEvidence: correctionEvidence }, 'fatigue');
    const session = restoreFatigueSession('fatigue-owner', saved);
    const changed = editFatigueSession(session, { kind: 'correction-value', field: 'yieldStrengthMpa', source: '250 MPa' });
    const result = fatigueSavedInput(changed, [], 'fatigue-owner');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected saved Goodman draft');
    expect(readFatigueSavedInput(result.saved, 'fatigue').curveEvidence).toEqual(correctionEvidence);
  });

  it('owns and preserves the evidence through an unrelated history edit and the actual saved reader', () => {
    const saved = loaded(), session = restoreFatigueSession('fatigue-owner', saved);
    const changed = editFatigueSession(session, { kind: 'history-stress', index: 0, source: '0, 100, 0' });
    const result = fatigueSavedInput(changed, [], 'fatigue-owner');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected saved draft');
    expect(result.saved.curveEvidence).toEqual(evidence);
    expect(result.saved.curveEvidence).not.toBe(saved.curveEvidence);
    expect(readFatigueSavedInput(JSON.parse(JSON.stringify(result.saved)), 'fatigue')).toEqual(result.saved);
  });

  it.each<FatigueEdit>([
    { kind: 'value', field: 'slope', source: '4' },
    { kind: 'stress-definition', value: 'amplitude' },
    { kind: 'mean-assumption', value: 'fully-reversed-only' },
    { kind: 'curve-source', field: 'reference', source: 'another source' },
  ])('drops the old evidence after a curve or source change: $kind', edit => {
    const saved = loaded(), changed = editFatigueSession(restoreFatigueSession('fatigue-owner', saved), edit);
    const result = fatigueSavedInput(changed, [], 'fatigue-owner');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid changed draft');
    expect(result.saved).not.toHaveProperty('curveEvidence');
    expect(fatigueDraftIsSaved(changed, [], saved)).toBe(false);
    expect(readFatigueSavedInput(result.saved, 'fatigue').curveEvidence).toBeUndefined();
  });

  it('keeps an edited-then-reverted draft dirty when its evidence has been invalidated', () => {
    const saved = loaded();
    const changed = editFatigueSession(restoreFatigueSession('fatigue-owner', saved), { kind: 'value', field: 'slope', source: '4' });
    const reverted = editFatigueSession(changed, { kind: 'value', field: 'slope', source: '3' });
    expect(fatigueDraftIsSaved(reverted, [], saved)).toBe(false);
    const result = fatigueSavedInput(reverted, [], 'fatigue-owner');
    expect(result.ok && result.saved.curveEvidence).toBeUndefined();
  });
});

it('does not mark the draft dirty when only evidence record insertion order differs', () => {
  const saved = loaded(), e = saved.curveEvidence;
  if (e === undefined) throw new Error('Expected loaded evidence');
  const reordered = { ...saved, curveEvidence: { ...e,
    temperatureRange: { unit: e.temperatureRange.unit, upper: e.temperatureRange.upper, lower: e.temperatureRange.lower },
    units: Object.fromEntries(Object.entries(e.units).reverse()),
    testConditions: { parameters: Object.fromEntries(Object.entries(e.testConditions.parameters).reverse()),
      description: e.testConditions.description },
    validRange: Object.fromEntries(Object.entries(e.validRange).reverse().map(([key, value]) =>
      [key, { unit: value.unit, upper: value.upper, lower: value.lower }])),
  } };
  expect(fatigueDraftIsSaved(restoreFatigueSession('fatigue-owner', saved), [], reordered)).toBe(true);
  expect(fatigueDraftIsSaved(restoreFatigueSession('fatigue-owner', reordered), [], saved)).toBe(true);
  const changed = { ...reordered, curveEvidence: { ...reordered.curveEvidence, citation: 'A different citation' } };
  expect(fatigueDraftIsSaved(restoreFatigueSession('fatigue-owner', saved), [], changed)).toBe(false);
});
