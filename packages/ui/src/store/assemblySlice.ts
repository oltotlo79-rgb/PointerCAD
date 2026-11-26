/**
 * アセンブリのスライス。
 * 分け方の約束は `viewSlice.ts` の冒頭にある。
 *
 * **1 つの窓で開く文書は 1 つだけ**。ここが `null` でないあいだは
 * アセンブリを開いていることになり、部品の読み出しの口(`documentKind.ts` の
 * `activePartDocument`)は `null` を返す。種類による分岐は**すべて `documentKind.ts`**
 * にあり、このスライスは文書・部品ライブラリとその履歴を持つ。
 *
 * 描画用の解決結果は assemblyView に置き、保存と Undo には含めない。
 * 共通の文書操作は documentSlice が所有し、ここへは get() 経由で委譲する。
 */

import {
  EMPTY_PART_LIBRARY,
  crossLevelCamDocumentFailure, crossLevelGearDocumentFailure, evaluateCamCouplings, evaluateMechanismCouplings,
  prepareCamFollowers, prepareMechanismCouplings, type MechanismCamCoupling, type MechanismGearCoupling,
  type AssemblyDocument, type AssemblyInterferenceProgress, type AssemblyInterferenceResult, type AssemblyKernelBridge,
  type EmbeddedPartAttachments, type FailureText, type JointCoordinate, type JointFramePair, type JointOccurrenceInputs,
  type MateDiagnosis, type MateResidualTargetPair, type PartDocument, type PartLibrary, type ResolvedAssembly,
  type RigidPlacement, type SolidBody, type SubShapeRef, type UndoStack, type WorkPlane,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import { createCircularWeldActions, type CircularWeldSlice } from './circularWeldActions.js';
import { createFrameEdgePickActions, type FrameEdgePickSlice } from './frameEdgePickActions.js';
import { createFrameStrokeActions, type FrameStrokeSlice } from './frameStrokeActions.js';
import { createFrameSlotFasteningActions, type FrameSlotFasteningSlice } from './frameSlotFasteningActions.js';
import { createFrameJointCheckActions, type FrameJointCheckSlice } from './frameJointCheckActions.js';
import { createFrameJointBracketActions, type FrameJointBracketSlice } from './frameJointBracketActions.js';
import { createMemberStretchActions, type MemberStretchSlice } from './memberStretchActions.js';
import { createDimensionMoveActions, type DimensionMoveSlice } from './dimensionMoveActions.js';
import { createComponentPickActions, type ComponentPickSlice } from './componentPickActions.js';
import { createBoltedJointActions } from './boltedJointActions.js';
import { createStandardPartPlacementActions, type StandardPartPlacementSlice } from './standardPartPlacementActions.js';
import { createBoltedJointDraftActions, type BoltedJointDraftSlice } from './boltedJointDraftActions.js';
import { createFilletWeldActions, type FilletWeldSlice } from './filletWeldActions.js';
import { createAssemblyJointDriveActions, type AssemblyJointDriveSlice } from './assemblyJointDriveActions.js';
import { createAssemblyExplodeActions, type AssemblyExplodeSlice } from './assemblyExplodeActions.js';
import type { AutoSaveRecord } from '@pointercad/io';
import type { AppState, DocumentStateUpdate } from './appState.js';
import { documentSessionId, type PreparedDocumentSession } from './documentIdentity.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';
import type { AssemblyMateDraft } from '../assembly/mateCommands.js';
import type { AssemblyDragState, AssemblyDragOverlay, AssemblyDragNotice } from '../assembly/dragComponentActions.js';
import type { AssemblyExplodeDraft } from '../assembly/explodeCommands.js';
import type { AssemblyInterferenceRunner } from '../assembly/interferenceActions.js';
import { interferencePairKey } from '../assembly/interferenceView.js';
import { t } from '../i18n/t.js';
import type {
  AssemblyReplacementPreview,
  AssemblyReplacementRunner,
} from '../assembly/replaceCommands.js';
import type { AssemblyBoltedJointDraft, BoltedJointDraftPreview, BoltedJointPickTarget } from '../assembly/boltedJointDraft.js';
import type { BoltedJointRebuildNotice } from '../assembly/boltedJointRebuild.js';
import type { NestedBoltedJointDraft, NestedBoltedJointPreview } from '../assembly/nestedBoltedJointDraft.js';
import type { AssemblyFilletWeldDraft, FilletWeldDraftPreview } from '../assembly/filletWeldDraft.js';
import type { NestedWeldDraft, NestedWeldPreview } from '../assembly/nestedWeldDraft.js';
import type { ChildWeldDefinitionTarget } from '../assembly/childWeldDefinitionEdit.js';
import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import type { OpenedAnalysisResults } from '../beam/savedBeamResults.js';
import { createAssemblyDocumentActions, emptyInterferenceState } from './assemblyDocumentActions.js';

import type { AssemblyPartAdoption, AssemblyPartEdit, AssemblyPartEditActions } from './partEditActions.js';

export interface AssemblySnapshot {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
}

export type AssemblyFaceProjection = (partRef: string, body: SolidBody,
  face: SubShapeRef, plane: WorkPlane, stillRequested: () => boolean) =>
  Promise<Awaited<ReturnType<AssemblyKernelBridge['projectSketchCurves']>>['results'][number] | null>;

export interface AssemblyView {
  readonly projectContextFace?: AssemblyFaceProjection;
  /** Current nonstored source/ledger ownership, separate from mate solving outcome. */
  readonly meshOwnership?: AssemblyMeshOwnership;
  /** この導出値を作った文書。古い形で合致を確定しない。 */
  readonly sourceDocument?: AssemblyDocument;
  /**
   * この解を作った時の入力そのもの(文書・部品の一式・子の組の文書)。解く所で解と同時に1回だけ入れ、押した時に
   * 作り直さない。入れ子の接合の選択は、これが今の文書・一式と同じ物の時だけ経路を解く。
   */
  readonly source?: JointOccurrenceInputs;
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
  | { readonly kind: 'failed' }
  | { readonly kind: 'internal'; readonly text: FailureText };

/** アセンブリのスライスが持つ欄と操作。 */
export interface AssemblySlice extends CircularWeldSlice, FrameEdgePickSlice, FrameStrokeSlice, FrameSlotFasteningSlice,
  FrameJointCheckSlice, FrameJointBracketSlice, MemberStretchSlice, DimensionMoveSlice, ComponentPickSlice,
  StandardPartPlacementSlice, BoltedJointDraftSlice, FilletWeldSlice, AssemblyJointDriveSlice, AssemblyExplodeSlice, AssemblyPartEditActions {
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
   * (「1 つの窓で 1 つの文書」)。
   */
  readonly openAssembly: (document: AssemblyDocument, library?: PartLibrary,
    options?: { readonly preserveSaveTarget?: boolean; readonly preparedSession?: PreparedDocumentSession;
      /** 開いたファイルの、指紋が合った解析の結果(J-03b)。開いた文書のまま(同じ物)の間だけ使う。 */
      readonly analysisResults?: ReadonlyMap<string, SavedAnalysisResult>;
      /** 保存してあった結果を io が出さなかった(指紋の不一致・壊れた中身)。梁の窓に理由を 1 行出す。 */
      readonly analysisResultsDropped?: boolean }) => void;
  /** 配置・固定・表示・抑制・部品更新の確定操作。1 回が Undo の 1 段。 */
  readonly applyAssembly: (document: AssemblyDocument, library?: PartLibrary, adopt?: AssemblyPartAdoption) => void;
  readonly setAssemblyMechanismCouplings: (couplings: readonly MechanismGearCoupling[]) => boolean;
  /** Cam-follower relations; same admission and one Undo step as the gear setter. False keeps the document. */
  readonly setAssemblyCamCouplings: (couplings: readonly MechanismCamCoupling[]) => boolean;
  /** 共通入口が部品へ切り替えるとき、文書更新と同時に添付・履歴・IDを初期化する。 */
  readonly resetAssembly: (update: DocumentStateUpdate, session?: PreparedDocumentSession) => void;
  /** 共通の undo / redo から get() 経由で呼ぶ、アセンブリ専用の履歴操作。 */
  readonly undoAssembly: () => void;
  readonly redoAssembly: () => void;
  readonly assemblyLibrary: PartLibrary;
  readonly partEdit: AssemblyPartEdit | null;
  readonly assemblyUndoStack: UndoStack<AssemblySnapshot> | null;
  readonly savedAssembly: AssemblySnapshot | null;
  readonly assemblyFileName: string | null;
  /** 開いたファイルの解析の結果と、その時の文書(J-03b)。形を変える確定で文書が別の物になると、梁の窓にも保存にも使わない。 */
  readonly assemblyOpenedAnalysisResults: OpenedAnalysisResults | null;
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
  /** サブアセンブリ配置・部品置換の非同期処理と、確認が必要な置換予告。 */
  readonly assemblyReplacementRunner: AssemblyReplacementRunner | null;
  readonly assemblyReplacementPreview: AssemblyReplacementPreview | null;
  readonly assemblyReplacementBusy: boolean;
  readonly assemblyReplacementRequestId: string | null;
  readonly setAssemblyReplacementRunner: (runner: AssemblyReplacementRunner | null) => void;
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
  /** 待ちの関節の駆動。持ち主は要求の世代・文書・文書の番号。文書・保存・Undo には含めない。 */
  readonly assemblyJointDrive: AssemblyJointDrive | null;
  /** 分解距離のその場入力。確定時だけ applyAssembly を1回呼び、Undoを1段積む。 */
  readonly assemblyExplodeDraft: AssemblyExplodeDraft | null;
  readonly assemblyExplodeError: 'invalidExpression' | 'invalidStep' | null;
  /**
   * ボルト締結(追加要件6)の打ちかけと予告。文書の寿命に結び、保存・Undo へは入れない。
   * 確定だけが applyAssembly を 1 回呼ぶ(整列・規格部品・互いの固定を Undo 1段)。
   */
  readonly assemblyBoltedJointDraft: AssemblyBoltedJointDraft | null;
  readonly assemblyBoltedJointPreview: BoltedJointDraftPreview | null;
  /**
   * 面(または穴の枠だけで、実らせんの組)を1つ足す。`add` が真(Shift)で 4 面がそろった後は、2 組目からの穴を
   * 足し外しする(全部の組を 1 回の確定で締結する。J-02 P4)。
   */
  readonly pickBoltedJointFace: (target: BoltedJointPickTarget, add?: boolean) => boolean;
  readonly commitBoltedJoint: () => boolean;
  /**
   * 部品の差し替え・取り込み直しで板が替わった締結(作り直しを待つ一覧。J-02 P8)。保存・Undo へは入れない。
   * 待つ物が無ければ null。
   */
  readonly assemblyBoltedJointRebuild: BoltedJointRebuildNotice | null;
  /** 作り直しを待つ締結の 1 つ目を「直す」の窓で開く。開けない(待つ物が無い)時は一覧を閉じて false。 */
  readonly beginBoltedJointRebuild: () => boolean;
  /** 作り直しの知らせを閉じる(文書は変えない)。 */
  readonly dismissBoltedJointRebuild: () => void;
  /**
   * 入れ子の組の葉の部品の穴どうしの締結(新しい締結の打ちかけの間だけ)。部品は根からの経路で指し、径・長さ・ナットは
   * 締結の打ちかけの欄をそのまま使う。予告と確定は model の入れ子の締結の命令。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyNestedBoltDraft: NestedBoltedJointDraft | null;
  readonly assemblyNestedBoltPreview: NestedBoltedJointPreview | null;
  /**
   * すみ肉溶接の打ちかけと予告。文書の寿命に結び、保存・Undo へは入れない。確定(と直す時の削除)だけが
   * applyAssembly を 1 回呼ぶ(ビードの部品・互いの固定を Undo 1段)。ビードの部品が 1 つ選ばれていれば直す。
   */
  readonly assemblyFilletWeldDraft: AssemblyFilletWeldDraft | null;
  readonly assemblyFilletWeldPreview: FilletWeldDraftPreview | null;
  /**
   * 入れ子の組の葉の部品どうしの溶接(新しい溶接の打ちかけの間だけ)。部品は根からの経路で指し、予告と確定は model の
   * previewOccurrenceFilletWeld / commitOccurrenceFilletWeld が、表示が解いた時の入力と葉の形で行う。脚長・区間・材質は
   * 溶接の打ちかけの欄をそのまま使う。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyNestedWeldDraft: NestedWeldDraft | null;
  readonly assemblyNestedWeldPreview: NestedWeldPreview | null;
  /**
   * 子の定義が持つ溶接を、正確な経路(根からビードまで)で選んで直す。定義を置いた全ての配置が変わるので、確定には
   * 範囲 'definition' と、今の影響する配置の数に一致する確かめが要る。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyChildWeldEdit: ChildWeldDefinitionTarget | null;
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
  'assembly' | 'assemblyInterferenceRunner' | 'assemblyReplacementRunner'>;

export type AssemblyOwnedInitialState = Pick<AssemblySlice,
  'assemblyLibrary' | 'assemblyUndoStack' | 'savedAssembly' | 'assemblyFileName'
  | 'assemblyInitialName' | 'assemblyView' | 'assemblyPlacement' | 'assemblyMateDraft'
  | 'assemblyDrag' | 'assemblyDragOverlay' | 'assemblyDragNotice' | 'assemblyMotionTime'
  | 'assemblyMotionPlaying' | 'assemblyMotionPlacements' | 'assemblyMotionSourceDocument'
  | 'assemblyMotionJointValues' | 'assemblyMotionNotice' | 'assemblyExplodeDraft'
  | 'assemblyExplodeError' | 'activeDocumentId' | 'assemblyInterferenceOpen'
  | 'assemblyInterferenceResult' | 'assemblyInterferenceSelectedKey'
  | 'assemblyInterferenceProgress' | 'assemblyInterferenceRequestId' | 'assemblyGapRequestId'
  | 'isCheckingAssemblyInterference' | 'assemblyInterferenceError' | 'standardPartPickerOpen'
  | 'assemblyReplacementPreview' | 'assemblyReplacementBusy' | 'assemblyReplacementRequestId'
  | 'assemblyBoltedJointDraft' | 'assemblyBoltedJointPreview' | 'assemblyNestedBoltDraft' | 'assemblyNestedBoltPreview'
  | 'assemblyBoltedJointRebuild'
  | 'assemblyFilletWeldDraft' | 'assemblyFilletWeldPreview'
  | 'assemblyCircularWeldDraft' | 'assemblyCircularWeldPreview'
  | 'assemblyNestedWeldDraft' | 'assemblyNestedWeldPreview' | 'assemblyChildWeldEdit' | 'assemblyJointDrive'
  | 'frameEdgePick' | 'frameStroke' | 'assemblyFrameSlotDraft' | 'assemblyFrameSlotPreview' | 'assemblyFrameSlotNut'
  | 'assemblyJointCheckOpen' | 'assemblyJointCheck' | 'assemblyJointCheckSelectedKey'
  | 'assemblyJointBracketDraft' | 'assemblyJointBracketPreview' | 'assemblyJointBracketData'
  | 'assemblyMemberStretchDraft' | 'assemblyMemberStretchPreview'
  | 'assemblyDimensionMoveDraft' | 'assemblyDimensionMovePreview' | 'assemblyComponentPick' | 'assemblyOpenedAnalysisResults'>;

/** 協調の関節の駆動の持ち主。この記録そのものがストアに残っている間だけ結果を反映できる。 */
export interface AssemblyJointDrive {
  readonly generation: number;
  readonly documentId: string;
  readonly document: AssemblyDocument;
  readonly jointId: string;
  readonly coordinate: JointCoordinate;
  readonly value: number;
  /** Omitted for a parent joint; otherwise the child occurrence, copied when requested. */
  readonly path?: readonly string[];
}

function runAssemblyInterference(set: (patch: Partial<AppState>) => void, get: () => AppState): void {
  const state = get();
  const document = state.assembly;
  const view = state.assemblyView;
  const runner = state.assemblyInterferenceRunner;
  if (document === null || view === null || view.sourceDocument !== document || runner === null) {
    set({ assemblyInterferenceOpen: true, assemblyInterferenceError: t('assembly.interference.notReady') });
    return;
  }
  const requestId = crypto.randomUUID();
  const placementSource = state.assemblyMotionPlacements !== null
    && state.assemblyMotionSourceDocument === document
    ? state.assemblyMotionPlacements : view.resolved.placements;
  const inputsCurrent = (current: AppState): boolean => {
    const currentView = current.assemblyView;
    const currentPlacements = current.assemblyMotionPlacements !== null
      && current.assemblyMotionSourceDocument === document
      ? current.assemblyMotionPlacements : currentView?.resolved.placements;
    // Mesh-accounting refresh replaces the view wrapper, not these computation inputs.
    return current.activeDocumentId === state.activeDocumentId
      && current.documentVersion === state.documentVersion && current.assembly === document
      && currentView?.sourceDocument === document && currentView.resolved === view.resolved
      && currentView.bodies === view.bodies && currentPlacements === placementSource;
  };
  const input = { requestId, components: [...document.components], resolved: view.resolved,
    bodies: new Map(view.bodies), placements: new Map(placementSource) };
  set({ assemblyInterferenceOpen: true, assemblyInterferenceResult: null,
    assemblyInterferenceSelectedKey: null, assemblyInterferenceProgress: null,
    assemblyInterferenceRequestId: requestId, isCheckingAssemblyInterference: true,
    assemblyInterferenceError: null });
  void runner.check(input, {
    onProgress: (progress) => {
      const current = get();
      if (current.assemblyInterferenceRequestId === requestId && inputsCurrent(current)) {
        set({ assemblyInterferenceProgress: progress });
      }
    },
    shouldCancel: () => {
      const current = get();
      return current.assemblyInterferenceRequestId !== requestId || !inputsCurrent(current);
    },
  }).then((result) => {
    const current = get();
    if (current.assemblyInterferenceRequestId !== requestId) return;
    if (!inputsCurrent(current)) {
      set({ assemblyInterferenceProgress: null, assemblyInterferenceRequestId: null,
        isCheckingAssemblyInterference: false,
        assemblyInterferenceError: t('assembly.interference.inputsChanged') });
      return;
    }
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
}

/** スライスが所有する一時状態を、起動・文書切替・検査で同じ値へ戻す唯一の正本。 */
export function createAssemblyInitialState(session?: PreparedDocumentSession): AssemblyOwnedInitialState {
  const activeDocumentId = documentSessionId(session);
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
    assemblyReplacementPreview: null,
    assemblyReplacementBusy: false,
    assemblyReplacementRequestId: null,
    assemblyBoltedJointDraft: null,
    assemblyBoltedJointPreview: null,
    assemblyNestedBoltDraft: null,
    assemblyNestedBoltPreview: null,
    assemblyBoltedJointRebuild: null,
    assemblyFilletWeldDraft: null,
    assemblyFilletWeldPreview: null,
    assemblyCircularWeldDraft: null,
    assemblyCircularWeldPreview: null,
    assemblyNestedWeldDraft: null,
    assemblyNestedWeldPreview: null,
    assemblyChildWeldEdit: null,
    frameEdgePick: null,
    frameStroke: null,
    assemblyFrameSlotDraft: null,
    assemblyFrameSlotPreview: null,
    assemblyFrameSlotNut: null,
    assemblyJointCheckOpen: false,
    assemblyJointCheck: null,
    assemblyJointCheckSelectedKey: null,
    assemblyJointBracketDraft: null,
    assemblyJointBracketPreview: null,
    assemblyJointBracketData: null,
    assemblyMemberStretchDraft: null,
    assemblyMemberStretchPreview: null,
    assemblyDimensionMoveDraft: null,
    assemblyDimensionMovePreview: null,
    assemblyComponentPick: null,
    assemblyJointDrive: null,
    assemblyOpenedAnalysisResults: null,
    ...emptyInterferenceState(),
    activeDocumentId,
  };
}

export const createAssemblySlice: StateCreator<
  AppState,
  [],
  [],
  Omit<AssemblySlice, keyof AssemblyInitialState>
> = (set, get) => {
  return {
    ...createAssemblyInitialState(),
    partEdit: null,
    ...createCircularWeldActions(set, get), ...createFrameEdgePickActions(set, get), ...createFrameStrokeActions(set, get), ...createFrameSlotFasteningActions(set, get), ...createFrameJointCheckActions(set, get), ...createFrameJointBracketActions(set, get), ...createMemberStretchActions(set, get), ...createDimensionMoveActions(set, get), ...createComponentPickActions(set, get), ...createBoltedJointActions(set, get),
    recoveryRecord: null,
    ...createAssemblyDocumentActions(set, get, createAssemblyInitialState),
    setAssemblyMechanismCouplings: (couplings) => {
      const state = get(), document = state.assembly;
      if (document === null) return false;
      if (couplings.length === 0 && (document.mechanismCouplings?.length ?? 0) === 0) return true;
      const next: AssemblyDocument = { ...document, mechanismCouplings: couplings.map(c => ({ ...c,
        ratio: { ...c.ratio }, phaseDeg: { ...c.phaseDeg } })) };
      const evaluated = evaluateMechanismCouplings(next);
      if (!evaluated.ok) return false;
      // Nor may the cam joint of a cross-level cam (the file reader refuses that document too).
      if (crossLevelCamDocumentFailure(next) !== null) return false;
      // A parent joint of a cross-level gear may not join a same-level gear (the file reader refuses that document).
      if (crossLevelGearDocumentFailure(next) !== null) return false;
      const view = state.assemblyView;
      if (evaluated.couplings.some(c => !c.suppressed)
          && (view === null || view.sourceDocument !== document || view.jointFrames === undefined)) return false;
      const checked = prepareMechanismCouplings({ couplings: evaluated.couplings, joints: next.joints,
        frames: view?.sourceDocument === document ? view.jointFrames ?? new Map() : new Map(),
        placements: view?.sourceDocument === document ? view.resolved.placements : new Map() });
      if (!checked.ok) return false;
      get().applyAssembly(next);
      return true;
    },
    setAssemblyCamCouplings: (couplings) => {
      const state = get(), document = state.assembly;
      if (document === null) return false;
      if (couplings.length === 0 && (document.camCouplings?.length ?? 0) === 0) return true;
      const next: AssemblyDocument = { ...document, camCouplings: couplings.map(c => ({ ...c,
        discRadiusMm: { ...c.discRadiusMm }, eccentricityMm: { ...c.eccentricityMm },
        rollerRadiusMm: { ...c.rollerRadiusMm }, phaseDeg: { ...c.phaseDeg } })) };
      const cams = evaluateCamCouplings(next), gears = evaluateMechanismCouplings(next);
      if (!cams.ok || !gears.ok) return false;
      if (crossLevelCamDocumentFailure(next) !== null) return false;
      if (crossLevelGearDocumentFailure(next) !== null) return false;
      const view = state.assemblyView;
      // Active cams need the solved frames of this exact document: geometry (in-line axes) is checked there.
      if (cams.couplings.some(c => !c.suppressed)
          && (view === null || view.sourceDocument !== document || view.jointFrames === undefined)) return false;
      const frames = view?.sourceDocument === document ? view.jointFrames ?? new Map() : new Map();
      const placements = view?.sourceDocument === document ? view.resolved.placements : new Map();
      const checkedGears = prepareMechanismCouplings({ couplings: gears.couplings, joints: next.joints, frames, placements });
      if (!checkedGears.ok) return false;
      const drivenJointIds = new Set(checkedGears.prepared.couplings.flatMap(row => [row.a.jointId, row.b.jointId]));
      const checked = prepareCamFollowers({ couplings: cams.couplings, joints: next.joints, frames, placements, drivenJointIds });
      if (!checked.ok) return false;
      get().applyAssembly(next);
      return true;
    },
    setAssemblyReplacementRunner: (assemblyReplacementRunner) => {
      set({ assemblyReplacementRunner });
    },
    setAssemblyInterferenceRunner: (assemblyInterferenceRunner) => {
      set({ assemblyInterferenceRunner });
    },
    runAssemblyInterference: () => runAssemblyInterference(set, get),
    selectAssemblyInterference: (assemblyInterferenceSelectedKey) => {
      set({ assemblyInterferenceSelectedKey });
    },
    closeAssemblyInterference: () => {
      set({ ...emptyInterferenceState(), measurement: null, massProperties: null });
    },
    ...createStandardPartPlacementActions(set, get),
    ...createBoltedJointDraftActions(set, get),
    ...createFilletWeldActions(set, get),
    ...createAssemblyJointDriveActions(set, get),
    ...createAssemblyExplodeActions(set, get),
  };
};
