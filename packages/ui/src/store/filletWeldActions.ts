import {
  partKeyOf, removeFilletWeld, weldSegmentsOf, type AssemblyComponent, type MateTarget, type OccurrenceWeldPick,
  type PartLibrary, type SolidBody,
} from '@pointercad/model';
import {
  childWeldDefinitionTarget, commitChildWeldDefinitionEdit, type ChildWeldDefinitionScope, type ChildWeldDefinitionTarget,
} from '../assembly/childWeldDefinitionEdit.js';
import {
  appendFilletWeldPick, commitFilletWeldDraft, createFilletWeldDraft, createFilletWeldEditDraft, filletWeldDraftContext,
  previewFilletWeldDraft, selectedWeldId,
  type AssemblyFilletWeldDraft, type FilletWeldDraftPatch, type FilletWeldDraftPreview,
} from '../assembly/filletWeldDraft.js';
import {
  appendNestedWeldPick, commitNestedWeld, commitNestedWeldEdit, createNestedWeldDraft, isOccurrenceWeld, nestedJointCommandContext,
  nestedWeldChoices, nestedWeldEditDisplayPreview, nestedWeldEditPreviewFor,
  nestedWeldDisplayPreview, nestedWeldPreviewFor, type NestedWeldDraft,
} from '../assembly/nestedWeldDraft.js';
import { selectedCircularWeldId } from './circularWeldActions.js';
import type { AppState } from './appState.js';

export interface FilletWeldSlice {
  readonly beginFilletWeld: () => boolean;
  readonly pickFilletWeldTarget: (target: MateTarget) => boolean;
  readonly updateFilletWeldDraft: (patch: FilletWeldDraftPatch) => void;
  readonly cancelFilletWeld: () => void;
  readonly commitFilletWeld: () => boolean;
  readonly pickNestedFilletWeldTarget: (pick: OccurrenceWeldPick) => boolean;
  readonly commitNestedFilletWeld: () => boolean;
  /** 保存した入れ子の溶接を直す確定(`commitOccurrenceFilletWeldEdit`、成功で applyAssembly を 1 回)。 */
  readonly commitNestedFilletWeldEdit: () => boolean;
  readonly removeFilletWeldDraft: () => boolean;
  readonly beginChildFilletWeldEdit: (path: readonly string[]) => boolean;
  readonly commitChildFilletWeldEdit: (confirmed: ChildWeldDefinitionScope | null) => boolean;
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

export function createFilletWeldActions(set: (patch: Partial<AppState>) => void, get: () => AppState): FilletWeldSlice {
  return {
    beginFilletWeld: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
        || state.assemblyDrag !== null || state.isComputing) return false;
      if (selectedCircularWeldId(state.assembly, state.selection) !== null) return state.beginCircularWeld();
      const weldId = selectedWeldId(state.assembly, state.selection);
      const draft = weldId === null ? createFilletWeldDraft(state.activeDocumentId)
        : createFilletWeldEditDraft(state.activeDocumentId, state.assembly, weldId);
      if (draft === null) return false;
      // 動かしている部品は無い(上で確かめた)ので、前に押した時の動かせない等の知らせは古い。状態欄の断りとして
      // 溶接の案内より先に出続けないよう、打ちかけを始める時に消す(ビードを押して選ぶと、その押下で知らせが残る)。
      const nestedEdit = weldId !== null && isOccurrenceWeld(state.assembly, weldId) && state.assemblyView !== null
        ? nestedWeldEditPreviewFor(state.assembly, state.assemblyLibrary, state.assemblyView, draft) : null;
      const nestedEditRoute = weldId !== null && isOccurrenceWeld(state.assembly, weldId);
      set({ assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyFilletWeldDraft: draft, assemblyChildWeldEdit: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: nestedEdit,
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
      set({ assemblyFilletWeldDraft: null, assemblyFilletWeldPreview: null, assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, assemblyNestedWeldDraft: null, assemblyNestedWeldPreview: null, assemblyChildWeldEdit: null });
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
  };
}
