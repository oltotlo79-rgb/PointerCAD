import { NativeScriptVm, NativeScriptException, type NativeScriptValue } from './nativeScriptVm.js';
import { installRuntimeBindings, type RuntimeOutput } from './runtimeBindings.js';
import { createRuntimeErrorReader, readRuntimeError, type ScriptRuntimeControl } from './runtimeErrors.js';
import { resolveScriptModule, validateScriptProgram } from './scriptModules.js';
import { readScriptExecutionInput } from './scriptInput.js';
import { nativeResourceLimit } from './runtimeResourceLimit.js';
import { scriptFailure, scriptInternalFailure, SCRIPT_LIMITS, type ScriptExecutionInput, type ScriptExecutionOutcome, type ScriptReasonFailure } from './scriptTypes.js';

/** Dedicated Worker only in the app; tests supply the same shipped WASM bytes. */
export async function executeScriptVm(input: ScriptExecutionInput, wasm: BufferSource): Promise<ScriptExecutionOutcome> {
  if (readScriptExecutionInput(input) === null) return { ok: false, error: scriptFailure('badExecutionInput'), console: [] };
  const checked = await validateScriptProgram(input.program);
  if (!checked.ok) return { ok: false, error: scriptFailure('badProgram'), console: [] };
  const modules = new Map(input.program.modules.map((module) => [module.name, module.source]));
  const sources = new Map(modules); sources.set('user-script.js', input.program.source);
  const control: ScriptRuntimeControl = { deadline: Infinity, failure: null, diagnostic: false };
  let readNativeLimit: () => ScriptReasonFailure | null = () => null;
  const unhandled = new Map<number, NativeScriptValue>();
  const terminal: { result?: { value: NativeScriptValue } | { error: NativeScriptValue } } = {};
  let vm: NativeScriptVm | undefined, result: NativeScriptValue | undefined, reader: NativeScriptValue | undefined;
  let output: RuntimeOutput = { commands: [], console: [] };
  const started = performance.now();
  let runningGuest = false;
  try {
    vm = await NativeScriptVm.create({ wasm, memoryLimit: SCRIPT_LIMITS.heapBytes, maxStackSize: SCRIPT_LIMITS.stackBytes,
      timeMs: input.timeMs,
      interruptHandler() {
        if (control.diagnostic) return performance.now() >= control.deadline;
        control.failure ??= readNativeLimit();
        if (performance.now() >= control.deadline) control.failure ??= scriptFailure('runtimeTimeout');
        return control.failure !== null;
      },
      onUnhandledRejection(promise, reason, handled) {
        const previous = unhandled.get(promise.identity);
        if (handled) { previous?.dispose(); unhandled.delete(promise.identity); }
        else if (previous === undefined) {
          if (unhandled.size >= 32) control.failure ??= scriptFailure('rejectedPromises');
          else unhandled.set(promise.identity, reason.dup());
        }
      },
      moduleLoader: {
        normalize(base, requested) {
          const name = resolveScriptModule(base, requested, modules);
          if (name === null) { control.failure ??= scriptFailure('moduleDenied'); throw new Error('Module denied'); }
          return name;
        },
        load(name) { const source = modules.get(name); if (source === undefined) throw new Error('Module missing'); return source; },
      },
    });
    readNativeLimit = nativeResourceLimit(vm, sources);
    reader = createRuntimeErrorReader(vm);
    output = installRuntimeBindings(vm, input, control);
    const initialized = performance.now(); control.deadline = initialized + SCRIPT_LIMITS.javascriptMs;
    runningGuest = true;
    result = vm.evalCode(input.program.source, 'user-script.js', true);
    vm.markPromiseHandled(result);
    vm.executePendingJobs();
    terminal.result = vm.settled(result);
    captureNativeFailure();
    const error = terminal.result !== undefined && 'error' in terminal.result ? terminal.result.error : unhandled.values().next().value;
    if (control.failure !== null) {
      if (control.failure.location === null && error !== undefined) control.failure = { ...control.failure, location: readRuntimeError(vm, reader, error, control, sources).location };
      return { ok: false, error: control.failure, console: output.console };
    }
    if (error !== undefined) return { ok: false, error: readRuntimeError(vm, reader, error, control, sources), console: output.console };
    if (terminal.result === undefined) return { ok: false, error: scriptFailure('pendingPromise'), console: output.console };
    return { ok: true, ...output, initializationMs: initialized - started, javascriptMs: performance.now() - initialized };
  } catch (error) {
    captureNativeFailure();
    let failure = control.failure;
    if (error instanceof NativeScriptException) {
      try {
        if (runningGuest && vm !== undefined && reader !== undefined && (failure === null || failure.location === null)) {
          const detail = readRuntimeError(vm, reader, error.handle, control, sources);
          failure = failure === null ? detail : { ...failure, location: detail.location };
        }
        failure ??= scriptInternalFailure(new Error('Script runtime initialization failed', { cause: error }));
      } finally { error.dispose(); }
    } else {
      failure ??= scriptInternalFailure(error);
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
