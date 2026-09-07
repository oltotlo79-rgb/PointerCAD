import {
  addComponent,
  createAssemblyDocument,
  createAssemblyDocumentBundle,
  createComponentFor,
  createEmptyPartDocument,
  createPartDocumentBundle,
  DEFAULT_APPEARANCE,
  EMPTY_PART_LIBRARY,
  embedPart,
  emptyEmbeddedPartAttachments,
  setFixed,
} from '@pointercad/model';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveAssembly } from '../file/assemblyFile.js';
import type { FileGateway } from '../file/fileGateway.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { PlaceComponentDeps } from './placeComponentActions.js';
import {
  cancelPlaceComponent,
  commitPlaceComponent,
  deleteSelectedComponents,
  duplicateSelectedComponent,
  startPlaceComponent,
  toggleSelectedFixed,
  toggleSelectedVisible,
  updatePlaceComponentSource,
} from './placeComponentActions.js';
import { placementFromSources } from './placeComponent.js';

const attachments = emptyEmbeddedPartAttachments();

function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settleValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { settleValue = resolve; });
  return { promise, settle: (value) => settleValue(value) };
}

function dependencies(part = createEmptyPartDocument()): PlaceComponentDeps {
  return {
    choose: () => Promise.resolve({ kind: 'pcad', fileName: '箱.pcad', bytes: new Uint8Array([1]) }),
    read: () => Promise.resolve({
      ok: true,
      bundle: createPartDocumentBundle(part, attachments),
      savedAt: '2026-09-07T00:00:00.000Z',
    }),
    embed: (library, document, fileName, path, options) =>
      embedPart(library, document, fileName, path, options),
  };
}

function openEmptyAssembly(): void {
  useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
}

async function ready(deps = dependencies()): Promise<PlaceComponentDeps> {
  await startPlaceComponent(deps);
  expect(useAppStore.getState().assemblyPlacement?.kind).toBe('ready');
  return deps;
}

function enterSources(sources: readonly [string, string, string]): void {
  for (const index of [0, 1, 2] as const) updatePlaceComponentSource(index, sources[index]);
}

beforeEach(resetTestStore);

describe('部品配置の非同期入口', () => {
  it('XYZ式はストアで更新し、新しい要求・取消・確定・文書切替・Undoで破棄する', async () => {
    openEmptyAssembly();
    const deps = await ready();
    enterSources(['10*2', '3', '-4']);
    expect(useAppStore.getState().assemblyPlacement).toMatchObject({
      kind: 'ready', sources: ['10*2', '3', '-4'],
    });
    await ready(deps);
    expect(useAppStore.getState().assemblyPlacement).toMatchObject({
      kind: 'ready', sources: ['', '', ''],
    });
    enterSources(['1', '2', '3']);
    cancelPlaceComponent();
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    await ready(deps);
    enterSources(['4', '5', '6']);
    await commitPlaceComponent(deps);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();

    await ready(deps);
    enterSources(['7', '8', '9']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assemblyPlacement).toBeNull();

    await ready(deps);
    enterSources(['10', '11', '12']);
    useAppStore.getState().openAssembly(createAssemblyDocument('別の組立'));
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });

  it('ファイル選択の取消で文書・ライブラリ・履歴・保存先を変えない', async () => {
    openEmptyAssembly();
    let cleared = 0;
    const gateway = {
      ...useAppStore.getState().fileGateway,
      hasSaveTarget: () => true,
      clearSaveTarget: () => { cleared += 1; },
    };
    useAppStore.setState({ fileGateway: gateway });
    useAppStore.getState().setAssemblyFileState('現在.pcada', null);
    const before = useAppStore.getState();
    await startPlaceComponent({ ...dependencies(), choose: () => Promise.resolve(null) });
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyFileName).toBe('現在.pcada');
    expect(after.fileGateway).toBe(gateway);
    expect(after.fileGateway.hasSaveTarget()).toBe(true);
    expect(cleared).toBe(0);
    expect(after.assemblyPlacement).toBeNull();
  });

  it('原点配置をapplyAssembly 1回ぶんのUndo段へ確定する', async () => {
    openEmptyAssembly();
    const deps = await ready();
    await commitPlaceComponent(deps);
    const state = useAppStore.getState();
    expect(state.assembly?.components).toHaveLength(1);
    expect(state.assembly?.components[0].fixed).toBe(true);
    expect(state.assembly?.components[0].placement.rotation).toEqual([0, 0, 0, 1]);
    expect(state.assemblyUndoStack?.past).toHaveLength(1);
    state.undo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
    expect(useAppStore.getState().assemblyLibrary.partFiles).toHaveLength(0);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    expect(useAppStore.getState().assemblyLibrary.partFiles).toHaveLength(1);
  });

  it('式配置の文字列と20mmをUndo/Redo・保存往復後も保つ', async () => {
    openEmptyAssembly();
    const deps = await ready();
    enterSources(['10*2', '', '']);
    await commitPlaceComponent(deps);
    expect(useAppStore.getState().assembly?.components[0].placement.position[0]).toMatchObject({
      source: '10*2', value: 20,
    });
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components[0].placement.position[0].source).toBe('10*2');
    const current = useAppStore.getState();
    if (current.assembly === null) throw new Error('アセンブリがありません。');
    const bytes = await writeDocumentBundle(
      createAssemblyDocumentBundle(current.assembly, current.assemblyLibrary),
    );
    const restored = await readDocumentBundle(bytes, 'assembly');
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.bundle.kind !== 'assembly') return;
    expect(restored.bundle.document.components[0].placement.position[0]).toMatchObject({
      source: '10*2', value: 20,
    });
  });

  it('同じ部品を2回置いても抱き込みは1件で添付を保つ', async () => {
    openEmptyAssembly();
    const shape = new Uint8Array([7, 8, 9]);
    const withAttachment = {
      shapes: new Map([['shape-1', shape]]), meshes: new Map(), canvases: new Map(),
    };
    const deps: PlaceComponentDeps = { ...dependencies(), read: () => Promise.resolve({
      ok: true,
      bundle: createPartDocumentBundle(createEmptyPartDocument(), withAttachment),
      savedAt: '2026-09-07T00:00:00.000Z',
    }) };
    await ready(deps);
    await commitPlaceComponent(deps);
    await ready(deps);
    enterSources(['1', '', '']);
    await commitPlaceComponent(deps);
    const state = useAppStore.getState();
    expect(state.assembly?.components).toHaveLength(2);
    expect(state.assemblyLibrary.partFiles).toHaveLength(1);
    expect(state.assemblyLibrary.attachments.get('part-1')?.shapes.get('shape-1')).toBe(shape);
  });

  it('不正入力で文書・ライブラリ・履歴を変えない', async () => {
    openEmptyAssembly();
    const deps = await ready();
    enterSources(['1/', '', '']);
    const before = useAppStore.getState();
    const result = await commitPlaceComponent(deps);
    const after = useAppStore.getState();
    expect(result?.ok).toBe(false);
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyPlacement?.kind).toBe('ready');
  });

  it('読込失敗で文書・ライブラリ・履歴を変えない', async () => {
    openEmptyAssembly();
    const before = useAppStore.getState();
    const deps: PlaceComponentDeps = {
      ...dependencies(), read: () => Promise.reject(new Error('broken')),
    };
    await startPlaceComponent(deps);
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.fileMessage?.failed).toBe(true);
  });

  it('取消後に届いた古いファイル選択結果を適用しない', async () => {
    openEmptyAssembly();
    const delayed = deferred<{ kind: 'pcad'; fileName: string; bytes: Uint8Array }>();
    const deps: PlaceComponentDeps = {
      ...dependencies(), choose: () => delayed.promise,
    };
    const operation = startPlaceComponent(deps);
    cancelPlaceComponent();
    delayed.settle({ kind: 'pcad', fileName: '遅い.pcad', bytes: new Uint8Array([1]) });
    await operation;
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });

  it('文書切替後に届いた古いファイル選択結果を適用しない', async () => {
    openEmptyAssembly();
    const delayed = deferred<{ kind: 'pcad'; fileName: string; bytes: Uint8Array }>();
    const deps: PlaceComponentDeps = {
      ...dependencies(), choose: () => delayed.promise,
    };
    const operation = startPlaceComponent(deps);
    useAppStore.getState().openAssembly(createAssemblyDocument('別の組立'));
    delayed.settle({ kind: 'pcad', fileName: '遅い.pcad', bytes: new Uint8Array([1]) });
    await operation;
    expect(useAppStore.getState().assembly?.name).toBe('別の組立');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });

  async function verifySaveTargetAfterOpenFile(
    openFile: NonNullable<FileGateway['openFile']>,
    place: boolean,
  ): Promise<void> {
    openEmptyAssembly();
    let targetIdentity: string | null = 'assembly-save-target-1';
    const reachedTargets: (string | null)[] = [];
    let cleared = 0;
    const gateway: FileGateway = {
      ...useAppStore.getState().fileGateway,
      openFile,
      hasSaveTarget: () => targetIdentity !== null,
      clearSaveTarget: () => {
        cleared += 1;
        targetIdentity = null;
      },
      savePcad: (name) => {
        reachedTargets.push(targetIdentity);
        return Promise.resolve(name);
      },
    };
    useAppStore.setState({ fileGateway: gateway });
    await startPlaceComponent();
    if (place) await commitPlaceComponent();
    await saveAssembly({ captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true) }, false);
    expect(useAppStore.getState().fileGateway).toBe(gateway);
    expect(reachedTargets).toEqual(['assembly-save-target-1']);
    expect(targetIdentity).toBe('assembly-save-target-1');
    expect(cleared).toBe(0);
  }

  it('本番openFileThroughの成功後も同じアセンブリ保存先へ保存する', async () => {
    const bytes = await writeDocumentBundle(createPartDocumentBundle(createEmptyPartDocument(), attachments));
    const requested: (readonly string[])[] = [];
    await verifySaveTargetAfterOpenFile((kinds) => {
      requested.push(kinds);
      return Promise.resolve({ kind: 'pcad', fileName: '箱.pcad', bytes });
    }, true);
    expect(requested).toEqual([['pcad']]);
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
  });

  it('本番openFileThroughの取消後も同じアセンブリ保存先へ保存する', async () => {
    await verifySaveTargetAfterOpenFile(() => Promise.resolve(null), false);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });

  it('本番openFileThroughの失敗後も同じアセンブリ保存先へ保存する', async () => {
    await verifySaveTargetAfterOpenFile(() => Promise.reject(new Error('picker failed')), false);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
});

describe('選択部品の操作', () => {
  function openWithComponent(): string {
    let assembly = createAssemblyDocument('組立');
    const component = createComponentFor(assembly, { kind: 'part', partRef: 'part-1' });
    assembly = addComponent(assembly, component);
    useAppStore.getState().openAssembly(assembly);
    useAppStore.getState().setSelection([component.id]);
    return component.id;
  }

  it('複製をUndo/Redo 1回で往復する', () => {
    openWithComponent();
    duplicateSelectedComponent();
    expect(useAppStore.getState().assembly?.components).toHaveLength(2);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(2);
  });

  it('複製した外観と材質を保存往復後も保つ', async () => {
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      { ...createEmptyPartDocument(), name: '保存する部品' },
      '保存する部品.pcad',
      '',
      { attachments },
    );
    let assembly = createAssemblyDocument('組立');
    const placement = placementFromSources(assembly, ['10*2', '3', '-4']);
    if (!placement.ok) throw new Error('検査用の配置式を評価できません。');
    const component = {
      ...createComponentFor(
        assembly,
        { kind: 'part', partRef: embedded.partRef },
        { partName: '保存する部品', placement: placement.placement },
      ),
      appearance: { ...DEFAULT_APPEARANCE, color: '#112233' },
      materialId: 'steel',
    };
    assembly = addComponent(assembly, component);
    useAppStore.getState().openAssembly(assembly, embedded.library);
    useAppStore.getState().setSelection([component.id]);
    duplicateSelectedComponent();
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('アセンブリがありません。');
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary));
    const restored = await readDocumentBundle(bytes, 'assembly');
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.bundle.kind !== 'assembly') return;
    expect(restored.bundle.document.components[1]).toMatchObject({
      source: component.source,
      placement: component.placement,
      materialId: 'steel', appearance: { color: '#112233' },
    });
  });

  it('削除をUndo/Redo 1回で往復する', () => {
    const id = openWithComponent();
    useAppStore.getState().setHovered(id);
    deleteSelectedComponents();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
    expect(useAppStore.getState().selection).toEqual([]);
    expect(useAppStore.getState().hoveredElementId).toBeNull();
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });

  it('固定切替をUndo/Redo 1回で往復する', () => {
    const id = openWithComponent();
    toggleSelectedFixed();
    expect(useAppStore.getState().assembly?.components[0].fixed).toBe(false);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components[0].fixed).toBe(true);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components[0].fixed).toBe(false);
    expect(id).toBe('component-1');
  });

  it('表示切替をUndo/Redo 1回で往復する', () => {
    openWithComponent();
    toggleSelectedVisible();
    expect(useAppStore.getState().assembly?.components[0].visible).toBe(false);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components[0].visible).toBe(true);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.components[0].visible).toBe(false);
  });

  it('別編集後に届いた古い抱き込み結果を適用しない', async () => {
    const id = openWithComponent();
    const base = await ready();
    const delayed = deferred<Awaited<ReturnType<typeof embedPart>>>();
    const deps: PlaceComponentDeps = {
      ...base, embed: () => delayed.promise,
    };
    const operation = commitPlaceComponent(deps);
    const state = useAppStore.getState();
    state.applyAssembly(setFixed(state.assembly!, id, false));
    const embedded = await embedPart(state.assemblyLibrary, createEmptyPartDocument(), '箱.pcad', '', { attachments });
    delayed.settle(embedded);
    await operation;
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    expect(useAppStore.getState().assembly?.components[0].fixed).toBe(false);
  });
});
