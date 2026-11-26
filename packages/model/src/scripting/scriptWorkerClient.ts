import { readScriptOutcome } from './scriptOutcome.js';
import { scriptFailure, scriptInternalFailure, SCRIPT_LIMITS, type ScriptExecutionInput, type ScriptExecutionOutcome, type ScriptReasonFailure } from './scriptTypes.js';

export type ScriptWorkerFactory = () => Worker;
export const createScriptWorker: ScriptWorkerFactory = () => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' });

/** Timeout and cancel live on the UI side, independent of guest JS and Promise jobs. */
export function runScriptWorker(input: ScriptExecutionInput, signal: AbortSignal, createWorker: ScriptWorkerFactory = createScriptWorker): Promise<ScriptExecutionOutcome> {
  return new Promise((resolve) => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const finish = (result: ScriptExecutionOutcome): void => {
      if (finished) return;
      finished = true; if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cancel); worker?.terminate(); resolve(result);
    };
    const fail = (error: ScriptReasonFailure): void => finish({ ok: false, error, console: [] });
    const internal = (cause: unknown): void => { if (!finished) fail(scriptInternalFailure(cause)); };
    const cancel = (): void => { fail(scriptFailure('cancelled')); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      worker = createWorker();
      if (finished) { worker.terminate(); return; }
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        try {
          const result = readScriptOutcome(event.data, input.commandNamespace);
          if (result === null) internal(new Error('Invalid script worker outcome')); else finish(result);
        } catch (error) { internal(error); }
      });
      worker.addEventListener('error', (event) => {
        if (finished) return;
        event.preventDefault();
        internal(event.error ?? new Error(event.message || 'Script worker stopped'));
      });
      worker.addEventListener('messageerror', () => { internal(new Error('Script worker outcome could not be received')); });
      timer = setTimeout(() => { fail(scriptFailure('totalTimeout')); }, SCRIPT_LIMITS.totalMs);
      worker.postMessage(input);
    } catch (error) { internal(error); }
  });
}
