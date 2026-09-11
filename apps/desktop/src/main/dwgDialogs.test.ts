import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAnyDialog, openPcadDialog, saveAsDialog } from './pcadDialogs.js';

const calls = vi.hoisted(() => ({
  open: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['C:/input/図面.DWG'] })),
  save: vi.fn(), stat: vi.fn(), read: vi.fn(), write: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: { showOpenDialog: calls.open, showSaveDialog: calls.save }, ipcMain: {} }));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  promises: { stat: calls.stat, readFile: calls.read, writeFile: calls.write } }));
beforeEach(() => { vi.clearAllMocks(); });

describe('DesktopのDWG案内はファイルを読み書きしない', () => {
  it('種類がDWGならネイティブ選択窓を開く前に断る', async () => {
    await expect(openAnyDialog(null, ['dwg'])).rejects.toThrow('DXFへ変換');
    expect(calls.open).not.toHaveBeenCalled(); expect(calls.stat).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
  });
  it('種類混在や部品を開く窓からDWGを選んでも本文を取得しない', async () => {
    await expect(openAnyDialog(null, ['dxf', 'dwg'])).rejects.toThrow('DXFへ変換');
    await expect(openAnyDialog(null, ['step'])).rejects.toThrow('DXFへ変換');
    await expect(openPcadDialog(null)).rejects.toThrow('DXFへ変換');
    expect(calls.open).toHaveBeenCalledTimes(3); expect(calls.stat).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
  });
  it('改変された画面からDWG保存を頼んでも保存窓も書込みも行わない', async () => {
    await expect(saveAsDialog(null, 'model.dwg', 'dwg', Uint8Array.of(1))).rejects.toThrow('直接読み書きできません');
    expect(calls.save).not.toHaveBeenCalled(); expect(calls.write).not.toHaveBeenCalled();
  });
});
