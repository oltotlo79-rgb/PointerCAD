/**
 * 溝の中心線(J-02 P6a)の検査:
 * - 資料の 3 族の全部の行・系列の族の全部の行・汎用の族の初めの値で、族の溝(`sectionSlots`)の口の両端が、置いた部品の形の台本
 *   (作図面の外の輪の線分の端の点)の溝の切り欠きの口と一致し、溝の数は溝のある面と面ごとの溝の数から出る数と同じ。
 * - 溝の中心線は配置で世界の座標になり、留めで切った端の外へ出ない(切る面の上で止まる)。
 * - 肩の裏の部屋の形が簡略である事を、溝ごとに知らせる。
 */
import { describe, expect, it } from 'vitest';

import { T_SLOT_FRAME_FAMILY } from '../catalog/families/tSlotFrame.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { T_SLOT_FRAME_SERIES_FAMILY } from '../catalog/families/tSlotFrameSeries.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { rotateVector } from '../placementMath.js';
import type { ProfileMiterEnd } from '../standard/profileMiter.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { frameSlotLines } from './frameSlots.js';

const FAMILIES: readonly CatalogFamily[] = [T_SLOT_FRAME_SERIES_FAMILY, ...Object.values(T_SLOT_CATALOG_FAMILIES)];

/** 置いた部品の形の台本の、作図面の線分の端の点(x, y。mm の 1e-9 で丸めた文字)。 */
function sketchPoints(family: CatalogFamily, row: CatalogItemRow, values: Readonly<Record<string, string>>): ReadonlySet<string> {
  const part = family.build(row, values);
  if (part === null) throw new Error(`build ${row.key}`);
  const key = (x: number, y: number): string => `${Math.round(x * 1e9) / 1e9},${Math.round(y * 1e9) / 1e9}`;
  const points = new Set<string>();
  for (const sketch of part.sketches) {
    for (const feature of sketch.features) {
      if (feature.kind !== 'line' || feature.from.mode !== 'absolute' || feature.to.mode !== 'absolute') continue;
      points.add(key(feature.from.x.value, feature.from.y.value));
      points.add(key(feature.to.x.value, feature.to.y.value));
    }
  }
  return points;
}

/** 溝の数の期待(上下は面ごとに上下の面の溝の数、左右は (H − W)/p + 上下の面の溝の数)。 */
function expectedSlotCount(row: CatalogItemRow): number {
  const dims = row.dims;
  const across = dims.slotsAcross ?? 1;
  const rows = Math.round(((dims.height ?? NaN) - (dims.width ?? NaN)) / (dims.slotPitch ?? NaN) + across);
  const open = (key: string): boolean => (dims[key] ?? 1) === 1;
  return (open('slotTop') ? across : 0) + (open('slotBottom') ? across : 0) + (open('slotLeft') ? rows : 0) + (open('slotRight') ? rows : 0);
}

function checkRow(family: CatalogFamily, row: CatalogItemRow, values: Readonly<Record<string, string>>, expected: number): void {
  const slots = family.sectionSlots?.(row, values);
  if (slots === null || slots === undefined) throw new Error(`slots ${row.key}`);
  expect(slots, row.key).toHaveLength(expected);
  const points = sketchPoints(family, row, values);
  const key = (x: number, y: number): string => `${Math.round(x * 1e9) / 1e9},${Math.round(y * 1e9) / 1e9}`;
  for (const slot of slots) {
    const half = slot.opening / 2;
    for (const sign of [-1, 1]) {
      const edge = key(slot.center[0] + sign * half * slot.across[0], slot.center[1] + sign * half * slot.across[1]);
      expect(points.has(edge), `${row.key} ${slot.face} ${edge}`).toBe(true);
    }
    expect(slot.roomSimplified).toBe(true);
  }
}

describe('族の溝の位置', () => {
  it('資料の 3 族と系列の族の全部の行で、溝の口の両端が形の台本の溝の切り欠きの口と合い、溝の数が面と溝の数の欄から出る数と同じ', () => {
    let rows = 0;
    for (const family of FAMILIES) {
      for (const row of family.rows) {
        checkRow(family, row, { length: '100' }, expectedSlotCount(row));
        rows += 1;
      }
    }
    expect(rows).toBe(FAMILIES.reduce((sum, family) => sum + family.rows.length, 0));
    expect(rows).toBeGreaterThan(80);
  });

  it('汎用の族(正方形、4 面に 1 本ずつ)も、初めの値で溝の口の両端が形の台本と合う', () => {
    const row = T_SLOT_FRAME_FAMILY.rows[0];
    if (row === undefined) throw new Error('row');
    const values = Object.fromEntries(T_SLOT_FRAME_FAMILY.options.map((spec) => [spec.key, spec.defaultValue]));
    checkRow(T_SLOT_FRAME_FAMILY, row, { ...values, length: '100' }, 4);
  });
});

describe('置いた部材の溝の中心線', () => {
  const family = T_SLOT_FRAME_SERIES_FAMILY;
  const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
  const slots = row === undefined ? null : family.sectionSlots?.(row, { length: '500' }) ?? null;
  const bounds = { minX: -10, minY: -10, maxX: 10, maxY: 10 };

  it('留めの無い部材の線は長さの向きに 0〜500 で、配置の回しと移しで世界の座標になる', () => {
    if (slots === null) throw new Error('slots');
    const rotation: readonly [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const lines = frameSlotLines(slots, { position: [100, 0, 0], rotation }, 500, bounds, []);
    expect(lines).toHaveLength(4);
    const top = lines.find((line) => line.face === 'top');
    const local: Vec3 = [0, 10, 0];
    const expected = rotateVector(rotation, local);
    expect(top?.start.map((value) => Math.round(value * 1e9) / 1e9)).toEqual([100 + expected[0], expected[1], expected[2]].map((value) => Math.round(value * 1e9) / 1e9));
    expect(top?.end[2]).toBeCloseTo(500, 9);
  });

  it('留めで切った端では、溝の線は切る面の上で止まり、切った端の外へ出ない(始点 +X: 右の面は 20 から、上下は 10 から、左は 0 から)', () => {
    if (slots === null) throw new Error('slots');
    const cuts: readonly ProfileMiterEnd[] = [{ end: 'start', side: 'x+' }, { end: 'end', side: 'x+' }];
    const lines = frameSlotLines(slots, { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, 500, bounds, cuts);
    const startOf = (face: string): number | undefined => lines.find((line) => line.face === face)?.start[2];
    const endOf = (face: string): number | undefined => lines.find((line) => line.face === face)?.end[2];
    expect([startOf('right'), startOf('top'), startOf('bottom'), startOf('left')]).toEqual([20, 10, 10, 0]);
    expect([endOf('right'), endOf('top'), endOf('bottom'), endOf('left')]).toEqual([480, 490, 490, 500]);
  });

  it('材料が残らない溝(短すぎる部材の内側の面)は入れない', () => {
    if (slots === null) throw new Error('slots');
    const cuts: readonly ProfileMiterEnd[] = [{ end: 'start', side: 'x+' }, { end: 'end', side: 'x+' }];
    const lines = frameSlotLines(slots, { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, 40, bounds, cuts);
    expect(lines.map((line) => line.face).sort()).toEqual(['bottom', 'left', 'top']);
  });

  it('溝ごとの呼び(nominalWidth)は、数も「決まらない」(null)も線にそのまま写り、持たない溝の線は欄を持たない', () => {
    if (slots === null) throw new Error('slots');
    const [first, second, ...rest] = slots;
    if (first === undefined || second === undefined) throw new Error('slots');
    const lines = frameSlotLines([{ ...first, nominalWidth: 8 }, { ...second, nominalWidth: null }, ...rest],
      { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, 500, bounds, []);
    expect(lines.map((line) => (Object.hasOwn(line, 'nominalWidth') ? line.nominalWidth : 'none')))
      .toEqual([8, null, ...rest.map(() => 'none')]);
  });
});
