import { drawingRegionContainsPoint, drawingViewBasis, type DrawingDocument, type Point2, type Vector3 } from '@pointercad/drawing';
import { resolvedDimensionView, type DimensionResolveContext } from './dimensionTarget.js';
import type { ConstructedDrawingView } from './viewConstruction.js';

const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 紙面のクリックを省略前の位置へ戻す。空白の隙間と切り抜き外は選択できない。 */
export function unfoldDrawingPick(point: Point2, id: string, document: DrawingDocument, context: DimensionResolveContext): Point2 | null {
  const view = resolvedDimensionView(id, document, context); if (view === undefined) return null;
  const frame = context.viewFrames?.get(id), spec = frame?.breakSpec;
  let unfolded = point;
  if (spec !== undefined) {
    const axis = spec.axis === 'u' ? 0 : 1;
    if (point[axis] > spec.from && point[axis] < spec.from + spec.keepGap) return null;
    if (point[axis] >= spec.from + spec.keepGap) {
      const amount = spec.to - spec.from - spec.keepGap;
      unfolded = axis === 0 ? [point[0] + amount, point[1]] : [point[0], point[1] + amount];
    }
  }
  const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir }), scale = view.scale ?? document.sheet.scale;
  if (basis === null || !Number.isFinite(scale) || scale <= 0) return null;
  const center = frame?.modelCenter ?? context.modelCenter;
  const raw: Point2 = [(unfolded[0] - view.position[0]) / scale + dot(center, basis.x),
    (unfolded[1] - view.position[1]) / scale + dot(center, basis.y)];
  return frame?.clips?.some((clip) => !drawingRegionContainsPoint(raw, clip)) === true ? null : unfolded;
}

/** 元メッシュの面を選ぶ際に、断面で取り去った部分を候補へ戻さない。 */
export function drawingSectionRetainsPoint(point: Vector3, section: ConstructedDrawingView['section']): boolean {
  if (section === undefined) return true;
  const relative: Vector3 = [point[0] - section.plane.origin[0], point[1] - section.plane.origin[1], point[2] - section.plane.origin[2]];
  const depth = dot(relative, section.plane.normal), u = dot(relative, section.plane.axisU), v = dot(relative, section.plane.axisV);
  const boundary = section.boundary ?? [];
  if (section.kind === 'half') {
    const [a, b] = boundary; if (a === undefined || b === undefined) return false;
    if ((b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0]) < -1e-9) return true;
  } else if (section.kind === 'local' && !drawingRegionContainsPoint([u, v], { kind: 'polygon', points: boundary })) return true;
  let cutDepth = 0;
  if (section.kind === 'stepped') {
    if (boundary.length < 2) return false;
    cutDepth = u < boundary[0][0] ? boundary[0][1] : boundary[boundary.length - 1][1];
    for (let index = 1; index < boundary.length; index++) {
      const a = boundary[index - 1], b = boundary[index];
      if (u < a[0] || u > b[0] || b[0] - a[0] <= 1e-12) continue;
      cutDepth = a[1] + (b[1] - a[1]) * (u - a[0]) / (b[0] - a[0]); break;
    }
  }
  return section.keepSide === 'positive' ? depth >= cutDepth - 1e-7 : depth <= cutDepth + 1e-7;
}
