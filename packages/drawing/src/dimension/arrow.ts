import type { Point2 } from '../types.js';
import { ARROW_LENGTH_MM } from '../style/jisStyle.js';

export interface ArrowTriangle {
  readonly points: readonly [Point2, Point2, Point2];
}

export interface BlackDot {
  readonly center: Point2;
  readonly radius: number;
  readonly diameter: number;
}

function unit(vector: Point2): Point2 {
  const length = Math.hypot(vector[0], vector[1]);
  return length === 0 ? [1, 0] : [vector[0] / length, vector[1] / length];
}

/** 先端と根元2点の三角形。direction は根元から先端へ向かう向き(§2.7)。 */
export function createArrowTriangle(
  tip: Point2,
  direction: Point2,
  length = ARROW_LENGTH_MM,
): ArrowTriangle {
  const axis = unit(direction);
  const normal: Point2 = [-axis[1], axis[0]];
  const halfWidth = length * Math.tan(Math.PI / 24);
  const rootCenter: Point2 = [tip[0] - axis[0] * length, tip[1] - axis[1] * length];
  return {
    points: [
      tip,
      [rootCenter[0] + normal[0] * halfWidth, rootCenter[1] + normal[1] * halfWidth],
      [rootCenter[0] - normal[0] * halfWidth, rootCenter[1] - normal[1] * halfWidth],
    ],
  };
}

/** 2つの矢と実文字幅・余白が寸法線の中へ収まらないとき外向きにする。 */
export function shouldUseOutwardArrows(
  span: number,
  textWidth = 0,
  margin = 0,
  arrowLength = ARROW_LENGTH_MM,
): boolean {
  return span < 2 * arrowLength + textWidth + margin;
}

/** 引出線の先の黒丸。直径は矢印長さの1/3(§2.7)。 */
export function blackDot(center: Point2, arrowLength = ARROW_LENGTH_MM): BlackDot {
  const diameter = arrowLength / 3;
  return { center, diameter, radius: diameter / 2 };
}
