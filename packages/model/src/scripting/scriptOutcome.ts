import { readSerializedScriptCommand } from './commandValidation.js';
import { scriptUtf8Bytes } from './scriptBytes.js';
import { SCRIPT_LIMITS, type ScriptCommand, type ScriptConsoleLine, type ScriptExecutionOutcome, type ScriptFailureKind, type ScriptLocation } from './scriptTypes.js';

const failureKinds: readonly ScriptFailureKind[] = ['source','syntax','runtime','memory','stack','timeout','cancelled','module','command','console','cad','stale','worker'];
function isFailureKind(value: unknown): value is ScriptFailureKind { return failureKinds.some((kind) => kind === value); }
function row(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function location(value: unknown): ScriptLocation | null | undefined {
  if (value === null) return null;
  if (!row(value) || typeof value.file !== 'string' || value.file.length > 128 || typeof value.line !== 'number'
    || !Number.isSafeInteger(value.line) || value.line < 1 || (value.column !== null
      && (typeof value.column !== 'number' || !Number.isSafeInteger(value.column) || value.column < 1))) return undefined;
  return { file: value.file, line: value.line, column: value.column };
}
export function readScriptOutcome(value: unknown, namespace: string): ScriptExecutionOutcome | null {
  if (!row(value) || !Array.isArray(value.console) || value.console.length > SCRIPT_LIMITS.consoleLines) return null;
  const console: ScriptConsoleLine[] = []; let logBytes = 0;
  for (const entry of value.console) {
    if (!row(entry) || typeof entry.text !== 'string' || (entry.level !== 'info' && entry.level !== 'warning' && entry.level !== 'error')) return null;
    const bytes = scriptUtf8Bytes(entry.text, SCRIPT_LIMITS.consoleBytes - logBytes);
    if (bytes === null) return null;
    console.push({ level: entry.level, text: entry.text }); logBytes += bytes;
  }
  if (value.ok === false) {
    if (!row(value.error) || !isFailureKind(value.error.kind) || typeof value.error.message !== 'string' || value.error.message.length > 4096) return null;
    const at = location(value.error.location); if (at === undefined) return null;
    return { ok: false, error: { kind: value.error.kind, message: value.error.message, location: at }, console };
  }
  if (value.ok !== true || !Array.isArray(value.commands) || value.commands.length > SCRIPT_LIMITS.commands
    || typeof value.javascriptMs !== 'number' || !Number.isFinite(value.javascriptMs) || value.javascriptMs < 0
    || typeof value.initializationMs !== 'number' || !Number.isFinite(value.initializationMs) || value.initializationMs < 0) return null;
  const commands: ScriptCommand[] = []; let commandBytes = 0;
  for (const command of value.commands) {
    const serialized = JSON.stringify(command);
    if (typeof serialized !== 'string') return null;
    const read = readSerializedScriptCommand(serialized, namespace, SCRIPT_LIMITS.commandBytes - commandBytes);
    if (!read.ok) return null;
    commands.push(read.command); commandBytes += read.bytes;
  }
  return { ok: true, commands, console, javascriptMs: value.javascriptMs, initializationMs: value.initializationMs };
}
