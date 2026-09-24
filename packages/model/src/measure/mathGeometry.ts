/** Called only with this recomputation's final geometry; saved fingerprints never supply values. */
import { selectMateTargetGeometry, type KernelBridge, type MeasureTarget, type SolidBody } from '../kernelBridge.js';
import { scoreSubShapeMatch } from '../kernelBridge/subShapeMatching.js';
import type { ResolvedPart } from '../part/resolvePart.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { compareMathGeometryCongruence, type MathGeometryComparisonShape } from './mathGeometryCongruence.js';
import type { MathGeometryCurve, MathGeometryFace, MathGeometryOutcome, MathGeometryPoint, MathGeometryQuantity, MathGeometryRequest,
  MathGeometryShape } from './mathGeometryTypes.js';

export interface MathGeometryContext {
  readonly documentId: string;
  readonly generation: number;
  readonly resolved: ResolvedPart;
  readonly bodies: readonly SolidBody[];
  readonly failedIds: ReadonlySet<string>;
  readonly bridge: Pick<KernelBridge, 'measure' | 'readCachedBodies'>;
  readonly shouldCancel: () => boolean;
}

/**
 * A face, edge or vertex is not re-selected by guesswork: when the best current candidate beats the
 * runner-up (itself at or above the kernel threshold 0.6) by less than this, the reference is
 * 'ambiguous-reference'. Only math geometry uses it; machining, appearance and mates keep the kernel pick.
 * Scores are 0..1 and an unchanged index alone is worth 0.2, so with a stable numbering a rival comes
 * this close only when the indexed candidate itself drifted far from the saved fingerprint. Without the
 * index, two faces or edges of the same orientation and size differ only by position, where 0.05 is a
 * distance difference of one eighth of the body's bounding diagonal.
 */
export const MATH_GEOMETRY_AMBIGUITY_MARGIN = 0.05;

type Scalar = { readonly value: number; readonly unit: 'mm' | 'mm2' | 'mm3' | 'degree' | 'radian' };
class GeometryProblem extends Error {
  constructor(readonly reason: Extract<MathGeometryOutcome, { readonly status: 'unresolved' }>['reason'], message: string) {
    super(message);
  }
}
const missing = (): never => { throw new GeometryProblem('missing-reference', '参照する現在の図形を確認できません。参照先を選び直してください。'); };
const unsupported = (): never => { throw new GeometryProblem('unsupported', 'この種類の図形からは指定した量を求められません。'); };
const ambiguous = (): never => { throw new GeometryProblem('ambiguous-reference', '形が変わり、参照先を1つに決められません。選び直してください。'); };
const finitePoint = (point: Vec3): Vec3 => point.every(Number.isFinite) ? point : missing();
const magnitude = (point: Vec3): number => Math.hypot(...point);
const difference = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Only explicitly referenced, current hidden steps need metadata; no old viewport body is borrowed. */
async function currentBodies(requests: readonly MathGeometryRequest[], context: MathGeometryContext): Promise<MathGeometryContext> {
  const ids = new Set<string>();
  const add = (target: MathGeometryPoint | MathGeometryCurve | MathGeometryShape): void => {
    if (target.kind === 'body') ids.add(target.featureId);
    else if (target.kind === 'vertex' || target.kind === 'edge' || target.kind === 'face') ids.add(target.reference.bodyFeatureId);
  };
  for (const request of requests) {
    if (request.documentId !== context.documentId) continue;
    const quantity = request.quantity;
    switch (quantity.kind) {
      case 'coordinate': add(quantity.point); break;
      case 'point-distance': case 'shape-distance': case 'angle': case 'plane-angle': case 'parallel': case 'perpendicular':
      case 'congruent': case 'similar':
        add(quantity.first); add(quantity.second); break;
      case 'line-plane-angle': add(quantity.line); add(quantity.plane); break;
      case 'point-angle': add(quantity.first); add(quantity.second); add(quantity.third); break;
      case 'length': case 'radius': case 'central-angle': add(quantity.curve); break;
      case 'contour-length': break;
      case 'area': add(quantity.shape); break;
      case 'volume': add(quantity.body); break;
    }
  }
  const present = new Set(context.bodies.map(value => value.featureId));
  const needed = context.resolved.steps.filter(step => !step.visible && ids.has(step.featureId)
    && !present.has(step.featureId) && !context.failedIds.has(step.featureId)).map(step => step.featureId);
  if (needed.length === 0 || context.bridge.readCachedBodies === undefined || context.shouldCancel()) return context;
  const failedIds = new Set(context.failedIds);
  try {
    const result = await context.bridge.readCachedBodies(context.resolved.steps, needed);
    // The outer loop checks cancellation before using any of these values.
    if (result.cancelled) {
      for (const id of needed) failedIds.add(id);
      return { ...context, failedIds };
    }
    for (const failure of result.failures) failedIds.add(failure.featureId);
    const requested = new Set(needed);
    return { ...context, failedIds, bodies: [...context.bodies, ...result.bodies.filter(value => requested.has(value.featureId))] };
  } catch {
    for (const id of needed) failedIds.add(id);
    return { ...context, failedIds };
  }
}

function body(context: MathGeometryContext, id: string): SolidBody {
  if (context.failedIds.has(id)) throw new GeometryProblem('failed-geometry', '参照先の形を正しく計算できませんでした。');
  const found = context.bodies.filter(candidate => candidate.featureId === id && candidate.isValid);
  if (found.length !== 1 || !context.resolved.steps.some(step => step.featureId === id)) return missing();
  return found[0];
}
function subShape(context: MathGeometryContext, target: Exclude<MathGeometryShape, { readonly kind: 'body' }>) {
  if (target.reference.fingerprint.kind !== target.kind) return missing();
  const current = body(context, target.reference.bodyFeatureId);
  const found = selectMateTargetGeometry(current, target.reference);
  if (found === null || found.kind !== target.kind) return missing();
  // Same kernel scoring as the pick above; a near tie means the saved fingerprint no longer names one shape.
  const scores = scoreSubShapeMatch(current, target.reference);
  if (scores === null) return missing();
  if (scores.runnerUpScore !== null && scores.score - scores.runnerUpScore < MATH_GEOMETRY_AMBIGUITY_MARGIN) return ambiguous();
  return found;
}
function point(context: MathGeometryContext, target: MathGeometryPoint): Vec3 {
  if (target.kind === 'vertex') return finitePoint(subShape(context, target).position);
  const sketches = context.resolved.sketches.filter(sketch => sketch.sketchId === target.sketchId);
  if (sketches.length !== 1 || context.failedIds.has(target.reference.pointId)) return missing();
  const found = sketches[0].resolved.points.filter(candidate => candidate.id === target.reference.pointId);
  if (found.length !== 1 || context.failedIds.has(found[0].featureId)) return missing();
  return finitePoint(found[0].position);
}
function coordinate(context: MathGeometryContext, quantity: Extract<MathGeometryQuantity, { readonly kind: 'coordinate' }>): number {
  const position = point(context, quantity.point);
  const component = { X: 0, Y: 1, Z: 2 }[quantity.component];
  if (quantity.frame === undefined) return position[component];
  const id = quantity.frame.featureId;
  const failure = context.resolved.references.errors.find(error => error.featureId === id);
  if (context.failedIds.has(id) || failure !== undefined) {
    throw new GeometryProblem('failed-geometry', failure?.message ?? '参照先の座標系を正しく計算できませんでした。');
  }
  const frames = context.resolved.references.coordinateSystems.filter(frame => frame.featureId === id);
  if (frames.length !== 1) return missing();
  const frame = frames[0], axes = [frame.xAxis, frame.yAxis, frame.zAxis];
  if (![frame.origin, ...axes].every(vector => vector.every(Number.isFinite))) {
    throw new GeometryProblem('failed-geometry', '座標系の原点と軸を正しく取得できませんでした。');
  }
  const delta = difference(position, frame.origin), axis = axes[component];
  return delta[0] * axis[0] + delta[1] * axis[1] + delta[2] * axis[2];
}
function sketchCurves(context: MathGeometryContext, target: { readonly sketchId: string; readonly featureId: string }): readonly ResolvedCurve[] {
  const sketches = context.resolved.sketches.filter(sketch => sketch.sketchId === target.sketchId);
  if (sketches.length !== 1 || context.failedIds.has(target.featureId)) return missing();
  const resolved = sketches[0].resolved;
  const curves = resolved.curvesByFeature.get(target.featureId)
    ?? [...resolved.segments, ...resolved.arcs, ...resolved.ellipses, ...resolved.splines].filter(curve => curve.featureId === target.featureId);
  if (curves.length === 0) return missing();
  return curves;
}
function sketchCurve(context: MathGeometryContext, target: Extract<MathGeometryCurve, { readonly kind: 'sketch-curve' }>): ResolvedCurve {
  const curves = sketchCurves(context, target);
  // A rectangle or other compound contour cannot silently mean its first edge.
  if (curves.length !== 1) return missing();
  return curves[0];
}
function curveLength(context: MathGeometryContext, target: MathGeometryCurve): number {
  if (target.kind === 'edge') {
    const shape = subShape(context, target);
    return shape.kind === 'edge' ? shape.length : missing();
  }
  return resolvedCurveLength(sketchCurve(context, target));
}
function resolvedCurveLength(curve: ResolvedCurve): number {
  if (curve.kind === 'segment') return magnitude(difference(finitePoint(curve.to), finitePoint(curve.from)));
  if (curve.kind === 'arc') return curve.radius * Math.abs(curve.endAngle - curve.startAngle);
  return unsupported();
}
function circularCurve(context: MathGeometryContext, target: MathGeometryCurve): { readonly radius: number; readonly sweep: number } {
  let radius: number, sweep: number;
  if (target.kind === 'edge') {
    const edge = subShape(context, target);
    if (edge.kind !== 'edge' || edge.curveKind !== 'circle' || edge.radius === null) return unsupported();
    radius = edge.radius;
    sweep = edge.length / radius;
  } else {
    const arc = sketchCurve(context, target);
    if (arc.kind !== 'arc') return unsupported();
    radius = arc.radius;
    sweep = Math.abs(arc.endAngle - arc.startAngle);
  }
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(sweep) || sweep < 0) {
    throw new GeometryProblem('failed-geometry', '円弧の半径と中心角を正しく取得できませんでした。');
  }
  return { radius, sweep };
}
function contourLength(context: MathGeometryContext, target: { readonly sketchId: string; readonly featureId: string }): number {
  const curves = sketchCurves(context, target);
  if (curves.some(curve => curve.kind !== 'segment' && curve.kind !== 'arc')) {
    throw new GeometryProblem('unsupported', '楕円や自由曲線を含む輪郭の長さには対応していません。');
  }
  return curves.reduce((total, curve) => total + resolvedCurveLength(curve), 0);
}
/** Classify only the current resolved geometry; a saved fingerprint never supplies dimensions. */
function comparisonShape(context: MathGeometryContext, target: MathGeometryCurve): MathGeometryComparisonShape {
  if (target.kind === 'sketch-curve') {
    const curves = sketchCurves(context, target);
    if (curves.length > 1) return { kind: 'polygon', curves };
    if (curves[0].kind === 'segment') return { kind: 'segment', length: resolvedCurveLength(curves[0]) };
    if (curves[0].kind !== 'arc') return unsupported();
  } else {
    const edge = subShape(context, target);
    if (edge.kind !== 'edge') return missing();
    if (edge.curveKind === 'line') return { kind: 'segment', length: edge.length };
    if (edge.curveKind !== 'circle') return unsupported();
  }
  return { kind: 'circular', ...circularCurve(context, target) };
}
function lineDirection(context: MathGeometryContext, target: MathGeometryCurve, tolerance: number): Vec3 {
  let direction: Vec3;
  if (target.kind === 'edge') {
    const shape = subShape(context, target);
    if (shape.kind !== 'edge' || shape.curveKind !== 'line' || shape.axis === null) return unsupported();
    if (shape.length <= tolerance) return unsupported();
    direction = finitePoint(shape.axis);
  } else {
    const curve = sketchCurve(context, target);
    if (curve.kind !== 'segment') return unsupported();
    direction = difference(finitePoint(curve.to), finitePoint(curve.from));
    if (magnitude(direction) <= tolerance) return unsupported();
  }
  return normalizedDirection(direction);
}
function normalizedDirection(direction: Vec3): Vec3 {
  const length = magnitude(direction);
  if (!Number.isFinite(length) || length === 0) return unsupported();
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}
function planeNormal(context: MathGeometryContext, target: MathGeometryFace): Vec3 {
  const face = subShape(context, target);
  if (face.kind !== 'face' || face.surfaceKind !== 'plane') {
    throw new GeometryProblem('unsupported', '平面でない面からは角度・平行・垂直を求められません。');
  }
  if (face.axis === null) return unsupported();
  return normalizedDirection(finitePoint(face.axis));
}
function pointDirection(context: MathGeometryContext, vertex: Vec3, target: MathGeometryPoint, tolerance: number): Vec3 {
  const direction = difference(point(context, target), vertex);
  if (magnitude(direction) <= tolerance) return unsupported();
  return normalizedDirection(direction);
}
/** atan2 retains precision near both parallel and perpendicular directions. */
function angleComponents(a: Vec3, b: Vec3): { readonly sine: number; readonly cosine: number } {
  const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return { sine: magnitude(cross), cosine: a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
}
function unorientedAngle(context: MathGeometryContext, first: MathGeometryCurve | MathGeometryFace,
  second: MathGeometryCurve | MathGeometryFace, tolerance: number): number {
  const a = first.kind === 'face' ? planeNormal(context, first) : lineDirection(context, first, tolerance);
  const b = second.kind === 'face' ? planeNormal(context, second) : lineDirection(context, second, tolerance);
  const { sine, cosine } = angleComponents(a, b);
  // One plane means the complement of the angle to its normal, independent of argument order.
  return (first.kind === 'face') !== (second.kind === 'face')
    ? Math.atan2(Math.abs(cosine), sine) : Math.atan2(sine, Math.abs(cosine));
}
function angleScalar(angle: number, unit: 'degree' | 'radian'): Scalar {
  return { value: unit === 'degree' ? angle * 180 / Math.PI : angle, unit };
}
function measureTarget(context: MathGeometryContext, target: MathGeometryShape): MeasureTarget {
  if (target.kind === 'body') {
    body(context, target.featureId);
    return { bodyFeatureId: target.featureId, subShape: null };
  }
  subShape(context, target);
  // No caller-provided bodyKey or placement can override the current part's identity.
  return { bodyFeatureId: target.reference.bodyFeatureId, subShape: target.reference };
}
async function evaluate(context: MathGeometryContext, request: MathGeometryRequest): Promise<Scalar | boolean> {
  const quantity = request.quantity;
  switch (quantity.kind) {
    case 'coordinate': return { value: coordinate(context, quantity), unit: 'mm' };
    case 'point-distance': return { value: magnitude(difference(point(context, quantity.first), point(context, quantity.second))), unit: 'mm' };
    case 'length': return { value: curveLength(context, quantity.curve), unit: 'mm' };
    case 'radius': return { value: circularCurve(context, quantity.curve).radius, unit: 'mm' };
    case 'central-angle': return angleScalar(circularCurve(context, quantity.curve).sweep, quantity.unit);
    case 'contour-length': return { value: contourLength(context, quantity), unit: 'mm' };
    case 'congruent': case 'similar': {
      const result = compareMathGeometryCongruence(quantity.kind, comparisonShape(context, quantity.first),
        comparisonShape(context, quantity.second), request.tolerance);
      if (!result.ok) throw new GeometryProblem(result.reason, result.message);
      return result.value;
    }
    case 'volume': {
      const value = body(context, quantity.body.featureId);
      if (value.bodyKind !== 'solid') return unsupported();
      return { value: value.volume, unit: 'mm3' };
    }
    case 'area': {
      if (quantity.shape.kind === 'face') {
        const face = subShape(context, quantity.shape);
        return face.kind === 'face' ? { value: face.area, unit: 'mm2' } : missing();
      }
      const target = measureTarget(context, quantity.shape);
      const outcome = await context.bridge.measure(context.resolved.steps, [target], 'massProperties');
      if (outcome.kind === 'failed') throw new GeometryProblem('failed-geometry', outcome.message);
      return outcome.kind === 'massProperties' ? { value: outcome.area, unit: 'mm2' } : missing();
    }
    case 'shape-distance': {
      const targets = [measureTarget(context, quantity.first), measureTarget(context, quantity.second)];
      const outcome = await context.bridge.measure(context.resolved.steps, targets, 'distance');
      if (outcome.kind === 'failed') throw new GeometryProblem('failed-geometry', outcome.message);
      return outcome.kind === 'distance' ? { value: outcome.distance, unit: 'mm' } : missing();
    }
    case 'angle': case 'plane-angle': case 'parallel': case 'perpendicular': {
      const angle = unorientedAngle(context, quantity.first, quantity.second, request.tolerance.linearMm);
      if (quantity.kind === 'parallel') return angle <= request.tolerance.angularRadians;
      if (quantity.kind === 'perpendicular') return Math.abs(Math.PI / 2 - angle) <= request.tolerance.angularRadians;
      return angleScalar(angle, quantity.unit);
    }
    case 'line-plane-angle':
      return angleScalar(unorientedAngle(context, quantity.line, quantity.plane, request.tolerance.linearMm), quantity.unit);
    case 'point-angle': {
      const vertex = point(context, quantity.second);
      const a = pointDirection(context, vertex, quantity.first, request.tolerance.linearMm);
      const b = pointDirection(context, vertex, quantity.third, request.tolerance.linearMm);
      const { sine, cosine } = angleComponents(a, b);
      return angleScalar(Math.atan2(sine, cosine), quantity.unit);
    }
  }
}

/** Null means cancellation; partial measurements must not survive a cancelled generation. */
export async function evaluateMathGeometry(requests: readonly MathGeometryRequest[], context: MathGeometryContext): Promise<readonly MathGeometryOutcome[] | null> {
  if (context.shouldCancel()) return null;
  const counts = new Map<string, number>();
  for (const request of requests) counts.set(request.id, (counts.get(request.id) ?? 0) + 1);
  const valid = (request: MathGeometryRequest): boolean => request.documentId === context.documentId
    && request.id.length > 0 && counts.get(request.id) === 1
    && Number.isFinite(request.tolerance.linearMm) && request.tolerance.linearMm > 0
    && Number.isFinite(request.tolerance.angularRadians) && request.tolerance.angularRadians > 0
    && request.tolerance.angularRadians < Math.PI / 4;
  context = await currentBodies(requests.filter(valid), context);
  if (context.shouldCancel()) return null;
  const outcomes: MathGeometryOutcome[] = [];
  for (const request of requests) {
    if (context.shouldCancel()) return null;
    const identity = { id: request.id, documentId: context.documentId, generation: context.generation };
    try {
      if (!valid(request)) {
        throw new GeometryProblem('invalid-request', '参照する文書・識別番号・許容差を確認してください。');
      }
      const value = await evaluate(context, request);
      if (context.shouldCancel()) return null;
      const base = { ...identity, status: 'value' as const, representation: 'geometry-double' as const, tolerance: request.tolerance };
      if (typeof value === 'boolean') outcomes.push({ ...base, kind: 'boolean', value });
      else {
        if (!Number.isFinite(value.value) || (request.quantity.kind !== 'coordinate' && value.value < 0)) {
          throw new GeometryProblem('failed-geometry', '図形から有限で妥当な測定値を取得できませんでした。');
        }
        outcomes.push({ ...base, kind: 'real', ...value });
      }
    } catch (error) {
      if (context.shouldCancel()) return null;
      outcomes.push({ ...identity, status: 'unresolved', reason: error instanceof GeometryProblem ? error.reason : 'failed-geometry',
        message: error instanceof Error ? error.message : '図形を測定できませんでした。' });
    }
  }
  return outcomes;
}
