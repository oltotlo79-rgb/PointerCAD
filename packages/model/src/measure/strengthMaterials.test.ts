import { describe, expect, it } from 'vitest';
import { findDensityMaterial } from '../appearance/densityMaterials.js';
import { METRIC_THREADS } from '../thread/metricThread.js';
import { BOLT_TENSILE_AREAS } from './boltStressAreas.js';
import { findStrengthMaterial, STRENGTH_MATERIALS, STRENGTH_SOURCES } from './strengthMaterials.js';
import { checkStrengthMaterialCondition, strengthMaterialSources } from './strengthMaterialTypes.js';
import { tensileStressArea } from './tensileStressArea.js';

function material(id: string) {
  const result = findStrengthMaterial(id); if (result === undefined) throw new Error(id); return result;
}
describe('条件と出典を持つ材料値', () => {
  it('材料条件のIDは重複せず、密度の対応と強度各値の出典がある', () => {
    expect(new Set(STRENGTH_MATERIALS.map((row) => row.id)).size).toBe(STRENGTH_MATERIALS.length);
    for (const row of STRENGTH_MATERIALS) {
      expect(findDensityMaterial(row.densityMaterialId)).toBeDefined();
      for (const value of [row.yieldStress, row.tensileStrength, row.youngModulus, row.shearModulus]) {
        if (value === null) continue;
        const source = STRENGTH_SOURCES[value.sourceId]; expect(source).toBeDefined();
        expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(source.url).toMatch(/^https:\/\//u);
        expect(Number(value.mpa)).toBeGreaterThan(0);
      }
    }
  });
  it.each([
    ['ss400-plate-0-16', 16, '245'], ['ss400-plate-16-40', 40, '235'], ['ss400-plate-40-100', 100, '215'],
  ])('SS400の厚さの上端%sを含み、隣の範囲へ外挿しない', (id, thickness, yieldMpa) => {
    if (typeof thickness !== 'number') throw new Error('thickness');
    const row = material(String(id)); expect(row.yieldStress.mpa).toBe(yieldMpa);
    expect(checkStrengthMaterialCondition(row, thickness).ok).toBe(true);
    expect(checkStrengthMaterialCondition(row, thickness + 0.001).ok).toBe(false);
    expect(checkStrengthMaterialCondition(row, null)).toMatchObject({ ok: false, reason: 'thickness-required' });
  });
  it('A5052の掲載下端0.2mmを含み、範囲外を採用しない', () => {
    const row = material('a5052p-h34-0.2-1.3');
    for (const thickness of [0.2, 1.3]) expect(checkStrengthMaterialCondition(row, thickness).ok).toBe(true);
    for (const thickness of [0, 0.199, 1.301, NaN, Infinity]) expect(checkStrengthMaterialCondition(row, thickness).ok).toBe(false);
  });
  it('確認できない弾性値を候補値から埋めない', () => {
    const stainless = strengthMaterialSources(material('sus304-solution-cold-rolled'));
    expect(stainless.get('youngModulus')).toBe('193000'); expect(stainless.has('shearModulus')).toBe(false);
    const aluminum = strengthMaterialSources(material('a5052p-h34-0.2-1.3'));
    expect(aluminum.has('youngModulus')).toBe(false); expect(aluminum.has('shearModulus')).toBe(false);
  });
  it('S45Cの焼ならしと焼入焼戻を別の参考条件にする', () => {
    expect(material('s45c-normalized-reference').yieldStress).toMatchObject({ mpa: '345', basis: 'reference' });
    expect(material('s45c-quenched-tempered-reference').yieldStress).toMatchObject({ mpa: '490', basis: 'reference' });
  });
});
describe('呼び面積と近似式を区別する', () => {
  it('独立の表値M10x1.5は58、近似式は未丸めの別の値になる', () => {
    const nominal = tensileStressArea(10, 1.5), approximation = tensileStressArea(10, 1.5, 'approximation');
    expect(nominal).toMatchObject({ ok: true, method: 'table', area: { value: 58 } });
    if (!approximation.ok) throw new Error(approximation.reason);
    expect(approximation.area.value).toBeCloseTo(Math.PI / 4 * (10 - 0.9382 * 1.5) ** 2, 12);
    expect(approximation.area.value).not.toBe(58);
  });
  it('M52細目は未掲載の表値を捏造せず、明示的な近似式だけを許す', () => {
    expect(tensileStressArea(52, 3)).toEqual({ ok: false, reason: 'unverified-table' });
    expect(tensileStressArea(52, 3, 'approximation').ok).toBe(true);
  });
  it('全28呼びの並目は出典付き表値、全56組は明示近似式で扱える', () => {
    for (const size of METRIC_THREADS) {
      expect(tensileStressArea(size.diameter, size.coarsePitch).ok, size.designation).toBe(true);
      for (const pitch of [size.coarsePitch, size.finePitch]) expect(tensileStressArea(size.diameter, pitch, 'approximation').ok).toBe(true);
    }
    expect(new Set(BOLT_TENSILE_AREAS.map((row) => `${String(row.diameterMm)}:${String(row.pitchMm)}`)).size).toBe(BOLT_TENSILE_AREAS.length);
  });
  it.each([[0, 1], [-2, 0.4], [10, 0], [10, 2], [NaN, 1], [Infinity, 1], [10, Infinity]])('不正な径/ピッチ %s/%sを拒否する', (diameter, pitch) => {
    expect(tensileStressArea(diameter, pitch)).toMatchObject({ ok: false, reason: 'invalid-thread' });
  });
});
