import { app, dialog, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

import { validateAppSender } from './appSender.js';

/**
 * 窓を閉じるときの未保存の確認(レビュー R03、FR-805・NFR-UX-3、要件§1.5)。
 *
 * Web 版はブラウザーの `beforeunload` で確認するが、デスクトップ版の窓でそれを使うと、確認を出さずに
 * 閉じるのを止めてしまう。そこで本体が窓の `close` を止めて画面へ問い合わせ、画面が未保存の有無を
 * 判定し、未保存があれば本体の窓で「保存して閉じる・保存せずに閉じる・戻る」を1回だけ出す。
 *
 * - **画面が用意を知らせた窓だけ守る。** 知らせる前(読込みの失敗・画面が落ちた後・読み直しの途中)は
 *   守る変更が画面に無いので、今までどおり閉じる。印刷用の隠し窓は送信元として登録しない
 *   (`appSender.ts`)ので、知らせが届かず守られない。
 * - **問合せは窓ごとに1つだけ。** 答えを待つ間に重ねて閉じても、新しい問合せも確認も出さない。
 * - **画面が答えないときも閉じられなくならない。** 5秒答えが無いか、応答しないと知らされた後に重ねて
 *   閉じると、強制的に閉じるかを本体の窓で聞く。未保存が無いと知らされていれば聞かずに閉じる。
 * - **Windows の終了・再起動・サインアウト**(`query-session-end`)は、未保存があるときだけ止めて同じ確認を出す。
 * - **アプリ全体の終了(`app.quit()`)も守る。** Electron は `before-quit` の後に全ての窓の `close` を出し、
 *   どれかが止めると終了をやめる。Linux の終了の合図(SIGTERM など)もこの道を通るので、窓の `close` を
 *   止めれば同じ確認になる。確認の後に窓が閉じると、最後の窓が閉じたときの `app.quit()` で終わる。
 * - **検査の後片付けだけは省く。** 画面検査(`e2e/tests/electronAppFlow.ts` の `launchDesktop`)は、終わりに
 *   Playwright の `app.close()`(= `app.quit()`)で終了を待つ。検査の入口が環境変数
 *   `CLOSE_GUARD_TEST_BYPASS_ENV` を `1` にしたときだけ、`before-quit` の後は確認を省く。製品の起動は
 *   この変数を渡さない。
 *
 * 文言は画面が ja.json から渡す(NFR-MA-5)。本体はその形だけを確かめる。
 */

/** 画面が確認の用意と文言を知らせる(画面 → 本体)。 */
export const CLOSE_GUARD_READY_CHANNEL = 'pcad:closeGuardReady';
/** 画面が未保存の有無の変化を知らせる(画面 → 本体)。Windows の終了要求の判断に使う。 */
export const CLOSE_GUARD_STATE_CHANNEL = 'pcad:closeGuardState';
/** 本体が閉じてよいかを問い合わせる(本体 → 画面)。 */
export const CLOSE_REQUEST_CHANNEL = 'pcad:closeRequest';
/** 画面が本体の窓で3択を出させる(画面 → 本体)。答えは `save`・`discard`・`cancel`。 */
export const CLOSE_CHOICE_CHANNEL = 'pcad:closeChoice';
/** 画面が問合せに答える(画面 → 本体)。 */
export const CLOSE_ANSWER_CHANNEL = 'pcad:closeAnswer';
/** 画面が問合せに応じるまで待つ上限。過ぎたら強制的に閉じるかを聞く。 */
export const CLOSE_ANSWER_TIMEOUT_MS = 5_000;

const TEXT_KEYS = ['message', 'detail', 'save', 'discard', 'cancel', 'unresponsiveMessage', 'unresponsiveDetail', 'forceClose'] as const;
/** 本体の確認の窓に出す文言。1つあたりの上限は、画面の文言として十分な長さにする。 */
const MAX_TEXT_LENGTH = 500;
const CHOICES = ['save', 'discard', 'cancel'] as const;

type CloseGuardTexts = Readonly<Record<(typeof TEXT_KEYS)[number], string>>;
type CloseChoice = (typeof CHOICES)[number];

interface PendingRequest {
  readonly id: string;
  /** 画面が3択を求めた(= 問合せを受け取って動いている)。 */
  acknowledged: boolean;
  /** 強制的に閉じるかを聞いている。 */
  forcing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface GuardedWindow {
  readonly window: BrowserWindow;
  texts: CloseGuardTexts | null;
  unsaved: boolean;
  unresponsive: boolean;
  allowClose: boolean;
  pending: PendingRequest | null;
}

const guarded = new WeakMap<WebContents, GuardedWindow>();
/** 画面検査の入口だけが渡す印。`1` のとき、アプリ全体の終了では確認を省く。 */
export const CLOSE_GUARD_TEST_BYPASS_ENV = 'PCAD_E2E_QUIT_WITHOUT_CLOSE_CONFIRM';
/** 印のある検査の後片付けで、アプリ全体の終了が始まった。 */
let quittingWithoutConfirm = false;

function readTexts(value: unknown): CloseGuardTexts | null {
  if (typeof value !== 'object' || value === null) return null;
  const texts = new Map<string, string>();
  for (const key of TEXT_KEYS) {
    const text: unknown = Reflect.get(value, key);
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) return null;
    texts.set(key, text);
  }
  const read = (key: (typeof TEXT_KEYS)[number]): string => texts.get(key) ?? '';
  return { message: read('message'), detail: read('detail'), save: read('save'), discard: read('discard'),
    cancel: read('cancel'), unresponsiveMessage: read('unresponsiveMessage'),
    unresponsiveDetail: read('unresponsiveDetail'), forceClose: read('forceClose') };
}

function clearPending(guard: GuardedWindow): void {
  const timer = guard.pending?.timer ?? null;
  if (timer !== null) clearTimeout(timer);
  guard.pending = null;
}

/** 画面の答えどおりに閉じる。`close` をもう一度通すが、止めない。 */
function closeNow(guard: GuardedWindow): void {
  clearPending(guard);
  guard.allowClose = true;
  guard.window.close();
}

/** 画面が答えないまま閉じる。固まった画面の後始末を待たない。 */
function destroyNow(guard: GuardedWindow): void {
  clearPending(guard);
  guard.allowClose = true;
  guard.window.destroy();
}

async function askForceClose(guard: GuardedWindow, pending: PendingRequest): Promise<void> {
  if (pending.timer !== null) clearTimeout(pending.timer);
  pending.timer = null;
  const texts = guard.texts;
  if (texts === null || !guard.unsaved) {
    destroyNow(guard);
    return;
  }
  pending.forcing = true;
  const { response } = await dialog.showMessageBox(guard.window, {
    type: 'warning', title: 'PointerCAD', message: texts.unresponsiveMessage, detail: texts.unresponsiveDetail,
    buttons: [texts.forceClose, texts.cancel], defaultId: 1, cancelId: 1, noLink: true,
  });
  if (guard.pending !== pending) return;
  if (response === 0) destroyNow(guard);
  else clearPending(guard);
}

/** 画面へ問い合わせる。問合せ中なら重ねず、画面が固まっていれば強制的に閉じるかを聞く。 */
function requestClose(guard: GuardedWindow): void {
  const pending = guard.pending;
  if (pending !== null) {
    if (!pending.forcing && pending.acknowledged && guard.unresponsive) void askForceClose(guard, pending);
    return;
  }
  const next: PendingRequest = { id: randomUUID(), acknowledged: false, forcing: false, timer: null };
  next.timer = setTimeout(() => {
    if (guard.pending === next && !next.acknowledged) void askForceClose(guard, next);
  }, CLOSE_ANSWER_TIMEOUT_MS);
  guard.pending = next;
  guard.window.webContents.send(CLOSE_REQUEST_CHANNEL, next.id);
}

function isProtected(guard: GuardedWindow): boolean {
  const contents = guard.window.webContents;
  return !quittingWithoutConfirm && !guard.allowClose && guard.texts !== null && !contents.isDestroyed() && !contents.isCrashed();
}

/** 窓ごとの見張りを付ける。守るかどうかは、画面が用意を知らせたかで決まる。 */
function watchWindow(window: BrowserWindow): void {
  const guard: GuardedWindow = { window, texts: null, unsaved: false, unresponsive: false, allowClose: false, pending: null };
  const contents = window.webContents;
  guarded.set(contents, guard);
  window.on('close', (event) => {
    if (!isProtected(guard)) return;
    event.preventDefault();
    requestClose(guard);
  });
  window.on('query-session-end', (event) => {
    if (!isProtected(guard) || !guard.unsaved) return;
    event.preventDefault();
    requestClose(guard);
  });
  window.on('unresponsive', () => { guard.unresponsive = true; });
  window.on('responsive', () => { guard.unresponsive = false; });
  // 画面が落ちた・読み直した後は守る変更が画面に残っていない。次の用意の知らせまで守らない。
  const forget = (): void => {
    clearPending(guard);
    guard.texts = null;
    guard.unsaved = false;
  };
  contents.on('render-process-gone', forget);
  contents.on('did-navigate', forget);
}

/** 送信元の確認を通った登録済みの窓だけを返す。 */
function senderGuard(event: IpcMainInvokeEvent): GuardedWindow | null {
  if (!validateAppSender(event)) return null;
  return guarded.get(event.sender) ?? null;
}

function currentRequest(guard: GuardedWindow, requestId: unknown): PendingRequest | null {
  const pending = guard.pending;
  return typeof requestId === 'string' && pending !== null && pending.id === requestId && !pending.forcing ? pending : null;
}

/**
 * 閉じるときの確認の受け口と、窓ごとの見張りを登録する。`app.whenReady()` の中で、
 * 主窓を作る前に1回だけ呼ぶ(`registerPcadIpc` と同じ理由。2回呼ぶと二重登録で失敗する)。
 */
export function registerCloseGuard(): void {
  app.on('before-quit', () => {
    // 印は終了の時点で読む(検査が途中で外して、終了の確認そのものを確かめられるように)。
    if (process.env[CLOSE_GUARD_TEST_BYPASS_ENV] === '1') quittingWithoutConfirm = true;
  });
  app.on('browser-window-created', (_event, window) => { watchWindow(window); });
  ipcMain.handle(CLOSE_GUARD_READY_CHANNEL, (event, texts: unknown): boolean => {
    const guard = senderGuard(event);
    const parsed = readTexts(texts);
    if (guard === null || parsed === null) return false;
    guard.texts = parsed;
    return true;
  });
  ipcMain.handle(CLOSE_GUARD_STATE_CHANNEL, (event, unsaved: unknown): boolean => {
    const guard = senderGuard(event);
    if (guard === null || typeof unsaved !== 'boolean') return false;
    guard.unsaved = unsaved;
    return true;
  });
  ipcMain.handle(CLOSE_CHOICE_CHANNEL, async (event, requestId: unknown): Promise<CloseChoice> => {
    const guard = senderGuard(event);
    const pending = guard === null ? null : currentRequest(guard, requestId);
    const texts = guard?.texts ?? null;
    if (guard === null || pending === null || texts === null || pending.acknowledged) return 'cancel';
    pending.acknowledged = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    const { response } = await dialog.showMessageBox(guard.window, {
      type: 'question', title: 'PointerCAD', message: texts.message, detail: texts.detail,
      buttons: [texts.save, texts.discard, texts.cancel], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (guard.pending !== pending) return 'cancel';
    return CHOICES[response] ?? 'cancel';
  });
  ipcMain.handle(CLOSE_ANSWER_CHANNEL, (event, requestId: unknown, close: unknown): boolean => {
    const guard = senderGuard(event);
    const pending = guard === null ? null : currentRequest(guard, requestId);
    if (guard === null || pending === null || typeof close !== 'boolean') return false;
    if (close) closeNow(guard);
    else clearPending(guard);
    return true;
  });
}
