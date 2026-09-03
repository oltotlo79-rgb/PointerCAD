/**
 * 自動保存の見張りとクラッシュ復元(計画書 docs/plans/P2-ソリッド基礎.md タスク24、§2.9)。
 *
 * 対応要件: FR-805(5 分ごとの自動保存)、NFR-RE-2(異常終了しても直前の作業を失わない)、
 * NFR-UX-2(モーダルを増やさない)。
 *
 * 中身の判断(間隔をどう数えるか、変更が無いときに書かないこと、書き込み中の重複を避けること)は
 * すべて `packages/io` の `createAutoSaver` が持っている。ここがするのは次の 4 つだけで、
 * 同じ判断を作り直さない。
 *  - 部品文書が変わったことを見張って `markDirty` へ伝える。
 *  - 起動時に控えを読み、開ける控えがあれば復元の案内を出す。
 *  - 案内の「復元する」「破棄する」を実行する。
 *  - ブラウザで使える保管庫(IndexedDB か、無ければ記憶上)を選ぶ。
 *
 * 配線を `.tsx` へ直書きせず、ここへ切り出して検査できるようにする
 * (docs/報告記録.md 2026-09-02 22:10 の④)。`PointerCadApp.tsx` は `startAutoSave` を
 * 呼んで、片付けの手を受け取るだけにする。
 */

import {
  createAutoSaver,
  createIndexedDbAutoSaveStorage,
  createMemoryAutoSaveStorage,
  type AutoSaver,
  type AutoSaveStorage,
} from '@pointercad/io';

import { useAppStore } from '../store/useAppStore.js';
import { hasUnsavedChanges, readPartDocument } from './partFile.js';

// ---------------------------------------------------------------------------
// 保管庫を選ぶ
// ---------------------------------------------------------------------------

/** `indexedDB` を持つかもしれない実行環境(`as` を使わずに絞るための形)。 */
interface IndexedDbScope {
  readonly indexedDB: object;
}

function hasIndexedDb(scope: object): scope is IndexedDbScope {
  return 'indexedDB' in scope && typeof scope.indexedDB === 'object' && scope.indexedDB !== null;
}

/**
 * ブラウザで使える保管庫を選ぶ(§0.a-0.11)。
 *
 * IndexedDB があればそれを、無ければ記憶上のものに落とす。記憶上のものはタブを閉じると
 * 消えるので控えの役目は果たさないが、**自動保存が無いせいで操作が止まることはない**
 * (NFR-RE-1)。
 *
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため
 * (`fileGateway.ts` の `hasFileSystemAccess` と同じ流儀)。なお実際の読み書き先を決めるのは
 * `packages/io` 側で、そちらは本物の `globalThis.indexedDB` を見る。だから偽の欄を持つ
 * `scope` を渡すと「IndexedDB の保管庫を選んだが、読み書きは何も起きない」形になる。
 */
export function createAutoSaveStorageForBrowser(scope: object = globalThis): AutoSaveStorage {
  return hasIndexedDb(scope) ? createIndexedDbAutoSaveStorage() : createMemoryAutoSaveStorage();
}

/**
 * 「書こうとした時点でまだ保存していない変更があるときだけ書く」保管庫。
 *
 * `createAutoSaver` は「前に控えを書いたときから文書が変わったか」で判断する。それだけだと、
 * **控えを書く前に利用者が手で保存した**場合を拾えない(手で保存しても文書そのものは
 * 変わらないので、次の 5 分で同じ中身の控えができ、次の起動で「前回の作業が残っています」と
 * 出てしまう)。ここで最後にもう一度だけ、いまの文書が本当に未保存かを確かめる。
 *
 * 判定は `hasUnsavedChanges` そのもので、間隔の管理も変更の記録も持たない
 * (同じ判断を 2 つ作らない)。
 */
export function createUnsavedOnlyStorage(inner: AutoSaveStorage): AutoSaveStorage {
  return {
    read: () => inner.read(),
    write: (record) => {
      const state = useAppStore.getState();
      if (!hasUnsavedChanges(state.document, state.savedDocument)) {
        return Promise.resolve();
      }
      return inner.write(record);
    },
    clear: () => inner.clear(),
  };
}

// ---------------------------------------------------------------------------
// 画面が隠れたことを知る口(タブを閉じる直前の控え)
// ---------------------------------------------------------------------------

/**
 * 画面の見え隠れを知らせるもの。ブラウザでは `document` がこれにあたる。
 * 使う欄だけを書き写し、`as` を使わずに型ガードで絞る(`fileGateway.ts` と同じ流儀)。
 */
export interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

function isVisibilityTarget(value: unknown): value is VisibilityTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'visibilityState' in value &&
    typeof value.visibilityState === 'string' &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function'
  );
}

/** いまの実行環境の `document`。持っていなければ null(Node の検査)。 */
function browserVisibilityTarget(): VisibilityTarget | null {
  const scope: object = globalThis;
  if (!('document' in scope)) {
    return null;
  }
  return isVisibilityTarget(scope.document) ? scope.document : null;
}

// ---------------------------------------------------------------------------
// 文書の変化を見張る
// ---------------------------------------------------------------------------

export interface AttachAutoSaveOptions {
  /** 控えを書く人(`packages/io` の `createAutoSaver` が作る)。 */
  readonly saver: AutoSaver;
  /**
   * 画面が隠れたことを知らせるもの。既定はブラウザの `document`(無ければ張らない)。
   * `null` を渡すと張らない。検査では偽物を渡して `visibilitychange` を起こす。
   */
  readonly visibility?: VisibilityTarget | null;
}

/**
 * 部品文書の変化を見張り、控えを書く人へ伝える(FR-805)。**戻り値を呼ぶと見張りをやめる。**
 *
 * 保存していない変更が無いとき(手で保存した直後、Undo で保存した形へ戻ったとき)は
 * 伝えない。伝えると、変わっていない中身の控えを作り直すことになる(§0.a-0.12)。
 *
 * あわせて、画面が隠れたとき(タブを閉じる・別のタブへ移る直前)に未保存の変更があれば、
 * 5 分を待たずにその場で控えを書く。閉じる操作を止めることはできない(ブラウザは
 * 書き終わりを待ってくれない)ので、これは「間に合えば残る」程度の保険として扱う。
 */
export function attachAutoSave(options: AttachAutoSaveOptions): () => void {
  const { saver } = options;

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.document === previous.document) {
      return;
    }
    if (!hasUnsavedChanges(next.document, next.savedDocument)) {
      return;
    }
    saver.markDirty(next.document);
  });

  const visibility =
    options.visibility === undefined ? browserVisibilityTarget() : options.visibility;
  const onVisibilityChange = (): void => {
    if (visibility === null || visibility.visibilityState !== 'hidden') {
      return;
    }
    const state = useAppStore.getState();
    if (!hasUnsavedChanges(state.document, state.savedDocument)) {
      return;
    }
    void saver.saveNow(state.document);
  };
  if (visibility !== null) {
    visibility.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    unsubscribe();
    if (visibility !== null) {
      visibility.removeEventListener('visibilitychange', onVisibilityChange);
    }
    saver.stop();
  };
}

// ---------------------------------------------------------------------------
// 起動時の案内と、その返事
// ---------------------------------------------------------------------------

export interface LoadAutoSavePromptOptions {
  /**
   * 読み終わった時点で、まだ案内を出してよいか。false を返すと画面へは何も出さない。
   * React の StrictMode は起動の手続きを 2 回走らせるので、1 回目の片付けの後に
   * 遅れて届いた結果で案内を出さないために使う。
   */
  readonly shouldApply?: () => boolean;
}

/**
 * 起動時に控えを読み、開ける控えがあれば復元の案内を出す(§2.9)。
 *
 * 控えが壊れていて開けないときは、**黙って捨てて案内を出さない**。開けないものを勧めても
 * 利用者にできることが無く、押した後で断るのは「操作を止めずに警告する」に反するため
 * (NFR-RE-1、NFR-UX-5)。例外は外へ出さない。
 */
export async function loadAutoSavePrompt(
  saver: AutoSaver,
  options: LoadAutoSavePromptOptions = {},
): Promise<void> {
  const record = await saver.readLatest();
  const mayApply = (): boolean => options.shouldApply?.() !== false;

  if (record === null) {
    if (mayApply()) {
      useAppStore.getState().setRestorePrompt(null);
    }
    return;
  }
  if (!readPartDocument(record.bytes).ok) {
    await saver.discard();
    if (mayApply()) {
      useAppStore.getState().setRestorePrompt(null);
    }
    return;
  }
  if (mayApply()) {
    useAppStore
      .getState()
      .setRestorePrompt({ savedAt: record.savedAt, documentName: record.documentName });
  }
}

/**
 * 案内の「復元する」。控えの部品を開き、案内を閉じる。
 *
 * 復元した部品は**まだどのファイルにも保存されていない**扱いにする(名前は「名称未設定」に
 * 戻る)。控えは前回の作業の途中の姿であって、ファイルに書いた中身とは限らないため。
 * 控えそのものは消さない。破棄を選ぶまで残す(§0.a-0.12)ので、復元した直後にもう一度
 * 落ちても同じところから始められる。
 */
export async function restoreAutoSave(saver: AutoSaver): Promise<void> {
  const record = await saver.readLatest();
  if (record === null) {
    useAppStore.getState().setRestorePrompt(null);
    return;
  }
  const outcome = readPartDocument(record.bytes);
  if (!outcome.ok) {
    // 読めない控えは残しておいても使い道が無い。
    await saver.discard();
    useAppStore.getState().setRestorePrompt(null);
    return;
  }
  const store = useAppStore.getState();
  store.resetDocument(outcome.document);
  store.setFileState(null, null);
  store.setRestorePrompt(null);
}

/** 案内の「破棄する」。控えを消して案内を閉じる。 */
export async function discardAutoSave(saver: AutoSaver): Promise<void> {
  await saver.discard();
  useAppStore.getState().setRestorePrompt(null);
}

// ---------------------------------------------------------------------------
// 起動時の配線
// ---------------------------------------------------------------------------

export interface StartAutoSaveOptions {
  /** 控えを書く人。既定はブラウザ用の保管庫を使うもの。検査では時計とタイマーを差し替えて渡す。 */
  readonly saver?: AutoSaver;
}

/**
 * 自動保存を始める(`PointerCadApp.tsx` が起動時に 1 回呼ぶ)。**戻り値を呼ぶと片付ける。**
 *
 * 控えを書く人をストアへ差し出し、控えがあれば案内を出し、文書の見張りを始める。
 * React の StrictMode ではこの手続きが 2 回走るが、1 回目は片付けの後に案内を出さないので
 * カードが二重に出ることはない。
 */
export function startAutoSave(options: StartAutoSaveOptions = {}): () => void {
  const saver =
    options.saver ??
    createAutoSaver({ storage: createUnsavedOnlyStorage(createAutoSaveStorageForBrowser()) });
  let detached = false;

  useAppStore.getState().setAutoSaver(saver);
  void loadAutoSavePrompt(saver, { shouldApply: () => !detached });
  const detach = attachAutoSave({ saver });

  return () => {
    detached = true;
    detach();
    if (useAppStore.getState().autoSaver === saver) {
      useAppStore.getState().setAutoSaver(null);
    }
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

/**
 * 控えを書いた時刻を、その場所の時計の読み方で表す(例: `2026/09/03 18:30`)。
 *
 * 控えの中では世界共通の書き方(ISO 8601、UTC)で持っているが、案内カードに出すのは
 * 利用者の時計の読みでなければ「さっきの作業」と結び付かない(NFR-UX-5)。
 * 読み取れない文字列はそのまま返す(案内を出せないよりはましなため)。
 */
export function formatSavedAt(savedAt: string): string {
  const time = new Date(savedAt).getTime();
  if (!Number.isFinite(time)) {
    return savedAt;
  }
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(time);
}
