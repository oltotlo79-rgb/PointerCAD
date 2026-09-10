import type { DatumDefinition, DatumReference, DrawingElementStyle, DrawingSubShapeRef, GdtFeature, GdtFrameSegment,
  GdtShapeTarget, GdtToleranceValue, GeometricToleranceFrame, WeldSymbol } from '@pointercad/model';
import { isRecord, isUnknownArray } from './guards.js';

interface Checks { readonly target: (value: unknown) => boolean; readonly style: (value: unknown) => boolean }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length <= max;
const literal = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);
const point = (value: unknown): boolean => isUnknownArray(value) && value.length === 2 && value.every(finite);
const expression = (value: unknown): boolean => isRecord(value) && text(value['source'], 4096) && finite(value['value']) && text(value['display'], 4096);
const lengthValue = (value: unknown): boolean => isRecord(value) && expression(value['expression']) && literal(value['unit'], ['mm', 'inch']);
const common = (value: Record<string, unknown>, checks: Checks): boolean => text(value['id']) && point(value['position']) && finite(value['height'])
  && text(value['layerId']) && (value['style'] === undefined || checks.style(value['style']));
function shapeTarget(value: unknown, checks: Checks): boolean {
  return isRecord(value) && value['kind'] === 'subShape' && checks.target(value) && isRecord(value['ref'])
    && Number.isSafeInteger(value['ref']['index']) && typeof value['ref']['index'] === 'number' && value['ref']['index'] >= 0
    && isRecord(value['ref']['fingerprint']) && literal(value['ref']['fingerprint']['kind'], ['face', 'edge']);
}
function feature(value: unknown, checks: Checks): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'medianPlane') return isUnknownArray(value['targets']) && value['targets'].length === 2 && value['targets'].every((target) => shapeTarget(target, checks));
  return literal(value['kind'], ['surface', 'line', 'axis']) && shapeTarget(value['target'], checks);
}
const member = (value: unknown): boolean => isRecord(value) && text(value['datumId']) && literal(value['material'], ['none', 'maximum']);
function reference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value['kind'] === 'single' ? member(value['member']) : value['kind'] === 'common'
    && isUnknownArray(value['members']) && value['members'].length === 2 && value['members'].every(member);
}
function segment(value: unknown): boolean {
  return isRecord(value) && literal(value['characteristic'], ['straightness', 'flatness', 'roundness', 'cylindricity', 'lineProfile', 'surfaceProfile',
    'parallelism', 'perpendicularity', 'angularity', 'position', 'coaxiality', 'symmetry', 'circularRunout', 'totalRunout'])
    && literal(value['zone'], ['betweenLines', 'betweenPlanes', 'cylinder', 'sphere', 'concentricCircles', 'coaxialCylinders', 'lineProfile', 'surfaceProfile', 'radialRunout', 'axialRunout'])
    && literal(value['material'], ['none', 'maximum']) && lengthValue(value['tolerance'])
    && isUnknownArray(value['datums']) && value['datums'].length <= 3 && value['datums'].every(reference)
    && isUnknownArray(value['basicDimensionIds']) && value['basicDimensionIds'].length <= 100 && value['basicDimensionIds'].every((id) => text(id));
}
export function isDatumDefinition(value: unknown, checks: Checks): value is DatumDefinition {
  return isRecord(value) && common(value, checks) && text(value['label'], 80) && feature(value['feature'], checks)
    && (value['sizeDimensionId'] === undefined || text(value['sizeDimensionId']));
}
export function isGdtFrame(value: unknown, checks: Checks): value is GeometricToleranceFrame {
  return isRecord(value) && common(value, checks) && feature(value['feature'], checks)
    && (value['sizeDimensionId'] === undefined || text(value['sizeDimensionId']))
    && isUnknownArray(value['segments']) && value['segments'].length >= 1 && value['segments'].length <= 8 && value['segments'].every(segment);
}
function weldSide(value: unknown): boolean {
  if (!isRecord(value) || !literal(value['kind'], ['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'])
    || !literal(value['side'], ['arrow', 'opposite', 'center']) || !literal(value['contour'], ['none', 'flush', 'convex', 'concave'])
    || !literal(value['finish'], ['none', 'grind', 'machine', 'chip', 'polish'])) return false;
  if (value['size'] !== undefined && (!isRecord(value['size']) || !literal(value['size']['kind'], ['leg', 'throat', 'penetration', 'diameter', 'width'])
    || !lengthValue(value['size']['value']))) return false;
  return ['length', 'pitch', 'rootGap', 'grooveDepth'].every((key) => value[key] === undefined || lengthValue(value[key]))
    && ['count', 'grooveAngle'].every((key) => value[key] === undefined || expression(value[key]));
}
export function isWeldSymbol(value: unknown, checks: Checks): value is WeldSymbol {
  return isRecord(value) && common(value, checks) && value['system'] === 'B' && checks.target(value['target'])
    && isUnknownArray(value['sides']) && value['sides'].length >= 1 && value['sides'].length <= 2 && value['sides'].every(weldSide)
    && typeof value['allAround'] === 'boolean' && typeof value['fieldWeld'] === 'boolean' && text(value['tail'], 2000)
    && (value['closedTail'] === undefined || typeof value['closedTail'] === 'boolean')
    && (value['arrowBendOffset'] === undefined || point(value['arrowBendOffset']));
}

interface Cleaners {
  readonly ref: (value: DrawingSubShapeRef) => DrawingSubShapeRef;
  readonly style: (value: DrawingElementStyle | null | undefined) => DrawingElementStyle | null | undefined;
}
const cleanLength = (value: GdtToleranceValue): GdtToleranceValue => ({ unit: value.unit,
  expression: { source: value.expression.source, value: value.expression.value, display: value.expression.display } });
function cleanFeature(value: GdtFeature, cleaners: Cleaners): GdtFeature {
  const target = (value: GdtShapeTarget): GdtShapeTarget => ({ kind: 'subShape', viewId: value.viewId, sourceRef: value.sourceRef,
    ...(value.componentId === undefined ? {} : { componentId: value.componentId }), ref: cleaners.ref(value.ref) });
  return value.kind === 'medianPlane' ? { kind: 'medianPlane', targets: [target(value.targets[0]), target(value.targets[1])] }
    : { kind: value.kind, target: target(value.target) };
}
function cleanReference(value: DatumReference): DatumReference {
  return value.kind === 'single' ? { kind: 'single', member: { datumId: value.member.datumId, material: value.member.material } }
    : { kind: 'common', members: [{ datumId: value.members[0].datumId, material: value.members[0].material },
      { datumId: value.members[1].datumId, material: value.members[1].material }] };
}
function cleanSegment(value: GdtFrameSegment): GdtFrameSegment {
  return { characteristic: value.characteristic, zone: value.zone, material: value.material, tolerance: cleanLength(value.tolerance),
    datums: value.datums.map(cleanReference), basicDimensionIds: [...value.basicDimensionIds] };
}
export function cleanDatum(value: DatumDefinition, cleaners: Cleaners): DatumDefinition {
  return { id: value.id, label: value.label, feature: cleanFeature(value.feature, cleaners), position: [...value.position], height: value.height,
    ...(value.sizeDimensionId === undefined ? {} : { sizeDimensionId: value.sizeDimensionId }),
    layerId: value.layerId, ...(value.style === undefined ? {} : { style: cleaners.style(value.style) }) };
}
export function cleanGdtFrame(value: GeometricToleranceFrame, cleaners: Cleaners): GeometricToleranceFrame {
  return { id: value.id, feature: cleanFeature(value.feature, cleaners), segments: value.segments.map(cleanSegment), position: [...value.position],
    ...(value.sizeDimensionId === undefined ? {} : { sizeDimensionId: value.sizeDimensionId }),
    height: value.height, layerId: value.layerId, ...(value.style === undefined ? {} : { style: cleaners.style(value.style) }) };
}
export function cleanWeldSymbol(value: WeldSymbol, cleaners: Cleaners, cleanTarget: (target: WeldSymbol['target']) => WeldSymbol['target']): WeldSymbol {
  const expr = (value: NonNullable<WeldSymbol['sides'][number]['count']>) => ({ source: value.source, value: value.value, display: value.display });
  return { id: value.id, system: value.system, target: cleanTarget(value.target), sides: value.sides.map((side) => ({ kind: side.kind, side: side.side,
    contour: side.contour, finish: side.finish,
    ...(side.size === undefined ? {} : { size: { kind: side.size.kind, value: cleanLength(side.size.value) } }),
    ...(side.length === undefined ? {} : { length: cleanLength(side.length) }), ...(side.pitch === undefined ? {} : { pitch: cleanLength(side.pitch) }),
    ...(side.rootGap === undefined ? {} : { rootGap: cleanLength(side.rootGap) }), ...(side.count === undefined ? {} : { count: expr(side.count) }),
    ...(side.grooveDepth === undefined ? {} : { grooveDepth: cleanLength(side.grooveDepth) }),
    ...(side.grooveAngle === undefined ? {} : { grooveAngle: expr(side.grooveAngle) }),
  })), allAround: value.allAround, fieldWeld: value.fieldWeld, tail: value.tail, position: [...value.position], height: value.height, layerId: value.layerId,
  ...(value.closedTail === undefined ? {} : { closedTail: value.closedTail }),
  ...(value.arrowBendOffset === undefined ? {} : { arrowBendOffset: [...value.arrowBendOffset] }),
  ...(value.style === undefined ? {} : { style: cleaners.style(value.style) }) };
}
