/**
 * 切断面の予告表示の頂点を作る純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27e 手順5、§0.a-0.61)。
 *
 * 対応要件: FR-432(平面による切断)、NFR-UX-2(その場で見える)、NFR-UX-5、NFR-PF-1。
 *
 * **three.js に触れない。** 位置の配列(`Float32Array`)だけを作り、材質と `BufferGeometry`
 * への載せ替えは `createSolidLayer.ts` が受け持つ。こうしておくと Node の単体検査で頂点の
 * 座標をそのまま確かめられる(`buildSubShapeGeometry.ts` / `buildSphereGrid.ts` と同じ流儀)。
 */

import {
  addVec3,
  scaleVec3,
  type ResolvedPlane,
  type Vec3,
} from '@pointercad/model';

/** 予告の四角と、残る側を示す矢印の頂点。 */
export interface CutPreviewPositions {
  /** 四角(三角形 2 枚 = 6 頂点 = 18 個の実数)。 */
  readonly facePositions: Float32Array;
  /** 矢印(線分 3 本 = 6 頂点 = 18 個の実数)。軸 1 本と、先端の羽 2 本。 */
  readonly arrowPositions: Float32Array;
}

/**
 * 矢印の長さを、四角の対角長に対する割合で決める。
 * 四角より目立つと切る位置が読みにくくなるので、短くしてある。
 */
const ARROW_LENGTH_RATIO = 0.18;
/** 矢の先の羽の長さ(矢印の長さに対する割合)。 */
const ARROW_HEAD_RATIO = 0.3;

/** 三角形 1 枚ぶんの頂点を配列へ書く。 */
function writeTriangle(target: number[], a: Vec3, b: Vec3, c: Vec3): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** 線分 1 本ぶんの頂点を配列へ書く。 */
function writeSegment(target: number[], a: Vec3, b: Vec3): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/**
 * 切断面の予告の四角(三角形 2 枚)と、残る側を示す矢印の線分を作る。
 *
 * - 四角は**対角長が `diagonal` の正方形**で、中心は `plane.origin`。`diagonal` には
 *   対象のボディの境界箱の対角長を渡す(§0.a-0.61)。こうすると、どんな向きで切っても
 *   四角が必ず対象を覆う(正方形の対角が境界箱の対角と同じ長さになるため)。
 *   1 辺は `diagonal / √2`、中心から角までは `diagonal / 2`。
 * - 4 つの角は `plane.axisU` と `plane.axisV` の組み合わせなので、**必ず平面の上に載る**。
 * - 矢印は残る側へ向く。`keep === 'positive'` なら法線の向き、`'negative'` ならその逆
 *   (§0.a-0.57)。矢の先には羽を 2 本付けて、どちらが先端かを見て取れるようにする。
 *
 * `diagonal` が 0 以下のときは頂点を 1 つも作らない(空の `Float32Array` を返す)。
 * 呼び出し側はそのまま載せてよく、描かれるものが無いだけになる。
 */
export function buildCutPreviewPositions(
  plane: ResolvedPlane,
  diagonal: number,
  keep: 'positive' | 'negative',
): CutPreviewPositions {
  if (!Number.isFinite(diagonal) || diagonal <= 0) {
    return { facePositions: new Float32Array(0), arrowPositions: new Float32Array(0) };
  }
  // 中心から角までの距離は対角長の半分。角は ±u ±v の 4 通り(1 辺は diagonal / √2)。
  const half = diagonal / 2;
  const u = scaleVec3(plane.axisU, half / Math.SQRT2);
  const v = scaleVec3(plane.axisV, half / Math.SQRT2);
  const corner = (su: number, sv: number): Vec3 =>
    addVec3(addVec3(plane.origin, scaleVec3(u, su)), scaleVec3(v, sv));
  const c00 = corner(-1, -1);
  const c10 = corner(1, -1);
  const c11 = corner(1, 1);
  const c01 = corner(-1, 1);

  const face: number[] = [];
  writeTriangle(face, c00, c10, c11);
  writeTriangle(face, c00, c11, c01);

  const direction = scaleVec3(plane.normal, keep === 'negative' ? -1 : 1);
  const length = diagonal * ARROW_LENGTH_RATIO;
  const tip = addVec3(plane.origin, scaleVec3(direction, length));
  const headBack = addVec3(plane.origin, scaleVec3(direction, length * (1 - ARROW_HEAD_RATIO)));
  const wing = scaleVec3(plane.axisU, length * ARROW_HEAD_RATIO);
  const arrow: number[] = [];
  writeSegment(arrow, plane.origin, tip);
  writeSegment(arrow, tip, addVec3(headBack, wing));
  writeSegment(arrow, tip, addVec3(headBack, scaleVec3(wing, -1)));

  return { facePositions: new Float32Array(face), arrowPositions: new Float32Array(arrow) };
}
