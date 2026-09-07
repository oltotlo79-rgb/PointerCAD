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

  it('アセンブリを開いても部品の欄と履歴は 1 つも変わらない(振る舞いを変えない)', () => {
    const before = useAppStore.getState();
    const document = before.document;
    const undoStack = before.undoStack;
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));

    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
    expect(useAppStore.getState().documentVersion).toBe(before.documentVersion);
  });
});
