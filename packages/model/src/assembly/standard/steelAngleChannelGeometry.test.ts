import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../../kernelBridge.js';
import { recomputePart } from '../../part/recomputePart.js';
import { buildStandardPart, buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { ANGLE_ADDITION_ORACLE, CHANNEL_ADDITION_CATALOG_ORACLE } from './steelAngleChannelOracle.fixture.js';
import { STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

const boundaries = [ANGLE_ADDITION_ORACLE[0], ANGLE_ADDITION_ORACLE[13],
  CHANNEL_ADDITION_CATALOG_ORACLE[0], CHANNEL_ADDITION_CATALOG_ORACLE[7]];
const cases = boundaries.flatMap(oracle => (['2-steel-1', '3-steel-profile-1'] as const)
  .map(revision => ({ oracle, revision, key: oracle.key })));

describe('W6d min/max angles and channels through real OCCT', () => {
  it('covers the same four minimum/maximum sections in both generator revisions', () => {
    expect(cases).toHaveLength(8);
    for (const catalog of ['equalAngle', 'channel']) {
      const rows = boundaries.filter(row => row.catalog === catalog);
      expect(rows).toHaveLength(2);
      expect(rows[0].exactAreaMm2.value).toBeLessThan(rows[1].exactAreaMm2.value);
      for (const revision of ['2-steel-1', '3-steel-profile-1']) {
        expect(cases.filter(row => row.oracle.catalog === catalog && row.revision === revision)).toHaveLength(2);
      }
    }
  });

  it.each(cases)('$key $revision matches independent area times length to relative 1e-8', async ({ oracle, revision }) => {
    const product = STEEL_PRODUCTS.find(row => row.key === oracle.key);
    if (product === undefined) throw new Error('Missing W6d OCCT product');
    const length = 100;
    const current = createStandardPartSource(product.catalog, product.size,
      { ...steelProductOptions(product), length: String(length) });
    expect(current.generatorRevision).toBe('3-steel-profile-1');
    const saved = buildStandardPartFromSource({ ...current, generatorRevision: revision });
    if (saved === null) throw new Error('Missing W6d generated document');
    const document = revision === '2-steel-1'
      ? buildStandardPart(product.catalog, product.size, { length: String(length) }) : saved;
    if (document === null) throw new Error('Missing W6d legacy buildStandardPart document');
    expect(document.sketches).toEqual(saved.sketches);
    expect(document.solids).toEqual(saved.solids);
    const area = revision === '2-steel-1' ? oracle.legacyPolygonAreaMm2.value : oracle.exactAreaMm2.value;
    try {
      const result = await recomputePart(document, bridge);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      expect(body.isValid).toBe(true);
      expect(body.mesh.triangleCount).toBeGreaterThan(0);
      const expected = area * length;
      const relativeError = Math.abs(body.volume - expected) / expected;
      expect(relativeError).toBeLessThan(1e-8);
      process.stdout.write('W6D_SECTION_VOLUME ' + JSON.stringify({ key: product.key, revision,
        lengthMm: length, areaMm2: area, expectedMm3: expected, actualMm3: body.volume, relativeError }) + String.fromCharCode(10));
    } finally { await bridge.releasePart(document.id); }
  });
});
