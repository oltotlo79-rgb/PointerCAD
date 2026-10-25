import { absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, createPointFeature,
  replaceSketch, resolveSketch, type PartDocument, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../store/appState.js';
import { bodyFor, extrudeFeature, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { connectSelectedPoints, selectedPointsConnection } from './connectSelectedPoints.js';
import { pickConnectionPoint } from './connectionSelection.js';

const state = () => useAppStore.getState();
const body = (id = 'solid-1'): SolidBody => ({ ...bodyFor(id),
  mesh: { ...bodyFor(id).mesh, positions: new Float32Array([0, 0, 0, 10, 20, 30]) },
  vertices: [{ index: 0, position: [0, 0, 0] }, { index: 1, position: [10, 20, 30] }],
});
function ready(): void {
  let document = appendSolid(createEmptyPartDocument(), extrudeFeature('solid-1'));
  let sketch = document.sketches[0];
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(40, 50, 60), 'free'));
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(25, 35, 45), 'free'));
  document = replaceSketch(document, sketch);
  state().resetDocument(document);
  state().recordRecomputeRequest(1);
  state().applyRecompute(document, { ...resultFor(document), generation: 1, bodies: [body()] });
  state().recordRecomputeCompletion(1, 'success');
}
function pick(ids = ['point-1', 'solid-1#vertex:1']): void { state().setSelection(ids, { kind: 'pick' }); }
function assertUnchanged(): void {
  const before = state();
  expect(connectSelectedPoints().ready).toBe(false);
  expect(state().document).toBe(before.document);
  expect(state().undoStack).toBe(before.undoStack);
  expect(state().connectionSelection).toBe(before.connectionSelection);
}
beforeEach(() => { resetTestStore(); ready(); });

describe('selection ownership at the actual store boundary', () => {
  it('certifies a plain-clicked sketch point from its untouched drag hit, then keeps it through a Shift pick', () => {
    state().beginSketchDrag({ pointKey: 'point-1', featureId: 'point-1', field: 'at', index: null,
      startUv: [40, 50], grabUv: [40, 50] });
    state().setSelection(['point-1']);
    expect(state().connectionSelection?.endpoints.get('point-1')).toMatchObject({
      kind: 'point', pointId: 'point-1', sketchId: state().sketch.id,
    });
    state().endSketchDrag(false);
    state().toggleSelection('point-2', { kind: 'pick' });
    expect(selectedPointsConnection().ready).toBe(true);
    const before = state().document, historyLength = state().undoStack.past.length;
    expect(connectSelectedPoints().ready).toBe(true);
    expect(state().undoStack.past).toHaveLength(historyLength + 1);
    expect(state().undoStack.past.at(-1)).toBe(before);
  });
  it('does not certify raw point IDs without the matching untouched point drag', () => {
    state().setSelection(['point-1']);
    expect(state().connectionSelection?.endpoints.has('point-1')).toBe(false);
    state().beginSketchDrag({ pointKey: 'point-2', featureId: 'point-2', field: 'at', index: null,
      startUv: [25, 35], grabUv: [25, 35] });
    state().setSelection(['point-1']);
    expect(state().connectionSelection?.endpoints.has('point-1')).toBe(false);
    state().endSketchDrag(false);
    state().toggleSelection('point-2', { kind: 'pick' });
    assertUnchanged();
  });
  it.each([[], ['solid-1#vertex:0'], ['solid-1#vertex:0', 'solid-1#vertex:0'],
    ['solid-1#vertex:0', 'solid-1#vertex:1', 'point-1'], ['solid-1#vertex:0', 'solid-1#face:0'],
    ['solid-1#vertex:0', 'solid-1#edge:0']])('refuses unsupported vertex selection %j', (...ids) => {
    pick(ids); assertUnchanged();
  });
  it('refuses zero length and non-finite mixed endpoints without a history update', () => {
    pick();
    const resolved = state().resolvedSketch;
    for (const position of [[10, 20, 30], [Number.NaN, 20, 30]] as const) {
      useAppStore.setState({ resolvedSketch: { ...resolved, points: resolved.points.map(point => point.id === 'point-1'
        ? { ...point, position } : point) } });
      assertUnchanged();
    }
  });
  const invalidations: readonly [string, (before: AppState) => Partial<AppState>][] = [
    ['same ID in a new generation', before => ({ bodies: [{ ...body(), vertices: [{ index: 1, position: [99, 88, 77] }] }],
      requestedGeneration: 2, completedGeneration: 2, mathGeometryResult: before.mathGeometryResult === null ? null
        : { ...before.mathGeometryResult, generation: 2 } })],
    ['edit before a calculation request', before => ({ document: { ...before.document, solids: [] } })],
    ['computing', () => ({ isComputing: true })],
    ['outstanding generation', () => ({ requestedGeneration: 2 })],
    ['old result snapshot', before => ({ mathGeometryResult: before.mathGeometryResult === null ? null
      : { ...before.mathGeometryResult, generation: 0 } })],
    ['cancelled', () => ({ recomputeCancelled: true, lastOutcome: 'cancelled' })],
    ['after cancellation and successful recomputation', before => ({ cancelRequestCount: before.cancelRequestCount + 1 })],
    ['same document ID in another session', () => ({ activeDocumentId: 'different-session' })],
    ['document replacement or Undo epoch', before => ({ documentVersion: before.documentVersion + 1 })],
    ['another active sketch', before => ({ document: { ...before.document, activeSketchId: 'sketch-2' } })],
    ['direct selection replacement', before => ({ selection: [...before.selection] })],
    ['another file owner', before => ({ fileGateway: { ...before.fileGateway } })],
  ];
  it.each(invalidations)('refuses %s without a document or Undo update', (_name, patch) => {
    pick();
    const before = state();
    useAppStore.setState(patch(before));
    assertUnchanged();
  });
  it('does not refresh an old vertex when adding a new point', () => {
    pick(['solid-1#vertex:1']);
    const old = state().connectionSelection?.endpoints.get('solid-1#vertex:1');
    const snapshot = state().mathGeometryResult;
    if (snapshot === null) throw new Error('snapshot');
    useAppStore.setState({ requestedGeneration: 2, completedGeneration: 2, mathGeometryResult: { ...snapshot, generation: 2 } });
    state().toggleSelection('point-1', { kind: 'pick' });
    expect(state().connectionSelection?.endpoints.get('solid-1#vertex:1')).toBe(old);
    assertUnchanged();
  });
  it('refuses uncertified raw IDs and never certifies an existing raw ID during an addition', () => {
    state().setSelection(['solid-1#vertex:1']);
    state().toggleSelection('point-1', { kind: 'pick' });
    expect(state().connectionSelection?.endpoints.has('solid-1#vertex:1')).toBe(false);
    assertUnchanged();
  });
  it('refuses a point whose actual sketch is different even when its ID exists here', () => {
    const document: PartDocument = { ...state().document,
      sketches: [...state().document.sketches, { ...state().sketch, id: 'sketch-2' }] };
    state().applyDocument(document);
    state().recordRecomputeRequest(2);
    state().applyRecompute(document, { ...resultFor(document), generation: 2, bodies: [body()] });
    state().recordRecomputeCompletion(2, 'success');
    state().setSelection(['point-1'], { kind: 'sketch', sketchId: state().sketch.id });
    state().toggleSelection('point-2', { kind: 'sketch', sketchId: 'sketch-2' });
    expect(selectedPointsConnection().reasonKey).toBe('sketch.connect.otherSketch');
    assertUnchanged();
  });
  it.each([['point-1', 'solid-1#vertex:1'], ['solid-1#vertex:0', 'solid-1#vertex:1']])(
    'creates a free reference line for %s / %s with one Undo', (first, second) => {
      pick([first, second]);
      const original = state().connectionSelection?.endpoints.get(second);
      const before = state().document, history = state().undoStack.past.length;
      const result = connectSelectedPoints();
      if (!result.ready || original?.kind !== 'vertex') throw new Error('expected ready vertex');
      expect(result.line.planeId).toBe('free');
      expect(result.line.to).toMatchObject({ mode: 'relative', base: { kind: 'subShape', ref: original.originalReference },
        dx: { value: 0 }, dy: { value: 0 }, dz: { value: 0 } });
      expect(state().undoStack.past).toHaveLength(history + 1);
      state().undo(); expect(state().document).toBe(before);
    },
  );
  it('finds the original body after body order changes', () => {
    const document = appendSolid(state().document, extrudeFeature('solid-2'));
    state().applyDocument(document);
    state().recordRecomputeRequest(2);
    state().applyRecompute(document, { ...resultFor(document), generation: 2, bodies: [body(), body('solid-2')] });
    state().recordRecomputeCompletion(2, 'success');
    pick(['solid-1#vertex:0', 'solid-2#vertex:1']);
    useAppStore.setState({ bodies: [...state().bodies].reverse() });
    const result = selectedPointsConnection();
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error(result.reasonKey);
    expect(result.line.from).toMatchObject({ base: { ref: { bodyFeatureId: 'solid-1' } } });
    expect(result.line.to).toMatchObject({ base: { ref: { bodyFeatureId: 'solid-2' } } });
  });
  it.each(['missing', 'ambiguous'] as const)('refuses a %s original reference without replacing its fingerprint', status => {
    pick();
    useAppStore.setState({ bodies: [{ ...body(), vertices: status === 'missing' ? []
      : [{ index: 1, position: [10, 20, 30] }, { index: 1, position: [10, 20, 30] }] }] });
    expect(selectedPointsConnection().reasonKey).toBe(`sketch.connect.${status}`);
    assertUnchanged();
  });
  it('refuses actual Undo and Redo with an earlier certificate', () => {
    state().applyDocument({ ...state().document, name: 'changed' });
    pick();
    const savedSelection = state().selection, certificate = state().connectionSelection;
    state().undo(); state().redo();
    useAppStore.setState({ selection: savedSelection, connectionSelection: certificate });
    assertUnchanged();
  });
});

describe('the same projected point candidates for hover and click', () => {
  const project = (position: readonly [number, number, number]): readonly [number, number] => [position[0], position[1]];
  it('picks sketch point features and solid vertices from their real positions', () => {
    expect(pickConnectionPoint(state(), project, [40, 50])).toEqual({ kind: 'hit', elementId: 'point-1' });
    expect(pickConnectionPoint(state(), project, [10, 20])).toEqual({ kind: 'hit', elementId: 'solid-1#vertex:1' });
  });
  it('rejects overlapping projected points and excludes line endpoint handles', () => {
    const resolvedSketch = resolveSketch(state().sketch);
    const point = resolvedSketch.points[0];
    useAppStore.setState({ resolvedSketch: { ...resolvedSketch, points: [
      { ...point, position: [10, 20, 99] },
      { ...point, id: 'line-1#start', featureId: 'line-1', position: [70, 80, 0] },
    ] } });
    expect(pickConnectionPoint(state(), project, [10, 20])).toEqual({ kind: 'ambiguous' });
    expect(pickConnectionPoint(state(), project, [70, 80])).toBeNull();
  });
});
