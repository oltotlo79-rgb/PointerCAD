import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { closeSync, constants as fileSystemConstants, promises as fileSystem, unlinkSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { SAVE_RECOVERY_COPY_MARKER, hasSaveRecoveryCopy } from '@pointercad/ui/save-errors';

import { nativeFileFilter, isFileDialogKind, MAX_COMPRESSED_INPUT_BYTES,
  PCAD_EXTENSION as PCAD_DOTTED_EXTENSION, type NativeFileFilter as KindFilter } from '@pointercad/ui/file-contracts';

import { validateAppSender } from './appSender.js';
import { beginExportWrite, clearExportHandoff, registerExportHandoffIpc } from './exportHandoffIpc.js';

/**
 * デスクトップ版の「開く」「保存」「名前を付けて保存」(計画書 docs/plans/P2-ソリッド基礎.md タスク26)と、
 * 種類を選ぶ「開く」「書き出す」(docs/plans/P6-入出力.md §2.2、§0.a-0.5、タスク4)。
 *
 * 対応要件: FR-806(保存・読込)、FR-802(読み込み)、FR-803(書き出し)、
 * 要件§1.5(Web 版とデスクトップ版に機能差を作らない)、NFR-SE-1。
 *
 * 画面(レンダラ)は `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false` のまま
 * 動かすので、ファイルの実体に触れるのはこの本体プロセスだけにする。画面から来るのは
 * 「名前」「バイト列」「名前を付けて保存かどうか」「ファイルの種類」だけで、
 * **パスは画面へ渡さない**(NFR-SE-1「外へ出す情報は最小にする」)。上書き先はここで覚える。
 *
 * **上書き先を扱うのは `.pcad` の口(開く 5 本 `pcad:openBegin`・`pcad:openChunk`・`pcad:openFinish`・`pcad:openAbort`・`pcad:openReread` /
 * `pcad:confirmTarget` / `pcad:clearTarget` / 保存の 4 本 `pcad:saveBegin`・`pcad:saveChunk`・`pcad:saveCommit`・`pcad:saveAbort` /
 * `pcad:hasTarget`)だけ。** 開く口は全部を読み終えた `pcad:openFinish` で実パスを
 * 未確定の token に結び付け、画面が文書を検証した後の `pcad:confirmTarget` で初めて確定する。
 * 種類つきの 2 本(`pcad:openAny` / `pcad:saveAs`)は `lastPaths` を読みも書きもしない
 * (§0.a-0.4。書き出した先を覚えると、次の Ctrl+S が部品ではなく書き出した先を上書きしかねない)。
 *
 * `node:fs/promises` ではなく `node:fs` の `promises` を使う。本体プロセスの束ね方
 * (`apps/desktop/vite.main.config.ts` の `rollupOptions.external`)が外に置くのは
 * `node:fs` までで、`node:fs/promises` は入っていないため(この設定は本タスクの範囲外)。
 */

/**
 * 画面側と取り決めたチャンネル名。**`apps/desktop/src/preload/preload.ts` の文字列と揃える**
 * (preload は本体プロセス専用の `dialog` / `ipcMain` を抱き込まないよう、このファイルから
 * 読まずに同じ文字列を書いている)。
 */
/**
 * 「開く」は 4 本に分ける(2026-11-13)。バイト列を 1 回の IPC で返すと、128MiB の部品で本体に全体の並びが載り、
 * 描画の処理には「IPC の受け取り」「世界の境目(contextBridge)の写し」「Worker へ渡す前の写し」が同時に生きて、
 * 読込の追加の記憶量の山になっていた。開始で窓を出してファイルを読むために開き(本文はまだ読まない)、
 * `PCAD_OPEN_CHUNK_BYTES` ずつ渡し、終わりで読む途中の変化が無いことを確かめて閉じる。
 */
const PCAD_OPEN_BEGIN_CHANNEL = 'pcad:openBegin';
const PCAD_OPEN_CHUNK_CHANNEL = 'pcad:openChunk';
const PCAD_OPEN_FINISH_CHANNEL = 'pcad:openFinish';
const PCAD_OPEN_ABORT_CHANNEL = 'pcad:openAbort';
/**
 * 読み直し。画面が読込の Worker へ並びを移した後に中身が要った時(移すと決めた後に学習の控えの鍵が現れた時)だけ、
 * 未確定の上書き先の候補(token)のファイルを、開いた時と大きさ・更新時刻が同じ時に限って区切って読み直す。
 */
const PCAD_OPEN_REREAD_CHANNEL = 'pcad:openReread';
/** 区切って渡す 1 回分の大きさ。ここだけで決め、開始の答えで画面へ知らせる(画面は自分で決めない)。 */
const PCAD_OPEN_CHUNK_BYTES = 8 * 1024 * 1024;
const OPEN_REQUEST_REFUSED = '読み込みの依頼の形が正しくありません。';
/**
 * 1 つの画面が同時に持てる途中の保存・途中の「開く」(読み直しを含む)の数と、1 つの候補を読み直せる回数。
 * 今の正しい使い方では、保存は documentSaveQueue で 1 本ずつ、「開く」は 1 本(読み直しはその後に多くて 1 回)なので、
 * 余裕を持たせた小さな数にする。超えた開始は断り、既にある保存・読込は変えない(壊れた描画の処理が記述子と一時ファイルを
 * 積み上げないため)。
 */
const MAX_SAVE_TRANSFERS_PER_SENDER = 4;
const MAX_OPEN_READS_PER_SENDER = 4;
const MAX_REREADS_PER_TARGET = 2;
/**
 * 「保存」は 4 本に分ける(案B、2026-11-13)。バイト列を 1 回の IPC で受けると、128MiB の部品で
 * 本体プロセスに「受け取った並び」と「IPC の作業領域」が同時に生き、保存中の追加の記憶量の山の
 * 大部分になっていた。開始で保存先を決め、`PCAD_SAVE_CHUNK_BYTES` ずつ一時ファイルへ追記し、確定で置き換える。
 */
const PCAD_SAVE_BEGIN_CHANNEL = 'pcad:saveBegin';
const PCAD_SAVE_CHUNK_CHANNEL = 'pcad:saveChunk';
const PCAD_SAVE_COMMIT_CHANNEL = 'pcad:saveCommit';
const PCAD_SAVE_ABORT_CHANNEL = 'pcad:saveAbort';
/** 分けて受け取る 1 回分の大きさ。ここだけで決め、開始の答えで画面へ知らせる(画面は自分で決めない)。 */
const PCAD_SAVE_CHUNK_BYTES = 8 * 1024 * 1024;
const SAVE_REQUEST_REFUSED = '保存の依頼の形が正しくありません。';
export const PCAD_HAS_TARGET_CHANNEL = 'pcad:hasTarget';
export const PCAD_CONFIRM_TARGET_CHANNEL = 'pcad:confirmTarget';
export const PCAD_CLEAR_TARGET_CHANNEL = 'pcad:clearTarget';
export const PCAD_OPEN_ANY_CHANNEL = 'pcad:openAny';
export const PCAD_SAVE_AS_CHANNEL = 'pcad:saveAs';
/**
 * 印刷(FR-810。P6 計画書 §2.11、タスク29)。**受け口は `main.ts` が登録する。**
 * ここはファイルの読み書きの場所で、印刷はダイアログではなく窓の仕事だから。
 */
export const PCAD_PRINT_CHANNEL = 'pcad:print';

const PCAD_EXTENSION = PCAD_DOTTED_EXTENSION.slice(1);
const DWG_GUIDE = 'DWGは直接読み書きできません。DXFへ変換する手順をヘルプで確認してください。';

/**
 * 「開く」が大きさを理由に断ったことを、画面側が**日本語の文面を見ずに**判別するための印
 * (P12-26 続き。要件§1.5「Web版とデスクトップ版に機能差を作らない」)。
 *
 * Electron の `ipcRenderer.invoke` の拒否は独自の例外クラスや追加の属性を運ばず、文面だけが
 * `Error invoking remote method '…': Error: <message>` の形で画面まで届く(preload は
 * そのまま横流しする素通しの口)。そこでこの固定の印を message の先頭に混ぜて運び、
 * `apps/desktop/src/renderer/desktopFileGateway.ts` が `message.includes(...)` だけで
 * 見分けて Web 版(`packages/ui/src/file/readBrowserFile.ts`)と同じ i18n の鍵
 * (`file.error.tooLarge` / `file.error.corrupted`)を選ぶ。印より後ろの日本語の文面を
 * 変えても印そのものは変わらないので、判定は壊れない。
 *
 * `desktopFileGateway.ts` は本体プロセス専用の `electron` / `node:fs` を抱き込むこのファイルを
 * import せず、同じ文字列を書き写している(直下のチャンネル名の定数と同じ理由。§36〜39 参照)。
 */
export const READ_TOO_LARGE_REASON_MARKER = 'PCAD_READ_TOO_LARGE:';
export const READ_SIZE_CHANGED_REASON_MARKER = 'PCAD_READ_SIZE_CHANGED:';
const READ_TOO_LARGE_MESSAGE = `${READ_TOO_LARGE_REASON_MARKER} ファイルが大きすぎます。種類ごとの読込上限を超えています。`;
const READ_SIZE_CHANGED_MESSAGE = `${READ_SIZE_CHANGED_REASON_MARKER} 読込中にファイルの大きさが変わりました。もう一度開いてください。`;
const READ_CHANGED_MESSAGE = `${READ_SIZE_CHANGED_REASON_MARKER} 読込中にファイルが変わりました。もう一度開いてください。`;

class InputTooLargeError extends Error {}
class ExportCancelledError extends Error {}

const PCAD_FILE_FILTER = nativeFileFilter('pcad');
const PCADA_FILE_FILTER = nativeFileFilter('pcada');
const PCADD_FILE_FILTER = nativeFileFilter('pcadd');

function documentFilters(kind: 'part' | 'assembly' | 'drawing' | 'all') {
  return kind === 'drawing' ? [PCADD_FILE_FILTER] : kind === 'assembly' ? [PCADA_FILE_FILTER] :
    kind === 'all' ? [PCAD_FILE_FILTER, PCADA_FILE_FILTER, PCADD_FILE_FILTER] : [PCAD_FILE_FILTER];
}

/** 「開く」で選ばれ、読むために開いたファイル。`path` と `handle` は本体プロセスの中だけで使う。 */
export interface OpenedPcadFile {
  /** 拡張子を含むファイル名(パスは含まない)。 */
  readonly name: string;
  /** ファイルの絶対パス。上書き先として覚えるためだけに使う。 */
  readonly path: string;
  /** 区切って読むために開いたままの記述子。読み終え・取消・画面が閉じた時に必ず閉じる。 */
  readonly handle: FileHandle;
  /** 開いた時の大きさ(上限の検査済み)。 */
  readonly size: number;
  /** 開いた時の更新時刻。読み終えた時に同じ記述子の stat と照合する。 */
  readonly modifiedAt: number;
}

/**
 * 保存先の名前を必ず `.pcad` で終わらせる。
 *
 * 画面側(`packages/ui/src/file/partFile.ts`)は返ってきた名前へ `.pcad` を足して表示するので、
 * ここで実ファイル名も揃えておかないと「画面の名前」と「ディスク上の名前」が食い違う。
 */
function withPcadExtension(filePath: string): string {
  return extname(filePath).toLowerCase() === `.${PCAD_EXTENSION}`
    ? filePath
    : `${filePath}.${PCAD_EXTENSION}`;
}

/** 種類ごとの読込の上限。部品などの「開く」(区切って読む)と種類つきの「開く」(readBytesFrom)の両方が使う。 */
function readLimitOf(filePath: string): number {
  // Script JSON may escape each source byte six times. Mirrors SCRIPT_FILE_LIMITS.bytes.
  const extension = extname(filePath).toLowerCase();
  return extension === '.csv' ? 1024 * 1024
    : extension === '.pcadscript' ? 6 * 1024 * 1024 + 65536 : MAX_COMPRESSED_INPUT_BYTES;
}

/**
 * ファイルを読む。失敗は日本語の `Error` にして `invoke` の拒否として返す。
 * 種類つきの読み込み(`pcad:openAny`)に使う(部品・アセンブリ・図面の「開く」は区切って読む `openForChunkedRead`)。
 *
 * 文面にパスを入れない。この文面は画面側まで届くため(NFR-SE-1)。
 * 大きさが理由の失敗(`InputTooLargeError`)には上の印を付けており、それを読み取った
 * `desktopFileGateway.ts` が Web 版と同じ `file.error.tooLarge` / `file.error.corrupted` を
 * 画面へ出す。それ以外の失敗で画面が利用者へ出す文言は `ja.json` の `file.openFailed` で、
 * ここの文面は記録用。
 */
async function readBytesFrom(filePath: string): Promise<Uint8Array> {
  if (extname(filePath).toLowerCase() === '.dwg') throw new Error(DWG_GUIDE);
  try {
    const metadata = await fileSystem.stat(filePath);
    const maximum = readLimitOf(filePath);
    if (metadata.size > maximum) {
      throw new InputTooLargeError(READ_TOO_LARGE_MESSAGE);
    }
    const contents = await fileSystem.readFile(filePath);
    if (contents.byteLength > maximum || contents.byteLength !== metadata.size) throw new InputTooLargeError(READ_SIZE_CHANGED_MESSAGE);
    // readFile の専有領域は view のまま渡す。転送・detach はしない。
    // pool の部分領域や共有領域は、前後のバイトを公開しない独立領域へ写す。
    if (contents.buffer instanceof ArrayBuffer && contents.byteOffset === 0
      && contents.byteLength === contents.buffer.byteLength) {
      return new Uint8Array(contents.buffer);
    }
    const bytes = new Uint8Array(contents.byteLength);
    bytes.set(contents);
    return bytes;
  } catch (cause) {
    if (cause instanceof InputTooLargeError) {
      throw cause;
    }
    throw new Error('ファイルを読めませんでした。', { cause });
  }
}

/**
 * 部品・アセンブリ・図面の「開く」: ファイルを読むために開き、同じ記述子の大きさと更新時刻を控える。本文はまだ読まない。
 * 上限は種類つきの「開く」と同じ(`readLimitOf`。大きければ本文を読まずに断る)。
 *
 * 読む途中の変化は「開いたままの記述子で読む」ことと「読み終えた時の記述子の stat を開いた時と照合する」ことで防ぐ。
 * 今の readFile の「開く」は大きさだけを照合していたが、区切って読むと IPC の往復の分だけ読む時間が延びるので、
 * 同じ大きさの書き換えも更新時刻で見つける。記述子は終わり・取消・画面の破棄で閉じ、持つのは区切りを読む間だけ。
 * Windows では、読むために開いている先への置換(rename)は EPERM で断られる(Node の open は削除の共有を付けて開くが、
 * 置換は開いている先には効かず、Node に置換の意味を変える口は無い)。そのため、読込と同じファイルへの保存の確定は
 * `replaceWithTemporary` の「控えを作ってから上書きする」道へ落ち、読込の側は終わりの照合で断る。
 */
async function openForChunkedRead(filePath: string): Promise<{ handle: FileHandle; size: number; modifiedAt: number }> {
  if (extname(filePath).toLowerCase() === '.dwg') throw new Error(DWG_GUIDE);
  let handle: FileHandle;
  try {
    handle = await fileSystem.open(filePath, 'r');
  } catch (cause) {
    throw new Error('ファイルを読めませんでした。', { cause });
  }
  try {
    const metadata = await handle.stat();
    if (metadata.size > readLimitOf(filePath)) throw new InputTooLargeError(READ_TOO_LARGE_MESSAGE);
    return { handle, size: metadata.size, modifiedAt: metadata.mtimeMs };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof InputTooLargeError) throw cause;
    throw new Error('ファイルを読めませんでした。', { cause });
  }
}

/** 存在すれば消す。一時ファイルの後始末用なので、存在しない場合を含め失敗は外へ出さない。 */
async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await fileSystem.unlink(filePath);
  } catch {
    // 保存の本来の成否を、一時ファイルの後始末だけで上書きしない。
  }
}

/**
 * ファイルを書く。同じディレクトリの一時ファイルを完成させてから置換する。
 * Windows で既存先への rename ができない場合は、元を控えてから上書きし、失敗時に戻す。
 */
function requireExportCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError('書き出しを取り消しました。');
}

/** 保存先と同じフォルダーの一時ファイルの名前。置換を同じボリュームの中の rename にするため。 */
function temporaryPathFor(filePath: string): string {
  return join(dirname(filePath), `${basename(filePath)}.tmp-${crypto.randomUUID()}`);
}

async function writeBytesTo(filePath: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const temporaryPath = temporaryPathFor(filePath);
  // flush: 書き終えたら sync してから閉じる(置換の前に中身をディスクへ。電源断で本物の名前が中身の無いファイルを指さない)。
  await replaceWithTemporary(filePath, temporaryPath, () => fileSystem.writeFile(temporaryPath, bytes,
    signal === undefined ? { flag: 'wx', flush: true } : { flag: 'wx', flush: true, signal }), signal);
}

/**
 * 分けて受け取った保存の一時ファイルを、ディスクへ書き出してから閉じる(置換の前)。sync が失敗したら閉じてから
 * 失敗を返し、置換の手順は保存の失敗として一時ファイルを消す(本物は変えない)。
 */
async function syncThenClose(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
  await handle.close();
}

/**
 * `finishTemporary` で一時ファイルを完成させてから、保存先を置き換える。置き換えの前は保存先に触れない。
 * 書き出し(`writeBytesTo`)と、分けて受け取る「保存」(`commitSaveTransfer`)の両方がこの 1 つの手順を使う。
 * 成否に関わらず一時ファイルは消し、復元できなかった時の控えだけを残す。
 */
async function replaceWithTemporary(filePath: string, temporaryPath: string,
  finishTemporary: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const directory = dirname(filePath);
  const backupPath = join(directory, `${basename(filePath)}.backup-${crypto.randomUUID()}`);
  let backupCreated = false;
  let backupMayBeRemoved = false;
  try {
    requireExportCurrent(signal);
    await finishTemporary();
    requireExportCurrent(signal);
    try {
      requireExportCurrent(signal);
      await fileSystem.rename(temporaryPath, filePath);
      return;
    } catch {
      requireExportCurrent(signal);
      try {
        await fileSystem.copyFile(filePath, backupPath, fileSystemConstants.COPYFILE_EXCL);
        backupCreated = true;
      } catch (backupCause) {
        throw new Error('保存先を安全に置換できませんでした。', {
          cause: backupCause,
        });
      }

      backupMayBeRemoved = true;
      requireExportCurrent(signal);
      try {
        await fileSystem.copyFile(temporaryPath, filePath);
      } catch (copyCause) {
        backupMayBeRemoved = false;
        try {
          await fileSystem.copyFile(backupPath, filePath);
          backupMayBeRemoved = true;
        } catch (restoreCause) {
          throw new AggregateError([copyCause, restoreCause], `${SAVE_RECOVERY_COPY_MARKER} 保存と復元に失敗しました。元の内容は同じフォルダーの .backup- を含む控えに残しています。`, {
            cause: restoreCause,
          });
        }
        throw copyCause;
      }
      backupMayBeRemoved = true;
    }
  } catch (cause) {
    if (hasSaveRecoveryCopy(cause)) throw cause;
    if (cause instanceof ExportCancelledError || signal?.aborted) throw new ExportCancelledError('書き出しを取り消しました。');
    throw new Error('ファイルを保存できませんでした。', { cause });
  } finally {
    await removeTemporaryFile(temporaryPath);
    // 復元不能時の正常なコピーは回収用に残す。後始末の失敗で保存を巻き戻さない。
    if (backupCreated && backupMayBeRemoved) await removeTemporaryFile(backupPath);
  }
}

/**
 * 「開く」。取り消されたら null。選ばれたファイルは読むために開いて返す(本文は `pcad:openChunk` で区切って読む)。
 *
 * 親の窓が分からないときは窓を付けずに出す(その場合 OS によっては前面に来ないことがあるが、
 * 開けなくなるよりはよい)。
 */
export async function openPcadDialog(window: BrowserWindow | null,
  kind: 'part' | 'assembly' | 'drawing' | 'all' = 'part'): Promise<OpenedPcadFile | null> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: documentFilters(kind),
  };
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  const filePath = result.filePaths[0];
  if (result.canceled || filePath === undefined) {
    return null;
  }
  return { name: basename(filePath), path: filePath, ...await openForChunkedRead(filePath) };
}

/**
 * 「保存」の保存先を決める。`saveAs` が false で `lastPath` を覚えていれば、窓を出さずにそこを返す
 * (Web 版が File System Access API でしている振る舞いと同じ)。取り消されたら null。
 * 書くのは分けて受け取った後の確定(`commitSaveTransfer`)。
 */
async function choosePcadSavePath(
  window: BrowserWindow | null,
  suggestedName: string,
  saveAs: boolean,
  lastPath: string | null,
  kind: 'part' | 'assembly' | 'drawing',
): Promise<string | null> {
  let filePath = saveAs ? null : lastPath;
  if (filePath === null) {
    const options: SaveDialogOptions = {
      // 「名前を付けて保存」でも、前に保存した場所と名前から始める。まだ無ければ画面が
      // 勧めてきた名前(既定の保存先フォルダに置かれる)。
      defaultPath: lastPath ?? suggestedName,
      filters: documentFilters(kind),
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    if (result.canceled || result.filePath === '') {
      return null;
    }
    filePath = kind === 'drawing'
      ? (extname(result.filePath).toLowerCase() === '.pcadd' ? result.filePath : `${result.filePath}.pcadd`)
      : kind === 'assembly'
      ? (extname(result.filePath).toLowerCase() === '.pcada' ? result.filePath : `${result.filePath}.pcada`)
      : withPcadExtension(result.filePath);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// 種類つきの「開く」「書き出す」(§2.2、§0.a-0.4・0.5)
// ---------------------------------------------------------------------------

/** 種類つきで開かれたファイル。**パスを持たない**(覚えないので要らない。NFR-SE-1)。 */
export interface OpenedAnyFile {
  /** 拡張子を含むファイル名(パスは含まない)。 */
  readonly name: string;
  /** どの種類として開かれたか。頼まれた種類の中から、拡張子で選び直したもの。 */
  readonly kind: string;
  readonly bytes: Uint8Array;
}

/** 表に載っている種類か。載っていなければ undefined。 */
function filterOf(kind: string): KindFilter | undefined {
  return isFileDialogKind(kind) ? nativeFileFilter(kind) : undefined;
}

/** 画面から来た「頼む種類の一覧」を確かめる。1 つも無い・知らない綴りが混じるものは受けない。 */
function toKnownKinds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const kinds: string[] = [];
  for (const kind of value) {
    if (typeof kind !== 'string' || filterOf(kind) === undefined) {
      return null;
    }
    kinds.push(kind);
  }
  return kinds;
}

/**
 * 選ばれたファイルの拡張子から、頼まれた種類のどれかを選び直す。
 * **頼まれていない種類には答えない**(画面側の `fileKindOfName` と同じ決まり)。
 */
function kindOfPath(filePath: string, kinds: readonly string[]): string | null {
  const extension = extname(filePath).toLowerCase().replace('.', '');
  for (const kind of kinds) {
    if (filterOf(kind)?.extensions.includes(extension) === true) {
      return kind;
    }
  }
  return null;
}

/** 保存先の名前を、その種類の代表の拡張子で終わらせる(`withPcadExtension` と同じ考え方)。 */
function withKindExtension(filePath: string, kind: string): string {
  const extensions = filterOf(kind)?.extensions ?? [];
  const current = extname(filePath).toLowerCase().replace('.', '');
  if (extensions.includes(current)) {
    return filePath;
  }
  const first = extensions[0];
  return first === undefined ? filePath : `${filePath}.${first}`;
}

/**
 * 種類を選んで「開く」。取り消されたら null。**上書き先は覚えない**(§0.a-0.4)。
 *
 * フィルタは頼まれた順に並べる(先頭が既定)。拡張子で種類を見分けられないファイルは
 * 断る。中身の先頭のバイト列で見分ける段構え(§0.a-0.27)は読み込む側の担当。
 */
export async function openAnyDialog(
  window: BrowserWindow | null,
  kinds: readonly string[],
): Promise<OpenedAnyFile | null> {
  if (kinds.length === 1 && kinds[0] === 'dwg') throw new Error(DWG_GUIDE);
  // Electron の `FileFilter` は書き換えられる並びを求めるので、写しを渡す。
  const filters: { name: string; extensions: string[] }[] = [];
  for (const kind of kinds) {
    const filter = filterOf(kind);
    if (filter !== undefined) {
      filters.push({ name: filter.name, extensions: [...filter.extensions] });
    }
  }
  const options: OpenDialogOptions = { properties: ['openFile'], filters };
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  const filePath = result.filePaths[0];
  if (result.canceled || filePath === undefined) {
    return null;
  }
  const kind = kindOfPath(filePath, kinds);
  if (extname(filePath).toLowerCase() === '.dwg') throw new Error(DWG_GUIDE);
  if (kind === null) {
    throw new Error('この拡張子のファイルは、頼まれた種類として読めません。');
  }
  return { name: basename(filePath), kind, bytes: await readBytesFrom(filePath) };
}

/**
 * 種類を選んで「書き出す」。**呼ぶたびに必ず窓を出す**(上書き先を覚えない。§0.a-0.4)。
 * 書けたら true、取り消されたら false。**返り値にパスも名前も含めない**(NFR-SE-1)。
 */
export async function saveAsDialog(window: BrowserWindow | null, fileName: string, kind: string,
  bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> {
  return await saveAsPathDialog(window, fileName, kind, bytes, signal) !== null;
}

async function saveAsPathDialog(
  window: BrowserWindow | null,
  fileName: string,
  kind: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  if (kind === 'dwg') throw new Error(DWG_GUIDE);
  const filter = filterOf(kind);
  const options: SaveDialogOptions = {
    // 画面が勧めてきた名前から始める(既定の保存先フォルダに置かれる)。
    defaultPath: fileName,
    filters:
      filter === undefined ? [] : [{ name: filter.name, extensions: [...filter.extensions] }],
  };
  const result =
    window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);
  if (result.canceled || result.filePath === '') {
    return null;
  }
  if (signal?.aborted) return null;
  const path = withKindExtension(result.filePath, kind);
  try {
    await writeBytesTo(path, bytes, signal);
  } catch (error) {
    if (error instanceof ExportCancelledError) return null;
    throw error;
  }
  if (signal?.aborted) return null; // A commit may already have completed; never delete it here.
  return path;
}

/**
 * 覚えている上書き先。**画面ごとに1つ**持つ(鍵は画面の識別子)。
 *
 * 窓が2つあるときに1つの控えを共有すると、片方の Ctrl+S がもう片方のファイルを
 * 上書きしてしまうため分ける。画面が閉じたら控えも捨てる。
 */
const lastPaths = new Map<number, string>();

/** 検証を通るまでの上書き先候補。実パスは本体プロセスの外へ出さない。 */
interface PendingSaveTarget {
  readonly token: string;
  readonly path: string;
  /** 読み終えた時の大きさと更新時刻。読み直し(`pcad:openReread`)は、これと同じファイルの時だけ読む。 */
  readonly size: number;
  readonly modifiedAt: number;
  /** この候補を読み直した回数(`MAX_REREADS_PER_TARGET` まで)。 */
  rereads: number;
}

const pendingPaths = new Map<number, PendingSaveTarget>();
const targetRevisions = new Map<number, object>();
const watchedWindowIds = new Set<number>();
let nextSaveTargetToken = 1;

/** 画面が閉じたとき、確定済み・未確定のどちらの控えも捨てる後始末を1度だけ付ける。 */
function watchWindow(event: IpcMainInvokeEvent): void {
  const contents = event.sender;
  const id = contents.id;
  if (watchedWindowIds.has(id)) {
    return;
  }
  watchedWindowIds.add(id);
  contents.once('destroyed', () => {
    lastPaths.delete(id);
    pendingPaths.delete(id);
    targetRevisions.delete(id);
    watchedWindowIds.delete(id);
    abortSenderWork(id);
  });
  // 読み直し・描画の処理の終了では送り手が消えるので、途中の保存の一時ファイルを捨て(本物には触れない)、
  // 途中の「開く」の開いたままのファイルを閉じる。
  contents.on('did-navigate', () => { abortSenderWork(id); });
  contents.on('render-process-gone', () => { abortSenderWork(id); });
}

/** 送り手の途中の保存と途中の「開く」を、どちらも片付ける。 */
function abortSenderWork(senderId: number): void {
  abortSenderTransfers(senderId);
  abortSenderOpenReads(senderId);
}

/** 分けて受け取っている途中の「保存」1 回分。実パスと一時ファイルは本体プロセスの中だけで持つ。 */
interface PcadSaveTransfer {
  readonly senderId: number;
  readonly path: string;
  readonly temporaryPath: string;
  readonly handle: FileHandle;
  readonly totalBytes: number;
  /** 開始の時の `targetRevisions` の版。確定の時に変わっていれば上書き先として覚えない(今の `pcad:save` と同じ決まり)。 */
  readonly revision: object;
  receivedBytes: number;
  nextIndex: number;
  busy: boolean;
}

/** 保存ごとの識別子(本体が開始で作る)→ 途中の保存。同時に複数あってよい(画面が閉じる・取消・確定で消える)。 */
const saveTransfers = new Map<string, PcadSaveTransfer>();
let exitCleanupRegistered = false;

/** 区切って渡している途中の「開く」1 回分。実パスと記述子は本体プロセスの中だけで持つ。 */
interface PcadOpenRead {
  readonly senderId: number;
  readonly path: string;
  readonly handle: FileHandle;
  readonly size: number;
  readonly modifiedAt: number;
  /** 読み直しの時だけ、その候補の token。終わりで候補を作り直さず、同じ token を返す。 */
  readonly rereadToken: string | null;
  sentBytes: number;
  nextIndex: number;
  busy: boolean;
}

/** 「開く」ごとの識別子(本体が開始で作る)→ 途中の「開く」。終わり・取消・画面が閉じる・アプリの終了で消える。 */
const openReads = new Map<string, PcadOpenRead>();

/**
 * 表から外して非同期の片付け(閉じる・一時ファイルを消す・確定の置換)を始めた保存と「開く」。片付けが終わるまで、
 * アプリの終了の同期の片付けから見えるように残す(終了が先に来ても一時ファイルを残さず、記述子を閉じる)。
 */
const settlingTransfers = new Set<PcadSaveTransfer>();
const settlingReads = new Set<PcadOpenRead>();

/** その画面の途中の保存・「開く」の数(上限の確かめに使う)。 */
function countBySender(entries: Iterable<{ readonly senderId: number }>, senderId: number): number {
  let count = 0;
  for (const entry of entries) if (entry.senderId === senderId) count += 1;
  return count;
}

/** 途中の保存を捨てる。一時ファイルを閉じて消し、保存先には触れない。2 回呼んでも片付けは 1 回。 */
async function abortSaveTransfer(transferId: string): Promise<void> {
  const transfer = saveTransfers.get(transferId);
  if (transfer === undefined) return;
  saveTransfers.delete(transferId);
  settlingTransfers.add(transfer);
  try {
    await transfer.handle.close().catch(() => undefined);
    await removeTemporaryFile(transfer.temporaryPath);
  } finally {
    settlingTransfers.delete(transfer);
  }
}

function abortSenderTransfers(senderId: number): void {
  for (const [transferId, transfer] of saveTransfers) {
    if (transfer.senderId === senderId) void abortSaveTransfer(transferId);
  }
}

/**
 * アプリの終了で非同期の片付けが間に合わない時のため、終了の直前に残りの一時ファイルを同期で消し、
 * 途中の「開く」の開いたままのファイルを同期で閉じる。片付けを始めた物・確定中の物(settling)も見る。
 */
function removeTransfersAtExit(): void {
  for (const transfer of [...saveTransfers.values(), ...settlingTransfers]) {
    try { closeSync(transfer.handle.fd); } catch { /* 閉じ済みでよい */ }
    try { unlinkSync(transfer.temporaryPath); } catch { /* 無い(置換の後)ならよい */ }
  }
  saveTransfers.clear();
  settlingTransfers.clear();
  for (const read of [...openReads.values(), ...settlingReads]) {
    try { closeSync(read.handle.fd); } catch { /* 閉じ済みでよい */ }
  }
  openReads.clear();
  settlingReads.clear();
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  process.once('exit', removeTransfersAtExit);
  exitCleanupRegistered = true;
}

/** 形の違う依頼を断る。途中の保存は捨てて、同じ識別子では続けさせない。 */
async function refuseSaveTransfer(transferId: string): Promise<never> {
  await abortSaveTransfer(transferId);
  throw new Error(SAVE_REQUEST_REFUSED);
}

/** 画面から来た識別子の保存を探す。知らない・終わった・別の画面の識別子は断る(他の保存は捨てない)。 */
function ownTransfer(event: IpcMainInvokeEvent, transferId: unknown): { readonly id: string; readonly transfer: PcadSaveTransfer } {
  const transfer = typeof transferId === 'string' ? saveTransfers.get(transferId) : undefined;
  if (typeof transferId !== 'string' || transfer === undefined || transfer.senderId !== event.sender.id) {
    throw new Error(SAVE_REQUEST_REFUSED);
  }
  return { id: transferId, transfer };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * 「保存」の開始。形を確かめ(合計は読込の上限 `MAX_COMPRESSED_INPUT_BYTES` まで。読めないファイルで開ける元を
 * 上書きしない)、保存先を決め、同じフォルダーに一時ファイルを排他で作る。取り消されたら null。
 */
async function beginSaveTransfer(event: IpcMainInvokeEvent, args: readonly unknown[]):
  Promise<{ transferId: string; chunkBytes: number } | null> {
  const [suggestedName, saveAs, kind, totalBytes] = args;
  if (args.length !== 4 || typeof suggestedName !== 'string' || typeof saveAs !== 'boolean'
    || (kind !== 'part' && kind !== 'assembly' && kind !== 'drawing')
    || typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error(SAVE_REQUEST_REFUSED);
  }
  if (totalBytes > MAX_COMPRESSED_INPUT_BYTES) {
    throw new Error('ファイルが大きすぎるため保存できません。開ける大きさの上限を超えています。');
  }
  if (countBySender(saveTransfers.values(), event.sender.id) >= MAX_SAVE_TRANSFERS_PER_SENDER) throw new Error(SAVE_REQUEST_REFUSED);
  watchWindow(event);
  const senderId = event.sender.id, revision = {};
  targetRevisions.set(senderId, revision);
  const path = await choosePcadSavePath(windowOf(event), suggestedName, saveAs, lastPaths.get(senderId) ?? null, kind);
  // 窓の間に画面が閉じたら送り手がいないので、一時ファイルを作らない。
  if (path === null || !watchedWindowIds.has(senderId)) return null;
  const temporaryPath = temporaryPathFor(path);
  let handle: FileHandle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
  } catch (cause) {
    throw new Error('ファイルを保存できませんでした。', { cause });
  }
  if (countBySender(saveTransfers.values(), senderId) >= MAX_SAVE_TRANSFERS_PER_SENDER) {
    // 窓の間に同じ画面の別の開始が上限まで埋めた。この一時ファイルだけを捨てる。
    await handle.close().catch(() => undefined);
    await removeTemporaryFile(temporaryPath);
    throw new Error(SAVE_REQUEST_REFUSED);
  }
  const transferId = crypto.randomUUID();
  saveTransfers.set(transferId, { senderId, path, temporaryPath, handle, totalBytes, revision,
    receivedBytes: 0, nextIndex: 0, busy: false });
  if (!watchedWindowIds.has(senderId)) {
    await abortSaveTransfer(transferId);
    return null;
  }
  return { transferId, chunkBytes: PCAD_SAVE_CHUNK_BYTES };
}

/**
 * 分けた 1 回分を受け取り、一時ファイルの続きへ書く。通し番号は 0 から 1 つずつ(入れ違い・欠け・二重を断る)、
 * 最後の回より前は `PCAD_SAVE_CHUNK_BYTES` ちょうど、合計は開始の長さまで、中身は送り手の SHA-256 と一致すること。
 * 1 つの保存の回は 1 つずつ(前の回を書いている間の次の回は断る)。
 */
async function receiveSaveChunk(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<true> {
  const [transferId, index, bytes, digest] = args;
  const { id, transfer } = ownTransfer(event, transferId);
  const position = transfer.receivedBytes;
  // IPC が届ける並びは ArrayBuffer の上にある。共有の領域の並びは断る(写さずに同じ領域の見せ方として扱う)。
  const piece = bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  if (args.length !== 4 || transfer.busy || index !== transfer.nextIndex || piece === null
    || typeof digest !== 'string' || piece.byteLength === 0 || piece.byteLength > PCAD_SAVE_CHUNK_BYTES
    || position + piece.byteLength > transfer.totalBytes
    || (position + piece.byteLength < transfer.totalBytes && piece.byteLength !== PCAD_SAVE_CHUNK_BYTES)) {
    return refuseSaveTransfer(id);
  }
  transfer.busy = true;
  transfer.nextIndex += 1;
  transfer.receivedBytes += piece.byteLength;
  try {
    if (await sha256Hex(piece) !== digest || saveTransfers.get(id) !== transfer) return await refuseSaveTransfer(id);
    try {
      for (let written = 0; written < piece.byteLength;) {
        const { bytesWritten } = await transfer.handle.write(piece, written, piece.byteLength - written, position + written);
        if (bytesWritten <= 0) throw new Error('一時ファイルへ書き込めませんでした。');
        written += bytesWritten;
      }
    } catch (cause) {
      await abortSaveTransfer(id);
      throw new Error('ファイルを保存できませんでした。', { cause });
    }
  } finally {
    transfer.busy = false;
  }
  return true;
}

/**
 * 確定。全部届いたことを確かめ、一時ファイルをディスクへ書き出して(sync)から閉じ、書き出しと同じ置換の手順で
 * 保存先を置き換える。開始の後に保存先の解除・別の保存の開始があれば、書いたうえで上書き先としては覚えず null を返す(今の決まり)。
 */
async function commitSaveTransfer(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<string | null> {
  const { id, transfer } = ownTransfer(event, args[0]);
  if (args.length !== 1 || transfer.busy || transfer.receivedBytes !== transfer.totalBytes) return refuseSaveTransfer(id);
  saveTransfers.delete(id);
  settlingTransfers.add(transfer);
  try {
    await replaceWithTemporary(transfer.path, transfer.temporaryPath, () => syncThenClose(transfer.handle));
  } finally {
    settlingTransfers.delete(transfer);
  }
  if (targetRevisions.get(event.sender.id) !== transfer.revision) return null;
  rememberPath(event, transfer.path);
  return basename(transfer.path);
}

/** 保存の 4 本の口を登録する。どの口も、許可していない送り手には副作用より先に答える。 */
function registerSaveTransferIpc(): void {
  ipcMain.handle(PCAD_SAVE_BEGIN_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? beginSaveTransfer(event, args) : null);
  ipcMain.handle(PCAD_SAVE_CHUNK_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? receiveSaveChunk(event, args) : false);
  ipcMain.handle(PCAD_SAVE_COMMIT_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? commitSaveTransfer(event, args) : null);
  ipcMain.handle(PCAD_SAVE_ABORT_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<void> => {
    if (!validateAppSender(event)) return;
    const [transferId] = args;
    const transfer = typeof transferId === 'string' ? saveTransfers.get(transferId) : undefined;
    // 終わった・知らない・別の画面の識別子は何もしない(その保存の持ち主ではない)。
    if (typeof transferId === 'string' && transfer?.senderId === event.sender.id) await abortSaveTransfer(transferId);
  });
}

/** 途中の「開く」をやめ、開いたままのファイルを閉じる。2 回呼んでも片付けは 1 回。 */
async function abortOpenRead(readId: string): Promise<void> {
  const read = openReads.get(readId);
  if (read === undefined) return;
  openReads.delete(readId);
  settlingReads.add(read);
  try {
    await read.handle.close().catch(() => undefined);
  } finally {
    settlingReads.delete(read);
  }
}

function abortSenderOpenReads(senderId: number): void {
  for (const [readId, read] of openReads) {
    if (read.senderId === senderId) void abortOpenRead(readId);
  }
}

/** 形の違う依頼を断る。途中の「開く」は閉じて、同じ識別子では続けさせない。 */
async function refuseOpenRead(readId: string): Promise<never> {
  await abortOpenRead(readId);
  throw new Error(OPEN_REQUEST_REFUSED);
}

/** 画面から来た識別子の「開く」を探す。知らない・終わった・別の画面の識別子は断る(他の「開く」は閉じない)。 */
function ownOpenRead(event: IpcMainInvokeEvent, readId: unknown): { readonly id: string; readonly read: PcadOpenRead } {
  const read = typeof readId === 'string' ? openReads.get(readId) : undefined;
  if (typeof readId !== 'string' || read === undefined || read.senderId !== event.sender.id) {
    throw new Error(OPEN_REQUEST_REFUSED);
  }
  return { id: readId, read };
}

/**
 * 「開く」の開始。窓を出し、選ばれたファイルを読むために開いて(上限の検査は本文を読む前)、一時的な識別子・
 * 名前・大きさ・分ける大きさだけを返す。本文もパスも返さない。取り消されたら null。引数は種類 1 つ(preload は
 * 省いた種類も undefined として 1 つ送る)で、数や種類が違えば窓を出さずに null。同じ画面の途中の「開く」が上限なら断る。
 */
async function beginOpenRead(event: IpcMainInvokeEvent, args: readonly unknown[]):
  Promise<{ readId: string; name: string; size: number; chunkBytes: number } | null> {
  if (args.length !== 1) return null;
  const [kind = 'part'] = args;
  if (kind !== 'part' && kind !== 'assembly' && kind !== 'drawing' && kind !== 'all') return null;
  const senderId = event.sender.id;
  if (countBySender(openReads.values(), senderId) >= MAX_OPEN_READS_PER_SENDER) throw new Error(OPEN_REQUEST_REFUSED);
  // 未確定の候補は次の「開く」を始めた時点で失効する。確定済みの先はまだ保つ。
  pendingPaths.delete(senderId);
  watchWindow(event);
  const opened = await openPcadDialog(windowOf(event), kind);
  if (opened === null) return null;
  // 窓の間に画面が閉じたら送り手がいないので、開いたファイルをすぐ閉じる。
  if (!watchedWindowIds.has(senderId)) {
    await opened.handle.close().catch(() => undefined);
    return null;
  }
  if (countBySender(openReads.values(), senderId) >= MAX_OPEN_READS_PER_SENDER) {
    await opened.handle.close().catch(() => undefined);
    throw new Error(OPEN_REQUEST_REFUSED);
  }
  const readId = crypto.randomUUID();
  openReads.set(readId, { senderId, path: opened.path, handle: opened.handle, size: opened.size,
    modifiedAt: opened.modifiedAt, rereadToken: null, sentBytes: 0, nextIndex: 0, busy: false });
  return { readId, name: opened.name, size: opened.size, chunkBytes: PCAD_OPEN_CHUNK_BYTES };
}

/**
 * 読み直しの開始。画面から来るのは token だけで、パスは本体が今の候補から決める。候補が今の物でない(次の「開く」・確定・
 * 解除の後)・別の画面の時は断る。開いた時と大きさ・更新時刻が違えば(保存し直された等)、同じ中身を返せないので
 * 読込中の変化の失敗にする。答えは開始と同じ形で、本文は `pcad:openChunk` で区切って読む。1 つの候補の読み直しは
 * `MAX_REREADS_PER_TARGET` 回まで、同じ画面の途中の「開く」と合わせて `MAX_OPEN_READS_PER_SENDER` 本まで。
 */
async function beginOpenReread(event: IpcMainInvokeEvent, args: readonly unknown[]):
  Promise<{ readId: string; name: string; size: number; chunkBytes: number }> {
  const [token] = args;
  const senderId = event.sender.id;
  const pending = pendingPaths.get(senderId);
  if (args.length !== 1 || typeof token !== 'string' || pending === undefined || pending.token !== token
    || pending.rereads >= MAX_REREADS_PER_TARGET || countBySender(openReads.values(), senderId) >= MAX_OPEN_READS_PER_SENDER) {
    throw new Error(OPEN_REQUEST_REFUSED);
  }
  pending.rereads += 1;
  const opened = await openForChunkedRead(pending.path);
  if (opened.size !== pending.size || opened.modifiedAt !== pending.modifiedAt
    || pendingPaths.get(senderId) !== pending || !watchedWindowIds.has(senderId)) {
    await opened.handle.close().catch(() => undefined);
    if (pendingPaths.get(senderId) !== pending || !watchedWindowIds.has(senderId)) throw new Error(OPEN_REQUEST_REFUSED);
    throw new InputTooLargeError(READ_CHANGED_MESSAGE);
  }
  const readId = crypto.randomUUID();
  openReads.set(readId, { senderId, path: pending.path, handle: opened.handle, size: opened.size,
    modifiedAt: opened.modifiedAt, rereadToken: token, sentBytes: 0, nextIndex: 0, busy: false });
  return { readId, name: basename(pending.path), size: opened.size, chunkBytes: PCAD_OPEN_CHUNK_BYTES };
}

/** position から length バイトちょうどを、その回の長さだけの新しい並びへ読む。足りなければ大きさが変わった失敗。 */
async function readExactly(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const piece = new Uint8Array(length);
  for (let filled = 0; filled < length;) {
    const { bytesRead } = await handle.read(piece, filled, length - filled, position + filled);
    if (bytesRead <= 0) throw new InputTooLargeError(READ_SIZE_CHANGED_MESSAGE);
    filled += bytesRead;
  }
  return piece;
}

/**
 * 区切りの 1 回分を読んで返す。通し番号は 0 から 1 つずつ(入れ違い・欠け・二重・読み過ぎを断る)、長さは
 * 最後の回より前は `PCAD_OPEN_CHUNK_BYTES` ちょうど。1 つの「開く」の回は 1 つずつ(前の回を読んでいる間の次の回は断る)。
 * 返す並びはその回の長さだけの独立した領域(大きい並びの見せ方を返すと、構造化複製が全体を写す)。
 */
async function readOpenChunk(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<Uint8Array> {
  const [readId, index] = args;
  const { id, read } = ownOpenRead(event, readId);
  if (args.length !== 2 || read.busy || index !== read.nextIndex || read.sentBytes >= read.size) return refuseOpenRead(id);
  const position = read.sentBytes;
  const length = Math.min(PCAD_OPEN_CHUNK_BYTES, read.size - position);
  read.busy = true;
  let piece: Uint8Array;
  try {
    piece = await readExactly(read.handle, position, length);
  } catch (cause) {
    await abortOpenRead(id);
    if (cause instanceof InputTooLargeError) throw cause;
    throw new Error('ファイルを読めませんでした。', { cause });
  } finally {
    read.busy = false;
  }
  if (openReads.get(id) !== read) throw new Error(OPEN_REQUEST_REFUSED);
  read.nextIndex += 1;
  read.sentBytes += length;
  return piece;
}

/** 開いたままの記述子の今の大きさと更新時刻を読んでから閉じる(読めても読めなくても必ず閉じる)。 */
async function statThenClose(handle: FileHandle): Promise<{ readonly size: number; readonly modifiedAt: number }> {
  try {
    const metadata = await handle.stat();
    return { size: metadata.size, modifiedAt: metadata.mtimeMs };
  } catch (cause) {
    throw new Error('ファイルを読めませんでした。', { cause });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 終わり。全部を渡したことを確かめ、同じ記述子の大きさと更新時刻が開いた時と同じかを照合してから閉じ、
 * 実パスを未確定の上書き先の候補に結び付けて token を返す(今の「開く」と同じく、確定は文書の検証の後)。
 * 変わっていたら読込中の変化の失敗にし、候補を作らない。
 */
async function finishOpenRead(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<string> {
  const { id, read } = ownOpenRead(event, args[0]);
  if (args.length !== 1 || read.busy || read.sentBytes !== read.size) return refuseOpenRead(id);
  openReads.delete(id);
  settlingReads.add(read);
  const current = await statThenClose(read.handle).finally(() => { settlingReads.delete(read); });
  if (current.size !== read.size) throw new InputTooLargeError(READ_SIZE_CHANGED_MESSAGE);
  if (current.modifiedAt !== read.modifiedAt) throw new InputTooLargeError(READ_CHANGED_MESSAGE);
  if (read.rereadToken !== null) {
    // 読み直しは候補を作り直さない。読む間に候補が替わっていたら(次の「開く」・確定・解除)断る。
    if (pendingPaths.get(event.sender.id)?.token !== read.rereadToken) throw new Error(OPEN_REQUEST_REFUSED);
    return read.rereadToken;
  }
  return rememberPendingPath(event, read.path, current);
}

/** 開く 5 本の口を登録する。どの口も、許可していない送り手には副作用より先に答える。 */
function registerOpenReadIpc(): void {
  ipcMain.handle(PCAD_OPEN_BEGIN_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? beginOpenRead(event, args) : null);
  ipcMain.handle(PCAD_OPEN_REREAD_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? beginOpenReread(event, args) : null);
  ipcMain.handle(PCAD_OPEN_CHUNK_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? readOpenChunk(event, args) : null);
  ipcMain.handle(PCAD_OPEN_FINISH_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    validateAppSender(event) ? finishOpenRead(event, args) : null);
  ipcMain.handle(PCAD_OPEN_ABORT_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<void> => {
    if (!validateAppSender(event)) return;
    const [readId] = args;
    const read = typeof readId === 'string' ? openReads.get(readId) : undefined;
    // 終わった・知らない・別の画面の識別子は何もしない(その「開く」の持ち主ではない)。
    if (typeof readId === 'string' && read?.senderId === event.sender.id) await abortOpenRead(readId);
  });
}

/** 上書き先を確定し、同じ画面の未確定候補を消す。 */
function rememberPath(event: IpcMainInvokeEvent, filePath: string): void {
  watchWindow(event);
  lastPaths.set(event.sender.id, filePath);
  pendingPaths.delete(event.sender.id);
}

/** 開いた実パスを、読み終えた時の大きさ・更新時刻と一緒に未確定の token に結び付ける。前の候補は呼び出し側で先に捨てる。 */
function rememberPendingPath(event: IpcMainInvokeEvent, filePath: string,
  identity: { readonly size: number; readonly modifiedAt: number }): string {
  watchWindow(event);
  const token = `save-target-${String(nextSaveTargetToken)}`;
  nextSaveTargetToken += 1;
  pendingPaths.set(event.sender.id, { token, path: filePath, size: identity.size, modifiedAt: identity.modifiedAt, rereads: 0 });
  return token;
}

/** 現在の文書の保存先と、未確定の候補を一緒に解除する。 */
function clearSaveTargets(event: IpcMainInvokeEvent): void {
  clearExportHandoff(event.sender.id);
  watchWindow(event);
  targetRevisions.set(event.sender.id, {});
  lastPaths.delete(event.sender.id);
  pendingPaths.delete(event.sender.id);
}

/** 依頼を出してきた画面の窓。取れなければ null(窓なしでダイアログを出す)。 */
function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/**
 * IPC を登録する。部品は開く 5 本(`registerOpenReadIpc`) / `pcad:confirmTarget` / `pcad:clearTarget` /
 * 保存の 4 本(`registerSaveTransferIpc`) / `pcad:hasTarget`、種類つきは `pcad:openAny` / `pcad:saveAs` の2本
 * (§0.a-0.5)。
 *
 * 往復する値は文字列・真偽・`Uint8Array`・文字列の並びに限る(構造化複製でそのまま往復できるもの)。
 * 画面から来た値は素性が分からないので、使う前に必ず形を確かめる。
 *
 * `app.whenReady()` の中から1回だけ呼ぶ(2回呼ぶと Electron が二重登録で失敗する)。
 */
export function registerPcadIpc(): void {
  registerExportHandoffIpc(saveAsPathDialog);
  registerExitCleanup();
  registerOpenReadIpc();

  ipcMain.handle(
    PCAD_CONFIRM_TARGET_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): boolean => {
      if (!validateAppSender(event)) {
        return false;
      }
      const [token] = args;
      if (typeof token !== 'string') {
        throw new Error('保存先の確定依頼の形が正しくありません。');
      }
      const pending = pendingPaths.get(event.sender.id);
      if (pending?.token !== token) {
        // 古い確定依頼は、別の文書の確定済み保存先を解除しない。
        return false;
      }
      targetRevisions.set(event.sender.id, {});
      rememberPath(event, pending.path);
      return true;
    },
  );

  ipcMain.handle(PCAD_CLEAR_TARGET_CHANNEL, (event: IpcMainInvokeEvent): void => {
    if (!validateAppSender(event)) {
      return;
    }
    clearSaveTargets(event);
  });

  registerSaveTransferIpc();

  ipcMain.handle(PCAD_HAS_TARGET_CHANNEL, (event: IpcMainInvokeEvent): boolean => {
    if (!validateAppSender(event)) {
      return false;
    }
    return lastPaths.has(event.sender.id);
  });

  ipcMain.handle(
    PCAD_OPEN_ANY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<OpenedAnyFile | null> => {
      if (!validateAppSender(event)) {
        return null;
      }
      const kinds = toKnownKinds(args[0]);
      if (kinds === null) {
        throw new Error('読み込みの依頼の形が正しくありません。');
      }
      // `rememberPath` を呼ばない。ここで開いたものは上書き先にしない(§0.a-0.4)。
      return openAnyDialog(windowOf(event), kinds);
    },
  );

  ipcMain.handle(
    PCAD_SAVE_AS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
      if (!validateAppSender(event)) {
        return false;
      }
      const [fileName, kind, bytes, requestId] = args;
      if (
        (args.length !== 3 && args.length !== 4) ||
        typeof fileName !== 'string' ||
        typeof kind !== 'string' ||
        filterOf(kind) === undefined ||
        !(bytes instanceof Uint8Array)
      ) {
        throw new Error('保存の依頼の形が正しくありません。');
      }
      // `rememberPath` を呼ばない。書き出した先は覚えないので、次の Ctrl+S は部品へ向かう。
      clearExportHandoff(event.sender.id);
      const attempt = beginExportWrite(event, requestId);
      if (attempt === null) return false;
      try {
        return await saveAsDialog(windowOf(event), fileName, kind, bytes, attempt.signal);
      } finally {
        attempt.finish();
      }
    },
  );
}
