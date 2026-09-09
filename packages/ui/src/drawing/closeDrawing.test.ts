import { createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { closeDrawingWithConfirmation } from './closeDrawing.js';

const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z' } as const;
beforeEach(() => { useAppStore.setState(createInitialDocumentState()); });

describe('図面から部品へ戻る時の未保存保護（レビュー R03）', () => {
  it('破棄を断れば図面も Undo 履歴も残り、編集を戻せる', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '編集した図面' });
    const before = useAppStore.getState();
    const confirmDiscard = vi.fn(() => Promise.resolve(false));
    expect(await closeDrawingWithConfirmation({ confirmDiscard })).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith('file.discardConfirm');
    expect(useAppStore.getState().drawing).toBe(before.drawing);
    expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing).toBe(original);
  });

  it('破棄へ同意した時だけ部品へ戻る', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '変更' });
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(true) })).toBe(true);
    expect(useAppStore.getState().drawing).toBeNull();
  });

  it('保存済みの未変更図面では確認を増やさない', async () => {
    useAppStore.getState().openDrawing(createDrawingDocument('図面', source), { saved: true });
    const confirmDiscard = vi.fn(() => Promise.resolve(false));
    expect(await closeDrawingWithConfirmation({ confirmDiscard })).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('確認待機中の追加編集を古い破棄の回答で消さない', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '最初の編集' });
    let answer: (value: boolean) => void = () => { throw new Error('未初期化'); };
    const response = new Promise<boolean>((resolve) => { answer = resolve; });
    const pending = closeDrawingWithConfirmation({ confirmDiscard: () => response });
    const latest = { ...original, name: '確認待機中の編集' };
    useAppStore.getState().applyDrawing(latest);
    answer(true); expect(await pending).toBe(false);
    expect(useAppStore.getState().drawing).toBe(latest);
  });
});
