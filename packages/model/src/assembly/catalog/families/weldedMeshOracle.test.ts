import { describe, expect, it } from 'vitest';

import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { buildCatalogItemPart, catalogItemNominalMass, createCatalogItemSource } from '../source.js';
import { WELDED_MESH_FAMILY } from './weldedMeshCatalog.js';

describe('溶接金網の注文寸法と公称質量', () => {
  it('整数ピッチと端の必要寸法を保ち、直交方向の円柱に開口が残る', () => {
    const family = WELDED_MESH_FAMILY;
    const row = family.rows.find((entry) => entry.key === 'steel-30');
    if (row === undefined) throw new Error('missing mesh row');
    const values = { width: '245', height: '267.2' };
    const part = family.build(row, values);
    if (part === null) throw new Error('valid mesh rejected');
    const wires = part.solids.flatMap((body) => {
      if (body.kind !== 'primitive' || body.shape.kind !== 'cylinder' || body.axis.kind !== 'world'
        || body.origin.kind !== 'coordinate' || body.origin.value.mode !== 'absolute') throw new Error('expected round wire');
      const { x, y, z } = body.origin.value;
      return [{ axis: body.axis.axis, x: x.value, y: y.value, z: z.value, diameter: body.shape.radius.value * 2,
        length: body.shape.height.value }];
    });
    const horizontal = wires.filter((wire) => wire.axis === 'x');
    const vertical = wires.filter((wire) => wire.axis === 'y');
    expect(horizontal.map((wire) => Math.round((wire.y + 133.6) * 10) / 10))
      .toEqual([13.6, 43.6, 73.6, 103.6, 133.6, 163.6, 193.6, 223.6, 253.6]);
    expect(vertical.map((wire) => wire.x + 122.5)).toEqual([17.5, 47.5, 77.5, 107.5, 137.5, 167.5, 197.5, 227.5]);
    expect(horizontal.every((wire) => wire.x === -122.5 && wire.length === 245 && wire.z === 1.6 && wire.diameter === 3.2)).toBe(true);
    expect(vertical.every((wire) => wire.y === -133.6 && wire.length === 267.2 && wire.diameter === 3.2)).toBe(true);
    expect(vertical[0]?.z).toBeCloseTo(4.8, 10);
    expect(family.build(row, { width: '244.999', height: '267.2' })).toBeNull();
    expect(family.build(row, { width: '245', height: '267.199' })?.solids).toHaveLength(16);
  });

  it('登録4行の材料別上限と質量を使い、保存する幅・高さの式から再建する', async () => {
    const family = WELDED_MESH_FAMILY;
    await PRODUCT_CATALOG_REGISTRY.ensure([family.id]);
    expect(family.rows).toHaveLength(4);
    const expectations = [
      ['steel-30', 1050, 963, 935], ['steel-50', 625, 963, 935],
      ['stainless-30', 1075, 2000, 1000], ['stainless-50', 650, 2000, 1000],
    ] as const;
    for (const [key, grams, long, short] of expectations) {
      const row = family.rows.find((entry) => entry.key === key);
      if (row === undefined) throw new Error(key);
      const source = createCatalogItemSource(family, row, { width: '250*2', height: '500' });
      expect(source.options).toEqual({ family: family.id, item: key, width: '250*2', height: '500' });
      expect(catalogItemNominalMass(source)).toBeCloseTo(grams, 10);
      expect(buildCatalogItemPart(source)).toEqual(family.build(row, { width: '250*2', height: '500' }));
      expect(family.build(row, { width: String(short), height: String(long) })).not.toBeNull();
      expect(family.build(row, { width: String(long + 1), height: String(short) })).toBeNull();
    }
  });
});
