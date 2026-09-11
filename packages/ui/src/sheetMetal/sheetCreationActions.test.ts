import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, createSheetBaseFeature, createSheetFlangeFeature, resolvePart, sheetBoundaryEdges } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyFor, createFakeRecompute, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildSheetCreation } from './sheetCommands.js';
import { applySheetCreation, displayedSheetBodies } from './sheetCreationActions.js';

function setup() {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const document = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '外周', planeId: 'xy', construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
    { kind: 'face', id: 'face', name: '基板輪郭', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
  ] });
  const base = createSheetBaseFeature(document, { sketchId: sketch.id, faceFeatureId: 'face' });
  useAppStore.getState().applyDocument(document, { undoable: false });
  // 実アプリ同様、元のスケッチの再計算完了後に板金の作成を始める。
  useAppStore.getState().applyRecompute(document, resultFor(document));
  useAppStore.getState().openSheetMetalTool('sheetBase');
  const session = useAppStore.getState().sheetMetalTool; if (session === null) throw new Error('作成を開始できません');
  const candidate = buildSheetCreation(document, base, {}, 'mm', {}); if (!candidate.ok) throw new Error(candidate.message);
  expect(useAppStore.getState().isComputing).toBe(false);
  const fake = createFakeRecompute();
  useAppStore.getState().setSheetMetalComputer((doc, _requestId, shouldCancel) => fake.recompute(doc, { shouldCancel }));
  const success = { ...resultFor(candidate.document), bodies: [bodyFor(base.id)] };
  return { document, base, session, candidate, fake, success };
}
beforeEach(() => { resetTestStore(); useAppStore.getState().setSheetMetalComputer(null); });
afterEach(() => { useAppStore.getState().closeSheetMetalTool(); useAppStore.getState().setSheetMetalComputer(null); });

describe('実形状が成功した板金だけを文書へ確定する', () => {
  it('消費済みの基板の再編集では後続形状を検査し、失敗は保持、成功は同じ位置でUndo1回へまとめる', async () => {
    const initial = setup(), panel = resolvePart(initial.candidate.document).sheetMetalBodies?.get(initial.base.id)?.panels[0];
    if (panel === undefined) throw new Error('基板が必要です');
    const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
    const flange = createSheetFlangeFeature(initial.candidate.document, initial.base.id, [{ panelId: panel.id, boundaryId: edges.value[0].id }]);
    const added = buildSheetCreation(initial.candidate.document, flange, {}, 'mm', {}); if (!added.ok) throw new Error(added.message);
    const document = added.document;
    useAppStore.getState().applyDocument(document, { undoable: false });
    useAppStore.getState().applyRecompute(document, { ...resultFor(document), bodies: [bodyFor(flange.id)] });
    useAppStore.getState().openSheetMetalTool('sheetBase', initial.base.id);
    const session = useAppStore.getState().sheetMetalTool; if (session === null) throw new Error('編集が必要です');
    expect(session.editingFeature).toBe(initial.base);
    const changed = buildSheetCreation(document, initial.base, { sheetThickness: '3' }, 'mm', {}, initial.base);
    if (!changed.ok) throw new Error(changed.message);
    const failed = applySheetCreation(session, changed, true);
    initial.fake.calls[0].settle({ ...resultFor(changed.document), bodies: [bodyFor(initial.base.id)],
      errors: [{ featureId: flange.id, code: 'kernelFailed', message: '後続の曲げが交差しています' }] });
    await failed; expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().sheetMetalError).toContain('後続');
    const pending = applySheetCreation(session, changed, false), body = { ...bodyFor(flange.id), volume: 7200 };
    initial.fake.calls[1].settle({ ...resultFor(changed.document), bodies: [body] }); await pending;
    expect(useAppStore.getState().sheetMetalPreview).toMatchObject({ featureId: initial.base.id, volume: 7200 });
    expect(useAppStore.getState().document).toBe(document);
    await applySheetCreation(session, changed, true); expect(initial.fake.calls).toHaveLength(2);
    expect(useAppStore.getState().document.solids).toHaveLength(2);
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(document);
  });
  it('プレビューは履歴を積まず、同じ候補の確定は追加計算せずUndo1回で戻る', async () => {
    const { document, base, session, candidate, fake, success } = setup();
    const pending = applySheetCreation(session, candidate, false);
    expect(useAppStore.getState().document).toBe(document); expect(fake.calls).toHaveLength(1);
    fake.calls[0].settle(success); await pending;
    const shown = useAppStore.getState();
    expect(shown.document).toBe(document); expect(shown.canUndo).toBe(false);
    expect(displayedSheetBodies(shown)).toBe(success.bodies); expect(shown.sheetMetalRequestId).toBeNull();
    const rebuilt = buildSheetCreation(document, { ...base }, {}, 'mm', {}); if (!rebuilt.ok) throw new Error(rebuilt.message);
    expect(rebuilt.document).not.toBe(candidate.document);
    await applySheetCreation(session, rebuilt, true);
    expect(fake.calls).toHaveLength(1); expect(useAppStore.getState().document).toBe(rebuilt.document);
    expect(useAppStore.getState().sheetMetalPreview).toBeNull();
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(document);
  });
  it('値が同じでも式sourceを変えた候補は、旧プレビューで確定しない', async () => {
    const { document, base, session, candidate, fake, success } = setup();
    const preview = applySheetCreation(session, candidate, false); fake.calls[0].settle(success); await preview;
    const rebuilt = buildSheetCreation(document, base, { sheetThickness: '0.5 + 0.5' }, 'mm', {});
    if (!rebuilt.ok) throw new Error(rebuilt.message);
    const pending = applySheetCreation(session, rebuilt, true);
    expect(fake.calls).toHaveLength(2); expect(useAppStore.getState().document).toBe(document);
    fake.calls[1].settle(success); await pending;
    expect(useAppStore.getState().document).toBe(rebuilt.document);
  });
  it('初回の作成も実形状を待ってから履歴を積む', async () => {
    const { document, session, candidate, fake, success } = setup();
    const pending = applySheetCreation(session, candidate, true);
    expect(useAppStore.getState().document).toBe(document);
    await applySheetCreation(session, candidate, true); expect(fake.calls).toHaveLength(1);
    fake.calls[0].settle(success); await pending;
    expect(useAppStore.getState().document).toBe(candidate.document); expect(useAppStore.getState().sheetMetalRequestId).toBeNull();
    expect(useAppStore.getState().sheetMetalTool).toBeNull();
  });
  it.each(['failure', 'missingBody', 'cancelled'] as const)('%sなら元の入力と形を保ち、履歴を積まない', async (kind) => {
    const { document, session, candidate, fake, success } = setup();
    const beforeBodies = useAppStore.getState().bodies;
    const pending = applySheetCreation(session, candidate, true);
    fake.calls[0].settle(kind === 'failure' ? { ...success, errors: [{ featureId: candidate.feature.id, code: 'kernelFailed', message: '輪郭が交差しています' }] }
      : kind === 'missingBody' ? { ...success, bodies: [] } : { ...success, cancelled: true });
    await pending;
    expect(useAppStore.getState().document).toBe(document); expect(useAppStore.getState().bodies).toBe(beforeBodies);
    expect(useAppStore.getState().sheetMetalTool).toBe(session); expect(useAppStore.getState().canUndo).toBe(false);
    if (kind !== 'cancelled') expect(useAppStore.getState().sheetMetalError).not.toBeNull();
  });
  it.each(['cancel', 'newDocument', 'anotherTool', 'newSession', 'editedInput'] as const)('%sのあとに返る古い成功は適用しない', async (kind) => {
    const { session, candidate, fake, success } = setup();
    const pending = applySheetCreation(session, candidate, true);
    const state = useAppStore.getState();
    if (kind === 'cancel') state.closeSheetMetalTool();
    if (kind === 'newDocument') state.applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    if (kind === 'anotherTool') state.setActiveTool('line');
    if (kind === 'newSession') state.openSheetMetalTool('sheetBase');
    if (kind === 'editedInput') state.clearSheetMetalPreview();
    const current = useAppStore.getState().document;
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].settle(success); await pending;
    expect(useAppStore.getState().document).toBe(current); expect(useAppStore.getState().sheetMetalPreview).toBeNull();
  });
  it('連続20入力が逆順に完了しても最後の入力だけをUndo1回へ確定する', async () => {
    const { document, base, session, fake, success } = setup();
    const candidates = Array.from({ length: 20 }, (_, i) => {
      const candidate = buildSheetCreation(document, base, { sheetThickness: `${i + 1}mm` }, 'mm', {});
      if (!candidate.ok) throw new Error(candidate.message);
      return candidate;
    });
    const pending = candidates.map((candidate) => {
      useAppStore.getState().clearSheetMetalPreview();
      return applySheetCreation(session, candidate, true);
    });
    expect(fake.calls).toHaveLength(20);
    for (let i = 19; i >= 0; i--) {
      if (i < 19) expect(fake.calls[i].options.shouldCancel?.()).toBe(true);
      fake.calls[i].settle({ ...success, bodies: [{ ...success.bodies[0], volume: 1500 * (i + 1) }] });
      await pending[i];
      expect(useAppStore.getState().document).toBe(candidates[19].document);
    }
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('Workerの例外は理由を出し、取消可能な作成入力と元文書を保つ', async () => {
    const { document, session, candidate } = setup();
    useAppStore.getState().setSheetMetalComputer(() => Promise.reject(new Error('計算部が停止しました')));
    await applySheetCreation(session, candidate, true);
    expect(useAppStore.getState().document).toBe(document); expect(useAppStore.getState().sheetMetalTool).toBe(session);
    expect(useAppStore.getState().sheetMetalError).toBe('計算部が停止しました'); expect(useAppStore.getState().sheetMetalRequestId).toBeNull();
  });
});
