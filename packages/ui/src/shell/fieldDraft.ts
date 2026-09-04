/**
 * プロパティ欄の打ちかけの下書きと、文書の版の照合(`PropertyPanel.tsx` の
 * `FeatureProperties` / `SolidProperties` で共通の仕組み)。
 *
 * 対応: docs/報告記録.md 2026-09-04 14:05 の 9b(Electron 検査の不合格 1 件)。
 *
 * 欄に焦点を残したまま文書が差し替わる(開く・新規・復元・Undo/Redo)と、選んでいる
 * フィーチャーの id が変わらない限り `PropertyPanel` は同じ `key` のまま再描画するため
 * (`react` はコンポーネントを作り直さない)、打っている途中の文字(下書き)がそのまま
 * 残ってしまい、文書の新しい値ではなく古い下書きが表示され続けていた。
 *
 * ここは「最後に見た文書の版(`useAppStore.documentVersion`)が変わったら下書きを捨てる」
 * 判定を、DOM にも React にも触れない純関数として切り出す。焦点そのものは動かさない
 * (欄の DOM 要素は同じまま残るので、表示する文字を差し替えるだけで焦点は保たれる)。
 */

/** 下書き 1 つと、最後に見た文書の版を束ねた状態。 */
export interface DraftVersionState<TDraft> {
  readonly draft: TDraft | null;
  readonly seenVersion: number;
}

/** 下書きの無い状態から始める(コンポーネントの初回マウント用)。 */
export function initialDraftVersionState<TDraft>(
  documentVersion: number,
): DraftVersionState<TDraft> {
  return { draft: null, seenVersion: documentVersion };
}

/**
 * 文書の版が最後に見たときと変わっていれば、下書きを捨てた状態を返す。
 * 変わっていなければ**同じ参照をそのまま返す**ので、呼び出し側は `!==` だけで
 * 「差し替えが起きたか」を判定でき、React の描画中に安全に `setState` を呼び分けられる。
 */
export function reconcileDraftVersion<TDraft>(
  state: DraftVersionState<TDraft>,
  documentVersion: number,
): DraftVersionState<TDraft> {
  if (state.seenVersion === documentVersion) {
    return state;
  }
  return { draft: null, seenVersion: documentVersion };
}
