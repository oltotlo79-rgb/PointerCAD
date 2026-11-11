import { readPcadFile, writePcadFile } from '@pointercad/io';
import { absoluteCoordinate, appendFeature, appendSolid, createDrawingDocument, createEmptyPartDocument,
  createEmptySketchDocument, createPointFeature, reevaluateDocument, replaceFeature, replaceSketch, resolveSketch,
  type PartDocument, type SketchDocument, type SketchLineFeature, type SolidBody, type Vec3 } from '@pointercad/model';
import { evaluateExpression } from '@pointercad/expression';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../store/appState.js';
import { bodyFor, extrudeFeature, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { faceFromSelectedPoints, selectedPointsFace } from './faceSelectedPoints.js';

const state = () => useAppStore.getState();
const SQUARE: readonly Vec3[] = [[0, 0, 0], [30, 0, 0], [30, 20, 0], [0, 20, 0]];

function sketchWith(positions: readonly Vec3[], planeId: string | readonly string[] = 'xy'): SketchDocument {
  let sketch = createEmptySketchDocument();
  for (const [index, position] of positions.entries()) {
    const plane = typeof planeId === 'string' ? planeId : planeId[index];
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(...position), plane));
  }
  return sketch;
}
function settle(document: PartDocument, generation: number, bodies: readonly SolidBody[] = []): void {
  state().recordRecomputeRequest(generation);
  state().applyRecompute(document, { ...resultFor(document), generation, bodies });
  state().recordRecomputeCompletion(generation, 'success');
}
function ready(sketch: SketchDocument, selection: readonly string[] = sketch.features.map(feature => feature.id)): void {
  state().applyDocument(replaceSketch(createEmptyPartDocument(), sketch), { replacesDocument: true });
  settle(state().document, 1);
  state().setSelection(selection, { kind: 'sketch', sketchId: state().sketch.id });
}
function assertUnchanged(reasonKey?: string): void {
  const before = state();
  const result = faceFromSelectedPoints();
  expect(result.ready).toBe(false);
  if (reasonKey !== undefined) expect(result.reasonKey).toBe(reasonKey);
  expect(state().document).toBe(before.document);
  expect(state().undoStack).toBe(before.undoStack);
}
const endpointIds = (line: SketchLineFeature): readonly string[] => [line.from, line.to].map(coordinate =>
  coordinate.mode === 'relative' && coordinate.base.kind === 'point' ? coordinate.base.pointId : 'other');

beforeEach(() => {
  resetTestStore();
  // The command-line focus is kept outside the document state, so it is not reset by resetTestStore.
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle', commandLineFocused: false });
});

describe('選んだ3点以上を通る面(R30)', () => {
  it('選んだ順の閉じた線分と面を1回の文書更新で作り、元の点を保ち、Undo/Redoを1回で戻す', () => {
    ready(sketchWith(SQUARE));
    const before = state().document, historyLength = state().undoStack.past.length;
    let documentUpdates = 0;
    const unsubscribe = useAppStore.subscribe((next, previous) => { if (next.document !== previous.document) documentUpdates++; });
    const result = faceFromSelectedPoints();
    unsubscribe();
    if (!result.ready) throw new Error(result.reasonKey);
    expect(documentUpdates).toBe(1);
    expect(state().undoStack.past).toHaveLength(historyLength + 1);
    expect(state().sketch.features.slice(0, 4)).toEqual(before.sketches[0].features);
    expect(result.reordered).toBe(false);
    expect(result.lines.map(endpointIds)).toEqual([
      ['point-1', 'point-2'], ['point-2', 'point-3'], ['point-3', 'point-4'], ['point-4', 'point-1']]);
    for (const line of result.lines) {
      expect(line).toMatchObject({ kind: 'line', planeId: 'xy', construction: false,
        from: { mode: 'relative', dx: { value: 0 }, dy: { value: 0 }, dz: { value: 0 } } });
    }
    expect(result.face).toMatchObject({ kind: 'face', planeId: 'xy', boundary: result.lines.map(line => ({ featureId: line.id })) });
    expect(state().sketch.features.slice(4)).toEqual([...result.lines, result.face]);
    expect(state().selection).toEqual([result.face.id]);
    expect(state().editNoticeKey).toBe('sketch.facePoints.created');
    const resolved = resolveSketch(state().sketch);
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves.map(curve => curve.kind === 'segment' ? [curve.from, curve.to] : null))
      .toEqual(SQUARE.map((position, index) => [position, SQUARE[(index + 1) % 4]]));
    const after = state().document;
    state().undo(); expect(state().document).toBe(before); expect(state().undoStack.past).toHaveLength(historyLength);
    state().redo(); expect(state().document).toBe(after);
  });
  it('交差する選択順は並べ直して作り、並べ直したことを知らせる', () => {
    ready(sketchWith([[0, 0, 0], [30, 0, 0], [0, 20, 0], [30, 20, 0]]));
    const result = faceFromSelectedPoints();
    if (!result.ready) throw new Error(result.reasonKey);
    expect(result.reordered).toBe(true);
    expect(result.lines.map(endpointIds)).toEqual([
      ['point-1', 'point-2'], ['point-2', 'point-4'], ['point-4', 'point-3'], ['point-3', 'point-1']]);
    expect(state().editNoticeKey).toBe('sketch.facePoints.createdReordered');
    expect(resolveSketch(state().sketch).faces).toHaveLength(1);
  });
  it('3Dの傾いた平面や異なる作図面の点はfreeの線分と面にする', () => {
    const tilted: readonly Vec3[] = [[-10, -10, -10], [10, -10, -10], [10, 10, 10], [-10, 10, 10]];
    for (const planes of [['free', 'free', 'free', 'free'], ['xy', 'free', 'free', 'free']] as const) {
      resetTestStore();
      const positions = planes[0] === 'xy' ? [[-10, -10, 0], [10, -10, 0], [10, 10, 20], [-10, 10, 20]] as const : tilted;
      ready(sketchWith(positions, planes));
      const result = faceFromSelectedPoints();
      if (!result.ready) throw new Error(result.reasonKey);
      expect(result.face.planeId).toBe('free');
      expect(result.lines.every(line => line.planeId === 'free')).toBe(true);
      const resolved = resolveSketch(state().sketch);
      expect(resolved.errors).toEqual([]);
      expect(resolved.faces).toHaveLength(1);
    }
  });
  it('保存・再読込の後も参照と面が同じで、元の点の係数を変えると面の角も追従する', () => {
    ready(sketchWith(SQUARE));
    const result = faceFromSelectedPoints();
    if (!result.ready) throw new Error(result.reasonKey);
    const reopened = readPcadFile(writePcadFile(state().document));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.sketches).toEqual(state().document.sketches);
    const sketch = reopened.document.sketches[0], first = sketch.features[0];
    if (first.kind !== 'point') throw new Error('point');
    const value = evaluateExpression('w * 2', { variables: new Map([['w', 3]]) });
    if (!value.ok) throw new Error('expression');
    const changed = replaceFeature(sketch, first.id, { ...first,
      at: { mode: 'absolute', x: value.value, y: absoluteCoordinate(0, -4, 0).y, z: absoluteCoordinate(0, 0, 0).z } });
    expect(resolveSketch(changed).faces[0].curves[0]).toMatchObject({ from: [6, -4, 0], to: [30, 0, 0] });
    const reevaluated = reevaluateDocument(changed, new Map([['w', 5]]));
    expect(resolveSketch(reevaluated).faces[0].curves[3]).toMatchObject({ from: [0, 20, 0], to: [10, -4, 0] });
    expect(reevaluated.features.slice(4)).toEqual([...result.lines, result.face]);
  });
  it.each([
    [[], 'sketch.facePoints.selectThree'], [['point-1'], 'sketch.facePoints.selectThree'],
    [['point-1', 'point-2'], 'sketch.facePoints.selectThree'],
    [['point-1', 'point-2', 'point-1'], 'sketch.facePoints.samePoint'],
  ] as const)('選択%jは理由%sで断り、文書とUndoを変えない', (selection, reasonKey) => {
    ready(sketchWith(SQUARE), selection);
    assertUnchanged(reasonKey);
  });
  it('点以外・認証の無い点・別スケッチの点を含む選択を断る', () => {
    ready(sketchWith(SQUARE));
    state().setSelection(['point-1', 'point-2', 'line-1'], { kind: 'sketch', sketchId: state().sketch.id });
    assertUnchanged('sketch.facePoints.pointFeaturesOnly');
    state().setSelection(['point-1', 'point-2', 'point-3']);
    assertUnchanged('sketch.facePoints.reselect');
    const document: PartDocument = { ...state().document,
      sketches: [...state().document.sketches, { ...state().sketch, id: 'sketch-2' }] };
    state().applyDocument(document);
    settle(document, 2);
    state().setSelection(['point-1', 'point-2'], { kind: 'sketch', sketchId: state().sketch.id });
    state().toggleSelection('point-3', { kind: 'sketch', sketchId: 'sketch-2' });
    expect(selectedPointsFace().reasonKey).toBe('sketch.facePoints.otherSketch');
    assertUnchanged('sketch.facePoints.otherSketch');
  });
  it.each([
    ['collinear', [[0, 0, 0], [10, 0, 0], [20, 0, 0]], 'sketch.facePoints.collinear'],
    ['notPlanar', [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], 'sketch.facePoints.notPlanar'],
    ['samePoint', [[0, 0, 0], [10, 0, 0], [0, 0, 0], [0, 10, 0]], 'sketch.facePoints.samePoint'],
    ['selfIntersecting', [[0, 0, 0], [1000, 0, 0], [500, 5e-7, 0]], 'sketch.facePoints.selfIntersecting'],
  ] as const)('%sの点は理由を出して断る', (_name, positions, reasonKey) => {
    ready(sketchWith(positions, 'free'));
    expect(selectedPointsFace().reasonKey).toBe(reasonKey);
    assertUnchanged(reasonKey);
  });
  it('未解決・非有限の点は位置を確認できないとして断る', () => {
    ready(sketchWith(SQUARE));
    const resolved = state().resolvedSketch;
    for (const position of [[Number.NaN, 0, 0], [0, Number.POSITIVE_INFINITY, 0]] as const) {
      useAppStore.setState({ resolvedSketch: { ...resolved, points: resolved.points.map(point => point.id === 'point-2'
        ? { ...point, position } : point) } });
      assertUnchanged('sketch.connect.unresolved');
    }
    useAppStore.setState({ resolvedSketch: { ...resolved, points: resolved.points.filter(point => point.id !== 'point-3') } });
    assertUnchanged('sketch.connect.unresolved');
  });
  const invalidations: readonly [string, (before: AppState) => Partial<AppState>, string][] = [
    ['computing', () => ({ isComputing: true }), 'sketch.facePoints.computing'],
    ['outstanding generation', () => ({ requestedGeneration: 2 }), 'sketch.facePoints.computing'],
    ['cancelled', () => ({ recomputeCancelled: true, lastOutcome: 'cancelled' }), 'sketch.connect.unresolved'],
    ['no result snapshot', () => ({ mathGeometryResult: null }), 'sketch.connect.unresolved'],
    ['replaced sketch object', before => ({ sketch: { ...before.sketch } }), 'sketch.connect.unresolved'],
    ['another document', before => ({ document: { ...before.document, id: 'another-document' } }), 'sketch.connect.unresolved'],
    ['cancellation request', before => ({ cancelRequestCount: before.cancelRequestCount + 1 }), 'sketch.facePoints.reselect'],
    ['document replacement or Undo epoch', before => ({ documentVersion: before.documentVersion + 1 }), 'sketch.facePoints.reselect'],
    ['another session', () => ({ activeDocumentId: 'different-session' }), 'sketch.facePoints.reselect'],
    ['direct selection replacement', before => ({ selection: [...before.selection] }), 'sketch.facePoints.reselect'],
    ['another file owner', before => ({ fileGateway: { ...before.fileGateway } }), 'sketch.facePoints.reselect'],
    ['line tool', () => ({ activeTool: 'line' }), 'sketch.connect.editing'],
    ['constraint', () => ({ activeConstraintKind: 'coincident' }), 'sketch.connect.editing'],
    ['history', () => ({ timelineIndex: 0 }), 'sketch.connect.editing'],
    ['command line', () => ({ commandLineFocused: true }), 'sketch.connect.editing'],
  ];
  it.each(invalidations)('%sの間は文書を更新しない', (_name, patch, reasonKey) => {
    ready(sketchWith(SQUARE));
    useAppStore.setState(patch(state()));
    assertUnchanged(reasonKey);
  });
  it('図面では使えず、選択の出所を確認した後の実Undo/Redoでも古い選択を使わない', () => {
    ready(sketchWith(SQUARE));
    const before = state();
    state().openDrawing(createDrawingDocument('drawing', { sourceRef: 'part', sourceKind: 'part',
      path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' }));
    assertUnchanged('command.unavailable.document');
    useAppStore.setState(before);
    state().applyDocument({ ...state().document, name: 'changed' });
    settle(state().document, 2);
    state().setSelection(['point-1', 'point-2', 'point-3'], { kind: 'sketch', sketchId: state().sketch.id });
    const selection = state().selection, certificate = state().connectionSelection;
    state().undo(); state().redo();
    useAppStore.setState({ selection, connectionSelection: certificate });
    assertUnchanged();
  });
});

describe('立体の頂点を含む面(R30)', () => {
  const body = (): SolidBody => ({ ...bodyFor('solid-1'),
    mesh: { ...bodyFor('solid-1').mesh, positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 10, 0, 10, 10]) },
    vertices: [{ index: 0, position: [0, 0, 0] }, { index: 1, position: [10, 0, 0] },
      { index: 2, position: [10, 10, 10] }, { index: 3, position: [0, 10, 10] }],
  });
  function solidReady(): void {
    let document = appendSolid(createEmptyPartDocument(), extrudeFeature('solid-1'));
    let sketch = document.sketches[0];
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(5, 15, 15), 'free'));
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(5, 15, 0), 'free'));
    document = replaceSketch(document, sketch);
    state().resetDocument(document);
    settle(document, 1, [body()]);
  }
  beforeEach(() => { resetTestStore(); solidReady(); });

  it('頂点だけ・頂点と点の混在で元参照を持つfreeの線分と面を作り、1回のUndoで戻す', () => {
    for (const ids of [['solid-1#vertex:0', 'solid-1#vertex:1', 'solid-1#vertex:2', 'solid-1#vertex:3'],
      ['solid-1#vertex:0', 'solid-1#vertex:1', 'point-1']]) {
      resetTestStore(); solidReady();
      state().setSelection(ids, { kind: 'pick' });
      const before = state().document, history = state().undoStack.past.length;
      const result = faceFromSelectedPoints();
      if (!result.ready) throw new Error(result.reasonKey);
      expect(result.face.planeId).toBe('free');
      const first = result.lines[0];
      expect(first.from).toMatchObject({ mode: 'relative', base: { kind: 'subShape',
        ref: { bodyFeatureId: 'solid-1', fingerprint: { kind: 'vertex', position: [0, 0, 0] } } } });
      expect(resolveSketch(state().sketch).faces).toHaveLength(1);
      expect(state().undoStack.past).toHaveLength(history + 1);
      state().undo(); expect(state().document).toBe(before);
    }
  });
  it('同じ平面に乗らない頂点、見つからない頂点、新しい世代の頂点を断る', () => {
    state().setSelection(['solid-1#vertex:0', 'solid-1#vertex:1', 'solid-1#vertex:2', 'point-2'], { kind: 'pick' });
    assertUnchanged('sketch.facePoints.notPlanar');
    state().setSelection(['solid-1#vertex:0', 'solid-1#vertex:1', 'solid-1#vertex:2'], { kind: 'pick' });
    const certified = state();
    useAppStore.setState({ bodies: [{ ...body(), vertices: [] }] });
    assertUnchanged('sketch.connect.missing');
    useAppStore.setState({ bodies: certified.bodies, requestedGeneration: 2, completedGeneration: 2,
      mathGeometryResult: certified.mathGeometryResult === null ? null : { ...certified.mathGeometryResult, generation: 2 } });
    assertUnchanged('sketch.facePoints.reselect');
  });
  it('3つ以上で点か頂点を含む選択だけを面の候補としてメニューへ出す', () => {
    state().setSelection(['solid-1#vertex:0', 'solid-1#vertex:1'], { kind: 'pick' });
    expect(selectedPointsFace().showInMenu).toBe(false);
    state().toggleSelection('solid-1#vertex:2', { kind: 'pick' });
    expect(selectedPointsFace()).toMatchObject({ showInMenu: true, ready: true });
    state().setSelection(['solid-1#face:0', 'solid-1#edge:0', 'solid-1#edge:1'], { kind: 'pick' });
    expect(selectedPointsFace().showInMenu).toBe(false);
  });
});
