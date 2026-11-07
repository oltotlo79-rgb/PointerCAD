/** Node-only native geometry fixture owned by model; never exported by its browser barrel. */
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { writeBrepBytes } from '@pointercad/kernel/testing/native-shape-inspection';
import { solidMeshBuffers, type CachedSolid } from '@pointercad/kernel/testing/recompute-solids';
import { createShapeCache } from '@pointercad/kernel/testing/shape-cache';
import { measureEx18Shape, type Ex18ShapeMeasurement } from '../part/ex18ShapeOracle.testSupport.js';

export function createNativeKernelBridgeForNodeTests() {
  return createDirectKernelBridge(createKernelApi(loadOcctForNode));
}

/** Native STEP roundtrips share the bridge cache while staying behind the model test boundary. */
export function createNativeKernelBridgeWithIoForNodeTests() {
  const api = createKernelApi(loadOcctForNode);
  return { bridge: createDirectKernelBridge(api), shapeIo: {
    exportShapes: api.exportShapes.bind(api), importShape: api.importShape.bind(api),
  } };
}

export type NativeKernelIoForNodeTests = ReturnType<typeof createNativeKernelBridgeWithIoForNodeTests>['shapeIo'];

export async function initializeNativeKernelForNodeTests(): Promise<void> {
  await loadOcctForNode();
}

/** Node tests can observe borrowed ownership without importing kernel or OCCT types into UI. */
 interface NativeShapeInspection {
  readonly owner: { delete(): void };
  readonly handle: { delete(): void };
  readonly readBrepBytes: () => Uint8Array;
  readonly measure: () => Ex18ShapeMeasurement;
}

export async function createInspectableNativeKernelForNodeTests() {
  const oc = await loadOcctForNode();
  const cache = createShapeCache<CachedSolid>(128, undefined, entry => solidMeshBuffers(entry.mesh));
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  function inspectShape(key: string): NativeShapeInspection {
    const entry = cache.get(key);
    if (entry === undefined) throw new Error(`Missing native cached shape ${key}`);
    return { owner: entry, handle: entry.shape, readBrepBytes: () => writeBrepBytes(oc, entry.shape),
      measure: () => measureEx18Shape(oc, entry.shape) };
  }
  return { bridge, inspectShape, dispose: () => { try { bridge.dispose(); } finally { cache.clear(); } } };
}
