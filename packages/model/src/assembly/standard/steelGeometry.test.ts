import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../../kernelBridge.js';
import { recomputePart } from '../../part/recomputePart.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { steelProductOptions, steelProducts, type SteelMaterialGrade, type SteelSectionCatalog } from './steelCatalog.js';
import {
  ORACLE_BOUNDARY_KEYS, ORACLE_LEGACY_KEYS, STEEL_CATALOG_ORACLE, type SteelCatalogOracleRow,
} from './steelCatalogOracle.fixture.js';

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

describe('W8b SGP additions through real OCCT', () => {
  it.each([
    ['6A', 'blackPipe-plainEnds', 10.5, 2.0],
    ['100A', 'blackPipe-plainEnds', 114.3, 4.5],
    ['500A', 'blackPipe-plainEnds', 508.0, 7.9],
    ['100A', 'whitePipe-zincCoated', 114.3, 4.5],
  ] as const)('%s %s has nominal hollow volume at 100 mm to relative 1e-9', async (size, condition, d, t) => {
    const row = steelProducts('SGP', 'steelPipe').find((candidate) => candidate.size === size && candidate.condition === condition);
    if (row === undefined) throw new Error(`Missing SGP geometry ${size}/${condition}`);
    const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
    expect(source.generatorRevision).toBe('3-steel-profile-1');
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error('SGP source did not produce a part');
    try {
      const result = await recomputePart(document, bridge);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      expect(body.isValid).toBe(true);
      expect(body.mesh.triangleCount).toBeGreaterThan(0);
      const expected = Math.PI / 4 * (d ** 2 - (d - 2 * t) ** 2) * 100;
      const relativeError = Math.abs(body.volume - expected) / expected;
      expect(relativeError).toBeLessThan(1e-9);
      process.stdout.write('SGP_OCCT_VOLUME ' + JSON.stringify({ key: row.key, expectedMm3: expected,
        actualMm3: body.volume, relativeError }) + '\n');
    } finally { await bridge.releasePart(document.id); }
  });
});

interface GeometryCase {
  readonly grade: SteelMaterialGrade;
  readonly catalog: SteelSectionCatalog;
  readonly size: string;
  readonly areaMm2: number;
  readonly length: number;
}
const crossSections = [
  { grade: 'SS400', catalog: 'flatBar', size: 'FB 50×6', areaMm2: 300 },
  { grade: 'S45C', catalog: 'flatBar', size: 'FB 50×6', areaMm2: 300 },
  { grade: 'S45C', catalog: 'roundBar', size: 'φ20', areaMm2: Math.PI * 100 },
  { grade: 'SGP', catalog: 'steelPipe', size: '15A', areaMm2: Math.PI * (10.85 ** 2 - 8.05 ** 2) },
] as const;
const cases: readonly GeometryCase[] = [
  ...crossSections.flatMap((row) => [1, 100, 12000].map((length) => ({ ...row, length }))),
  { grade: 'SS400', catalog: 'equalAngle', size: 'L 50×50×6', areaMm2: 564, length: 100 },
  { grade: 'SS400', catalog: 'channel', size: '[ 100×50×5×7.5', areaMm2: 1175, length: 100 },
  { grade: 'SS400', catalog: 'hBeam', size: 'H 150×150×7×10', areaMm2: 3910, length: 100 },
];

describe('steel sources through real OCCT and normal part recomputation', () => {
  it.each(cases)('$grade $catalog $size length $length has one valid solid and the independent geometric volume', async (input) => {
    const row = steelProducts(input.grade, input.catalog).find((candidate) => candidate.size === input.size);
    if (row === undefined) throw new Error('Missing real geometry fixture');
    const source = { ...createStandardPartSource(row.catalog, row.size,
      { ...steelProductOptions(row), length: String(input.length) }), generatorRevision: '2-steel-1' };
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error('Steel source did not produce a part');
    try {
      const result = await recomputePart(document, bridge);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      expect(body.isValid).toBe(true);
      expect(body.mesh.triangleCount).toBeGreaterThan(0);
      const expectedVolume = input.areaMm2 * input.length;
      expect(Math.abs(body.volume - expectedVolume) / expectedVolume).toBeLessThan(1e-8);
    } finally { await bridge.releasePart(document.id); }
  });
});

const corner = 1 - Math.PI / 4;
const turn = 85 * Math.PI / 180;
const channelAddedArea = 96 * (Math.tan(turn / 2) - turn / 2);
const profileCases = [
  { catalog: 'equalAngle', size: 'L 40×40×5', width: 40, height: 40, area: 375 + corner * (4.5 ** 2 - 18) },
  { catalog: 'equalAngle', size: 'L 50×50×6', width: 50, height: 50, area: 564 + corner * (6.5 ** 2 - 40.5) },
  { catalog: 'equalAngle', size: 'L 65×65×6', width: 65, height: 65, area: 744 + corner * (8.5 ** 2 - 32) },
  { catalog: 'channel', size: '[ 75×40×5×7', width: 40, height: 75, area: 865 + channelAddedArea },
  { catalog: 'channel', size: '[ 100×50×5×7.5', width: 50, height: 100, area: 1175 + channelAddedArea },
  { catalog: 'channel', size: '[ 125×65×6×8', width: 65, height: 125, area: 1694 + channelAddedArea },
  { catalog: 'hBeam', size: 'H 150×150×7×10', width: 150, height: 150, area: 3910 + 256 * corner },
  { catalog: 'hBeam', size: 'H 200×200×8×12', width: 200, height: 200, area: 6208 + 676 * corner },
  { catalog: 'hBeam', size: 'H 300×300×10×15', width: 300, height: 300, area: 11700 + 676 * corner },
] as const;

describe('analytic steel profiles through real OCCT and normal extrusion', () => {
  it.each(profileCases.flatMap((row) => [1, 100, 12000].map((length) => ({ ...row, length }))))(
    '$size length $length has sourced independent volume and bounds', async (input) => {
      const row = steelProducts('SS400', input.catalog).find((item) => item.size === input.size);
      if (row === undefined) throw new Error('Missing source-backed OCCT fixture');
      const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(input.length) });
      expect(source.generatorRevision).toBe('3-steel-profile-1');
      const document = buildStandardPartFromSource(source);
      if (document === null) throw new Error('Profile did not produce a part');
      try {
        const result = await recomputePart(document, bridge);
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        const body = result.bodies[0];
        expect(body.isValid).toBe(true);
        expect(body.mesh.triangleCount).toBeGreaterThan(0);
        const expected = input.area * input.length;
        expect(Math.abs(body.volume - expected) / expected).toBeLessThan(1e-8);
        const frame = body.coordinateFrame?.origin ?? [0, 0, 0];
        for (const [axis, maximum] of [input.width, input.height, input.length].entries()) {
          let low = Infinity;
          let high = -Infinity;
          for (let index = axis; index < body.mesh.positions.length; index += 3) {
            const position = body.mesh.positions[index] + frame[axis];
            low = Math.min(low, position);
            high = Math.max(high, position);
          }
          expect(low).toBeCloseTo(0, 7);
          expect(high).toBeCloseTo(maximum, 7);
        }
      } finally { await bridge.releasePart(document.id); }
    });
});

interface OracleGeometryCase {
  readonly key: string;
  readonly oracle: SteelCatalogOracleRow;
  readonly length: number;
  readonly revision: '3-steel-profile-1' | '2-steel-1';
  readonly areaMm2: number;
}
function oracleByKey(key: string): SteelCatalogOracleRow {
  const row = STEEL_CATALOG_ORACLE.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`Missing independent oracle ${key}`);
  return row;
}
const oracleGeometryCases: readonly OracleGeometryCase[] = [
  ...STEEL_CATALOG_ORACLE.map((oracle): OracleGeometryCase => ({ key: oracle.key, oracle, length: 100,
    revision: '3-steel-profile-1', areaMm2: oracle.exactAreaMm2.value })),
  ...ORACLE_BOUNDARY_KEYS.flatMap((key) => {
    const oracle = oracleByKey(key);
    return [1, 12000].map((length): OracleGeometryCase => ({ key, oracle, length,
      revision: '3-steel-profile-1', areaMm2: oracle.exactAreaMm2.value }));
  }),
  ...ORACLE_LEGACY_KEYS.map((key): OracleGeometryCase => {
    const oracle = oracleByKey(key);
    if (oracle.legacyPolygonAreaMm2 === undefined) throw new Error(`Missing legacy polygon area ${key}`);
    return { key, oracle, length: 100, revision: '2-steel-1', areaMm2: oracle.legacyPolygonAreaMm2.value };
  }),
];

describe('independent catalog oracle through the real OCCT kernel', () => {
  it('covers 31 current rows, twelve six-family length boundaries and three supported legacy representatives', () => {
    expect(oracleGeometryCases).toHaveLength(46);
    expect(oracleGeometryCases.filter((row) => row.revision === '3-steel-profile-1' && row.length === 100)).toHaveLength(31);
    for (const length of [1, 12000]) {
      const boundaries = oracleGeometryCases.filter((row) => row.length === length);
      expect(boundaries).toHaveLength(6);
      expect(new Set(boundaries.map((row) => row.oracle.catalog)).size).toBe(6);
    }
    const legacy = oracleGeometryCases.filter((row) => row.revision === '2-steel-1');
    expect(legacy).toHaveLength(3);
    expect(legacy.map((row) => row.oracle.catalog)).toEqual(['equalAngle', 'channel', 'hBeam']);
  });

  it.each(oracleGeometryCases)('$key length $length revision $revision matches independent volume to relative 1e-8', async (input) => {
    const started = performance.now();
    const row = steelProducts(input.oracle.grade, input.oracle.catalog).find((candidate) => candidate.key === input.key);
    if (row === undefined) throw new Error(`Missing real OCCT product ${input.key}`);
    const current = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(input.length) });
    expect(current.generatorRevision).toBe('3-steel-profile-1');
    const source = { ...current, generatorRevision: input.revision };
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error(`Oracle source did not produce a part: ${input.key}`);
    try {
      const result = await recomputePart(document, bridge);
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      expect(body.isValid).toBe(true);
      expect(body.mesh.triangleCount).toBeGreaterThan(0);
      const expectedVolume = input.areaMm2 * input.length;
      const relativeError = Math.abs(body.volume - expectedVolume) / expectedVolume;
      process.stdout.write('STEEL_ORACLE_VOLUME ' + JSON.stringify({ key: input.key, lengthMm: input.length,
        revision: input.revision, areaMm2: input.areaMm2, expectedMm3: expectedVolume,
        actualMm3: body.volume, relativeError, elapsedMs: performance.now() - started }) + '\n');
      expect(relativeError).toBeLessThan(1e-8);
    } finally { await bridge.releasePart(document.id); }
  });
});
