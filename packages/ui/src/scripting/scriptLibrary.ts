import { SCRIPT_FILE_LIMITS, SCRIPT_LIMITS, readScriptFileValue, scriptUtf8Bytes, type ScriptFile } from '@pointercad/model/scripting';

export interface ScriptLibraryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const SCRIPT_LIBRARY_KEY = 'pointercad.script-tools.v1';
export type ScriptLibraryRead = { readonly ok: true; readonly tools: readonly ScriptFile[] }
  | { readonly ok: false };
export function browserScriptStorage(): ScriptLibraryStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
export async function readScriptLibrary(storage: ScriptLibraryStorage | null): Promise<ScriptLibraryRead> {
  if (storage === null) return { ok: false };
  try {
    const source = storage.getItem(SCRIPT_LIBRARY_KEY);
    if (source === null) return { ok: true, tools: [] };
    if (scriptUtf8Bytes(source, SCRIPT_FILE_LIMITS.libraryBytes) === null) return { ok: false };
    const values: unknown = JSON.parse(source);
    if (!Array.isArray(values) || values.length > SCRIPT_LIMITS.tools) return { ok: false };
    const tools: ScriptFile[] = [], ids = new Set<string>(), names = new Set<string>();
    for (const entry of values) {
      const value: unknown = entry;
      const item = await readScriptFileValue(value);
      if (!item.ok || ids.has(item.file.scriptId) || names.has(item.file.name)) return { ok: false };
      tools.push(item.file); ids.add(item.file.scriptId); names.add(item.file.name);
    }
    return { ok: true, tools };
  } catch { return { ok: false }; }
}
/** Mutate storage only after the complete replacement is validated. A rejected write preserves the old list. */
export async function writeScriptLibrary(storage: ScriptLibraryStorage | null, tools: readonly ScriptFile[]): Promise<boolean> {
  if (storage === null || tools.length > SCRIPT_LIMITS.tools) return false;
  try {
    const source = JSON.stringify(tools);
    if (scriptUtf8Bytes(source, SCRIPT_FILE_LIMITS.libraryBytes) === null) return false;
    const checked = await readScriptLibrary({ getItem: () => source, setItem: () => { throw new Error('read only'); } });
    if (!checked.ok) return false;
    storage.setItem(SCRIPT_LIBRARY_KEY, source); return true;
  } catch { return false; }
}
/** Shared command identity for toolbar and later shortcut/radial assignments. */
export function scriptCommandId(scriptId: string): string { return `script:${scriptId}`; }
