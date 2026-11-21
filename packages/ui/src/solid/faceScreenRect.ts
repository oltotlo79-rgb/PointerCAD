/**
 * 選んだ面が画面に写る外形の箱(M-10 ①)。
 *
 * 面を押して立体の道具(穴・ねじ穴など)を開くと、入力の窓は押した点のそばに出る。窓が面そのものを
 * 覆うと、続けて面の辺を押せない。そこで押した時に面の画面の外形を覚えておき、窓はその箱を避けて開く
 * (`NumericInputPopover.tsx` の `placePopover`)。
 *
 * 写し方は呼び出し側から関数(`ProjectToScreen`)で受け取る(`pickSubShape.ts` と同じ作り)。
 * three.js にも DOM にも触れないので Node で検査できる。
 */
import type { SolidBody } from '@pointercad/model';

import type { ProjectToScreen } from '../sketch/snapMath.js';
import { parseSubShapeId, subShapeFrameOrigin } from './subShapeSelection.js';

/** 画面の上の箱(canvas の左上を原点とした画素)。 */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * 面の三角形の頂点を全部画面へ写し、それを囲む箱を返す。
 * 面でない id・ボディや面が見つからない・三角形が無い・三角形の範囲が表の外・写せない点(カメラの後ろ)が
 * ある時は null(窓は今までどおり押した点のそばに出る)。
 */
export function faceScreenRect(
  bodies: readonly SolidBody[],
  elementId: string,
  project: ProjectToScreen,
): ScreenRect | null {
  const parsed = parseSubShapeId(elementId);
  const body = parsed?.kind === 'face' ? bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId) : undefined;
  const face = body?.faces.find((entry) => entry.index === parsed?.index);
  const origin = body === undefined ? null : subShapeFrameOrigin(body);
  if (body === undefined || face === undefined || origin === null || face.triangleCount <= 0) {
    return null;
  }
  const { positions, indices } = body.mesh;
  const end = (face.triangleOffset + face.triangleCount) * 3;
  if (face.triangleOffset < 0 || end > indices.length) {
    return null;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let corner = face.triangleOffset * 3; corner < end; corner += 1) {
    const vertex = indices[corner] * 3;
    if (vertex + 2 >= positions.length) {
      return null;
    }
    const screen = project([positions[vertex] + origin[0], positions[vertex + 1] + origin[1], positions[vertex + 2] + origin[2]]);
    if (screen === null) {
      return null;
    }
    left = Math.min(left, screen[0]);
    top = Math.min(top, screen[1]);
    right = Math.max(right, screen[0]);
    bottom = Math.max(bottom, screen[1]);
  }
  return { left, top, right, bottom };
}
