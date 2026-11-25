import { describe, expect, it } from 'vitest';

import { activeSketch } from '../../standard/partPrimitives.js';
import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { catalogItemNominalMass, createCatalogItemSource } from '../source.js';
import { SHEET_FIXING_PLATE_FAMILY } from './sheetFixingPlateCatalog.js';

// Use the independent drawing's edge-based coordinates, and the individual product mass listings.
const DRAWING = [
  { length: 75, centers: [20, 55], masses: [10, 9] },
  { length: 190, centers: [20, 170], masses: [26, 24] },
  { length: 340, centers: [20, 170, 320], masses: [47, 43] },
];

describe('シート押さえ板', () => {
  it('独立寸法図の端基準に合う通し穴を持ち、材質別の公称質量を保持する', async () => {
    const family = SHEET_FIXING_PLATE_FAMILY;
    await PRODUCT_CATALOG_REGISTRY.ensure([family.id]);
    expect(PRODUCT_CATALOG_REGISTRY.loaded(family.id)).toBe(family);
    expect(family.options).toEqual([]);
    expect(family.stock).toBe('count');
    expect(family.rows).toHaveLength(6);
    for (const { length, centers, masses } of DRAWING) {
      const rows = family.rows.filter((row) => row.dims.length === length);
      expect(rows.map((row) => row.materialLabel)).toEqual(['制電塩ビ（透明）', 'PET（透明）']);
      expect(rows.map((row) => catalogItemNominalMass(createCatalogItemSource(family, row)))).toEqual(masses);
      for (const row of rows) {
        const document = family.build(row, {});
        if (document === null) throw new Error(row.key);
        const features = activeSketch(document).features;
        const edges = features.filter((feature) => feature.kind === 'line');
        const vertices = edges.map(({ from }) => from.mode === 'absolute' ? [from.x.value, from.y.value, from.z.value] : null);
        expect(vertices, row.key).toEqual([[-length / 2, -10, 0], [length / 2, -10, 0], [length / 2, 10, 0], [-length / 2, 10, 0]]);
        const arcs = features.filter((feature) => feature.kind === 'arc');
        expect(arcs.map(({ center, radius }) => center.mode === 'absolute'
          ? [center.x.value + length / 2, center.y.value + 10, radius.value * 2] : null), row.key)
          .toEqual(centers.flatMap((x) => [[x, 10, 7], [x, 10, 7]]));
        expect(document.solids.flatMap((feature) => feature.kind === 'extrude'
          ? [[feature.distance.value, feature.reversed, feature.symmetric]] : []), row.key)
          .toEqual(Array.from({ length: centers.length + 1 }, () => [5, false, false]));
        expect(document.solids.filter((feature) => feature.kind === 'boolean')).toHaveLength(centers.length);
        expect(family.nominalVolume(row, {}), row.key).toBeCloseTo((length * 20 - centers.length * Math.PI * 3.5 ** 2) * 5, 9);
      }
    }
  });
});
