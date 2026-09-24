/** Persist identities and measurement definitions, never an old geometry result. */
import type { MathGeometryBody, MathGeometryCurve, MathGeometryDefinition, MathGeometryFace, MathGeometryFrame,
  MathGeometryPoint, MathGeometryQuantity, MathGeometryShape } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, joinPath, readLiteral, readNumber, readString, type Checked } from '../guards.js';
import { readSubShapeRef } from './shapeReferences.js';

type Target = MathGeometryPoint | MathGeometryCurve | MathGeometryShape;
const identifier = (value: string): boolean => value.trim().length > 0
  && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

function readTarget(value: unknown, path: string): Checked<Target> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const kind = readLiteral(record.value, 'kind', path, ['sketch-point', 'sketch-curve', 'body', 'vertex', 'edge', 'face']);
  if (!kind.ok) return kind;
  if (kind.value === 'body' || kind.value === 'sketch-curve') {
    const featureId = readString(record.value, 'featureId', path);
    if (!featureId.ok) return featureId;
    if (!identifier(featureId.value)) return fieldProblem(joinPath(path, 'featureId'), 'type');
    if (kind.value === 'body') return { ok: true, value: { kind: 'body', featureId: featureId.value } };
    const sketchId = readString(record.value, 'sketchId', path);
    if (!sketchId.ok) return sketchId;
    return identifier(sketchId.value) ? { ok: true, value: { kind: 'sketch-curve', sketchId: sketchId.value, featureId: featureId.value } }
      : fieldProblem(joinPath(path, 'sketchId'), 'type');
  }
  if (kind.value === 'sketch-point') {
    const sketchId = readString(record.value, 'sketchId', path);
    if (!sketchId.ok) return sketchId;
    if (!identifier(sketchId.value)) return fieldProblem(joinPath(path, 'sketchId'), 'type');
    const location = joinPath(path, 'reference'), reference = checkRecord(record.value.reference, location);
    if (!reference.ok) return reference;
    const pointKind = readLiteral(reference.value, 'kind', location, ['point']);
    if (!pointKind.ok) return pointKind;
    const pointId = readString(reference.value, 'pointId', location);
    if (!pointId.ok) return pointId;
    return identifier(pointId.value) ? { ok: true, value: { kind: 'sketch-point', sketchId: sketchId.value,
      reference: { kind: 'point', pointId: pointId.value } } } : fieldProblem(joinPath(location, 'pointId'), 'type');
  }
  const location = joinPath(path, 'reference'), reference = readSubShapeRef(record.value.reference, location);
  if (!reference.ok) return reference;
  const { bodyFeatureId, index, fingerprint } = reference.value;
  if (!identifier(bodyFeatureId) || !Number.isSafeInteger(index) || index < 0 || fingerprint.kind !== kind.value) {
    return fieldProblem(location, 'type');
  }
  switch (fingerprint.kind) {
    case 'vertex': return { ok: true, value: { kind: 'vertex', reference: { bodyFeatureId, index, fingerprint } } };
    case 'edge':
      if (fingerprint.length < 0 || (fingerprint.radius !== null && fingerprint.radius < 0)) return fieldProblem(location, 'type');
      return { ok: true, value: { kind: 'edge', reference: { bodyFeatureId, index, fingerprint } } };
    case 'face':
      if (fingerprint.area < 0 || (fingerprint.radius !== null && fingerprint.radius < 0)) return fieldProblem(location, 'type');
      return { ok: true, value: { kind: 'face', reference: { bodyFeatureId, index, fingerprint } } };
  }
}

const isPoint = (target: Target): target is MathGeometryPoint => target.kind === 'sketch-point' || target.kind === 'vertex';
const isCurve = (target: Target): target is MathGeometryCurve => target.kind === 'sketch-curve' || target.kind === 'edge';
const isShape = (target: Target): target is MathGeometryShape => target.kind === 'body' || target.kind === 'face'
  || target.kind === 'edge' || target.kind === 'vertex';
const isArea = (target: Target): target is MathGeometryBody | MathGeometryFace => target.kind === 'body' || target.kind === 'face';
const isBody = (target: Target): target is MathGeometryBody => target.kind === 'body';
const isFace = (target: Target): target is MathGeometryFace => target.kind === 'face';
const isLineOrPlane = (target: Target): target is MathGeometryCurve | MathGeometryFace => isCurve(target) || isFace(target);
function target<T extends Target>(record: Record<string, unknown>, key: string, path: string,
  accept: (value: Target) => value is T): Checked<T> {
  const location = joinPath(path, key), result = readTarget(record[key], location);
  if (!result.ok) return result;
  return accept(result.value) ? { ok: true, value: result.value } : fieldProblem(location, 'type');
}

function readFrame(value: unknown, path: string): Checked<MathGeometryFrame> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const kind = readLiteral(record.value, 'kind', path, ['reference']);
  if (!kind.ok) return kind;
  const featureId = readString(record.value, 'featureId', path);
  if (!featureId.ok) return featureId;
  return identifier(featureId.value) ? { ok: true, value: { kind: 'reference', featureId: featureId.value } }
    : fieldProblem(joinPath(path, 'featureId'), 'type');
}

function readQuantity(value: unknown, path: string): Checked<MathGeometryQuantity> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const kind = readLiteral(record.value, 'kind', path, ['coordinate', 'point-distance', 'shape-distance', 'length',
    'area', 'volume', 'angle', 'plane-angle', 'line-plane-angle', 'point-angle', 'parallel', 'perpendicular',
    'radius', 'central-angle', 'contour-length', 'congruent', 'similar']);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case 'coordinate': {
      const point = target(record.value, 'point', path, isPoint);
      if (!point.ok) return point;
      const component = readLiteral(record.value, 'component', path, ['X', 'Y', 'Z']);
      if (!component.ok) return component;
      const coordinate = { kind: 'coordinate' as const, point: point.value, component: component.value };
      if (record.value.frame === undefined) return { ok: true, value: coordinate };
      const frame = readFrame(record.value.frame, joinPath(path, 'frame'));
      return frame.ok ? { ok: true, value: { ...coordinate, frame: frame.value } } : frame;
    }
    case 'point-distance': {
      const first = target(record.value, 'first', path, isPoint), second = target(record.value, 'second', path, isPoint);
      if (!first.ok) return first;
      return second.ok ? { ok: true, value: { kind: 'point-distance', first: first.value, second: second.value } } : second;
    }
    case 'shape-distance': {
      const first = target(record.value, 'first', path, isShape), second = target(record.value, 'second', path, isShape);
      if (!first.ok) return first;
      return second.ok ? { ok: true, value: { kind: 'shape-distance', first: first.value, second: second.value } } : second;
    }
    case 'length': case 'radius': {
      const curve = target(record.value, 'curve', path, isCurve);
      return curve.ok ? { ok: true, value: { kind: kind.value, curve: curve.value } } : curve;
    }
    case 'central-angle': {
      const curve = target(record.value, 'curve', path, isCurve);
      if (!curve.ok) return curve;
      const unit = readLiteral(record.value, 'unit', path, ['degree', 'radian']);
      return unit.ok ? { ok: true, value: { kind: 'central-angle', curve: curve.value, unit: unit.value } } : unit;
    }
    case 'contour-length': {
      const sketchId = readString(record.value, 'sketchId', path), featureId = readString(record.value, 'featureId', path);
      if (!sketchId.ok) return sketchId;
      if (!featureId.ok) return featureId;
      if (!identifier(sketchId.value)) return fieldProblem(joinPath(path, 'sketchId'), 'type');
      if (!identifier(featureId.value)) return fieldProblem(joinPath(path, 'featureId'), 'type');
      return { ok: true, value: { kind: 'contour-length', sketchId: sketchId.value, featureId: featureId.value } };
    }
    case 'area': {
      const shape = target(record.value, 'shape', path, isArea);
      return shape.ok ? { ok: true, value: { kind: 'area', shape: shape.value } } : shape;
    }
    case 'volume': {
      const body = target(record.value, 'body', path, isBody);
      return body.ok ? { ok: true, value: { kind: 'volume', body: body.value } } : body;
    }
    case 'parallel': case 'perpendicular': {
      const first = target(record.value, 'first', path, isLineOrPlane), second = target(record.value, 'second', path, isLineOrPlane);
      if (!first.ok) return first;
      return second.ok ? { ok: true, value: { kind: kind.value, first: first.value, second: second.value } } : second;
    }
    case 'congruent': case 'similar': {
      const first = target(record.value, 'first', path, isCurve), second = target(record.value, 'second', path, isCurve);
      if (!first.ok) return first;
      return second.ok ? { ok: true, value: { kind: kind.value, first: first.value, second: second.value } } : second;
    }
    case 'angle': {
      const first = target(record.value, 'first', path, isCurve), second = target(record.value, 'second', path, isCurve);
      if (!first.ok) return first;
      if (!second.ok) return second;
      const unit = readLiteral(record.value, 'unit', path, ['degree', 'radian']);
      return unit.ok ? { ok: true, value: { kind: 'angle', first: first.value, second: second.value, unit: unit.value } } : unit;
    }
    case 'plane-angle': {
      const first = target(record.value, 'first', path, isFace), second = target(record.value, 'second', path, isFace);
      if (!first.ok) return first;
      if (!second.ok) return second;
      const unit = readLiteral(record.value, 'unit', path, ['degree', 'radian']);
      return unit.ok ? { ok: true, value: { kind: 'plane-angle', first: first.value, second: second.value, unit: unit.value } } : unit;
    }
    case 'line-plane-angle': {
      const line = target(record.value, 'line', path, isCurve), plane = target(record.value, 'plane', path, isFace);
      if (!line.ok) return line;
      if (!plane.ok) return plane;
      const unit = readLiteral(record.value, 'unit', path, ['degree', 'radian']);
      return unit.ok ? { ok: true, value: { kind: 'line-plane-angle', line: line.value, plane: plane.value, unit: unit.value } } : unit;
    }
    case 'point-angle': {
      const first = target(record.value, 'first', path, isPoint), second = target(record.value, 'second', path, isPoint);
      const third = target(record.value, 'third', path, isPoint);
      if (!first.ok) return first;
      if (!second.ok) return second;
      if (!third.ok) return third;
      const unit = readLiteral(record.value, 'unit', path, ['degree', 'radian']);
      return unit.ok ? { ok: true, value: { kind: 'point-angle', first: first.value, second: second.value,
        third: third.value, unit: unit.value } } : unit;
    }
  }
}

/** Missing targets remain definitions that can be repaired, but malformed targets are never accepted. */
export function readMathGeometry(value: unknown, documentId: string, path: string): Checked<readonly MathGeometryDefinition[]> {
  if (!Array.isArray(value)) return fieldProblem(path, 'type');
  const result: MathGeometryDefinition[] = [], seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const location = indexPath(path, i), item: unknown = value[i], record = checkRecord(item, location);
    if (!record.ok) return record;
    const id = readString(record.value, 'id', location), name = readString(record.value, 'name', location);
    if (!id.ok) return id;
    if (!name.ok) return name;
    if (!identifier(id.value) || seen.has(id.value)) return fieldProblem(joinPath(location, 'id'), 'type');
    if (!identifier(name.value)) return fieldProblem(joinPath(location, 'name'), 'type');
    const owner = readString(record.value, 'documentId', location);
    if (!owner.ok) return owner;
    if (owner.value !== documentId) return fieldProblem(joinPath(location, 'documentId'), 'type');
    const quantity = readQuantity(record.value.quantity, joinPath(location, 'quantity'));
    if (!quantity.ok) return quantity;
    const tolerancePath = joinPath(location, 'tolerance'), tolerance = checkRecord(record.value.tolerance, tolerancePath);
    if (!tolerance.ok) return tolerance;
    const linear = readNumber(tolerance.value, 'linearMm', tolerancePath), angular = readNumber(tolerance.value, 'angularRadians', tolerancePath);
    if (!linear.ok) return linear;
    if (!angular.ok) return angular;
    if (linear.value <= 0) return fieldProblem(joinPath(tolerancePath, 'linearMm'), 'type');
    if (angular.value <= 0 || angular.value >= Math.PI / 4) return fieldProblem(joinPath(tolerancePath, 'angularRadians'), 'type');
    seen.add(id.value);
    result.push({ id: id.value, documentId, name: name.value, quantity: quantity.value,
      tolerance: { linearMm: linear.value, angularRadians: angular.value } });
  }
  return { ok: true, value: result };
}

export function serializeMathGeometry(value: readonly MathGeometryDefinition[], documentId: string): readonly MathGeometryDefinition[] {
  const result = readMathGeometry(value, documentId, 'mathGeometry');
  if (!result.ok) throw new RangeError('図形を測る定義の参照先・単位・許容差を確認してください。');
  return result.value;
}
