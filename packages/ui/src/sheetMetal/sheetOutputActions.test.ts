import { absoluteCoordinate, appendSolid, createEmptyPartDocument, replaceSketch, createSheetBaseFeature, resolvePart, unfoldSheetBody } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { exportSheet } from './sheetOutputActions.js';
import type { SheetOutputFile, SheetOutputFormat, SheetOutputRequest } from './sheetOutputComputer.js';

function setup() {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const profile = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '外周', planeId: 'xy', construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
    { kind: 'face', id: 'face', name: '輪郭面', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
  ] });
  const base = createSheetBaseFeature(profile, { sketchId: sketch.id, faceFeatureId: 'face' });
  const document = appendSolid(profile, base), resolved = resolvePart(document);
  const sheet = resolved.sheetMetalBodies?.get(base.id); if (sheet === undefined) throw new Error('基板が必要です');
  useAppStore.getState().applyDocument(document, { undoable: false });
  useAppStore.getState().applyRecompute(document, { ...resultFor(document), bodies: [bodyFor(base.id)], sheetMetalBodies: resolved.sheetMetalBodies });
  useAppStore.getState().openSheetMetalTool('sheetUnfold');
  const session = useAppStore.getState().sheetMetalTool; if (session === null) throw new Error('展開を開始できません');
  const definition = { sourceFeatureId: base.id, fixedPanelId: sheet.panels[0].id, seamConnectionIds: [] };
  const flat = unfoldSheetBody(sheet, definition.fixedPanelId, []); if (!flat.ok) throw new Error(flat.message);
  const preview = { session, candidate: document, bodies: [bodyFor(base.id)], featureId: base.id, volume: 1500,
    flat: { definition, geometry: flat.value } };
  useAppStore.setState({ sheetMetalPreview: preview });
  const save = vi.fn(() => Promise.resolve(true));
  useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
  return { document, preview, save };
}
const file: SheetOutputFile = { fileName: '展開.dxf', kind: 'dxf', bytes: new TextEncoder().encode('DXF') };
beforeEach(() => { resetTestStore(); useAppStore.getState().setSheetOutputComputer(null); });
afterEach(() => { useAppStore.getState().closeSheetMetalTool(); useAppStore.getState().setSheetOutputComputer(null); });

describe('板金の出力と文書世代', () => {
  it.each(['flatDxf', 'flatStep', 'foldedStep'] as const)('%sの指定と文書を計算へ渡し、成功ファイルだけを保存する', async (format: SheetOutputFormat) => {
    const item = setup(), computer = vi.fn(() => Promise.resolve(file));
    useAppStore.getState().setSheetOutputComputer(computer);
    await exportSheet(item.preview, format);
    expect(computer).toHaveBeenCalledWith(expect.objectContaining({ document: item.document, definition: item.preview.flat.definition, format }), expect.any(Function));
    expect(item.save).toHaveBeenCalledWith(file.fileName, 'dxf', file.bytes);
    expect(useAppStore.getState().document).toBe(item.document);
    expect(useAppStore.getState().fileMessage).toMatchObject({ key: 'sheetMetal.exported', failed: false });
    expect(useAppStore.getState().sheetMetalRequestId).toBeNull();
  });
  it('計算中の重複出力を防ぎ、別文書に切替後の結果を保存しない', async () => {
    const item = setup();
    let settle: (value: SheetOutputFile) => void = () => { throw new Error('開始前'); };
    let cancelled = () => false;
    const computer = vi.fn((_request: SheetOutputRequest, check: () => boolean) => new Promise<SheetOutputFile>((resolve) => { settle = resolve; cancelled = check; }));
    useAppStore.getState().setSheetOutputComputer(computer);
    const pending = exportSheet(item.preview, 'flatDxf');
    await exportSheet(item.preview, 'flatStep'); expect(computer).toHaveBeenCalledTimes(1);
    useAppStore.getState().applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    expect(cancelled()).toBe(true); settle(file); await pending;
    expect(item.save).not.toHaveBeenCalled();
  });
  it('失敗を表示し、ファイル選択を取り消した時は成功を表示しない', async () => {
    const item = setup();
    useAppStore.getState().setSheetOutputComputer(() => Promise.reject(new Error('輪郭が閉じていません')));
    await exportSheet(item.preview, 'flatDxf');
    expect(item.save).not.toHaveBeenCalled(); expect(useAppStore.getState().sheetMetalError).toBe('輪郭が閉じていません');
    useAppStore.getState().setSheetOutputComputer(() => Promise.resolve(file)); item.save.mockResolvedValue(false);
    await exportSheet(item.preview, 'flatDxf'); expect(useAppStore.getState().fileMessage?.key).not.toBe('sheetMetal.exported');
  });
  it('保存ダイアログ中に文書を変更しても、新文書へ保存成功の通知を残さない', async () => {
    const item = setup(); useAppStore.getState().setSheetOutputComputer(() => Promise.resolve(file));
    item.save.mockImplementation(() => {
      useAppStore.getState().applyDocument(createEmptyPartDocument(), { replacesDocument: true }); return Promise.resolve(true);
    });
    await exportSheet(item.preview, 'flatStep');
    expect(item.save).toHaveBeenCalledOnce(); expect(useAppStore.getState().fileMessage?.key).not.toBe('sheetMetal.exported');
  });
});
