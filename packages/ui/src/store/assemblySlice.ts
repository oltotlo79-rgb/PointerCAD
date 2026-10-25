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
  type AssemblyDocument, type AxisSpec, type EmbeddedPartAttachments, type JointOccurrenceInputs, type PartDocument, type PartLibrary,
  type AssemblyInterferenceProgress, type AssemblyInterferenceResult,
  solveDrivenJoint, evaluateMechanismCouplings, crossLevelGearDocumentFailure, crossLevelCamDocumentFailure, prepareMechanismCouplings, type MechanismGearCoupling,
  runCooperative, type CooperativeRun, type SolveDrivenJointOutcome,
  evaluateCamCouplings, prepareCamFollowers, type MechanismCamCoupling,
  type JointCoordinate, type JointFramePair, type MateResidualTargetPair,
  type ResolvedAssembly, type RigidPlacement, type SolidBody, type UndoStack,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AutoSaveRecord } from '@pointercad/io';
import type { AppState, DocumentStateUpdate } from './appState.js';
import { emptySheetMetalTool } from './sheetMetalSlice.js';
import { documentSessionId, type PreparedDocumentSession } from './documentIdentity.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';
import type { MateDiagnosis } from '@pointercad/model';
import type { AssemblyMateDraft } from '../assembly/mateCommands.js';
import type { AssemblyDragState, AssemblyDragOverlay, AssemblyDragNotice } from '../assembly/dragComponentActions.js';
import { assemblyMotionPlacements } from '../assembly/animation.js';
import {
  commitExplodeDraft, createExplodeDraft, type AssemblyExplodeDraft,
} from '../assembly/explodeCommands.js';
import { jointDriveUpdate, prepareJointDrive, prepareJointDriveRequest, type AssemblyDriveResult } from './assemblyJointDrive.js';
import type { AssemblyInterferenceRunner } from '../assembly/interferenceActions.js';
import { interferencePairKey } from '../assembly/interferenceView.js';
import { t } from '../i18n/t.js';
import {
  commitStandardPartChoice, type StandardPartCategory,
} from '../assembly/standardPartPicker.js';
import type {
  AssemblyReplacementPreview,
  AssemblyReplacementRunner,
} from '../assembly/replaceCommands.js';
import {
  appendBoltedJointPick, commitBoltedJointDraft, createBoltedJointDraft, previewBoltedJointDraft,
  createBoltedJointEditDraft,
  type AssemblyBoltedJointDraft, type BoltedJointDraftPatch, type BoltedJointDraftPreview, type BoltedJointPickTarget,
} from '../assembly/boltedJointDraft.js';
import {
  appendNestedBoltedJointPick, commitNestedBoltedJoint, createNestedBoltedJointDraft, nestedBoltedJointCommandContext,
  previewNestedBoltedJoint, type NestedBoltedJointDraft, type NestedBoltedJointPick, type NestedBoltedJointPreview,
} from '../assembly/nestedBoltedJointDraft.js';
import { nestedBoltedJointDisplayPreview, rootBoltedJointPicks } from '../assembly/nestedBoltedJointDisplay.js';
import {
  appendFilletWeldPick, commitFilletWeldDraft, createFilletWeldDraft, createFilletWeldEditDraft, filletWeldDraftContext,
  previewFilletWeldDraft, selectedWeldId,
  type AssemblyFilletWeldDraft, type FilletWeldDraftPatch, type FilletWeldDraftPreview,
} from '../assembly/filletWeldDraft.js';
import {
  appendNestedWeldPick, commitNestedWeld, commitNestedWeldEdit, createNestedWeldDraft, isOccurrenceWeld, nestedJointCommandContext,
  nestedWeldChoices, nestedWeldEditDisplayPreview, nestedWeldEditPreviewFor,
  nestedWeldDisplayPreview, nestedWeldPreviewFor, type NestedWeldDraft, type NestedWeldPreview,
} from '../assembly/nestedWeldDraft.js';
import { partKeyOf, removeFilletWeld, weldSegmentsOf, type AssemblyComponent, type MateTarget, type OccurrenceWeldPick } from '@pointercad/model';
import { boltedJointRecordForComponent } from '@pointercad/model';
import {
  childWeldDefinitionTarget, commitChildWeldDefinitionEdit, type ChildWeldDefinitionScope, type ChildWeldDefinitionTarget,
} from '../assembly/childWeldDefinitionEdit.js';

export interface AssemblySnapshot {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
}

export interface AssemblyView {
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
    options?: { readonly preserveSaveTarget?: boolean; readonly preparedSession?: PreparedDocumentSession }) => void;
  /** 配置・固定・表示・抑制・部品更新の確定操作。1 回が Undo の 1 段。 */
  readonly applyAssembly: (document: AssemblyDocument, library?: PartLibrary) => void;
  readonly setAssemblyMechanismCouplings: (couplings: readonly MechanismGearCoupling[]) => boolean;
  /** Cam-follower relations; same admission and one Undo step as the gear setter. False keeps the document. */
  readonly setAssemblyCamCouplings: (couplings: readonly MechanismCamCoupling[]) => boolean;
  /** 共通入口が部品へ切り替えるとき、文書更新と同時に添付・履歴・IDを初期化する。 */
  readonly resetAssembly: (update: DocumentStateUpdate, session?: PreparedDocumentSession) => void;
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
  readonly setAssemblyMotionTime: (time: number) => boolean;
  readonly setAssemblyMotionPlaying: (playing: boolean) => void;
  readonly driveAssemblyJoint: (jointId: string, coordinate: JointCoordinate, value: number) => boolean;
  /** 待ちの関節の駆動。持ち主は要求の世代・文書・文書の番号。文書・保存・Undo には含めない。 */
  readonly assemblyJointDrive: AssemblyJointDrive | null;
  /**
   * スライダー・数の入力からの駆動。画面を止めずに区切って解き、同じ持ち主のまま解けた時だけ 1 回反映する。
   * 文書の差し替え・Undo/Redo・取消・次の要求の後に終わった結果は反映しない。取消は失敗として示さない。
   */
  readonly requestAssemblyJointDrive: (jointId: string, coordinate: JointCoordinate, value: number, path?: readonly string[]) => boolean;
  /** 待ちの駆動を止める(owner を渡すとその持ち主の時だけ)。動きの表示・文書・履歴は変えない。 */
  readonly cancelAssemblyJointDrive: (owner?: AssemblyJointDrive) => void;
  /** 分解距離のその場入力。確定時だけ applyAssembly を1回呼び、Undoを1段積む。 */
  readonly assemblyExplodeDraft: AssemblyExplodeDraft | null;
  readonly assemblyExplodeError: 'invalidExpression' | 'invalidStep' | null;
  readonly beginAssemblyExplode: () => boolean;
  readonly cancelAssemblyExplode: () => void;
  readonly commitAssemblyExplode: (distanceSource: string, name: string, direction?: AxisSpec) => boolean;
  /**
   * ボルト締結(追加要件6)の打ちかけと予告。文書の寿命に結び、保存・Undo へは入れない。
   * 確定だけが applyAssembly を 1 回呼ぶ(整列・規格部品・互いの固定を Undo 1段)。
   */
  readonly assemblyBoltedJointDraft: AssemblyBoltedJointDraft | null;
  readonly assemblyBoltedJointPreview: BoltedJointDraftPreview | null;
  /** `selection` は道具を開く直前の選択(メニューは合致の打ちかけを消す前に読んで渡す)。省くと今の選択。 */
  readonly beginBoltedJoint: (selection?: readonly string[]) => boolean;
  /** 面(または穴の枠だけで、実らせんの組)を1つ足す。 */
  readonly pickBoltedJointFace: (target: BoltedJointPickTarget) => boolean;
  readonly updateBoltedJointDraft: (patch: BoltedJointDraftPatch) => void;
  readonly cancelBoltedJoint: () => void;
  readonly commitBoltedJoint: () => boolean;
  /**
   * 入れ子の組の葉の部品の穴どうしの締結(新しい締結の打ちかけの間だけ)。部品は根からの経路で指し、径・長さ・ナットは
   * 締結の打ちかけの欄をそのまま使う。予告と確定は model の入れ子の締結の命令。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyNestedBoltDraft: NestedBoltedJointDraft | null;
  readonly assemblyNestedBoltPreview: NestedBoltedJointPreview | null;
  readonly pickNestedBoltedJointTarget: (pick: NestedBoltedJointPick) => boolean;
  /**
   * すみ肉溶接の打ちかけと予告。文書の寿命に結び、保存・Undo へは入れない。確定(と直す時の削除)だけが
   * applyAssembly を 1 回呼ぶ(ビードの部品・互いの固定を Undo 1段)。ビードの部品が 1 つ選ばれていれば直す。
   */
  readonly assemblyFilletWeldDraft: AssemblyFilletWeldDraft | null;
  readonly assemblyFilletWeldPreview: FilletWeldDraftPreview | null;
  readonly beginFilletWeld: () => boolean;
  readonly pickFilletWeldTarget: (target: MateTarget) => boolean;
  readonly updateFilletWeldDraft: (patch: FilletWeldDraftPatch) => void;
  readonly cancelFilletWeld: () => void;
  readonly commitFilletWeld: () => boolean;
  /**
   * 入れ子の組の葉の部品どうしの溶接(新しい溶接の打ちかけの間だけ)。部品は根からの経路で指し、予告と確定は model の
   * previewOccurrenceFilletWeld / commitOccurrenceFilletWeld が、表示が解いた時の入力と葉の形で行う。脚長・区間・材質は
   * 溶接の打ちかけの欄をそのまま使う。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyNestedWeldDraft: NestedWeldDraft | null;
  readonly assemblyNestedWeldPreview: NestedWeldPreview | null;
  readonly pickNestedFilletWeldTarget: (pick: OccurrenceWeldPick) => boolean;
  readonly commitNestedFilletWeld: () => boolean;
  /** 保存した入れ子の溶接を直す確定(`commitOccurrenceFilletWeldEdit`、成功で applyAssembly を 1 回)。 */
  readonly commitNestedFilletWeldEdit: () => boolean;
  readonly removeFilletWeldDraft: () => boolean;
  /**
   * 子の定義が持つ溶接を、正確な経路(根からビードまで)で選んで直す。定義を置いた全ての配置が変わるので、確定には
   * 範囲 'definition' と、今の影響する配置の数に一致する確かめが要る。確定は applyAssembly を 1 回(Undo 1段)。
   */
  readonly assemblyChildWeldEdit: ChildWeldDefinitionTarget | null;
  readonly beginChildFilletWeldEdit: (path: readonly string[]) => boolean;
  readonly commitChildFilletWeldEdit: (confirmed: ChildWeldDefinitionScope | null) => boolean;
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
  | 'assemblyFilletWeldDraft' | 'assemblyFilletWeldPreview'
  | 'assemblyNestedWeldDraft' | 'assemblyNestedWeldPreview' | 'assemblyChildWeldEdit' | 'assemblyJointDrive'>;

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

/** 1 区切りの数え上げの単位と、1 回の setTimeout で進める区切りの数。速さの主張ではない(Root の実測待ち)。 */
const JOINT_DRIVE_WORK = { units: 512 };
const JOINT_DRIVE_POINTS_PER_SLICE = 1;

type InterferenceTransientState = Pick<AssemblyOwnedInitialState,
  'assemblyInterferenceOpen' | 'assemblyInterferenceResult' | 'assemblyInterferenceSelectedKey'
  | 'assemblyInterferenceProgress' | 'assemblyInterferenceRequestId' | 'assemblyGapRequestId'
  | 'isCheckingAssemblyInterference' | 'assemblyInterferenceError'>;

/** いまの文書・表示の形・部品の一式でボルト締結を予告する。表示が古ければ予告しない。 */
/** EX12: an edit or Undo that ends a coupled drag of the current document gives back the drives shown at the drag start,
 * but only while the shown drives are still the ones that drag published (anything else replaced them on purpose). */
function endedDragDrives(state: AppState): Pick<AppState, 'assemblyOccurrenceDrives'> | null {
  const drag = state.assemblyDrag;
  return drag !== null && drag.published !== null && state.assemblyOccurrenceDrives === drag.published
    && state.assembly === drag.document && state.assemblyLibrary === drag.library
    && state.activeDocumentId === drag.documentId && state.documentVersion === drag.version
    ? { assemblyOccurrenceDrives: drag.occurrenceDrives } : null;
}

function boltedJointPreviewFor(state: AppState, draft: AssemblyBoltedJointDraft): BoltedJointDraftPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { kind: 'issue', issue: { kind: 'stale' } };
  }
  return previewBoltedJointDraft(state.assembly, view, state.assemblyLibrary, draft);
}

/** いまの文書・表示の形・部品の一式で溶接を予告する。表示が古ければ予告しない。 */
function filletWeldPreviewFor(state: AppState, draft: AssemblyFilletWeldDraft): FilletWeldDraftPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { kind: 'issue', issue: { kind: 'stale' } };
  }
  const context = filletWeldDraftContext(state.assembly, view, state.assemblyLibrary);
  return 'kind' in context ? { kind: 'issue', issue: context } : previewFilletWeldDraft(context, draft);
}

/** 平らの溶接と同じ版の作り方(filletWeldDraft.ts の partRevisions)。 */
function libraryPartRevisions(library: PartLibrary): Map<string, string> {
  return new Map(library.partFiles.map((file) => [file.ref, `${file.contentHash}:${file.attachmentsDigest}`]));
}

/** 子の定義の溶接を、その定義の文書と今の表示のボディで予告する(既存の previewFilletWeldDraft)。 */
function childWeldPreviewFor(
  state: AppState, target: ChildWeldDefinitionTarget, draft: AssemblyFilletWeldDraft,
): FilletWeldDraftPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { kind: 'issue', issue: { kind: 'stale' } };
  }
  const current = childWeldDefinitionTarget(state.assembly, state.assemblyLibrary, target.path);
  if ('refusal' in current || current.child !== target.child) return { kind: 'issue', issue: { kind: 'stale' } };
  return previewFilletWeldDraft({
    document: current.child, partRevisions: libraryPartRevisions(state.assemblyLibrary), resolve: () => null,
    bodiesOf: (component: AssemblyComponent): readonly SolidBody[] | null => view.bodies.get(partKeyOf(component.source)) ?? null,
  }, draft);
}

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
    assemblyFilletWeldDraft: null,
    assemblyFilletWeldPreview: null,
    assemblyNestedWeldDraft: null,
    assemblyNestedWeldPreview: null,
    assemblyChildWeldEdit: null,
    assemblyJointDrive: null,
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
  const empty = createAssemblyInitialState;
  let jointDriveGeneration = 0;
  let jointDriveRun: { readonly owner: AssemblyJointDrive; readonly run: CooperativeRun<AssemblyDriveResult> } | null = null;
  function ownsJointDrive(owner: AssemblyJointDrive, source: AppState): boolean {
    const state = get();
    return state.assemblyJointDrive === owner && state.assembly === owner.document
      && owner.generation === jointDriveGeneration && state.assemblyView === source.assemblyView
      && state.activeDocumentId === owner.documentId && state.assemblyLibrary === source.assemblyLibrary
      && state.documentVersion === source.documentVersion && state.requestedGeneration === source.requestedGeneration
      && state.cancelRequestCount === source.cancelRequestCount
      && state.assemblyMotionPlacements === source.assemblyMotionPlacements
      && state.assemblyMotionJointValues === source.assemblyMotionJointValues
      && state.assemblyOccurrenceDrives === source.assemblyOccurrenceDrives;
  }
  /** A solved top-level drive is published with every cross-level group it turns (EX12), or refused whole. */
  function publishJointDrive(values: ReadonlyMap<string, number>, prepared: NonNullable<ReturnType<typeof prepareJointDrive>>,
    driven: SolveDrivenJointOutcome): boolean {
    const update = jointDriveUpdate(values, prepared, driven);
    if (!driven.ok) {
      set({ ...update, assemblyJointDrive: null });
      return false;
    }
    const follow = get().followAssemblyCrossLevelMotion(driven.placements, update.assemblyMotionJointValues ?? values);
    if (!follow.ok) {
      set({ assemblyJointDrive: null, assemblyMotionPlaying: false, assemblyCrossLevelMotionNotice: follow.notice });
      return false;
    }
    set({ ...update, assemblyJointDrive: null, assemblyMotionJointValues: follow.values, assemblyOccurrenceDrives: follow.drives,
      assemblyCrossLevelMotionNotice: null });
    return true;
  }
  function stopJointDrive(): void {
    const current = jointDriveRun;
    jointDriveRun = null;
    current?.run.cancel();
  }
  /** 古くなった持ち主の待ちを消す。新しい持ち主の待ちには触れない。 */
  function dropJointDrive(owner: AssemblyJointDrive): void {
    if (jointDriveRun?.owner === owner) stopJointDrive();
    if (get().assemblyJointDrive === owner) set({ assemblyJointDrive: null });
  }
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
      connectionSelection: null,
      hoveredElementId: null,
      assemblyPlacement: null,
      assemblyMateDraft: null,
      assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null,
      assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: null,
      assemblyMotionSourceDocument: null, assemblyMotionJointValues: new Map(), assemblyMotionNotice: null,
      assemblyExplodeDraft: null, assemblyExplodeError: null,
      standardPartPickerOpen: false,
      assemblyReplacementPreview: null, assemblyReplacementBusy: false, assemblyReplacementRequestId: null,
      assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
      assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null,
      assemblyJointDrive: null,
      ...emptyInterferenceState(), ...endedDragDrives(state),
    }));
  }
  return {
    ...empty(),
    recoveryRecord: null,
    resetAssembly: (update, session) => {
      const initial = empty(session);
      set((state) => ({ ...update(state), ...initial, assembly: null, strengthSession: null, exportHandoff: null, exportHandoffAttempt: null }));
    },
    openAssembly: (assembly, library = EMPTY_PART_LIBRARY, options) => {
      const initial = empty(options?.preparedSession);
      if (options?.preserveSaveTarget !== true) get().fileGateway.clearSaveTarget?.();
      set((state) => ({
        ...initial, assembly, drawing: null, savedDrawing: null, drawingFileName: null, strengthSession: null,
        exportHandoff: null, exportHandoffAttempt: null, ...emptySheetMetalTool(),
        drawingInitialName: null, assemblyLibrary: library, assemblyInitialName: assembly.name,
        assemblyUndoStack: createUndoStack({ document: assembly, library }),
        documentVersion: state.documentVersion + 1,
        canUndo: false, canRedo: false, selection: [], connectionSelection: null, hoveredElementId: null,
        activeTool: 'select', fileMessage: null,
      }));
    },
    applyAssembly: (assembly, library = get().assemblyLibrary) => {
      // An edit that breaks a saved cross-level gear or cam keeps the file readable: the repaired document is committed
      // instead (one Undo step), and what was suspended or removed is reported.
      const repaired = get().pruneAssemblyCrossLevelCouplings(assembly, library.assemblies ?? new Map());
      if (repaired.document !== assembly) {
        get().applyAssembly(repaired.document, library);
        set({ assemblyCrossLevelGearRepairs: repaired.repairs });
        return;
      }
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
          assemblyReplacementPreview: null, assemblyReplacementBusy: false, assemblyReplacementRequestId: null,
          assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null,
          assemblyJointDrive: null,
          assemblyCrossLevelGearRepairs: repaired.repairs,
          ...emptyInterferenceState(), ...endedDragDrives(current) };
      });
    },
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
    beginBoltedJoint: (selection) => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
        || state.assemblyDrag !== null || state.isComputing) return false;
      // 動かしている部品は無い(上で確かめた)ので、前に押した時の動かせない等の知らせは古い。溶接と同じく、締結の
      // 案内を隠さないよう打ちかけを開く時に消す。
      // 締結した部品(板・座金・ボルト・ナット)を 1 つだけ選んで開くと、その締結を直す(記録した指定を欄へ入れる)。
      const chosen = selection ?? state.selection;
      const selected = chosen.length === 1 ? chosen[0] : undefined;
      const record = selected === undefined ? undefined : boltedJointRecordForComponent(state.assembly, selected);
      // 記録の無い締結(記録を残す前に作った締結)の座金・ボルト・ナットを選んで開いた時は、推測で作り直さず、
      // 直せない理由を出す。窓は新しい締結のままで、面を選べば新しい締結として続けられる。
      const selectedPart = record === undefined && selected !== undefined
        ? state.assembly.components.find((component) => component.id === selected) : undefined;
      const recordless = selectedPart !== undefined && selectedPart.rigidGroupId !== undefined
        && selectedPart.source.kind === 'standardPart'
        && ['hexBolt', 'hexNut', 'plainWasher', 'springWasher'].includes(selectedPart.source.catalog);
      const draft = record === undefined ? createBoltedJointDraft(state.activeDocumentId)
        : createBoltedJointEditDraft(state.activeDocumentId, record);
      set({ assemblyBoltedJointDraft: draft,
        assemblyBoltedJointPreview: record !== undefined ? boltedJointPreviewFor(state, draft)
          : recordless ? { kind: 'issue', issue: { kind: 'jointRecordMissing' } } : null,
        assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
        assemblyDragNotice: null,
        standardPartPickerOpen: false, assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    pickBoltedJointFace: (target) => {
      const state = get();
      const draft = state.assemblyBoltedJointDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null) return false;
      const next = appendBoltedJointPick(draft, target);
      if (next === null) return false;
      set({ assemblyBoltedJointDraft: next, assemblyBoltedJointPreview: boltedJointPreviewFor(state, next) });
      return true;
    },
    updateBoltedJointDraft: (patch) => {
      const state = get();
      const draft = state.assemblyBoltedJointDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      const next = { ...draft, ...patch };
      const nested = state.assemblyNestedBoltDraft;
      if (nested !== null && state.assembly !== null && state.assemblyView !== null) {
        // 入れ子の葉の穴を選んだ締結: 径・長さ・ナットの欄の変更で入れ子の予告を作り直す。
        const context = nestedBoltedJointCommandContext(state.assembly, state.assemblyLibrary, state.assemblyView);
        const preview = previewNestedBoltedJoint(context, nested, next);
        set({ assemblyBoltedJointDraft: next, assemblyNestedBoltPreview: preview, assemblyBoltedJointPreview: nestedBoltedJointDisplayPreview(preview) });
        return;
      }
      set({ assemblyBoltedJointDraft: next, assemblyBoltedJointPreview: boltedJointPreviewFor(state, next) });
    },
    cancelBoltedJoint: () => {
      // 取消は文書も履歴も変えない。下書きと予告だけを消す。
      set({ assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null });
    },
    pickNestedBoltedJointTarget: (pick) => {
      const state = get();
      const fields = state.assemblyBoltedJointDraft;
      if (fields === null || fields.documentId !== state.activeDocumentId
        || state.assembly === null || state.assemblyView === null || state.isComputing) return false;
      // 根の葉を先に選んでいた締結は、その選択を根からの経路 [部品] の選択として同じ入れ子の下書きへ移してから足す
      // (順と組の確かめは下書きの append がする。移せない・合わない時は何も変えない)。
      const carried = state.assemblyNestedBoltDraft !== null ? [] : rootBoltedJointPicks(fields.picks, state.assemblyView.resolved.partKeys);
      if (carried === null) return false;
      let next: NestedBoltedJointDraft | null = state.assemblyNestedBoltDraft ?? createNestedBoltedJointDraft(state.activeDocumentId);
      for (const selected of [...carried, pick]) next = next === null ? null : appendNestedBoltedJointPick(next, selected);
      if (next === null) return false;
      const cleared = fields.picks.length > 0 ? { ...fields, picks: [] } : fields;
      const context = nestedBoltedJointCommandContext(state.assembly, state.assemblyLibrary, state.assemblyView);
      const preview = previewNestedBoltedJoint(context, next, cleared);
      set({ assemblyBoltedJointDraft: cleared, assemblyNestedBoltDraft: next, assemblyNestedBoltPreview: preview,
        assemblyBoltedJointPreview: nestedBoltedJointDisplayPreview(preview) });
      return true;
    },
    commitBoltedJoint: () => {
      const nested = get();
      const nestedDraft = nested.assemblyNestedBoltDraft;
      if (nestedDraft !== null) {
        // 入れ子の葉の穴を選んだ締結: 予告どおりの時だけ model の入れ子の締結で確定する。失敗は文書を変えずに理由を見せる。
        const fields = nested.assemblyBoltedJointDraft, preview = nested.assemblyNestedBoltPreview;
        if (fields === null || nested.assembly === null || nested.assemblyView === null || nested.isComputing
          || preview?.kind !== 'plan' || !preview.result.ok) return false;
        const context = nestedBoltedJointCommandContext(nested.assembly, nested.assemblyLibrary, nested.assemblyView);
        const result = context === null ? null : commitNestedBoltedJoint(context, nestedDraft, fields, preview.result);
        if (result === null || !result.ok) {
          const again = previewNestedBoltedJoint(context, nestedDraft, fields);
          set({ assemblyNestedBoltPreview: again, assemblyBoltedJointPreview: nestedBoltedJointDisplayPreview(again) });
          return false;
        }
        get().applyAssembly(result.document);
        set({ assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null });
        return true;
      }
      const state = get();
      const draft = state.assemblyBoltedJointDraft;
      const preview = state.assemblyBoltedJointPreview;
      const view = state.assemblyView;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || view === null
        || preview?.kind !== 'plan' || !preview.result.ok || state.isComputing) return false;
      const result = commitBoltedJointDraft(state.assembly, view, state.assemblyLibrary, draft, preview.result.plan);
      if (!result.ok) {
        // 予告の後に形・版・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyBoltedJointPreview: boltedJointPreviewFor(state, draft) });
        return false;
      }
      get().applyAssembly(result.document);
      return true;
    },
    beginFilletWeld: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
        || state.assemblyDrag !== null || state.isComputing) return false;
      const weldId = selectedWeldId(state.assembly, state.selection);
      const draft = weldId === null ? createFilletWeldDraft(state.activeDocumentId)
        : createFilletWeldEditDraft(state.activeDocumentId, state.assembly, weldId);
      if (draft === null) return false;
      // 動かしている部品は無い(上で確かめた)ので、前に押した時の動かせない等の知らせは古い。状態欄の断りとして
      // 溶接の案内より先に出続けないよう、打ちかけを始める時に消す(ビードを押して選ぶと、その押下で知らせが残る)。
      const nestedEdit = weldId !== null && isOccurrenceWeld(state.assembly, weldId) && state.assemblyView !== null
        ? nestedWeldEditPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, draft) : null;
      const nestedEditRoute = weldId !== null && isOccurrenceWeld(state.assembly, weldId);
      set({ assemblyFilletWeldDraft: draft, assemblyChildWeldEdit: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: nestedEdit,
        assemblyFilletWeldPreview: weldId === null ? null : nestedEditRoute
          ? nestedWeldEditDisplayPreview(nestedEdit, draft, state.assembly) : filletWeldPreviewFor(state, draft),
        assemblyDragNotice: null,
        assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
        standardPartPickerOpen: false, assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    pickFilletWeldTarget: (target) => {
      const state = get();
      const draft = state.assemblyFilletWeldDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null) return false;
      if (state.assemblyNestedWeldDraft !== null) {
        return target.kind === 'subShape' && get().pickNestedFilletWeldTarget({ path: [target.componentId], ref: target.ref });
      }
      const next = appendFilletWeldPick(draft, target);
      if (next === null) return false;
      set({ assemblyFilletWeldDraft: next, assemblyFilletWeldPreview: filletWeldPreviewFor(state, next) });
      return true;
    },
    updateFilletWeldDraft: (patch) => {
      const state = get();
      const draft = state.assemblyFilletWeldDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      const next = { ...draft, ...patch };
      const childEdit = state.assemblyChildWeldEdit;
      if (childEdit !== null) {
        // 子の定義の溶接を直している: 予告はその定義の文書で作り直す(根の文書の溶接へ落とさない)。
        set({ assemblyFilletWeldDraft: next, assemblyFilletWeldPreview: childWeldPreviewFor(state, childEdit, next) });
        return;
      }
      if (next.weldId !== null && state.assembly !== null && isOccurrenceWeld(state.assembly, next.weldId)) {
        // 保存した入れ子の溶接を直す: 欄の変更のたびに直しの予告を作り直す(平らの予告へ落とさない)。
        const edit = state.assemblyView === null ? null
          : nestedWeldEditPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, next);
        set({ assemblyFilletWeldDraft: next, assemblyNestedWeldPreview: edit, assemblyFilletWeldPreview: nestedWeldEditDisplayPreview(edit, next, state.assembly) });
        return;
      }
      const nested = state.assemblyNestedWeldDraft;
      if (nested !== null && state.assembly !== null && state.assemblyView !== null) {
        const preview = nestedWeldPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, next, nested);
        set({ assemblyFilletWeldDraft: next, assemblyNestedWeldPreview: preview, assemblyFilletWeldPreview: nestedWeldDisplayPreview(preview, nested, next) });
        return;
      }
      set({ assemblyFilletWeldDraft: next, assemblyFilletWeldPreview: filletWeldPreviewFor(state, next) });
    },
    cancelFilletWeld: () => {
      // 取消は文書も履歴も変えない。下書きと予告だけを消す。
      set({ assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null });
    },
    pickNestedFilletWeldTarget: (pick) => {
      const state = get();
      const weld = state.assemblyFilletWeldDraft;
      // 新しい溶接の打ちかけの間だけ。平らな面・辺を先に選んでいてもよい(下で入れ子の下書きへ移す)。
      if (weld === null || weld.weldId !== null || weld.documentId !== state.activeDocumentId
        || state.assembly === null || state.assemblyView === null || state.isComputing) return false;
      // 平らを先に選んでいた時は、その面・辺を根の葉(1要素の経路)として入れ子の下書きへ移す(選んだ順のまま)。
      const current = state.assemblyNestedWeldDraft ?? weld.picks.reduce<NestedWeldDraft | null>((draft, flat) => (draft === null
        || flat.kind !== 'subShape' ? null : appendNestedWeldPick(draft, { path: [flat.componentId], ref: flat.ref })),
      createNestedWeldDraft(state.activeDocumentId));
      if (current === null) return false;
      const next = current.documentId === state.activeDocumentId ? appendNestedWeldPick(current, pick) : null;
      if (next === null) return false;
      const preview = nestedWeldPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, weld, next);
      set({ assemblyFilletWeldDraft: { ...weld, picks: [] }, assemblyNestedWeldDraft: next, assemblyNestedWeldPreview: preview,
        assemblyFilletWeldPreview: nestedWeldDisplayPreview(preview, next, weld) });
      return true;
    },
    commitNestedFilletWeldEdit: () => {
      const state = get();
      const weld = state.assemblyFilletWeldDraft;
      const preview = state.assemblyNestedWeldPreview;
      if (weld === null || weld.weldId === null || weld.documentId !== state.activeDocumentId || state.assembly === null
        || state.assemblyView === null || state.isComputing || preview?.kind !== 'edit' || !preview.result.ok) return false;
      const result = commitNestedWeldEdit(state.assembly, state.assemblyLibrary, state.assemblyView, weld, preview.result);
      if (result === null || !result.ok) {
        // 予告の後に表示・文書・結び付けが変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        const again = nestedWeldEditPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, weld);
        set({ assemblyNestedWeldPreview: again, assemblyFilletWeldPreview: nestedWeldEditDisplayPreview(again, weld, state.assembly) });
        return false;
      }
      get().applyAssembly(result.document);
      set({ assemblyNestedWeldPreview: null, assemblyFilletWeldPreview: null });
      return true;
    },
    commitNestedFilletWeld: () => {
      const state = get();
      const weld = state.assemblyFilletWeldDraft;
      const draft = state.assemblyNestedWeldDraft;
      const preview = state.assemblyNestedWeldPreview;
      if (weld === null || draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null
        || state.assemblyView === null || state.isComputing || preview?.kind !== 'plan' || !preview.result.ok) return false;
      const choices = nestedWeldChoices(weld, draft);
      const context = nestedJointCommandContext(state.assembly, state.assemblyLibrary, state.assemblyView);
      const result = choices === null ? null : commitNestedWeld(context, draft, choices, preview.result);
      if (result === null || !result.ok) {
        // 予告の後に表示・文書・持ち主が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        const again = nestedWeldPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, weld, draft);
        set({ assemblyNestedWeldPreview: again, assemblyFilletWeldPreview: nestedWeldDisplayPreview(again, draft, weld) });
        return false;
      }
      get().applyAssembly(result.document);
      set({ assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null, assemblyFilletWeldPreview: null });
      return true;
    },
    commitFilletWeld: () => {
      // 子の定義の直しは、影響する配置の数を確かめる commitChildFilletWeldEdit だけで確定する。
      if (get().assemblyChildWeldEdit !== null) return false;
      const routed = get();
      const routedWeldId = routed.assemblyFilletWeldDraft?.weldId;
      // 保存した入れ子の溶接を直している時は、入れ子の直しの確定へ(平らの確定へ落とさない)。
      if (routedWeldId !== undefined && routedWeldId !== null && routed.assembly !== null
        && isOccurrenceWeld(routed.assembly, routedWeldId)) return get().commitNestedFilletWeldEdit();
      if (get().assemblyNestedWeldDraft !== null) return get().commitNestedFilletWeld();
      const state = get();
      const draft = state.assemblyFilletWeldDraft;
      const preview = state.assemblyFilletWeldPreview;
      const view = state.assemblyView;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || view === null
        || preview?.kind !== 'plan' || !preview.result.ok || state.isComputing) return false;
      const context = filletWeldDraftContext(state.assembly, view, state.assemblyLibrary);
      const result = 'kind' in context ? { ok: false as const } : commitFilletWeldDraft(context, draft, preview.result.plan);
      if (!result.ok) {
        // 予告の後に形・版・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyFilletWeldPreview: filletWeldPreviewFor(state, draft) });
        return false;
      }
      get().applyAssembly(result.document);
      return true;
    },
    beginChildFilletWeldEdit: (path) => {
      const state = get();
      if (state.assembly === null || state.assemblyView === null || state.assemblyPlacement !== null
        || state.assemblyMateDraft !== null || state.assemblyDrag !== null || state.isComputing) return false;
      const target = childWeldDefinitionTarget(state.assembly, state.assemblyLibrary, path);
      if ('refusal' in target) return false;
      const draft = createFilletWeldEditDraft(state.activeDocumentId, target.child, target.weldId);
      if (draft === null) return false;
      set({ assemblyFilletWeldDraft: draft, assemblyChildWeldEdit: target,
        assemblyFilletWeldPreview: childWeldPreviewFor(state, target, draft),
        assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyDragNotice: null,
        assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
        standardPartPickerOpen: false, assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    commitChildFilletWeldEdit: (confirmed) => {
      const state = get();
      const target = state.assemblyChildWeldEdit;
      const draft = state.assemblyFilletWeldDraft;
      const view = state.assemblyView;
      if (target === null || draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null
        || view === null || view.sourceDocument !== state.assembly || state.isComputing) return false;
      const result = commitChildWeldDefinitionEdit(state.assembly, state.assemblyLibrary, target, draft, confirmed,
        (component) => view.bodies.get(partKeyOf(component.source)) ?? null, libraryPartRevisions(state.assemblyLibrary));
      if (!result.ok) {
        // 確かめが無い・数が違う・古い・計画が断られた: 文書も履歴も変えず、今の定義で予告し直す。
        set({ assemblyFilletWeldPreview: childWeldPreviewFor(state, target, draft) });
        return false;
      }
      get().applyAssembly(result.document, result.library);
      return true;
    },
    removeFilletWeldDraft: () => {
      const state = get();
      const draft = state.assemblyFilletWeldDraft;
      if (draft === null || draft.weldId === null || draft.documentId !== state.activeDocumentId
        || state.assembly === null || state.isComputing) return false;
      const segments = weldSegmentsOf(state.assembly).get(draft.weldId) ?? [];
      if (segments.length === 0) return false;
      // ビードだけを消す。溶接した部品の組は残す(組を解くのは「締結を外す」)。1 回が Undo の 1 段。
      get().applyAssembly(removeFilletWeld(state.assembly, segments.map((component) => component.id)));
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
      stopJointDrive();
      // A presentation step that turns a coupled parent joint carries its cross-level group, or is refused whole.
      const follow = get().followAssemblyCrossLevelMotion(motion.placements, state.assemblyMotionJointValues);
      if (!follow.ok) {
        set({ assemblyMotionPlaying: false, assemblyCrossLevelMotionNotice: follow.notice });
        return false;
      }
      set({ assemblyMotionTime: time, assemblyMotionPlacements: motion.placements,
        assemblyMotionSourceDocument: state.assembly, assemblyMotionNotice: null, assemblyJointDrive: null, assemblyOccurrenceDrives: follow.drives, assemblyCrossLevelMotionNotice: null });
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
      if (ready) stopJointDrive();
      set(ready ? { assemblyMotionPlaying: true, assemblyJointDrive: null } : { assemblyMotionPlaying: false });
    },
    driveAssemblyJoint: (jointId, coordinate, value) => {
      // The cam joint of a saved cross-level cam moves with its follower placement (one atomic cam drive).
      const crossCam = get().getAssemblyCrossLevelCamOfParent(jointId);
      if (crossCam !== null) return coordinate === 'angle' && get().driveAssemblyCrossLevelCam(crossCam, 'cam', value);
      // A parent joint of a saved cross-level gear moves with all its coupled placements (one atomic group drive).
      const crossLevel = get().getAssemblyCrossLevelGearOfParent(jointId);
      if (crossLevel !== null) return coordinate === 'angle' && get().driveAssemblyCrossLevelGear(crossLevel, 'parent', value);
      const state = get();
      const prepared = prepareJointDrive(state, jointId, coordinate, value);
      if (prepared === null) return false;
      stopJointDrive();
      const driven = solveDrivenJoint(...prepared.args);
      const published = publishJointDrive(state.assemblyMotionJointValues, prepared, driven);
      return published;
    },
    requestAssemblyJointDrive: (jointId, coordinate, value, path) => {
      stopJointDrive();
      const state = get();
      const requestedPath = path === undefined ? undefined : [...path];
      const prepared = prepareJointDriveRequest(state, jointId, coordinate, value, requestedPath, JOINT_DRIVE_WORK);
      if (prepared === null) {
        if (state.assemblyJointDrive !== null) set({ assemblyJointDrive: null });
        return false;
      }
      jointDriveGeneration += 1;
      const owner: AssemblyJointDrive = { generation: jointDriveGeneration, documentId: state.activeDocumentId,
        document: prepared.document, jointId, coordinate, value, ...(requestedPath === undefined ? {} : { path: requestedPath }) };
      const run = runCooperative(prepared.steps, {
        pointsPerSlice: JOINT_DRIVE_POINTS_PER_SLICE,
        schedule: (slice) => {
          setTimeout(() => {
            if (ownsJointDrive(owner, state)) slice();
            else dropJointDrive(owner);
          }, 0);
        },
      });
      jointDriveRun = { owner, run };
      set({ assemblyJointDrive: owner, assemblyMotionPlaying: false });
      const release = (): void => {
        if (jointDriveRun?.owner === owner) jointDriveRun = null;
      };
      void run.result.then((result) => {
        release();
        if (result.status === 'cancelled' || !ownsJointDrive(owner, state)) {
          dropJointDrive(owner);
          return;
        }
        const { ok, update } = result.value;
        set({ assemblyMotionNotice: ok ? null : { kind: 'failed' }, ...update, assemblyJointDrive: null });
      }, () => {
        release();
        if (!ownsJointDrive(owner, state)) {
          dropJointDrive(owner);
          return;
        }
        set({ assemblyJointDrive: null, assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } });
      });
      return true;
    },
    cancelAssemblyJointDrive: (owner) => {
      const current = get().assemblyJointDrive;
      if (owner !== undefined && current !== owner) return;
      stopJointDrive();
      if (current !== null) set({ assemblyJointDrive: null });
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
      const initial = empty();
      state.fileGateway.clearSaveTarget?.();
      set({ ...initial, assembly: null, documentVersion: state.documentVersion + 1,
        canUndo: state.undoStack.past.length > 0, canRedo: state.undoStack.future.length > 0 });
    },
    undoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.past.length > 0) applyHistory(undo(stack));
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen
        || get().assemblyReplacementPreview !== null || get().assemblyReplacementBusy
        || get().assemblyBoltedJointDraft !== null || get().assemblyFilletWeldDraft !== null) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false, assemblyReplacementPreview: null, assemblyReplacementBusy: false,
          assemblyReplacementRequestId: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null, ...endedDragDrives(get()) });
      }
    },
    redoAssembly: () => {
      const stack = get().assemblyUndoStack;
      if (stack !== null && stack.future.length > 0) applyHistory(redo(stack));
      else if (get().assemblyPlacement !== null || get().assemblyMateDraft !== null || get().assemblyDrag !== null
        || get().assemblyExplodeDraft !== null || get().standardPartPickerOpen
        || get().assemblyReplacementPreview !== null || get().assemblyReplacementBusy
        || get().assemblyBoltedJointDraft !== null || get().assemblyFilletWeldDraft !== null) {
        set({ assemblyPlacement: null, assemblyMateDraft: null, assemblyDrag: null, assemblyDragOverlay: null,
          assemblyDragNotice: null, assemblyExplodeDraft: null, assemblyExplodeError: null,
          standardPartPickerOpen: false, assemblyReplacementPreview: null, assemblyReplacementBusy: false,
          assemblyReplacementRequestId: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
          assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null, ...endedDragDrives(get()) });
      }
    },
  };
};
