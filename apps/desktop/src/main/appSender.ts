import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';

import { APP_HOST, APP_SCHEME } from './appProtocol.js';

/** main が作った、特権 IPC を使ってよい主窓の画面だけを覚える。 */
const appWebContents = new WeakSet<WebContents>();

/** 主窓を特権 IPC の送信元として登録する。印刷用の隠し窓は登録しない。 */
export function registerAppWindow(window: BrowserWindow): void {
  appWebContents.add(window.webContents);
}

/** app 配信元、または明示された開発サーバーと同じ origin かを確かめる。 */
export function isAllowedAppUrl(candidateUrl: string, devServerUrl?: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    if (candidate.protocol === `${APP_SCHEME}:` && candidate.host === APP_HOST) {
      return true;
    }
    if (devServerUrl === undefined) {
      return false;
    }
    return candidate.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

/** 登録済み主窓の main frame が、許可した配信元から呼んだ IPC だけを受ける。 */
export function validateAppSender(event: IpcMainInvokeEvent): boolean {
  const senderFrame = event.senderFrame;
  return (
    appWebContents.has(event.sender) &&
    senderFrame !== null &&
    senderFrame === event.sender.mainFrame &&
    isAllowedAppUrl(senderFrame.url, process.env['PCAD_DEV_SERVER_URL'])
  );
}
