import { SCRIPT_API_VERSION, SCRIPT_LIMITS, type ScriptProgram } from './scriptTypes.js';
import { isScriptModuleName, sha256ScriptSource, validateScriptProgram } from './scriptModules.js';
import { scriptUtf8Bytes } from './scriptBytes.js';

/** JSON escaping can multiply source bytes by six. The decoded source budget remains 1 MiB. */
export const SCRIPT_FILE_LIMITS = Object.freeze({ bytes: 6 * SCRIPT_LIMITS.sourceBytes + 65536, libraryBytes: 8 * 1024 * 1024, nameCharacters: 80 });
export const SCRIPT_ICONS: readonly ScriptIcon[] = ['code', 'point', 'line', 'box', 'gear'];
export type ScriptIcon = 'code' | 'point' | 'line' | 'box' | 'gear';
export interface ScriptFile {
  readonly kind: 'pointercad-script'; readonly version: 1; readonly scriptId: string;
  readonly name: string; readonly icon: ScriptIcon; readonly program: ScriptProgram;
  readonly seed: number; readonly timeMs: number;
}
export type ScriptFileRead = { readonly ok: true; readonly file: ScriptFile }
  | { readonly ok: false; readonly reason: 'bytes' | 'format' | 'version' | 'name' | 'program' };
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function icon(value: unknown): value is ScriptIcon { return value === 'code' || value === 'point' || value === 'line' || value === 'box' || value === 'gear'; }
function integer(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export async function readScriptFileValue(value: unknown): Promise<ScriptFileRead> {
  if (!record(value) || !keys(value, ['kind', 'version', 'scriptId', 'name', 'icon', 'program', 'seed', 'timeMs']) || value.kind !== 'pointercad-script')
    return { ok: false, reason: 'format' };
  if (value.version !== 1) return { ok: false, reason: 'version' };
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name !== value.name.trim() || value.name.length > SCRIPT_FILE_LIMITS.nameCharacters || [...value.name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    return { ok: false, reason: 'name' };
  if (typeof value.scriptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.scriptId) || !icon(value.icon) || !integer(value.seed, 0xffffffff) || !integer(value.timeMs, SCRIPT_LIMITS.maximumTimeMs))
    return { ok: false, reason: 'format' };
  const raw = value.program;
  if (!record(raw) || !keys(raw, ['apiVersion', 'source', 'sha256', 'modules']) || raw.apiVersion !== SCRIPT_API_VERSION || typeof raw.source !== 'string' || !digest(raw.sha256) || !Array.isArray(raw.modules) || raw.modules.length > SCRIPT_LIMITS.modules)
    return { ok: false, reason: 'program' };
  const modules = [];
  for (const entry of raw.modules) {
    const module: unknown = entry;
    if (!record(module) || !keys(module, ['name', 'source', 'sha256']) || typeof module.name !== 'string' || !isScriptModuleName(module.name) || typeof module.source !== 'string' || !digest(module.sha256))
      return { ok: false, reason: 'program' };
    modules.push({ name: module.name, source: module.source, sha256: module.sha256 });
  }
  const program: ScriptProgram = { apiVersion: SCRIPT_API_VERSION, source: raw.source, sha256: raw.sha256, modules };
  if (!(await validateScriptProgram(program)).ok) return { ok: false, reason: 'program' };
  return { ok: true, file: { kind: 'pointercad-script', version: 1, scriptId: value.scriptId, name: value.name, icon: value.icon, program, seed: value.seed, timeMs: value.timeMs } };
}

/** Explicit editor save/run only. Decoding never repairs a mismatching hash. */
export async function createScriptFile(input: {
  readonly scriptId: string; readonly name: string; readonly icon: ScriptIcon; readonly source: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[]; readonly seed: number; readonly timeMs: number;
}): Promise<ScriptFileRead> {
  let remaining = SCRIPT_LIMITS.sourceBytes;
  if (input.modules.length > SCRIPT_LIMITS.modules) return { ok: false, reason: 'program' };
  for (const source of [input.source, ...input.modules.map(module => module.source)]) {
    const bytes = scriptUtf8Bytes(source, remaining);
    if (bytes === null) return { ok: false, reason: 'bytes' }; remaining -= bytes;
  }
  const modules = [];
  for (const module of input.modules) modules.push({ ...module, sha256: await sha256ScriptSource(module.source) });
  return readScriptFileValue({ kind: 'pointercad-script', version: 1, scriptId: input.scriptId, name: input.name.trim(), icon: input.icon,
    program: { apiVersion: SCRIPT_API_VERSION, source: input.source, sha256: await sha256ScriptSource(input.source), modules }, seed: input.seed, timeMs: input.timeMs });
}
