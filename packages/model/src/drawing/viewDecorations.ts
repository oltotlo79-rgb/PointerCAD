import { breakDrawingCurve, createArrowTriangle, drawingViewBasis, formatDrawingScale, LINE_WIDTHS_MM,
  type DrawingDocument, type DrawingRenderCurve, type DrawingRenderElement, type Point2, type Vector3 } from '@pointercad/drawing';
import type { ResolvedDrawingView } from './resolveDrawing.js';
import type { ConstructedDrawingView } from './viewConstruction.js';
import { createCuttingLine } from './sectionSpec.js';

const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
type Bounds = { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number };
function viewBounds(view: ResolvedDrawingView): Bounds {
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const curve of [...view.visible.map((item) => item.curve), ...view.cuttingCurves]) {
    const points: readonly Point2[] = curve.kind === 'segment' ? [curve.from, curve.to] : curve.kind === 'polyline' ? curve.points
      : [[curve.center[0] - curve.radius, curve.center[1] - curve.radius], [curve.center[0] + curve.radius, curve.center[1] + curve.radius]];
    for (const [x, y] of points) { left = Math.min(left, x); right = Math.max(right, x); bottom = Math.min(bottom, y); top = Math.max(top, y); }
  }
  return Number.isFinite(left) ? { left, right, bottom, top }
    : { left: view.position[0] - 10, right: view.position[0] + 10, bottom: view.position[1] - 10, top: view.position[1] + 10 };
}

/** 切断面と、面を真横から見る親図の交線を図の外まで延ばす。 */
function planeTrace(parent: ConstructedDrawingView, projected: ResolvedDrawingView,
  section: NonNullable<ConstructedDrawingView['section']>): readonly Point2[] | null {
  const basis = drawingViewBasis({ normal: parent.view.direction, xDir: parent.view.xDir });
  if (basis === null || Math.abs(dot(section.plane.normal, basis.normal)) > 1e-7 || parent.breakSpec !== undefined) return null;
  const a = dot(section.plane.normal, basis.x), b = dot(section.plane.normal, basis.y), length = Math.hypot(a, b);
  if (length < 1e-9) return null;
  const delta: Vector3 = [parent.modelCenter[0] - section.plane.origin[0], parent.modelCenter[1] - section.plane.origin[1], parent.modelCenter[2] - section.plane.origin[2]];
  const distance = -dot(section.plane.normal, delta) * projected.scale / length;
  const origin: Point2 = [projected.position[0] + a / length * distance, projected.position[1] + b / length * distance];
  const axis: Point2 = [-b / length, a / length], bounds = viewBounds(projected), margin = 8;
  let first = -Infinity, last = Infinity;
  for (const [index, minimum, maximum] of [[0, bounds.left - margin, bounds.right + margin], [1, bounds.bottom - margin, bounds.top + margin]] as const) {
    if (Math.abs(axis[index]) < 1e-9) { if (origin[index] < minimum || origin[index] > maximum) return null; }
    else {
      const lo = (minimum - origin[index]) / axis[index], hi = (maximum - origin[index]) / axis[index];
      first = Math.max(first, Math.min(lo, hi)); last = Math.min(last, Math.max(lo, hi));
    }
  }
  return !Number.isFinite(first) || !Number.isFinite(last) || first >= last ? null
    : [[origin[0] + axis[0] * first, origin[1] + axis[1] * first], [origin[0] + axis[0] * last, origin[1] + axis[1] * last]];
}

/** 解決済みの図に付随する符号。文書へ導出パスを保存せず、全描画・出力で共有する。 */
export function addDrawingViewDecorations(document: DrawingDocument, views: readonly ResolvedDrawingView[],
  frames: ReadonlyMap<string, ConstructedDrawingView>): readonly ResolvedDrawingView[] {
  const decorations = new Map<string, DrawingRenderElement[]>(), sizeMm = document.sheet.textHeight ?? 3.5;
  const annotationLayer = (fallback: string): string => document.layers.some((layer) => layer.id === 'layer-5') ? 'layer-5' : fallback;
  const add = (id: string, element: DrawingRenderElement): void => {
    const items = decorations.get(id) ?? []; items.push(element); decorations.set(id, items);
  };
  for (const original of document.views) {
    const definition = original.construction, own = views.find((view) => view.viewId === original.id), frame = frames.get(original.id);
    if (own === undefined || frame === undefined || definition === undefined || definition.kind !== 'section' && definition.kind !== 'detail') continue;
    const style = { lineType: 'solid', lineWidth: LINE_WIDTHS_MM.thin } as const;
    add(original.id, { ownerId: original.id, layerId: annotationLayer(original.layerId), style,
      texts: [{ text: definition.kind === 'detail' ? `${definition.label} (${formatDrawingScale(own.scale)})` : `${definition.label}–${definition.label}`,
        position: [own.position[0], viewBounds(own).bottom - 8], sizeMm, anchor: 'middle', baseline: 'top' }] });
    if (definition.kind === 'detail') {
      const parent = frames.get(definition.sourceViewId), projected = views.find((view) => view.viewId === definition.sourceViewId);
      const region = frame.clips?.[frame.clips.length - 1];
      if (parent === undefined || projected === undefined || region?.kind !== 'circle') continue;
      const center: Point2 = [projected.position[0] + definition.center[0] * projected.scale, projected.position[1] + definition.center[1] * projected.scale];
      const radius = region.radius * projected.scale;
      const circle: DrawingRenderCurve = { kind: 'arc', center, radius, startAngle: 0, endAngle: Math.PI * 2 };
      const curves = parent.breakSpec === undefined ? [circle] : breakDrawingCurve(circle, parent.breakSpec);
      let label: Point2 = [center[0], center[1] + radius - sizeMm - 1];
      if (parent.breakSpec !== undefined) {
        const spec = parent.breakSpec, axis = spec.axis === 'u' ? 0 : 1;
        const shifted = label[axis] > spec.from && label[axis] < spec.to ? spec.from + spec.keepGap / 2
          : label[axis] >= spec.to ? label[axis] - (spec.to - spec.from - spec.keepGap) : label[axis];
        label = axis === 0 ? [shifted, label[1]] : [label[0], shifted];
      }
      add(projected.viewId, { ownerId: original.id, layerId: annotationLayer(parent.view.layerId), style, curves,
        texts: [{ text: definition.label, position: label, sizeMm, anchor: 'middle', baseline: 'bottom' }] });
      continue;
    }
    const section = frame.section; if (section === undefined) continue;
    const explicit = definition.plane.kind === 'viewLine' ? definition.plane : undefined;
    const candidates = explicit === undefined ? document.views.filter((view) => view.construction === undefined)
      : document.views.filter((view) => view.id === explicit.sourceViewId);
    for (const candidate of candidates) {
      const parent = frames.get(candidate.id), projected = views.find((view) => view.viewId === candidate.id);
      if (parent === undefined || projected === undefined) continue;
      const basis = drawingViewBasis({ normal: parent.view.direction, xDir: parent.view.xDir }); if (basis === null) continue;
      const toPaper = (point: Vector3): Point2 => {
        const relative: Vector3 = [point[0] - parent.modelCenter[0], point[1] - parent.modelCenter[1], point[2] - parent.modelCenter[2]];
        return [projected.position[0] + dot(relative, basis.x) * projected.scale, projected.position[1] + dot(relative, basis.y) * projected.scale];
      };
      let points = explicit === undefined ? planeTrace(parent, projected, section) : [explicit.from, explicit.to]
        .map((point): Point2 => [projected.position[0] + point[0] * projected.scale, projected.position[1] + point[1] * projected.scale]);
      if (points === null) continue;
      if (section.kind === 'stepped' && section.boundary !== undefined) points = section.boundary.map(([u, depth]) => toPaper([
        section.plane.origin[0] + u * section.plane.axisU[0] + depth * section.plane.normal[0],
        section.plane.origin[1] + u * section.plane.axisU[1] + depth * section.plane.normal[1],
        section.plane.origin[2] + u * section.plane.axisU[2] + depth * section.plane.normal[2],
      ]));
      const along: Point2 = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
      const direction: Point2 = [dot(frame.view.direction, basis.x), dot(frame.view.direction, basis.y)];
      const cutting = createCuttingLine(points, 0, -along[1] * direction[0] + along[0] * direction[1] >= 0 ? 'right' : 'left');
      if (cutting === null) continue;
      const common = { ownerId: original.id, layerId: annotationLayer(parent.view.layerId) };
      add(projected.viewId, { ...common, style: { ...style, lineType: 'chain' },
        curves: cutting.chain.map((line) => ({ kind: 'segment', from: line.from, to: line.to })) });
      add(projected.viewId, { ...common, style: { ...style, lineWidth: LINE_WIDTHS_MM.thick },
        curves: cutting.heavyMarks.map((line) => ({ kind: 'segment', from: line.from, to: line.to })) });
      add(projected.viewId, { ...common, style,
        curves: cutting.arrows.map((arrow) => ({ kind: 'segment', from: [arrow.at[0] - arrow.direction[0] * 7, arrow.at[1] - arrow.direction[1] * 7], to: arrow.at })),
        fills: cutting.arrows.map((arrow) => {
          const [tip, left, right] = createArrowTriangle(arrow.at, arrow.direction).points;
          return { fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: tip }, { kind: 'L', to: left }, { kind: 'L', to: right }, { kind: 'Z' }] }] };
        }),
        texts: cutting.arrows.map((arrow) => ({ text: definition.label, sizeMm, anchor: 'middle', baseline: 'middle',
          position: [arrow.at[0] - arrow.direction[0] * (9 + sizeMm / 2), arrow.at[1] - arrow.direction[1] * (9 + sizeMm / 2)] })) });
      break;
    }
  }
  return views.map((view) => decorations.has(view.viewId) ? { ...view, decorations: decorations.get(view.viewId) } : view);
}
