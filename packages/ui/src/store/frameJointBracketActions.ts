/**
 * 締結部品の自動判別(E-07)の打ちかけの店の操作。状態の欄(assemblyJointBracketDraft・assemblyJointBracketPreview・assemblyJointBracketData)は
 * `AssemblySlice` に置き、動作だけをここに置く(フレームの溝への締結の操作と同じ形)。
 *
 * - 始める: 接続の id(接合チェックの行から。十字は分けた T の id)で始め、板の行の表・溝用のナット・族を遅れて読む(読み終わるまで「読み込み中」)。
 *   入れ替え(E-13)は記録の id で始める(記録の接続を今の組立から探す)。記録を外す操作もここに置く(部品は残す)。
 * - 候補を選ぶ: 接続ごとに 1 つ。選び直すと置き換える。
 * - 確定: いまの形で計画を作り直し、全部が通った時だけ applyAssembly を 1 回(Undo 1 回)。待つ間に文書が替わった結果は当てない。
 */
import { detachFrameJointRecord, loadJointBracketRecords, loadSlotNutRecords, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';

import {
  commitFrameJointBrackets, createFrameJointBracketDraft, createFrameJointSwapDraft, frameJointBracketReady, jointBracketGroupSelection,
  previewFrameJointBrackets, type FrameJointBracketData, type FrameJointBracketDraft, type FrameJointBracketDraftPatch, type FrameJointBracketGroup,
  type FrameJointBracketPreview,
} from '../assembly/frameJointBracketDraft.js';
import type { AppState } from './appState.js';
// useAppStore を読まない核の口を使う(assemblySlice から読まれるので、useAppStore へ戻る輪を作らない)。
import { beginDocumentRequest } from './documentRequestCore.js';

type SetState = (patch: Partial<AppState>) => void;

/** 遅れて読む族(板 2 つ・溝用のナット・六角穴付きボルト)。 */
const FAMILY_IDS = ['t-slot-angle-bracket', 't-slot-flat-plate', 't-slot-nut', 'socket-head-cap-screw'];

export interface FrameJointBracketSlice {
  readonly assemblyJointBracketDraft: FrameJointBracketDraft | null;
  readonly assemblyJointBracketPreview: FrameJointBracketPreview | null;
  readonly assemblyJointBracketData: FrameJointBracketData | null;
  /** 接続の id で始める。同じ形の接続の組(安全柵など)を渡すと、組ごとに 1 つの候補をまとめて選べる。 */
  readonly beginJointBracket: (jointIds: readonly string[], groups?: readonly FrameJointBracketGroup[]) => boolean;
  /** 組で 1 つの候補の形を選ぶ(組の接続ごとの候補を、その形の候補に置き換える)。 */
  readonly chooseJointBracketGroup: (groupKey: string, shapeKey: string) => void;
  /** 記録のある接続の板とつなぎ方の入れ替え(E-13)を始める。記録の接続が今の組立に無い時は始めない。 */
  readonly beginJointBracketSwap: (recordId: string) => boolean;
  /** 記録を外す(置いた部品はそのまま残す。Undo 1 回)。 */
  readonly detachJointRecord: (recordId: string) => void;
  readonly chooseJointBracket: (jointId: string, key: string) => void;
  readonly updateJointBracketDraft: (patch: FrameJointBracketDraftPatch) => void;
  readonly commitJointBracket: () => boolean;
  readonly cancelJointBracket: () => void;
}

type FrameJointBracketFields = 'assemblyJointBracketDraft' | 'assemblyJointBracketPreview' | 'assemblyJointBracketData';

/** 組立を閉じる・開き直す時に戻す欄(下書きと予告を捨てる。読み込んだ表は残す)。assemblySlice の片付けが広げて使う。 */
export function emptyJointBracketState(): Pick<FrameJointBracketSlice, 'assemblyJointBracketDraft' | 'assemblyJointBracketPreview'> {
  return { assemblyJointBracketDraft: null, assemblyJointBracketPreview: null };
}

function previewFor(state: AppState, draft: FrameJointBracketDraft): FrameJointBracketPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) return { kind: 'issue', issue: 'stale' };
  return previewFrameJointBrackets(state.assembly, view, state.assemblyLibrary, draft, state.assemblyJointBracketData);
}

/** 族と行の表を読む(読み終わった族が揃わない時は null)。 */
async function loadData(): Promise<FrameJointBracketData | null> {
  const [, records, nutRecords] = await Promise.all([PRODUCT_CATALOG_REGISTRY.ensure(FAMILY_IDS), loadJointBracketRecords(), loadSlotNutRecords()]);
  const angle = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-angle-bracket'), plate = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-flat-plate');
  const nutFamily = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-nut');
  return angle === undefined || plate === undefined || nutFamily === undefined ? null
    : { records, nutFamily, nutRecords, families: { angle, plate } };
}

/** 始められる時か(組立があり、置く・合わせる・動かす・計算の途中でない)。 */
function canBegin(state: AppState): boolean {
  return state.assembly !== null && state.assemblyPlacement === null && state.assemblyMateDraft === null && state.assemblyDrag === null
    && !state.isComputing;
}

export function createFrameJointBracketActions(set: SetState, get: () => AppState): Omit<FrameJointBracketSlice, FrameJointBracketFields> {
  const refresh = (draft: FrameJointBracketDraft): void => {
    set({ assemblyJointBracketDraft: draft, assemblyJointBracketPreview: previewFor(get(), draft) });
  };
  /** 打ちかけを置き、ほかの打ちかけを閉じ、族と行の表が無ければ遅れて読む(読み終わるまで「読み込み中」)。 */
  const start = (draft: FrameJointBracketDraft): void => {
    set({ assemblyJointBracketDraft: draft, assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null, assemblyBoltedJointDraft: null,
      assemblyBoltedJointPreview: null, standardPartPickerOpen: false, assemblyDragNotice: null });
    if (get().assemblyJointBracketData !== null) { refresh(draft); return; }
    set({ assemblyJointBracketPreview: { kind: 'issue', issue: 'loading' } });
    const request = beginDocumentRequest('assembly.frameJointBracket', get, get());
    void loadData().then((data) => {
      const current = get().assemblyJointBracketDraft;
      if (!request.isCurrent() || data === null || current === null || current.documentId !== draft.documentId) return;
      set({ assemblyJointBracketData: data });
      refresh(current);
    }, () => undefined);
  };
  return {
    beginJointBracket: (jointIds, groups = []) => {
      const state = get();
      if (!canBegin(state) || jointIds.length === 0) return false;
      start(createFrameJointBracketDraft(state.activeDocumentId, jointIds, groups));
      return true;
    },
    chooseJointBracketGroup: (groupKey, shapeKey) => {
      const state = get();
      const draft = state.assemblyJointBracketDraft;
      const picked = jointBracketGroupSelection(state.assemblyJointBracketPreview, groupKey, shapeKey);
      if (draft === null || Object.keys(picked).length === 0) return;
      refresh({ ...draft, selected: { ...draft.selected, ...picked }, groupSelected: { ...draft.groupSelected, [groupKey]: shapeKey } });
    },
    beginJointBracketSwap: (recordId) => {
      const state = get();
      const view = state.assemblyView;
      if (!canBegin(state) || state.assembly === null || view === null || view.sourceDocument !== state.assembly) return false;
      const draft = createFrameJointSwapDraft(state.activeDocumentId, state.assembly, view, recordId);
      if (draft === null) return false;
      start(draft);
      return true;
    },
    detachJointRecord: (recordId) => {
      const state = get();
      if (state.assembly === null || state.isComputing) return;
      const next = detachFrameJointRecord(state.assembly, recordId, false);
      if (next !== state.assembly) state.applyAssembly(next);
    },
    chooseJointBracket: (jointId, key) => {
      const draft = get().assemblyJointBracketDraft;
      if (draft === null || !draft.jointIds.includes(jointId)) return;
      refresh({ ...draft, selected: { ...draft.selected, [jointId]: key } });
    },
    updateJointBracketDraft: (patch) => {
      const state = get();
      const draft = state.assemblyJointBracketDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      // 呼び・入れ方・材質を替えると候補の計画が変わるので、選んだ候補は選び直してもらう。
      refresh({ ...draft, ...patch, selected: {}, groupSelected: {} });
    },
    commitJointBracket: () => {
      const state = get();
      const draft = state.assemblyJointBracketDraft, view = state.assemblyView;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || view === null || state.isComputing
        || !frameJointBracketReady(state.assemblyJointBracketPreview)) return false;
      const result = commitFrameJointBrackets(state.assembly, view, state.assemblyLibrary, draft, state.assemblyJointBracketData);
      if (!result.ok) {
        // 予告の後に形・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyJointBracketPreview: result.preview });
        return false;
      }
      get().applyAssembly(result.document);
      get().setSelection(result.componentIds);
      set({ assemblyJointBracketDraft: null, assemblyJointBracketPreview: null });
      return true;
    },
    cancelJointBracket: () => {
      // 取消は文書も履歴も変えない(読み込んだ表は残す)。
      set({ assemblyJointBracketDraft: null, assemblyJointBracketPreview: null });
    },
  };
}
