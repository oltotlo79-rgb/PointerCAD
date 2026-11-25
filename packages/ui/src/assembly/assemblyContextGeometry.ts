import { addVec3, applyPlacementToDirection, applyPlacementToPoint, findComponent,
  relativePlacement, resolveSubShapeReference, type ContextPlanePoints, type MateSubShapeGeometry, type SubShapeRef,
} from '@pointercad/model';
import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import type { AppState } from '../store/appState.js';
import { assemblyBackgroundLibrary, assemblyCalculation } from '../store/partEditActions.js';
import type { AssemblyMateFaceHit } from '../viewport/createAssemblyLayer.js';

/** Only the solved placements paired with these exact source bodies may be used together. */
export function currentAssemblyContext(state: AppState) {
  const { assembly, assemblyView: view } = state;
  const calculation = assemblyCalculation(state);
  if (assembly === null || view === null || view.sourceDocument !== assembly
    || view.source?.library !== assemblyBackgroundLibrary(state) || calculation.isComputing || calculation.recomputeCancelled
    || calculation.lastOutcome !== 'success' || calculation.requestedGeneration !== calculation.completedGeneration
    || view.diagnosis?.converged === false || view.meshOwnership?.publicationCurrent() === false
    || state.assemblyDrag !== null || state.assemblyMotionPlaying || state.assemblyMotionPlacements !== null
    || state.assemblyExplodeDraft !== null) return null;
  return view;
}

export function contextSource(state: AppState, targetId: string, sourceId: string, bodyFeatureId: string) {
  const view = currentAssemblyContext(state), document = state.assembly;
  if (view === null || document === null || targetId === sourceId) return null;
  const target = findComponent(document, targetId), source = findComponent(document, sourceId);
  if (target?.source.kind !== 'part' || source?.source.kind !== 'part'
    || target.suppressed || source.suppressed || !source.visible || target.source.partRef === source.source.partRef) return null;
  const partKey = view.resolved.partKeys.get(sourceId);
  if (partKey === undefined || partKey !== source.source.partRef) return null;
  const part = assemblyBackgroundLibrary(state).parts.get(partKey);
  const targetPose = view.resolved.placements.get(targetId), sourcePose = view.resolved.placements.get(sourceId);
  const bodies = view.bodies.get(partKey) ?? [];
  const [body, duplicate] = bodies.filter(candidate => candidate.featureId === bodyFeatureId);
  if (part === undefined || targetPose === undefined || sourcePose === undefined || body === undefined
    || duplicate !== undefined || !body.isValid) return null;
  return { body, bodies, view, partKey, partId: part.id, pose: relativePlacement(targetPose, sourcePose),
    inversePose: relativePlacement(sourcePose, targetPose) };
}

type PickedContextFace = NonNullable<ReturnType<typeof contextSource>> & {
  readonly reference: SubShapeRef;
  readonly geometry: Extract<MateSubShapeGeometry, { kind: 'face' }>;
};

/** The hit index is scoped to this render; it is never the persisted identity. */
export function pickedContextFace(state: AppState, targetId: string, hit: AssemblyMateFaceHit): PickedContextFace | null {
  if (hit.occurrencePath !== undefined && hit.occurrencePath.length !== 1) return null;
  const source = contextSource(state, targetId, hit.componentId, hit.bodyFeatureId);
  if (source === null || source.partKey !== hit.partKey) return null;
  const reference = subShapeRefOf(source.bodies, subShapeElementId(hit.bodyFeatureId, 'face', hit.faceIndex));
  if (reference === null || reference.fingerprint.kind !== 'face') return null;
  const resolved = resolveSubShapeReference(source.body, reference);
  return resolved.status === 'matched' && resolved.match.reference.index === hit.faceIndex && resolved.match.geometry.kind === 'face'
    ? { ...source, reference, geometry: resolved.match.geometry } : null;
}

export function contextPlanePoints(
  source: NonNullable<ReturnType<typeof contextSource>>, reference: SubShapeRef, requireOrigin: boolean,
): ContextPlanePoints | null {
  if (requireOrigin && reference.origin?.shapeKind !== 'face') return null;
  const resolved = resolveSubShapeReference(source.body, reference);
  if (resolved.status !== 'matched') return null;
  const geometry = resolved.match.geometry;
  if (geometry.kind !== 'face' || geometry.surfaceKind !== 'plane' || geometry.planarBasis === undefined) return null;
  const { origin, xAxis, yAxis } = geometry.planarBasis;
  const point = applyPlacementToPoint(source.pose, origin);
  const points: ContextPlanePoints = [point, addVec3(point, applyPlacementToDirection(source.pose, xAxis)),
    addVec3(point, applyPlacementToDirection(source.pose, yAxis))];
  return points.every(position => position.every(Number.isFinite)) ? points : null;
}
