/**
 * 読み直し・閉じる・別の頁へ移るときの未保存の確認(P12-24、FR-805・FR-1004、NFR-UX-3)。
 *
 * ブラウザーの頁は、読み直す・タブを閉じる・別の頁へ移ると記憶の中の文書を失う。
 * 自動保存の控え(既定5分ごと)より後の変更は戻せないので、**保存していない変更がある間だけ**
 * ブラウザー自身の確認を出させる(`beforeunload`)。変更が無いとき(起動直後・保存した直後・
 * 開いた直後)は何もしない。確認が要らない場面で確認を出すと、利用者が確認を読まずに
 * 押す癖が付くため(NFR-UX-3)。
 *
 * 判定は画面の `*` 印と同じ `activeHasUnsavedChanges` を使う。加えて、図面を開いている間は
 * 図面の元になった部品がストアに残り、図面を閉じると画面へ戻るので、その部品の未保存の
 * 変更も守る。
 *
 * 取り付けは各アプリの入口が行う(Web 版は `apps/web/src/main.tsx`)。デスクトップ版の窓は
 * 確認を出さずに閉じるのを止めてしまうため、本体側で確認の窓を出す用意ができるまで
 * 取り付けない。
 */
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { hasUnsavedChanges } from './partFile.js';

/** 頁を離れると失われる、保存していない変更があるか。 */
export function hasUnsavedWork(state: AppState): boolean {
  if (activeHasUnsavedChanges(state)) return true;
  // 図面の後ろに残る部品(図面を閉じると戻る)。アセンブリを開くと部品は空へ戻るので見ない。
  return state.drawing !== null && hasUnsavedChanges(state.document, state.savedDocument);
}

/** 頁を離れる知らせ(`BeforeUnloadEvent`)のうち、確認を求めるのに使う欄だけ。 */
export type UnloadEvent = Pick<BeforeUnloadEvent, 'preventDefault' | 'returnValue'>;

/** 確認の取り付け先。ブラウザーでは `window`。検査では偽の的を渡す。 */
export interface UnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: UnloadEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: UnloadEvent) => void): void;
}

/**
 * 保存していない変更がある間だけ、頁を離れる前にブラウザーの確認を出させる。
 * 戻り値で取り外す。状態は離れる瞬間に読むので、変更のたびに付け外ししない。
 */
export function attachUnsavedChangesGuard(
  target: UnloadTarget,
  getState: () => AppState = useAppStore.getState,
): () => void {
  const listener = (event: UnloadEvent): void => {
    if (!hasUnsavedWork(getState())) return;
    // 今のブラウザーは preventDefault で確認を出す。古い版は returnValue に値が要る。
    // 文言はブラウザーが決めた定型文になり、頁からは変えられない。
    event.preventDefault();
    event.returnValue = true;
  };
  target.addEventListener('beforeunload', listener);
  return () => {
    target.removeEventListener('beforeunload', listener);
  };
}
