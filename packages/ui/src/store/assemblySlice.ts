/**
 * アセンブリのスライス(P7 §0.10、計画書タスク5)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 *
 * **1 つの窓で開く文書は 1 つだけ**(§0.a-0.10)。ここが `null` でないあいだは
 * アセンブリを開いていることになり、部品の読み出しの口(`documentKind.ts` の
 * `activePartDocument`)は `null` を返す。種類による分岐は**すべて `documentKind.ts`**
 * にあり、このスライスは文書・部品ライブラリとその履歴を持つ。
 *
 * 描画用の解決結果は assemblyView に置き、保存と Undo には含めない。
 * 共通の文書操作は documentSlice が所有し、ここへは get() 経由で委譲する。
 */

import {
  createUndoStack, EMPTY_PART_LIBRARY, pushUndo, redo, undo,
  type AssemblyDocument, type PartLibrary, type ResolvedAssembly, type SolidBody, type UndoStack,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AutoSaveRecord } from '@pointercad/io';
import type { AppState, DocumentStateUpdate } from './appState.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';

export interface AssemblySnapshot {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
}

export interface AssemblyView {
  readonly resolved: ResolvedAssembly;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly appearances: ReadonlyMap<string, AppearanceInput>;
}

/** アセンブリのスライスが持つ欄と操作。 */
export interface AssemblySlice {
  /**
   * 開いているアセンブリ文書(FR-601)。**開いていなければ null**(= 部品を開いている)。
   *
   * 部品を作り直す(新規)と閉じるので、初期値は `createInitialDocumentState` の側に
   * 置いてある(`documentSlice.ts` の `resetDocument` も `null` へ戻す)。
   */
  readonly assembly: AssemblyDocument | null;
  /**
   * アセンブリを開く。**部品の欄はここでは触らない**——欄そのものは起動時の空の部品を
   * 持ったまま残るが、`activePartDocument` が `null` を返すので画面には出ない
   * (§0.a-0.10「1 つの窓で 1 つの文書」)。
   */
  readonly openAssembly: (document: AssemblyDocument, library?: PartLibrary,
    options?: { readonly preserveSaveTarget?: boolean }) => void;
  /** 配置・固定・表示・抑制・部品更新の確定操作。1 回が Undo の 1 段。 */
  readonly applyAssembly: (document: AssemblyDocument, library?: PartLibrary) => void;
  /** 共通入口が部品へ切り替えるとき、文書更新と同時に添付・履歴・IDを初期化する。 */
  readonly resetAssembly: (update: DocumentStateUpdate) => void;
  /** 共通の undo / redo から get() 経由で呼ぶ、アセンブリ専用の履歴操作。 */
  readonly undoAssembly: () => void;
  readonly redoAssembly: () => void;
  readonly assemblyLibrary: PartLibrary;
  readonly assemblyUndoStack: UndoStack<AssemblySnapshot> | null;
  readonly savedAssembly: AssemblySnapshot | null;
  readonly assemblyFileName: string | null;
  readonly assemblyInitialName: string | null;
  readonly assemblyView: AssemblyView | null;
  /** 文書の id は新規でも同じ値になり得るため、開く単位の安定 ID を別に持つ。 */
  readonly activeDocumentId: string;
  readonly recoveryRecord: AutoSaveRecord | null;
  readonly setAssemblyFileState: (name: string | null, saved: AssemblySnapshot | null) => void;
  /** アセンブリを閉じて、部品の画面へ戻る。 */
  readonly closeAssembly: () => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄。実体は `initialDocumentState.ts` が 1 か所で作る。
 */
export type AssemblyInitialState = Pick<AssemblySlice, 'assembly'>;

export const createAssemblySlice: StateCreator<
  AppState,
  [],
  [],
  Omit<AssemblySlice, keyof AssemblyInitialState>
> = (set, get) => {
  const empty = () => ({
    assemblyLibrary: EMPTY_PART_LIBRARY,
    assemblyUndoStack: null,
    savedAssembly: null,
    assemblyFileName: null,
    assemblyInitialName: null,
    assemblyView: null,
    activeDocumentId: crypto.randomUUID(),
  });
  function applyHistory(stack: UndoStack<AssemblySnapshot>): void {
    set((state) => ({
      assembly: stack.present.document,
      assemblyLibrary: stack.present.library,
      assemblyUndoStack: stack,
      canUndo: stack.past.length > 0,
      canRedo: stack.future.length > 0,
      documentVersion: state.documentVersion + 1,
      fileMessage: null,
      selection: [],
      hoveredElementId: null,
    }));
  }
  return {
    ...empty(),
    recoveryRecord: null,
    resetAssembly: (update) => {
      set((state) => ({ ...update(state), ...empty(), assembly: null }));
    },
    openAssembly: (assembly, library = EMPTY_PART_LIBRARY, options) => {
      if (options?.preserveSaveTarget !== true) get().fileGateway.clearSaveTarget?.();
      set((state) => ({
        ...empty(), assembly, assemblyLibrary: library, assemblyInitialName: assembly.name,
        assemblyUndoStack: createUndoStack({ document: assembly, library }),
        documentVersion: state.documentVersion + 1,
        canUndo: false, canRedo: false, selection: [], hoveredElementId: null,
        activeTool: 'select', fileMessage: null,
      }));
    },
    applyAssembly: (assembly, library = get().assemblyLibrary) => {
      const state = get();
      if (state.assembly === null || state.assemblyUndoStack === null) {
        return;
      }
      if (state.assembly === assembly && state.assemblyLibrary === library) {
        return;
      }
      const stack = pushUndo(state.assemblyUndoStack, { document: assembly, library });
      set({ assembly, assemblyLibrary: library, assemblyUndoStack: stack,
        canUndo: stack.past.length > 0, canRedo: false, fileMessage: null });
    },
    setAssemblyFileState: (assemblyFileName, savedAssembly) => {
      set({ assemblyFileName, savedAssembly });
    },
    closeAssembly: () => {
      const state = get();
      state.fileGateway.clearSaveTarget?.();
      set({ ...empty(), assembly: null, documentVersion: state.documentVersion + 1,
        canUndo: state.undoStack.past.length > 0, canRedo: state.undoStack.future.length > 0 });
    },
    undoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.past.length > 0) applyHistory(undo(stack));
    },
    redoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.future.length > 0) applyHistory(redo(stack));
    },
  };
};
