export {
  createKernelBridge,
  type KernelBridge,
  type SketchFaceFailure,
  type SketchTessellationOutcome,
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
  SketchPointFeature,
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
export type {
  BooleanFeature, BooleanOperation, ExtrudeFeature, PartDocument, RevolveAxis, RevolveFeature,
  SewFeature, SketchFaceRef, SketchLineRef, SolidFeature, SolidFeatureKind,
} from './part/types.js';
export type { SolidLabelKey } from './part/createPartDocument.js';
export {
  addSketch, appendSolid, consumedBodyIds, createEmptyPartDocument, DEFAULT_SEW_TOLERANCE_MM,
  findSketch, findSolid, liveBodyIds, nextSolidId, nextSolidName, PART_SCHEMA_VERSION,
  removeSolid, replaceSketch, replaceSolid, setActiveSketch, SOLID_LABELS,
} from './part/createPartDocument.js';
export type { PushUndoOptions, UndoStack } from './history/undoStack.js';
export {
  canRedo, canUndo, createUndoStack, pushUndo, redo, undo, UNDO_COALESCE_MS, UNDO_LIMIT,
} from './history/undoStack.js';
