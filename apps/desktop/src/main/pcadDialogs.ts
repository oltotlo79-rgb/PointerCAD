import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { constants as fileSystemConstants, promises as fileSystem } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { SAVE_RECOVERY_COPY_MARKER, hasSaveRecoveryCopy } from '@pointercad/ui/save-errors';

import { validateAppSender } from './appSender.js';

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
 * **上書き先を扱うのは `.pcad` の 5 本(`pcad:open` / `pcad:confirmTarget` /
 * `pcad:clearTarget` / `pcad:save` / `pcad:hasTarget`)だけ。** `pcad:open` は実パスを
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
export const PCAD_OPEN_CHANNEL = 'pcad:open';
export const PCAD_SAVE_CHANNEL = 'pcad:save';
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

/** 部品ファイルの拡張子(要件§8)。 */
const PCAD_EXTENSION = 'pcad';

/** `packages/io/src/limits.ts` の圧縮済み入力上限と同じ値。desktop は io に依存しないため写す。 */
const MAX_COMPRESSED_INPUT_BYTES = 256 * 1024 * 1024;

class InputTooLargeError extends Error {}

/**
 * ファイル選択の窓に出す種別。
 *
 * 文言は `packages/ui/src/i18n/ja.json` の `file.typeDescription` と同じにしてある
 * (Web 版のファイル選択と同じ表示にするため)。本体プロセスから ja.json を引くには
 * `@pointercad/ui` を本体側の束へ持ち込むことになり、画面用の実装まで抱き込むので写している。
 * 窓の題名は指定しない。指定しなければ OS が「開く」「名前を付けて保存」を各国語で出す。
 */
const PCAD_FILE_FILTER = { name: 'PointerCAD の部品ファイル', extensions: [PCAD_EXTENSION] };
const PCADA_FILE_FILTER = { name: 'PointerCAD のアセンブリファイル', extensions: ['pcada'] };
const PCADD_FILE_FILTER = { name: 'PointerCAD の図面ファイル', extensions: ['pcadd'] };

function documentFilters(kind: 'part' | 'assembly' | 'drawing' | 'all') {
  return kind === 'drawing' ? [PCADD_FILE_FILTER] : kind === 'assembly' ? [PCADA_FILE_FILTER] :
    kind === 'all' ? [PCAD_FILE_FILTER, PCADA_FILE_FILTER, PCADD_FILE_FILTER] : [PCAD_FILE_FILTER];
}

/** ダイアログのフィルタ 1 つぶん(Electron の `FileFilter` と同じ形)。 */
interface KindFilter {
  readonly name: string;
  /** 拡張子。**先頭の `.` を付けない**(Electron の決まり)。先頭が代表で、書き出しのときに足す。 */
  readonly extensions: readonly string[];
}

/**
 * ファイルの種類ごとのダイアログのフィルタ(§2.2)。
 *
 * **正本は `packages/ui/src/file/fileGateway.ts` の表**で、ここはその写しである。写している
 * 理由は上の `PCAD_FILE_FILTER` と同じで、本体プロセスから `@pointercad/ui` を読むと
 * 画面用の実装まで本体側の束へ入ってしまうため。**片方を直したらもう片方も直す。**
 *
 * 鍵は `FileKind`(`@pointercad/model`)の文字列。本体プロセスはその型を持てない(依存が
 * `@pointercad/ui` だけ)ので、鍵の綴りは文字列として持ち、画面から来た値はこの表に
 * 載っているかどうかだけで確かめる。
 */
const KIND_FILTERS: Readonly<Record<string, KindFilter | undefined>> = {
  zip: { name: 'ZIP', extensions: ['zip'] },
  pcada: PCADA_FILE_FILTER,
  pcad: PCAD_FILE_FILTER,
  pcadt: { name: 'PointerCAD', extensions: ['pcadt'] },
  step: { name: 'STEP', extensions: ['step', 'stp'] },
  stl: { name: 'STL', extensions: ['stl'] },
  obj: { name: 'OBJ', extensions: ['obj'] },
  glb: { name: 'glTF', extensions: ['glb', 'gltf'] },
  '3mf': { name: '3MF', extensions: ['3mf'] },
  dxf: { name: 'DXF', extensions: ['dxf'] },
  svg: { name: 'SVG', extensions: ['svg'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
  png: { name: 'PNG', extensions: ['png'] },
  jpg: { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
};

/** 「開く」で選ばれたファイル。`path` は本体プロセスの中だけで使う。 */
export interface OpenedPcadFile {
  /** 拡張子を含むファイル名(パスは含まない)。 */
  readonly name: string;
  /** ファイルの絶対パス。上書き先として覚えるためだけに使う。 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** 「保存」で書き込んだ先。`path` は本体プロセスの中だけで使う。 */
export interface SavedPcadFile {
  readonly name: string;
  readonly path: string;
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

/**
 * ファイルを読む。失敗は日本語の `Error` にして `invoke` の拒否として返す。
 * 部品ファイルにも、種類つきの読み込み(`pcad:openAny`)にも同じものを使う。
 *
 * 文面にパスを入れない。この文面は画面側まで届くため(NFR-SE-1)。画面が利用者へ出す文言は
 * `ja.json` の `file.openFailed` で、ここの文面は記録用。
 */
async function readBytesFrom(filePath: string): Promise<Uint8Array> {
  try {
    const metadata = await fileSystem.stat(filePath);
    if (metadata.size > MAX_COMPRESSED_INPUT_BYTES) {
      throw new InputTooLargeError('ファイルが大きすぎます（上限は 256 MiB です）。');
    }
    const contents = await fileSystem.readFile(filePath);
    // Buffer は Node の内部で使い回す記憶を指すことがあるので、自前の記憶へ写してから渡す。
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
async function writeBytesTo(filePath: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `${basename(filePath)}.tmp-${crypto.randomUUID()}`);
  const backupPath = join(directory, `${basename(filePath)}.backup-${crypto.randomUUID()}`);
  let backupCreated = false;
  let backupMayBeRemoved = false;
  try {
    await fileSystem.writeFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await fileSystem.rename(temporaryPath, filePath);
      return;
    } catch {
      try {
        await fileSystem.copyFile(filePath, backupPath, fileSystemConstants.COPYFILE_EXCL);
        backupCreated = true;
      } catch (backupCause) {
        throw new Error('保存先を安全に置換できませんでした。', {
          cause: backupCause,
        });
      }

      try {
        await fileSystem.copyFile(temporaryPath, filePath);
      } catch (copyCause) {
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
    throw new Error('ファイルを保存できませんでした。', { cause });
  } finally {
    await removeTemporaryFile(temporaryPath);
    // 復元不能時の正常なコピーは回収用に残す。後始末の失敗で保存を巻き戻さない。
    if (backupCreated && backupMayBeRemoved) await removeTemporaryFile(backupPath);
  }
}

/**
 * 「開く」。取り消されたら null。
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
  return { name: basename(filePath), path: filePath, bytes: await readBytesFrom(filePath) };
}

/**
 * 「保存」。`saveAs` が false で `lastPath` を覚えていれば、窓を出さずにそこへ上書きする
 * (Web 版が File System Access API でしている振る舞いと同じ)。取り消されたら null。
 */
export async function savePcadDialog(
  window: BrowserWindow | null,
  suggestedName: string,
  bytes: Uint8Array,
  saveAs: boolean,
  lastPath: string | null,
  kind: 'part' | 'assembly' | 'drawing' = 'part',
): Promise<SavedPcadFile | null> {
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
  await writeBytesTo(filePath, bytes);
  return { name: basename(filePath), path: filePath };
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
  return KIND_FILTERS[kind];
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
  if (kind === null) {
    throw new Error('この拡張子のファイルは、頼まれた種類として読めません。');
  }
  return { name: basename(filePath), kind, bytes: await readBytesFrom(filePath) };
}

/**
 * 種類を選んで「書き出す」。**呼ぶたびに必ず窓を出す**(上書き先を覚えない。§0.a-0.4)。
 * 書けたら true、取り消されたら false。**返り値にパスも名前も含めない**(NFR-SE-1)。
 */
export async function saveAsDialog(
  window: BrowserWindow | null,
  fileName: string,
  kind: string,
  bytes: Uint8Array,
): Promise<boolean> {
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
    return false;
  }
  await writeBytesTo(withKindExtension(result.filePath, kind), bytes);
  return true;
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
  });
}

/** 上書き先を確定し、同じ画面の未確定候補を消す。 */
function rememberPath(event: IpcMainInvokeEvent, filePath: string): void {
  watchWindow(event);
  lastPaths.set(event.sender.id, filePath);
  pendingPaths.delete(event.sender.id);
}

/** 開いた実パスを未確定の token に結び付ける。前の候補は呼び出し側で先に捨てる。 */
function rememberPendingPath(event: IpcMainInvokeEvent, filePath: string): string {
  watchWindow(event);
  const token = `save-target-${String(nextSaveTargetToken)}`;
  nextSaveTargetToken += 1;
  pendingPaths.set(event.sender.id, { token, path: filePath });
  return token;
}

/** 現在の文書の保存先と、未確定の候補を一緒に解除する。 */
function clearSaveTargets(event: IpcMainInvokeEvent): void {
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
 * IPC を登録する。部品は `pcad:open` / `pcad:confirmTarget` / `pcad:clearTarget` /
 * `pcad:save` / `pcad:hasTarget` の5本、種類つきは `pcad:openAny` / `pcad:saveAs` の2本
 * (§0.a-0.5)。
 *
 * 往復する値は文字列・真偽・`Uint8Array`・文字列の並びに限る(構造化複製でそのまま往復できるもの)。
 * 画面から来た値は素性が分からないので、使う前に必ず形を確かめる。
 *
 * `app.whenReady()` の中から1回だけ呼ぶ(2回呼ぶと Electron が二重登録で失敗する)。
 */
export function registerPcadIpc(): void {
  ipcMain.handle(
    PCAD_OPEN_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      kind: unknown = 'part',
    ): Promise<{ name: string; bytes: Uint8Array; saveTargetToken: string } | null> => {
      if (!validateAppSender(event)) {
        return null;
      }
      if (kind !== 'part' && kind !== 'assembly' && kind !== 'drawing' && kind !== 'all') return null;
      // 未確定の候補は次の「開く」を始めた時点で失効する。確定済みの先はまだ保つ。
      pendingPaths.delete(event.sender.id);
      const opened = await openPcadDialog(windowOf(event), kind);
      if (opened === null) {
        return null;
      }
      const saveTargetToken = rememberPendingPath(event, opened.path);
      return { name: opened.name, bytes: opened.bytes, saveTargetToken };
    },
  );

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

  ipcMain.handle(
    PCAD_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<string | null> => {
      if (!validateAppSender(event)) {
        return null;
      }
      const [suggestedName, bytes, saveAs, kind = 'part'] = args;
      if (
        typeof suggestedName !== 'string' ||
        !(bytes instanceof Uint8Array) ||
        typeof saveAs !== 'boolean' || (kind !== 'part' && kind !== 'assembly' && kind !== 'drawing')
      ) {
        throw new Error('保存の依頼の形が正しくありません。');
      }
      watchWindow(event);
      const revision = {};
      targetRevisions.set(event.sender.id, revision);
      const saved = await savePcadDialog(
        windowOf(event),
        suggestedName,
        bytes,
        saveAs,
        lastPaths.get(event.sender.id) ?? null,
        kind,
      );
      if (saved === null || targetRevisions.get(event.sender.id) !== revision) {
        return null;
      }
      rememberPath(event, saved.path);
      return saved.name;
    },
  );

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
      const [fileName, kind, bytes] = args;
      if (
        typeof fileName !== 'string' ||
        typeof kind !== 'string' ||
        filterOf(kind) === undefined ||
        !(bytes instanceof Uint8Array)
      ) {
        throw new Error('保存の依頼の形が正しくありません。');
      }
      // `rememberPath` を呼ばない。書き出した先は覚えないので、次の Ctrl+S は部品へ向かう。
      return saveAsDialog(windowOf(event), fileName, kind, bytes);
    },
  );
}
