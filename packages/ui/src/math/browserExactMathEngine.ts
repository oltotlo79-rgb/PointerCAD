import { ExactMathEngineClient, type ExactMathEnginePhase } from '@pointercad/expression/math/client';
import { browserMathWorker } from './browserMathWorker.js';

/** The application chooses its fixed bundled Worker. Formula input cannot select a module URL. */
export function createBrowserExactMathEngine(options: {
  readonly createWorker: () => Worker;
  readonly onPhase?: (phase: ExactMathEnginePhase) => void;
}): ExactMathEngineClient {
  return new ExactMathEngineClient({
    createWorker: () => browserMathWorker(options.createWorker()),
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  });
}
