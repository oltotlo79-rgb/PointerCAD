import type { Point2 } from '../types.js';
import type { ArcGeometry, DimensionLineSegment } from '../dimension/geometry.js';
import { blackDot, createArrowTriangle, type ArrowTriangle } from '../dimension/arrow.js';
import type { SymbolText } from '../annotation/symbols.js';
import type { SemanticTextMetrics } from '../render/types.js';

export interface BalloonCircle { readonly center: Point2; readonly radius: number }
export interface BalloonInput {
  readonly itemNumber: number;
  /** 解決済みの部品表。表示順から番号を付け直さない。 */
  readonly bomNumbers: ReadonlySet<number>;
  readonly position: Point2;
  readonly target: Point2;
  readonly targetKind: 'face' | 'edge';
  readonly heightMm?: number;
  readonly occupied?: readonly BalloonCircle[];
  readonly measureText?: (text: string, heightMm: number) => SemanticTextMetrics | null;
}
export interface BalloonGeometry {
  readonly circle: ArcGeometry;
  readonly text: SymbolText;
  readonly lines: readonly DimensionLineSegment[];
  readonly arrow: ArrowTriangle | null;
  readonly dot: BalloonCircle | null;
}

/** 引出線の先から外へ進む半直線上で、丸との禁止区間を飛び越す。 */
function moveOutside(position: Point2, direction: Point2, radius: number, occupied: readonly BalloonCircle[]): Point2 | null {
  const intervals: { from: number; to: number }[] = [];
  for (const circle of occupied) {
    if (!circle.center.every(Number.isFinite) || !Number.isFinite(circle.radius) || circle.radius <= 0) return null;
    const x = circle.center[0] - position[0], y = circle.center[1] - position[1];
    const along = x * direction[0] + y * direction[1];
    const across = x * direction[1] - y * direction[0];
    const sum = radius + circle.radius + 0.5;
    if (Math.abs(across) > sum) continue;
    const half = Math.sqrt(Math.max(0, sum * sum - across * across));
    if (!Number.isFinite(half)) return null;
    if (along + half >= 0) intervals.push({ from: along - half, to: along + half });
  }
  intervals.sort((a, b) => a.from - b.from || a.to - b.to);
  let distance = 0;
  for (const interval of intervals) {
    if (interval.from > distance) break;
    distance = Math.max(distance, interval.to);
  }
  const result: Point2 = [position[0] + distance * direction[0], position[1] + distance * direction[1]];
  return result.every(Number.isFinite) ? result : null;
}

/** 丸の直径=文字高さ×2.5。面は黒丸、輪郭は矢印。同番号の複数配置を許す。 */
export function balloon(input: BalloonInput): BalloonGeometry | null {
  const height = input.heightMm ?? 3.5;
  if (!Number.isSafeInteger(input.itemNumber) || input.itemNumber < 1 || !input.bomNumbers.has(input.itemNumber)
    || !Number.isFinite(height) || height <= 0 || !input.position.every(Number.isFinite)
    || !input.target.every(Number.isFinite) || !['face', 'edge'].includes(input.targetKind)) return null;
  const radius = height * 1.25;
  if (!Number.isFinite(radius)) return null;
  const text = String(input.itemNumber);
  const metrics = input.measureText?.(text, height);
  if (input.measureText !== undefined && metrics == null) return null;
  const diagonal = metrics == null ? 0 : Math.hypot(metrics.inkBounds.right - metrics.inkBounds.left,
    metrics.inkBounds.top - metrics.inkBounds.bottom);
  if (!Number.isFinite(diagonal)) return null;
  const textHeight = diagonal > 0 ? height * Math.min(1, (2 * radius - 1) / diagonal) : height;
  if (textHeight <= 0) return null;
  const dx = input.position[0] - input.target[0], dy = input.position[1] - input.target[1];
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= radius) return null;
  const direction: Point2 = [dx / length, dy / length];
  const center = moveOutside(input.position, direction, radius, input.occupied ?? []);
  if (center === null) return null;
  const end: Point2 = [center[0] - direction[0] * radius, center[1] - direction[1] * radius];
  if (!end.every(Number.isFinite)) return null;
  return {
    circle: { center, radius, startAngle: 0, endAngle: 2 * Math.PI },
    text: { text, position: center, sizeMm: textHeight, anchor: 'middle', baseline: 'middle' },
    lines: [{ from: input.target, to: end }],
    arrow: input.targetKind === 'edge' ? createArrowTriangle(input.target, [-direction[0], -direction[1]]) : null,
    dot: input.targetKind === 'face' ? blackDot(input.target) : null,
  };
}
