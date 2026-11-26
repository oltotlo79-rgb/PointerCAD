import type { NativeScriptValue, NativeScriptVm } from './nativeScriptVm.js';
import { readSerializedScriptCommand } from './commandValidation.js';
import { scriptUtf8Bytes } from './scriptBytes.js';
import { locateScriptError } from './scriptLocation.js';
import type { ScriptRuntimeControl } from './runtimeErrors.js';
import { SCRIPT_GUEST_BOOTSTRAP } from './scriptGuestBootstrap.js';
import { scriptFailure, SCRIPT_LIMITS, type ScriptCommand, type ScriptConsoleLine, type ScriptExecutionInput, type ScriptFailureReason } from './scriptTypes.js';

export interface RuntimeOutput { commands: ScriptCommand[]; console: ScriptConsoleLine[] }
export function installRuntimeBindings(vm: NativeScriptVm, input: ScriptExecutionInput, control: ScriptRuntimeControl): RuntimeOutput {
  const output: RuntimeOutput = { commands: [], console: [] };
  const sources = new Map(input.program.modules.map(module => [module.name, module.source])); sources.set('user-script.js', input.program.source);
  let commandBytes = 0, consoleBytes = 0;
  const fail = (reason: ScriptFailureReason): void => {
    control.failure ??= scriptFailure(reason);
  };
  const bind = (name: string, value: NativeScriptValue): void => {
    try { vm.global.setProp(name, value); } finally { value.dispose(); }
  };
  bind('__pointercadCommand', vm.newFunction('pcad-command', (...args) => {
    const value = args[0];
    if (control.failure !== null) return vm.undefined;
    if (args.length !== 1 || value === undefined || !value.isString) throw new Error('Invalid script command callback input');
    if (output.commands.length >= SCRIPT_LIMITS.commands) { fail('commandCount'); return vm.undefined; }
    const read = readSerializedScriptCommand(value.toString(), input.commandNamespace, SCRIPT_LIMITS.commandBytes - commandBytes);
    if (!read.ok) { fail('commandRejected'); return vm.undefined; }
    output.commands.push(read.command); commandBytes += read.bytes;
    return vm.undefined;
  }));
  bind('__pointercadConsole', vm.newFunction('pcad-console', (...args) => {
    const value = args[0];
    if (control.failure !== null) return vm.undefined;
    if (args.length !== 1 || value === undefined || !value.isString) throw new Error('Invalid script console callback input');
    if (output.console.length >= SCRIPT_LIMITS.consoleLines) { fail('logCount'); return vm.undefined; }
    const serialized = value.toString();
    // Escaping may enlarge a serialized log; bound it before parsing too.
    if (scriptUtf8Bytes(serialized, SCRIPT_LIMITS.consoleBytes * 6 + 64) === null) {
      fail('logBytes'); return vm.undefined;
    }
    const record: unknown = JSON.parse(serialized);
    if (typeof record !== 'object' || record === null || !('text' in record) || !('level' in record)
      || typeof record.text !== 'string' || (record.level !== 'info' && record.level !== 'warning' && record.level !== 'error')) {
      throw new Error('Invalid script console record');
    }
    const bytes = scriptUtf8Bytes(record.text, SCRIPT_LIMITS.consoleBytes - consoleBytes);
    if (bytes === null) { fail('logBytes'); return vm.undefined; }
    consoleBytes += bytes; output.console.push({ level: record.level, text: record.text });
    return vm.undefined;
  }));
  bind('__pointercadLimit', vm.newFunction('pcad-limit', (...args) => {
    const reason = args[0]?.isString ? args[0].toString() : '';
    switch (reason) {
      case 'commands': fail('tooManyCommands'); break;
      case 'bytes': fail('tooManyCommandBytes'); break;
      case 'console': fail('tooManyLogs'); break;
      case 'console-bytes': fail('tooManyLogBytes'); break;
      default: throw new Error('Unknown script limit callback');
    }
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
