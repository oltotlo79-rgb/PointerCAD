import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { readDrawingPrintOptions, type DrawingPrintOptions } from '@pointercad/ui/print-settings';
import { drawingPrintDocument } from './drawingPrintDocument.js';

import { APP_ENTRY_URL, handleAppScheme, registerAppScheme } from './appProtocol.js';
import { isAllowedAppUrl, registerAppWindow, validateAppSender } from './appSender.js';
import { PCAD_PRINT_CHANNEL, registerPcadIpc } from './pcadDialogs.js';

/**
 * このファイルの出力先 dist/main。
 * 計画書は `dirname(fileURLToPath(import.meta.url))` としていたが、Vite 8(Rolldown)は
 * CommonJS 出力で `import.meta` を空オブジェクトへ置き換えるため実行時に壊れる
 * (実測: `fileURLToPath({}.url)`)。出力形式は cjs で固定しているので `__dirname` を使う。
 */
const currentDirectory = __dirname;
/** dist/main から見た画面の出力先。 */
const rendererRoot = join(currentDirectory, '..', 'renderer');
const preloadPath = join(currentDirectory, '..', 'preload', 'preload.cjs');

/** 開発時は Vite の開発サーバーを読む。統括が起動して環境変数で渡す。 */
const devServerUrl = process.env['PCAD_DEV_SERVER_URL'];

registerAppScheme();

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // これより狭いとツールバーの機能グループが折り返して読みにくくなる。
    minWidth: 960,
    minHeight: 600,
    // 画面の用意ができるまで出さない。白い一瞬の画面を見せないため。
    show: false,
    autoHideMenuBar: true,
    // 画面本体の地の色(appShell.css の --pcad-bg)と合わせる。
    backgroundColor: '#16181d',
    title: 'PointerCAD',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerAppWindow(window);

  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppUrl(targetUrl, devServerUrl)) {
      event.preventDefault();
    }
  });
  // P11b タスク 1 の固定 HTTPS 許可表による外部リンク処理は、この拒否口へ追加する。
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.once('ready-to-show', () => {
    window.show();
  });

  void window.loadURL(devServerUrl ?? APP_ENTRY_URL);
}

/**
 * 印刷(FR-810。P6 計画書 §2.11、タスク29)。
 *
 * 画面から PNG のバイト列を受け取り、**隠しの窓**へ data URL として読み込ませてから
 * `webContents.print()` を呼ぶ。画面の窓をそのまま印刷しないのは、ツールバーや区画まで
 * 紙に出てしまうため。紙に出すのは、画面側が背景を白にして描いた 1 コマだけ(FR-908)。
 *
 * 部品の画像はOSの印刷設定を使う。図面は検証済みの用紙・向き・部数を初期値にする。
 * どちらも `silent: false` で、利用者が印刷画面で確認できる。
 * 取り消しは `success` が false で返る。**例外にしない**(NFR-RE-1)。
 *
 * **隠しの窓は `finally` で必ず閉じる。** 閉じ忘れると見えない窓が残り、
 * 画面の窓を全部閉じてもアプリが終わらなくなる。
 */
async function printInHiddenWindow(png: Uint8Array, options?: DrawingPrintOptions): Promise<boolean> {
  const printWindow = new BrowserWindow({
    title: 'PointerCAD',
    show: false,
    webPreferences: {
      // 絵を 1 枚出すだけなので、画面の口(preload)は渡さない。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  printWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppUrl(targetUrl, devServerUrl)) {
      event.preventDefault();
    }
  });
  // P11b タスク 1 の固定 HTTPS 許可表による外部リンク処理は、この拒否口へ追加する。
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const dataUrl = options === undefined ? `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      : `data:text/html;base64,${Buffer.from(drawingPrintDocument(png, options)).toString('base64')}`;
    await printWindow.loadURL(dataUrl);
    await printWindow.webContents.executeJavaScript('Promise.all(Array.from(document.images, image => image.decode()))');
    return await new Promise<boolean>((resolve) => {
      printWindow.webContents.print({ silent: false, printBackground: true, ...(options === undefined ? {}
        : { pageSize: options.pageSize, landscape: options.landscape, copies: options.copies, margins: { marginType: 'none' }, scaleFactor: 100 }) }, (success) => {
        resolve(success);
      });
    });
  } finally {
    printWindow.destroy();
  }
}

/**
 * 印刷の受け口を登録する。`app.whenReady()` の中から1回だけ呼ぶ
 * (`registerPcadIpc` と同じ理由。2回呼ぶと Electron が二重登録で失敗する)。
 */
function registerPrintIpc(): void {
  ipcMain.handle(
    PCAD_PRINT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
      if (!validateAppSender(event)) {
        return false;
      }
      const [png, rawOptions] = args;
      if (!(png instanceof Uint8Array)) {
        throw new Error('印刷の依頼の形が正しくありません。');
      }
      const options = rawOptions === undefined ? undefined : readDrawingPrintOptions(rawOptions);
      if (options === null) throw new Error('図面の印刷設定が正しくありません。');
      return printInHiddenWindow(png, options);
    },
  );
}

void app.whenReady().then(() => {
  // 既定のメニューバー(File / Edit / View / Window)は使わないので消す。
  Menu.setApplicationMenu(null);
  handleAppScheme(rendererRoot);
  // 「開く」「保存」の受け口。窓を作る前に用意しておく(FR-806、計画書 タスク26)。
  registerPcadIpc();
  // 「印刷」の受け口(FR-810、P6 計画書 タスク29)。
  registerPrintIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
