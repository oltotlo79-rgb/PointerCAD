import { describe, expect, it } from 'vitest';
import type { AnalysisMaterialCapacity } from './analysisModel.js';
import { InputIssue, readAnalysisMaterialCapacity, readBeamMaterials } from './analysisValidation.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from './beamInputs.js';
import { beamCadFixture } from './beamInputs.testSupport.js';
import { readSolidCadSavedInput } from './solidCadInput.js';
import { findStrengthMaterial, STRENGTH_SOURCES } from '../measure/strengthMaterials.js';

const cases = [
  ['ss400-plate-0-16', 245, 'jisf-g3101-draft', 16, '圧延鋼板（熱処理の指定なし）', 'standard-draft', 'minimum'],
  ['ss400-plate-16-40', 235, 'jisf-g3101-draft', 40, '圧延鋼板（熱処理の指定なし）', 'standard-draft', 'minimum'],
  ['ss400-plate-40-100', 215, 'jisf-g3101-draft', 100, '圧延鋼板（熱処理の指定なし）', 'standard-draft', 'minimum'],
  ['s45c-normalized-reference', 345, 'tsubaki-s45c', null, '焼ならし・適用寸法未指定の参考値', 'manufacturer-reference', 'reference'],
  ['s45c-quenched-tempered-reference', 490, 'tsubaki-s45c', null, '焼入焼戻・適用寸法未指定の参考値', 'manufacturer-reference', 'reference'],
] as const;

function capacity(index = 0): AnalysisMaterialCapacity {
  const [materialConditionId, yieldMPa, sourceId, thicknessMm, condition, evidence, basis] = cases[index];
  return { materialConditionId, yieldMPa, sourceId, thicknessMm, condition, evidence, basis };
}
function solidSaved() {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'body',
    fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -1],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function rejection(value: unknown): string {
  try { readAnalysisMaterialCapacity(value); } catch (error) {
    if (error instanceof InputIssue) return error.code;
    throw error;
  }
  throw new Error('Expected capacity rejection');
}

describe('source-bound FE yield capacity', () => {
  it.each(cases)('matches W01 values, source strings and conditions for %s', (id, mpa, sourceId, thicknessMm, condition, evidence, basis) => {
    const preset = findStrengthMaterial(id);
    expect(preset?.yieldStress.mpa).toBe(String(mpa));
    expect(preset?.yieldStress.sourceId).toBe(sourceId);
    expect(preset?.condition).toBe(condition);
    expect(preset?.yieldStress.basis).toBe(basis);
    expect(STRENGTH_SOURCES[sourceId].evidence).toBe(evidence);
    const supplied = { materialConditionId: id, yieldMPa: mpa, sourceId, thicknessMm, condition, evidence, basis };
    const decoded = readAnalysisMaterialCapacity(supplied);
    expect(decoded).toEqual(supplied);
    expect(decoded).not.toBe(supplied);
    const material = beamCadFixture().definition.materials[0];
    expect(readBeamMaterials([{ ...material, capacity: supplied }])[0].capacity).toEqual(supplied);
    expect(readSolidCadSavedInput({ ...solidSaved(), capacity: supplied }).capacity).toEqual(supplied);
  });

  it.each([
    ['source-missing', { ...capacity(), sourceId: undefined }],
    ['condition-mismatch', { ...capacity(3), condition: capacity(4).condition }],
    ['thickness-outside', { ...capacity(2), thicknessMm: 100.001 }],
  ])('refuses %s before publishing a document or producing capacity results', (reason, invalid) => {
    const fixture = beamCadFixture();
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: fixture.definition }] };
    const document = withBeamAnalysisInputs(fixture.document, attachment);
    const existingResult = Object.freeze({ inputSha256: 'previous-input', stressMPa: Object.freeze([10, 0, 0, 0, 0, 0]) });
    const state = { document, result: existingResult };
    const before = structuredClone(state);
    const rejected = { ...attachment, analyses: [{ kind: 'standard-members', definition: { ...fixture.definition,
      materials: fixture.definition.materials.map(material => ({ ...material, capacity: invalid })) } }] };
    const checked = readBeamAnalysisInputs(rejected, document.id);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error('Expected reason-coded refusal');
    expect(checked.issue.code).toBe(`material-capacity-${reason}`);
    expect(checked).not.toHaveProperty('value');
    expect(checked).not.toHaveProperty('safetyFactor');
    expect(() => withBeamAnalysisInputs(document, rejected)).toThrow(`material-capacity-${reason}`);
    expect(() => readSolidCadSavedInput({ ...solidSaved(), capacity: invalid })).toThrow(InputIssue);
    expect(rejection(invalid)).toBe(`material-capacity-${reason}`);
    expect(state).toEqual(before);
    expect(state.document).toBe(document);
    expect(state.result).toBe(existingResult);
  });

  it.each([
    [16, 0, 1, '16 以下'], [40, 1, 2, '16 超え40 以下'],
  ] as const)('uses the printed inclusive upper boundary at %s mm', (thicknessMm, lower, upper, printed) => {
    expect(findStrengthMaterial(capacity(lower).materialConditionId)?.thicknessPrinted).toBe(printed);
    expect(readAnalysisMaterialCapacity({ ...capacity(lower), thicknessMm })).toEqual(capacity(lower));
    expect(rejection({ ...capacity(upper), thicknessMm })).toBe('material-capacity-thickness-outside');
    expect(readAnalysisMaterialCapacity({ ...capacity(upper), thicknessMm: thicknessMm + 0.001 }).materialConditionId)
      .toBe(capacity(upper).materialConditionId);
  });

  it('keeps absent legacy values missing without filling them from names or elastic properties', () => {
    const material = { ...beamCadFixture().definition.materials[0], id: 'ss400-plate-0-16' };
    expect(readBeamMaterials([material])).toEqual([material]);
    expect(Object.hasOwn(readBeamMaterials([material])[0], 'capacity')).toBe(false);
    expect(rejection(readBeamMaterials([material])[0].capacity)).toBe('material-capacity-missing');
    expect(readSolidCadSavedInput(solidSaved())).toEqual(solidSaved());
    expect(Object.hasOwn(readSolidCadSavedInput(solidSaved()), 'capacity')).toBe(false);
  });

  it.each([
    ['missing source key', Object.fromEntries(Object.entries(capacity()).filter(([key]) => key !== 'sourceId')), 'source-missing'],
    ['empty source', { ...capacity(), sourceId: '' }, 'source-missing'],
    ['unknown source', { ...capacity(), sourceId: 'not-a-source' }, 'source-mismatch'],
    ['different source', { ...capacity(), sourceId: 'nippon-ss400' }, 'source-mismatch'],
    ['reference promoted to minimum', { ...capacity(3), basis: 'minimum' }, 'source-mismatch'],
    ['reference promoted to draft', { ...capacity(3), evidence: 'standard-draft' }, 'source-mismatch'],
    ['different yield', { ...capacity(), yieldMPa: 235 }, 'value-mismatch'],
    ['missing thickness', { ...capacity(), thicknessMm: null }, 'thickness-required'],
    ['unknown condition ID', { ...capacity(), materialConditionId: 'SS400' }, 'condition-mismatch'],
  ])('rejects %s rather than repairing the evidence', (_label, input, reason) => {
    expect(rejection(input)).toBe(`material-capacity-${reason}`);
  });

  it.each([null, { ...capacity(), unexpected: true }, { ...capacity(), yieldMPa: NaN },
    { ...capacity(), yieldMPa: 0 }, { ...capacity(), thicknessMm: -1 },
    { ...capacity(), [Symbol('hidden')]: true }])('rejects malformed explicit capacity %j', input => {
    expect(() => readAnalysisMaterialCapacity(input)).toThrow(InputIssue);
  });
});
