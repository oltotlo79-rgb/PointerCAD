import {
  createMathBackend,
  executeCurvePointWorkRequest,
  executeSurfacePointWorkRequest,
  executeSurfacePointContinuationWork,
  executeCurvePointContinuationWork,
  executeFunctionCurveWorkRequest,
  executeFunctionImplicitCurveWorkRequest,
  executeFunctionImplicitWorkRequest,
  executeFunctionPointContinuationWork,
  executeFunctionPointWorkRequest,
  executeFunctionSurfaceWorkRequest,
  executeMathWorkRequest,
} from '@pointercad/expression/math/worker';







const backend = createMathBackend();
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  self.postMessage(kind === 'sample-function-curve' ? executeFunctionCurveWorkRequest(value,backend)
    : kind === 'sample-function-surface' ? executeFunctionSurfaceWorkRequest(value,backend)
      : kind === 'sample-function-implicit-surface' ? executeFunctionImplicitWorkRequest(value,backend)
        : kind === 'sample-function-implicit-curve' ? executeFunctionImplicitCurveWorkRequest(value,backend)
          : kind === 'solve-curve-points' ? executeCurvePointWorkRequest(value,backend)
            : kind === 'solve-surface-points' ? executeSurfacePointWorkRequest(value,backend)
            : kind === 'solve-function-points' ? executeFunctionPointWorkRequest(value,backend)
              : kind === 'continue-curve-point' ? executeCurvePointContinuationWork(value,backend)
                : kind === 'continue-surface-point' ? executeSurfacePointContinuationWork(value,backend)
                : kind === 'continue-function-point' ? executeFunctionPointContinuationWork(value,backend) : executeMathWorkRequest(value,backend));
});
