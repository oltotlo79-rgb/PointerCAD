/**
 * 配置の補助 P-A 寸法で動かすの打ちかけの店の操作(伸縮 memberStretchActions.ts と同じ形)。状態の欄(assemblyDimensionMoveDraft・
 * assemblyDimensionMovePreview)は `AssemblySlice` に置き、動作だけをここに置く。
 *
 * - 始める: 選んだ部品が 1 つの時だけ。アルミフレーム・鋼材・機械要素・部品のファイルのどれでも同じ。ほかの打ちかけ(溝の締結・ボルト締結・
 *   板の自動判別・伸縮)と選ぶ窓を閉じる。
 * - 欄を替える: 予告を作り直す(計画は同期で、表示の形の外接箱から作る)。
 * - 確定: 予告と同じ入力で計画を作り直し、通った時だけ applyAssembly を 1 回(Undo 1 回)。拘束は残さない。動いた部品を選んだ状態にする。
 */
import {
  createDimensionMoveDraft, dimensionMoveReady, previewDimensionMove, type DimensionMoveDraft, type DimensionMoveDraftPatch,
  type DimensionMovePreview,
} from '../assembly/dimensionMoveDraft.js';
import type { AppState } from './appState.js';

type SetState = (patch: Partial<AppState>) => void;

export interface DimensionMoveSlice {
  readonly assemblyDimensionMoveDraft: DimensionMoveDraft | null;
  readonly assemblyDimensionMovePreview: DimensionMovePreview | null;
  readonly beginDimensionMove: () => boolean;
  readonly updateDimensionMoveDraft: (patch: DimensionMoveDraftPatch) => void;
  readonly commitDimensionMove: () => boolean;
  readonly cancelDimensionMove: () => void;
}

type DimensionMoveFields = 'assemblyDimensionMoveDraft' | 'assemblyDimensionMovePreview';

/** 組立を閉じる・開き直す・編集した時に戻す欄(打ちかけと予告を捨てる)。assemblySlice の片付けが広げて使う。 */
export function emptyDimensionMoveState(): Pick<DimensionMoveSlice, DimensionMoveFields> {
  return { assemblyDimensionMoveDraft: null, assemblyDimensionMovePreview: null };
}

function previewFor(state: AppState, draft: DimensionMoveDraft): DimensionMovePreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null) return { current: null, issue: 'stale', plan: null };
  return previewDimensionMove(state.assembly, view, draft);
}

export function createDimensionMoveActions(set: SetState, get: () => AppState): Omit<DimensionMoveSlice, DimensionMoveFields> {
  const refresh = (draft: DimensionMoveDraft): void => {
    set({ assemblyDimensionMoveDraft: draft, assemblyDimensionMovePreview: previewFor(get(), draft) });
  };
  return {
    beginDimensionMove: () => {
      const state = get();
      const view = state.assemblyView;
      const componentId = state.selection.length === 1 ? state.selection[0] : undefined;
      if (state.assembly === null || view === null || view.sourceDocument !== state.assembly || componentId === undefined
        || !state.assembly.components.some((component) => component.id === componentId) || state.assemblyPlacement !== null
        || state.assemblyMateDraft !== null || state.assemblyDrag !== null || state.isComputing) return false;
      set({ assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null,
        assemblyJointBracketDraft: null, assemblyJointBracketPreview: null, assemblyMemberStretchDraft: null,
        assemblyMemberStretchPreview: null, standardPartPickerOpen: false, assemblyDragNotice: null });
      refresh(createDimensionMoveDraft(state.activeDocumentId, componentId));
      return true;
    },
    updateDimensionMoveDraft: (patch) => {
      const state = get();
      const draft = state.assemblyDimensionMoveDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      refresh({ ...draft, ...patch });
    },
    commitDimensionMove: () => {
      const state = get();
      const draft = state.assemblyDimensionMoveDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || state.isComputing
        || !dimensionMoveReady(state.assemblyDimensionMovePreview)) return false;
      const preview = previewFor(state, draft);
      if (preview.plan === null || !preview.plan.ok) {
        // 予告の後に形・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyDimensionMovePreview: preview });
        return false;
      }
      get().applyAssembly(preview.plan.document);
      get().setSelection(preview.plan.movedIds);
      set(emptyDimensionMoveState());
      return true;
    },
    cancelDimensionMove: () => {
      // 取消は文書も履歴も変えない。
      set(emptyDimensionMoveState());
    },
  };
}
