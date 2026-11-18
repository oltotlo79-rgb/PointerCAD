import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { validateAppSender } from './appSender.js';
import type { SixDofGate } from './sixDofGate.js';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)の印の IPC。画面が呼べるのは 3 つだけ:
 * - enable: 主プロセスが OS の確かめの窓を出し、利用者が「許可する」を選んだ時だけ入にする。画面から入を直接書く口は無い。
 * - disable: いつでも切にする(安全な向きなので確かめない)。
 * - state: 今の印を返す。
 * どれも、登録済みの主窓の main frame が app 配信元から呼んだ時だけ働き(validateAppSender)、引数を 1 つも受けない。
 * チャンネル名は preload.ts に同じ文字列を書いている(preload は本体のファイルを読み込めないため)。
 */
const SIX_DOF_ENABLE_CHANNEL = 'pcad:sixDof:enable';
const SIX_DOF_DISABLE_CHANNEL = 'pcad:sixDof:disable';
const SIX_DOF_STATE_CHANNEL = 'pcad:sixDof:state';

/** 呼んだ窓の上に OS の確かめの窓を出し、利用者が許可したら true。 */
export type SixDofConfirm = (event: IpcMainInvokeEvent) => Promise<boolean>;

export function registerSixDofIpc(ipcMain: Pick<IpcMain, 'handle'>, gate: SixDofGate, confirm: SixDofConfirm,
  validate: (event: IpcMainInvokeEvent) => boolean = validateAppSender): void {
  ipcMain.handle(SIX_DOF_ENABLE_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    if (!validate(event) || args.length !== 0) return false;
    if (gate.enabled()) return true;
    if (!await confirm(event)) return false;
    // 確かめの窓を出している間に、窓が別の所へ移った・閉じた時は入にしない。
    if (!validate(event)) return false;
    return gate.set(true);
  });
  ipcMain.handle(SIX_DOF_DISABLE_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): boolean => {
    if (!validate(event) || args.length !== 0) return false;
    return gate.set(false);
  });
  ipcMain.handle(SIX_DOF_STATE_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): boolean =>
    validate(event) && args.length === 0 && gate.enabled());
}
