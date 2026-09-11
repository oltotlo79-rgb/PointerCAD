import { QuickJS, EvalFlags, JSException, type JSValueHandle } from 'quickjs-wasi';
import { installRuntimeBindings, type RuntimeOutput } from './runtimeBindings.js';
import { createRuntimeErrorReader, readRuntimeError, scriptFailure, type ScriptRuntimeControl } from './runtimeErrors.js';
import { resolveScriptModule, validateScriptProgram } from './scriptModules.js';
import { readScriptExecutionInput } from './scriptInput.js';
import { nativeResourceLimit } from './runtimeResourceLimit.js';
import type { ScriptFailure } from './scriptTypes.js';
import { SCRIPT_LIMITS, type ScriptExecutionInput, type ScriptExecutionOutcome } from './scriptTypes.js';

/** Dedicated Worker only in the app; tests supply the same shipped WASM bytes. */
export async function executeScriptVm(input: ScriptExecutionInput, wasm: BufferSource): Promise<ScriptExecutionOutcome> {
  if (readScriptExecutionInput(input) === null) return { ok: false, error: scriptFailure('source', '実行する内容の形式や大きさを確認してください。'), console: [] };
  const checked = await validateScriptProgram(input.program);
  if (!checked.ok) return { ok: false, error: scriptFailure('source', '処理の内容・名前・版・照合値を確認してください。'), console: [] };
  const modules = new Map(input.program.modules.map((module) => [module.name, module.source]));
  const sources = new Map(modules); sources.set('user-script.js', input.program.source);
  const control: ScriptRuntimeControl = { deadline: Infinity, failure: null, diagnostic: false };
  let readNativeLimit: () => ScriptFailure | null = () => null;
  const unhandled = new Map<number, JSValueHandle>();
  const terminal: { result?: { value: JSValueHandle } | { error: JSValueHandle } } = {};
  let vm: QuickJS | undefined, result: JSValueHandle | undefined, reader: JSValueHandle | undefined;
  let output: RuntimeOutput = { commands: [], console: [] };
  const started = performance.now();
  try {
    vm = await QuickJS.create({ wasm, memoryLimit: SCRIPT_LIMITS.heapBytes, maxStackSize: SCRIPT_LIMITS.stackBytes,
      timezoneOffset: 0,
      wasi: (memory) => ({ clock_time_get(_clock: number, _precision: bigint, pointer: number): number {
        new DataView(memory.buffer).setBigUint64(pointer, BigInt(input.timeMs) * 1000000n, true); return 0;
      } }),
      interruptHandler() {
        if (control.diagnostic) return performance.now() >= control.deadline;
        control.failure ??= readNativeLimit();
        if (performance.now() >= control.deadline) control.failure ??= scriptFailure('timeout', '処理時間の上限5秒を超えました。');
        return control.failure !== null;
      },
      onUnhandledRejection(promise, reason, handled) {
        const previous = unhandled.get(promise.identity);
        if (handled) { previous?.dispose(); unhandled.delete(promise.identity); }
        else if (previous === undefined) {
          if (unhandled.size >= 32) control.failure ??= scriptFailure('runtime', '未処理の非同期エラーが多すぎます。');
          else unhandled.set(promise.identity, reason.dup());
        }
      },
      moduleLoader: {
        normalize(base, requested) {
          const name = resolveScriptModule(base, requested, modules);
          if (name === null) { control.failure ??= scriptFailure('module', '同梱されたローカル処理だけを読み込めます。'); throw new Error('Module denied'); }
          return name;
        },
        load(name) { const source = modules.get(name); if (source === undefined) throw new Error('Module missing'); return source; },
      },
    });
    readNativeLimit = nativeResourceLimit(vm, sources);
    reader = createRuntimeErrorReader(vm);
    output = installRuntimeBindings(vm, input, control);
    const initialized = performance.now(); control.deadline = initialized + SCRIPT_LIMITS.javascriptMs;
    result = vm.evalCode(input.program.source, 'user-script.js', EvalFlags.TYPE_MODULE);
    vm.markPromiseHandled(result);
    void vm.resolvePromise(result).then((value) => { terminal.result = value; });
    vm.executePendingJobs(); await Promise.resolve();
    captureNativeFailure();
    const error = terminal.result !== undefined && 'error' in terminal.result ? terminal.result.error : unhandled.values().next().value;
    if (control.failure !== null) {
      if (control.failure.location === null && error !== undefined) control.failure = { ...control.failure, location: readRuntimeError(vm, reader, error, control, sources).location };
      return { ok: false, error: control.failure, console: output.console };
    }
    if (error !== undefined) return { ok: false, error: readRuntimeError(vm, reader, error, control, sources), console: output.console };
    if (terminal.result === undefined) return { ok: false, error: scriptFailure('runtime', '完了しない非同期処理が残っています。'), console: output.console };
    return { ok: true, ...output, initializationMs: initialized - started, javascriptMs: performance.now() - initialized };
  } catch (error) {
    captureNativeFailure();
    let failure = control.failure ?? scriptFailure('worker', '処理を実行できませんでした。もう一度実行してください。');
    if (error instanceof JSException) {
      try {
        if (vm !== undefined && reader !== undefined && failure.location === null) {
          const detail = readRuntimeError(vm, reader, error.handle, control, sources);
          failure = control.failure === null ? detail : { ...failure, location: detail.location };
        }
      }
      finally { error.dispose(); }
    }
    return { ok: false, error: failure, console: output.console };
  } finally {
    if (terminal.result !== undefined) {
      if ('error' in terminal.result) terminal.result.error.dispose(); else terminal.result.value.dispose();
    }
    result?.dispose(); reader?.dispose();
    for (const reason of unhandled.values()) reason.dispose(); unhandled.clear(); vm?.dispose();
  }

  function captureNativeFailure(): void {
    const native = readNativeLimit();
    if (native === null) return;
    control.failure = control.failure === null ? native
      : { ...control.failure, location: control.failure.location ?? native.location };
  }
}
