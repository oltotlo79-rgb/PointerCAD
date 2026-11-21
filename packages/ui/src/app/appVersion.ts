/**
 * アプリの版(根の package.json の version)。Web と desktop の build、ui の単体の設定の define(scripts/vite/appVersion.mjs)で配る。
 * define が無い所(ほかの単体の設定・ビルドを通さない読み込み)でも未定義の参照で落ちないよう、typeof で確かめて null を返す。
 */
declare const __PCAD_APP_VERSION__: unknown;

export function currentAppVersion(): string | null {
  if (typeof __PCAD_APP_VERSION__ === 'undefined') return null;
  const value = __PCAD_APP_VERSION__;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
