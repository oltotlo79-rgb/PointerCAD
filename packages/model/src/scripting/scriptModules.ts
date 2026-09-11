import { scriptUtf8Bytes } from './scriptBytes.js';
import { SCRIPT_API_VERSION, SCRIPT_LIMITS, type ScriptProgram } from './scriptTypes.js';

/** Local names only. No traversal, URL, query, fragment, drive letter or encoded path. */
export function isScriptModuleName(name: string): boolean {
  return name.length <= 128 && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(name)
    && name !== 'user-script.js' && !name.startsWith('pointercad-internal-');
}

export function resolveScriptModule(base: string, requested: string, modules: ReadonlyMap<string, string>): string | null {
  const name = requested.startsWith('./')
    ? base.slice(0, Math.max(0, base.lastIndexOf('/') + 1)) + requested.slice(2) : requested;
  if (!isScriptModuleName(name) || !modules.has(name)) return null;
  return name;
}

export type ScriptProgramCheck = { readonly ok: true }
  | { readonly ok: false; readonly reason: 'version' | 'bytes' | 'count' | 'name' | 'duplicate' | 'hash'; readonly module: string | null };

export async function sha256ScriptSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

/** Typed values are still rechecked on a Worker message boundary. File decoding supplies this shape. */
export async function validateScriptProgram(program: ScriptProgram): Promise<ScriptProgramCheck> {
  if (program.apiVersion !== SCRIPT_API_VERSION) return { ok: false, reason: 'version', module: null };
  if (program.modules.length > SCRIPT_LIMITS.modules) return { ok: false, reason: 'count', module: null };
  let used = scriptUtf8Bytes(program.source, SCRIPT_LIMITS.sourceBytes);
  if (used === null) return { ok: false, reason: 'bytes', module: null };
  const names = new Set<string>();
  for (const module of program.modules) {
    if (!isScriptModuleName(module.name)) return { ok: false, reason: 'name', module: module.name };
    if (names.has(module.name)) return { ok: false, reason: 'duplicate', module: module.name };
    names.add(module.name);
    const bytes = scriptUtf8Bytes(module.source, SCRIPT_LIMITS.sourceBytes - used);
    if (bytes === null) return { ok: false, reason: 'bytes', module: module.name };
    used += bytes;
  }
  if (await sha256ScriptSource(program.source) !== program.sha256) return { ok: false, reason: 'hash', module: null };
  for (const module of program.modules) {
    if (await sha256ScriptSource(module.source) !== module.sha256) return { ok: false, reason: 'hash', module: module.name };
  }
  return { ok: true };
}
