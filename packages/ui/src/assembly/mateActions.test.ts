import { addComponent, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, resolveAssembly, resolvePart, type AssemblyDocument } from '@pointercad/model';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MatePopover } from './MatePopover.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { addMateTarget, cancelMate, commitMateDraft, deleteAssemblyMate, editAssemblyMate,
  flipAssemblyMate, handleMateKey, jointDraftCheck, mateDraftCheck, mateFailureText, mateKindReadiness,
  removeDraftTarget, startJoint, startMate, toggleDraftFlipped, updateJointRangeSource, updateMateSource } from './mateActions.js';
import { startAssemblyPartPlacement } from '../shell/menus/AssemblyGroup.js';

function openAssembly(): AssemblyDocument {
  let document = createAssemblyDocument('組立');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  useAppStore.getState().openAssembly(document, { ...EMPTY_PART_LIBRARY,
    parts: new Map([['a', createEmptyPartDocument()], ['b', createEmptyPartDocument()]]) });
  return document;
}

function publishView(): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const resolvedParts = new Map([...state.assemblyLibrary.parts].map(([key, part]) => [key, resolvePart(part)]));
  const resolved = resolveAssembly(state.assembly, { library: state.assemblyLibrary, resolvedParts });
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: state.assembly, resolved,
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
}
let detachView = (): void => undefined;
beforeEach(() => {
  resetTestStore();
  detachView = useAppStore.subscribe((next, previous) => { if (next.assembly !== previous.assembly) publishView(); });
});
afterEach(() => { detachView(); });

describe('合致の共通action', () => {
  const popover = () => {
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try { return renderToStaticMarkup(createElement(MatePopover)); } finally { snapshot.mockRestore(); }
  };

  it('面2つのpopoverにoffset欄があり、式を確定・保存・再読込しても配置を書き戻さない', async () => {
    const document = openAssembly();
    for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'xy' });
    updateMateSource('-10*2');
    const markup = popover();
    expect(markup).toContain(t('assembly.mate.offset'));
    expect(markup).toContain('value="-10*2"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('right:12px');
    expect(markup).not.toContain('left:12px');
    expect(markup).toContain('pcad-popover__actions--mate-targets');
    handleMateKey('Enter');
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('fixture');
    expect(state.assembly.components).toEqual(document.components);
    const restored = await readDocumentBundle(await writeDocumentBundle(createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary)), 'assembly');
    if (!restored.ok || restored.bundle.kind !== 'assembly') throw new Error('fixture');
    expect(restored.bundle.document.mates[0].value).toMatchObject({ source: '-10*2', value: -20 });
    expect(restored.bundle.document.components).toEqual(document.components);
  });

  it.each([['distance', '-1'], ['distance', 'unknown'], ['distance', '1/0'], ['angle', '0'], ['angle', '1'], ['angle', '179'], ['angle', '180']] as const)(
    '%sの%sは入力中の実popoverに理由と確定不可が出て、修正すると消える', (kind, source) => {
      openAssembly(); startMate(kind);
      for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: kind === 'angle' ? 'x' : 'origin' });
      updateMateSource(source);
      const markup = popover();
      expect(markup).toContain('aria-invalid="true"');
      expect(markup).toContain('role="status"');
      expect(markup).toMatch(/pcad-button--action" aria-disabled="true"/);
      expect(useAppStore.getState().assembly?.mates).toHaveLength(0);
      updateMateSource('10');
      expect(popover()).toContain('aria-invalid="false"');
      expect(popover()).toMatch(/pcad-button--action" aria-disabled="false"/);
    });

  it('値の範囲理由と既定名はリソースの文を使う', () => {
    openAssembly(); startMate('distance');
    for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'origin' });
    updateMateSource('-1');
    expect(mateFailureText(mateDraftCheck(useAppStore.getState()))).toBe(t('assembly.mate.negativeDistance'));
    updateMateSource('1'); commitMateDraft();
    expect(useAppStore.getState().assembly?.mates[0].name).toBe(t('assembly.mate.defaultName').replace('{count}', '1'));
    startMate('angle');
    for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'x' });
    updateMateSource('180');
    expect(mateFailureText(mateDraftCheck(useAppStore.getState()))).toBe(t('assembly.mate.angleRange'));
  });
  it('開始・値・反転・取消をZustandの同じdraftで管理する', () => {
    openAssembly();
    startMate('distance');
    updateMateSource('10*2');
    toggleDraftFlipped();
    expect(useAppStore.getState().assemblyMateDraft).toMatchObject({ kind: 'distance', source: '10*2', flipped: true });
    cancelMate();
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
  });

  it('合致popoverはビューポートcanvasより上の入力層に固定する', () => {
    const css = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(css).toMatch(/\.pcad-viewport\s*\{[^}]*isolation:\s*isolate;/u);
    expect(css).toMatch(/\.pcad-viewport__canvas\s*\{[^}]*z-index:\s*0;/u);
    expect(css).toMatch(/\.pcad-popover\s*\{[^}]*z-index:\s*2;/u);
    expect(css).toMatch(/\.pcad-popover__actions--mate-targets\s*\{[^}]*flex-wrap:\s*wrap;/u);
  });

  it('ジョイントの範囲式をpopoverで編集し、Undo 1段で保存する', () => {
    openAssembly(); startJoint('revolute');
    for (const componentId of ['component-1', 'component-2']) {
      addMateTarget({ kind: 'origin', componentId, element: 'z' });
    }
    updateJointRangeSource('min', '10*3');
    updateJointRangeSource('max', '60*2');
    const markup = popover();
    expect(markup).toContain(t('assembly.joint.rangeMinimum'));
    expect(markup).toContain(t('assembly.joint.rangeMaximum'));
    expect(markup).toContain('value="10*3"');
    expect(markup).toContain('value="60*2"');
    expect(markup).toMatch(/pcad-button--action" aria-disabled="false"/);
    handleMateKey('Enter');
    expect(useAppStore.getState().assembly?.joints[0]).toMatchObject({
      kind: 'revolute', minValue: { source: '10*3', value: 30 }, maxValue: { source: '60*2', value: 120 },
    });
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it.each([['unknown', '120'], ['120', '30']])(
    '不正なジョイント範囲 %s〜%s はpopoverに理由を出して確定しない', (min, max) => {
      openAssembly(); startJoint('revolute');
      for (const componentId of ['component-1', 'component-2']) {
        addMateTarget({ kind: 'origin', componentId, element: 'z' });
      }
      updateJointRangeSource('min', min); updateJointRangeSource('max', max);
      expect(jointDraftCheck(useAppStore.getState(), 'revolute')).toMatchObject({ ok: false, reason: 'range' });
      expect(popover()).toContain('role="status"');
      expect(popover()).toMatch(/pcad-button--action" aria-disabled="true"/);
      handleMateKey('Enter');
      expect(useAppStore.getState().assembly?.joints).toHaveLength(0);
    });

  it('別部品の2対象を追加し確定はUndoを1段だけ積む', () => {
    openAssembly();
    startMate('coincident');
    expect(addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' })).toBe(true);
    expect(addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' })).toBe(true);
    expect(commitMateDraft()).toMatchObject({ ok: true });
    expect(useAppStore.getState().assembly?.mates).toHaveLength(1);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mates).toHaveLength(0);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.mates).toHaveLength(1);
  });

  it('同一部品と3対象目を拒否する', () => {
    openAssembly();
    startMate('coincident');
    expect(addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' })).toBe(true);
    expect(addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'x' })).toBe(false);
    expect(addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' })).toBe(true);
    expect(addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'y' })).toBe(false);
  });

  it('古い文書のdraftは対象追加も確定もしない', () => {
    openAssembly();
    startMate('coincident');
    useAppStore.setState({ activeDocumentId: 'new-document' });
    expect(addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' })).toBe(false);
    expect(commitMateDraft()).toBeNull();
    expect(useAppStore.getState().assembly?.mates).toHaveLength(0);
  });

  it('不正式は文書・履歴・libraryを変えずdraftを残す', () => {
    openAssembly();
    startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    updateMateSource('-3');
    const before = useAppStore.getState();
    expect(commitMateDraft()).toMatchObject({ ok: false, reason: 'value' });
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
    expect(after.assemblyMateDraft).not.toBeNull();
  });

  it('編集・反転・削除は各Undo 1段で完全に戻る', () => {
    openAssembly();
    startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    updateMateSource('5');
    commitMateDraft();
    editAssemblyMate('mate-1');
    updateMateSource('10*2');
    commitMateDraft();
    expect(useAppStore.getState().assembly?.mates[0].value).toMatchObject({ source: '10*2', value: 20 });
    flipAssemblyMate('mate-1');
    expect(useAppStore.getState().assembly?.mates[0].flipped).toBe(true);
    deleteAssemblyMate('mate-1');
    expect(useAppStore.getState().assembly?.mates).toHaveLength(0);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mates[0].flipped).toBe(true);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mates[0].flipped).toBe(false);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mates[0].value?.value).toBe(5);
  });

  it('距離式と対象をpcada保存・再読込後も完全に保つ', async () => {
    const first = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', '');
    const second = await embedPart(first.library, createEmptyPartDocument(), 'b.pcad', '');
    let document = createAssemblyDocument('組立');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: first.partRef }, { partName: 'A' }));
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: second.partRef }, { partName: 'B' }));
    useAppStore.getState().openAssembly(document, second.library);
    startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    updateMateSource('10*2');
    commitMateDraft();
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('fixture');
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary));
    const restored = await readDocumentBundle(bytes, 'assembly');
    if (!restored.ok) throw new Error(`${restored.error.code}: ${restored.error.message}`);
    if (restored.bundle.kind !== 'assembly') throw new Error('assemblyではありません。');
    expect(restored.bundle.document.mates[0]).toMatchObject({
      kind: 'distance', value: { source: '10*2', value: 20 },
      a: { componentId: 'component-1' }, b: { componentId: 'component-2' },
    });
  });

  it.each(['undo', 'redo', 'open', 'close'] as const)('%sでdraftを破棄する', (operation) => {
    openAssembly();
    startMate('coincident');
    if (operation === 'undo' || operation === 'redo') {
      useAppStore.getState()[operation]();
    } else if (operation === 'open') {
      useAppStore.getState().openAssembly(createAssemblyDocument('別'));
    } else {
      useAppStore.getState().closeAssembly();
    }
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
  });

  it('対象先行と種類先行で同じmateを1段だけ確定する', () => {
    const make = (first: boolean) => {
      openAssembly();
      if (first) startMate('coincident');
      addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'xy' });
      addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'xy' });
      const draft = useAppStore.getState().assemblyMateDraft;
      expect(draft?.flipped).toBe(true);
      expect(handleMateKey('Enter')).toBe(true);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
      return useAppStore.getState().assembly?.mates[0];
    };
    expect(make(false)).toEqual(make(true));
  });

  it('対象を保持したまま種類とoffset式を変え、Undo/Redoで保存式を復元する', () => {
    openAssembly();
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'xy' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'xy' });
    const targets = useAppStore.getState().assemblyMateDraft?.targets;
    startMate('distance');
    expect(useAppStore.getState().assemblyMateDraft?.targets).toEqual(targets);
    startMate('coincident'); updateMateSource('-10*2');
    expect(mateDraftCheck(useAppStore.getState())).toMatchObject({ ok: true, mate: { value: { source: '-10*2', value: -20 } } });
    handleMateKey('Enter');
    useAppStore.getState().undo(); useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.mates[0].value?.source).toBe('-10*2');
  });

  it('未定義式は確定前から理由が出て、IME Enterは処理しない', () => {
    openAssembly(); startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    updateMateSource('unknown');
    expect(mateDraftCheck(useAppStore.getState())?.ok).toBe(false);
    expect(mateFailureText(mateDraftCheck(useAppStore.getState()))).not.toBeNull();
    expect(handleMateKey('Enter', true)).toBe(false);
    expect(useAppStore.getState().assembly?.mates).toHaveLength(0);
    updateMateSource('10*2');
    expect(mateDraftCheck(useAppStore.getState())?.ok).toBe(true);
  });

  it.each(['suppressed', 'missing', 'busy', 'oldView'] as const)('%sの対象で確定を拒否し履歴・文書を変えない', (change) => {
    openAssembly(); startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('fixture');
    if (change === 'busy') useAppStore.setState({ isComputing: true });
    else if (change === 'oldView') {
      const view = state.assemblyView;
      if (view === null) throw new Error('fixture');
      useAppStore.setState({ assemblyView: { ...view, sourceDocument: createAssemblyDocument('old') } });
    } else useAppStore.setState({ assembly: { ...state.assembly, components: change === 'missing' ? state.assembly.components.slice(0, 1)
      : state.assembly.components.map((component, index) => index === 1 ? { ...component, suppressed: true } : component) } });
    const before = useAppStore.getState();
    expect(commitMateDraft()).toMatchObject({ ok: false, reason: 'stale' });
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('対象3個は種類/確定とも不可で、1個外せば選び直せる', () => {
    const document = openAssembly();
    useAppStore.getState().applyAssembly(addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' })));
    for (const componentId of ['component-1', 'component-2', 'component-3']) addMateTarget({ kind: 'origin', componentId, element: 'origin' });
    expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(3);
    expect(mateKindReadiness(useAppStore.getState(), 'coincident').ready).toBe(false);
    expect(commitMateDraft()?.ok).toBe(false);
    removeDraftTarget(2);
    expect(mateKindReadiness(useAppStore.getState(), 'coincident').ready).toBe(true);
    expect(commitMateDraft()?.ok).toBe(true);
  });

  it('部品配置のファイル選択を始める前にdraftを消し、配置中のmate編集を拒否する', async () => {
    openAssembly(); startMate('distance');
    addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' });
    addMateTarget({ kind: 'origin', componentId: 'component-2', element: 'origin' });
    commitMateDraft(); editAssemblyMate('mate-1');
    await startAssemblyPartPlacement({ read: (bytes) => readDocumentBundle(bytes, 'part'), embed: embedPart, choose: () => {
      expect(useAppStore.getState().assemblyMateDraft).toBeNull();
      editAssemblyMate('mate-1'); expect(useAppStore.getState().assemblyMateDraft).toBeNull();
      return Promise.resolve(null);
    } });
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
});
