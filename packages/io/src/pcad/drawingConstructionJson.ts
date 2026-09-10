import type { DimensionTarget, DrawingPlaneDefinition, DrawingViewConstruction, DrawingClipDefinition } from '@pointercad/model';
import { isRecord, isUnknownArray } from './guards.js';

type CleanTarget = (target: DimensionTarget) => DimensionTarget;
type CheckTarget = (value: unknown) => boolean;
const cleanExpression = (value: { readonly source: string; readonly value: number; readonly display: string }) =>
  ({ source: value.source, value: value.value, display: value.display });

function cleanPlane(plane: DrawingPlaneDefinition, target: CleanTarget): DrawingPlaneDefinition {
  switch (plane.kind) {
    case 'workPlane': return { kind: plane.kind, planeId: plane.planeId, offset: cleanExpression(plane.offset) };
    case 'face': return { kind: plane.kind, target: target(plane.target), offset: cleanExpression(plane.offset) };
    case 'threePoints': return { kind: plane.kind, points: [target(plane.points[0]), target(plane.points[1]), target(plane.points[2])] };
    case 'viewLine': return { kind: plane.kind, sourceViewId: plane.sourceViewId, from: [...plane.from], to: [...plane.to] };
  }
}
function cleanRegion(region: DrawingClipDefinition): DrawingClipDefinition {
  return region.kind === 'circle' ? { kind: region.kind, center: [...region.center], radius: cleanExpression(region.radius) }
    : { kind: region.kind, points: region.points.map((point) => [...point]) };
}

/** 解決済みの平面や投影線を保存せず、作成時の式・参照だけを保存する。 */
export function cleanDrawingConstruction(value: DrawingViewConstruction, target: CleanTarget): DrawingViewConstruction {
  switch (value.kind) {
    case 'section': return { kind: value.kind, plane: cleanPlane(value.plane, target), mode: value.mode, keepSide: value.keepSide,
      label: value.label, reversed: value.reversed, ...(value.boundary === undefined ? {} : { boundary: value.boundary.map((point) => [...point]) }) };
    case 'detail': return { kind: value.kind, sourceViewId: value.sourceViewId, center: [...value.center], radius: cleanExpression(value.radius),
      scale: cleanExpression(value.scale), label: value.label };
    case 'auxiliary': return { kind: value.kind, sourceViewId: value.sourceViewId, plane: cleanPlane(value.plane, target) };
    case 'partial': return { kind: value.kind, sourceViewId: value.sourceViewId, region: cleanRegion(value.region) };
    case 'broken': return { kind: value.kind, sourceViewId: value.sourceViewId, axis: value.axis,
      from: cleanExpression(value.from), to: cleanExpression(value.to), gap: cleanExpression(value.gap) };
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const point2 = (value: unknown): boolean => isUnknownArray(value) && value.length === 2
  && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
const points = (value: unknown, minimum: number): boolean => isUnknownArray(value) && value.length >= minimum && value.every(point2);
const expression = (value: unknown): boolean => isRecord(value) && text(value['source']) && typeof value['display'] === 'string'
  && typeof value['value'] === 'number' && Number.isFinite(value['value']);

function plane(value: unknown, target: CheckTarget): boolean {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'workPlane': return ['xy', 'xz', 'yz'].some((id) => id === value['planeId']) && expression(value['offset']);
    case 'face': return target(value['target']) && expression(value['offset']);
    case 'threePoints': return isUnknownArray(value['points']) && value['points'].length === 3 && value['points'].every(target);
    case 'viewLine': return text(value['sourceViewId']) && point2(value['from']) && point2(value['to']);
    default: return false;
  }
}
function region(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value['kind'] === 'circle' ? point2(value['center']) && expression(value['radius'])
    : value['kind'] === 'polygon' && points(value['points'], 3);
}

/** 外部ファイルの構造を検査。参照解決や式の意味は再評価時に検査する。 */
export function isDrawingConstruction(value: unknown, target: CheckTarget): value is DrawingViewConstruction {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'section') {
    const mode = value['mode'];
    return ['full', 'half', 'local', 'revolved', 'stepped'].some((kind) => kind === mode) && plane(value['plane'], target)
      && (value['keepSide'] === 'positive' || value['keepSide'] === 'negative') && text(value['label']) && typeof value['reversed'] === 'boolean'
      && (value['boundary'] === undefined ? mode === 'full' || mode === 'revolved'
        : points(value['boundary'], mode === 'local' ? 3 : 2) && (mode !== 'half' || isUnknownArray(value['boundary']) && value['boundary'].length === 2));
  }
  if (!text(value['sourceViewId'])) return false;
  switch (value['kind']) {
    case 'detail': return point2(value['center']) && expression(value['radius']) && expression(value['scale']) && text(value['label']);
    case 'auxiliary': return plane(value['plane'], target);
    case 'partial': return region(value['region']);
    case 'broken': return (value['axis'] === 'u' || value['axis'] === 'v') && expression(value['from']) && expression(value['to']) && expression(value['gap']);
    default: return false;
  }
}
