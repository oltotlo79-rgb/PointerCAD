import { t, type MessageKey } from './i18n/t.js';

/**
 * 計算部(FEM の Worker)の断りを、解析の窓によらず同じ日本語の文にする(A-24)。
 *
 * - 計算の準備のファイル(資産)を読めなかった(asset-missing)・壊れていた(asset-corrupt)時は、窓の「入力を確かめて」の文を
 *   出さず、次にする事が分かる共通の文にする。Worker の message は code と同じ頭(`asset-missing: …`)で始まる
 *   (packages/fem/src/offlineBrowser.ts)ので、code の無い所では message の頭で見分けてよい。
 * - ほかの計算部の code は、内部の英語の文を出さず「計算部で計算できませんでした（code）。」にする。
 * - 計算部の code でない断り(入力や形状の断り)は扱わない(null。呼び手の今の文のまま)。
 */
const ASSET_FAILURES: readonly (readonly [string, MessageKey])[] = [
  ['asset-missing', 'strength.femFailure.assetMissing'],
  ['asset-corrupt', 'strength.femFailure.assetCorrupt'],
];
/** packages/fem/src/protocol.ts の FemFailureCode(資産の 2 種を除く 6 種)。@pointercad/fem はこの型を公開していない。 */
const FEM_RUNTIME_CODES: ReadonlySet<string> = new Set([
  'offline-request-denied', 'runtime-initialization', 'solver-failed', 'invalid-protocol', 'worker-failed', 'deadline',
]);

/** 資産の失敗なら共通の文の鍵を返す。code そのもの、または `code:` で始まる文(Worker の message、`${code}: ${message}`)を受ける。 */
export function femAssetFailureKey(codeOrMessage: string | null | undefined): MessageKey | null {
  if (codeOrMessage === null || codeOrMessage === undefined) return null;
  const found = ASSET_FAILURES.find(([code]) => codeOrMessage === code || codeOrMessage.startsWith(`${code}:`));
  return found === undefined ? null : found[1];
}

/** 計算部の code の断りを日本語の文にする。資産は共通の文、ほかの計算部の code は code を添えた文。計算部の code でなければ null。 */
export function femRuntimeFailureText(code: string): string | null {
  const asset = femAssetFailureKey(code);
  if (asset !== null) return t(asset);
  return FEM_RUNTIME_CODES.has(code) ? t('strength.femFailure.runtime').replace('{code}', code) : null;
}
