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
  executeExactMathWorkRequest,
  decodeMathWorkEnvelope,
  type MathWorkEnvelope,
} from '@pointercad/expression/math/worker';
import { createLocalExactMathEngine } from './localExactMathEngine.js';
const diagnose = import.meta.env.VITE_PCAD_E2E === '1';
const initializationStarted = performance.now();
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'module-ready', elapsedMs: initializationStarted }));
const backend = createMathBackend();
let scalarRequest: MathWorkEnvelope | null = null;
let retire = false;
const exactEngine = createLocalExactMathEngine({
  onPhase: phase => {
    if (scalarRequest === null) throw new Error('No active scalar request');
    self.postMessage({ kind: 'math-phase', serial: scalarRequest.serial, identity: scalarRequest.request.identity, phase });
  },
  retire: () => { retire = true; },
});
async function runScalar(value: unknown): Promise<void> {
  const requestStarted = performance.now();
  if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-start', kind: 'evaluate-math' }));
  try {
    scalarRequest = decodeMathWorkEnvelope(value);
    const result = await executeExactMathWorkRequest(scalarRequest, { backend, engine: exactEngine,
      // The window's bounded client terminates this entire Worker, including Python.
      // A timer in this same thread could not interrupt a synchronous calculation.
      shouldStop: () => undefined,
    });
    if (retire) self.postMessage({ kind: 'math-worker-retire' });
    self.postMessage(result);
  } catch {
    self.postMessage({ kind: 'math-failed' });
  } finally {
    scalarRequest = null;
    if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-end', kind: 'evaluate-math', elapsedMs: performance.now() - requestStarted }));
  }
}
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'backend-ready', elapsedMs: performance.now() - initializationStarted }));
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  if (scalarRequest !== null) throw new Error('A mathematics request is already running');
  if (kind === 'evaluate-math') { void runScalar(value); return; }
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
