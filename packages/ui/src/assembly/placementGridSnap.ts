/**
 * 配置の方眼への吸着(配置の補助 P-C): 一筆書きの点と、部品のドラッグ(鋼材・機械要素・フレームの配置の後の動かし)を、
 * 固定の方眼の幅に乗せる。今の動きを変えないため、方眼が固定('fixed')で、吸着が入り、吸着の種類の「方眼」が入っている時だけ効く
 * (自動の方眼は視点で幅が変わるので、配置の吸着には使わない)。画面・ストアは持たない純関数。
 */
import { withinMagnitude, type Vec3, type WorkPlane } from '@pointercad/model';

import { validGridCount, validGridStep, type GridSetting } from '../settings/gridSetting.js';
import { nearestGridPoint, type SnapKind } from '../sketch/snapMath.js';

/** 配置の方眼の吸着の中身(幅・画面の半径・広がり)。 */
export interface PlacementGridSnap {
  readonly spacing: number;
  /** 一筆書きの点を格子点へ吸い付ける画面の半径(画素。点の吸着の半径)。 */
  readonly radiusPixels: number;
  /** 方眼を描く広がり(片側、mm)。この外の格子点には吸い付かない。 */
  readonly extent: number;
}

/** 吸着の入切・種類と方眼の設定から、配置の方眼の吸着を決める。効かない時は null。 */
export function placementGridSnapFor(input: { readonly grid: GridSetting; readonly snapEnabled: boolean;
  readonly snapKinds: readonly SnapKind[]; readonly radiusPixels: number }): PlacementGridSnap | null {
  if (input.grid.mode !== 'fixed' || !input.snapEnabled || !input.snapKinds.includes('grid')
    || !validGridStep(input.grid.stepMm) || !validGridCount(input.grid.count)) return null;
  return { spacing: input.grid.stepMm, radiusPixels: input.radiusPixels, extent: input.grid.stepMm * input.grid.count };
}

/** 面の上の点の、面の原点から測った 2 つの軸の座標(広がりの判定に使う)。 */
function planeCoordinates(plane: WorkPlane, point: Vec3): readonly [number, number] {
  const d: Vec3 = [point[0] - plane.origin[0], point[1] - plane.origin[1], point[2] - plane.origin[2]];
  const along = (axis: Vec3): number => d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
  return [along(plane.axisU), along(plane.axisV)];
}

/**
 * 一筆書きの、前の点の高さの面の上の点を、方眼の格子点へ吸い付ける。格子点が広がりの外か、画面で半径より遠い時は元の点。
 * 格子は世界の原点からの幅の倍数(画面の方眼の線と同じ位置)。吸い付かなければ入力の点をそのまま返す。
 */
export function snapStrokePointToGrid(plane: WorkPlane, point: Vec3, snap: PlacementGridSnap,
  toScreen: (world: Vec3) => readonly [number, number] | null, pointer: readonly [number, number]): Vec3 {
  const candidate = nearestGridPoint(plane, point, snap.spacing);
  const [u, v] = planeCoordinates(plane, candidate);
  if (!withinMagnitude(u, snap.extent) || !withinMagnitude(v, snap.extent)) return point;
  const screen = toScreen(candidate);
  return screen !== null && Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]) <= snap.radiusPixels ? candidate : point;
}

/**
 * 部品のドラッグの点を、押した点からの動きが幅の倍数になる点へ丸める(押した点を原点にした格子。置いた位置の端数を保ったまま幅ずつ動く)。
 */
export function snapDragPointToGrid(plane: WorkPlane, grab: Vec3, point: Vec3, snap: PlacementGridSnap): Vec3 {
  return nearestGridPoint({ ...plane, origin: grab }, point, snap.spacing);
}
