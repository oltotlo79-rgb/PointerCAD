import {
  createMathBackend,
  executePreparedFunctionWork,
  executeExactMathWorkRequest,
  decodeMathWorkEnvelope,
  type MathWorkEnvelope,
} from '@pointercad/expression/math/worker';
import { createLocalExactMathEngine } from './localExactMathEngine.js';
const diagnose = import.meta.env.VITE_PCAD_E2E === '1';
const initializationStarted = performance.now();
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'module-ready', elapsedMs: initializationStarted }));
const backend = createMathBackend();
let activeRequest: { readonly serial: number; readonly identity: MathWorkEnvelope['request']['identity'] } | null = null;
let busy = false;
let retire = false;
const exactEngine = createLocalExactMathEngine({
  onPhase: phase => {
    if (activeRequest === null) throw new Error('No active mathematics request');
    self.postMessage({ kind: 'math-phase', ...activeRequest, phase });
  },
  retire: () => { retire = true; },
});
async function runRequest(value: unknown, kind: unknown): Promise<void> {
  const requestStarted = performance.now();
  if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-start', kind }));
  try {
    const options = { backend, engine: exactEngine,
      // The window's bounded client terminates this entire Worker, including Python.
      // A timer in this same thread could not interrupt a synchronous calculation.
      shouldStop: () => undefined,
    };
    let result: unknown;
    if (kind === 'evaluate-math') {
      const envelope = decodeMathWorkEnvelope(value);
      activeRequest = { serial: envelope.serial, identity: envelope.request.identity };
      result = await executeExactMathWorkRequest(envelope, options);
    } else {
      result = await executePreparedFunctionWork(value, { ...options,
        onIdentity: (serial, identity) => { activeRequest = { serial, identity }; },
      });
    }
    if (retire) self.postMessage({ kind: 'math-worker-retire' });
    self.postMessage(result);
  } catch {
    self.postMessage({ kind: 'math-failed' });
  } finally {
    activeRequest = null; busy = false;
    if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'request-end', kind, elapsedMs: performance.now() - requestStarted }));
  }
}
if (diagnose) console.debug('[pcad:math-phase]', JSON.stringify({ phase: 'backend-ready', elapsedMs: performance.now() - initializationStarted }));
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  if (busy) throw new Error('A mathematics request is already running');
  busy = true;
  void runRequest(value, kind);
});
