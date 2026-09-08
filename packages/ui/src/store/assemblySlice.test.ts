/** 文書の種類。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  createAssemblyDocument,
  createEmptyPartDocument,
} from '@pointercad/model';
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
