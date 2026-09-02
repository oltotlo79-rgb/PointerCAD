export type { BoxParameters, MeshData, TessellationOptions } from './types.js';
export type { ArcSpec, CurveSpec, SegmentSpec, Vec3Tuple } from './types.js';
export { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION } from './types.js';
export { makeBox, type OcctShapeHandle } from './occt/makeBox.js';
export {
  discretizeEdge,
  makeArcEdge,
  makeCurveEdge,
  makeSegmentEdge,
  type OcctEdgeHandle,
} from './occt/makeSketchEdges.js';
export { tessellate, type SurfaceMesh } from './occt/tessellate.js';
export { extractEdges, type EdgeLines } from './occt/extractEdges.js';
export { createKernelApi, type KernelApi } from './worker/kernelApi.js';
export { createKernelWorker } from './client/createKernelWorker.js';
