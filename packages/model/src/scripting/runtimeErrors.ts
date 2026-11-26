import { NativeScriptException, type NativeScriptValue, type NativeScriptVm } from './nativeScriptVm.js';
import { locateScriptError } from './scriptLocation.js';
import { scriptFailure, scriptInternalFailure, type ScriptExecutionOutcome } from './scriptTypes.js';

type RuntimeFailure = Extract<ScriptExecutionOutcome, { ok: false }>['error'];

/** Capture intrinsics before user code; never invoke an arbitrary message/stack getter. */
const ERROR_READER = `(() => {
  const descriptor = Object.getOwnPropertyDescriptor, create = Object.create, stringify = JSON.stringify;
  const prototype = Object.getPrototypeOf, syntaxPrototype = SyntaxError.prototype;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const stackGetter = descriptor(Error.prototype, 'stack').get;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  return (error, isError) => {
    const out = create(null);
    if (isError && prototype(error) === syntaxPrototype) out.name = 'SyntaxError';
    for (const key of ['name', 'message']) {
      const field = descriptor(error, key);
      if (field && 'value' in field && typeof field.value === 'string') out[key] = slice(field.value, 0, 4096);
    }
    if (isError) {
      const stack = call(stackGetter, error);
      if (typeof stack === 'string') out.stack = slice(stack, 0, 16384);
    }
    return stringify(out);
  };
})()`;

export interface ScriptRuntimeControl {
  deadline: number;
  failure: RuntimeFailure | null;
  diagnostic: boolean;
}
export function createRuntimeErrorReader(vm: NativeScriptVm): NativeScriptValue {
  return vm.evalCode(ERROR_READER, 'pointercad-internal-errors.js');
}
export function readRuntimeError(vm: NativeScriptVm, reader: NativeScriptValue, value: NativeScriptValue,
  control: ScriptRuntimeControl, sources: ReadonlyMap<string, string>): RuntimeFailure {
  const previous = control.deadline;
  const wasDiagnostic = control.diagnostic;
  control.deadline = performance.now() + 50; control.diagnostic = true;
  const fallback = scriptFailure('unreadableGuestError');
  try {
    const serialized = vm.callFunction(reader, vm.undefined, value, value.isError ? vm.true : vm.false)
      .consume((result) => result.isString ? result.toString() : '{}');
    const detail: unknown = JSON.parse(serialized);
    if (typeof detail !== 'object' || detail === null) return fallback;
    const stack = 'stack' in detail && typeof detail.stack === 'string' ? detail.stack : '';
    const location = locateScriptError(stack, sources);
    if (!('message' in detail) || typeof detail.message !== 'string') {
      if ('name' in detail && detail.name === 'SyntaxError') return scriptFailure('unreadableSyntaxError', location);
      return { ...fallback, location };
    }
    const message = detail.message;
    const kind = /out of memory/u.test(message) ? 'memory' : /stack overflow|Maximum call stack size exceeded/u.test(message) ? 'stack'
      : 'name' in detail && detail.name === 'SyntaxError' ? 'syntax' : 'runtime';
    return { kind, message, location };
  } catch (error) {
    if (!(error instanceof NativeScriptException)) {
      // A primary failure already owns the report; the diagnostic pass only adds its position.
      return control.failure === null ? scriptInternalFailure(error) : fallback;
    }
    error.dispose();
    return fallback;
  } finally { control.deadline = previous; control.diagnostic = wasDiagnostic; }
}
