import { evaluateExpression } from '@pointercad/expression';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createEmptySketchDocument, createPointFeature,
  createDrawingDocument, reevaluateDocument, replaceFeature, replaceSketch, resolveSketch, SKETCH_TOLERANCE_MM,
  type SketchDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { attachPartRecompute } from '../store/attachKernel.js';
import { createFakeRecompute, resetTestStore, resultFor, tick } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { connectSelectedPoints, prepareConnectedPoints, selectedPointsConnection } from './connectSelectedPoints.js';

const state = () => useAppStore.getState();
function points(planeId = 'xy', same = false): SketchDocument {
  let sketch = createEmptySketchDocument();
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(10, 20, 0), planeId));
  return appendFeature(sketch, createPointFeature(sketch, same ? absoluteCoordinate(10, 20, 0)
    : absoluteCoordinate(30, 40, planeId === 'free' ? 50 : 0), planeId));
}
function ready(sketch = points()): void {
  state().applyDocument(replaceSketch(createEmptyPartDocument(), sketch), { replacesDocument: true });
  state().recordRecomputeRequest(1);
  state().applyRecompute(state().document, { ...resultFor(state().document), generation: 1 });
  state().recordRecomputeCompletion(1, 'success');
  state().setSelection(['point-2', 'point-1'], { kind: 'sketch', sketchId: state().sketch.id });
}
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});

describe('2点を参照する線分', () => {
  it('異なる作図面のpointをfree線分で結び、世界XYZと元参照を保つ', () => {
    let sketch = createEmptySketchDocument();
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(10, 20, 0), 'xy'));
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(30, 40, 50), 'free'));
    ready(sketch);
    const result = connectSelectedPoints();
    if (!result.ready) throw new Error(result.reasonKey);
    expect(result.line.planeId).toBe('free');
    expect(result.line.from).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-2' } });
    expect(resolveSketch(state().sketch).segments[0]).toMatchObject({ from: [30, 40, 50], to: [10, 20, 0] });
  });
  it.each(['xy', 'free'])('%sの選択順で線分を追加し、元の点を保持してUndo/Redoを1回で戻す', planeId => {
    ready(points(planeId));
    const before = state().document, historyLength = state().undoStack.past.length;
    let documentUpdates = 0;
    const unsubscribe = useAppStore.subscribe((next, previous) => { if (next.document !== previous.document) documentUpdates++; });
    const result = connectSelectedPoints();
    unsubscribe();
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error(result.reasonKey);
    expect(documentUpdates).toBe(1);
    expect(state().undoStack.past).toHaveLength(historyLength + 1);
    expect(state().sketch.features.slice(0, 2)).toEqual(before.sketches[0].features);
    expect(state().selection).toEqual([result.line.id]);
    expect(result.line.from).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-2' }, dx: { value: 0 } });
    expect(result.line.to).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-1' }, dz: { value: 0 } });
    expect(resolveSketch(state().sketch).segments[0]).toMatchObject({
      from: [30, 40, planeId === 'free' ? 50 : 0], to: [10, 20, 0],
    });
    const after = state().document;
    state().undo(); expect(state().document).toBe(before); expect(state().undoStack.past).toHaveLength(historyLength);
    state().redo(); expect(state().document).toBe(after);
  });
  it('保存した点参照は数値と係数の再評価後も元の点へ追従する', () => {
    const sketch = points('free'), resolved = resolveSketch(sketch);
    const result = prepareConnectedPoints(sketch, resolved, ['point-1', 'point-2']);
    if (!result.ready) throw new Error(result.reasonKey);
    const value = evaluateExpression('w * 2', { variables: new Map([['w', 7]]) });
    if (!value.ok) throw new Error('expression');
    const connected = appendFeature(sketch, result.line);
    const first = sketch.features[0];
    if (first.kind !== 'point') throw new Error('point');
    const changed = replaceFeature(connected, first.id, { ...first,
      at: { mode: 'absolute', x: value.value, y: absoluteCoordinate(0, 0, 0).y, z: absoluteCoordinate(0, 0, 5).z } });
    expect(resolveSketch(changed).segments[0].from).toEqual([14, 0, 5]);
    const reevaluated = reevaluateDocument(changed, new Map([['w', 11]]));
    expect(resolveSketch(reevaluated).segments[0].from).toEqual([22, 0, 5]);
    expect(reevaluated.features[2]).toEqual(result.line);
    expect(resolveSketch(reevaluated).segments[0].to).toEqual([30, 40, 50]);
  });
  it.each([[], ['point-1'], ['point-1', 'point-2', 'point-3'], ['point-1', 'line-1'],
    ['point-1', 'solid-1#vertex:0'], ['point-1', 'other-sketch:point-1'], ['point-1', 'point-1']].map(selection => ({ selection })))(
    '無効な選択$selectionでは追加しない', ({ selection }) => {
      ready(); state().setSelection(selection);
      const before = state();
      expect(connectSelectedPoints().ready).toBe(false);
      expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
    },
  );
  it('同じ座標と許容誤差内の長さ、未解決・非有限の点を拒否する', () => {
    const sketch = points(), resolved = resolveSketch(sketch);
    for (const distance of [0, SKETCH_TOLERANCE_MM / 2, NaN]) {
      const moved = { ...resolved, points: [resolved.points[0], { ...resolved.points[1],
        position: [10 + distance, 20, 0] as const }] };
      expect(prepareConnectedPoints(sketch, moved, ['point-1', 'point-2']).ready).toBe(false);
    }
    expect(prepareConnectedPoints(sketch, { ...resolved, points: [] }, ['point-1', 'point-2']).reasonKey)
      .toBe('sketch.connect.unresolved');
    ready(points('xy', true)); expect(connectSelectedPoints().reasonKey).toBe('sketch.connect.samePoint');
  });
  it('同じIDの点が残っていても、旧文書の結果・未完了の世代・中止結果を使わない', () => {
    ready(); const before = state();
    for (const patch of [
      { isComputing: true }, { requestedGeneration: 2 }, { lastOutcome: 'cancelled' as const },
      { mathGeometryResult: null }, { sketch: { ...before.sketch } },
      { document: { ...before.document, id: 'another-document' } },
      { document: { ...before.document, sketches: [points('free')] } },
    ]) {
      useAppStore.setState({ ...before, ...patch });
      expect(connectSelectedPoints().ready).toBe(false);
      expect(state().documentVersion).toBe(before.documentVersion);
    }
  });
  it('入力・拘束・履歴途中・図面の間は文書を更新しない', () => {
    ready(); const before = state();
    for (const patch of [{ activeTool: 'line' as const }, { activeConstraintKind: 'coincident' as const },
      { timelineIndex: 0 }, { commandLineFocused: true }]) {
      useAppStore.setState({ ...before, ...patch });
      expect(connectSelectedPoints().reasonKey).toBe('sketch.connect.editing');
      expect(state().document).toBe(before.document);
    }
    useAppStore.setState(before);
    state().openDrawing(createDrawingDocument('drawing', { sourceRef: 'part', sourceKind: 'part',
      path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' }));
    expect(connectSelectedPoints().reasonKey).toBe('command.unavailable.document');
    expect(state().document).toBe(before.document);
  });
  it('数学測定の定義が無い通常スケッチでも実ストアの再計算経路を通って接続できる', async () => {
    state().setSketch(points()); state().setSelection(['point-1', 'point-2'], { kind: 'sketch', sketchId: state().sketch.id });
    expect(state().mathGeometryResult).toBeNull();
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    try {
      const call = fake.calls[0];
      expect(selectedPointsConnection().ready).toBe(false);
      // resultFor deliberately omits mathGeometry, as ordinary sketches may do.
      call.settle({ ...resultFor(call.document), generation: call.options.generation ?? 0 });
      await tick();
      expect(state().mathGeometryResult?.evaluated).toBe(false);
      expect(state().lastOutcome).toBe('success');
      expect(connectSelectedPoints().ready).toBe(true);
      expect(fake.calls).toHaveLength(2);
    } finally { detach(); }
  });
});
