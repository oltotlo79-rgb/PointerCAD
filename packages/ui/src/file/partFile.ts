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
  serializeDocument,
  writePcadFile,
  type PcadAttachments,
  type ReadPcadFileErrorCode,
} from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocument } from '../store/documentKind.js';
import { activeHasUnsavedChanges, applyPickedAssembly, newAssembly, saveAssembly } from './assemblyFile.js';
import { withPcadExtension, type PickedFile } from './fileGateway.js';
import { recordRecentFile, type RecentFilesStorage } from './recentFiles.js';
import { saveFailureMessageKey } from './saveFailure.js';
import { completeDocumentSave, queueDocumentSave } from './documentSaveQueue.js';
import { applyPickedDrawing, saveDrawing } from './drawingFile.js';

/**
 * 手続きが外の世界へ触れる口(検査では偽物を差し込む)。
 *
 * `confirmDiscard` を約束(Promise)で受けるのは、P2 の仕上げで画面の中の確認カードへ
 * 差し替えられるようにするため(NFR-UX-2「モーダルを増やさない」)。今の既定はブラウザの
 * 確認窓で、答えはすぐ返る。
 */
export interface PartFileDeps {
  /** サムネイルの PNG。作れなければ null(サムネイルなしで保存する、§0.a-0.18)。 */
  readonly captureThumbnail: () => Uint8Array | null;
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

/**
 * 中身が同じかを比べるときに使う保存時刻。
 *
 * `serializeDocument` は保存時刻も一緒に書き出すので、同じ値を渡して**時刻の違いを
 * 消してから**比べる。そうしないと「開いた直後なのに保存していない変更がある」に見える。
 */
const COMPARISON_SAVED_AT = '1970-01-01T00:00:00.000Z';

/** 名前と理由をつなぐ区切り。文字そのものは言葉に依らないのでここに置く。 */
const TITLE_SEPARATOR = ' - ';
/** 保存していない変更があることを表す印。 */
const UNSAVED_MARK = '*';

/**
 * `.pcad` を読めなかった理由と、利用者へ見せる文言の対応(NFR-UX-5)。
 *
 * `packages/io` は理由ごとに日本語の文も持っているが、画面へ出す文言は ja.json に
 * まとめる決まりなので(NFR-MA-5)、ここで対応づけ直す。`Record` で全部の理由を
 * 書かせているので、`packages/io` が理由を増やしたら型検査で気づける。
 */
const OPEN_ERROR_KEYS: Readonly<Record<ReadPcadFileErrorCode, MessageKey>> = {
  // ZIP として開けない。中身を見る手前で壊れている。
  notZip: 'file.error.corrupted',
  // ZIP ではあるが、部品の中身が入っていない。
  missingDocument: 'file.error.missingDocument',
  // 中身が JSON として読めない。
  invalidJson: 'file.error.corrupted',
  // PointerCAD の封筒になっていない(他のアプリのファイル)。
  notPcad: 'file.error.wrongKind',
  // PointerCAD のファイルだが、部品ではない(アセンブリ・図面)。
  unsupportedKind: 'file.error.wrongKind',
  unsupportedOldVersion: 'file.error.tooOld',
  unsupportedNewVersion: 'file.error.tooNew',
  // 版の記録が食い違う・欄が足りない・型が違うのは、いずれも中身の壊れ。
  versionMismatch: 'file.error.corrupted',
  missingField: 'file.error.corrupted',
  invalidField: 'file.error.corrupted',
};

/**
 * 読めなかった理由を利用者へ見せる文言のキーへ直す(P6 タスク33)。
 *
 * ひな形(`.pcadt`)も同じ封筒を読む(`file/templateFile.ts`)ので、上の表を**写さずに**
 * 使えるようにここへ 1 つだけ口を開けてある。表そのものは外へ出さない(理由と文言の
 * 対応を書き換える場所を 1 か所に閉じるため)。
 */
export function openErrorMessageKey(code: ReadPcadFileErrorCode): MessageKey {
  return OPEN_ERROR_KEYS[code];
}

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
 * 「開く」(`openPart`)と自動保存の復元(`attachAutoSave.ts`)の両方が同じ経路を通る。
 * 読めなかった理由の言い換えを 2 か所に持つと、片方だけ直したときに同じファイルへ
 * 違う断り方をすることになるので、ここ 1 つにまとめる。
 */
export function readPartDocument(bytes: Uint8Array): ReadPartDocumentOutcome {
  const result = readPcadFile(bytes);
  if (!result.ok) {
    return { ok: false, messageKey: OPEN_ERROR_KEYS[result.error.code] };
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

/**
 * 直前の判定を 1 つだけ覚えておく。
 *
 * 判定は文書を丸ごと文字列にして比べるので、式を 1 文字打つたびに全部を書き出すと
 * もったいない(NFR-PF-1)。文書は作り直しでしか変わらない(不変)ので、
 * 同じ 2 つを渡されたら前と同じ答えでよい。
 */
let cachedDocument: PartDocument | null = null;
let cachedSaved: PartDocument | null = null;
let cachedResult = false;

/** 中身を比べるための文字列。保存時刻の違いは消してある。 */
function contentOf(document: PartDocument): string {
  return serializeDocument(document, { savedAt: COMPARISON_SAVED_AT });
}

/** 何もかいていない、起動直後のままの部品か。 */
function isUntouched(document: PartDocument): boolean {
  return contentOf(document) === contentOf(createEmptyPartDocument());
}

/**
 * 保存していない変更があるか。
 *
 * 参照が同じかではなく**中身**で比べる。文書は書き換えるたびに作り直されるので、
 * 参照で比べると「1 文字打って消した」だけで変更ありになってしまう。
 * 一度も保存していないとき(`savedDocument` が null)は、起動直後のままの空の部品を
 * 「変更なし」として扱う。まだ何もしていない状態で確認を出さないため(NFR-UX-3)。
 */
export function hasUnsavedChanges(
  document: PartDocument,
  savedDocument: PartDocument | null,
): boolean {
  if (document === cachedDocument && savedDocument === cachedSaved) {
    return cachedResult;
  }
  const result =
    savedDocument === null
      ? !isUntouched(document)
      : document !== savedDocument && contentOf(document) !== contentOf(savedDocument);
  cachedDocument = document;
  cachedSaved = savedDocument;
  cachedResult = result;
  return result;
}

// ---------------------------------------------------------------------------
// 既定の口(画面から呼ぶときのもの)
// ---------------------------------------------------------------------------

/** ブラウザの確認窓で聞く。窓を出せない環境では、失うものがある操作を進めない。 */
function confirmWithBrowser(messageKey: MessageKey): Promise<boolean> {
  if (typeof globalThis.confirm !== 'function') {
    return Promise.resolve(false);
  }
  return Promise.resolve(globalThis.confirm(t(messageKey)));
}

/** ビューポートが差し出したサムネイルの作り手を呼ぶ。無ければ・失敗すれば null。 */
function captureThumbnailFromViewport(): Uint8Array | null {
  const capture = useAppStore.getState().captureThumbnail;
  if (capture === null) {
    return null;
  }
  try {
    return capture();
  } catch {
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
    confirmDiscard: confirmWithBrowser,
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
  store.fileGateway.clearSaveTarget?.();
  store.resetDocument(createEmptyPartDocument());
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
  let picked: PickedFile | null;
  try {
    picked = await useAppStore.getState().fileGateway.openPcad('all');
  } catch {
    useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    return;
  }
  if (picked === null) {
    return;
  }
  if (picked.name.toLowerCase().endsWith('.pcada')) {
    await applyPickedAssembly(picked, deps);
    return;
  }
  if (picked.name.toLowerCase().endsWith('.pcadd')) {
    await applyPickedDrawing(picked, deps);
    return;
  }
  const result = readPartDocument(picked.bytes);
  if (!result.ok) {
    useAppStore.getState().setFileMessage({ key: result.messageKey, failed: true });
    return;
  }
  // ここまで来たら中身は確かめ済み。文書を差し替え、Undo で開く前へ戻れるようにする。
  // 文書まるごとの差し替えなので、プロパティ欄の打ちかけの下書きは捨てる
  // (§0.a-0.1〜、docs/報告記録.md 2026-09-04 14:05 の 9b)。
  const store = useAppStore.getState();
  // 形そのもの(読み込んだ B-rep・三角形・下絵)は文書の外にあるので、
  // 文書を差し替える前に渡す(差し替えの直後に再計算が走るため)。
  deps.onAttachmentsLoaded?.(result.attachments);
  store.applyDocument(result.document, { replacesDocument: true });
  store.setFileState(picked.name, result.document);
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
  const thumbnailPng = deps.captureThumbnail();
  /*
   * サムネイルと添付はどちらも「あれば入れる」欄なので、渡す組を 1 か所で組み立てる。
   * 添付を落とすと、読み込んだ形を含む部品が開き直せなくなる(`PartFileDeps.attachmentsOf`)。
   */
  const attachments = deps.attachmentsOf?.();
  return queueDocumentSave(store, async (isCurrent) => {
  try {
    const bytes = writePcadFile(document, {
    ...(thumbnailPng === null ? {} : { thumbnailPng }),
    ...(attachments === undefined ? {} : { attachments }),
  });
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
    }
  });
  } catch (error) {
    if (isCurrent()) useAppStore.getState().setFileMessage({ key: saveFailureMessageKey(error), failed: true });
  }
  });
}
