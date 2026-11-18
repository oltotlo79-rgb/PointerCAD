/**
 * 伸縮(E-13)の打ちかけの店の操作。状態の欄(assemblyMemberStretchDraft・assemblyMemberStretchPreview)は `AssemblySlice` に置き、
 * 動作だけをここに置く(締結部品の自動判別の操作と同じ形)。
 *
 * - 始める: 今の選択(部材 1 本なら、その軸と中央)で打ちかけを作り、ほかの打ちかけ(溝の締結・ボルト締結・板の自動判別)を閉じる。
 * - 欄を替える: 予告を作り直す(計画は同期で、表示の形の外接箱から作る)。
 * - 確定: 予告と同じ入力で計画を作り直し、通った時だけ applyAssembly を 1 回(Undo 1 回)。伸び縮みした部材を選んだ状態にする。
 */
import {
  createMemberStretchDraft, memberStretchReady, previewMemberStretch, type MemberStretchDraft, type MemberStretchDraftPatch,
  type MemberStretchPreview,
} from '../assembly/memberStretchDraft.js';
import type { AppState } from './appState.js';

type SetState = (patch: Partial<AppState>) => void;

export interface MemberStretchSlice {
  readonly assemblyMemberStretchDraft: MemberStretchDraft | null;
  readonly assemblyMemberStretchPreview: MemberStretchPreview | null;
  readonly beginMemberStretch: () => boolean;
  readonly updateMemberStretchDraft: (patch: MemberStretchDraftPatch) => void;
  readonly commitMemberStretch: () => boolean;
  readonly cancelMemberStretch: () => void;
}

type MemberStretchFields = 'assemblyMemberStretchDraft' | 'assemblyMemberStretchPreview';

/** 組立を閉じる・開き直す・編集した時に戻す欄(打ちかけと予告を捨てる)。assemblySlice の片付けが広げて使う。 */
export function emptyMemberStretchState(): Pick<MemberStretchSlice, MemberStretchFields> {
  return { assemblyMemberStretchDraft: null, assemblyMemberStretchPreview: null };
}

function previewFor(state: AppState, draft: MemberStretchDraft): MemberStretchPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null) return { kind: 'issue', issue: 'stale' };
  return previewMemberStretch(state.assembly, view, draft);
}

export function createMemberStretchActions(set: SetState, get: () => AppState): Omit<MemberStretchSlice, MemberStretchFields> {
  const refresh = (draft: MemberStretchDraft): void => {
    set({ assemblyMemberStretchDraft: draft, assemblyMemberStretchPreview: previewFor(get(), draft) });
  };
  return {
    beginMemberStretch: () => {
      const state = get();
      const view = state.assemblyView;
      if (state.assembly === null || view === null || view.sourceDocument !== state.assembly || state.assemblyPlacement !== null
        || state.assemblyMateDraft !== null || state.assemblyDrag !== null || state.isComputing) return false;
      set({ assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null, assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null,
        assemblyJointBracketDraft: null, assemblyJointBracketPreview: null, standardPartPickerOpen: false, assemblyDragNotice: null });
      refresh(createMemberStretchDraft(state.activeDocumentId, state.assembly, view, state.selection));
      return true;
    },
    updateMemberStretchDraft: (patch) => {
      const state = get();
      const draft = state.assemblyMemberStretchDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      refresh({ ...draft, ...patch });
    },
    commitMemberStretch: () => {
      const state = get();
      const draft = state.assemblyMemberStretchDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || state.isComputing
        || !memberStretchReady(state.assemblyMemberStretchPreview)) return false;
      const preview = previewFor(state, draft);
      if (preview.kind !== 'plan' || !preview.plan.ok) {
        // 予告の後に形・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyMemberStretchPreview: preview });
        return false;
      }
      get().applyAssembly(preview.plan.document);
      get().setSelection(preview.plan.stretched.map((member) => member.componentId));
      set(emptyMemberStretchState());
      return true;
    },
    cancelMemberStretch: () => {
      // 取消は文書も履歴も変えない。
      set(emptyMemberStretchState());
    },
  };
}
