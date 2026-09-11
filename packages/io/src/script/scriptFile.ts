import { SCRIPT_FILE_LIMITS, readScriptFileValue, type ScriptFile, type ScriptFileRead } from '@pointercad/model/scripting';

/** Check bytes before decoding or allocating a JSON tree. Invalid UTF-8 is not silently repaired. */
export async function decodeScriptFile(bytes: Uint8Array): Promise<ScriptFileRead> {
  if (bytes.byteLength > SCRIPT_FILE_LIMITS.bytes) return { ok: false, reason: 'bytes' };
  try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return await readScriptFileValue(value); }
  catch { return { ok: false, reason: 'format' }; }
}
export async function encodeScriptFile(file: ScriptFile): Promise<Uint8Array> {
  const checked = await readScriptFileValue(file);
  if (!checked.ok) throw new Error('処理の名前・設定・内容を確認してください。');
  const bytes = new TextEncoder().encode(JSON.stringify(checked.file));
  if (bytes.byteLength > SCRIPT_FILE_LIMITS.bytes) throw new Error('処理ファイルの大きさが上限を超えています。');
  return bytes;
}
