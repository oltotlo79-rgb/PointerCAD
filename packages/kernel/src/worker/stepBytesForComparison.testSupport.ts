/**
 * STEP 比較専用。4 行目の ISO 8601 の日時だけを同じバイトへ置き換える。
 * 改行・FILE_NAME の残りを含め、それ以外のバイトは一切変えない。
 * 製品の入口からは import せず、隣の単体検査だけで使う。
 */
export function stepBytesForComparison(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const match = /^((?:[^\n]*\n){3}FILE_NAME\('Open CASCADE Shape Model',')(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})'/u.exec(text);
  if (match === null) {
    throw new Error('STEP の 4 行目に ISO 8601 の FILE_NAME 日時がありません。');
  }
  const [, prefix, timestamp] = match;
  const date = new Date(`${timestamp}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${timestamp}.000Z`) {
    throw new Error('STEP の FILE_NAME 日時が ISO 8601 として不正です。');
  }
  const offset = new TextEncoder().encode(prefix).byteLength;
  return bytes.slice().fill(0, offset, offset + timestamp.length);
}
