/**
 * 図形の測定値の「いまの値」の判定(ADD-23、計画書 geomref-plan.md §4(c)、GR-14)。
 *
 * 再計算の結果(`PartRecomputeResult.mathGeometry`)は、`applyRecompute` が「計算した文書・
 * 世代」と一緒にストアの `mathGeometryResult` へ控える(`store/recomputeSlice.ts`)。
 * 画面(一覧・係数行・数式入力・状態欄)はその控えを直接読まず、**必ずここを通す**。判定を
 * 1 か所にまとめ、状況のコードだけを返す(文言は持たない。i18n の鍵は画面側が引く)。
 *
 * 値を出すのは「いま画面に出ている部品の文書」と「その世代の完了した計算」が揃うときだけ。
 * 形の変更直後・取消・新規・開く・復元・Undo/Redo・世代交代・履歴の途中表示(Q12=H1)では
 * 出さない。**文書ID は十分条件にしない**(既定ID `part-1` は一意でない)。文書オブジェクトと
 * 形の欄の同一性(`affectsShape` は参照比較)と世代で判定する。外観・名前だけの変更は
 * `affectsShape` が偽なので値を保つ。
 */
import { useAppStore } from '../store/useAppStore.js';
import { currentMathGeometry, type CurrentMathGeometry, type MathGeometryResultState } from './currentMathGeometry.js';
export { currentMathGeometry, mathGeometryInputsFor, type MathGeometryResultSnapshot, type MathGeometryUnresolvedReason,
  type MathGeometryResultState, type CurrentMathGeometry, type MathGeometryResultStatus } from './currentMathGeometry.js';

/** 待ち終えたときの結果。`computing`・`timeline` の間は待ち続けるので返らない。 */
export type MathGeometryWaitResult =
  | Exclude<CurrentMathGeometry, { readonly status: 'computing' | 'timeline' }>
  | { readonly status: 'aborted' };

const ABORTED = Object.freeze({ status: 'aborted' as const });

/**
 * 図形の測定値が「いまの値」になるまで待つ(数式の編集画面や、評価の入口が使う)。
 *
 * - `current` になったらその判定を返す。
 * - 計算中(`computing`)と履歴の途中表示(`timeline`。つまみを末尾へ戻せば計算が走る)の
 *   間は待ち続ける。
 * - `cancelled`・`notEvaluated`・`notPart` は文書が変わらない限り自然には値にならないので、
 *   その判定をすぐ返す(呼び出し側が理由を出して止める)。
 * - `signal` が中止されたら `aborted` を返す。待つのをやめたら購読は必ず外す。
 *
 * 返した後で文書が変わっていないかは、呼び出し側が自分の `isCurrent` で確かめ、値は
 * `mathGeometryInputsFor(state, document)` で読み直す。
 */
export function waitForCurrentMathGeometry(signal?: AbortSignal): Promise<MathGeometryWaitResult> {
  return new Promise<MathGeometryWaitResult>((resolve) => {
    if (signal?.aborted === true) {
      resolve(ABORTED);
      return;
    }
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    function settle(value: MathGeometryWaitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }
    function onAbort(): void {
      settle(ABORTED);
    }
    function check(state: MathGeometryResultState): void {
      const current = currentMathGeometry(state);
      if (current.status !== 'computing' && current.status !== 'timeline') {
        settle(current);
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe = useAppStore.subscribe(check);
    check(useAppStore.getState());
  });
}
