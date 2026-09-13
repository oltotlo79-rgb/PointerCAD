import type { MathWorkerPort } from '@pointercad/expression/math/client';
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



import { createBrowserMathWorker } from './browserMathWorker.js';


export function createBrowserFunctionPointClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): PointCalculationWorkerClient {
  return new PointCalculationWorkerClient({createWorker});
}
export function createBrowserCurvePointClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): CurvePointWorkerClient {
  return new CurvePointWorkerClient({createWorker});
}
export function createBrowserCurvePointContinuationClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): CurvePointContinuationWorkerClient {
  return new CurvePointContinuationWorkerClient({createWorker});
}
export function createBrowserFunctionPointContinuationClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): PointContinuationWorkerClient {
  return new PointContinuationWorkerClient({createWorker});
}

/** Dispose on editor/document close. No mathematical engine is instantiated on the UI thread. */
export function createBrowserFunctionClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): FunctionCurveWorkerClient {
  return new FunctionCurveWorkerClient({
    createWorker,
  });
}

export function createBrowserFunctionSurfaceClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): FunctionSurfaceWorkerClient {
  return new FunctionSurfaceWorkerClient({
    createWorker,
  });
}

export function createBrowserImplicitSurfaceClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): FunctionImplicitWorkerClient {
  return new FunctionImplicitWorkerClient({
    createWorker,
  });
}

export function createBrowserImplicitCurveClient(createWorker: () => MathWorkerPort = createBrowserMathWorker): FunctionImplicitCurveWorkerClient {
  return new FunctionImplicitCurveWorkerClient({
    createWorker,
  });
}
