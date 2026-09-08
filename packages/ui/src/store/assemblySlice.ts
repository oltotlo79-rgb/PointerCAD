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
  addComponent, createComponentFor, createUndoStack, EMPTY_PART_LIBRARY, pushUndo, redo, undo,
  type AssemblyDocument, type AxisSpec, type EmbeddedPartAttachments, type PartDocument, type PartLibrary,
  type AssemblyInterferenceProgress, type AssemblyInterferenceResult,
  solveDrivenJoint, type JointCoordinate, type JointFramePair, type MateResidualTargetPair,
  type ResolvedAssembly, type RigidPlacement, type SolidBody, type UndoStack,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AutoSaveRecord } from '@pointercad/io';
import type { AppState, DocumentStateUpdate } from './appState.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { MateDiagnosis } from '@pointercad/model';
import type { AssemblyMateDraft } from '../assembly/mateCommands.js';
import type { AssemblyDragState, AssemblyDragOverlay, AssemblyDragNotice } from '../assembly/dragComponentActions.js';
import { assemblyMotionPlacements } from '../assembly/animation.js';
import {
  commitExplodeDraft, createExplodeDraft, type AssemblyExplodeDraft,
} from '../assembly/explodeCommands.js';
import { currentJointSliderValue, jointSliderBounds, jointSliderReference } from '../assembly/jointSlider.js';
import type { AssemblyInterferenceRunner } from '../assembly/interferenceActions.js';
import { interferencePairKey } from '../assembly/interferenceView.js';
import { t } from '../i18n/t.js';
import {
  commitStandardPartChoice, type StandardPartCategory,
} from '../assembly/standardPartPicker.js';

export interface AssemblySnapshot {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
}

export interface AssemblyView {
  /** この導出値を作った文書。古い形で合致を確定しない。 */
  readonly sourceDocument?: AssemblyDocument;
  readonly resolved: ResolvedAssembly;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly appearances: ReadonlyMap<string, AppearanceInput>;
  /** 合致の解と理由。保存・Undoへは入れない。 */
  readonly diagnosis: MateDiagnosis | null;
  readonly mateTargetErrors: ReadonlyMap<string, readonly string[]>;
  /** 一時的なジョイント駆動でも同じ解決済み幾何を使う。 */
  readonly mateTargets?: ReadonlyMap<string, MateResidualTargetPair>;
  /** ジョイント対象から一度だけ作った部品局所フレーム。 */
  readonly jointFrames?: ReadonlyMap<string, JointFramePair>;
  readonly jointTargetErrors?: ReadonlyMap<string, readonly string[]>;
}

/** 部品ファイルの選択から配置確定までを、文書の寿命と要求IDに結び付ける一時状態。 */
export type AssemblyPlacementState =
  | {
      readonly kind: 'choosing';
      readonly requestId: string;
      readonly documentId: string;
    }
  | {
      readonly kind: 'ready' | 'committing';
      readonly requestId: string;
      readonly documentId: string;
      readonly fileName: string;
      readonly document: PartDocument;
      readonly attachments: EmbeddedPartAttachments;
      /** 確定前のXYZ式。配置操作の正本として文書と同じストアに置く。 */
      readonly sources: readonly [string, string, string];
    };

export type AssemblyMotionNotice =
  | { readonly kind: 'rangeEnd'; readonly min: number | null; readonly max: number | null; readonly value: number }
  | { readonly kind: 'failed' };

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
  /** カーネルを持つアプリ入口から差し出す、表示専用の干渉解析と隙間測定の口。 */
  readonly assemblyInterferenceRunner: AssemblyInterferenceRunner | null;
  readonly assemblyInterferenceOpen: boolean;
  readonly assemblyInterferenceResult: AssemblyInterferenceResult | null;
  readonly assemblyInterferenceSelectedKey: string | null;
  readonly assemblyInterferenceProgress: AssemblyInterferenceProgress | null;
  readonly assemblyInterferenceRequestId: string | null;
  readonly assemblyGapRequestId: string | null;
  readonly isCheckingAssemblyInterference: boolean;
  readonly assemblyInterferenceError: string | null;
  readonly setAssemblyInterferenceRunner: (runner: AssemblyInterferenceRunner | null) => void;
  readonly runAssemblyInterference: () => void;
  readonly selectAssemblyInterference: (key: string | null) => void;
  readonly closeAssemblyInterference: () => void;
  /** モーダルにしない規格部品の選択パネル。確定後も開いたままなのでEnterで繰り返せる。 */
  readonly standardPartPickerOpen: boolean;
  readonly openStandardPartPicker: () => boolean;
  readonly closeStandardPartPicker: () => void;
  readonly placeStandardPart: (
    category: StandardPartCategory,
    choiceKey: string,
    lengthSource: string,
    dimensionSeries?: 'annexJA' | 'main',
    threadSeries?: 'coarse' | 'fine',
  ) => boolean;
  /** 「部品を配置」の一時状態。取消・文書切替・確定編集で必ず消える。 */
  readonly assemblyPlacement: AssemblyPlacementState | null;
  /** 合致コマンドの打ちかけ。文書の寿命に結び、保存・Undoへは入れない。 */
  readonly assemblyMateDraft: AssemblyMateDraft | null;
  /** Display-only drag state. No pin, candidate or solver trace enters AssemblySnapshot. */
  readonly assemblyDrag: AssemblyDragState | null;
  readonly assemblyDragOverlay: AssemblyDragOverlay | null;
  readonly assemblyDragNotice: AssemblyDragNotice | null;
  /** 共通時間軸と一時 joint driver の結果。文書・保存・Undo には含めない。 */
  readonly assemblyMotionTime: number;
  readonly assemblyMotionPlaying: boolean;
  readonly assemblyMotionPlacements: ReadonlyMap<string, RigidPlacement> | null;
  readonly assemblyMotionSourceDocument: AssemblyDocument | null;
  readonly assemblyMotionJointValues: ReadonlyMap<string, number>;
  readonly assemblyMotionNotice: AssemblyMotionNotice | null;
  readonly setAssemblyMotionTime: (time: number) => boolean;
  readonly setAssemblyMotionPlaying: (playing: boolean) => void;
  readonly driveAssemblyJoint: (jointId: string, coordinate: JointCoordinate, value: number) => boolean;
  /** 分解距離のその場入力。確定時だけ applyAssembly を1回呼び、Undoを1段積む。 */
  readonly assemblyExplodeDraft: AssemblyExplodeDraft | null;
  readonly assemblyExplodeError: 'invalidExpression' | 'invalidStep' | null;
  readonly beginAssemblyExplode: () => boolean;
  readonly cancelAssemblyExplode: () => void;
  readonly commitAssemblyExplode: (distanceSource: string, name: string, direction?: AxisSpec) => boolean;
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
export type AssemblyInitialState = Pick<AssemblySlice,
  'assembly' | 'assemblyInterferenceRunner'>;

export type AssemblyOwnedInitialState = Pick<AssemblySlice,
  'assemblyLibrary' | 'assemblyUndoStack' | 'savedAssembly' | 'assemblyFileName'
  | 'assemblyInitialName' | 'assemblyView' | 'assemblyPlacement' | 'assemblyMateDraft'
  | 'assemblyDrag' | 'assemblyDragOverlay' | 'assemblyDragNotice' | 'assemblyMotionTime'
  | 'assemblyMotionPlaying' | 'assemblyMotionPlacements' | 'assemblyMotionSourceDocument'
  | 'assemblyMotionJointValues' | 'assemblyMotionNotice' | 'assemblyExplodeDraft'
  | 'assemblyExplodeError' | 'activeDocumentId' | 'assemblyInterferenceOpen'
  | 'assemblyInterferenceResult' | 'assemblyInterferenceSelectedKey'
  | 'assemblyInterferenceProgress' | 'assemblyInterferenceRequestId' | 'assemblyGapRequestId'
  | 'isCheckingAssemblyInterference' | 'assemblyInterferenceError' | 'standardPartPickerOpen'>;

type InterferenceTransientState = Pick<AssemblyOwnedInitialState,
  'assemblyInterferenceOpen' | 'assemblyInterferenceResult' | 'assemblyInterferenceSelectedKey'
  | 'assemblyInterferenceProgress' | 'assemblyInterferenceRequestId' | 'assemblyGapRequestId'
  | 'isCheckingAssemblyInterference' | 'assemblyInterferenceError'>;

/** 文書を替える全経路で解析結果と非同期要求を同時に失効させる正本。 */
function emptyInterferenceState(): InterferenceTransientState {
  return {
    assemblyInterferenceOpen: false,
    assemblyInterferenceResult: null,
    assemblyInterferenceSelectedKey: null,
    assemblyInterferenceProgress: null,
    assemblyInterferenceRequestId: null,
    assemblyGapRequestId: null,
    isCheckingAssemblyInterference: false,
    assemblyInterferenceError: null,
  };
}

/** スライスが所有する一時状態を、起動・文書切替・検査で同じ値へ戻す唯一の正本。 */
export function createAssemblyInitialState(): AssemblyOwnedInitialState {
  return {
    assemblyLibrary: EMPTY_PART_LIBRARY,
    assemblyUndoStack: null,
    savedAssembly: null,
    assemblyFileName: null,
    assemblyInitialName: null,
    assemblyView: null,
    assemblyPlacement: null,
    assemblyMateDraft: null,
    assemblyDrag: null,
    assemblyDragOverlay: null,
    assemblyDragNotice: null,
    assemblyMotionTime: 0,
    assemblyMotionPlaying: false,
    assemblyMotionPlacements: null,
    assemblyMotionSourceDocument: null,
    assemblyMotionJointValues: new Map<string, number>(),
    assemblyMotionNotice: null,
    assemblyExplodeDraft: null,
    assemblyExplodeError: null,
    standardPartPickerOpen: false,
    ...emptyInterferenceState(),
    activeDocumentId: crypto.randomUUID(),
  };
}

export const createAssemblySlice: StateCreator<
  AppState,
  [],
  [],
  Omit<AssemblySlice, keyof AssemblyInitialState>
> = (set, get) => {
  const empty = createAssemblyInitialState;
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
      assemblyPlacement: null,
      assemblyMateDraft: null,
      assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null,
      assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: null,
      assemblyMotionSourceDocument: null, assemblyMotionJointValues: new Map(), assemblyMotionNotice: null,
      assemblyExplodeDraft: null, assemblyExplodeError: null,
      standardPartPickerOpen: false,
      ...emptyInterferenceState(),
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
      set((current) => {
        const overlay = current.assemblyDragOverlay;
        const keepOverlay = overlay !== null && overlay.document === assembly
          && overlay.library === library && overlay.documentId === current.activeDocumentId
          && overlay.version === current.documentVersion;
        return { assembly, assemblyLibrary: library, assemblyUndoStack: stack,
          canUndo: stack.past.length > 0, canRedo: false, fileMessage: null,
          assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null,
          assemblyDragOverlay: keepOverlay ? overlay : null,
          assemblyDragNotice: keepOverlay ? current.assemblyDragNotice : null,
          assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: null,
          assemblyMotionSourceDocument: null, assemblyMotionJointValues: new Map(), assemblyMotionNotice: null,
          assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false,
          ...emptyInterferenceState() };
      });
    },
    setAssemblyInterferenceRunner: (assemblyInterferenceRunner) => {
      set({ assemblyInterferenceRunner });
    },
    runAssemblyInterference: () => {
      const state = get();
      const document = state.assembly;
      const view = state.assemblyView;
      const runner = state.assemblyInterferenceRunner;
      if (document === null || view === null || view.sourceDocument !== document || runner === null) {
        set({ assemblyInterferenceOpen: true, assemblyInterferenceError: t('assembly.interference.notReady') });
        return;
      }
      const requestId = crypto.randomUUID();
      const placements = state.assemblyMotionPlacements !== null
        && state.assemblyMotionSourceDocument === document
        ? new Map(state.assemblyMotionPlacements) : new Map(view.resolved.placements);
      const input = { requestId, components: [...document.components], resolved: view.resolved,
        bodies: new Map(view.bodies), placements };
      set({ assemblyInterferenceOpen: true, assemblyInterferenceResult: null,
        assemblyInterferenceSelectedKey: null, assemblyInterferenceProgress: null,
        assemblyInterferenceRequestId: requestId, isCheckingAssemblyInterference: true,
        assemblyInterferenceError: null });
      void runner.check(input, {
        onProgress: (progress) => {
          if (get().assemblyInterferenceRequestId === requestId) set({ assemblyInterferenceProgress: progress });
        },
        shouldCancel: () => get().assemblyInterferenceRequestId !== requestId,
      }).then((result) => {
        const current = get();
        if (current.assemblyInterferenceRequestId !== requestId || current.assembly !== document
          || current.assemblyView !== view) return;
        const first = result.pairs[0];
        set({ assemblyInterferenceResult: result,
          assemblyInterferenceSelectedKey: first === undefined ? null
            : interferencePairKey(first.aComponentId, first.bComponentId),
          assemblyInterferenceProgress: null, assemblyInterferenceRequestId: null,
          isCheckingAssemblyInterference: false,
          assemblyInterferenceError: result.kind === 'failed' ? result.failure.message : null });
      }).catch((error: unknown) => {
        if (get().assemblyInterferenceRequestId !== requestId) return;
        set({ assemblyInterferenceProgress: null, assemblyInterferenceRequestId: null,
          isCheckingAssemblyInterference: false,
          assemblyInterferenceError: error instanceof Error ? error.message : String(error) });
      });
    },
    selectAssemblyInterference: (assemblyInterferenceSelectedKey) => {
      set({ assemblyInterferenceSelectedKey });
    },
    closeAssemblyInterference: () => {
      set({ ...emptyInterferenceState(), measurement: null, massProperties: null });
    },
    openStandardPartPicker: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null
        || state.assemblyMateDraft !== null || state.assemblyDrag !== null || state.isComputing) return false;
      set({ standardPartPickerOpen: true, assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    closeStandardPartPicker: () => {
      set({ standardPartPickerOpen: false });
    },
    placeStandardPart: (category, choiceKey, lengthSource, dimensionSeries, threadSeries) => {
      const state = get();
      if (!state.standardPartPickerOpen || state.assembly === null) return false;
      const selected = commitStandardPartChoice(
        category, choiceKey, lengthSource, dimensionSeries, threadSeries,
      );
      if (!selected.ok) return false;
      const component = createComponentFor(state.assembly, selected.value.source, {
        partName: selected.value.name,
      });
      get().applyAssembly(addComponent(state.assembly, component));
      // 確定後も同じ選択を残す。次のEnterを同じ1操作としてもう1個置ける(NFR-UX-4)。
      set({ standardPartPickerOpen: true });
      return true;
    },
    setAssemblyMotionTime: (time) => {
      const state = get();
      const view = state.assemblyView;
      if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) return false;
      const motion = assemblyMotionPlacements({ document: state.assembly, resolved: view.resolved,
        mateTargets: view.mateTargets, jointFrames: view.jointFrames, time });
      if (!motion.ok) {
        set({ assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } });
        return false;
      }
      set({ assemblyMotionTime: time, assemblyMotionPlacements: motion.placements,
        assemblyMotionSourceDocument: state.assembly, assemblyMotionNotice: null });
      return true;
    },
    setAssemblyMotionPlaying: (playing) => {
      if (!playing) {
        set({ assemblyMotionPlaying: false });
        return;
      }
      const state = get();
      const ready = state.assembly !== null && state.assembly.presentation.length > 0
        && state.assemblyView?.sourceDocument === state.assembly;
      set({ assemblyMotionPlaying: ready });
    },
    driveAssemblyJoint: (jointId, coordinate, value) => {
      const state = get();
      const document = state.assembly;
      const view = state.assemblyView;
      if (document === null || view === null || view.sourceDocument !== document || !Number.isFinite(value)) return false;
      const joint = document.joints.find((item) => item.id === jointId && !item.suppressed);
      const frames = view.jointFrames?.get(jointId);
      if (joint === undefined || frames === undefined) return false;
      const key = `${jointId}\u0000${coordinate}`;
      const bounds = jointSliderBounds(document, joint, coordinate);
      if (!bounds.ok) return false;
      const initialReference = jointSliderReference(bounds.bounds);
      const reference = state.assemblyMotionJointValues.get(key)
        ?? currentJointSliderValue({ document, joint, coordinate, placements: view.resolved.placements,
          frames, referenceAngle: coordinate === 'angle' ? initialReference : undefined })
        ?? initialReference;
      const driven = solveDrivenJoint(document, view.mateTargets ?? new Map(), view.resolved.placements,
        { jointId, coordinate, value, ...(coordinate === 'angle' ? { referenceAngle: reference } : {}),
          ...(joint.kind === 'cylindrical' ? { bounds: { min: joint.minValue, max: joint.maxValue } } : {}) },
        { jointFrames: view.jointFrames });
      if (!driven.ok) {
        set({ assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } });
        return false;
      }
      const displayed = driven.atLimit ? driven.target : driven.actual;
      const values = new Map(state.assemblyMotionJointValues).set(key, displayed);
      set({ assemblyMotionTime: 0, assemblyMotionPlaying: false,
        assemblyMotionPlacements: driven.placements, assemblyMotionSourceDocument: document,
        assemblyMotionJointValues: values,
        assemblyMotionNotice: driven.atLimit
          ? { kind: 'rangeEnd', min: bounds.bounds.min, max: bounds.bounds.max, value: displayed }
          : null });
      return true;
    },
    beginAssemblyExplode: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null) return false;
      const result = createExplodeDraft(state.assembly, state.selection);
      if (!result.ok) return false;
      set({ assemblyExplodeDraft: result.draft, assemblyExplodeError: null,
        assemblyMotionPlaying: false });
      return true;
    },
    cancelAssemblyExplode: () => {
      set({ assemblyExplodeDraft: null, assemblyExplodeError: null });
    },
    commitAssemblyExplode: (distanceSource, name, direction) => {
      const state = get();
      if (state.assembly === null || state.assemblyExplodeDraft === null) return false;
      const draft = direction === undefined ? state.assemblyExplodeDraft
        : { ...state.assemblyExplodeDraft, direction };
      const result = commitExplodeDraft(state.assembly, draft, distanceSource, name);
      if (!result.ok) {
        set({ assemblyExplodeError: result.reason === 'invalidExpression' ? 'invalidExpression' : 'invalidStep' });
        return false;
      }
      get().applyAssembly(result.document);
      return true;
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
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false });
      }
    },
    redoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.future.length > 0) applyHistory(redo(stack));
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false });
      }
    },
  };
};
