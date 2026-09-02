import { createKernelWorker, type KernelApi } from '@pointercad/kernel';
import * as Comlink from 'comlink';

import type { PartMesh } from './types.js';

/** model から幾何カーネルへの唯一の接点。ここ以外から kernel を呼ばない。 */
export interface KernelBridge {
  tessellateBox(dx: number, dy: number, dz: number): Promise<PartMesh>;
  dispose(): void;
}

/** Web Worker 内の幾何カーネルへつなぐ。ブラウザ・Electron のレンダラでのみ使える。 */
export function createKernelBridge(): KernelBridge {
  const worker = createKernelWorker();
  const remote = Comlink.wrap<KernelApi>(worker);

  return {
    async tessellateBox(dx, dy, dz): Promise<PartMesh> {
      const mesh = await remote.tessellateBox({ dx, dy, dz });
      return {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        edgePositions: mesh.edgePositions,
        triangleCount: mesh.triangleCount,
      };
    },
    dispose(): void {
      remote[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
