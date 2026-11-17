/** Resolve an entry from current geometry, never from the saved face fingerprint. */
import { withinMagnitude } from '../../numericTolerance.js';
import type { HoleFeature, ThreadHoleFeature } from '../../part/types.js';
import { addVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import type { AssemblyComponent } from '../types.js';
import type { FasteningGeometryContext } from './bindHoleSelection.js';
import type { FasteningHoleEntry } from './holeEntryTypes.js';
import { FASTENING_DIRECTION_TOLERANCE, FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointRejection } from './types.js';

interface EntryCylinder {
  readonly radius: number;
  readonly axis: Vec3;
  readonly center: Vec3;
  readonly length: number;
}

type EntryDimensions = Omit<Extract<FasteningHoleEntry, { readonly kind: 'counterbore' }>, 'side'>
  | Omit<Extract<FasteningHoleEntry, { readonly kind: 'countersink' }>, 'side'>;

function dimensions(feature: HoleFeature | ThreadHoleFeature, drill: number): EntryDimensions | null {
  const entry = feature.entry;
  if (entry === undefined || entry.kind === 'plain') return null;
  const diameter = entry.diameter.value;
  if (!Number.isFinite(diameter) || diameter <= drill) return null;
  if (entry.kind === 'counterbore') {
    return Number.isFinite(entry.depth.value) && entry.depth.value > 0
      ? { kind: 'counterbore', diameter, depth: entry.depth.value } : null;
  }
  const angle = entry.angle.value;
  if (!Number.isFinite(angle) || angle <= 0 || angle >= 180) return null;
  const depth = (diameter - drill) / (2 * Math.tan(angle * Math.PI / 360));
  return Number.isFinite(depth) && depth > 0 ? { kind: 'countersink', diameter, angle, depth } : null;
}

function entryPlane(context: FasteningGeometryContext, component: AssemblyComponent,
  feature: HoleFeature | ThreadHoleFeature, bodyId: string) {
  const direct = context.resolveFace(component, feature.face);
  const consumed = direct.status === 'missing' && direct.reason === 'body-missing';
  const current = consumed && feature.face.origin !== undefined && feature.face.bodyFeatureId !== bodyId
    ? context.resolveFace(component, { ...feature.face, bodyFeatureId: bodyId }) : direct;
  if (current.status !== 'matched' || current.geometry.kind !== 'face' || current.geometry.surfaceKind !== 'plane') return null;
  const { position, axis } = current.geometry;
  if (axis === null || !position.every(Number.isFinite) || !axis.every(Number.isFinite)) return null;
  const size = lengthVec3(axis);
  return size > FASTENING_LENGTH_TOLERANCE_MM ? { point: position, normal: scaleVec3(axis, 1 / size) } : null;
}

/** Extend the certified bore band only when its end is exactly the entry depth from the resolved entry plane. */
export function bindHoleEntry(context: FasteningGeometryContext, component: AssemblyComponent,
  feature: HoleFeature | ThreadHoleFeature, bodyId: string, cylinder: EntryCylinder,
  mating: { readonly point: Vec3; readonly normal: Vec3 }):
  { readonly cylinder: EntryCylinder; readonly entry?: FasteningHoleEntry } | BoltedJointRejection {
  if (feature.entry === undefined || feature.entry.kind === 'plain') return { cylinder };
  const detail = { componentId: component.id, holeFeatureId: feature.id };
  const dims = dimensions(feature, cylinder.radius * 2);
  if (dims === null) return { code: 'invalidDimension', detail: { ...detail, name: 'holeEntry' } };
  const plane = entryPlane(context, component, feature, bodyId);
  if (plane === null) return { code: 'threadEntryUnknown', detail: { ...detail, reason: 'entryPlaneMissing' } };
  const parallel = dotVec3(plane.normal, cylinder.axis);
  if (!withinMagnitude(parallel * parallel - 1, FASTENING_DIRECTION_TOLERANCE)) {
    return { code: 'faceAxisMismatch', detail };
  }
  const offset = dotVec3(subVec3(plane.point, cylinder.center), cylinder.axis);
  const extent = cylinder.length / 2 + dims.depth;
  const side = withinMagnitude(offset - extent, FASTENING_LENGTH_TOLERANCE_MM) ? 1
    : withinMagnitude(offset + extent, FASTENING_LENGTH_TOLERANCE_MM) ? -1 : null;
  if (side === null) return { code: 'holeFaceMismatch', detail: { ...detail, reason: 'entryDepthMismatch' } };
  const center = addVec3(cylinder.center, scaleVec3(cylinder.axis, side * dims.depth / 2));
  const length = cylinder.length + dims.depth;
  if (!Number.isFinite(length) || !center.every(Number.isFinite)) return { code: 'invalidDimension', detail };
  const samePlane = withinMagnitude(dotVec3(subVec3(plane.point, mating.point), mating.normal), FASTENING_LENGTH_TOLERANCE_MM);
  return { cylinder: { ...cylinder, center, length }, entry: { ...dims, side: samePlane ? 'mating' : 'outer' } };
}
