import { boltedJointRecordForComponent } from '@pointercad/model';
import { createBoltedJointDraft, createBoltedJointEditDraft, type BoltedJointDraftPatch } from '../assembly/boltedJointDraft.js';
import { nestedBoltedJointDisplayPreview, rootBoltedJointPicks } from '../assembly/nestedBoltedJointDisplay.js';
import {
  appendNestedBoltedJointPick, createNestedBoltedJointDraft, nestedBoltedJointCommandContext,
  previewNestedBoltedJoint, type NestedBoltedJointDraft, type NestedBoltedJointPick,
} from '../assembly/nestedBoltedJointDraft.js';
import { boltedJointPreviewFor } from './boltedJointActions.js';
import type { AppState } from './appState.js';

export interface BoltedJointDraftSlice {
  /** `selection` は道具を開く直前の選択(メニューは合致の打ちかけを消す前に読んで渡す)。省くと今の選択。 */
  readonly beginBoltedJoint: (selection?: readonly string[]) => boolean;
  readonly updateBoltedJointDraft: (patch: BoltedJointDraftPatch) => void;
  readonly cancelBoltedJoint: () => void;
  readonly pickNestedBoltedJointTarget: (pick: NestedBoltedJointPick) => boolean;
}

export function createBoltedJointDraftActions(set: (patch: Partial<AppState>) => void, get: () => AppState): BoltedJointDraftSlice {
  return {
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
      set({ assemblyBoltedJointDraft: draft, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null,
        assemblyBoltedJointPreview: record !== undefined ? boltedJointPreviewFor(state, draft)
          : recordless ? { kind: 'issue', issue: { kind: 'jointRecordMissing' } } : null,
        assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
        assemblyDragNotice: null,
        standardPartPickerOpen: false, assemblyExplodeDraft: null, assemblyExplodeError: null });
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
  };
}
