import {
  drawingViewBasis, fitTolerance, formatDimension, resolveDimensionTolerance,
  type Dimension, type DimensionTarget, type DimensionTolerance, type DrawingDocument, type DrawingViewBasis, type Point2, type Vector3,
} from '@pointercad/drawing';
import { evaluateExpression } from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import { rematchSubShapeRef, type SolidBody } from '../kernelBridge.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../assembly/placementMath.js';
import type { DrawingProjectionCurve } from './resolveDrawing.js';

export type ResolvedDimensionTarget =
  | { readonly kind: 'point'; readonly point: Vector3; readonly paperPoint: Point2 }
  | { readonly kind: 'line'; readonly from: Vector3; readonly to: Vector3; readonly paperFrom: Point2; readonly paperTo: Point2; readonly length: number }
  | { readonly kind: 'circle' | 'arc'; readonly center: Vector3; readonly axis: Vector3; readonly radius: number; readonly length: number;
      readonly from: Vector3; readonly to: Vector3; readonly paperCenter: Point2; readonly paperFrom: Point2; readonly paperTo: Point2 }
  | { readonly kind: 'plane'; readonly point: Vector3; readonly normal: Vector3; readonly paperPoint: Point2 }
  | { readonly kind: 'sphere'; readonly center: Vector3; readonly radius: number; readonly paperCenter: Point2 };
export interface DrawingDimensionInstance {
  readonly sourceRef: string;
  /** Workerの投影へ渡したボディの鍵。featureIdと混同しない。 */
  readonly bodyId: string;
  readonly componentId?: string;
  readonly body: SolidBody;
  readonly placement: RigidPlacement;
}

/** HLRが由来を確定できた辺だけを保存参照へ変える。輪郭や曖昧な由来はnull。 */
export function drawingTargetFromProjection(
  curve: DrawingProjectionCurve, viewId: string, sourceRef: string, instances: readonly DrawingDimensionInstance[],
): DimensionTarget | null {
  const source = curve.provenance;
  if (source.kind !== 'edge' || source.dimensionTarget !== true || typeof source.bodyId !== 'string'
    || typeof source.edgeIndex !== 'number' || !Number.isInteger(source.edgeIndex) || source.edgeIndex < 0
    || (source.occurrenceId !== null && typeof source.occurrenceId !== 'string')
    || !Array.isArray(source.parameterRange) || source.parameterRange.length !== 2
    || !source.parameterRange.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) return null;
  const candidates = instances.filter((instance) => instance.sourceRef === sourceRef && instance.bodyId === source.bodyId
    && (instance.componentId ?? null) === source.occurrenceId);
  if (candidates.length !== 1) return null;
  const instance = candidates[0];
  const edge = instance.body.edges.find((item) => item.index === source.edgeIndex);
  if (edge === undefined) return null;
  return { kind: 'subShape', viewId, sourceRef, ...(instance.componentId === undefined ? {} : { componentId: instance.componentId }),
    ref: { bodyFeatureId: instance.body.featureId, index: edge.index, fingerprint: {
      kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius,
    } } };
}
export interface DimensionResolveContext {
  readonly instances: readonly DrawingDimensionInstance[];
  /** resolveDrawingと同じ、配置済み元モデル全体の中心。 */
  readonly modelCenter: Vector3;
}
export interface ResolvedDrawingDimension {
  readonly dimension: Dimension;
  readonly targets: readonly ResolvedDimensionTarget[];
  readonly value: number | null;
  /** 座標寸法は基準点からの図のX/Y成分。単一の距離へ潰さない。 */
  readonly coordinates: Point2 | null;
  readonly text: string;
  readonly status: 'resolved' | 'unresolved';
  readonly reason: 'target' | 'measurement' | 'view' | null;
  readonly displayTolerance?: DimensionTolerance;
}

const GEOMETRY_TOLERANCE = 1e-7;
function delta(a: Vector3, b: Vector3): Vector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vector3, b: Vector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function unit(vector: Vector3): Vector3 | null {
  const length = Math.hypot(...vector);
  return length > 0 && Number.isFinite(length) ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}
function parallel(a: Vector3, b: Vector3): boolean {
  const first = unit(a), second = unit(b);
  return first !== null && second !== null && 1 - Math.abs(dot(first, second)) <= GEOMETRY_TOLERANCE;
}

/** kernelBridgeに既存の指紋照合(しきい値0.6)を使う。同じfeatureIdでも別の部品へ逃がさない。 */
export function resolveDimensionTarget(
  target: DimensionTarget, document: DrawingDocument, context: DimensionResolveContext,
): ResolvedDimensionTarget | null {
  const view = document.views.find((item) => item.id === target.viewId);
  if (view === undefined) return null;
  const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
  const scale = view.scale ?? document.sheet.scale;
  if (basis === null || !Number.isFinite(scale) || scale <= 0) return null;
  const paper = (point: Vector3): Point2 => {
    const relative = delta(point, context.modelCenter);
    return [view.position[0] + dot(relative, basis.x) * scale, view.position[1] + dot(relative, basis.y) * scale];
  };
  if (target.kind === 'point') {
    // 紙面だけにある点からモデルの長さを逆算しない。
    return target.modelPoint === undefined || !target.modelPoint.every(Number.isFinite) ? null
      : { kind: 'point', point: target.modelPoint, paperPoint: paper(target.modelPoint) };
  }
  if (target.sourceRef !== document.source.sourceRef) return null;
  const matches = context.instances.filter((item) => item.sourceRef === target.sourceRef && item.componentId === target.componentId
    && item.body.featureId === target.ref.bodyFeatureId);
  if (matches.length !== 1) return null;
  const instance = matches[0];
  const reference = rematchSubShapeRef([instance.body], target.ref);
  if (reference === null) return null;
  const point = (value: Vector3) => applyPlacementToPoint(instance.placement, value);
  const direction = (value: Vector3) => applyPlacementToDirection(instance.placement, value);
  if (reference.fingerprint.kind === 'vertex') {
    const vertex = instance.body.vertices.find((item) => item.index === reference.index);
    if (vertex === undefined) return null;
    const current = point(vertex.position);
    return { kind: 'point', point: current, paperPoint: paper(current) };
  }
  if (reference.fingerprint.kind === 'edge') {
    const edge = instance.body.edges.find((item) => item.index === reference.index);
    if (edge === undefined || !Number.isFinite(edge.length) || edge.length <= 0) return null;
    const from = point(edge.start), to = point(edge.end);
    if (edge.curveKind === 'line') return { kind: 'line', from, to, length: edge.length, paperFrom: paper(from), paperTo: paper(to) };
    if (edge.curveKind !== 'circle' || edge.axisOrigin == null || edge.axis === null || edge.radius === null || edge.radius <= 0) return null;
    const center = point(edge.axisOrigin);
    const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) <= GEOMETRY_TOLERANCE * Math.max(1, edge.length)
      && Math.hypot(...delta(from, to)) <= GEOMETRY_TOLERANCE;
    return { kind: full ? 'circle' : 'arc', center, axis: direction(edge.axis), radius: edge.radius, length: edge.length,
      from, to, paperCenter: paper(center), paperFrom: paper(from), paperTo: paper(to) };
  }
  const face = instance.body.faces.find((item) => item.index === reference.index);
  if (face === undefined) return null;
  if (face.surfaceKind === 'plane' && face.axis !== null) {
    const current = point(face.centroid);
    return { kind: 'plane', point: current, normal: direction(face.axis), paperPoint: paper(current) };
  }
  // 部分的な球面の重心を球の中心として使わない。kernelで解析中心を公開してから解決する。
  if (face.surfaceKind === 'sphere' && face.axisOrigin != null && face.radius !== null && face.radius > 0) {
    const center = point(face.axisOrigin);
    return { kind: 'sphere', center, radius: face.radius, paperCenter: paper(center) };
  }
  return null;
}

/** 注記の引出点。曲面の面積重心は注記位置にだけ使い、寸法の測定値には使わない。 */
export function resolveDrawingAnnotationTarget(target: DimensionTarget, document: DrawingDocument, context: DimensionResolveContext): Point2 | null {
  if (target.kind === 'subShape' && target.ref.fingerprint.kind === 'face') {
    if (target.sourceRef !== document.source.sourceRef) return null;
    const view = document.views.find((item) => item.id === target.viewId);
    if (view === undefined) return null;
    const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
    const scale = view.scale ?? document.sheet.scale;
    const matches = context.instances.filter((item) => item.sourceRef === target.sourceRef && item.componentId === target.componentId
      && item.body.featureId === target.ref.bodyFeatureId);
    if (basis === null || !Number.isFinite(scale) || scale <= 0 || matches.length !== 1) return null;
    const instance = matches[0], reference = rematchSubShapeRef([instance.body], target.ref);
    const face = reference === null ? undefined : instance.body.faces.find((item) => item.index === reference.index);
    if (face === undefined) return null;
    const point = delta(applyPlacementToPoint(instance.placement, face.centroid), context.modelCenter);
    return [view.position[0] + dot(point, basis.x) * scale, view.position[1] + dot(point, basis.y) * scale];
  }
  const resolved = resolveDimensionTarget(target, document, context);
  if (resolved === null) return null;
  if (resolved.kind === 'point' || resolved.kind === 'plane') return resolved.paperPoint;
  if (resolved.kind === 'line') return [(resolved.paperFrom[0] + resolved.paperTo[0]) / 2, (resolved.paperFrom[1] + resolved.paperTo[1]) / 2];
  return resolved.paperCenter;
}

function segment(target: ResolvedDimensionTarget): readonly [Vector3, Vector3] | null {
  return target.kind === 'line' ? [target.from, target.to] : null;
}
function centerPoint(target: ResolvedDimensionTarget): Vector3 | null {
  return target.kind === 'point' ? target.point
    : target.kind === 'circle' || target.kind === 'arc' || target.kind === 'sphere' ? target.center : null;
}
function measurementEnds(targets: readonly ResolvedDimensionTarget[]): readonly [Vector3, Vector3] | null {
  if (targets.length === 1) return segment(targets[0]);
  if (targets.length !== 2) return null;
  const first = centerPoint(targets[0]), second = centerPoint(targets[1]);
  return first === null || second === null ? null : [first, second];
}
function directionOf(target: ResolvedDimensionTarget): Vector3 | null {
  return target.kind === 'line' ? unit(delta(target.to, target.from)) : target.kind === 'plane' ? unit(target.normal) : null;
}
function measure(dimension: Dimension, targets: readonly ResolvedDimensionTarget[], basis: DrawingViewBasis): number | null {
  const first = targets[0];
  if (first === undefined) return null;
  if (dimension.kind === 'radius' || dimension.kind === 'diameter' || dimension.kind === 'sphereRadius' || dimension.kind === 'sphereDiameter') {
    const sphere = dimension.kind === 'sphereRadius' || dimension.kind === 'sphereDiameter';
    if (targets.length !== 1 || (sphere ? first.kind !== 'sphere' : first.kind !== 'circle' && first.kind !== 'arc')) return null;
    if (!('radius' in first)) return null;
    return first.radius * (dimension.kind === 'diameter' || dimension.kind === 'sphereDiameter' ? 2 : 1);
  }
  if (dimension.kind === 'arcLength') return targets.length === 1 && (first.kind === 'circle' || first.kind === 'arc') ? first.length : null;
  if (dimension.kind === 'angle') {
    if (targets.length !== 2) return null;
    const a = directionOf(first), b = directionOf(targets[1]);
    return a === null || b === null ? null : Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
  }
  const ends = measurementEnds(targets);
  if (ends !== null) {
    const vector = delta(ends[1], ends[0]);
    if (dimension.measurement === 'horizontal') return Math.abs(dot(vector, basis.x));
    if (dimension.measurement === 'vertical') return Math.abs(dot(vector, basis.y));
    if (dimension.measurement === 'trueDistance') return Math.hypot(...vector);
    return null;
  }
  if (targets.length === 2) {
    const second = targets[1];
    if (first.kind === 'plane' && second.kind === 'plane' && parallel(first.normal, second.normal)) {
      const normal = unit(first.normal);
      return normal === null ? null : Math.abs(dot(delta(second.point, first.point), normal));
    }
    if (first.kind === 'line' && second.kind === 'line' && parallel(delta(first.to, first.from), delta(second.to, second.from))) {
      const direction = unit(delta(first.to, first.from));
      if (direction === null) return null;
      const offset = delta(second.from, first.from);
      const along = dot(offset, direction);
      return Math.hypot(offset[0] - along * direction[0], offset[1] - along * direction[1], offset[2] - along * direction[2]);
    }
  }
  return null;
}

/** 文書を開く/再計算する際に1回呼び、得た結果を描画へ渡す。保存文書は書き換えない。 */
export function resolveDrawingDimensions(document: DrawingDocument, context: DimensionResolveContext): readonly ResolvedDrawingDimension[] {
  const cache = new Map<string, ResolvedDimensionTarget | null>();
  const analysis = analyzeParameters(document.parameters, []);
  const toleranceValue = (value: number | { readonly source: string }): number | null => {
    if (typeof value === 'number') return value;
    const evaluated = evaluateExpression(value.source, analysis);
    return evaluated.ok ? evaluated.value.value : null;
  };
  return document.dimensions.map((dimension): ResolvedDrawingDimension => {
    const unresolved = (reason: 'target' | 'measurement' | 'view', targets: readonly ResolvedDimensionTarget[] = []): ResolvedDrawingDimension => ({
      dimension, targets, value: null, coordinates: null, text: '？', status: 'unresolved', reason,
    });
    const view = document.views.find((item) => item.id === dimension.targets[0]?.viewId);
    if (view === undefined || dimension.targets.some((target) => target.viewId !== view.id)) return unresolved('view');
    const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
    if (basis === null) return unresolved('view');
    const targets: ResolvedDimensionTarget[] = [];
    for (const target of dimension.targets) {
      const key = JSON.stringify(target);
      if (!cache.has(key)) cache.set(key, resolveDimensionTarget(target, document, context));
      const current = cache.get(key);
      if (current == null) return unresolved('target', targets);
      targets.push(current);
    }
    if (dimension.measurement === 'coordinate') {
      const ends = measurementEnds(targets);
      if (ends === null) return unresolved('measurement', targets);
      const vector = delta(ends[1], ends[0]);
      const coordinates: Point2 = [dot(vector, basis.x), dot(vector, basis.y)];
      if (!coordinates.every(Number.isFinite)) return unresolved('measurement', targets);
      return { dimension, targets, value: null, coordinates, text: coordinates.map((value, index) =>
        `${index === 0 ? 'X' : 'Y'}: ${formatDimension({ value, kind: 'coordinate' })}`).join(' / '), status: 'resolved', reason: null };
    }
    const value = measure(dimension, targets, basis);
    if (value === null || !Number.isFinite(value)) return unresolved('measurement', targets);
    let displayTolerance: DimensionTolerance | undefined;
    if (dimension.fit !== undefined) {
      if (dimension.tolerance !== undefined || !['length', 'diameter'].includes(dimension.kind)) return unresolved('measurement', targets);
      const fit = fitTolerance(value, dimension.fit.symbol);
      if (fit === null) return unresolved('measurement', targets);
      if (dimension.fit.showDeviation) displayTolerance = { kind: 'deviation', ...fit };
    } else if (dimension.tolerance !== undefined) {
      if (dimension.tolerance.kind === 'symmetric') {
        const current = toleranceValue(dimension.tolerance.value);
        if (current === null) return unresolved('measurement', targets);
        displayTolerance = { kind: 'symmetric', value: current };
      } else {
        const upper = toleranceValue(dimension.tolerance.upper), lower = toleranceValue(dimension.tolerance.lower);
        if (upper === null || lower === null) return unresolved('measurement', targets);
        displayTolerance = { kind: 'deviation', upper, lower };
      }
      if (resolveDimensionTolerance(displayTolerance) === null) return unresolved('measurement', targets);
    }
    const text = formatDimension({ value, kind: dimension.kind, prefix: dimension.prefix,
      suffix: `${dimension.fit?.symbol ?? ''}${dimension.suffix ?? ''}`, decimals: dimension.fit === undefined ? undefined : 4,
      tolerance: displayTolerance, reference: dimension.reference });
    return { dimension, targets, value, coordinates: null, text, status: 'resolved', reason: null,
      ...(displayTolerance === undefined ? {} : { displayTolerance }) };
  });
}
