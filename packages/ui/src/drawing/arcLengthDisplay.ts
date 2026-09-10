import { createProjectedArcLengthDimensionGeometry, drawingViewBasis, type ProjectedArcLengthDimensionGeometry, type DrawingDocument, type Point2, type Vector3 } from '@pointercad/drawing';
import { resolvedDimensionView, type DimensionResolveContext, type ResolvedDimensionTarget, type ResolvedDrawingDimension } from '@pointercad/model';

type ArcTarget = Extract<ResolvedDimensionTarget, { readonly kind: 'circle' | 'arc' }>;
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vector3): Vector3 => { const length = Math.hypot(...a); return [a[0] / length, a[1] / length, a[2] / length]; };

/** 両端と弧長から大弧/小弧を、線重心から半円の向きを復元する。 */
export function arcLengthSweep(target: ArcTarget): { readonly sweep: number; readonly radial: Vector3; readonly tangent: Vector3 } | null {
  const radial = unit(subtract(target.from, target.center)); const axis = unit(target.axis);
  const tangent = unit(cross(axis, radial)); const angle = target.length / target.radius;
  if (![...radial, ...tangent, angle].every(Number.isFinite) || angle <= 0 || angle > 2 * Math.PI + 1e-7) return null;
  if (target.kind === 'circle') return { sweep: 2 * Math.PI, radial, tangent };
  const end = unit(subtract(target.to, target.center));
  const candidates = [angle, -angle].filter((sweep) => {
    const coordinate = (i: number): number => radial[i] * Math.cos(sweep) + tangent[i] * Math.sin(sweep);
    const expected: Vector3 = [coordinate(0), coordinate(1), coordinate(2)];
    return Math.hypot(...subtract(expected, end)) < 1e-6;
  });
  if (candidates.length === 1) return { sweep: candidates[0], radial, tangent };
  if (candidates.length !== 2 || target.centroid === undefined) return null;
  const towardArc = unit(subtract(target.centroid, target.center));
  const sweep = candidates.find((candidate) => dot(towardArc, radial) * Math.cos(candidate / 2) + dot(towardArc, tangent) * Math.sin(candidate / 2) > 1 - 1e-6);
  return sweep === undefined ? null : { sweep, radial, tangent };
}

export function arcLengthDisplayGeometry(document: DrawingDocument, resolved: ResolvedDrawingDimension,
  target: ArcTarget, textWidth: number, context: Pick<DimensionResolveContext, 'viewFrames'>): ProjectedArcLengthDimensionGeometry | null {
  const view = resolvedDimensionView(resolved.dimension.targets[0]?.viewId ?? '', document, context);
  const arc = arcLengthSweep(target); if (view === undefined || arc === null) return null;
  const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir }); if (basis === null) return null;
  const scale = view.scale ?? document.sheet.scale;
  const project = (direction: Vector3): Point2 => [dot(direction, basis.x) * target.radius * scale, dot(direction, basis.y) * target.radius * scale];
  const a = project(arc.radial), b = project(arc.tangent);
  const text = resolved.dimension.placement.textPosition;
  const radius = Math.max(Math.hypot(...a), Math.hypot(...b));
  const offset = text === null ? 8 : Math.max(1, Math.hypot(text[0] - target.paperCenter[0], text[1] - target.paperCenter[1]) - radius - 1);
  return createProjectedArcLengthDimensionGeometry({ center: target.paperCenter, axes: [a, b], sweep: arc.sweep, offset, textWidth });
}
