import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

import { APP_ENTRY_URL, handleAppScheme, registerAppScheme } from './appProtocol.js';

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
    backgroundColor: '#1e1e1e',
    title: 'PointerCAD',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadURL(devServerUrl ?? APP_ENTRY_URL);
}

void app.whenReady().then(() => {
  handleAppScheme(rendererRoot);
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
