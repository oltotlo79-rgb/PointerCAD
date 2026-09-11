import { absoluteCoordinate, appendSolid, createEmptyPartDocument, replaceSketch, createSheetBaseFeature, resolvePart,
  unfoldSheetBody, type SheetFlatResult } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { showSheetUnfold } from './sheetUnfoldActions.js';
import { displayedSheetBodies, isSheetFlatDisplayed } from './sheetCreationActions.js';

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
  const success: SheetFlatResult = { ok: true, body: { ...bodyFor(base.id), volume: 1500 }, bodyKey: 'flat-key', geometry: flat.value };
  const calls: { cancel: () => boolean; settle: (result: SheetFlatResult) => void }[] = [];
  useAppStore.getState().setSheetMetalFlatComputer((_body, _definition, _requestId, cancel) =>
    new Promise((settle) => { calls.push({ cancel, settle }); }));
  return { document, session, definition, success, calls };
}
beforeEach(() => { resetTestStore(); useAppStore.getState().setSheetMetalFlatComputer(null); });
afterEach(() => { useAppStore.getState().closeSheetMetalTool(); useAppStore.getState().setSheetMetalFlatComputer(null); });

describe('展開の表示と保存・取消を同じ文書世代へ限定する', () => {
  it('成功した固定面をUndo1回で保存し、折曲げ表示と同じ条件の再展開では履歴を増やさない', async () => {
    const item = setup(), pending = showSheetUnfold(item.session, item.definition);
    expect(useAppStore.getState().document).toBe(item.document); expect(item.calls).toHaveLength(1);
    await showSheetUnfold(item.session, item.definition); expect(item.calls).toHaveLength(1);
    item.calls[0].settle(item.success); await pending;
    const saved = useAppStore.getState();
    expect(saved.document.sheetUnfolds).toEqual([item.definition]); expect(saved.isComputing).toBe(false);
    expect(displayedSheetBodies(saved)[0].volume).toBe(1500); expect(saved.sheetMetalRequestId).toBeNull();
    expect(isSheetFlatDisplayed(saved)).toBe(true);
    saved.clearSheetMetalPreview(); expect(displayedSheetBodies(useAppStore.getState())).toBe(saved.bodies);
    expect(isSheetFlatDisplayed(useAppStore.getState())).toBe(false);
    expect(useAppStore.getState().document).toBe(saved.document);
    const session = saved.sheetMetalTool; if (session === null) throw new Error('表示中のセッションが必要です');
    const again = showSheetUnfold(session, item.definition); item.calls[1].settle(item.success); await again;
    expect(useAppStore.getState().document).toBe(saved.document);
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(item.document);
    expect(useAppStore.getState().sheetMetalPreview).toBeNull(); expect(useAppStore.getState().canUndo).toBe(false);
  });
  it.each(['failed', 'cancelled', 'exception'] as const)('%sで展開が成功しなければ固定面と履歴を保存しない', async (kind) => {
    const item = setup();
    if (kind === 'exception') useAppStore.getState().setSheetMetalFlatComputer(() => Promise.reject(new Error('計算部が停止しました')));
    const pending = showSheetUnfold(item.session, item.definition);
    if (kind !== 'exception') item.calls[0].settle({ ok: false, message: '展開パネルが重なります', cancelled: kind === 'cancelled' });
    await pending;
    expect(useAppStore.getState().document).toBe(item.document); expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().sheetMetalTool).toBe(item.session); expect(useAppStore.getState().sheetMetalRequestId).toBeNull();
    if (kind !== 'cancelled') expect(useAppStore.getState().sheetMetalError).not.toBeNull();
  });
  it.each(['close', 'folded', 'newDocument', 'otherTool', 'newSession'] as const)('%sの後の旧応答を表示・保存しない', async (kind) => {
    const item = setup(), pending = showSheetUnfold(item.session, item.definition), state = useAppStore.getState();
    if (kind === 'close') state.closeSheetMetalTool();
    if (kind === 'folded') state.clearSheetMetalPreview();
    if (kind === 'newDocument') state.applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    if (kind === 'otherTool') state.setActiveTool('line');
    if (kind === 'newSession') state.openSheetMetalTool('sheetUnfold');
    const current = useAppStore.getState().document;
    expect(item.calls[0].cancel()).toBe(true); item.calls[0].settle(item.success); await pending;
    expect(useAppStore.getState().document).toBe(current); expect(useAppStore.getState().sheetMetalPreview).toBeNull();
    expect(isSheetFlatDisplayed(useAppStore.getState())).toBe(false);
  });
});
