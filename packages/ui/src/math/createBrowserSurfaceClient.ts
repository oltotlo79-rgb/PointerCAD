import { FunctionSurfaceWorkerClient } from '@pointercad/expression/math/client';
import { browserMathWorker } from './browserMathWorker.js';

export function createBrowserSurfaceClient(): FunctionSurfaceWorkerClient {
  return new FunctionSurfaceWorkerClient({
    createWorker:()=>browserMathWorker(new Worker(new URL('./math.worker.ts',import.meta.url),{type:'module'})),
  });
}
