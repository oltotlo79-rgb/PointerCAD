import { describe, expect, it } from 'vitest';
import { STRENGTH_SOURCES } from '@pointercad/model';
import { readSolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { selectSolidMaterial, solidMaterialCapacityMatches, solidMaterialDraftOf, solidMaterialSourceUrl } from './solidMaterialSelection.js';

describe('solid material yield selection, independent catalogue values', () => {
  it('keeps optional no-yield mode separate from an incomplete chosen material', () => {
    expect(selectSolidMaterial({ materialConditionId: '', thickness: '' })).toMatchObject({ ok: true, capacity: null });
    expect(selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness: '' })).toEqual({ ok: false, issue: 'thickness' });
  });
  it('does not silently switch SS400 thickness conditions at 16 mm', () => {
    const at16 = selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness: '16' });
    expect(at16.ok && at16.capacity?.yieldMPa).toBeCloseTo(245, 12);
    expect(selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness: '17' })).toEqual({ ok: false, issue: 'outside' });
    const at17 = selectSolidMaterial({ materialConditionId: 'ss400-plate-16-40', thickness: '17' });
    expect(at17.ok && at17.capacity?.yieldMPa).toBeCloseTo(235, 12);
    expect(at17.ok && at17.source).toMatchObject({ evidence: 'standard-draft', standard: 'JIS G 3101',
      sha256: '797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893' });
  });
  it.each(['', ' ', 'NaN', 'Infinity', '-1', '0', '1e309', 'unfinished'])('refuses invalid thickness %j for a chosen material', thickness => {
    expect(selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness })).toEqual({ ok: false, issue: 'thickness' });
  });
  it('keeps the two S45C heat treatments and their dimensional uncertainty distinct', () => {
    const normalized = selectSolidMaterial({ materialConditionId: 's45c-normalized-reference', thickness: '16' });
    const tempered = selectSolidMaterial({ materialConditionId: 's45c-quenched-tempered-reference', thickness: '16' });
    expect(normalized.ok && normalized.capacity?.yieldMPa).toBeCloseTo(345, 12);
    expect(tempered.ok && tempered.capacity?.yieldMPa).toBeCloseTo(490, 12);
    expect(normalized.ok && normalized.preset?.thicknessMm).toBeNull();
    expect(tempered.ok && tempered.capacity?.condition).toContain('焼入焼戻');
    expect(normalized.ok && normalized.capacity?.condition).toContain('焼ならし');
  });
  it.each([['s45c-normalized-reference', 345], ['s45c-quenched-tempered-reference', 490]] as const)(
    'preserves saved null thickness for unconstrained preset %s', (materialConditionId, yieldMPa) => {
      const result = selectSolidMaterial({ materialConditionId, thickness: '' });
      if (!result.ok || result.capacity === null) throw new Error('Expected capacity');
      expect(result.capacity.thicknessMm).toBeNull(); expect(result.capacity.yieldMPa).toBeCloseTo(yieldMPa, 12);
      const input = { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'body',
        fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -1],
        linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1,
        capacity: result.capacity };
      const saved = readSolidCadSavedInput(JSON.parse(JSON.stringify(input))).capacity;
      if (saved === undefined) throw new Error('Expected saved capacity');
      expect(saved).toEqual(result.capacity); expect(solidMaterialCapacityMatches(saved)).toBe(true);
      expect(solidMaterialDraftOf(saved)).toEqual({ materialConditionId, thickness: '' });
      for (const thickness of ['NaN', '-1', '0', 'Infinity']) {
        expect(selectSolidMaterial({ materialConditionId, thickness })).toEqual({ ok: false, issue: 'thickness' });
      }
    });
  it('uses the existing expression input normalization for fullwidth thickness', () => {
    const result = selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness: '１６' });
    expect(result.ok && result.capacity?.yieldMPa).toBeCloseTo(245, 12);
    expect(result.ok && result.capacity?.thicknessMm).toBeCloseTo(16, 12);
  });
  it('retains inclusive aluminium lower bounds without applying them to SS400', () => {
    const selection = selectSolidMaterial({ materialConditionId: 'a5052p-h34-0.2-1.3', thickness: '0.2' });
    expect(selection.ok && selection.capacity?.yieldMPa).toBeCloseTo(180, 12);
    expect(selectSolidMaterial({ materialConditionId: 'a5052p-h34-0.2-1.3', thickness: '0.19' })).toEqual({ ok: false, issue: 'outside' });
  });
  it('rejects changed saved evidence, yield and condition instead of borrowing current evidence', () => {
    const result = selectSolidMaterial({ materialConditionId: 'ss400-plate-0-16', thickness: '16' });
    if (!result.ok || result.capacity === null) throw new Error('Expected valid fixture');
    const value = result.capacity;
    expect(solidMaterialCapacityMatches(value)).toBe(true);
    for (const changed of [{ ...value, yieldMPa: 235 }, { ...value, sourceId: 'other' }, { ...value, condition: 'other' },
      { ...value, evidence: 'measured-reference' as const }, { ...value, basis: 'reference' as const },
      { ...value, thicknessMm: 17 }, { ...value, materialConditionId: 'missing' }]) expect(solidMaterialCapacityMatches(changed)).toBe(false);
    expect(solidMaterialDraftOf(null)).toEqual({ materialConditionId: '', thickness: '' });
    expect(solidMaterialDraftOf(value)).toEqual({ materialConditionId: 'ss400-plate-0-16', thickness: '16' });
    expect(Object.keys(value).sort()).toEqual(['basis', 'condition', 'evidence', 'materialConditionId', 'sourceId', 'thicknessMm', 'yieldMPa']);
  });
  it('uses only catalogue HTTP(S) links', () => {
    for (const source of Object.values(STRENGTH_SOURCES)) expect(solidMaterialSourceUrl(source)).toBe(source.url);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'not a URL']) expect(solidMaterialSourceUrl({ url })).toBeNull();
  });
});
