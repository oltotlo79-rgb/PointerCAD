import type { MathEditorResultText } from './mathEditorResult.js';

/*
 * 結果の欄に見せる物(外部検査 run 43803122461 の調べ、統括の決定「計算中も前の結果を薄く残し、結果の欄の高さを変えない」)。
 * 入力中・計算中に結果の欄が 1 行の「計算中」に縮むと、全部の桁の行や使えない理由の行が消えて高さが変わる。窓の中の送りが
 * 下端にある時は見えている中身がずれ、押した物(記号と演算を探す など)が押している間に動く。前に計算の済んだ結果を、
 * 計算中と分かる印を付けてそのまま残し、高さを保つ。誤りは前の結果で隠さない。
 */

export interface ShownMathResult {
  readonly text: MathEditorResultText;
  readonly applyBlockedReason: string | null;
  /** 入力中・計算中で、前に計算の済んだ結果を残している(薄く見せ、計算中の印を付ける)。 */
  readonly stale: boolean;
}

/**
 * 前の結果を残す対象(入力中・計算中)か。厳密な計算部の準備の段(runtime-loading・symbolic-import)は、準備の文と案内を
 * 見せるので対象にしない(mathEditorResult.ts の順と同じ: 準備の段 → 計算の段 → 入力中・計算中)。
 */
export function mathResultPending(snapshot: { readonly state: { readonly status: string };
  readonly phase?: 'runtime-loading' | 'symbolic-import' | 'calculating' | null }): boolean {
  if (snapshot.phase === 'runtime-loading' || snapshot.phase === 'symbolic-import') return false;
  return snapshot.phase === 'calculating' || snapshot.state.status === 'editing' || snapshot.state.status === 'calculating';
}

/**
 * previous は前に計算の済んだ結果(誤りでない物。呼び手が、計算が済むたびに覚え直し、誤りの時は忘れる)。
 * pending は入力中・計算中。
 */
export function shownMathResult(previous: ShownMathResult | null, next: MathEditorResultText, nextReason: string | null,
  pending: boolean): ShownMathResult {
  if (pending && !next.hasError && previous !== null && !previous.text.hasError) {
    return { text: previous.text, applyBlockedReason: previous.applyBlockedReason, stale: true };
  }
  return { text: next, applyBlockedReason: nextReason, stale: false };
}
