import {
  createCalculationPaceMessage,
  createCalculationPaceMeter,
  createMathBackend,
  executePreparedFunctionWork,
  executeExactMathWorkRequest,
  decodeMathWorkEnvelope,
  setCalculationPace,
  warmMathBackend,
  type MathWorkEnvelope,
} from '@pointercad/expression/math/worker';
import { createLocalExactMathEngine } from './localExactMathEngine.js';
const diagnose = import.meta.env.VITE_PCAD_E2E === '1';
const diagnosticWorker = diagnose ? crypto.randomUUID() : undefined;
function trace(phase: string, detail: Record<string, unknown>): void {
  console.debug('[pcad:math-phase]', JSON.stringify({ worker: diagnosticWorker,
    timeOrigin: performance.timeOrigin, atMs: performance.now(), phase, ...detail }));
}
/** Observe the real envelope without invoking validation earlier or changing its contents. */
function observedEnvelope(value: unknown): Record<string, unknown> {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  const request = raw?.request;
  return { serial: raw?.serial, identity: request !== null && typeof request === 'object' && 'identity' in request
    ? request.identity : undefined };
}
const initializationStarted = performance.now();
if (diagnose) trace('module-ready', { elapsedMs: initializationStarted });
const backend = createMathBackend();
// Compile the shared calculation code now, outside every request's wall clock; the result is discarded.
const warmupMs = warmMathBackend(backend);
// The machine's current pace (v1.0.2): every wall-clock limit of a request follows it, so a slow or throttled PC
// does not refuse a correct calculation that a machine at its usual speed completes.
const pace = createCalculationPaceMeter();
let activeRequest: { readonly serial: number; readonly identity: MathWorkEnvelope['request']['identity'] } | null = null;
let busy = false;
let retire = false;
const exactEngine = createLocalExactMathEngine({
  onPhase: phase => {
    if (activeRequest === null) throw new Error('No active mathematics request');
    if (diagnose) trace(`engine-${phase}`, { ...activeRequest });
    self.postMessage({ kind: 'math-phase', ...activeRequest, phase });
  },
  retire: () => { retire = true; },
});
async function runRequest(value: unknown, kind: unknown): Promise<void> {
  const requestStarted = performance.now();
  const diagnosticEnvelope = diagnose ? observedEnvelope(value) : null;
  if (diagnose) trace('request-received', { ...diagnosticEnvelope, kind });
  try {
    // Measured (or reused) before the request's own clocks start; the host stretches its deadline by the same pace.
    const requestPace = pace.current();
    setCalculationPace(requestPace);
    self.postMessage(createCalculationPaceMessage(requestPace));
    if (diagnose) trace('request-start', { ...diagnosticEnvelope, kind, pace: requestPace, referenceMs: pace.elapsedMs });
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
    if (diagnose) trace('reply-ready', { ...diagnosticEnvelope, kind });
    self.postMessage(result);
  } catch {
    if (diagnose) trace('reply-ready', { ...diagnosticEnvelope, kind, failed: true });
    self.postMessage({ kind: 'math-failed' });
  } finally {
    activeRequest = null; busy = false;
    if (diagnose) trace('request-end', { ...diagnosticEnvelope, kind, elapsedMs: performance.now() - requestStarted });
  }
}
if (diagnose) trace('backend-ready', { elapsedMs: performance.now() - initializationStarted, warmupMs, referenceMs: pace.elapsedMs });
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  if (busy) throw new Error('A mathematics request is already running');
  busy = true;
  void runRequest(value, kind);
});
