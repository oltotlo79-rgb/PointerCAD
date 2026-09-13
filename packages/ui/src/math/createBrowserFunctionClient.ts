import {
  CurvePointWorkerClient,
  CurvePointContinuationWorkerClient,
  FunctionCurveWorkerClient,
  FunctionImplicitCurveWorkerClient,
  FunctionImplicitWorkerClient,
  PointContinuationWorkerClient,
  PointCalculationWorkerClient,
  FunctionSurfaceWorkerClient,
} from '@pointercad/expression/math/client';



import { browserMathWorker } from './browserMathWorker.js';


export function createBrowserFunctionPointClient(): PointCalculationWorkerClient {
  return new PointCalculationWorkerClient({createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), {type:'module'}))});
}
export function createBrowserCurvePointClient(): CurvePointWorkerClient {
  return new CurvePointWorkerClient({createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), {type:'module'}))});
}
export function createBrowserCurvePointContinuationClient(): CurvePointContinuationWorkerClient {
  return new CurvePointContinuationWorkerClient({createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), {type:'module'}))});
}
export function createBrowserFunctionPointContinuationClient(): PointContinuationWorkerClient {
  return new PointContinuationWorkerClient({createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), {type:'module'}))});
}

/** Dispose on editor/document close. No mathematical engine is instantiated on the UI thread. */
export function createBrowserFunctionClient(): FunctionCurveWorkerClient {
  return new FunctionCurveWorkerClient({
    createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' })),
  });
}

export function createBrowserFunctionSurfaceClient(): FunctionSurfaceWorkerClient {
  return new FunctionSurfaceWorkerClient({
    createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' })),
  });
}

export function createBrowserImplicitSurfaceClient(): FunctionImplicitWorkerClient {
  return new FunctionImplicitWorkerClient({
    createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' })),
  });
}

export function createBrowserImplicitCurveClient(): FunctionImplicitCurveWorkerClient {
  return new FunctionImplicitCurveWorkerClient({
    createWorker: () => browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' })),
  });
}
