export type { BoxParameters, MeshData, TessellationOptions } from './types.js';
export type { ArcSpec, CurveSpec, SegmentSpec, Vec3Tuple } from './types.js';
export type {
  FaceMeshData,
  PlanarFaceRequest,
  SketchTessellation,
  SketchTessellationFailure,
  SketchTessellationRequest,
} from './types.js';
// ソリッド(立体)の依頼と結果(FR-401〜404)。Comlink 越しに渡せる素の値だけで書いてある。
export type {
  BooleanOperation,
  BooleanStepSpec,
  ExtrudeStepSpec,
  RevolveStepSpec,
  SewStepSpec,
  SolidBodyMesh,
  SolidProgress,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  SolidStepFailure,
  SolidStepRequest,
  SolidStepSpec,
} from './types.js';
export { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION } from './types.js';
export { makeBox, type OcctShapeHandle } from './occt/makeBox.js';
export { makePlanarFace, type OcctFaceHandle } from './occt/makePlanarFace.js';
export {
  discretizeEdge,
  makeArcEdge,
  makeCurveEdge,
  makeSegmentEdge,
  type OcctEdgeHandle,
} from './occt/makeSketchEdges.js';
export { tessellate, type SurfaceMesh } from './occt/tessellate.js';
export { extractEdges, type EdgeLines } from './occt/extractEdges.js';
export {
  buildSolidBodyMesh,
  hasSolid,
  isValidShape,
  measureVolume,
} from './occt/solidMesh.js';
export { makeExtrudeSolid, makeRevolveSolid } from './occt/makeSolidSweep.js';
export { sewSolid } from './occt/sewSolid.js';
export { booleanOp } from './occt/booleanOp.js';
export {
  createShapeCache,
  SHAPE_CACHE_CAPACITY,
  type ShapeCache,
  type ShapeCacheEntry,
  type ShapeCacheStats,
} from './worker/shapeCache.js';
export {
  recomputeSolids,
  type CachedSolid,
  type SolidCancelToken,
  type SolidProgressCallback,
  type SolidRecomputeDeps,
} from './worker/recomputeSolids.js';
export { createKernelApi, type KernelApi } from './worker/kernelApi.js';
export { createKernelWorker } from './client/createKernelWorker.js';
