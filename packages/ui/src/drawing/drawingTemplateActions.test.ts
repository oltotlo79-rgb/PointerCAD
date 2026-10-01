import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { parseDrawing, readDrawingTemplateFile, serializeDrawing } from '@pointercad/io';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingSheet, createDrawingFromTemplateFile, parseDrawingSheetDraft, saveCurrentDrawingTemplate, type DrawingSheetDraft } from './drawingTemplateActions.js';

const expressionDraft: DrawingSheetDraft = { scale: '1/2', scaleOptions: '1/2, 1, root(8, 3)', textHeight: '7/2',
  fields: [{ key: 'title', label: '図名', widthWeight: 1, widthExpression: '1+1' }] };

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
  it('数式を評価して1回のUndo・Redo・図面保存・ひな形保存で原式を保つ', async () => {
    const { document, save } = setup();
    const parsed = parseDrawingSheetDraft(document.sheet, expressionDraft);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(commitDrawingSheet(parsed.sheet)).toBe(true);
    const applied = useAppStore.getState().drawing;
    if (applied === null) throw new Error('missing drawing');
    expect(applied.sheet).toMatchObject({ scale: 0.5, scaleExpression: '1/2', textHeight: 3.5, textHeightExpression: '7/2',
      scaleOptions: [0.5, 1, 2], scaleOptionExpressions: ['1/2', '1', 'root(8, 3)'],
      titleBlockFields: [{ widthWeight: 2, widthExpression: '1+1' }] });
    expect(parseDrawing(serializeDrawing(applied))).toMatchObject({ ok: true, document: { sheet: applied.sheet } });
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(false);
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawing?.sheet).toEqual(applied.sheet);
    expect(await saveCurrentDrawingTemplate('式のひな形')).toBe(true);
    expect(readDrawingTemplateFile(save.mock.calls[0][2])).toMatchObject({ ok: true, template: { sheet: applied.sheet } });
  });
  it('評価済みの原式を再編集し、取消で直前の原式へ戻る', () => {
    const { document } = setup();
    for (const scale of ['1/2', '1/4']) {
      const parsed = parseDrawingSheetDraft(useAppStore.getState().drawing?.sheet ?? document.sheet, { ...expressionDraft, scale });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      expect(commitDrawingSheet(parsed.sheet)).toBe(true);
    }
    expect(useAppStore.getState().drawing?.sheet).toMatchObject({ scale: 0.25, scaleExpression: '1/4' });
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing?.sheet).toMatchObject({ scale: 0.5, scaleExpression: '1/2' });
  });
  it.each(['0', '-1', '1/0', '不明', '1+', ''])('無効な数式%sを各欄に示し文書と履歴を変えない', (value) => {
    const { document } = setup();
    const drafts = [
      { ...expressionDraft, scale: value }, { ...expressionDraft, textHeight: value },
      { ...expressionDraft, scaleOptions: `1, ${value}` },
      { ...expressionDraft, fields: [{ ...expressionDraft.fields[0], widthExpression: value }] },
    ];
    for (const [index, draft] of drafts.entries()) {
      const parsed = parseDrawingSheetDraft(document.sheet, draft);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('accepted invalid draft');
      expect([parsed.errors.scale, parsed.errors.textHeight, parsed.errors.scaleOptions, parsed.errors.fields[0].width][index]).toBeTruthy();
    }
    expect(useAppStore.getState().drawing).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('重複する候補、単位付きの比率、空の項目名を個別に知らせる', () => {
    const { document } = setup();
    expect(parseDrawingSheetDraft(document.sheet, { ...expressionDraft, scale: '1in', scaleOptions: '1/2, 0.5',
      fields: [{ key: 'title', label: '', widthExpression: '1mm' }] })).toMatchObject({ ok: false, errors: {
        scale: '比率にはmmやinなどの長さの単位を付けないでください。',
        scaleOptions: '同じ値になる縮尺の候補が重複しています。',
        fields: [{ label: '項目名を入力してください。', width: '比率にはmmやinなどの長さの単位を付けないでください。' }],
      } });
  });
  it('表題欄の並べ替え・削除後もキーに結びついた幅の原式を評価する', () => {
    const { document } = setup();
    const fields = [{ key: 'b', label: 'B', widthExpression: '3+1' }, { key: 'a', label: 'A', widthExpression: '1+1' }];
    const parsed = parseDrawingSheetDraft(document.sheet, { ...expressionDraft, fields });
    expect(parsed).toMatchObject({ ok: true, sheet: { titleBlockFields: [
      { key: 'b', widthWeight: 4, widthExpression: '3+1' }, { key: 'a', widthWeight: 2, widthExpression: '1+1' },
    ] } });
    expect(parseDrawingSheetDraft(document.sheet, { ...expressionDraft, fields: fields.slice(1) }))
      .toMatchObject({ ok: true, sheet: { titleBlockFields: [{ key: 'a', widthWeight: 2, widthExpression: '1+1' }] } });
  });
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
