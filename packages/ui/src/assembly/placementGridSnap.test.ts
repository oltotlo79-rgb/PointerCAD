import { WORK_PLANES, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { DEFAULT_GRID_SETTING } from '../settings/gridSetting.js';
import { DEFAULT_SNAP_KINDS } from '../sketch/snapMath.js';
import { placementGridSnapFor, snapDragPointToGrid, snapStrokePointToGrid, type PlacementGridSnap } from './placementGridSnap.js';

/* 配置の補助 P-C: 一筆書きの点と部品のドラッグの方眼への吸着。固定の方眼で、吸着と「方眼」の種類が入っている時だけ効く。 */
const FIXED = { mode: 'fixed', stepMm: 200, count: 5 } as const;
const SNAP: PlacementGridSnap = { spacing: 200, radiusPixels: 12, extent: 1000 };
/** 上から見た画面: 1 mm が 1 画素で、世界の X・Y がそのまま画面の座標。 */
const topView = (world: Vec3): readonly [number, number] => [world[0], world[1]];

describe('配置の方眼への吸着', () => {
  it('固定の方眼・吸着が入・「方眼」の種類が入の時だけ効き、広がりは 幅 × 数', () => {
    const base = { grid: FIXED, snapEnabled: true, snapKinds: DEFAULT_SNAP_KINDS, radiusPixels: 12 };
    expect(placementGridSnapFor(base)).toEqual(SNAP);
    expect(placementGridSnapFor({ ...base, grid: DEFAULT_GRID_SETTING })).toBeNull();
    expect(placementGridSnapFor({ ...base, snapEnabled: false })).toBeNull();
    expect(placementGridSnapFor({ ...base, snapKinds: DEFAULT_SNAP_KINDS.filter(kind => kind !== 'grid') })).toBeNull();
  });

  it('幅か線の数が設定範囲の外なら配置に固定方眼を使わない', () => {
    const base = { grid: FIXED, snapEnabled: true, snapKinds: DEFAULT_SNAP_KINDS, radiusPixels: 12 };
    for (const stepMm of [0, -1, 0.01, Infinity, NaN]) {
      expect(placementGridSnapFor({ ...base, grid: { ...FIXED, stepMm } })).toBeNull();
    }
    for (const count of [0, 1.5, 51]) {
      expect(placementGridSnapFor({ ...base, grid: { ...FIXED, count } })).toBeNull();
    }
  });

  it('一筆書きの点は、画面で半径の中の格子点へ吸い付き、遠い時・広がりの外では元の点のまま(高さの面の上でも同じ格子)', () => {
    const level = { ...WORK_PLANES.xy, origin: [0, 0, 300] as Vec3 };
    expect(snapStrokePointToGrid(level, [405, 195, 300], SNAP, topView, [405, 195])).toEqual([400, 200, 300]);
    expect(snapStrokePointToGrid(level, [460, 195, 300], SNAP, topView, [460, 195])).toEqual([460, 195, 300]);
    expect(snapStrokePointToGrid(level, [1205, 0, 300], SNAP, topView, [1205, 0])).toEqual([1205, 0, 300]);
    expect(snapStrokePointToGrid(level, [405, 195, 300], SNAP, () => null, [405, 195])).toEqual([405, 195, 300]);
  });

  it('部品のドラッグは、押した点からの動きを幅の倍数に丸める(置いた位置の端数は保つ)', () => {
    const grab: Vec3 = [13, 7, 0];
    expect(snapDragPointToGrid(WORK_PLANES.xy, grab, [13 + 290, 7 - 110, 0], SNAP)).toEqual([13 + 200, 7 - 200, 0]);
    expect(snapDragPointToGrid(WORK_PLANES.xy, grab, [13 + 90, 7 + 50, 0], SNAP)).toEqual(grab);
  });
});
