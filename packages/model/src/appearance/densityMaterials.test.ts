import { describe, expect, it } from 'vitest';

import { DEFAULT_DENSITY_MATERIAL_ID, DENSITY_MATERIALS, findDensityMaterial } from './densityMaterials.js';

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
