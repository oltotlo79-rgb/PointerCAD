/**
 * 曲線を折れ線へ分解する(計画書 docs/plans/P1-式とスケッチ.md タスク15 手順1)。
 *
 * 表示(タスク20)と画面上の当たり判定(pickMath.ts)の両方でこの粗さを使う。
 * カーネルを呼ばずに済ませることで、マウスが動くたびの Worker 往復を無くす(NFR-PF-1)。
 * 確定した面の形はカーネルの結果(SketchMesh)で置き換わるので、ここは下書きの精度でよい。
 *
 * DOM にも three.js にも触れない純関数だけを置く。
 */

import { arcPointAt, type ResolvedArc, type ResolvedCurve, type Vec3 } from '@pointercad/model';

/** 全周の円弧を何本の線分に割るか。表示と当たり判定の両方でこの粗さを使う。 */
export const ARC_SEGMENTS_PER_TURN = 64;

/**
 * 曲線を折れ線へ分解する。線分は両端の 2 点、円弧は角度を等分した点列になる。
 */
export function sampleCurve(curve: ResolvedCurve): Vec3[] {
  if (curve.kind === 'segment') {
    return [curve.from, curve.to];
  }
  return sampleArc(curve);
}

/**
 * 円弧を折れ線へ分解する。開始角から終了角までを等分し、両端を必ず含める。
 * 分割数は掃く角度に比例させる(全周で ARC_SEGMENTS_PER_TURN 区間)。
 * 角度差 0 の退化した円弧でも 1 区間は作り、空の折れ線を返さない。
 */
export function sampleArc(arc: ResolvedArc): Vec3[] {
  const sweep = Math.abs(arc.endAngle - arc.startAngle);
  const divisions = Math.max(1, Math.ceil((sweep / (2 * Math.PI)) * ARC_SEGMENTS_PER_TURN));
  const points: Vec3[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    const ratio = index / divisions;
    points.push(arcPointAt(arc, arc.startAngle + (arc.endAngle - arc.startAngle) * ratio));
  }
  return points;
}

/** 折れ線を「線分ごとに 6 個」の並びへ直す。three.js の LineSegments に渡す形。 */
export function toLineSegmentPositions(points: readonly Vec3[]): number[] {
  const values: number[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    values.push(from[0], from[1], from[2], to[0], to[1], to[2]);
  }
  return values;
}
