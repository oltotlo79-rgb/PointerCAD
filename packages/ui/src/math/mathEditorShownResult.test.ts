import { describe, expect, it } from 'vitest';
import type { MathEditorResultText } from './mathEditorResult.js';
import { mathResultPending, shownMathResult } from './mathEditorShownResult.js';

/*
 * 計算中も前の結果を薄く残し、結果の欄の高さを変えない(外部検査 run 43803122461 の調べ、統括の決定)。
 * 入力中・計算中に結果の欄が 1 行に縮むと、窓の中の送りが下端にある時に中身がずれ、押した summary が動く。
 */
const settled: MathEditorResultText = { message: '≈ 1.85407', detail: '誤差の上限: 1e-12', hasError: false, busy: false,
  full: '= 1.8540746773013719184' };
const calculating: MathEditorResultText = { message: '計算中…', detail: '', hasError: false, busy: true };
const failed: MathEditorResultText = { message: '0では割れません。', detail: '', hasError: true, busy: false };

describe('入力中・計算中の判定', () => {
  const snapshot = (status: 'editing' | 'calculating' | 'evaluated', phase: 'runtime-loading' | 'symbolic-import' | 'calculating' | null) =>
    ({ state: { status }, phase });
  it('入力中と計算中は前の結果を残す対象', () => {
    expect(mathResultPending(snapshot('editing', null))).toBe(true);
    expect(mathResultPending(snapshot('calculating', null))).toBe(true);
    expect(mathResultPending(snapshot('evaluated', 'calculating'))).toBe(true);
  });
  it('厳密な計算部の準備の段は対象にしない(準備の文と案内を、前の結果で隠さない)', () => {
    for (const phase of ['runtime-loading', 'symbolic-import'] as const) {
      expect(mathResultPending(snapshot('calculating', phase))).toBe(false);
      expect(mathResultPending(snapshot('editing', phase))).toBe(false);
    }
  });
  it('計算の済んだ時は対象にしない', () => {
    expect(mathResultPending(snapshot('evaluated', null))).toBe(false);
  });
});

describe('結果の欄に見せる物', () => {
  it('計算の済んだ結果は、そのまま見せ、次の計算中に残す材料にする', () => {
    expect(shownMathResult(null, settled, '理由', false)).toEqual({ text: settled, applyBlockedReason: '理由', stale: false });
  });

  it('入力中・計算中は、前の結果(全部の桁と使えない理由の行を含む)をそのまま残し、計算中と分かる印を付ける(行の数が変わらない)', () => {
    const previous = shownMathResult(null, settled, '理由', false);
    const shown = shownMathResult(previous, calculating, null, true);
    expect(shown).toEqual({ text: settled, applyBlockedReason: '理由', stale: true });
    // 残した物は前の物と同じ行(1 行目・説明・全部の桁)を持つ。
    expect([shown.text.message, shown.text.detail, shown.text.full]).toEqual([settled.message, settled.detail, settled.full]);
  });

  it('前の結果が無い時(開いた直後)は、計算中の文をそのまま見せる', () => {
    expect(shownMathResult(null, calculating, null, true)).toEqual({ text: calculating, applyBlockedReason: null, stale: false });
  });

  it('誤りは前の結果を残さない(誤りを、古い値で隠さない)', () => {
    const previous = shownMathResult(null, settled, null, false);
    expect(shownMathResult(previous, failed, null, false)).toEqual({ text: failed, applyBlockedReason: null, stale: false });
    // 計算中に誤りが届いた時も、誤りを見せる。
    expect(shownMathResult(previous, failed, null, true)).toEqual({ text: failed, applyBlockedReason: null, stale: false });
    // 前が誤りなら、次の計算中に誤りを残さない。
    const previousError = shownMathResult(null, failed, null, false);
    expect(shownMathResult(previousError, calculating, null, true)).toEqual({ text: calculating, applyBlockedReason: null, stale: false });
  });
});
