import { describe, expect, it } from 'vitest';

import { DEFAULT_DENSITY_MATERIAL_ID, DENSITY_MATERIALS, findDensityMaterial } from './densityMaterials.js';
import { densityGPerCm3ToKgM3 } from './densityMaterials.js';
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
