/** Worker-owned symbolic engine, source preparation and request execution. Never import into the editor. */
export { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
export type { ExactMathEngine, ExactMathWorkOptions } from './exactMathWorkExecution.js';
export {executeCurvePointWorkRequest} from './curvePointWorkExecution.js';
export {executeSurfacePointWorkRequest} from './surfacePointWorkExecution.js';
export {executeSurfacePointContinuationWork} from './surfacePointContinuationWorkExecution.js';
export {executeCurvePointContinuationWork} from './curvePointContinuationWorkExecution.js';
export {
  executeFunctionPointContinuationWork,
  executeMathWorkRequest,
} from './mathWorkExecution.js';
export type {
  MathExecutionBackend,
} from './mathWorkExecution.js';
export {
  createMathBackend,
} from './createMathBackend.js';
export {
  createFunctionMathSource,
  readFunctionMathSource,
} from './functionMathSource.js';
export {
  executeFunctionCurveWorkRequest,
} from './functionCurveWorkExecution.js';
export {
  executeFunctionSurfaceWorkRequest,
} from './functionSurfaceWorkExecution.js';
export {
  executeFunctionImplicitWorkRequest,
} from './functionImplicitWorkExecution.js';
export {
  executeFunctionImplicitCurveWorkRequest,
} from './functionImplicitCurveWorkExecution.js';
export {
  executeFunctionPointWorkRequest,
} from './functionPointWorkExecution.js';
