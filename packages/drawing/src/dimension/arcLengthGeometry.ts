import type { Point2 } from '../types.js';
import { createArrowTriangle, shouldUseOutwardArrows, type ArrowTriangle } from './arrow.js';
import { DIMENSION_EXTENSION_GAP_MM, DIMENSION_EXTENSION_OVER_MM } from '../style/jisStyle.js';
import type { DimensionLineSegment } from './geometry.js';

export interface ArcLengthDimensionInput {
  readonly center: Point2;
  /** 円の始点方向と接線方向の半径を紙面へ投影した2本。斜めの図では楕円になる。 */
  readonly axes: readonly [Point2, Point2];
  readonly sweep: number;
  readonly offset?: number;
  readonly textWidth?: number;
}
export interface ProjectedArcLengthDimensionGeometry {
  readonly points: readonly Point2[];
  readonly extensionLines: readonly DimensionLineSegment[];
  readonly arrows: readonly [ArrowTriangle, ArrowTriangle];
  readonly textPosition: Point2;
  readonly normal: Point2;
}

const unit = (point: Point2): Point2 => { const length = Math.hypot(...point); return [point[0] / length, point[1] / length]; };
const add = (point: Point2, vector: Point2, distance: number): Point2 => [point[0] + vector[0] * distance, point[1] + vector[1] * distance];
const CHORD_ERROR_MM = 0.01;
const MAX_SEGMENTS = 65_536;

/** 実寸値を再計算しない。円弧の投影から寸法線・補助線・矢印の配置だけを作る。 */
export function createProjectedArcLengthDimensionGeometry(input: ArcLengthDimensionInput): ProjectedArcLengthDimensionGeometry | null {
  const [a, b] = input.axes;
  const offset = input.offset ?? 8;
  const textWidth = input.textWidth ?? 0;
  const firstRadius = Math.hypot(...a), secondRadius = Math.hypot(...b);
  if (![...input.center, ...a, ...b, input.sweep, offset, textWidth].every(Number.isFinite)
    || firstRadius === 0 || secondRadius === 0 || offset < 0 || textWidth < 0
    || Math.abs(input.sweep) < 1e-10 || Math.abs(input.sweep) > Math.PI * 2 + 1e-7
    || Math.abs(a[0] * b[1] - a[1] * b[0]) <= 1e-12 * firstRadius * secondRadius) return null;
  // 最も短い投影半径でも補助線との隙間を確保する（斜視の楕円でも内側へ入らない）。
  const cross = Math.abs(a[0] * b[1] - a[1] * b[0]);
  const dot = a[0] * b[0] + a[1] * b[1];
  const major = Math.sqrt((firstRadius ** 2 + secondRadius ** 2 + Math.hypot(firstRadius ** 2 - secondRadius ** 2, 2 * dot)) / 2);
  const factor = 1 + offset / (cross / major);
  const radiusBound = (firstRadius + secondRadius) * factor;
  const step = 2 * Math.acos(Math.max(-1, 1 - CHORD_ERROR_MM / radiusBound));
  const count = Math.max(2, Math.ceil(Math.abs(input.sweep) / step));
  if (!Number.isFinite(count) || count > MAX_SEGMENTS) return null;
  const radial = (angle: number): Point2 => [a[0] * Math.cos(angle) + b[0] * Math.sin(angle), a[1] * Math.cos(angle) + b[1] * Math.sin(angle)];
  const point = (angle: number, scale: number): Point2 => add(input.center, radial(angle), scale);
  const points: Point2[] = Array.from({ length: count + 1 }, (_, index) => point(input.sweep * index / count, factor));
  let span = 0;
  for (let i = 1; i < points.length; i += 1) span += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const outward = shouldUseOutwardArrows(span, textWidth, 1);
  const tangent = (angle: number): Point2 => unit([-a[0] * Math.sin(angle) + b[0] * Math.cos(angle), -a[1] * Math.sin(angle) + b[1] * Math.cos(angle)]);
  const sign = Math.sign(input.sweep) * (outward ? 1 : -1);
  const startTangent = tangent(0), endTangent = tangent(input.sweep);
  const normal = unit(radial(input.sweep / 2));
  return {
    points,
    extensionLines: Math.abs(Math.abs(input.sweep) - Math.PI * 2) < 1e-7 ? [] : [0, input.sweep].map((angle) => {
      const direction = unit(radial(angle));
      return { from: add(point(angle, 1), direction, DIMENSION_EXTENSION_GAP_MM), to: add(point(angle, factor), direction, DIMENSION_EXTENSION_OVER_MM) };
    }),
    arrows: [createArrowTriangle(points[0], [startTangent[0] * sign, startTangent[1] * sign]),
      createArrowTriangle(points[points.length - 1], [-endTangent[0] * sign, -endTangent[1] * sign])],
    textPosition: add(point(input.sweep / 2, factor), normal, 1), normal,
  };
}
