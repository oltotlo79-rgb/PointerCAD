/**
 * ホバーとクリックの当たり判定(計画書 docs/plans/P1-式とスケッチ.md タスク15 手順5、§2.8)。
 *
 * 対応要件: FR-106(スケッチ要素のクリック選択とホバーハイライト)。
 *
 * スナップ(snapMath.ts)と同じく判定は**画面座標**で行い、ワールド → 画面の
 * 写し方は呼び出し側から関数で注入する。DOM にも three.js にも触れない純関数だけを置く。
 */

import type { ResolvedSketch, Vec3 } from '@pointercad/model';

import { sampleCurve } from './sampleCurve.js';
import type { ProjectToScreen } from './snapMath.js';

export type PickKind = 'point' | 'curve' | 'face';

export interface PickResult {
  readonly kind: PickKind;
  readonly featureId: string;
  /** 点列の中の 1 点なら `featureId#n`、それ以外は featureId と同じ。 */
  readonly elementId: string;
}

/** クリック・ホバーの当たり判定の半径(画素)。 */
export const PICK_RADIUS_PIXELS = 6;

type Screen = readonly [number, number];

/** 画面座標での点と線分の距離。線分の外側では近い方の端点までの距離になる。 */
export function distanceToSegment2d(point: Screen, from: Screen, to: Screen): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - from[0], point[1] - from[1]);
  }
  const raw = ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared;
  const ratio = Math.min(Math.max(raw, 0), 1);
  return Math.hypot(point[0] - (from[0] + dx * ratio), point[1] - (from[1] + dy * ratio));
}

/** 画面座標での多角形の内外判定(交差数)。境界上の扱いは問わない。 */
export function isInsidePolygon2d(point: Screen, polygon: readonly Screen[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a[1] > point[1] !== b[1] > point[1];
    if (!crosses) {
      continue;
    }
    const x = a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (point[0] < x) {
      inside = !inside;
    }
  }
  return inside;
}

function projectAll(points: readonly Vec3[], project: ProjectToScreen): Screen[] {
  const screen: Screen[] = [];
  for (const point of points) {
    const projected = project(point);
    if (projected !== null) {
      screen.push(projected);
    }
  }
  return screen;
}

/**
 * ポインタの下にある要素を 1 つ返す(FR-106)。
 * 小さいものを先に取る(点 → 線・円弧 → 面)。同じ種別なら画面距離が近いものを取る。
 * 点と曲線は判定半径の中にあることを条件にし、面は内側にあることだけを条件にする。
 */
export function pickSketchElement(
  sketch: ResolvedSketch,
  project: ProjectToScreen,
  pointer: Screen,
  radiusPixels: number = PICK_RADIUS_PIXELS,
): PickResult | null {
  let bestPoint: PickResult | null = null;
  let bestPointDistance = Number.POSITIVE_INFINITY;
  for (const point of sketch.points) {
    const screen = project(point.position);
    if (screen === null) {
      continue;
    }
    const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
    if (distance <= radiusPixels && distance < bestPointDistance) {
      bestPointDistance = distance;
      bestPoint = { kind: 'point', featureId: point.featureId, elementId: point.id };
    }
  }
  if (bestPoint !== null) {
    return bestPoint;
  }

  let bestCurve: PickResult | null = null;
  let bestCurveDistance = Number.POSITIVE_INFINITY;
  for (const curve of [...sketch.segments, ...sketch.arcs]) {
    const screen = projectAll(sampleCurve(curve), project);
    for (let index = 0; index + 1 < screen.length; index += 1) {
      const distance = distanceToSegment2d(pointer, screen[index], screen[index + 1]);
      if (distance <= radiusPixels && distance < bestCurveDistance) {
        bestCurveDistance = distance;
        bestCurve = { kind: 'curve', featureId: curve.featureId, elementId: curve.featureId };
      }
    }
  }
  if (bestCurve !== null) {
    return bestCurve;
  }

  // 面は後ろから調べる。後から作った面が上に見えるため。
  for (let index = sketch.faces.length - 1; index >= 0; index -= 1) {
    const face = sketch.faces[index];
    const outline: Vec3[] = [];
    for (const curve of face.curves) {
      outline.push(...sampleCurve(curve));
    }
    const screen = projectAll(outline, project);
    if (screen.length >= 3 && isInsidePolygon2d(pointer, screen)) {
      return { kind: 'face', featureId: face.featureId, elementId: face.featureId };
    }
  }

  return null;
}
