import type { Point2 } from '../types.js';

/** 紙上の誤差。縮尺を適用した後の半径に使う(P8 §2.10訂正)。 */
export const DEFAULT_ARC_TOLERANCE_MM = 0.001;
const MAX_ARC_SEGMENTS = 16_384;

export interface CubicBezierSegment {
  readonly from: Point2;
  readonly control1: Point2;
  readonly control2: Point2;
  readonly to: Point2;
}

export interface BezierArc {
  readonly start: Point2;
  readonly segments: readonly CubicBezierSegment[];
}

export function cubicBezierPoint(curve: CubicBezierSegment, t: number): Point2 {
  const u = 1 - t;
  return [0, 1].map((axis) => u ** 3 * curve.from[axis] + 3 * u * u * t * curve.control1[axis]
    + 3 * u * t * t * curve.control2[axis] + t ** 3 * curve.to[axis]) as [number, number];
}

/**
 * 単位円の対称な弧では ||B(t)||²−1 = d² t²(1−t)²(t−1/2)²。
 * 最大は t=(3±√3)/6、積は1/432。小角でもsqrt(1+x)−1の桁落ちを避ける。
 */
function relativeRadialError(angle: number): number {
  const half = angle / 2;
  const d = 8 * Math.cos(half) * Math.tan(angle / 4) - 4 * Math.sin(half);
  const squaredError = d * d / 432;
  return squaredError / (Math.sqrt(1 + squaredError) + 1);
}

/** 符号つきの弧を、紙上誤差を満たす等角の3次曲線へ写す。縮退は始点だけを返す。 */
export function bezierArc(input: {
  readonly center: Point2;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly toleranceMm?: number;
}): BezierArc | null {
  const { center, radius, startAngle, endAngle } = input;
  const tolerance = input.toleranceMm ?? DEFAULT_ARC_TOLERANCE_MM;
  const sweep = endAngle - startAngle;
  if (![...center, radius, startAngle, endAngle, sweep, tolerance].every(Number.isFinite)
    || radius < 0 || tolerance <= 0 || Math.abs(sweep) > 2 * Math.PI + 1e-12) return null;
  const point = (angle: number): Point2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  const start = point(startAngle);
  if (!start.every(Number.isFinite)) return null;
  if (radius === 0 || sweep === 0) return { start, segments: [] };
  let count = Math.ceil(Math.abs(sweep) / (Math.PI / 2));
  while (radius * relativeRadialError(sweep / count) > tolerance && count <= MAX_ARC_SEGMENTS) count *= 2;
  if (count > MAX_ARC_SEGMENTS) return null;
  const step = sweep / count;
  const k = 4 / 3 * Math.tan(step / 4);
  const segments: CubicBezierSegment[] = [];
  let from = start;
  for (let i = 0; i < count; i += 1) {
    const a = startAngle + step * i, b = startAngle + step * (i + 1);
    // 円の閉鎖と隣接片の接続を同じ座標値で表す。
    const to = i === count - 1 && Math.abs(Math.abs(sweep) - 2 * Math.PI) <= 1e-12 ? start : point(b);
    const control1: Point2 = [from[0] - radius * k * Math.sin(a), from[1] + radius * k * Math.cos(a)];
    const control2: Point2 = [to[0] + radius * k * Math.sin(b), to[1] - radius * k * Math.cos(b)];
    if (![...to, ...control1, ...control2].every(Number.isFinite)) return null;
    segments.push({ from, control1, control2, to });
    from = to;
  }
  return { start, segments };
}

/** 生成した座標をサンプルし、分割数決定の式とは独立に半径誤差(mm)を測る。 */
export function measureBezierRadialError(
  curve: CubicBezierSegment, center: Point2, radius: number, samples = 256,
): number {
  if (!Number.isInteger(samples) || samples < 2 || samples > 1_000_000) return Infinity;
  let maximum = 0;
  for (let i = 0; i <= samples; i += 1) {
    const point = cubicBezierPoint(curve, i / samples);
    maximum = Math.max(maximum, Math.abs(Math.hypot(point[0] - center[0], point[1] - center[1]) - radius));
  }
  return maximum;
}
