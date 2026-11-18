import { BrowserWindow, dialog } from 'electron';
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions, Session } from 'electron';

import { allowSixDofDevices, type SixDofDeviceChooser } from './sixDofDevices.js';
import { createSixDofGate } from './sixDofGate.js';
import { registerSixDofIpc, type SixDofConfirm } from './sixDofIpc.js';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)の読み取りの例外を、既定の session と IPC へ 1 回だけ組み込む。
 * main.ts の `denyBrowserPermissions` の後に呼ぶ。窓の文は製品名・製造元の名前を出さない。
 */
const CONFIRM: MessageBoxOptions = {
  type: 'question', buttons: ['許可する', 'やめる'], defaultId: 1, cancelId: 1, noLink: true,
  message: '3D マウス(多軸の入力機器)を読めるようにしますか。',
  detail: '多軸の入力機器だけを読み、ほかの機器は読みません。この機能は実機では確かめていません。'
    + '設定の「操作の割り当て」の「3D マウス」で、いつでも切にできます。',
};

/** 許す機器が 2 つ以上つながっている時だけ、どれを使うかを番号で選ばせる(機器の名前は出さない)。 */
const MAX_CHOICES = 8;

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

const confirmSixDof: SixDofConfirm = async (event) => {
  const owner = windowOf(event);
  const answer = owner === null ? await dialog.showMessageBox(CONFIRM) : await dialog.showMessageBox(owner, CONFIRM);
  return answer.response === 0;
};

const chooseDevice: SixDofDeviceChooser = async (count) => {
  const shown = Math.min(count, MAX_CHOICES);
  const buttons = [...Array.from({ length: shown }, (_, index) => `3D マウス ${String(index + 1)}`), 'やめる'];
  const answer = await dialog.showMessageBox({ type: 'question', buttons, defaultId: shown, cancelId: shown, noLink: true,
    message: '使う 3D マウス(多軸の入力機器)を選んでください。' });
  return answer.response < shown ? answer.response : null;
};

export function installSixDofAccess(session: Session, ipcMain: Pick<IpcMain, 'handle'>, userDataDirectory: string): void {
  const gate = createSixDofGate(userDataDirectory);
  allowSixDofDevices(session, gate, chooseDevice);
  registerSixDofIpc(ipcMain, gate, confirmSixDof);
}
