export {
  createKernelBridge,
  createKernelHealth,
  KERNEL_BROKEN_MESSAGE,
  type KernelBridge,
  type KernelHealth,
  type PartCancelToken,
  type PartProgress,
  type PartProgressCallback,
  type SketchFaceFailure,
  type SketchTessellationOutcome,
  type SolidBody,
  type SolidBodyFailure,
  type SolidBodyMeshData,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SolidRecomputeOptions,
  type SolidRecomputeOutcome,
  type SolidVertexEntry,
  type ThreadMarkEntry,
} from './kernelBridge.js';
export type { Vec3 } from './sketch/vec3.js';
export {
  addVec3, crossVec3, distanceVec3, dotVec3, isSamePoint, lengthVec3,
  lerpVec3, normalizeVec3, ORIGIN, scaleVec3, SKETCH_TOLERANCE_MM, subVec3,
} from './sketch/vec3.js';
export type { WorkPlane, WorkPlaneId } from './sketch/planeMath.js';
export {
  DEFAULT_WORK_PLANE_ID, degreesToRadians, directionInPlane, distanceToPlane,
  planeToWorld, polarOffset, projectOntoPlane, radiansToDegrees,
  WORK_PLANE_IDS, WORK_PLANES, worldToPlane,
} from './sketch/planeMath.js';
export type {
  CoordinateInput, PointReference, ResolvedArc, ResolvedCurve, ResolvedFace,
  ResolvedPoint, ResolvedSegment, ResolvedSketch, SketchArcFeature, SketchDocument,
  SketchElementRef, SketchError, SketchErrorCode, SketchFaceFeature, SketchFaceMesh,
  SketchFeature, SketchFeatureKind, SketchLineFeature, SketchMesh, SketchPointArrayFeature,
  SketchPointFeature, SketchPolygonFeature, SketchRectangleFeature, SketchSlotFeature,
} from './sketch/types.js';
export {
  absoluteCoordinate, appendFeature, createEmptySketchDocument, createPointFeature,
  DEFAULT_FACE_COLOR, findFeature, nextFeatureId, nextFeatureName, removeFeature, replaceFeature,
} from './sketch/createSketchDocument.js';
export type { ResolveContext, ResolveOutcome } from './sketch/resolveCoordinate.js';
export {
  resolveCoordinate, resolvePointReference, vertexKey,
} from './sketch/resolveCoordinate.js';
export {
  arcPointAt, curveEnd, curveStart, fitPlaneNormal, isFullCircle, isPlanar,
  MAX_POINT_ARRAY_COUNT, resolveSketch,
} from './sketch/resolveSketch.js';
export type { SketchRecomputeResult } from './sketch/recomputeSketch.js';
export { recomputeSketch, reevaluateDocument } from './sketch/recomputeSketch.js';
export type { MetricThreadSize, ThreadSeries } from './thread/metricThread.js';
export {
  DEFAULT_THREAD_DESIGNATION, findMetricThread, METRIC_THREAD_DESIGNATIONS, METRIC_THREADS,
  metricThreadPitch, threadMinorDiameter, threadPitchDiameter, threadTriangleHeight,
} from './thread/metricThread.js';
export type {
  BooleanFeature, BooleanOperation, ChamferFeature, ChamferSize, ExtrudeFeature,
  FilletFeature, HoleDepth, HoleFeature, PartDocument, PatternDirection,
  PatternFeature, PatternPlacement, RevolveAxis, RevolveFeature, SewFeature, SketchFaceRef,
  SketchLineRef, SketchPointRef, SolidFeature, SolidFeatureKind, SpringDerived, SpringFeature,
  SpringHandedness, ThreadHoleFeature,
  ThreadRepresentation,
} from './part/types.js';
export type {
  EdgeCurveKind, FaceSurfaceKind, SubShapeFingerprint, SubShapeKind, SubShapeRef,
} from './geometry/subShapeRef.js';
export {
  dedupeSubShapeRefs, fingerprintKeyText, isSameSubShape, subShapeKindOf,
} from './geometry/subShapeRef.js';
export type { SolidLabelKey } from './part/createPartDocument.js';
export {
  addSketch, appendSolid, consumedBodyIds, consumedTargetsOf, createEmptyPartDocument,
  DEFAULT_CHAMFER_ANGLE_DEGREES, DEFAULT_CHAMFER_DISTANCE_MM, DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM, DEFAULT_HOLE_DEPTH_MM, DEFAULT_HOLE_DIAMETER_MM, DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM, DEFAULT_SEW_TOLERANCE_MM, DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM, DEFAULT_SPRING_TURNS, DEFAULT_SPRING_WIRE_DIAMETER_MM, findSketch,
  findSolid, isMachiningFeature, isPatternSource, liveBodyIds, MAX_PATTERN_COUNT, MAX_SPRING_TURNS,
  nextSolidId, nextSolidName, PART_SCHEMA_VERSION, removeSolid, replaceSketch, replaceSolid,
  setActiveSketch, SOLID_LABELS,
} from './part/createPartDocument.js';
export type {
  BooleanKeyMaterial, ChamferKeyMaterial, ExtrudeKeyMaterial, FilletKeyMaterial, HoleKeyMaterial,
  KeyArc, KeyCurve, KeySegment, KeySubShape, KeyTransform, KeyVec3, RevolveKeyMaterial,
  SewKeyMaterial, SolidStepKeyMaterial, SpringKeyMaterial, ThreadKeyMaterial,
} from './part/cacheKey.js';
export { cacheKeyFor, hash64, KEY_DECIMALS } from './part/cacheKey.js';
export type {
  HoleCentersOutcome, MachiningTargetOutcome, PartError, PartErrorCode, ResolvedPart,
  ResolvedPartSketch, ResolvedSolidStep, RevolveAxisFrame, RigidTransform, SolidStepPlan,
  SubShapeQueryPlan,
} from './part/resolvePart.js';
export {
  resolveHoleCenters, resolveMachiningTarget, resolvePart, resolvePatternTransforms,
  resolveRevolveAxis, resolveSpringLength, resolveSpringOrigin, resolveTiltedDirection,
  translateCurve,
} from './part/resolvePart.js';
export type {
  PartRecomputeError, PartRecomputeOptions, PartRecomputeResult, PartSketchResult,
} from './part/recomputePart.js';
export { recomputePart } from './part/recomputePart.js';
export type { PushUndoOptions, UndoStack } from './history/undoStack.js';
export {
  canRedo, canUndo, createUndoStack, pushUndo, redo, undo, UNDO_COALESCE_MS, UNDO_LIMIT,
} from './history/undoStack.js';
