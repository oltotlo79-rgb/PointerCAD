import type { DrawingRenderCurve } from '../render/renderDrawing.js';
import type { Point2 } from '../types.js';
import type { WeldKind, WeldSideSpec } from './types.js';

/** Z3021:2016表1。矢側は下、反対側は上、抵抗スポット/シームは基線の中央。 */
export function weldSymbolGeometry(kind: WeldKind, side: WeldSideSpec['side'], height: number, origin: Point2): readonly DrawingRenderCurve[] | null {
  if (!Number.isFinite(height) || height < 1 || height > 100 || !origin.every(Number.isFinite)
    || (side === 'center' && kind !== 'spot' && kind !== 'seam')) return null;
  const sign = side === 'arrow' ? -1 : 1, h = height, [x, y] = origin;
  const point = (dx: number, dy: number): Point2 => [x + dx * h, y + dy * h * sign];
  const line = (a: Point2, b: Point2): DrawingRenderCurve => ({ kind: 'segment', from: a, to: b });
  if (kind === 'fillet') return [line(point(-0.7, 0), point(-0.7, 1.4)), line(point(-0.7, 1.4), point(0.7, 0))];
  if (kind === 'squareButt') return [-0.4, 0.4].map((dx) => line(point(dx, 0), point(dx, 1.4)));
  if (kind === 'vButt') return [line(point(0, 0), point(-0.7, 1.4)), line(point(0, 0), point(0.7, 1.4))];
  if (kind === 'bevelButt') return [line(point(-0.5, 0), point(-0.5, 1.4)), line(point(-0.5, 0), point(0.7, 1.4))];
  if (kind === 'uButt') return [line(point(0, 0), point(0, 0.4)),
    { kind: 'arc', center: point(0, 1.1), radius: h * 0.7, startAngle: sign > 0 ? Math.PI : 0, endAngle: sign > 0 ? Math.PI * 2 : Math.PI }];
  if (kind === 'jButt') return [line(point(-0.5, 0), point(-0.5, 1.1)),
    { kind: 'arc', center: point(-0.5, 1.1), radius: h * 0.7, startAngle: sign > 0 ? -Math.PI / 2 : 0, endAngle: sign > 0 ? 0 : Math.PI / 2 }];
  const radius = 0.6 * h, center: Point2 = [x, y + (side === 'center' ? 0 : sign * radius)];
  const circle: DrawingRenderCurve = { kind: 'arc', center, radius, startAngle: 0, endAngle: Math.PI * 2 };
  return kind === 'spot' ? [circle] : [circle, ...[-0.2, 0.2].map((offset) => line([x - h * 0.8, center[1] + h * offset], [x + h * 0.8, center[1] + h * offset]))];
}
