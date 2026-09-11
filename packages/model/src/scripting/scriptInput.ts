import { scriptUtf8Bytes } from './scriptBytes.js';
import { SCRIPT_API_VERSION, SCRIPT_LIMITS, type ScriptExecutionInput, type ScriptModule, type ScriptProgram } from './scriptTypes.js';

function row(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function ownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Decode only cloned/parsed data, before allocating encoded bytes or creating a VM. */
export function readScriptProgram(value: unknown): ScriptProgram | null {
  if (!row(value) || !ownKeys(value, ['apiVersion', 'source', 'sha256', 'modules']) || value.apiVersion !== SCRIPT_API_VERSION
    || !boundedText(value.source, SCRIPT_LIMITS.sourceBytes) || !digest(value.sha256)
    || !Array.isArray(value.modules) || value.modules.length > SCRIPT_LIMITS.modules) return null;
  const modules: ScriptModule[] = [];
  let total = scriptUtf8Bytes(value.source, SCRIPT_LIMITS.sourceBytes);
  if (total === null) return null;
  for (const module of value.modules) {
    if (!row(module) || !ownKeys(module, ['name', 'source', 'sha256']) || !boundedText(module.name, 128)
      || !boundedText(module.source, SCRIPT_LIMITS.sourceBytes) || !digest(module.sha256)) return null;
    const bytes = scriptUtf8Bytes(module.source, SCRIPT_LIMITS.sourceBytes - total);
    if (bytes === null) return null;
    total += bytes; modules.push({ name: module.name, source: module.source, sha256: module.sha256 });
  }
  return { apiVersion: SCRIPT_API_VERSION, source: value.source, sha256: value.sha256, modules };
}
export function readScriptExecutionInput(value: unknown): ScriptExecutionInput | null {
  if (!row(value) || !ownKeys(value, ['executionId', 'commandNamespace', 'program', 'snapshot', 'seed', 'timeMs'])
    || !boundedText(value.executionId, 128) || !/^[a-zA-Z0-9-]{1,128}$/u.test(value.executionId)
    || !digest(value.commandNamespace) || !boundedText(value.snapshot, SCRIPT_LIMITS.commandBytes)
    || scriptUtf8Bytes(value.snapshot, SCRIPT_LIMITS.commandBytes) === null
    || typeof value.seed !== 'number' || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff
    || typeof value.timeMs !== 'number' || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0 || value.timeMs > SCRIPT_LIMITS.maximumTimeMs) return null;
  const program = readScriptProgram(value.program);
  if (program === null) return null;
  return { executionId: value.executionId, commandNamespace: value.commandNamespace, program,
    snapshot: value.snapshot, seed: value.seed, timeMs: value.timeMs };
}
