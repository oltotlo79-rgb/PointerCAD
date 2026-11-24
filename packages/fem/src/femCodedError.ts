/**
 * fem の失敗の種類の符号(0b-4)。失敗の種類は、誤りの文(message)ではなく、投げる所で持たせた符号で決める
 * (決まり failure-kind/no-message-text-match。eslint.messageKind.js)。文は今のまま利用者・記録へ出す。
 * このファイルは読み込みを持たない(FEM の Worker の束に入る。外の読み込みを持ち込まない)。
 */

/** Worker の失敗の符号のうち、fem が投げる所で決まる物(protocol.ts の FemFailureCode の一部)。 */
type FemErrorCode = 'asset-missing' | 'asset-corrupt' | 'offline-request-denied' | 'invalid-protocol';

/**
 * Worker の失敗の符号を持つ誤り。worker.ts は文の頭ではなく、この符号で失敗の符号を決める。
 * name は Error のまま(上書きしない): 計算部(Pyodide)が誤りを文(`${誤り}`)で包み直す時の頭「Error: …」を、記録でも前と同じにする。
 */
export class FemCodedError extends Error {
  constructor(readonly code: FemErrorCode, message: string, options?: ErrorOptions) { super(message, options); }
}

/**
 * 解析の断りの種類。FemFailure.refusal と、計算の途中の断り(FemRefusalError)が持ち、ui はこれで見せる文を選ぶ。
 * - no-positive-mode・mechanism・budget・supports: 座屈の断り(正の荷重係数が無い・機構・数値の予算・支持の自由度)。
 * - rigid-body: 支持が剛体の動きを止めていない。
 * - stale-source: 解析の間に CAD の元が変わった。
 * - support-conflict・support-all-free: 支持の指定変位の食い違い・並進の拘束が 1 つも無い。
 * - unknown: 座屈の計算部の文の頭(solid-buckling-…:)が上のどれでもない(元の文は message に残る)。
 */
export type FemRefusalCode = 'no-positive-mode' | 'mechanism' | 'budget' | 'supports' | 'rigid-body' | 'stale-source'
  | 'support-conflict' | 'support-all-free' | 'unknown';
/** 符号の全部(protocol.ts の返事の照らし isReply が使う)。 */
export const FEM_REFUSAL_CODES: readonly FemRefusalCode[] = ['no-positive-mode', 'mechanism', 'budget', 'supports', 'rigid-body',
  'stale-source', 'support-conflict', 'support-all-free', 'unknown'];

/** 解析の断りの符号を持つ誤り。文は今のまま。name は Error のまま(FemCodedError と同じ理由)。 */
export class FemRefusalError extends Error {
  constructor(readonly refusal: FemRefusalCode, message: string) { super(message); }
}

/** 誤りが断りの符号を持てば { refusal }、持たなければ {}(失敗の結果へ広げて運ぶ)。 */
export function femRefusalField(error: unknown): { readonly refusal?: FemRefusalCode } {
  return error instanceof FemRefusalError ? { refusal: error.refusal } : {};
}

/*
 * 下の 2 つは、計算部(Pyodide・Python)を通った誤りの文から種類を読む、fem のただ 1 か所(表 eslint.messageKind.js の boundary)。
 * 計算部は誤りを解釈器の中で包み直し、種類を文でしか渡さない。ほかの所では文を読まない(Worker と、欄の無い返事を受けた FemClient が呼ぶ)。
 */

/** 取得を断った印(offlineBrowser.ts の offline-request-denied:)が文のどこかにあれば、その符号。計算部が包み直しても文に残る。 */
export function nativeFailureCode(message: string): 'offline-request-denied' | undefined {
  return message.includes('offline-request-denied:') ? 'offline-request-denied' : undefined;
}

/**
 * 座屈の計算部(solidBuckling.py)と翻訳の断りの文から、断りの符号。並びは ui が今まで文で見ていた順
 * (正の荷重係数 → 機構と剛体の動き → 予算と支持)。solid-buckling-…: の頭があるのに上のどれでもない時は unknown
 * (黙って一般の断りにしない。元の文は message に残る)。頭が無ければ undefined。
 */
export function nativeRefusal(message: string): FemRefusalCode | undefined {
  if (message.includes('solid-buckling-no-positive-mode')) return 'no-positive-mode';
  if (message.includes('solid-buckling-mechanism')) return 'mechanism';
  if (message.includes('unrestrained component rigid-body motion')) return 'rigid-body';
  if (message.includes('solid-buckling-budget')) return 'budget';
  if (message.includes('solid-buckling-supports')) return 'supports';
  return /solid-buckling-[a-z-]+:/u.test(message) ? 'unknown' : undefined;
}
