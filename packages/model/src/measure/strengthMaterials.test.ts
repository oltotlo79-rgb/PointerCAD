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
  // Independently transcribed table 3, PDF7 / printed p3, G3101 draft PDF SHA-256:
  // 797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893.
  // Transcription JSON SHA-256: 7a1545c41f5730cedebf234d4a8b57be796d5dbb1394b2fc8913685f258696b4.
  // Freeze the printed strings here so the test also runs without the working scratchpad.
  it.each([
    ['ss400-plate-0-16', 0, 16, '16 以下', '245', '245 以上', 'G3101-T3-SS400-Y1'],
    ['ss400-plate-16-40', 16, 40, '16 超え40 以下', '235', '235 以上', 'G3101-T3-SS400-Y2'],
    ['ss400-plate-40-100', 40, 100, '40 超え100 以下', '215', '215 以上', 'G3101-T3-SS400-Y3'],
  ] as const)('%sの規格原案の印刷文字列・単位・範囲を完全一致で固定する',
    (id, lower, upper, thicknessPrinted, minimum, yieldPrinted, yieldRowId) => {
      const row = material(id);
      expect(row.grade).toBe('SS400');
      expect(row.product).toBe('plate');
      expect(row.condition).toBe('圧延鋼板（熱処理の指定なし）');
      expect(row.temperature).toBe('not-specified');
      expect(row.thicknessMm).toEqual({ greaterThan: lower, atMost: upper });
      expect(row.thicknessPrinted).toBe(thicknessPrinted);
      expect(row.yieldStress).toEqual({ mpa: minimum, sourceId: 'jisf-g3101-draft', basis: 'minimum',
        sourceValue: { printed: yieldPrinted, unit: 'N/mm2', rowId: yieldRowId } });
      expect(row.tensileStrength).toEqual({ mpa: '400', maximumMpa: '510', sourceId: 'jisf-g3101-draft', basis: 'minimum',
        sourceValue: { printed: '400～510', unit: 'N/mm2', rowId: 'G3101-T3-SS400-T1' } });
      // Table note equates N/mm2 to MPa. Only the minimum is a calculation input.
      expect(strengthMaterialSources(row).get('yieldStress')).toBe(minimum);
      expect(checkStrengthMaterialCondition(row, lower).ok).toBe(false);
      expect(checkStrengthMaterialCondition(row, lower + 0.001).ok).toBe(true);
      expect(checkStrengthMaterialCondition(row, upper).ok).toBe(true);
      expect(checkStrengthMaterialCondition(row, upper + 0.001).ok).toBe(false);
    });
  it('一次の原案と供給者の抜粋を区別し、版・頁・表・PDFの指紋を固定する', () => {
    expect(STRENGTH_SOURCES['jisf-g3101-draft']).toEqual({
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3101_20230726.pdf',
      publisher: '日本鉄鋼連盟',
      locator: 'PDF7ページ・印刷3ページ、表3（鋼板）。注記: 1 N/mm2 = 1 MPa。注a: 上降伏点ReH、現れない場合は0.2%耐力Rp0.2。最終規格票との差は未確認',
      checkedDate: '2026-10-25', standard: 'JIS G 3101',
      standardEdition: 'JIS G 3101:9999（案）、JISF 2022年度第2回鋼材規格三者委員会 資料4、ファイル日付2023-07-26、更新2024-02-19',
      evidence: 'standard-draft',
      sha256: '797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893',
    });
    expect(STRENGTH_SOURCES['nippon-ss400']).toEqual({
      url: 'https://www.nipponsteel.com/product/plate/list/machinery/pdf/kyouken.pdf',
      publisher: '日本製鉄', locator: 'CORSPACE資料、PDF9ページ、表4-1（SS400と同じと記載された機械的性質）',
      checkedDate: '2026-09-11', standard: 'JIS G 3101', standardEdition: null, evidence: 'supplier-excerpt',
      sha256: 'aa11597e13f303f2fbe0b7b401906d9834ed8e80ce9e15b9f5fcc0b268d56a13',
    });
  });
  it('SS400以外の全4材料条件を変更前のUTF-8バイト列と照合する', () => {
    const steelElasticReference = {
      youngModulus: { mpa: '205000', sourceId: 'jfe-steel-elastic', basis: 'reference' },
      shearModulus: { mpa: '79000', sourceId: 'jfe-steel-elastic', basis: 'reference' },
    };
    const before = [
      {
        id: 's45c-normalized-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼ならし・適用寸法未指定の参考値',
        product: 'general', thicknessMm: null, temperature: 'not-specified',
        yieldStress: { mpa: '345', sourceId: 'tsubaki-s45c', basis: 'reference' },
        tensileStrength: { mpa: '570', sourceId: 'tsubaki-s45c', basis: 'reference' },
        ...steelElasticReference,
      },
      {
        id: 's45c-quenched-tempered-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼入焼戻・適用寸法未指定の参考値',
        product: 'general', thicknessMm: null, temperature: 'not-specified',
        yieldStress: { mpa: '490', sourceId: 'tsubaki-s45c', basis: 'reference' },
        tensileStrength: { mpa: '690', sourceId: 'tsubaki-s45c', basis: 'reference' },
        ...steelElasticReference,
      },
      {
        id: 'sus304-solution-cold-rolled', densityMaterialId: 'stainless', grade: 'SUS304', condition: '冷延鋼板・固溶化処理',
        product: 'cold-rolled-sheet', thicknessMm: null, temperature: 'not-specified',
        yieldStress: { mpa: '205', sourceId: 'nippon-sus304', basis: 'minimum' },
        tensileStrength: { mpa: '520', sourceId: 'nippon-sus304', basis: 'minimum' },
        youngModulus: { mpa: '193000', sourceId: 'nippon-sus304', basis: 'reference' }, shearModulus: null,
      },
      {
        id: 'a5052p-h34-0.2-1.3', densityMaterialId: 'aluminum', grade: 'A5052P', condition: 'H34',
        product: 'plate', thicknessMm: { greaterThan: 0.2, atMost: 1.3, lowerInclusive: true }, temperature: 'not-specified',
        yieldStress: { mpa: '180', sourceId: 'jaa-a5052-h34', basis: 'minimum' },
        tensileStrength: { mpa: '235', sourceId: 'jaa-a5052-h34', basis: 'minimum' },
        youngModulus: null, shearModulus: null,
      },
    ];
    const utf8 = new TextEncoder();
    expect(utf8.encode(JSON.stringify(STRENGTH_MATERIALS.filter(row => row.grade !== 'SS400'))))
      .toEqual(utf8.encode(JSON.stringify(before)));
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
