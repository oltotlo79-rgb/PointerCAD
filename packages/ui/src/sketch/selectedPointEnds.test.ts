import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createEmptySketchDocument, createPointFeature,
  replaceSketch, type PartDocument, type Vec3 } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../store/appState.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { selectedPointsConnection } from './connectSelectedPoints.js';
import { selectedPointsFace } from './faceSelectedPoints.js';
import { pointSelectionCount, pointSelectionStateRefusal, resolveSelectedPointEnds } from './selectedPointEnds.js';

const state = () => useAppStore.getState();
function ready(): void {
  let sketch = createEmptySketchDocument();
  const positions: readonly Vec3[] = [[0, 0, 0], [30, 0, 0], [0, 20, 0]];
  for (const position of positions) {
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(...position), 'xy'));
  }
  const document: PartDocument = replaceSketch(createEmptyPartDocument(), sketch);
  state().applyDocument(document, { replacesDocument: true });
  state().recordRecomputeRequest(1);
  state().applyRecompute(state().document, { ...resultFor(state().document), generation: 1 });
  state().recordRecomputeCompletion(1, 'success');
}
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle', commandLineFocused: false });
  ready();
});

describe('点の選択に対する2点接続と面の共通の判定(R29/R30)', () => {
  it('選んだ点の数は点・頂点・認証済みの項目だけを数える', () => {
    state().setSelection(['point-1', 'line-1', 'solid-1#vertex:0', 'solid-1#face:0'], { kind: 'sketch', sketchId: state().sketch.id });
    expect(pointSelectionCount(state())).toBe(2);
    expect(selectedPointsConnection().pointCount).toBe(2);
    expect(selectedPointsFace().pointCount).toBe(2);
    state().setSelection([]);
    expect(pointSelectionCount(state())).toBe(0);
  });
  it('文書・計算・入力の状態の断りは2つの操作で同じ順と同じ理由になる', () => {
    state().setSelection(['point-1', 'point-2', 'point-3'], { kind: 'sketch', sketchId: state().sketch.id });
    const before = state();
    const cases: readonly [Partial<AppState>, string | null][] = [
      [{}, null], [{ activeTool: 'line' }, 'sketch.connect.editing'], [{ timelineIndex: 0 }, 'sketch.connect.editing'],
      [{ lastOutcome: 'failed' }, 'sketch.connect.unresolved'], [{ mathGeometryResult: null }, 'sketch.connect.unresolved'],
    ];
    for (const [patch, reason] of cases) {
      useAppStore.setState({ ...before, ...patch });
      expect(pointSelectionStateRefusal(state(), 'sketch.connect.computing')).toBe(reason);
      expect(pointSelectionStateRefusal(state(), 'sketch.facePoints.computing')).toBe(reason);
    }
    useAppStore.setState({ ...before, isComputing: true });
    expect(selectedPointsConnection().reasonKey).toBe('sketch.connect.computing');
    expect(selectedPointsFace().reasonKey).toBe('sketch.facePoints.computing');
  });
  it('選択の出所の断りは操作ごとの文言で返し、確認できた点は選んだ順の参照を返す', () => {
    const reasons = { computing: 'sketch.facePoints.computing', reselect: 'sketch.facePoints.reselect',
      pointFeaturesOnly: 'sketch.facePoints.pointFeaturesOnly', otherSketch: 'sketch.facePoints.otherSketch' } as const;
    state().setSelection(['point-3', 'point-1']);
    expect(resolveSelectedPointEnds(state(), reasons)).toEqual({ ok: false, reasonKey: 'sketch.facePoints.reselect' });
    state().setSelection(['point-3', 'line-1'], { kind: 'sketch', sketchId: state().sketch.id });
    expect(resolveSelectedPointEnds(state(), reasons)).toEqual({ ok: false, reasonKey: 'sketch.facePoints.pointFeaturesOnly' });
    state().setSelection(['point-3', 'point-1'], { kind: 'sketch', sketchId: state().sketch.id });
    const resolved = resolveSelectedPointEnds(state(), reasons);
    if (!resolved.ok) throw new Error(resolved.reasonKey);
    expect(resolved.ends.map(end => [end.position, end.planeId])).toEqual([[[0, 20, 0], 'xy'], [[0, 0, 0], 'xy']]);
    expect(resolved.ends[0].coordinate).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: 'point-3' } });
  });
});
