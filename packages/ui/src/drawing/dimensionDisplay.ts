import { createAngleDimensionGeometry, createDiameterDimensionGeometry, createLinearDimensionGeometry,
  createRadiusDimensionGeometry, drawingViewBasis, formatDimension, layoutDimensionTolerance,
  type ArrowTriangle, type DrawingDocument, type DrawingRenderCurve, type DrawingRenderElement,
  type InkBounds, type OutlinedText, type Point2, type Vector3,
} from '@pointercad/drawing';
import type { ResolvedDimensionTarget, ResolvedDrawingDimension } from '@pointercad/model';

export interface DimensionDisplay {
  readonly element: DrawingRenderElement;
  readonly textPosition: Point2;
  readonly normal: Point2;
  readonly bounds: InkBounds | null;
  readonly unresolved: boolean;
}
export type OutlineDrawingText = (text: string, sizeMm: number) => OutlinedText;
const subtract = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalized(a: Point2): Point2 { const length = Math.hypot(...a); return length > 1e-9 ? [a[0] / length, a[1] / length] : [1, 0]; }

function center(target: ResolvedDimensionTarget): Point2 {
  if (target.kind === 'line') return [(target.paperFrom[0] + target.paperTo[0]) / 2, (target.paperFrom[1] + target.paperTo[1]) / 2];
  return target.kind === 'point' || target.kind === 'plane' ? target.paperPoint : target.paperCenter;
}
function endpoints(targets: readonly ResolvedDimensionTarget[]): readonly [Point2, Point2] | null {
  const first = targets[0], second = targets[1];
  if (first === undefined) return null;
  if (second === undefined) return first.kind === 'line' ? [first.paperFrom, first.paperTo] : null;
  if (first.kind === 'line' && second.kind === 'line') {
    const direction = normalized(subtract(first.paperTo, first.paperFrom));
    const delta = subtract(second.paperFrom, first.paperFrom);
    const along = delta[0] * direction[0] + delta[1] * direction[1];
    return [[first.paperFrom[0] + along * direction[0], first.paperFrom[1] + along * direction[1]], second.paperFrom];
  }
  return [center(first), center(second)];
}

/** 傾いた円の投影は楕円になる。紙上の任意方向との交点までの距離を求める。 */
function circlePaperRadius(target: Extract<ResolvedDimensionTarget, { kind: 'circle' | 'arc' }>, document: DrawingDocument,
  resolved: ResolvedDrawingDimension, direction: Point2): number | null {
  const view = document.views.find((candidate) => candidate.id === resolved.dimension.targets[0]?.viewId);
  if (view === undefined) return null;
  const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
  if (basis === null) return null;
  const raw = cross(target.axis, Math.abs(target.axis[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]);
  const length = Math.hypot(...raw);
  if (length < 1e-9) return null;
  const a: Vector3 = [raw[0] / length, raw[1] / length, raw[2] / length];
  const b = cross(target.axis, a);
  const ax = dot(a, basis.x), ay = dot(a, basis.y), bx = dot(b, basis.x), by = dot(b, basis.y);
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-9) return null;
  const parameterLength = Math.hypot((by * direction[0] - bx * direction[1]) / det, (-ay * direction[0] + ax * direction[1]) / det);
  return target.radius * (view.scale ?? document.sheet.scale) / parameterLength;
}

function arrowFill(arrow: ArrowTriangle): NonNullable<DrawingRenderElement['fills']>[number] {
  return { fillRule: 'nonzero', subpaths: [{ commands: [
    { kind: 'M', to: arrow.points[0] }, { kind: 'L', to: arrow.points[1] }, { kind: 'L', to: arrow.points[2] }, { kind: 'Z' },
  ] }] };
}

/** 値はmodelが解いた実寸だけを使う。紙上の線の長さは表示の配置にだけ使う。 */
export function displayDrawingDimension(document: DrawingDocument, resolved: ResolvedDrawingDimension,
  outline: OutlineDrawingText): DimensionDisplay {
  const dimension = resolved.dimension;
  const first = resolved.targets[0];
  const fallback: Point2 = dimension.placement.textPosition ?? (first === undefined ? [20, 20] : center(first));
  let textPosition = fallback;
  let normal: Point2 = [0, 1];
  const curves: DrawingRenderCurve[] = [];
  const arrows: ArrowTriangle[] = [];
  let geometryValid = resolved.status === 'resolved';
  const mainText = resolved.value === null ? resolved.text : formatDimension({ value: resolved.value, kind: dimension.kind,
    prefix: dimension.prefix, suffix: `${dimension.fit?.symbol ?? ''}${dimension.suffix ?? ''}`, reference: dimension.reference });
  const sizeMm = 3.5;
  const currentTolerance = resolved.displayTolerance ?? dimension.tolerance;
  const tolerance = currentTolerance === undefined ? null : layoutDimensionTolerance({ mainText, tolerance: currentTolerance,
    sizeMm, decimals: dimension.fit === undefined ? undefined : 4, measure: (text, size) => outline(text, size).metrics });
  const metrics = outline(mainText, sizeMm).metrics;
  const textWidth = tolerance === null ? (metrics?.advanceMm ?? 0) : tolerance.advanceMm;

  if (geometryValid && dimension.kind === 'angle' && first?.kind === 'line' && resolved.targets[1]?.kind === 'line') {
    const second = resolved.targets[1];
    const a = subtract(first.paperTo, first.paperFrom), b = subtract(second.paperTo, second.paperFrom);
    const det = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(det) < 1e-9) geometryValid = false;
    else {
      const offset = subtract(second.paperFrom, first.paperFrom);
      const along = (offset[0] * b[1] - offset[1] * b[0]) / det;
      const intersection: Point2 = [first.paperFrom[0] + along * a[0], first.paperFrom[1] + along * a[1]];
      const radius = dimension.placement.textPosition === null ? 12 : Math.max(3, Math.hypot(...subtract(fallback, intersection)) - 1);
      const geometry = createAngleDimensionGeometry(intersection, a, b, radius);
      if (geometry === null) geometryValid = false;
      else {
        curves.push({ kind: 'arc', ...geometry.dimensionArc }, ...geometry.extensionLines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })));
        arrows.push(...geometry.arrows); textPosition = geometry.textPosition;
        normal = normalized(subtract(textPosition, intersection));
      }
    }
  } else if (geometryValid && first !== undefined && (dimension.kind === 'diameter' || dimension.kind === 'radius'
    || dimension.kind === 'sphereDiameter' || dimension.kind === 'sphereRadius')) {
    if (first.kind !== 'circle' && first.kind !== 'arc' && first.kind !== 'sphere') geometryValid = false;
    else {
      const direction = dimension.placement.textPosition === null ? [1, 0] as const : normalized(subtract(fallback, first.paperCenter));
      const view = document.views.find((candidate) => candidate.id === dimension.targets[0]?.viewId);
      const radius = first.kind === 'sphere' ? first.radius * (view?.scale ?? document.sheet.scale)
        : circlePaperRadius(first, document, resolved, direction);
      const geometry = radius === null ? null : (dimension.kind === 'radius' || dimension.kind === 'sphereRadius'
        ? createRadiusDimensionGeometry(first.paperCenter, radius, direction) : createDiameterDimensionGeometry(first.paperCenter, radius, direction));
      if (geometry === null) geometryValid = false;
      else { curves.push({ kind: 'segment', ...geometry.dimensionLine }); arrows.push(...geometry.arrows); textPosition = geometry.textPosition; }
    }
  } else if (geometryValid) {
    const ends = endpoints(resolved.targets);
    if (ends === null) geometryValid = false;
    else {
      const direction: Point2 = dimension.measurement === 'horizontal' ? [1, 0] : dimension.measurement === 'vertical' ? [0, 1]
        : normalized(subtract(ends[1], ends[0]));
      normal = [-direction[1], direction[0]];
      const geometry = createLinearDimensionGeometry({ first: ends[0], second: ends[1], direction,
        commonNormalCoordinate: dimension.placement.commonNormalCoordinate, textWidth, textMargin: 1 });
      if (geometry === null) geometryValid = false;
      else {
        curves.push({ kind: 'segment', ...geometry.dimensionLine }, ...geometry.extensionLines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })));
        arrows.push(...geometry.arrows); textPosition = geometry.textPosition;
      }
    }
  }
  textPosition = dimension.placement.textPosition ?? textPosition;
  const unresolved = !geometryValid;
  const texts: NonNullable<DrawingRenderElement['texts']> = unresolved
    ? [{ text: '？', position: textPosition, sizeMm, anchor: 'middle', baseline: 'bottom' }]
    : tolerance === null ? [{ text: mainText, position: textPosition, sizeMm, anchor: 'middle', baseline: 'bottom' }]
      : tolerance.runs.map((run): NonNullable<DrawingRenderElement['texts']>[number] => ({ text: run.text,
        position: [textPosition[0] + run.position[0] - tolerance.advanceMm / 2, textPosition[1] + run.position[1] - tolerance.inkBounds.bottom],
        sizeMm: run.metrics.sizeMm }));
  const bounds = tolerance?.inkBounds ?? metrics?.inkBounds ?? null;
  return { element: { ownerId: dimension.id, layerId: dimension.layerId,
    style: unresolved ? { ...dimension.style, color: '#c2410c' } : dimension.style,
    curves: unresolved ? [] : curves, fills: unresolved ? [] : arrows.map(arrowFill), texts },
  textPosition, normal, unresolved, bounds: bounds === null ? null : {
    left: textPosition[0] - textWidth / 2 + bounds.left, right: textPosition[0] - textWidth / 2 + bounds.right,
    bottom: textPosition[1], top: textPosition[1] + bounds.top - bounds.bottom } };
}
