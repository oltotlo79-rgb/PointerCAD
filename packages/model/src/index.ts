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
  type SketchOffsetContour,
  type SketchOffsetEntry,
  type SketchOffsetFailure,
  type SketchOffsetRequestItem,
  type SketchOffsetResult,
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
  lerpVec3, normalizeVec3, ORIGIN, rotateAboutAxis, rotateDirection, scaleVec3,
  SKETCH_TOLERANCE_MM, subVec3,
} from './sketch/vec3.js';
export type { BaseWorkPlaneId, WorkPlane, WorkPlaneId } from './sketch/planeMath.js';
export {
  baseWorkPlane, DEFAULT_WORK_PLANE_ID, degreesToRadians, directionInPlane, distanceToPlane,
  FREE_WORK_PLANE_ID, isBaseWorkPlaneId, isFreeWorkPlaneId, planeAxesFor, planeToWorld,
  polarOffset, projectOntoPlane, radiansToDegrees, tiltedDirection, WORK_PLANE_IDS, WORK_PLANES,
  WORLD_AXIS_DIRECTIONS, worldToPlane,
} from './sketch/planeMath.js';
export type {
  AxisFrame, AxisSpec, PlaneErrorKey, PlaneOutcome, PlaneResolveContext, PlaneSpec,
  ResolvedPlane, ResolvedSubShape,
} from './geometry/planeSpec.js';
export {
  planeFromNormal, planeSpecKeyText, resolvePlaneSpec, subShapeFromFingerprint,
} from './geometry/planeSpec.js';
export type {
  CoordinateInput, FreeArcOrientation, OffsetContourShape, OffsetCornerKind, OffsetSide,
  PendingOffset, PointArrayLayout, PointReference, ResolvedArc,
  ResolvedCurve, ResolvedEllipse,
  ResolvedFace, ResolvedPoint, ResolvedSegment, ResolvedSketch, ResolvedSpline, SketchArcFeature,
  SketchDocument, SketchElementRef, SketchEllipseFeature, SketchError, SketchErrorCode,
  SketchFaceFeature, SketchFaceMesh, SketchFeature, SketchFeatureKind, SketchLineFeature,
  SketchMesh, SketchOffsetFeature, SketchPointArrayFeature, SketchPointFeature,
  SketchPolygonFeature,
  SketchRectangleFeature, SketchSlotFeature, SketchSplineFeature,
} from './sketch/types.js';
export {
  absoluteCoordinate, appendFeature, createEmptySketchDocument, createPointFeature,
  DEFAULT_FACE_COLOR, findFeature, nextFeatureId, nextFeatureName, removeFeature, replaceFeature,
} from './sketch/createSketchDocument.js';
export type { ResolveContext, ResolveOutcome } from './sketch/resolveCoordinate.js';
export {
  resolveCoordinate, resolvePointReference, vertexKey,
} from './sketch/resolveCoordinate.js';
export type { SketchResolveOptions } from './sketch/resolveSketch.js';
export {
  arcPointAt, azimuthToEllipseParameter, curveEnd, curveStart, ellipsePointAt, fitPlaneNormal,
  isFullCircle, isFullEllipse, isPlanar, MAX_POINT_ARRAY_COUNT, resolveSketch,
} from './sketch/resolveSketch.js';
export type {
  CurveChain, CurveChainOptions, CurveChainOutcome, CurveEvaluator, CurveIntersection,
} from './sketch/intersectionMath.js';
export {
  curveEvaluator, curveIntersections, curveParameterNear, curvePointAt, FULL_TURN,
  INTERSECTION_TOLERANCE_MM, isClosedCurve, segmentSegmentIntersection, traceCurveChain,
} from './sketch/intersectionMath.js';
export type { ExtendRequest, TrimErrorKey, TrimOutcome, TrimRequest } from './sketch/trimExtend.js';
export {
  explodeCompoundFeature, extendCurve, nearestCurveEnd, parseElementId, trimCurve,
} from './sketch/trimExtend.js';
export type { SplineCurveData } from './sketch/splineMath.js';
export {
  hasDuplicateSplinePoint, MAX_SPLINE_POINTS, MIN_CLOSED_SPLINE_POINTS, MIN_SPLINE_POINTS,
  sampleSpline, sampleSplineCurve, splineCurveData, splineDegree, splinePointAt,
  SPLINE_SEGMENTS_PER_SPAN,
} from './sketch/splineMath.js';
export type { SketchRecomputeOptions, SketchRecomputeResult } from './sketch/recomputeSketch.js';
export { recomputeSketch, reevaluateDocument } from './sketch/recomputeSketch.js';
export type { OffsetCache, OffsetKeyMaterial } from './sketch/offsetMath.js';
export {
  closedOffsetDistance, createOffsetCache, offsetCacheKey, offsetDisplacement, offsetSideOf,
  OFFSET_CACHE_CAPACITY,
} from './sketch/offsetMath.js';
export type { MetricThreadSize, ThreadSeries } from './thread/metricThread.js';
export {
  DEFAULT_THREAD_DESIGNATION, findMetricThread, METRIC_THREAD_DESIGNATIONS, METRIC_THREADS,
  metricThreadPitch, threadMinorDiameter, threadPitchDiameter, threadTriangleHeight,
} from './thread/metricThread.js';
export type {
  BooleanFeature, BooleanOperation, ChamferFeature, ChamferSize, ExtrudeFeature,
  FilletFeature, HoleDepth, HoleFeature, PartDocument, PatternDirection,
  PatternFeature, PatternPlacement, ReferenceAxisDefinition, ReferenceAxisFeature,
  ReferenceCoordinateSystemFeature, ReferenceFeature, ReferenceFeatureKind,
  ReferencePlaneFeature, ReferencePointDefinition, ReferencePointFeature,
  RevolveAxis, RevolveFeature, SewFeature, SketchFaceRef,
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
  addSketch, appendReference, appendSolid, consumedBodyIds, consumedTargetsOf,
  createEmptyPartDocument,
  DEFAULT_CHAMFER_ANGLE_DEGREES, DEFAULT_CHAMFER_DISTANCE_MM, DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM, DEFAULT_HOLE_DEPTH_MM, DEFAULT_HOLE_DIAMETER_MM, DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM, DEFAULT_SEW_TOLERANCE_MM, DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM, DEFAULT_SPRING_TURNS, DEFAULT_SPRING_WIRE_DIAMETER_MM, findReference,
  findSketch,
  findSolid, isMachiningFeature, isPatternSource, liveBodyIds, MAX_PATTERN_COUNT, MAX_SPRING_TURNS,
  nextReferenceId, nextReferenceName, nextSolidId, nextSolidName, PART_SCHEMA_VERSION,
  REFERENCE_LABELS, removeReference, removeSolid, replaceReference, replaceSketch, replaceSolid,
  setActiveSketch, SOLID_LABELS,
} from './part/createPartDocument.js';
export type {
  ReferenceError, ReferenceErrorCode, ReferenceResolveDeps, ReferenceResolver,
  ResolvedReferenceAxis, ResolvedReferenceCoordinateSystem, ResolvedReferencePlane,
  ResolvedReferencePoint, ResolvedReferences,
} from './part/resolveReferences.js';
export {
  createReferenceResolver, workPlaneFromResolved,
} from './part/resolveReferences.js';
export type {
  BooleanKeyMaterial, ChamferKeyMaterial, ExtrudeKeyMaterial, FilletKeyMaterial, HoleKeyMaterial,
  KeyArc, KeyCurve, KeyEllipse, KeySegment, KeySpline, KeySubShape, KeyTransform, KeyVec3,
  RevolveKeyMaterial, SewKeyMaterial, SolidStepKeyMaterial, SpringKeyMaterial, ThreadKeyMaterial,
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
