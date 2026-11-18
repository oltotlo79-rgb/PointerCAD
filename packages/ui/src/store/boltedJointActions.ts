/**
 * ボルト締結(追加要件6・J-02)の打ちかけで面を選ぶ操作と、確定の操作。状態の欄と操作の宣言は `AssemblySlice` のまま、
 * 動作だけを `createAssemblySlice` から取り出した(円の溶接・フレームの辺を選ぶ途中と同じ形)。
 *
 * 新しい締結は穴が 1 組でも一括の口で予告・確定し、4 面の後に Shift で選んだ穴は 2 組目からの穴として足し外しする。
 * 確定は全部の組を 1 つの新しい文書にして `applyAssembly` を 1 回だけ呼ぶ(元に戻す 1 回で全部が消える)。
 */
import { findBoltedJointRecord } from '@pointercad/model';

import {
  appendBoltedJointPick, BOLTED_JOINT_PICK_COUNT, boltedJointPreviewReady, commitBoltedJointDraft, commitBoltedJointSetDraft,
  previewBoltedJointDraft, toggleBoltedJointExtraHole, type AssemblyBoltedJointDraft, type BoltedJointDraftPreview,
} from '../assembly/boltedJointDraft.js';
import { pendingBoltedJointRebuilds, withoutRebuiltRecord } from '../assembly/boltedJointRebuild.js';
import { nestedBoltedJointDisplayPreview } from '../assembly/nestedBoltedJointDisplay.js';
import { commitNestedBoltedJoint, nestedBoltedJointCommandContext, previewNestedBoltedJoint } from '../assembly/nestedBoltedJointDraft.js';
import type { AppState } from './appState.js';

type SetState = (patch: Partial<AppState>) => void;

/** いまの文書・表示の形・部品の一式で締結を予告する。表示が古ければ予告しない。 */
export function boltedJointPreviewFor(state: AppState, draft: AssemblyBoltedJointDraft): BoltedJointDraftPreview {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { kind: 'issue', issue: { kind: 'stale' } };
  }
  return previewBoltedJointDraft(state.assembly, view, state.assemblyLibrary, draft);
}

/** 入れ子の葉の穴を選んだ締結: 予告どおりの時だけ model の入れ子の締結で確定する。失敗は文書を変えずに理由を見せる。 */
function commitNestedBoltedJointDraft(set: SetState, get: () => AppState): boolean {
  const nested = get();
  const nestedDraft = nested.assemblyNestedBoltDraft, fields = nested.assemblyBoltedJointDraft, preview = nested.assemblyNestedBoltPreview;
  if (nestedDraft === null || fields === null || nested.assembly === null || nested.assemblyView === null || nested.isComputing
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

/** 作り直しを待つ締結の 1 つ目を、今ある「直す」の窓で開く(その締結のボルトなどを選んで開くのと同じ)。 */
function beginNextRebuild(set: SetState, get: () => AppState): boolean {
  const state = get();
  const [recordId] = pendingBoltedJointRebuilds(state.assemblyBoltedJointRebuild, state.activeDocumentId, state.assembly,
    state.assemblyLibrary);
  const record = recordId === undefined || state.assembly === null ? undefined : findBoltedJointRecord(state.assembly, recordId);
  const [part] = record?.componentIds ?? [];
  if (part === undefined) {
    set({ assemblyBoltedJointRebuild: null });
    return false;
  }
  return state.beginBoltedJoint([part]);
}

export function createBoltedJointActions(set: SetState, get: () => AppState):
Pick<AppState, 'pickBoltedJointFace' | 'commitBoltedJoint' | 'beginBoltedJointRebuild' | 'dismissBoltedJointRebuild'> {
  return {
    beginBoltedJointRebuild: () => beginNextRebuild(set, get),
    dismissBoltedJointRebuild: () => { set({ assemblyBoltedJointRebuild: null }); },
    pickBoltedJointFace: (target, add = false) => {
      const state = get();
      const draft = state.assemblyBoltedJointDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null) return false;
      const next = add && draft.picks.length >= BOLTED_JOINT_PICK_COUNT ? toggleBoltedJointExtraHole(draft, target)
        : appendBoltedJointPick(draft, target);
      if (next === null) return false;
      set({ assemblyBoltedJointDraft: next, assemblyBoltedJointPreview: boltedJointPreviewFor(state, next) });
      return true;
    },
    commitBoltedJoint: () => {
      if (get().assemblyNestedBoltDraft !== null) return commitNestedBoltedJointDraft(set, get);
      const state = get();
      const draft = state.assemblyBoltedJointDraft;
      const preview = state.assemblyBoltedJointPreview;
      const view = state.assemblyView;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || view === null
        || !boltedJointPreviewReady(preview) || state.isComputing) return false;
      const result = preview.kind === 'set'
        ? commitBoltedJointSetDraft(state.assembly, view, state.assemblyLibrary, draft, preview.result.plan)
        : commitBoltedJointDraft(state.assembly, view, state.assemblyLibrary, draft, preview.result.plan);
      if (!result.ok) {
        // 予告の後に形・版・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyBoltedJointPreview: boltedJointPreviewFor(state, draft) });
        return false;
      }
      get().applyAssembly(result.document);
      // 作り直しを待っていた締結を直したら、待つ一覧から外す(元に戻しても一覧へは戻さない)。
      const notice = get().assemblyBoltedJointRebuild;
      if (notice !== null && draft.editRecordId !== undefined) set({ assemblyBoltedJointRebuild: withoutRebuiltRecord(notice, draft.editRecordId) });
      return true;
    },
  };
}
