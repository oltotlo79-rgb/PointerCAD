import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserFileGateway } from './fileGateway.js';
import { importFile } from './exchangeActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

describe('形式の選択から読込の入口まで', () => {
  beforeEach(resetTestStore);
  it('DWGの直接要求はファイル選択・形状・履歴を変更せず変換理由を示す', async () => {
    const showOpenFilePicker = vi.fn(() => Promise.resolve([]));
    useAppStore.getState().setFileGateway(createBrowserFileGateway({ showOpenFilePicker }));
    const before = useAppStore.getState();
    await importFile('dwg');
    const after = useAppStore.getState();
    expect(showOpenFilePicker).not.toHaveBeenCalled();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.errorMessage).toContain('DXFへ変換');
  });
  it('選んだ形式だけをファイル選択へ渡し、取消は文書を変えない', async () => {
    const showOpenFilePicker = vi.fn(() => Promise.resolve([]));
    useAppStore.getState().setFileGateway(createBrowserFileGateway({ showOpenFilePicker }));
    const before = useAppStore.getState();
    await importFile('dxf');
    expect(showOpenFilePicker).toHaveBeenCalledWith({ multiple: false, types: [{ description: 'DXF', accept: { 'image/vnd.dxf': ['.dxf'] } }] });
    expect(useAppStore.getState().document).toBe(before.document);
  });
});
