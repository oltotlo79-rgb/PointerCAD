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
const diagnose = import.meta.env.VITE_PCAD_E2E === '1';
const initializationStarted = performance.now();
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'module-ready', elapsedMs: initializationStarted }));
const backend = createMathBackend();
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'backend-ready', elapsedMs: performance.now() - initializationStarted }));
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  const requestStarted = performance.now();
  if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-start', kind }));
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
  if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-end', kind, elapsedMs: performance.now() - requestStarted }));
});
