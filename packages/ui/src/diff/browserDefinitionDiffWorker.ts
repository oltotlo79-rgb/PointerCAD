import type { DefinitionDiffPort } from './definitionDiffClient.js';
export function createDefinitionDiffWorker(): DefinitionDiffPort {
  const worker = new Worker(new URL('./definitionDiff.worker.ts', import.meta.url), { type: 'module' });
  let closed = false;
  const port: DefinitionDiffPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage(request) { if (closed) throw new Error('比較処理は終了しています。'); worker.postMessage(request); },
    terminate() { if (closed) return; closed = true; worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); },
  };
  worker.onmessage = (event: MessageEvent<unknown>) => { if (!closed) port.onmessage?.({ data: event.data }); };
  worker.onerror = event => { event.preventDefault(); if (!closed) port.onerror?.(); };
  worker.onmessageerror = () => { if (!closed) port.onmessageerror?.(); };
  return port;
}
