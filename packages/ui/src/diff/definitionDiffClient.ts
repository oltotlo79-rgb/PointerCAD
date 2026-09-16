import { DEFINITION_DIFF_TIMEOUT_MS, isDefinitionDiffReply, type DefinitionDiffReply, type DefinitionDiffRequest } from './definitionDiffProtocol.js';

export interface DefinitionDiffPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (request: DefinitionDiffRequest) => void;
  terminate: () => void;
}
export type DefinitionDiffExecution = { readonly ok: true; readonly reply: DefinitionDiffReply }
  | { readonly ok: false; readonly reason: 'cancelled' | 'timeout' | 'failed' };

/** 成功・失敗・中止のすべてで、その依頼だけが持つWorkerと待機を解放する。 */
export function runDefinitionDiff(request: DefinitionDiffRequest, signal: AbortSignal,
  createPort: () => DefinitionDiffPort, timeoutMs = DEFINITION_DIFF_TIMEOUT_MS): Promise<DefinitionDiffExecution> {
  if (signal.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve({ ok: false, reason: 'failed' });
  return new Promise(resolve => {
    let port: DefinitionDiffPort;
    try { port = createPort(); } catch { resolve({ ok: false, reason: 'failed' }); return; }
    let finished = false;
    const finish = (result: DefinitionDiffExecution): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      port.onmessage = null; port.onerror = null; port.onmessageerror = null;
      try { port.terminate(); } catch { resolve({ ok: false, reason: 'failed' }); return; }
      resolve(result);
    };
    const cancel = (): void => finish({ ok: false, reason: 'cancelled' });
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    port.onmessage = event => {
      if (performance.now() >= deadline) { finish({ ok: false, reason: 'timeout' }); return; }
      const reply = event.data;
      if (!isDefinitionDiffReply(reply) || (reply.kind !== 'failed'
        && (request.kind === 'inspect' ? reply.kind !== 'inspected' : reply.kind !== 'compared'
          || reply.result.relationship !== request.relationship))) { finish({ ok: false, reason: 'failed' }); return; }
      finish({ ok: true, reply });
    };
    port.onerror = () => finish({ ok: false, reason: 'failed' });
    port.onmessageerror = () => finish({ ok: false, reason: 'failed' });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try { port.postMessage(request); } catch { finish({ ok: false, reason: 'failed' }); }
  });
}
