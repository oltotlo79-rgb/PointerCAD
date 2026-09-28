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
 * 取り付けは各アプリの入口が行う(Web 版は `apps/web/src/main.tsx`、デスクトップ版は
 * `apps/desktop/src/renderer/main.tsx`。レビュー R03)。デスクトップ版の窓で `beforeunload` を使うと
 * 確認を出さずに閉じるのを止めてしまうので、デスクトップ版は本体の問合せの口
 * (`CloseRequestTarget`。preload が出す)を渡す。本体が窓の「閉じる」を止めて問い合わせ、
 * ここが未保存を判定し、未保存があれば本体の窓で「保存して閉じる・保存せずに閉じる・戻る」を
 * 1回だけ出させる。保存の取消・失敗では閉じず、保存できたときだけ閉じる。
 */
import { t } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { createDefaultPartFileDeps, hasUnsavedChanges, savePart, type PartFileDeps } from './partFile.js';

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

/** 本体の窓で選ばれた答え。 */
export type CloseChoice = 'save' | 'discard' | 'cancel';

/** 本体の確認の窓に出す文言(ja.json の `file.closeGuard.*`)。 */
export interface CloseGuardTexts {
  readonly message: string;
  readonly detail: string;
  readonly save: string;
  readonly discard: string;
  readonly cancel: string;
  readonly unresponsiveMessage: string;
  readonly unresponsiveDetail: string;
  readonly forceClose: string;
}

/**
 * デスクトップ版の本体が窓を閉じる前に問い合わせる口(preload の `pointercadDesktop` が出す)。
 * 答えの形は本体が確かめるので、ここは `Promise<unknown>` で受ける。
 */
export interface CloseRequestTarget {
  /** 確認の用意ができたことと文言を本体へ知らせる。知らせるまで本体は閉じるのを止めない。 */
  closeGuardReady(texts: CloseGuardTexts): Promise<unknown>;
  /** 未保存の有無が変わったことを本体へ知らせる(OS の終了要求を止めるかの判断に使う)。 */
  reportUnsavedWork(unsaved: boolean): Promise<unknown>;
  /** 本体からの「閉じてよいか」の問合せを受ける。戻り値で受けるのをやめる。 */
  onCloseRequest(listener: (requestId: string) => void): () => void;
  /** 本体の窓で3択を出させる。答えは `CloseChoice` のどれか。 */
  chooseCloseAction(requestId: string): Promise<unknown>;
  /** 問合せに答える。`close` が true なら本体が窓を閉じる。 */
  answerCloseRequest(requestId: string, close: boolean): Promise<unknown>;
}

/** 未保存の判定(`hasUnsavedWork`)が読む欄。どれも変わらなければ判定し直さない。 */
const UNSAVED_WORK_INPUTS = [
  'document', 'savedDocument', 'fileName', 'assembly', 'assemblyLibrary', 'savedAssembly', 'assemblyFileName',
  'assemblyInitialName', 'drawing', 'savedDrawing', 'drawingSources', 'savedDrawingSources', 'drawingFileName',
  'drawingInitialName', 'drawingUndoStack', 'activeDocumentId',
] as const satisfies readonly (keyof AppState)[];

function closeGuardTexts(): CloseGuardTexts {
  return {
    message: t('file.closeGuard.message'), detail: t('file.closeGuard.detail'),
    save: t('file.closeGuard.save'), discard: t('file.closeGuard.discard'), cancel: t('file.closeGuard.cancel'),
    unresponsiveMessage: t('file.closeGuard.unresponsiveMessage'),
    unresponsiveDetail: t('file.closeGuard.unresponsiveDetail'), forceClose: t('file.closeGuard.forceClose'),
  };
}

/**
 * 閉じる前に、見えている文書と図面の後ろの部品を保存する。全部保存できたときだけ true。
 * 取消・失敗は保存の手続きが状態のまま残す(失敗は帯へ理由を出す)ので、残った未保存で判定する。
 */
async function saveAllForClose(getState: () => AppState, deps: PartFileDeps): Promise<boolean> {
  if (activeHasUnsavedChanges(getState())) {
    await savePart(deps, false);
    if (activeHasUnsavedChanges(getState())) return false;
  }
  const state = getState();
  if (state.drawing !== null && hasUnsavedChanges(state.document, state.savedDocument)) {
    // 図面は保存済みか変更が無い。部品を保存できるのは部品を開いている間だけなので、図面を閉じて部品へ戻る。
    state.closeDrawing();
    await savePart(deps, false);
  }
  return !hasUnsavedWork(getState());
}

/** 閉じてよいか。未保存が無ければ聞かず、あれば本体の3択に従う。 */
async function mayClose(target: CloseRequestTarget, requestId: string, getState: () => AppState,
  createDeps: () => PartFileDeps): Promise<boolean> {
  if (!hasUnsavedWork(getState())) return true;
  const choice = await target.chooseCloseAction(requestId);
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  return saveAllForClose(getState, createDeps());
}

function attachCloseRequestGuard(target: CloseRequestTarget, getState: () => AppState,
  createDeps: () => PartFileDeps): () => void {
  let seen: readonly unknown[] | null = null;
  let reported: boolean | null = null;
  const report = (): void => {
    const state = getState();
    const inputs = UNSAVED_WORK_INPUTS.map((key) => state[key]);
    if (seen !== null && inputs.every((value, index) => Object.is(value, seen?.[index]))) return;
    seen = inputs;
    const unsaved = hasUnsavedWork(state);
    if (unsaved === reported) return;
    reported = unsaved;
    void target.reportUnsavedWork(unsaved).catch(() => undefined);
  };
  let answering = false;
  const answer = async (requestId: string): Promise<void> => {
    // 本体は問合せを1つずつ送る。答えている途中に届いた問合せには、確認を重ねず「閉じない」と答える。
    if (answering) {
      await target.answerCloseRequest(requestId, false).catch(() => undefined);
      return;
    }
    answering = true;
    // 判定や保存が思わぬ理由で失敗したときは、変更を守るため閉じない。
    const close = await mayClose(target, requestId, getState, createDeps).catch(() => false)
      .finally(() => { answering = false; });
    await target.answerCloseRequest(requestId, close).catch(() => undefined);
  };
  void target.closeGuardReady(closeGuardTexts()).catch(() => undefined);
  report();
  const unsubscribe = useAppStore.subscribe(report);
  const stopListening = target.onCloseRequest((requestId) => { void answer(requestId); });
  return () => {
    unsubscribe();
    stopListening();
  };
}

function isCloseRequestTarget(target: UnloadTarget | CloseRequestTarget): target is CloseRequestTarget {
  return 'onCloseRequest' in target;
}

/**
 * 保存していない変更を、頁や窓を閉じる前に守る。戻り値で取り外す。状態は閉じる瞬間に読む。
 *
 * - ブラウザー(`UnloadTarget`): 変更がある間だけブラウザーの確認を出させる。
 * - デスクトップ版(`CloseRequestTarget`): 本体の問合せに答え、必要なら3択を出させて保存する。
 *
 * `createDeps` は保存に使う口(既定は画面から呼ぶときのもの)。ブラウザーでは使わない。
 */
export function attachUnsavedChangesGuard(
  target: UnloadTarget | CloseRequestTarget,
  getState: () => AppState = useAppStore.getState,
  createDeps: () => PartFileDeps = createDefaultPartFileDeps,
): () => void {
  if (isCloseRequestTarget(target)) return attachCloseRequestGuard(target, getState, createDeps);
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
