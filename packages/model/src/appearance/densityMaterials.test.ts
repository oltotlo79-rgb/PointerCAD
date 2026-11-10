import { describe, expect, it } from 'vitest';

import { DEFAULT_DENSITY_MATERIAL_ID, DENSITY_MATERIALS, findDensityMaterial } from './densityMaterials.js';
import { densityGPerCm3ToKgM3 } from './densityMaterials.js';
import type { DensityMaterial } from './densityMaterials.js';
import { findStrengthMaterial } from '../measure/strengthMaterials.js';

describe('DENSITY_MATERIALS', () => {
  it('非木材13種+木材6種の19件になる(§2.4.2。計画書の見た目上の「15行」との差は報告参照)', () => {
    expect(DENSITY_MATERIALS.length).toBe(19);
  });

  it('id は重複しない', () => {
    const ids = DENSITY_MATERIALS.map((material) => material.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('すべての密度が正の有限数', () => {
    for (const material of DENSITY_MATERIALS) {
      expect(Number.isFinite(material.density)).toBe(true);
      expect(material.density).toBeGreaterThan(0);
    }
  });

  it('鋼の密度は 7.85 g/cm³', () => {
    expect(findDensityMaterial('steel')?.density).toBe(7.85);
  });

  it('木材(ナラ)は wood-oak として引ける(materialPresets.ts の WOOD_SPECIES と共有)', () => {
    expect(findDensityMaterial('wood-oak')?.density).toBe(0.68);
  });

  it('custom は密度が固定値でないためこの表に含まれない', () => {
    expect(findDensityMaterial('custom')).toBeUndefined();
  });

  it('既定は steel(7.85)', () => {
    expect(DEFAULT_DENSITY_MATERIAL_ID).toBe('steel');
    expect(findDensityMaterial(DEFAULT_DENSITY_MATERIAL_ID)?.density).toBe(7.85);
  });

  it('未知の id は undefined', () => {
    expect(findDensityMaterial('unobtainium')).toBeUndefined();
  });
});

describe('CAD density to analysis units', () => {
  it('converts 7.85 g/cm3 to 7850 kg/m3 without rounding and round-trips every existing density', () => {
    expect(densityGPerCm3ToKgM3(7.85)).toBe(7850);
    for (const material of DENSITY_MATERIALS) {
      const kgM3 = densityGPerCm3ToKgM3(material.density);
      expect(Math.abs(kgM3 / 1000 - material.density) / material.density).toBeLessThanOrEqual(1e-12);
    }
  });

  it.each([
    ['ss400-plate-0-16', 'jisf-g3101-draft'],
    ['ss400-plate-16-40', 'jisf-g3101-draft'],
    ['ss400-plate-40-100', 'jisf-g3101-draft'],
    ['s45c-normalized-reference', 'tsubaki-s45c'],
    ['s45c-quenched-tempered-reference', 'tsubaki-s45c'],
  ])('keeps the recorded density association and strength source for %s', (id, sourceId) => {
    const material = findStrengthMaterial(id);
    expect(material?.densityMaterialId).toBe('steel');
    expect(material?.yieldStress.sourceId).toBe(sourceId);
    expect(findDensityMaterial(material?.densityMaterialId ?? '')?.density).toBe(7.85);
  });
});

describe('DensityMaterial source', () => {
  type DensitySource = NonNullable<DensityMaterial['source']>;
  const statedGPerCm3 = (source: DensitySource): number =>
    source.statedUnit === 'kg/(cm2*m)' ? source.statedValue * 10 : source.statedValue;

  it('steel・stainless・aluminum の 3 行だけが出典を持ち、残りの 16 行は出典なし', () => {
    expect(DENSITY_MATERIALS.filter((material) => material.source !== undefined).map((material) => material.id))
      .toEqual(['steel', 'stainless', 'aluminum']);
    expect(DENSITY_MATERIALS.filter((material) => material.source === undefined)).toHaveLength(16);
  });

  it('結ばれた出典は重複せず、使われない出典が無く、掲載値は正の有限数', () => {
    const used = DENSITY_MATERIALS.flatMap((material) => (material.source === undefined ? [] : [material.source]));
    expect(new Set(used).size).toBe(used.length);
    expect(used).toHaveLength(3);
    for (const source of used) {
      expect(Number.isFinite(source.statedValue)).toBe(true);
      expect(source.statedValue).toBeGreaterThan(0);
      expect(source.url.startsWith('https://')).toBe(true);
    }
  });

  const sourceCases: readonly (readonly [id: string, density: number, url: string, condition: string])[] = [
    ['steel', 7.85, 'https://www.niscs.nipponsteel.com/products/ac/forming/data/forming_15.pdf', 'JIS G 3350'],
    ['stainless', 7.93, 'https://www.jfe-steel.co.jp/products/stainless/catalog/g1j-001.pdf', 'SUS304'],
    ['aluminum', 2.68, 'https://www.aluminum.or.jp/fields/kenchiku/kenzai/guide/a/', 'A5052P-H34'],
  ];
  it.each(sourceCases)('%s の表の値 %s は出典 %s の掲載値・条件(%s)と一致し、実測値とは称さない', (id, density, url, condition) => {
    const material = findDensityMaterial(id);
    expect(material?.density).toBe(density);
    const source: DensitySource | undefined = material?.source;
    expect(source?.url).toBe(url);
    expect(source).toBeDefined();
    if (source === undefined) return;
    expect(source.condition).toContain(condition);
    expect(source.condition).toContain('実測値ではない');
    expect(Math.abs(statedGPerCm3(source) - density) / density).toBeLessThanOrEqual(1e-12);
  });
});
