import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { promises as fileSystem } from 'node:fs';
import { basename, extname } from 'node:path';

/**
 * デスクトップ版の「開く」「保存」「名前を付けて保存」(計画書 docs/plans/P2-ソリッド基礎.md タスク26)。
 *
 * 対応要件: FR-806(保存・読込)、要件§1.5(Web 版とデスクトップ版に機能差を作らない)、NFR-SE-1。
 *
 * 画面(レンダラ)は `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false` のまま
 * 動かすので、ファイルの実体に触れるのはこの本体プロセスだけにする。画面から来るのは
 * 「名前」「バイト列」「名前を付けて保存かどうか」の3つだけで、**パスは画面へ渡さない**
 * (NFR-SE-1「外へ出す情報は最小にする」)。上書き先はここで覚える。
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

/** 部品ファイルの拡張子(要件§8)。 */
const PCAD_EXTENSION = 'pcad';

/**
 * ファイル選択の窓に出す種別。
 *
 * 文言は `packages/ui/src/i18n/ja.json` の `file.typeDescription` と同じにしてある
 * (Web 版のファイル選択と同じ表示にするため)。本体プロセスから ja.json を引くには
 * `@pointercad/ui` を本体側の束へ持ち込むことになり、画面用の実装まで抱き込むので写している。
 * 窓の題名は指定しない。指定しなければ OS が「開く」「名前を付けて保存」を各国語で出す。
 */
const PCAD_FILE_FILTER = { name: 'PointerCAD の部品ファイル', extensions: [PCAD_EXTENSION] };

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
 *
 * 文面にパスを入れない。この文面は画面側まで届くため(NFR-SE-1)。画面が利用者へ出す文言は
 * `ja.json` の `file.openFailed` で、ここの文面は記録用。
 */
async function readPcadBytes(filePath: string): Promise<Uint8Array> {
  try {
    const contents = await fileSystem.readFile(filePath);
    // Buffer は Node の内部で使い回す記憶を指すことがあるので、自前の記憶へ写してから渡す。
    const bytes = new Uint8Array(contents.byteLength);
    bytes.set(contents);
    return bytes;
  } catch (cause) {
    throw new Error('ファイルを読めませんでした。', { cause });
  }
}

/** ファイルを書く。失敗は日本語の `Error`(文面にパスを入れない理由は `readPcadBytes` と同じ)。 */
async function writePcadBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  try {
    await fileSystem.writeFile(filePath, bytes);
  } catch (cause) {
    throw new Error('ファイルを保存できませんでした。', { cause });
  }
}

/**
 * 「開く」。取り消されたら null。
 *
 * 親の窓が分からないときは窓を付けずに出す(その場合 OS によっては前面に来ないことがあるが、
 * 開けなくなるよりはよい)。
 */
export async function openPcadDialog(window: BrowserWindow | null): Promise<OpenedPcadFile | null> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [PCAD_FILE_FILTER],
  };
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  const filePath = result.filePaths[0];
  if (result.canceled || filePath === undefined) {
    return null;
  }
  return { name: basename(filePath), path: filePath, bytes: await readPcadBytes(filePath) };
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
): Promise<SavedPcadFile | null> {
  let filePath = saveAs ? null : lastPath;
  if (filePath === null) {
    const options: SaveDialogOptions = {
      // 「名前を付けて保存」でも、前に保存した場所と名前から始める。まだ無ければ画面が
      // 勧めてきた名前(既定の保存先フォルダに置かれる)。
      defaultPath: lastPath ?? suggestedName,
      filters: [PCAD_FILE_FILTER],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    if (result.canceled || result.filePath === '') {
      return null;
    }
    filePath = withPcadExtension(result.filePath);
  }
  await writePcadBytes(filePath, bytes);
  return { name: basename(filePath), path: filePath };
}

/**
 * 覚えている上書き先。**画面ごとに1つ**持つ(鍵は画面の識別子)。
 *
 * 窓が2つあるときに1つの控えを共有すると、片方の Ctrl+S がもう片方のファイルを
 * 上書きしてしまうため分ける。画面が閉じたら控えも捨てる。
 */
const lastPaths = new Map<number, string>();

/** 上書き先を覚える。初めて覚える画面には、閉じたときに忘れる後始末を付ける。 */
function rememberPath(event: IpcMainInvokeEvent, filePath: string): void {
  const contents = event.sender;
  const id = contents.id;
  if (!lastPaths.has(id)) {
    contents.once('destroyed', () => {
      lastPaths.delete(id);
    });
  }
  lastPaths.set(id, filePath);
}

/** 依頼を出してきた画面の窓。取れなければ null(窓なしでダイアログを出す)。 */
function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/**
 * IPC を登録する。チャンネルは `pcad:open` / `pcad:save` / `pcad:hasTarget` の3本だけ。
 *
 * 往復する値は文字列・真偽・`Uint8Array` に限る(構造化複製でそのまま往復できるもの)。
 * 画面から来た値は素性が分からないので、使う前に必ず形を確かめる。
 *
 * `app.whenReady()` の中から1回だけ呼ぶ(2回呼ぶと Electron が二重登録で失敗する)。
 */
export function registerPcadIpc(): void {
  ipcMain.handle(
    PCAD_OPEN_CHANNEL,
    async (event: IpcMainInvokeEvent): Promise<{ name: string; bytes: Uint8Array } | null> => {
      const opened = await openPcadDialog(windowOf(event));
      if (opened === null) {
        return null;
      }
      // 開いたファイルはそのまま上書き先にする(次の Ctrl+S は窓を出さずに同じ先へ書く)。
      rememberPath(event, opened.path);
      return { name: opened.name, bytes: opened.bytes };
    },
  );

  ipcMain.handle(
    PCAD_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<string | null> => {
      const [suggestedName, bytes, saveAs] = args;
      if (
        typeof suggestedName !== 'string' ||
        !(bytes instanceof Uint8Array) ||
        typeof saveAs !== 'boolean'
      ) {
        throw new Error('保存の依頼の形が正しくありません。');
      }
      const saved = await savePcadDialog(
        windowOf(event),
        suggestedName,
        bytes,
        saveAs,
        lastPaths.get(event.sender.id) ?? null,
      );
      if (saved === null) {
        return null;
      }
      rememberPath(event, saved.path);
      return saved.name;
    },
  );

  ipcMain.handle(PCAD_HAS_TARGET_CHANNEL, (event: IpcMainInvokeEvent): boolean =>
    lastPaths.has(event.sender.id),
  );
}
