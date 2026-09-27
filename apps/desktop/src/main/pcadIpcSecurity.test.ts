import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPcadIpc } from './pcadDialogs.js';

const native = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  allowed: false,
  clearExportHandoff: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: native.showOpenDialog, showSaveDialog: native.showSaveDialog },
  ipcMain: { handle: native.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => native.allowed }));
vi.mock('./exportHandoffIpc.js', () => ({
  registerExportHandoffIpc: vi.fn(),
  clearExportHandoff: native.clearExportHandoff,
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (handler === undefined) throw new Error(`IPC未登録: ${channel}`);
  const result: unknown = Reflect.apply(handler, undefined, [{ sender: { id: 42 } }, ...args]);
  return Promise.resolve(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  native.allowed = false;
  registerPcadIpc();
});

describe('ファイルIPCは不許可の送信元で副作用より先に止まる', () => {
  it.each([
    ['pcad:open', null],
    ['pcad:confirmTarget', false],
    ['pcad:clearTarget', undefined],
    ['pcad:save', null],
    ['pcad:hasTarget', false],
    ['pcad:openAny', null],
    ['pcad:saveAs', false],
  ])('%sを拒否し、選択窓と保存先を変更しない', async (channel, expected) => {
    expect(await invoke(channel, '/outside/arbitrary.pcad', Uint8Array.of(1))).toBe(expected);
    expect(native.showOpenDialog).not.toHaveBeenCalled();
    expect(native.showSaveDialog).not.toHaveBeenCalled();
    expect(native.clearExportHandoff).not.toHaveBeenCalled();
  });
});
