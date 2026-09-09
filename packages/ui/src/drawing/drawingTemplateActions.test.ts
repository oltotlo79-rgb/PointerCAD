import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { readDrawingTemplateFile } from '@pointercad/io';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingSheet, createDrawingFromTemplateFile, saveCurrentDrawingTemplate } from './drawingTemplateActions.js';

beforeEach(resetTestStore);
function setup() {
  const document = createDrawingDocument('図面', { sourceRef: 'source-1', sourceKind: 'part', path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' });
  useAppStore.getState().openDrawing(document);
  const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>().mockResolvedValue(true);
  const clearTarget = vi.fn();
  useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save, clearSaveTarget: clearTarget } });
  return { document, save, clearTarget };
}
describe('図面用紙の確定とひな形のファイル操作', () => {
  it('用紙・縮尺・表題欄を1操作で確定しUndoする', () => {
    const { document } = setup();
    expect(commitDrawingSheet({ ...document.sheet, paperSizeId: 'A4-landscape', scale: 0.5,
      titleBlock: { ...document.sheet.titleBlock, title: '変更した図名' } })).toBe(true);
    expect(useAppStore.getState().drawing?.sheet).toMatchObject({ paperSizeId: 'A4-landscape', scale: 0.5 });
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(document);
  });
  it('向きと用紙の矛盾・不正な文字高さを履歴へ入れない', () => {
    const { document } = setup();
    expect(commitDrawingSheet({ ...document.sheet, orientation: 'portrait' })).toBe(false);
    expect(commitDrawingSheet({ ...document.sheet, textHeight: -1 })).toBe(false);
    expect(useAppStore.getState().drawing).toBe(document);
  });
  it('同じ設定を確定してもUndoは増えない', () => {
    const { document } = setup(); expect(commitDrawingSheet(document.sheet)).toBe(true);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('投影計算中でも設定だけを保存し、図面の上書き先・保存済み状態は変えない', async () => {
    const { document, save, clearTarget } = setup();
    useAppStore.setState({ drawingBusy: true });
    expect(await saveCurrentDrawingTemplate('標準')).toBe(true);
    expect(save).toHaveBeenCalledWith('標準.pcadt', 'pcadt', expect.any(Uint8Array));
    const parsed = readDrawingTemplateFile(save.mock.calls[0][2]);
    expect(parsed).toMatchObject({ ok: true, template: { name: '標準', sheet: document.sheet } });
    expect(clearTarget).not.toHaveBeenCalled(); expect(useAppStore.getState().savedDrawing).toBeNull();
  });
  it('取消・書込失敗は保存成功にしない', async () => {
    const { save } = setup(); save.mockResolvedValueOnce(false);
    expect(await saveCurrentDrawingTemplate('標準')).toBe(false);
    save.mockRejectedValueOnce(new Error('disk'));
    expect(await saveCurrentDrawingTemplate('標準')).toBe(false);
    expect(useAppStore.getState().drawingMessage).toContain('保存できません');
  });
  it('名前なしではファイル選択を開かない', async () => {
    const { save } = setup(); expect(await saveCurrentDrawingTemplate('　')).toBe(false); expect(save).not.toHaveBeenCalled();
  });
  it('ファイル読込を取り消しても元文書を変えない', async () => {
    const document = useAppStore.getState().document;
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, openFile: () => Promise.resolve(null) } });
    expect(await createDrawingFromTemplateFile()).toBe(false);
    expect(useAppStore.getState().document).toBe(document); expect(useAppStore.getState().drawing).toBeNull();
  });
  it('保存待ちに文書を閉じたとき、次の文書へ成功メッセージを残さない', async () => {
    const { save } = setup(); let finish: (value: boolean) => void = () => {};
    save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const saving = saveCurrentDrawingTemplate('標準');
    useAppStore.getState().closeDrawing(); finish(true); await saving;
    expect(useAppStore.getState().drawingMessage).toBeNull();
  });
});
