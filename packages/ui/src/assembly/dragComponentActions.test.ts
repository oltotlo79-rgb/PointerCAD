import { createAssemblyDocument, createEmptyPartDocument, resolveAssembly, resolvePart, EMPTY_PART_LIBRARY,
  DEFAULT_COMPONENT_PLACEMENT, IDENTITY_PLACEMENT, WORK_PLANES,
  type AssemblyComponent, type RigidPlacement } from '@pointercad/model';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from './dragComponentActions.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';

beforeEach(resetTestStore);

function placementFixture() {
  const components: AssemblyComponent[] = ['ground', 'a', 'b', 'unrelated'].map((id) => ({
    id, name: id, source: { kind: 'part', partRef: id }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: id === 'ground', visible: true, suppressed: false,
  }));
  const document = { ...createAssemblyDocument('drag'), components };
  const initial = new Map(components.map((component) => [component.id, IDENTITY_PLACEMENT]));
  const final = new Map<string, RigidPlacement>(initial);
  final.set('a', { ...IDENTITY_PLACEMENT, position: [1.2345678901234567, 0, 0] });
  final.set('b', { ...IDENTITY_PLACEMENT, position: [1.2345678901234567, 0, 0] });
  return { document, initial, final };
}

describe('P7-18 B03/B13/C03: 全成分の丸めない原子的placement', () => {
  it('連動した2個だけ書換え、固定/非対象/元文書を保つ', () => {
    const { document, initial, final } = placementFixture();
    const before = structuredClone(document);
    const next = actions.componentDragDocument(document, initial, final);
    expect(next).not.toBeNull();
    if (next === null) throw new Error('valid placement required');
    expect(next.components[1].placement.position[0].value).toBe(1.2345678901234567);
    expect(next.components[2].placement.position[0].source).toBe(exactExpressionValueFromNumber(1.2345678901234567).source);
    expect(next.components[0]).toBe(document.components[0]);
    expect(next.components[3]).toBe(document.components[3]);
    expect(next.components[1].source).toBe(document.components[1].source);
    expect(next.components[1].placement.position[1]).toBe(document.components[1].placement.position[1]);
    expect(document).toEqual(before);
  });
  it('無移動はdocumentの同一参照を返してUndoを作らない', () => {
    const { document, initial } = placementFixture();
    expect(actions.componentDragDocument(document, initial, initial)).toBe(document);
  });
  it('±0とq/−qだけの差を配置編集にしない', () => {
    const { document, initial } = placementFixture();
    const same = new Map(initial);
    same.set('a', { position: [-0, 0, 0], rotation: [-0, -0, -0, -1] });
    expect(actions.componentDragDocument(document, initial, same)).toBe(document);
  });
  it('微小な実移動を1e-9の切捨てで消さない', () => {
    const { document, initial, final } = placementFixture();
    final.set('a', { ...IDENTITY_PLACEMENT, position: [1e-12, 0, 0] });
    expect(actions.componentDragDocument(document, initial, final)?.components[1].placement.position[0].value).toBe(1e-12);
  });
  it.each([NaN, Infinity, -Infinity])('途中componentの不正値%sで部分文書を返さない', (bad) => {
    const { document, initial, final } = placementFixture();
    final.set('b', { ...IDENTITY_PLACEMENT, position: [bad, 0, 0] });
    expect(actions.componentDragDocument(document, initial, final)).toBeNull();
  });
  it('固定の移動や不足placementは書戻さない', () => {
    const { document, initial, final } = placementFixture();
    final.set('ground', { ...IDENTITY_PLACEMENT, position: [1, 0, 0] });
    expect(actions.componentDragDocument(document, initial, final)).toBeNull();
    final.set('ground', IDENTITY_PLACEMENT); final.delete('b');
    expect(actions.componentDragDocument(document, initial, final)).toBeNull();
  });
  it('退化quaternionを恒等回転に直して成功にしない', () => {
    const { document, initial, final } = placementFixture();
    final.set('b', { ...IDENTITY_PLACEMENT, rotation: [0, 0, 0, 0] });
    expect(actions.componentDragDocument(document, initial, final)).toBeNull();
  });
});

function storeFixture() {
  const { document } = placementFixture();
  const part = createEmptyPartDocument();
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map(document.components.map((c) => [c.id, part])) };
  const resolved = resolveAssembly(document, { library,
    resolvedParts: new Map(document.components.map((c) => [c.id, resolvePart(part)])) });
  useAppStore.getState().openAssembly(document, library);
  useAppStore.setState({ assemblyView: { sourceDocument: document, resolved, bodies: new Map(),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() }, isComputing: false, selectionKind: 'body' });
  return { document, initial: useAppStore.getState(), begin: () => actions.beginComponentDrag('a', WORK_PLANES.xy, [0, 0, 0]) };
}

describe('P7-18 B03/B04/B07/B10/B13/B14: 実dragと一時store', () => {
  it('moveは文書/Undo/再計算世代を変えずreleaseだけUndo1、Redo1', () => {
    const f = storeFixture();
    expect(f.begin()).toBe(true);
    const step = actions.moveComponentDrag([10, 20, 0]);
    expect(step?.hardSatisfied).toBe(true);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(f.initial.assemblyUndoStack);
    expect(useAppStore.getState().requestedGeneration).toBe(f.initial.requestedGeneration);
    expect(actions.finishComponentDrag([10, 20, 0])).toBe(true);
    const final = useAppStore.getState().assembly;
    expect(final?.components[1].placement.position[0].value).toBeCloseTo(10, 9);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.getState().undo(); expect(useAppStore.getState().assembly).toBe(f.document);
    useAppStore.getState().redo(); expect(useAppStore.getState().assembly).toBe(final);
  });

  it('overlayは文書・版・世代がすべて一致する間だけ表示へ渡す', () => {
    const f = storeFixture();
    expect(f.begin()).toBe(true);
    actions.moveComponentDrag([10, 0, 0]);
    const preview = useAppStore.getState();
    const overlay = preview.assemblyDragOverlay;
    expect(overlay).not.toBeNull();
    expect(actions.componentDragPlacements(preview)).toBe(overlay?.placements);
    useAppStore.setState({ requestedGeneration: preview.requestedGeneration + 1 });
    expect(actions.componentDragPlacements(useAppStore.getState())).toBe(preview.assemblyView?.resolved.placements);
  });
  it('clickだけは成功終了しても文書/履歴を作らない', () => {
    const f = storeFixture(); expect(f.begin()).toBe(true);
    expect(actions.finishComponentDrag([0, 0, 0])).toBe(true);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(f.initial.assemblyUndoStack);
  });
  it('取消は直前previewを文書にせずsession/overlayを破棄する', () => {
    const f = storeFixture(); expect(f.begin()).toBe(true);
    actions.moveComponentDrag([10, 0, 0]); actions.cancelComponentDrag();
    expect(useAppStore.getState().assemblyDrag).toBeNull();
    expect(useAppStore.getState().assemblyDragOverlay).toBeNull();
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(f.initial.assemblyUndoStack);
    expect(actions.finishComponentDrag([20, 0, 0])).toBe(false);
  });
  it.each(['undo', 'redo'] as const)('空履歴%sでもdragを破棄する', (operation) => {
    const f = storeFixture(); expect(f.begin()).toBe(true);
    useAppStore.getState()[operation]();
    expect(useAppStore.getState().assemblyDrag).toBeNull();
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(f.initial.assemblyUndoStack);
  });
  it.each(['close', 'open', 'newPart'] as const)('%s後に古いdragのreleaseを書き戻さない', (operation) => {
    const f = storeFixture(); expect(f.begin()).toBe(true);
    if (operation === 'close') useAppStore.getState().closeAssembly();
    else if (operation === 'open') useAppStore.getState().openAssembly(createAssemblyDocument('other'));
    else useAppStore.getState().resetDocument(createEmptyPartDocument());
    const before = useAppStore.getState();
    expect(actions.finishComponentDrag([10, 0, 0])).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });
  it('固定部品は準備前に日本語で拒否する', () => {
    const f = storeFixture();
    expect(actions.beginComponentDrag('ground', WORK_PLANES.xy, [0, 0, 0])).toBe(false);
    expect(useAppStore.getState().assemblyDragNotice).toBe('fixed');
    expect(useAppStore.getState().assembly).toBe(f.document);
  });
  it.each(['hidden', 'suppressed', 'computing', 'stale'] as const)('%sの開始を拒否する', (reason) => {
    const f = storeFixture();
    if (reason === 'computing') useAppStore.setState({ isComputing: true });
    else if (reason === 'stale') useAppStore.setState({ assembly: { ...f.document } });
    else {
      const document = { ...f.document, components: f.document.components.map((c) => c.id !== 'a' ? c
        : reason === 'hidden' ? { ...c, visible: false } : { ...c, suppressed: true }) };
      const view = useAppStore.getState().assemblyView;
      if (view === null) throw new Error('view');
      useAppStore.setState({ assembly: document, assemblyView: { ...view, sourceDocument: document } });
    }
    expect(f.begin()).toBe(false);
    expect(useAppStore.getState().assemblyDrag).toBeNull();
  });
  it.each(['time', 'iterations'] as const)('releaseの%s切れをhard成立だけで確定しない', (reason) => {
    const f = storeFixture(); expect(f.begin()).toBe(true);
    expect(actions.finishComponentDrag([10, 0, 0], reason === 'time' ? { maxTimeMs: 0, now: () => 0 } : { maxIterations: 0 })).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(f.initial.assemblyUndoStack);
    expect(useAppStore.getState().assemblyDrag).toBeNull();
  });
});
