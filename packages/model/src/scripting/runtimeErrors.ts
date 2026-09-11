import { JSException, type JSValueHandle, type QuickJS } from 'quickjs-wasi';
import { locateScriptError } from './scriptLocation.js';
import type { ScriptFailure, ScriptFailureKind } from './scriptTypes.js';

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
  failure: ScriptFailure | null;
  diagnostic: boolean;
}
export function scriptFailure(kind: ScriptFailureKind, message: string): ScriptFailure {
  return { kind, message, location: null };
}
export function createRuntimeErrorReader(vm: QuickJS): JSValueHandle {
  return vm.evalCode(ERROR_READER, 'pointercad-internal-errors.js');
}
export function readRuntimeError(vm: QuickJS, reader: JSValueHandle, value: JSValueHandle,
  control: ScriptRuntimeControl, sources: ReadonlyMap<string, string>): ScriptFailure {
  const previous = control.deadline;
  control.deadline = performance.now() + 50; control.diagnostic = true;
  const fallback = scriptFailure('runtime', '処理を完了できませんでした。エラーの内容を読み取れません。');
  try {
    const serialized = vm.callFunction(reader, vm.undefined, value, value.isError ? vm.true : vm.false)
      .consume((result) => result.isString ? result.toString() : '{}');
    const detail: unknown = JSON.parse(serialized);
    if (typeof detail !== 'object' || detail === null) return fallback;
    const message = 'message' in detail && typeof detail.message === 'string' ? detail.message : fallback.message;
    const stack = 'stack' in detail && typeof detail.stack === 'string' ? detail.stack : '';
    const kind = /out of memory/u.test(message) ? 'memory' : /stack overflow|Maximum call stack size exceeded/u.test(message) ? 'stack'
      : 'name' in detail && detail.name === 'SyntaxError' ? 'syntax' : 'runtime';
    return { kind, message, location: locateScriptError(stack, sources) };
  } catch (error) {
    if (error instanceof JSException) error.dispose();
    return fallback;
  } finally { control.deadline = previous; control.diagnostic = false; }
}
