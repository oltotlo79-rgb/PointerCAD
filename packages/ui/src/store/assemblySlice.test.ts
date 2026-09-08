/** 文書の種類。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  addComponent,
  createAssemblyDocument,
  createComponentFor,
  createEmptyPartDocument,
  resolveAssembly,
  type JointFrame,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  activeDocumentKind,
  activePartDocument,
} from './documentKind.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
} from './testing/createTestStore.js';
import { createMateDraft } from '../assembly/mateCommands.js';

beforeEach(resetTestStore);

describe('文書の種類の切替(P7 §0.a-0.10、タスク5)', () => {
  it('起動直後はアセンブリを開いていない(部品の画面)', () => {
    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
  });

  it('アセンブリを開くと種類が変わり、部品は読めなくなる(同時に 2 つ開かない)', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);

    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(activeDocumentKind(useAppStore.getState())).toBe('assembly');
    expect(activePartDocument(useAppStore.getState())).toBeNull();
  });

  it('閉じると部品の画面へ戻る', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    useAppStore.getState().closeAssembly();

    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
    expect(activePartDocument(useAppStore.getState())).toBe(useAppStore.getState().document);
  });

  it('新しい部品を作ると、開いていたアセンブリは閉じる', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    useAppStore.getState().resetDocument(createEmptyPartDocument());

    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
  });

  it('アセンブリを開いても部品の欄と履歴は保ち、文書の寿命は進める', () => {
    const before = useAppStore.getState();
    const document = before.document;
    const undoStack = before.undoStack;
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));

    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
    expect(useAppStore.getState().documentVersion).toBe(before.documentVersion + 1);
  });
});

describe('配置中の一時状態(P7 タスク11b)', () => {
  it.each(['undo', 'redo'] as const)('空履歴の%sはdraftを破棄し、履歴・版・再計算世代を増やさない', (operation) => {
    const document = createAssemblyDocument('組立');
    useAppStore.getState().openAssembly(document);
    const before = useAppStore.getState();
    useAppStore.setState({ assemblyMateDraft: createMateDraft(before.activeDocumentId, 'coincident') });
    useAppStore.getState()[operation]();
    const after = useAppStore.getState();
    expect(after.assemblyMateDraft).toBeNull();
    expect(after.assembly).toBe(document);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.requestedGeneration).toBe(before.requestedGeneration);
    expect(after.assemblyView).toBe(before.assemblyView);
  });

  it('表示専用overlayをUndo snapshotへ入れず、通常編集では残さない', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);
    const state = useAppStore.getState();
    useAppStore.setState({
      assemblyDragOverlay: {
        document: assembly,
        library: state.assemblyLibrary,
        documentId: state.activeDocumentId,
        version: state.documentVersion,
        generation: state.requestedGeneration,
        placements: new Map(),
        validatedIds: [],
      },
      assemblyDragNotice: 'dragging',
    });
    useAppStore.getState().applyAssembly({ ...assembly, name: '変更後' });
    const edited = useAppStore.getState();
    expect(edited.assemblyDragOverlay).toBeNull();
    expect(edited.assemblyDragNotice).toBeNull();
    expect(Object.keys(edited.assemblyUndoStack?.present ?? {}).sort()).toEqual(['document', 'library']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(useAppStore.getState().assemblyDragOverlay).toBeNull();
  });

  it('確定編集は配置状態を消し、Undoを1段だけ積む', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);
    const documentId = useAppStore.getState().activeDocumentId;
    useAppStore.setState({
      assemblyPlacement: { kind: 'choosing', requestId: 'request-1', documentId },
    });

    useAppStore.getState().applyAssembly({ ...assembly, name: '変更後' });

    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it('別文書を開くと配置状態を消し、文書IDを更新する', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    const documentId = useAppStore.getState().activeDocumentId;
    useAppStore.setState({
      assemblyPlacement: { kind: 'choosing', requestId: 'request-1', documentId },
    });

    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て2'));

    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().activeDocumentId).not.toBe(documentId);
  });
});

describe('P7-22/35 表示専用の動きと分解履歴', () => {
  const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  function withComponents() {
    let document = createAssemblyDocument('組立');
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'a' }, { partName: 'A' }));
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'b' }, { partName: 'B' }));
    return document;
  }

  it('2部品の分解を1回で確定し、Undo 1回でステップを消す', () => {
    const document = withComponents();
    useAppStore.getState().openAssembly(document);
    useAppStore.setState({ selection: document.components.map((component) => component.id) });
    expect(useAppStore.getState().beginAssemblyExplode()).toBe(true);
    expect(useAppStore.getState().commitAssemblyExplode('12*2', '分解1', { kind: 'world', axis: 'y' })).toBe(true);
    const committed = useAppStore.getState();
    expect(committed.assembly?.presentation).toHaveLength(1);
    expect(committed.assembly?.presentation[0].body).toMatchObject({ kind: 'explode',
      componentIds: document.components.map((component) => component.id),
      direction: { kind: 'world', axis: 'y' }, distance: { source: '12*2', value: 24 } });
    expect(committed.assemblyUndoStack?.past).toHaveLength(1);
    committed.undo();
    expect(useAppStore.getState().assembly?.presentation).toEqual([]);
  });

  it('時間軸は表示配置だけを変え、文書とUndo履歴を変更しない', () => {
    const initial = withComponents();
    useAppStore.getState().openAssembly(initial);
    useAppStore.setState({ selection: [initial.components[0].id] });
    useAppStore.getState().beginAssemblyExplode();
    useAppStore.getState().commitAssemblyExplode('50', '分解1');
    const document = useAppStore.getState().assembly;
    if (document === null) throw new Error('fixture');
    const resolved = resolveAssembly(document);
    useAppStore.setState({ assemblyView: { sourceDocument: document, resolved,
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().setAssemblyMotionTime(1)).toBe(true);
    expect(useAppStore.getState().assembly).toBe(document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(stack);
    expect(useAppStore.getState().assemblyMotionPlacements?.get(document.components[0].id)?.position[2]).toBe(50);
  });

  it('確定編集で再生・一時配置・分解draftを必ず破棄する', () => {
    const document = withComponents();
    useAppStore.getState().openAssembly(document);
    useAppStore.setState({ selection: [document.components[0].id] });
    useAppStore.getState().beginAssemblyExplode();
    useAppStore.setState({ assemblyMotionPlaying: true, assemblyMotionTime: 0.5,
      assemblyMotionPlacements: new Map(), assemblyMotionSourceDocument: document });
    useAppStore.getState().applyAssembly({ ...document, name: '変更後' });
    const state = useAppStore.getState();
    expect(state.assemblyMotionPlaying).toBe(false);
    expect(state.assemblyMotionTime).toBe(0);
    expect(state.assemblyMotionPlacements).toBeNull();
    expect(state.assemblyMotionSourceDocument).toBeNull();
    expect(state.assemblyExplodeDraft).toBeNull();
  });

  it('別文書を開いても前文書の表示配置を持ち越さない', () => {
    const first = withComponents();
    useAppStore.getState().openAssembly(first);
    useAppStore.setState({ assemblyMotionPlaying: true, assemblyMotionTime: 1,
      assemblyMotionPlacements: new Map(), assemblyMotionSourceDocument: first });
    useAppStore.getState().openAssembly(createAssemblyDocument('次'));
    const state = useAppStore.getState();
    expect(state.assemblyMotionPlaying).toBe(false);
    expect(state.assemblyMotionPlacements).toBeNull();
    expect(state.assemblyMotionSourceDocument).toBeNull();
  });

  it('解決結果が届く前は再生を開始しない', () => {
    const initial = withComponents();
    const document = { ...initial, presentation: [{ id: 'step-1', name: '分解1', start: 0, end: 1,
      body: { kind: 'explode' as const, componentIds: [initial.components[0].id],
        direction: { kind: 'world' as const, axis: 'z' as const }, distance: expressionValueFromNumber(10) } }] };
    useAppStore.getState().openAssembly(document);
    useAppStore.getState().setAssemblyMotionPlaying(true);
    expect(useAppStore.getState().assemblyMotionPlaying).toBe(false);
  });

  it('ジョイントの範囲外入力を端へ丸め、表示配置だけを更新する', () => {
    const initial = withComponents();
    const [a, b] = initial.components;
    const document = { ...initial,
      components: [{ ...a, fixed: false }, { ...b, fixed: true }],
      joints: [{ id: 'joint-1', name: '移動1', kind: 'slider' as const,
        a: { kind: 'origin' as const, componentId: a.id, element: 'z' as const },
        b: { kind: 'origin' as const, componentId: b.id, element: 'z' as const },
        minValue: expressionValueFromNumber(-5), maxValue: expressionValueFromNumber(10), suppressed: false }] };
    useAppStore.getState().openAssembly(document);
    const resolved = resolveAssembly(document);
    useAppStore.setState({ assemblyView: { sourceDocument: document, resolved,
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      mateTargets: new Map(), jointFrames: new Map([['joint-1', { a: FRAME, b: FRAME }]]) } });
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'translation', 20)).toBe(true);
    const state = useAppStore.getState();
    expect(state.assemblyMotionJointValues.get('joint-1\u0000translation')).toBeCloseTo(10, 8);
    expect(state.assemblyMotionNotice).toMatchObject({ kind: 'rangeEnd', min: -5, max: 10, value: 10 });
    expect(state.assembly).toBe(document);
    expect(state.assemblyUndoStack).toBe(stack);
  });
});
