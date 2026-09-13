import { createBrowserMathWorker } from './browserMathWorker.js';
import { createMathWorkerGroup } from './mathWorkerGroup.js';
/** Browser-owned numerical evaluator for every part computation, including assembly/drawing/export inputs. */
import { FunctionSurfacePlanCache, hasDocumentMath, recomputePart, type KernelBridge, type PartDocument, type PartRecomputeOptions,
  type PartRecomputeResult } from '@pointercad/model';
import type { MathWorkerClient, MathWorkerPort } from '@pointercad/expression/math/client';
import { createBrowserMathClient } from './createBrowserMathClient.js';
import { createBrowserFunctionClient, createBrowserFunctionSurfaceClient, createBrowserImplicitSurfaceClient, createBrowserImplicitCurveClient, createBrowserFunctionPointContinuationClient } from './createBrowserFunctionClient.js';

export function createMathPartRecomputer(createClient: (createWorker: () => MathWorkerPort) => MathWorkerClient) {
  const surfacePlans = new FunctionSurfacePlanCache();
  return async (document: PartDocument, bridge: KernelBridge, options: PartRecomputeOptions = {}): Promise<PartRecomputeResult> => {
    if (!hasDocumentMath(document) || options.math !== undefined || options.shouldCancel?.()) return recomputePart(document, bridge, options);
    const workers = createMathWorkerGroup(createBrowserMathWorker);
    const client = createClient(workers.createPort), abort = new AbortController();
    const hasSurfaces = document.solids.some(feature => feature.kind === 'functionSurface' && !feature.suppressed);
    const curves = (hasSurfaces || document.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'functionCurve')))
      && options.functions === undefined ? createBrowserFunctionClient(workers.createPort) : undefined;
    const surfaces = hasSurfaces && options.functions === undefined ? createBrowserFunctionSurfaceClient(workers.createPort) : undefined;
    const hasImplicitSurfaces = document.solids.some(feature => feature.kind === 'functionSurface' && !feature.suppressed && feature.definition.formula.kind === 'implicit-surface');
    const implicitSurfaces = hasImplicitSurfaces && options.functions === undefined ? createBrowserImplicitSurfaceClient(workers.createPort) : undefined;
    const hasImplicitCurves=document.sketches.some(sketch=>sketch.features.some(feature=>feature.kind==='functionCurve' && feature.definition.formula.kind==='implicit-curve'));
    const implicitCurves=hasImplicitCurves && options.functions===undefined ? createBrowserImplicitCurveClient(workers.createPort) : undefined;
    const points=curves===undefined?undefined:createBrowserFunctionPointContinuationClient(workers.createPort);
    const isCurrent = () => !abort.signal.aborted && !options.shouldCancel?.();
    // Existing geometry callers expose a cancellation predicate. Bridge it to termination while math is synchronous in its Worker.
    const cancelWatch = setInterval(() => { if (options.shouldCancel?.()) abort.abort(); }, 16);
    try {
      return await recomputePart(document, bridge, { ...options,
        functions: options.functions ?? (curves === undefined ? undefined : { curves, surfaces, implicitSurfaces, implicitCurves, points, surfacePlans }), math: { client, signal: abort.signal, isCurrent,
        identity: { documentId: document.id, documentVersion: options.generation ?? 0 } } });
    } finally {
      clearInterval(cancelWatch);
      abort.abort();
      client.dispose();
      curves?.dispose();
      surfaces?.dispose();
      implicitSurfaces?.dispose();
      implicitCurves?.dispose();
      points?.dispose();
      workers.dispose();
    }
  };
}

export const recomputePartWithMath = createMathPartRecomputer(createBrowserMathClient);
