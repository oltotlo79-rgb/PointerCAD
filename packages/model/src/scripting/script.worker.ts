import { executeScriptVm } from './runtimeAdapter.js';
import { readScriptExecutionInput } from './scriptInput.js';
import { scriptFailure, scriptInternalFailure, type ScriptExecutionOutcome } from './scriptTypes.js';

let started = false;
globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (started) return;
  started = true;
  const input = readScriptExecutionInput(event.data);
  const send = (result: ScriptExecutionOutcome): void => { globalThis.postMessage(result); };
  if (input === null) { send({ ok: false, error: scriptFailure('badWorkerInput'), console: [] }); return; }
  void (async (): Promise<ScriptExecutionOutcome> => {
    // URL is a bundled asset. The script cannot choose it or access this fetch function.
    const response = await fetch(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url));
    if (!response.ok) throw new Error('実行器を読み込めません。');
    const wasm = await response.arrayBuffer();
    return executeScriptVm(input, wasm);
  })().then(send, (error: unknown) => { send({ ok: false, error: scriptInternalFailure(error), console: [] }); });
});
