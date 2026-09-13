/** ADD-13: measure resolved function points and direction lines without changing their definitions. */
import { distanceVec3, type ResolvedSketch, type Vec3, type LengthUnit } from '@pointercad/model';
import { angleDegreesBetween, formatMeasure, measureReadiness, type LocalMeasureResult, type MeasureReadiness, type MeasureTarget } from '../solid/measure.js';
import { parseSubShapeId, type SubShapeBody } from '../solid/subShapeSelection.js';
import type { MeasurementState, MeasureAngleSpec } from '../viewport/createMeasureLayer.js';

export interface SketchMeasureReadiness extends Omit<MeasureReadiness, 'targets'> {
  readonly source: 'sketch';
  readonly targets: readonly Pick<MeasureTarget, 'kind' | 'elementId'>[];
  readonly measurement: MeasurementState;
}
export type PartMeasureReadiness = MeasureReadiness | SketchMeasureReadiness;
type Point = { readonly kind: 'vertex'; readonly elementId: string; readonly point: Vec3; readonly sketch: boolean };
type Line = { readonly kind: 'edge'; readonly elementId: string; readonly from: Vec3; readonly to: Vec3; readonly sketch: true };
type Target = Point | Line;
const finitePoint = (point: Vec3): boolean => point.every(Number.isFinite);

function target(sketch: ResolvedSketch, bodies: readonly SubShapeBody[], elementId: string): Target | null {
  const point = sketch.points.find(item => item.id === elementId);
  if (point !== undefined) return finitePoint(point.position) ? { kind: 'vertex', elementId, point: point.position, sketch: true } : null;
  // A compound outline must never be measured as just its first segment.
  const segments = sketch.segments.filter(item => item.featureId === elementId);
  if (segments.length === 1 && !sketch.curvesByFeature.has(elementId)) {
    const line = segments[0];
    return finitePoint(line.from) && finitePoint(line.to) ? { kind: 'edge', elementId, from: line.from, to: line.to, sketch: true } : null;
  }
  const parsed = parseSubShapeId(elementId);
  if (parsed?.kind !== 'vertex') return null;
  const vertex = bodies.find(body => body.featureId === parsed.bodyFeatureId)?.vertices.find(item => item.index === parsed.index);
  return vertex !== undefined && finitePoint(vertex.position) ? { kind: 'vertex', elementId, point: vertex.position, sketch: false } : null;
}

function direction(line: Line): Vec3 | null {
  const delta: Vec3 = [line.to[0] - line.from[0], line.to[1] - line.from[1], line.to[2] - line.from[2]];
  const length = Math.hypot(...delta);
  return length > 0 && Number.isFinite(length) ? [delta[0] / length, delta[1] / length, delta[2] / length] : null;
}

export function partMeasureReadiness(selection: readonly string[], bodies: readonly SubShapeBody[], sketch?: ResolvedSketch, unit: LengthUnit = 'mm'): PartMeasureReadiness {
  if (sketch === undefined || selection.length < 1 || selection.length > 2 || new Set(selection).size !== selection.length) return measureReadiness(selection, bodies);
  const targets = selection.map(id => target(sketch, bodies, id));
  const first = targets[0], second = targets[1];
  if (first === null || targets.some(item => item === null) || !targets.some(item => item?.sketch)) return measureReadiness(selection, bodies);
  let result: LocalMeasureResult;
  let angle: MeasureAngleSpec | null = null;
  if (first.kind === 'vertex' && second?.kind === 'vertex') {
    result = { kind: 'pointDistance', value: distanceVec3(first.point, second.point), unit: 'mm', segment: [first.point, second.point] };
  } else if (first.kind === 'edge' && second === undefined) {
    result = { kind: 'edgeLength', value: distanceVec3(first.from, first.to), unit: 'mm', segment: [first.from, first.to] };
  } else if (first.kind === 'edge' && second?.kind === 'edge') {
    const from = direction(first), initialTo = direction(second);
    if (from === null || initialTo === null) return measureReadiness(selection, bodies);
    const value = angleDegreesBetween(from, initialTo);
    if (value === null) return measureReadiness(selection, bodies);
    const sign = from.reduce((sum, v, i) => sum + v * initialTo[i], 0) < 0 ? -1 : 1;
    const to: Vec3 = [sign * initialTo[0], sign * initialTo[1], sign * initialTo[2]];
    angle = { apex: first.from, from, to, radius: Math.min(distanceVec3(first.from, first.to), distanceVec3(second.from, second.to)) / 4 };
    result = { kind: 'edgeAngle', value, unit: 'degree', segment: null };
  } else return measureReadiness(selection, bodies);
  if (!Number.isFinite(result.value)) return measureReadiness(selection, bodies);
  return { source: 'sketch', ready: true, kind: result.kind, kinds: [result.kind], reason: null, message: null,
    targets: targets.filter((item): item is Target => item !== null).map(({ kind, elementId }) => ({ kind, elementId })),
    measurement: { result, text: formatMeasure(result, unit), angle, anchor: null } };
}
