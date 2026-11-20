export type { DrawingDxfEntity as DxfWriteEntity, DrawingDxfLayer as DxfWriteLayer,
  DrawingDxfLineType as DxfWriteLineType, DrawingDxfOptions as DxfWriteOptions } from '@pointercad/model';

/** DXF の文字列の `\U+XXXX` の書き方(字を Unicode の番号で書く)。R12へUTF-8を混ぜずASCIIで日本語を保持する。
 * 制御文字は断り、126 より上の字と `\`・`%` を `\U+` と 4 桁の 16 進で書く。 */
export function dxfString(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('DXFの文字列に制御文字は使えません。');
  }
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && !(value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff)) {
      throw new Error('DXFの文字列が正しくありません。');
    }
    if (code >= 0xdc00 && code <= 0xdfff && !(value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff)) {
      throw new Error('DXFの文字列が正しくありません。');
    }
    result += code > 126 || code === 92 || code === 37 ? `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}` : value[index];
  }
  return result;
}

/** 1回だけ復号する。元の文字列に含まれた「\\U+XXXX」を再帰的に変換しない。 */
export function decodeDxfString(value: string): string {
  return value.replace(/\\U\+([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
