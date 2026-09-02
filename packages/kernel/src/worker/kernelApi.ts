import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { extractEdges } from '../occt/extractEdges.js';
import { makeBox } from '../occt/makeBox.js';
import { makePlanarFace } from '../occt/makePlanarFace.js';
import { discretizeEdge, makeCurveEdge } from '../occt/makeSketchEdges.js';
import { tessellate } from '../occt/tessellate.js';
import type {
  BoxParameters,
  FaceMeshData,
  MeshData,
  SketchTessellation,
  SketchTessellationFailure,
  SketchTessellationRequest,
  TessellationOptions,
} from '../types.js';

/** UI 側から Comlink 越しに呼べる幾何カーネルの窓口。 */
export interface KernelApi {
  /** 直方体を作って表示用メッシュを返す。 */
  tessellateBox(parameters: BoxParameters, options?: TessellationOptions): Promise<MeshData>;
  /** スケッチの曲線を折れ線に、閉ループを面にする(FR-309)。 */
  tessellateSketch(
    request: SketchTessellationRequest,
    options?: TessellationOptions,
  ): Promise<SketchTessellation>;
}

/**
 * OCCT の読み込み手続きを受け取って KernelApi を組み立てる。
 * ブラウザでは loadOcctForBrowser、Node のテストでは loadOcctForNode を渡す。
 */
export function createKernelApi(loadOcct: () => Promise<OpenCascadeInstance>): KernelApi {
  return {
    async tessellateBox(parameters, options = {}): Promise<MeshData> {
      const oc = await loadOcct();
      const handle = makeBox(oc, parameters);
      try {
        const surface = tessellate(oc, handle.shape, options);
        const edges = extractEdges(oc, handle.shape, options);
        return {
          positions: surface.positions,
          normals: surface.normals,
          indices: surface.indices,
          edgePositions: edges.positions,
          triangleCount: surface.triangleCount,
          faceCount: surface.faceCount,
          edgeCount: edges.edgeCount,
        };
      } finally {
        handle.delete();
      }
    },

    async tessellateSketch(sketch, options = {}): Promise<SketchTessellation> {
      const oc = await loadOcct();
      const curvePolylines: Float32Array[] = [];
      const faces: FaceMeshData[] = [];
      const failures: SketchTessellationFailure[] = [];

      for (const curve of sketch.curves) {
        const handle = makeCurveEdge(oc, curve);
        try {
          curvePolylines.push(discretizeEdge(oc, handle.edge, options));
        } finally {
          handle.delete();
        }
      }

      // 面が 1 枚失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const faceRequest of sketch.faces) {
        try {
          const handle = makePlanarFace(oc, faceRequest.curves, options);
          try {
            const surface = tessellate(oc, handle.face, options);
            faces.push({
              id: faceRequest.id,
              positions: surface.positions,
              normals: surface.normals,
              indices: surface.indices,
              triangleCount: surface.triangleCount,
              boundaryPositions: handle.boundaryPositions,
              boundaryEdgeCount: handle.boundaryEdgeCount,
            });
          } finally {
            handle.delete();
          }
        } catch (error) {
          failures.push({
            id: faceRequest.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { curvePolylines, faces, failures };
    },
  };
}
