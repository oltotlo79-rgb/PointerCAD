/** Node-only native geometry fixture owned by model; never exported by its browser barrel. */
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';

export function createNativeKernelBridgeForNodeTests(): ReturnType<typeof createDirectKernelBridge> {
  return createDirectKernelBridge(createKernelApi(loadOcctForNode));
}

export async function initializeNativeKernelForNodeTests(): Promise<void> {
  await loadOcctForNode();
}
