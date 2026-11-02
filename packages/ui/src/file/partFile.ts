import { createDocumentElementId } from '@pointercad/model/document-identity';
import { awaitThumbnailCapture, reportThumbnailCaptureReason, type ThumbnailCapture, type ThumbnailCaptureResult } from './thumbnail.js';
import { captureDocumentIdentity, compareDocumentIdentity } from '../store/documentRequest.js';
/**
 * 新規・開く・保存の手続き(計画書 docs/plans/P2-ソリッド基礎.md タスク23)。
 *
 * 対応要件: FR-801(`.pcad` の保存と読込)、FR-806(保存・読込の操作)、
 * NFR-UX-3(復元できない操作の前に確認する)、NFR-RE-1(失敗しても今の文書を壊さない)。
 *
 * 配線を `.tsx` へ直書きせず、ここへ切り出して検査できるようにする
 * (docs/報告記録.md 2026-09-02 22:10 の④)。ブラウザの API はここでは触らない。
 * ファイルを選ぶ・読む・書くのはすべてストアの `fileGateway`(§2.10)に任せるので、
 * 検査では記憶上のバイト列を返す偽の口を差し込める。
 *
 * **失敗しても今の文書は変えない。** 読み込みが途中で断られたときに、いま開いている
 * 部品を半分だけ差し替えると、利用者は元へ戻す手立てを失う(NFR-RE-1、FR-504)。
 * だから文書を差し替えるのは「読み切って中身も確かめられた」ときだけにする。
 */

import {
  DEFAULT_AUTO_SAVE_IDENTITY,
  readPcadFile,
  type SaveDocumentEncoder,
  type PcadAttachments,
} from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';

import { openErrorMessageKey } from './documentReadError.js';
import { hasUnsavedChanges } from './partDocumentDirty.js';
export { openErrorMessageKey } from './documentReadError.js';
export { hasUnsavedChanges } from './partDocumentDirty.js';

import { t, type MessageKey } from '../i18n/t.js';
import { createPartLineageId, createSecureUuid, prepareDocumentSession, SecurePartIdentityError,
  type PreparedDocumentSession } from '../store/fileSlice.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocument } from '../store/documentKind.js';
import { activeHasUnsavedChanges, applyPickedAssembly, newAssembly, saveAssembly } from './assemblyFile.js';
import { beginOpenRequest, finishOpenRequest, mayOpenAfterRead, mayReportOpenFailure, readForOpen } from './documentOpenGuard.js';
import { withPcadExtension, type PickedFile } from './fileGateway.js';
import { recordRecentFile, type RecentFilesStorage } from './recentFiles.js';
import { saveFailureMessageKey } from './saveFailure.js';
import { completeDocumentSave, queueDocumentSave, reportSaveEncodingFailure } from './documentSaveQueue.js';
import { captureSaveSnapshot } from './pcadSaveSnapshot.js';
import { applyPickedDrawing, saveDrawing } from './drawingFile.js';
import { loadedPartAttachments } from './loadedPartAttachments.js';
import { readTutorialCheckpoint, saveTutorialCheckpoint } from '../tutorial/tutorialCheckpoint.js';
import { continuingParameterSession, parameterCheckpointInput, parameterCheckpointIdentity,
  parameterCheckpointWriteGuard, parameterTutorialEvidence, parameterTutorialStep,
  resumeParameterTutorialSession } from '../tutorial/tutorialProgress.js';

/**
 * 手続きが外の世界へ触れる口(検査では偽物を差し込む)。
 *
 * `confirmDiscard` を約束(Promise)で受けるのは、画面の中の確認へ答えるまで待つため。
 * 既定は画面の中の日本語の 3 択(`confirmInApp`、w91a)。
 */
export interface PartFileDeps {
  /** headless検査用の明示注入口。製品の既定はストアが持つ同一配信元Worker。 */
  readonly encodeSave?: SaveDocumentEncoder;
  /** サムネイルの PNG。作れなければ null(サムネイルなしで保存する、§0.a-0.18)。 */
  readonly captureThumbnail: ThumbnailCapture;
  /** 失うものがある操作の前に確認する。「はい」なら true(NFR-UX-3)。 */
  readonly confirmDiscard: (messageKey: MessageKey) => Promise<boolean>;
  /**
   * 最近使ったファイルの履歴の置き場(FR-807、P6 §0.a-0.38、タスク28)。
   *
   * **省略すると端末の `localStorage`**(使えない環境では履歴を残さない)。`null` を渡すと
   * どこにも残さない。検査から記憶上の偽の置き場を渡せるように、ここも他の 2 つと同じ
   * 「外の世界へ触れる口」として並べる。
   */
  readonly recentFilesStorage?: RecentFilesStorage | null;
  /**
   * 保存に一緒に入れる添付(読み込んだ形・下絵。§0.a-0.9・0.24・0.45、P6 タスク32)。
   *
   * **渡さないと、読み込んだ形を含む部品が開き直せなくなる。** `.pcad` の読み手は
   * 文書が指している `shapes/*.brep` / `meshes/*.bin` / `canvases/*.png` が欠けていると
   * 断る(`packages/io` の `findMissingAttachment`)ためで、これは自動保存の控えでも
   * 同じことが起きる(`io` の `AutoSaverOptions.attachmentsOf`)。
   *
   * 表そのものではなく関数で受けるのは、**書く直前の表**を使うためである。
   * 返さなければ添付なしで書く(読み込んだ形を 1 つも持たない部品では同じ結果になる)。
   */
  readonly attachmentsOf?: () => PcadAttachments | undefined;
  /**
   * 開いたファイルに入っていた添付を受け取る口(P6 タスク32)。
   *
   * **`.pcad` を開いた瞬間にしか手に入らない。** 読み込んだ形の B-rep は再計算で
   * 作り直せない(§0.a-0.9 の「導出できるものは保存しない」の例外)ので、ここで
   * 受け取って持ち回らないと、次の再計算で形が消え、次の保存でファイルからも消える。
   */
  readonly onAttachmentsLoaded?: (attachments: PcadAttachments) => void;
}

/** 名前と理由をつなぐ区切り。文字そのものは言葉に依らないのでここに置く。 */
const TITLE_SEPARATOR = ' - ';
/** 保存していない変更があることを表す印。 */
const UNSAVED_MARK = '*';

// ---------------------------------------------------------------------------
// .pcad のバイト列から部品を起こす
// ---------------------------------------------------------------------------

/** `.pcad` を読んだ結果。読めなければ利用者へ見せる文言のキーだけを返す。 */
export type ReadPartDocumentOutcome =
  | {
      readonly ok: true;
      readonly document: PartDocument;
      /**
       * ファイルに入っていた添付(P6 §0.a-0.55、タスク21・32)。**未参照のものも入る。**
       * 呼び出し側はこれを持ち回り、次の保存でそのまま書き戻す。
       */
      readonly attachments: PcadAttachments;
    }
  | { readonly ok: false; readonly messageKey: MessageKey };

/**
 * `.pcad` のバイト列から部品を起こす(FR-801)。
 *
 * 同期読取が必要な呼出し元のための純粋なAPI。通常の「開く」と自動保存復元は
 * 読込Workerを使い、読めなかった理由の言い換えは同じ `openErrorMessageKey` を使う。
 */
export function readPartDocument(bytes: Uint8Array): ReadPartDocumentOutcome {
  const result = readPcadFile(bytes);
  if (!result.ok) {
    return { ok: false, messageKey: openErrorMessageKey(result.error.code) };
  }
  return { ok: true, document: result.document, attachments: result.attachments };
}

// ---------------------------------------------------------------------------
// 表示用の名前
// ---------------------------------------------------------------------------

/** 表示用のファイル名。まだ保存していなければ「名称未設定」。 */
export function displayFileName(fileName: string | null): string {
  return fileName === null || fileName.trim().length === 0 ? t('file.untitled') : fileName;
}

/** 帯に出す名前。保存していない変更があれば末尾に `*` を付ける。 */
export function documentLabel(fileName: string | null, unsaved: boolean): string {
  return unsaved ? `${displayFileName(fileName)}${UNSAVED_MARK}` : displayFileName(fileName);
}

/**
 * 窓の見出し(タブに出る文字)。
 *
 * まだ名前も変更も無いうち(起動直後)は製品名だけにする。何もしていないのに
 * 「名称未設定 - PointerCAD」と出ると、開いていないものを開いているように見えるため。
 */
export function windowTitle(fileName: string | null, unsaved: boolean): string {
  if (fileName === null && !unsaved) {
    return t('app.title');
  }
  return `${documentLabel(fileName, unsaved)}${TITLE_SEPARATOR}${t('app.title')}`;
}

// ---------------------------------------------------------------------------
// 保存していない変更があるか
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 既定の口(画面から呼ぶときのもの)
// ---------------------------------------------------------------------------

/**
 * 画面の中の確認(AppShell の `DiscardConfirmDialog`)で聞く(w91a)。ブラウザー標準の `confirm` は
 * デスクトップ版で英語の OK/Cancel になるので使わない(lint が拒否する)。答えは窓を閉じる前の
 * 確認と同じ 3 つで、「保存して続ける」は保存できたときだけ進める(取消・失敗なら変更を残して止まる)。
 */
async function confirmInApp(messageKey: MessageKey): Promise<boolean> {
  const choice = await useAppStore.getState().requestDiscardConfirm(messageKey);
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  await savePart(createDefaultPartFileDeps(), false);
  return !activeHasUnsavedChanges(useAppStore.getState());
}

/** ビューポートが差し出したサムネイルの作り手を呼ぶ。無ければ・失敗すれば null。 */
function captureThumbnailFromViewport(): ThumbnailCaptureResult {
  const capture = useAppStore.getState().captureThumbnail;
  if (capture === null) {
    reportThumbnailCaptureReason('producer:absent');
    return null;
  }
  try {
    const result = capture();
    if (result instanceof Promise) return result.then(value => {
      reportThumbnailCaptureReason(value === null ? 'producer:null' : 'producer:success'); return value;
    }, () => { reportThumbnailCaptureReason('producer:throw'); return null; });
    reportThumbnailCaptureReason(result === null ? 'producer:null' : 'producer:success');
    return result;
  } catch {
    reportThumbnailCaptureReason('producer:throw');
    // サムネイルが作れないことを保存の失敗にしない(§0.a-0.18)。
    return null;
  }
}

/**
 * 開いたファイルの添付をストアへ入れ直す(P6 タスク32・39)。
 *
 * **3 つまとめて差し替える。** 開くのは文書ごとの操作なので、前の文書の読み込んだ形も
 * 下絵も残さない(残すと、新しい文書が指していない添付を書き戻し続けることになる)。
 */
function storeAttachments(attachments: PcadAttachments): void {
  const store = useAppStore.getState();
  store.setImportedAttachments(attachments.shapes, attachments.meshes);
  store.setCanvasImages(attachments.canvases);
}

/** 画面から呼ぶときの既定の口。 */
export function createDefaultPartFileDeps(): PartFileDeps {
  return {
    captureThumbnail: captureThumbnailFromViewport,
    confirmDiscard: confirmInApp,
    attachmentsOf: currentPcadAttachments,
    onAttachmentsLoaded: storeAttachments,
  };
}

// ---------------------------------------------------------------------------
// 手続き
// ---------------------------------------------------------------------------

/** 保存していない変更があれば確認する。進めてよければ true。 */
async function mayDiscard(deps: PartFileDeps): Promise<boolean> {
  const state = useAppStore.getState();
  if (!activeHasUnsavedChanges(state)) {
    return true;
  }
  return deps.confirmDiscard('file.discardConfirm');
}

/**
 * 新規(FR-806)。保存していない変更があれば確認する(NFR-UX-3)。
 * 進めるときは履歴のスタックごと作り直すので、新規の前へは戻れない。
 */
export async function newPart(deps: PartFileDeps): Promise<void> {
  if (activeDocument(useAppStore.getState()).kind === 'assembly') return newAssembly(deps);
  if (!(await mayDiscard(deps))) {
    return;
  }
  const store = useAppStore.getState();
  // 文書と上書き先の寿命をそろえる。前の文書の先を新しい空の部品へ持ち越さない。
  const emptyDocument = createEmptyPartDocument();
  let id: string;
  let preparedSession: PreparedDocumentSession;
  try { id = createPartLineageId(); preparedSession = prepareDocumentSession(); }
  catch (error) {
    if (!(error instanceof SecurePartIdentityError)) throw error;
    store.setFileMessage({ key: 'command.unavailable.action', failed: true });
    return;
  }
  const document = { ...emptyDocument, id };
  store.fileGateway.clearSaveTarget?.();
  store.resetDocument(document, preparedSession);
  store.setFileState(null, null);
}

/**
 * 開く(FR-806、FR-801)。読めなかったら理由を帯へ出すだけで、**今の文書は変えない**
 * (NFR-RE-1)。取り消されたときは何も起きない(理由も出さない)。
 */
export async function openPart(deps: PartFileDeps): Promise<void> {
  if (!(await mayDiscard(deps))) {
    return;
  }
  // 確認に答えた時点の文書を控える。ファイルを選ぶ窓や読込の間に編集・取り消しをしたら、
  // 開く前に改めて確認する(docs/review-2026-09-28-codex.md R02)。
  const request = beginOpenRequest();
  try {
  let picked: PickedFile | null;
  try {
    picked = await useAppStore.getState().fileGateway.openPcad('all');
  } catch {
    if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    return;
  }
  if (picked === null) {
    return;
  }
  if (picked.name.toLowerCase().endsWith('.pcada')) {
    try { await applyPickedAssembly(picked, deps, request); }
    catch (error) {
      if (!(error instanceof SecurePartIdentityError)) throw error;
      if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    }
    return;
  }
  if (picked.name.toLowerCase().endsWith('.pcadd')) {
    try { await applyPickedDrawing(picked, deps, request); }
    catch (error) {
      if (!(error instanceof SecurePartIdentityError)) throw error;
      if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    }
    return;
  }
  const result = await readForOpen(request, 'part', picked.bytes);
  if (result === null) return;
  if (!result.ok) {
    if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({ key: openErrorMessageKey(result.error.code), failed: true });
    return;
  }
  const checkpoint = await readTutorialCheckpoint(
    { part: { document: result.document, savedBytes: picked.bytes } },
    useAppStore.getState().tutorialCheckpointStorage,
  );
  if (!(await mayOpenAfterRead(request, deps))) {
    return;
  }
  // ここまで来たら中身は確かめ済み。開いた文書は新しい履歴から始め、前の文書の選択も
  // 持ち越さない(`opensDocument`)。開いた直後の Undo で前の文書へ戻ると、名前と上書き先は
  // 開いたファイルのまま中身だけが前の文書になり、上書き保存で開いたファイルを壊すため。
  // 文書まるごとの差し替えなので、プロパティ欄の打ちかけの下書きは捨てる
  // (§0.a-0.1〜、docs/報告記録.md 2026-09-04 14:05 の 9b)。
  const store = useAppStore.getState();
  // 形そのもの(読み込んだ B-rep・三角形・下絵)は文書の外にあるので、
  // 文書を差し替える前に渡す(差し替えの直後に再計算が走るため)。
  let preparedSession: PreparedDocumentSession;
  let loaded: ReturnType<typeof loadedPartAttachments>;
  try {
    preparedSession = prepareDocumentSession();
    loaded = loadedPartAttachments(result.document, result.attachments,
      { shapes: store.importedShapes, meshes: store.importedMeshes, canvases: store.canvases },
      kind => createDocumentElementId(`${kind}-asset-`, createSecureUuid));
  } catch (error) {
    if (!(error instanceof SecurePartIdentityError)) throw error;
    if (mayReportOpenFailure(request)) store.setFileMessage({ key: 'file.openFailed', failed: true });
    return;
  }
  deps.onAttachmentsLoaded?.(loaded.attachments);
  store.applyDocument(loaded.document, { opensDocument: true, preparedSession });
  store.setFileState(picked.name, loaded.document);
  const opened = useAppStore.getState();
  // Asset collision normalization can rewrite the document after the saved bytes were verified.
  // Its old checkpoint no longer describes the document now visible in the store.
  const sameSavedContent = loaded.document === result.document;
  opened.setTutorialDrawingProof(null);
  opened.setTutorialExports({});
  opened.setTutorialDraft(checkpoint.ok && sameSavedContent ? checkpoint.checkpoint.draft ?? null : null);
  opened.setTutorialSession(checkpoint.ok && sameSavedContent
    ? resumeParameterTutorialSession(checkpoint.checkpoint, loaded.document, opened.documentVersion) : null);
  opened.setTutorialCheckpointFailure(checkpoint.ok && !sameSavedContent ? 'staleContent'
    : checkpoint.ok || checkpoint.reason === 'missing' ? null : checkpoint.reason);
  // 中身を検証して文書へ適用し終えたものだけ、開いた先をこの文書の上書き先にする。
  if (picked.saveTargetToken === null) {
    store.fileGateway.clearSaveTarget?.();
  } else if (store.fileGateway.confirmSaveTarget !== undefined) {
    try {
      await store.fileGateway.confirmSaveTarget(picked.saveTargetToken);
    } catch {
      // 確定に失敗したときは、前の文書の先へ誤って上書きするより名前を訊き直す。
      store.fileGateway.clearSaveTarget?.();
    }
  }
  // 開けたものだけを履歴へ残す(FR-807)。断ったファイルを勧め直さないため。
  recordRecentFile(picked.name, { storage: deps.recentFilesStorage });
  } finally { finishOpenRequest(request); }
}

/**
 * 保存(FR-806、FR-801)。`saveAs` が true なら必ず場所を聞く。
 * 保存先を覚えていない口(ダウンロードへ落とす環境)でも必ず場所を聞く形になる。
 */
export async function savePart(deps: PartFileDeps, saveAs: boolean): Promise<void> {
  const store = useAppStore.getState();
  const active = activeDocument(store);
  if (active.kind === 'assembly') return saveAssembly(deps, saveAs);
  if (active.kind === 'drawing') return saveDrawing(deps, saveAs);
  if (active.kind !== 'part') return;
  // 書き出す文書はここで確定させる。待っている間に文書が変わっても、
  // 「保存した文書」と実際に書いたものを食い違わせない。
  const document = store.document;
  const guideSession = store.tutorialSession?.course === 'parameterToExport'
    && store.tutorialSession.documentId === document.id
    && store.tutorialSession.documentVersion === store.documentVersion ? store.tutorialSession : null;
  const guideVersion = store.documentVersion;
  const thumbnailIdentity = captureDocumentIdentity(store);
  const thumbnail = Promise.resolve(deps.captureThumbnail()).catch(() => null);
  /*
   * サムネイルと添付はどちらも「あれば入れる」欄なので、渡す組を 1 か所で組み立てる。
   * 添付を落とすと、読み込んだ形を含む部品が開き直せなくなる(`PartFileDeps.attachmentsOf`)。
   */
  const attachments = deps.attachmentsOf?.();
  const snapshot = captureSaveSnapshot({ kind: 'part', document, options: {
    savedAt: new Date().toISOString(),
    ...(attachments === undefined ? {} : { attachments }),
  } });
  return queueDocumentSave(store, async (isCurrent, control) => {
  try {
    const captured = await awaitThumbnailCapture(thumbnail, control.signal);
    if (!isCurrent()) return;
    const current = useAppStore.getState();
    const thumbnailPng = compareDocumentIdentity(thumbnailIdentity, current) === 'current'
      && current.requestedGeneration === store.requestedGeneration && current.completedGeneration === store.completedGeneration
      && current.cancelRequestCount === store.cancelRequestCount && current.recomputeCancelled === store.recomputeCancelled ? captured : null;
    const encoding = snapshot.kind === 'part' && thumbnailPng !== null
      ? { ...snapshot, options: { ...snapshot.options, thumbnailPng } } : snapshot;
    const bytes = await (deps.encodeSave ?? store.saveDocumentEncoder)(encoding, control);
    if (!control.beginWriting()) return;
  const suggestedName = withPcadExtension(displayFileName(store.fileName));

    const savedName = await store.fileGateway.savePcad(
      suggestedName,
      bytes,
      saveAs || !store.fileGateway.hasSaveTarget(),
    );
  if (savedName === null || !isCurrent()) {
    // 取り消された。今の状態のままにする。
    return;
  }
  const after = useAppStore.getState();
  const savedFileName = withPcadExtension(savedName);
  after.setFileState(savedFileName, document);
  if (guideSession !== null) {
    const latest = useAppStore.getState();
    const activeGuide = latest.tutorialSession;
    if (continuingParameterSession(guideSession, activeGuide) && activeGuide !== null) {
      const currentGuide = () => isCurrent() && useAppStore.getState().document === document
        && useAppStore.getState().documentVersion === guideVersion
        && useAppStore.getState().tutorialCheckpointStorage === latest.tutorialCheckpointStorage
        && useAppStore.getState().tutorialSession === activeGuide;
      const stage = parameterTutorialStep(activeGuide, document, latest.documentVersion,
        parameterTutorialEvidence(latest));
      const input = stage === 'differentDocument' ? null
        : parameterCheckpointInput(activeGuide, document, stage, latest.tutorialDraft);
      if (input !== null) {
        const guard = parameterCheckpointWriteGuard(activeGuide, latest.tutorialCheckpointStorage, currentGuide);
        const checkpoint = guard.ok ? await saveTutorialCheckpoint(input,
          { part: { document, savedBytes: bytes } }, latest.tutorialCheckpointStorage, guard.isCurrent) : guard;
        if (currentGuide()) {
          useAppStore.getState().setTutorialCheckpointFailure(checkpoint.ok ? null : checkpoint.reason);
          if (checkpoint.ok) useAppStore.getState().setTutorialSession({ ...activeGuide,
            checkpointIdentity: parameterCheckpointIdentity(checkpoint.checkpoint) });
        }
      }
    }
  }
  /*
   * 保存できたものも履歴へ残す(FR-807)。別名保存で名前が変わったときは、**新しい名前**が
   * 先頭へ来る(`savedName` は口が実際に書いた先の名前で、候補名ではない)。
   * 元の名前も履歴に残ったままなので、後から元のファイルを選び直せる。
   */
  recordRecentFile(savedFileName, { storage: deps.recentFilesStorage });

  /*
   * 手で保存できたら自動保存の控えは用済みなので消す(§0.a-0.12)。
   * 残しておくと、次の起動で「前回の作業が残っています」と、いま保存したばかりの
   * ファイルより古いものを勧めてしまう。
   * 控えを消せなくても保存そのものは成功しているので、失敗は伝えない(NFR-RE-1)。
   */
  const saver = store.autoSaver;
  const canDiscard = (): boolean => {
    const current = useAppStore.getState();
    return isCurrent() && current.autoSaver === saver && !hasUnsavedChanges(current.document, document);
  };
  await completeDocumentSave(isCurrent, async () => {
    if (saver !== null && canDiscard()) {
      await saver.discard();
      if (canDiscard()) await saver.discard(DEFAULT_AUTO_SAVE_IDENTITY);
      if (canDiscard()) useAppStore.setState({ recoverySaveState: null });
    }
  }, savedFileName);
  } catch (error) {
    if (isCurrent()) useAppStore.getState().setFileMessage({ key: saveFailureMessageKey(error), failed: true });
    reportSaveEncodingFailure(error, isCurrent);
  }
  });
}
