import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { extractEdges } from '../occt/extractEdges.js';
import { makeBox } from '../occt/makeBox.js';
import { tessellate } from '../occt/tessellate.js';
import type { BoxParameters, MeshData, TessellationOptions } from '../types.js';

/** UI 側から Comlink 越しに呼べる幾何カーネルの窓口。 */
export interface KernelApi {
  /** 直方体を作って表示用メッシュを返す。 */
  tessellateBox(parameters: BoxParameters, options?: TessellationOptions): Promise<MeshData>;
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
  };
}
