import type { DrawingRenderCurve, DrawingRenderElement } from '../render/renderDrawing.js';
import type { InkBounds } from '../render/types.js';
import type { Point2 } from '../types.js';
import { measureGdtTokens, type MeasureGdtText } from './frameGeometry.js';

/** targetは表面の引出線、またはサイズ寸法線の延長上。軸の意味を単なる面への矢印で代用しない。 */
export function gdtDatumGeometry(input: { readonly label: string; readonly position: Point2; readonly target: Point2;
  readonly height: number; readonly measure: MeasureGdtText; readonly targetDirection?: Point2 }): {
    readonly curves: readonly DrawingRenderCurve[]; readonly fills: NonNullable<DrawingRenderElement['fills']>;
    readonly texts: NonNullable<DrawingRenderElement['texts']>; readonly bounds: InkBounds;
  } | null {
  const { label, position, target, height } = input;
  if (!/^[A-Z]$/.test(label) || !Number.isFinite(height) || height < 1 || height > 100 || ![...position, ...target].every(Number.isFinite)) return null;
  const measured = measureGdtTokens([{ kind: 'text', text: label }], height, input.measure), metrics = measured?.[0]?.metrics;
  if (metrics == null || measured === null) return null;
  const size = Math.max(2 * height, measured[0].width + 2), center: Point2 = [position[0] + size / 2, position[1] + size / 2];
  const dx = target[0] - center[0], dy = target[1] - center[1], distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || Math.max(Math.abs(dx), Math.abs(dy)) <= size / 2) return null;
  const ratio = (size / 2) / Math.max(Math.abs(dx), Math.abs(dy)), start: Point2 = [center[0] + dx * ratio, center[1] + dy * ratio];
  let u: Point2 = [-dx / distance, -dy / distance];
  if (input.targetDirection !== undefined) {
    const [tx, ty] = input.targetDirection, length = Math.hypot(tx, ty);
    if (!Number.isFinite(length) || length < 1e-9) return null;
    const sign = -dy * tx + dx * ty >= 0 ? 1 : -1;
    u = [-ty / length * sign, tx / length * sign];
  }
  const triangleHeight = Math.min(height * 0.7, Math.hypot(target[0] - start[0], target[1] - start[1]) / 2);
  const halfWidth = triangleHeight * 0.58;
  // データム三角は底辺を対象線へ置き、頂点を枠へ結ぶ。公差指示の矢印とは逆向き。
  const tip: Point2 = [target[0] + u[0] * triangleHeight, target[1] + u[1] * triangleHeight];
  const a: Point2 = [target[0] - u[1] * halfWidth, target[1] + u[0] * halfWidth];
  const b: Point2 = [target[0] + u[1] * halfWidth, target[1] - u[0] * halfWidth];
  const bounds = { left: position[0], bottom: position[1], right: position[0] + size, top: position[1] + size };
  if (!Object.values(bounds).every(Number.isFinite)) return null;
  return { curves: [{ kind: 'polyline', points: [position, [bounds.right, bounds.bottom], [bounds.right, bounds.top], [bounds.left, bounds.top]], closed: true },
    { kind: 'segment', from: start, to: tip }],
  fills: [{ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: tip }, { kind: 'L', to: a }, { kind: 'L', to: b }, { kind: 'Z' }] }] }],
  texts: [{ text: label, sizeMm: height, anchor: 'start', baseline: 'alphabetic', position: [center[0] - (metrics.inkBounds.left + metrics.inkBounds.right) / 2,
    center[1] - (metrics.inkBounds.bottom + metrics.inkBounds.top) / 2] }], bounds };
}
