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
 *  - 起動時に控えを読み、復元できるかどうかに応じた案内を出す。
 *  - 案内の「復元する」「控えを書き出す」「破棄する」を実行する。
 *  - ブラウザで使う IndexedDB の保管庫を選び、無ければ失敗を通知する。
 *
 * 配線を `.tsx` へ直書きせず、ここへ切り出して検査できるようにする
 * (docs/報告記録.md 2026-09-02 22:10 の④)。`PointerCadApp.tsx` は `startAutoSave` を
 * 呼んで、片付けの手を受け取るだけにする。
 */

import {
  DEFAULT_AUTO_SAVE_IDENTITY,
  createAutoSaver,
  createIndexedDbAutoSaveStorage,
  readDocumentBundle,
  readDrawingBundle,
  type AutoSaveDocument,
  type AutoSaveRecord,
  type AutoSaveIdentity,
  type AutoSaverOptions,
  type AutoSaver,
  type AutoSaveStorage,
} from '@pointercad/io';
import { createAssemblyDocumentBundle, createPartDocumentBundle, drawingSourceInputOf, partLibraryOfBundle } from '@pointercad/model';

import { currentPcadAttachments } from '../store/attachKernel.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { saveFileAsThrough, withPcadExtension, withPcadaExtension, withPcaddExtension } from './fileGateway.js';
import { openErrorMessageKey, readPartDocument } from './partFile.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { activeDocument } from '../store/documentKind.js';
import { hasSaveRecoveryCopy } from './saveFailure.js';

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

class IndexedDbUnavailableError extends Error {
  readonly reason = 'unavailable' as const;

  constructor() {
    super('IndexedDB is unavailable');
    this.name = 'IndexedDbUnavailableError';
  }
}

/**
 * ブラウザで使える保管庫を選ぶ(§0.a-0.11)。
 *
 * IndexedDB が無ければ、読み込みは候補なし、書き込みと削除は `unavailable` の理由つきで
 * 失敗する。記憶上へ黙って落とすと、控えが残っていないのに成功したように見えるため。
 * 失敗は `createAutoSaver` の `onError` が状態欄へ知らせ、操作そのものは止めない(NFR-RE-1)。
 *
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため
 * (`fileGateway.ts` の `hasFileSystemAccess` と同じ流儀)。なお実際の読み書き先を決めるのは
 * `packages/io` 側で、そちらは本物の `globalThis.indexedDB` を見る。だから偽の欄を持つ
 * `scope` を渡すと「IndexedDB の保管庫を選んだが、実体が無ければ理由つきで失敗する」形になる。
 */
export function createAutoSaveStorageForBrowser(scope: object = globalThis): AutoSaveStorage {
  if (hasIndexedDb(scope)) {
    return createIndexedDbAutoSaveStorage();
  }
  return {
    read: () => Promise.resolve(null),
    write: () => Promise.reject(new IndexedDbUnavailableError()),
    clear: () => Promise.reject(new IndexedDbUnavailableError()),
  };
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
    read: (identity) => inner.read(identity),
    write: (record) => {
      const state = useAppStore.getState();
      if ((record.documentId === undefined || record.documentId === state.activeDocumentId) &&
        !activeHasUnsavedChanges(state)) {
        return Promise.resolve();
      }
      return inner.write(record);
    },
    clear: (identity) => inner.clear(identity),
    ...(inner.listRecords === undefined ? {} : { listRecords: () => inner.listRecords?.() ?? Promise.resolve([]) }),
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

function recoveryDocument(state: AppState, bundleParts: boolean): AutoSaveDocument | null {
  const active = activeDocument(state);
  if (active.kind === 'drawing') {
    const entry = state.drawingSources.sources.find((item) => item.metadata.sourceRef === active.document.source.sourceRef
      && item.metadata.contentHash === active.document.source.contentHash);
    const source = entry === undefined ? null : drawingSourceInputOf(entry);
    if (source === null) { reportAutoSaveFailure(); return null; }
    return { kind: 'drawing', document: active.document, source };
  }
  return active.kind === 'assembly' ? createAssemblyDocumentBundle(active.document, active.library)
    : bundleParts ? createPartDocumentBundle(active.document, currentPcadAttachments()) : active.document;
}

export interface AttachAutoSaveOptions {
  readonly bundleParts?: boolean;
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
    if (next.document === previous.document && next.assembly === previous.assembly &&
      next.drawing === previous.drawing && next.drawingSources === previous.drawingSources &&
      next.assemblyLibrary === previous.assemblyLibrary && next.importedShapes === previous.importedShapes &&
      next.importedMeshes === previous.importedMeshes && next.canvases === previous.canvases) {
      return;
    }
    if (!activeHasUnsavedChanges(next)) {
      return;
    }
    const document = recoveryDocument(next, options.bundleParts === true);
    if (document !== null) saver.markDirty(document);
  });

  const visibility =
    options.visibility === undefined ? browserVisibilityTarget() : options.visibility;
  const onVisibilityChange = (): void => {
    if (visibility === null || visibility.visibilityState !== 'hidden') {
      return;
    }
    const state = useAppStore.getState();
    if (!activeHasUnsavedChanges(state)) {
      return;
    }
    const document = recoveryDocument(state, options.bundleParts === true);
    if (document !== null) void saver.saveNow(document);
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
  readonly record?: AutoSaveRecord | null;
  /**
   * 読み終わった時点で、まだ案内を出してよいか。false を返すと画面へは何も出さない。
   * React の StrictMode は起動の手続きを 2 回走らせるので、1 回目の片付けの後に
   * 遅れて届いた結果で案内を出さないために使う。
   */
  readonly shouldApply?: () => boolean;
}

/**
 * 起動時に控えを読み、復元の案内を出す(§2.9)。この版で読めない控えも消さず、理由と
 * `.pcad` のまま書き出す導線を出す。新しい版の控えと壊れた控えを黙って同じ扱いにしない。
 */
export async function loadAutoSavePrompt(
  saver: AutoSaver,
  options: LoadAutoSavePromptOptions = {},
): Promise<void> {
  const record = options.record === undefined ? await saver.readLatest() : options.record;
  const mayApply = (): boolean => options.shouldApply?.() !== false;
  if (!mayApply()) return;
  useAppStore.setState({ recoveryRecord: record });

  if (record === null) {
    if (mayApply()) {
      useAppStore.getState().setRestorePrompt(null);
    }
    return;
  }
  const outcome = record.kind === 'drawing' ? await readDrawingRecovery(record)
    : record.kind === 'assembly' ? await readAssemblyRecovery(record) : readPartDocument(record.bytes);
  if (!outcome.ok) {
    if (mayApply()) {
      useAppStore.getState().setRestorePrompt({
        savedAt: record.savedAt,
        documentName: record.documentName,
        unrecoverable: true,
        reasonKey: outcome.messageKey,
      });
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
  const before = useAppStore.getState();
  const isCurrent = () => useAppStore.getState().activeDocumentId === before.activeDocumentId
    && useAppStore.getState().documentVersion === before.documentVersion;
  const record = await recoveryRecordOf(saver);
  if (!isCurrent()) return;
  if (record === null) {
    useAppStore.getState().setRestorePrompt(null);
    return;
  }
  if (record.kind === 'drawing') {
    const outcome = await readDrawingBundle(record.bytes);
    if (!isCurrent()) return;
    if (!outcome.ok) { await loadAutoSavePrompt(saver, { record, shouldApply: isCurrent }); return; }
    before.openDrawing(outcome.document, {
      sources: { sources: [{ metadata: outcome.document.source, ...outcome.source }] },
      importedShapes: outcome.source.sourceKind === 'part' ? outcome.source.attachments?.shapes : undefined,
    });
    // 原本の控えは成功保存まで保持。文書のIDと元sessionを結び付けて別窓を消さない。
    if (record.documentId !== undefined) useAppStore.setState({ activeDocumentId: record.documentId });
    before.setRestorePrompt(null);
    // 空の用紙設定だけを復元した場合も、新規の未変更図面とは区別する。
    useAppStore.setState({ recoveryRecord: record, drawingInitialName: null });
    return;
  }
  if (record.kind === 'assembly') {
    const outcome = await readDocumentBundle(record.bytes, 'assembly');
    if (!outcome.ok || outcome.bundle.kind !== 'assembly') {
      await loadAutoSavePrompt(saver, { record });
      return;
    }
    const state = useAppStore.getState();
    state.openAssembly(outcome.bundle.document, partLibraryOfBundle(outcome.bundle));
    // 復元後は新しい窓の session で同じ文書を引き継ぐ。元の控えは消さない。
    if (record.documentId !== undefined) useAppStore.setState({ activeDocumentId: record.documentId });
    state.setRestorePrompt(null);
    useAppStore.setState({ recoveryRecord: null });
    return;
  }
  const outcome = readPartDocument(record.bytes);
  if (!outcome.ok) {
    // 読めない控えは消さない。版を更新して復元するか、元のバイト列を書き出せるよう案内を保つ。
    useAppStore.getState().setRestorePrompt({
      savedAt: record.savedAt,
      documentName: record.documentName,
      unrecoverable: true,
      reasonKey: outcome.messageKey,
    });
    return;
  }
  const store = useAppStore.getState();
  store.resetDocument(outcome.document);
  if (record.documentId !== undefined) useAppStore.setState({ activeDocumentId: record.documentId });
  /*
   * 形そのもの(読み込んだ B-rep・三角形・下絵)は文書の外にあるので、**文書を作り直した
   * 後に**入れ直す(`resetDocument` が前の部品の表を空にするので、先に入れると消える。
   * ストアの `resetDocument` の注釈と同じ順序。P6 タスク32・39)。
   */
  store.setImportedAttachments(outcome.attachments.shapes, outcome.attachments.meshes);
  store.setCanvasImages(outcome.attachments.canvases);
  store.setFileState(null, null);
  store.fileGateway.clearSaveTarget?.();
  store.setRestorePrompt(null);
  useAppStore.setState({ recoveryRecord: null });
}

async function readDrawingRecovery(record: AutoSaveRecord) {
  const result = await readDrawingBundle(record.bytes);
  return result.ok ? { ok: true as const } :
    { ok: false as const, messageKey: openErrorMessageKey(result.error.code) };
}

async function readAssemblyRecovery(record: AutoSaveRecord) {
  const result = await readDocumentBundle(record.bytes, 'assembly');
  return result.ok ? { ok: true as const } :
    { ok: false as const, messageKey: openErrorMessageKey(result.error.code) };
}

function identityOfRecord(record: AutoSaveRecord): AutoSaveIdentity {
  if (record.kind !== undefined && record.documentId !== undefined && record.sessionId !== undefined) {
    return { kind: record.kind, documentId: record.documentId, sessionId: record.sessionId };
  }
  return DEFAULT_AUTO_SAVE_IDENTITY;
}

function recoveryRecordOf(saver: AutoSaver): Promise<AutoSaveRecord | null> {
  const state = useAppStore.getState();
  const record = state.restorePrompt === null ? null : state.recoveryRecord;
  return saver.readLatest(record === null ? undefined : identityOfRecord(record));
}

/** 案内の「破棄する」。控えを消して案内を閉じる。 */
export async function discardAutoSave(saver: AutoSaver): Promise<void> {
  const record = await recoveryRecordOf(saver);
  await saver.discard(record === null ? undefined : identityOfRecord(record));
  useAppStore.getState().setRestorePrompt(null);
  useAppStore.setState({ recoveryRecord: null });
}

/** 読めない控えを、内容を変えず既存のファイル保存の口から `.pcad` として書き出す。 */
export async function exportAutoSave(saver: AutoSaver): Promise<void> {
  const record = await recoveryRecordOf(saver);
  if (record === null) {
    useAppStore.getState().setRestorePrompt(null);
    return;
  }
  const store = useAppStore.getState();
  try {
    const saved = await saveFileAsThrough(
      store.fileGateway,
      record.kind === 'drawing' ? withPcaddExtension(record.documentName)
        : record.kind === 'assembly' ? withPcadaExtension(record.documentName) : withPcadExtension(record.documentName),
      record.kind === 'drawing' ? 'pcadd' : record.kind === 'assembly' ? 'pcada' : 'pcad',
      record.bytes,
    );
    if (saved) {
      useAppStore.getState().setFileMessage({ key: 'restore.exported', failed: false });
    }
  } catch (error) {
    useAppStore.getState().setFileMessage({ key: hasSaveRecoveryCopy(error) ? 'file.saveRecoveryCopyRetained' : 'restore.exportFailed', failed: true });
  }
}

/** 自動保存の失敗を、通常のファイル操作と同じ状態欄へ明示する。 */
export function reportAutoSaveFailure(): void {
  useAppStore.getState().setFileMessage({ key: 'autoSave.failed', failed: true });
}

/** 次の自動保存が成功したら、自動保存由来の古い失敗だけを状態欄から消す。 */
export function clearAutoSaveFailure(): void {
  const state = useAppStore.getState();
  if (state.fileMessage?.key === 'autoSave.failed') {
    state.setFileMessage(null);
  }
}

// ---------------------------------------------------------------------------
// 起動時の配線
// ---------------------------------------------------------------------------

export interface StartAutoSaveOptions {
  /** 控えを書く人。既定はブラウザ用の保管庫を使うもの。検査では時計とタイマーを差し替えて渡す。 */
  readonly saver?: AutoSaver;
  readonly storage?: AutoSaveStorage;
  readonly sessionId?: string;
  readonly createSaver?: (options: AutoSaverOptions) => AutoSaver;
}

const WINDOW_SESSION_ID = crypto.randomUUID();

function startDocumentAutoSave(options: StartAutoSaveOptions): () => void {
  const storage = options.storage ?? createAutoSaveStorageForBrowser();
  const factory = options.createSaver ?? createAutoSaver;
  const sessionId = options.sessionId ?? WINDOW_SESSION_ID;
  let detached = false;
  let identity = '';
  let revision = 0;
  let stopCurrent: (() => void) | null = null;
  let saver: AutoSaver | null = null;
  const promptedKinds = new Set<string>();

  function switchDocument(): void {
    const state = useAppStore.getState();
    const active = activeDocument(state);
    const nextIdentity = `${active.kind}:${active.documentId}`;
    if (identity === nextIdentity) return;
    identity = nextIdentity;
    revision += 1;
    const currentRevision = revision;
    stopCurrent?.();
    const current = factory({ storage: createUnsavedOnlyStorage(storage), kind: active.kind,
      documentId: active.documentId, sessionId,
      onError: () => { if (!detached && currentRevision === revision) reportAutoSaveFailure(); },
      onSuccess: () => { if (!detached && currentRevision === revision) clearAutoSaveFailure(); },
    });
    saver = current;
    state.setAutoSaver(current);
    stopCurrent = attachAutoSave({ saver: current, bundleParts: true });
    if (activeHasUnsavedChanges(useAppStore.getState())) {
      const document = recoveryDocument(useAppStore.getState(), true);
      if (document !== null) current.markDirty(document);
    }
    const shouldApply = () => !detached && currentRevision === revision;
    if (promptedKinds.has(active.kind)) return;
    const startup = promptedKinds.size === 0 && active.kind === 'part' && !activeHasUnsavedChanges(state);
    promptedKinds.add(active.kind);
    if (storage.listRecords === undefined) {
      void loadAutoSavePrompt(current, { shouldApply });
    } else {
      void storage.listRecords().then((records) => {
        if (!shouldApply()) return;
        const record = records.filter((item) => startup || (item.kind ?? 'part') === active.kind)
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0] ?? null;
        if (record !== null) promptedKinds.add(record.kind ?? 'part');
        return loadAutoSavePrompt(current, { shouldApply, record });
      }).catch(() => { if (shouldApply()) reportAutoSaveFailure(); });
    }
  }
  const unsubscribe = useAppStore.subscribe(switchDocument);
  switchDocument();
  return () => {
    detached = true;
    unsubscribe();
    stopCurrent?.();
    if (useAppStore.getState().autoSaver === saver) useAppStore.getState().setAutoSaver(null);
  };
}

/**
 * 自動保存を始める(`PointerCadApp.tsx` が起動時に 1 回呼ぶ)。**戻り値を呼ぶと片付ける。**
 *
 * 控えを書く人をストアへ差し出し、控えがあれば案内を出し、文書の見張りを始める。
 * React の StrictMode ではこの手続きが 2 回走るが、1 回目は片付けの後に案内を出さないので
 * カードが二重に出ることはない。
 */
export function startAutoSave(options: StartAutoSaveOptions = {}): () => void {
  if (options.saver === undefined) return startDocumentAutoSave(options);
  const saver =
    options.saver ??
    createAutoSaver({
      storage: createUnsavedOnlyStorage(createAutoSaveStorageForBrowser()),
      /*
       * 控えにも添付(読み込んだ形・下絵)を一緒に入れる(P6 タスク32、タスク21 の申し送り)。
       * **渡さないと、読み込んだ形を含む文書の控えが復元できない**——`.pcad` の読み手は
       * 文書が指している添付が欠けていると断るので、添付なしで書いた控えは
       * 「開けない控え」になる(`packages/io` の `findMissingAttachment`)。
       */
      attachmentsOf: () => currentPcadAttachments(),
      onError: reportAutoSaveFailure,
      onSuccess: clearAutoSaveFailure,
    });
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
