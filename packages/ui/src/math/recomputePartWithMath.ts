/** Browser-owned numerical evaluator for part, assembly, drawing and export computations. */
import { createBrowserMathWorker } from './browserMathWorker.js';
import { createMathWorkerReuse, type MathWorkerLease } from './mathWorkerReuse.js';
import { FunctionSurfacePlanCache, hasDocumentMath, recomputePart, type KernelBridge, type PartDocument,
  type PartRecomputeOptions, type PartRecomputeResult } from '@pointercad/model';
import type { MathWorkerClient, MathWorkerPort } from '@pointercad/expression/math/client';
import { createBrowserMathClient, pageMathResultMemory } from './createBrowserMathClient.js';
import { createBrowserFunctionClient, createBrowserFunctionSurfaceClient, createBrowserImplicitSurfaceClient,
  createBrowserImplicitCurveClient, createBrowserFunctionPointContinuationClient } from './createBrowserFunctionClient.js';

export interface MathPartRecomputer {
  (document: PartDocument, bridge: KernelBridge, options?: PartRecomputeOptions): Promise<PartRecomputeResult>;
  releaseOwner(bridge: KernelBridge): void;
  /** Keep the prepared idle Worker while a math editor is open; call the result when it closes. */
  holdIdleWorker(): () => void;
  /** Lend a math editor the prepared Worker of the previous editor of this document; release it when the editor closes. */
  acquireEditorWorker(documentId: string): MathWorkerLease;
}
export function createMathPartRecomputer(createClient: (createWorker: () => MathWorkerPort, hasWorker: () => boolean) => MathWorkerClient,
  createWorker: () => MathWorkerPort = createBrowserMathWorker): MathPartRecomputer {
  const surfacePlans = new FunctionSurfacePlanCache(), workers = createMathWorkerReuse(createWorker);
  async function compute(document: PartDocument, bridge: KernelBridge, options: PartRecomputeOptions = {}): Promise<PartRecomputeResult> {
    if (!hasDocumentMath(document) || options.math !== undefined || options.shouldCancel?.()) {
      workers.clear(bridge); return recomputePart(document, bridge, options);
    }
    const lease = workers.acquire(document.id, bridge), abort = new AbortController();
    const owned: { dispose(): void }[] = [];
    const keep = <T extends { dispose(): void }>(client: T): T => { owned.push(client); return client; };
    let reusable = false;
    const isCurrent = () => !abort.signal.aborted && !options.shouldCancel?.();
    const cancelWatch = setInterval(() => { if (options.shouldCancel?.()) abort.abort(); }, 16);
    try {
      const client = keep(createClient(lease.group.createPort, () => lease.group.hasWorker));
      const hasSurfaces = document.solids.some(feature => feature.kind === 'functionSurface' && !feature.suppressed);
      const curves = (hasSurfaces || document.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'functionCurve')))
        && options.functions === undefined ? keep(createBrowserFunctionClient(lease.group.createPort)) : undefined;
      const surfaces = hasSurfaces && options.functions === undefined ? keep(createBrowserFunctionSurfaceClient(lease.group.createPort)) : undefined;
      const hasImplicitSurfaces = document.solids.some(feature => feature.kind === 'functionSurface' && !feature.suppressed && feature.definition.formula.kind === 'implicit-surface');
      const implicitSurfaces = hasImplicitSurfaces && options.functions === undefined ? keep(createBrowserImplicitSurfaceClient(lease.group.createPort)) : undefined;
      const hasImplicitCurves = document.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'functionCurve' && feature.definition.formula.kind === 'implicit-curve'));
      const implicitCurves = hasImplicitCurves && options.functions === undefined ? keep(createBrowserImplicitCurveClient(lease.group.createPort)) : undefined;
      const points = curves === undefined ? undefined : keep(createBrowserFunctionPointContinuationClient(lease.group.createPort));
      const result = await recomputePart(document, bridge, { ...options,
        functions: options.functions ?? (curves === undefined ? undefined : { curves, surfaces, implicitSurfaces, implicitCurves, points, surfacePlans }),
        math: { client, signal: abort.signal, isCurrent, identity: { documentId: document.id, documentVersion: options.generation ?? 0 } } });
      reusable = !result.cancelled && isCurrent();
      return result;
    } finally {
      clearInterval(cancelWatch);
      let clientsReleased = false;
      try { abort.abort(); for (const client of owned) client.dispose(); clientsReleased = true; }
      finally { lease.release(reusable && clientsReleased); }
    }
  }
  return Object.assign(compute, { releaseOwner: (bridge: KernelBridge) => { workers.clear(bridge); },
    holdIdleWorker: () => workers.hold(), acquireEditorWorker: (documentId: string) => workers.acquireEditor(documentId) });
}
/** Shares validated values with the page's math editors: applying an edit already calculated its formulas. */
export const recomputePartWithMath = createMathPartRecomputer((createWorker, hasWorker) =>
  createBrowserMathClient(createWorker, pageMathResultMemory, hasWorker));
