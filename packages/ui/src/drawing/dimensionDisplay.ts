import { createAngleDimensionGeometry, createDiameterDimensionGeometry, createLinearDimensionGeometry,
  createRadiusDimensionGeometry, createArrowTriangle, drawingViewBasis, formatDimension, layoutDimensionTolerance,
  type ArrowTriangle, type DrawingDocument, type DrawingRenderCurve, type DrawingRenderElement,
  type InkBounds, type OutlinedText, type Point2, type Vector3,
} from '@pointercad/drawing';
import { dimensionAngleDirections, drawingDimensionPaperEnds as endpoints, resolvedDimensionView, type DimensionResolveContext, type ResolvedDimensionTarget, type ResolvedDrawingDimension } from '@pointercad/model';
import { arcLengthDisplayGeometry } from './arcLengthDisplay.js';

export interface DimensionDisplay {
  readonly element: DrawingRenderElement;
  readonly textPosition: Point2;
  readonly normal: Point2;
  readonly bounds: InkBounds | null;
  readonly unresolved: boolean;
  readonly sizeDimensionLine?: { readonly from: Point2; readonly to: Point2 };
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
/** 傾いた円の投影は楕円になる。紙上の任意方向との交点までの距離を求める。 */
function circlePaperRadius(target: Extract<ResolvedDimensionTarget, { kind: 'circle' | 'arc' }>, document: DrawingDocument,
  resolved: ResolvedDrawingDimension, direction: Point2, context: Pick<DimensionResolveContext, 'viewFrames'>): number | null {
  const view = resolvedDimensionView(resolved.dimension.targets[0]?.viewId ?? '', document, context);
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
  outline: OutlineDrawingText, context: Pick<DimensionResolveContext, 'viewFrames'> = {}): DimensionDisplay {
  const dimension = resolved.dimension;
  const first = resolved.targets[0];
  const fallback: Point2 = dimension.placement.textPosition ?? (first === undefined ? [20, 20] : center(first));
  let textPosition = fallback;
  let normal: Point2 = [0, 1];
  const curves: DrawingRenderCurve[] = [];
  const arrows: ArrowTriangle[] = [];
  let sizeDimensionLine: DimensionDisplay['sizeDimensionLine'];
  let seriesTexts: NonNullable<DrawingRenderElement['texts']> | null = null;
  let geometryValid = resolved.status === 'resolved' && !(dimension.basic === true
    && (dimension.reference || dimension.tolerance !== undefined || dimension.fit !== undefined));
  const mainText = resolved.value === null ? resolved.text : formatDimension({ value: resolved.value, kind: dimension.kind,
    prefix: dimension.prefix, fitSymbol: dimension.fit?.symbol, suffix: dimension.suffix, reference: dimension.reference });
  const toleranceMainText = formatDimension({ value: resolved.value, kind: dimension.kind, prefix: dimension.prefix, fitSymbol: dimension.fit?.symbol });
  const sizeMm = document.sheet.textHeight ?? 3.5;
  const currentTolerance = resolved.displayTolerance ?? dimension.tolerance;
  const tolerance = currentTolerance === undefined || dimension.kind === 'coordinate' || dimension.series !== undefined ? null : layoutDimensionTolerance({ mainText: toleranceMainText, suffix: dimension.suffix,
    reference: dimension.reference, tolerance: currentTolerance,
    sizeMm, decimals: dimension.fit === undefined ? undefined : 4, measure: (text, size) => outline(text, size).metrics });
  const metrics = outline(mainText, sizeMm).metrics;
  const textWidth = tolerance === null ? (metrics?.advanceMm ?? 0) : tolerance.advanceMm;

  if (geometryValid && resolved.progressive !== undefined) {
    normal = dimension.measurement === 'horizontal' ? [0, 1] : [-1, 0];
    const original = resolved.progressive;
    const offset = dimension.placement.commonNormalCoordinate - original.line.from[0] * normal[0] - original.line.from[1] * normal[1];
    const move = (point: Point2): Point2 => [point[0] + normal[0] * offset, point[1] + normal[1] * offset];
    const series = { ...original, line: { from: move(original.line.from), to: move(original.line.to) }, ticks: original.ticks.map((tick) => ({
      ...tick, line: { from: move(tick.line.from), to: move(tick.line.to) }, textPosition: move(tick.textPosition),
      arrow: tick.arrow === null ? null : { ...tick.arrow, points: [move(tick.arrow.points[0]), move(tick.arrow.points[1]), move(tick.arrow.points[2])] as const },
    })) };
    const base = series.ticks.find((tick) => tick.pointId === series.basePointId);
    if (base === undefined) geometryValid = false;
    else {
      textPosition = base.textPosition;
      const shift = dimension.placement.textPosition === null ? [0, 0] as const : subtract(dimension.placement.textPosition, textPosition);
      curves.push({ kind: 'segment', ...series.line });
      seriesTexts = series.ticks.map((tick, index) => {
        curves.push({ kind: 'segment', ...tick.line });
        if (tick.arrow !== null) arrows.push(tick.arrow);
        const target = resolved.targets[index];
        if (target?.kind === 'point') {
          const at = center(target), h = dimension.placement.commonNormalCoordinate;
          const distance = h - at[0] * normal[0] - at[1] * normal[1], side = Math.sign(distance);
          curves.push({ kind: 'segment', from: [at[0] + normal[0] * side, at[1] + normal[1] * side],
            to: [at[0] + normal[0] * (distance + 2 * side), at[1] + normal[1] * (distance + 2 * side)] });
        }
        return { text: formatDimension({ value: tick.value, kind: 'length', prefix: dimension.prefix, suffix: dimension.suffix,
          tolerance: resolved.displayTolerance, reference: dimension.reference }),
        position: [tick.textPosition[0] + shift[0], tick.textPosition[1] + shift[1]], sizeMm, anchor: 'middle', baseline: 'bottom' };
      });
      const origin: Point2 = [(base.line.from[0] + base.line.to[0]) / 2, (base.line.from[1] + base.line.to[1]) / 2];
      curves.push({ kind: 'arc', center: origin, radius: 0.8, startAngle: 0, endAngle: Math.PI * 2 });
    }
  } else if (geometryValid && dimension.kind === 'coordinate') {
    const ends = endpoints(resolved.targets);
    if (ends === null || resolved.coordinates === null) geometryValid = false;
    else {
      const point = ends[1];
      textPosition = dimension.placement.textPosition ?? [point[0] + textWidth / 2 + 8, dimension.placement.commonNormalCoordinate];
      const end: Point2 = [textPosition[0] - textWidth / 2, textPosition[1] - 1];
      const direction = normalized(subtract(end, point));
      curves.push({ kind: 'segment', from: point, to: end }, { kind: 'segment', from: end, to: [end[0] + textWidth, end[1]] });
      arrows.push(createArrowTriangle(point, [-direction[0], -direction[1]]));
    }
  } else if (geometryValid && dimension.kind === 'arcLength') {
    const geometry = first?.kind === 'circle' || first?.kind === 'arc' ? arcLengthDisplayGeometry(document, resolved, first, textWidth, context) : null;
    if (geometry === null) geometryValid = false;
    else {
      curves.push({ kind: 'polyline', points: geometry.points, closed: false },
        ...geometry.extensionLines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })));
      arrows.push(...geometry.arrows); textPosition = geometry.textPosition; normal = geometry.normal;
    }
  } else if (geometryValid && dimension.kind === 'angle' && first?.kind === 'line' && resolved.targets[1]?.kind === 'line') {
    const second = resolved.targets[1];
    const rays = dimensionAngleDirections(first, second), rawA = subtract(first.paperTo, first.paperFrom), rawB = subtract(second.paperTo, second.paperFrom);
    const a: Point2 = [rawA[0] * (rays?.firstSign ?? 1), rawA[1] * (rays?.firstSign ?? 1)];
    const b: Point2 = [rawB[0] * (rays?.secondSign ?? 1), rawB[1] * (rays?.secondSign ?? 1)];
    const det = a[0] * b[1] - a[1] * b[0];
    if (rays === null || Math.abs(det) < 1e-9) geometryValid = false;
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
      const view = resolvedDimensionView(dimension.targets[0]?.viewId ?? '', document, context);
      const radius = first.kind === 'sphere' ? first.radius * (view?.scale ?? document.sheet.scale)
        : circlePaperRadius(first, document, resolved, direction, context);
      const geometry = radius === null ? null : (dimension.kind === 'radius' || dimension.kind === 'sphereRadius'
        ? createRadiusDimensionGeometry(first.paperCenter, radius, direction) : createDiameterDimensionGeometry(first.paperCenter, radius, direction));
      if (geometry === null) geometryValid = false;
      else {
        curves.push({ kind: 'segment', ...geometry.dimensionLine }); arrows.push(...geometry.arrows); textPosition = geometry.textPosition;
        if (dimension.kind === 'diameter') sizeDimensionLine = geometry.dimensionLine;
      }
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
        sizeDimensionLine = geometry.dimensionLine;
      }
    }
  }
  textPosition = dimension.placement.textPosition ?? textPosition;
  const unresolved = !geometryValid;
  const texts: NonNullable<DrawingRenderElement['texts']> = unresolved
    ? [{ text: '？', position: textPosition, sizeMm, anchor: 'middle', baseline: 'bottom' }]
    : seriesTexts ?? (tolerance === null ? [{ text: mainText, position: textPosition, sizeMm, anchor: 'middle', baseline: 'bottom' }]
      : tolerance.runs.map((run): NonNullable<DrawingRenderElement['texts']>[number] => ({ text: run.text,
        position: [textPosition[0] + run.position[0] - tolerance.advanceMm / 2, textPosition[1] + run.position[1] - tolerance.inkBounds.bottom],
        sizeMm: run.metrics.sizeMm })));
  const bounds = tolerance?.inkBounds ?? metrics?.inkBounds ?? null;
  const seriesBounds = seriesTexts?.flatMap((text) => {
    const measured = outline(text.text, text.sizeMm).metrics;
    return measured == null ? [] : [{ left: text.position[0] - measured.advanceMm / 2 + measured.inkBounds.left,
      right: text.position[0] - measured.advanceMm / 2 + measured.inkBounds.right, bottom: text.position[1],
      top: text.position[1] + measured.inkBounds.top - measured.inkBounds.bottom }];
  });
  const textBounds: InkBounds | null = seriesBounds !== undefined && seriesBounds.length > 0 ? {
    left: Math.min(...seriesBounds.map((box) => box.left)), right: Math.max(...seriesBounds.map((box) => box.right)),
    bottom: Math.min(...seriesBounds.map((box) => box.bottom)), top: Math.max(...seriesBounds.map((box) => box.top)),
  } : bounds === null ? null : {
    left: textPosition[0] - textWidth / 2 + bounds.left, right: textPosition[0] - textWidth / 2 + bounds.right,
    bottom: textPosition[1], top: textPosition[1] + bounds.top - bounds.bottom };
  let displayBounds = textBounds;
  if (!unresolved && dimension.basic === true && textBounds !== null) {
    // P9-10: 用紙上の文字境界から四辺とも1mm以上離す。図の縮尺では変えない。
    const padding = 1;
    displayBounds = { left: textBounds.left - padding, right: textBounds.right + padding, bottom: textBounds.bottom - padding, top: textBounds.top + padding };
    for (const box of seriesBounds !== undefined && seriesBounds.length > 0 ? seriesBounds : [textBounds]) {
      curves.push({ kind: 'polyline', points: [[box.left - padding, box.bottom - padding], [box.right + padding, box.bottom - padding],
        [box.right + padding, box.top + padding], [box.left - padding, box.top + padding]], closed: true });
    }
  }
  return { element: { ownerId: dimension.id, layerId: dimension.layerId,
    style: unresolved ? { ...dimension.style, color: '#c2410c' } : dimension.style,
    curves: unresolved ? [] : curves, fills: unresolved ? [] : arrows.map(arrowFill), texts },
  textPosition, normal, unresolved, bounds: displayBounds, ...(unresolved || sizeDimensionLine === undefined ? {} : { sizeDimensionLine }) };
}
