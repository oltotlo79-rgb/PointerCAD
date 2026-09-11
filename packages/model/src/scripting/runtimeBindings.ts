import type { JSValueHandle, QuickJS } from 'quickjs-wasi';
import { readSerializedScriptCommand } from './commandValidation.js';
import { scriptUtf8Bytes } from './scriptBytes.js';
import { locateScriptError } from './scriptLocation.js';
import { scriptFailure, type ScriptRuntimeControl } from './runtimeErrors.js';
import { SCRIPT_GUEST_BOOTSTRAP } from './scriptGuestBootstrap.js';
import { SCRIPT_LIMITS, type ScriptCommand, type ScriptConsoleLine, type ScriptExecutionInput } from './scriptTypes.js';

export interface RuntimeOutput { commands: ScriptCommand[]; console: ScriptConsoleLine[] }
export function installRuntimeBindings(vm: QuickJS, input: ScriptExecutionInput, control: ScriptRuntimeControl): RuntimeOutput {
  const output: RuntimeOutput = { commands: [], console: [] };
  const sources = new Map(input.program.modules.map(module => [module.name, module.source])); sources.set('user-script.js', input.program.source);
  let commandBytes = 0, consoleBytes = 0;
  const fail = (kind: 'command' | 'console', message: string): void => {
    control.failure ??= scriptFailure(kind, message);
  };
  const bind = (name: string, value: JSValueHandle): void => {
    try { vm.global.setProp(name, value); } finally { value.dispose(); }
  };
  bind('__pointercadCommand', vm.newFunction('pcad-command', (...args) => {
    const value = args[0];
    if (control.failure !== null) return vm.undefined;
    if (args.length !== 1 || value === undefined || !value.isString || output.commands.length >= SCRIPT_LIMITS.commands) {
      fail('command', '1回の処理で作れる操作は1000件までです。'); return vm.undefined;
    }
    const read = readSerializedScriptCommand(value.toString(), input.commandNamespace, SCRIPT_LIMITS.commandBytes - commandBytes);
    if (!read.ok) { fail('command', '操作の入力や大きさが許容範囲を超えています。'); return vm.undefined; }
    output.commands.push(read.command); commandBytes += read.bytes;
    return vm.undefined;
  }));
  bind('__pointercadConsole', vm.newFunction('pcad-console', (...args) => {
    const value = args[0];
    if (control.failure !== null) return vm.undefined;
    if (args.length !== 1 || value === undefined || !value.isString || output.console.length >= SCRIPT_LIMITS.consoleLines) {
      fail('console', '表示できる記録は1000行までです。'); return vm.undefined;
    }
    const serialized = value.toString();
    // Escaping may enlarge a serialized log; bound it before parsing too.
    if (scriptUtf8Bytes(serialized, SCRIPT_LIMITS.consoleBytes * 6 + 64) === null) {
      fail('console', '表示する記録が大きすぎます。'); return vm.undefined;
    }
    const record: unknown = JSON.parse(serialized);
    if (typeof record !== 'object' || record === null || !('text' in record) || !('level' in record)
      || typeof record.text !== 'string' || (record.level !== 'info' && record.level !== 'warning' && record.level !== 'error')) {
      fail('console', '表示する記録の形式が正しくありません。'); return vm.undefined;
    }
    const bytes = scriptUtf8Bytes(record.text, SCRIPT_LIMITS.consoleBytes - consoleBytes);
    if (bytes === null) { fail('console', '表示する記録が大きすぎます。'); return vm.undefined; }
    consoleBytes += bytes; output.console.push({ level: record.level, text: record.text });
    return vm.undefined;
  }));
  bind('__pointercadLimit', vm.newFunction('pcad-limit', (...args) => {
    const reason = args[0]?.isString ? args[0].toString() : '';
    const kind = reason === 'console' || reason === 'console-bytes' ? 'console' : 'command';
    const message = reason === 'commands' ? '1回の処理で作れる操作の上限1000件を超えました。処理を分けてください。'
      : reason === 'bytes' ? '操作の内容が上限8MiBを超えました。処理を分けてください。'
      : reason === 'console' ? '表示できる記録の上限1000行を超えました。記録を減らしてください。'
      : reason === 'console-bytes' ? '表示する記録の上限1MiBを超えました。記録を減らしてください。'
      : '1回の処理で扱える件数か大きさを超えました。処理を分けてください。';
    fail(kind, message);
    const trace = args[1];
    if (control.failure !== null && control.failure.location === null && trace?.isString)
      control.failure = { ...control.failure, location: locateScriptError(trace.toString().slice(0, SCRIPT_LIMITS.stackCharacters), sources) };
    return vm.undefined;
  }));
  bind('__pointercadSnapshot', vm.newString(input.snapshot));
  bind('__pointercadExecutionPrefix', vm.newString(input.commandNamespace));
  bind('__pointercadSeed', vm.newNumber(input.seed));
  vm.evalCode(SCRIPT_GUEST_BOOTSTRAP, 'pointercad-internal-api.js').dispose();
  return output;
}
