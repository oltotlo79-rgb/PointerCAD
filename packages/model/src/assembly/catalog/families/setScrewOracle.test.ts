/**
 * M-04 六角穴付き止めねじ(JIS B 1177-2007)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の setScrew)の突合せ、
 * 長さの範囲と短い形の決まり、形の体積の検査。fixture は規格寸法の表の語の位置・在庫表の画素と線から、
 * 製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import { createCatalogItemSource } from '../source.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { SET_SCREW_FAMILIES } from './setScrew.js';

const ORACLE = CATALOG_ORACLES.setScrew;
type Kind = keyof typeof SET_SCREW_FAMILIES;
const KINDS: readonly (readonly [Kind, string])[] = [['cup', 'くぼみ先'], ['flat', '平先'], ['dog', '棒先'], ['cone', 'とがり先']];
const ORACLE_DIMS = new Map(ORACLE.dims.map(([size, ...values]): [string, number[]] => [size, values.map(Number)]));

const familyOf = (kind: Kind): CatalogFamily => SET_SCREW_FAMILIES[kind];
const oracleLengths = (kind: Kind): readonly (readonly [string, number, number, readonly number[]])[] =>
  ORACLE[kind].map(([size, first, last, shaded]): readonly [string, number, number, readonly number[]] =>
    [size, Number(first), Number(last), shaded.map(Number)]);

/** 資料の読みから決めた、長さ ℓ の形の体積(軸 + 先 − 六角穴)。短い形は網かけの最も長い長さ以下。 */
function expectedVolume(kind: Kind, size: string, length: number): number {
  const [pitch, s, t1, t2, , , dogDp, zShort, zLong, dt] = ORACLE_DIMS.get(size) ?? [];
  const shadedMax = Math.max(...(oracleLengths(kind).find(([name]) => name === size)?.[3] ?? []));
  const d = Number(size.slice(1));
  const short = length <= shadedMax;
  const t = (short ? t1 : t2) ?? NaN;
  const hexagon = Math.sqrt(3) / 2 * (s ?? NaN) ** 2 * t;
  expect(pitch).toBeGreaterThan(0);
  if (kind === 'dog') {
    const z = (short ? zShort : zLong) ?? NaN;
    return Math.PI * (d / 2) ** 2 * (length - z) + Math.PI * ((dogDp ?? NaN) / 2) ** 2 * z - hexagon;
  }
  if (kind === 'cone') {
    const tip = (dt ?? NaN) / 2;
    const h = (d / 2 - tip) / Math.tan((short ? 60 : 45) * Math.PI / 180);
    return Math.PI * (d / 2) ** 2 * (length - h) + Math.PI * h / 3 * ((d / 2) ** 2 + d / 2 * tip + tip ** 2) - hexagon;
  }
  return Math.PI * (d / 2) ** 2 * length - hexagon;
}

const fromProduct = (row: CatalogItemRow): readonly number[] => [row.dims.pitch, row.dims.socketWidth, row.dims.socketDepthShort,
  row.dims.socketDepthLong].map((value) => value ?? NaN);

describe('M-04 六角穴付き止めねじ 資料の表との突合せ', () => {
  it('4 つの先の形とも、呼び M2〜M24 の 12 行の P・s・t(1 欄・2 欄)と先の寸法は資料の規格寸法の表と一致する', () => {
    expect([...ORACLE_DIMS.keys()]).toEqual(['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20', 'M24']);
    for (const [kind] of KINDS) {
      const rows = familyOf(kind).rows;
      expect(rows.map((row) => row.size)).toEqual([...ORACLE_DIMS.keys()]);
      for (const row of rows) {
        const [pitch, s, t1, t2, dz, flatDp, dogDp, zShort, zLong, dt] = ORACLE_DIMS.get(row.size) ?? [];
        expect([row.key, row.dims.nominalDiameter]).toEqual([row.size, Number(row.size.slice(1))]);
        expect(fromProduct(row)).toEqual([pitch, s, t1, t2]);
        const point = { cup: [row.dims.cupDiameter, dz], flat: [row.dims.pointDiameter, flatDp], cone: [row.dims.tipDiameter, dt],
          dog: [row.dims.pointDiameter, dogDp] }[kind];
        expect(point[0]).toBe(point[1]);
        if (kind === 'dog') expect([row.dims.dogLengthShort, row.dims.dogLengthLong]).toEqual([zShort, zLong]);
      }
    }
  });

  it('長さの範囲(太線枠)と網かけの最も長い長さは資料の在庫表と一致し、網かけは範囲の最も短い長さから始まる', () => {
    for (const [kind] of KINDS) {
      const oracle = oracleLengths(kind);
      expect(familyOf(kind).rows.map((row) => [row.size, row.dims.lengthMin, row.dims.lengthMax, row.dims.shortLengthMax]))
        .toEqual(oracle.map(([size, first, last, shaded]) => [size, first, last, Math.max(...shaded)]));
      for (const [, first, last, shaded] of oracle) {
        expect(Math.min(...shaded)).toBe(first);
        expect(Math.max(...shaded)).toBeLessThan(last);
      }
    }
  });

  it('ピッチはねじの表の並目と同じで、t は 1 欄 < 2 欄、六角穴・先の径は呼び径より小さく、短い棒先 < 長い棒先', () => {
    for (const [kind] of KINDS) {
      for (const row of familyOf(kind).rows) {
        const dims = row.dims;
        const thread = findMetricThread(row.size);
        expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(dims.pitch);
        expect(dims.socketDepthShort).toBeLessThan(dims.socketDepthLong ?? NaN);
        expect(dims.socketWidth).toBeLessThan(dims.nominalDiameter ?? NaN);
        const point = dims.cupDiameter ?? dims.pointDiameter ?? dims.tipDiameter;
        expect(point).toBeLessThan(dims.nominalDiameter ?? NaN);
        if (kind === 'dog') expect(dims.dogLengthShort).toBeLessThan(dims.dogLengthLong ?? NaN);
      }
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結する', () => {
    const evidence = familyOf('cup').rows[0]?.evidence;
    expect(KINDS.every(([kind]) => familyOf(kind).rows.every((row) => row.evidence === evidence))).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain('PDF 28 頁');
    expect(evidence?.locator).toContain(`PDF 29〜${ORACLE.pages[1]} 頁`);
    expect(evidence?.title.startsWith('資料 K5-4 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect(KINDS.map(([kind]) => [familyOf(kind).id, familyOf(kind).kindKey, familyOf(kind).catalogRevision,
      familyOf(kind).generatorRevision])).toEqual([
      ['set-screw-cup-point', 'catalog.mechanical.kind.setScrewCup', 'set-screw-2026-11-r1', 'set-screw-1'],
      ['set-screw-flat-point', 'catalog.mechanical.kind.setScrewFlat', 'set-screw-2026-11-r1', 'set-screw-1'],
      ['set-screw-dog-point', 'catalog.mechanical.kind.setScrewDog', 'set-screw-2026-11-r1', 'set-screw-1'],
      ['set-screw-cone-point', 'catalog.mechanical.kind.setScrewCone', 'set-screw-2026-11-r1', 'set-screw-1'],
    ]);
  });

  it('形は軸(+ 棒先・とがり先)− 六角穴で、体積は網かけの長さ以下で短い形・それより長いと長い形、範囲の外の長さは作らない', () => {
    for (const [kind, label] of KINDS) {
      const family = familyOf(kind);
      const kinds = kind === 'cup' || kind === 'flat' ? ['primitive', 'threadShaft', 'extrude', 'boolean']
        : ['primitive', 'threadShaft', 'primitive', 'boolean', 'extrude', 'boolean'];
      for (const [size, first, last, shaded] of oracleLengths(kind)) {
        const row = family.rows.find((candidate) => candidate.size === size);
        if (row === undefined) throw new Error(`row ${size} is missing`);
        for (const length of [first, Math.max(...shaded), (Math.max(...shaded) + last) / 2, last]) {
          const values = { length: String(length) };
          const part = family.build(row, values);
          expect(part?.name).toBe(`六角穴付き止めねじ ${label} ${size}×${length}`);
          expect(part?.solids.map((feature) => feature.kind)).toEqual(kinds);
          expect(family.nominalVolume(row, values)).toBeCloseTo(expectedVolume(kind, size, length), 6);
        }
        // 長さを入れずに置く時は、その呼びの範囲の最も短い長さになる(全ての呼びで作れる 1 つの既定の長さが無いため)。
        expect(createCatalogItemSource(family, row).options.length).toBe(String(first));
        expect(createCatalogItemSource(family, row, { length: '7*2' }).options.length).toBe('7*2');
        expect(family.build(row, { length: String(first - 0.01) })).toBeNull();
        expect(family.build(row, { length: String(last + 0.01) })).toBeNull();
        expect(family.nominalVolume(row, { length: String(last + 0.01) })).toBeNull();
      }
    }
  });
});
