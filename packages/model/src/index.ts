export type {
  BoxFeature,
  Feature,
  PartDocument,
  PartMesh,
  RecomputeResult,
} from './types.js';
export { createBoxPartDocument, DEFAULT_BOX_SIZE } from './createBoxPartDocument.js';
export { createKernelBridge, type KernelBridge } from './kernelBridge.js';
export { recomputePart } from './recompute.js';
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
