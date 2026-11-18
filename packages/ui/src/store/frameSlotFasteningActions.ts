/**
 * フレームの溝への締結(J-02 P6b・P7)の打ちかけの店の操作。状態の欄(assemblyFrameSlotDraft・assemblyFrameSlotPreview・
 * assemblyFrameSlotNut)は `AssemblySlice` に置き、動作だけをここに置く(締結・円の溶接・フレームの辺を選ぶ途中と同じ形)。
 *
 * - 始める: 締結の打ちかけ・ほかの打ちかけを閉じ、溝用のナットの族と記録を遅れて読む(読み終わるまで予告は「読み込み中」)。
 *   選択に部品があり、それが溝つきのフレームでない時は、それをブラケットとみなして P7(全部の穴)で始める。
 * - 確定: いまの形で計画を作り直し、通った時だけ applyAssembly を 1 回(Undo 1 回)。待つ間に文書が替わった結果は当てない。
 */
import { loadSlotNutRecords, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';

import { previewBracketSlotFastening } from '../assembly/frameSlotBracketHoles.js';
import {
  appendFrameSlotPick, commitFrameSlotDraft, createFrameSlotDraft, frameSlotPreviewReady, previewFrameSlotDraft,
  type AssemblyFrameSlotDraft, type FrameSlotDraftPatch, type FrameSlotDraftPreview, type FrameSlotNutData, type FrameSlotPreviewWithPairs,
} from '../assembly/frameSlotFasteningDraft.js';
import type { AppState } from './appState.js';
// useAppStore を読まない核の口を使う(assemblySlice から読まれるので、documentRequest.ts を経て useAppStore へ戻る輪を作らない)。
import { beginDocumentRequest } from './documentRequestCore.js';

type SetState = (patch: Partial<AppState>) => void;

const NUT_FAMILY_ID = 't-slot-nut';
const BOLT_FAMILY_ID = 'socket-head-cap-screw';

/** 状態の欄(打ちかけ・予告・遅れて読んだナットの表)と操作。欄の初めの値と片付けは assemblySlice が持つ。 */
export interface FrameSlotFasteningSlice {
  readonly assemblyFrameSlotDraft: AssemblyFrameSlotDraft | null;
  readonly assemblyFrameSlotPreview: FrameSlotDraftPreview | null;
  readonly assemblyFrameSlotNut: FrameSlotNutData | null;
  readonly beginFrameSlotFastening: (bracketIds?: readonly string[] | null) => boolean;
  readonly pickFrameSlotFace: (target: Parameters<typeof appendFrameSlotPick>[1], add?: boolean) => boolean;
  readonly updateFrameSlotDraft: (patch: FrameSlotDraftPatch) => void;
  readonly commitFrameSlotFastening: () => boolean;
  readonly cancelFrameSlotFastening: () => void;
}

/** いまの状態で予告する(P7 の時は穴ごとに合わせ面を選んだ組で)。表示が古い時は予告しない。 */
function frameSlotPreviewFor(state: AppState, draft: AssemblyFrameSlotDraft): FrameSlotPreviewWithPairs {
  const view = state.assemblyView;
  if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { preview: { kind: 'issue', issue: 'stale' }, pairs: [] };
  }
  // P7 の段で足す 1 行(選んだブラケットの全部の穴)。
  if (draft.bracketIds !== null) return previewBracketSlotFastening(state.assembly, view, state.assemblyLibrary, draft, state.assemblyFrameSlotNut);
  return previewFrameSlotDraft(state.assembly, view, state.assemblyLibrary, draft, state.assemblyFrameSlotNut);
}

export function createFrameSlotFasteningActions(set: SetState, get: () => AppState):
Omit<FrameSlotFasteningSlice, 'assemblyFrameSlotDraft' | 'assemblyFrameSlotPreview' | 'assemblyFrameSlotNut'> {
  const refresh = (draft: AssemblyFrameSlotDraft): void => {
    set({ assemblyFrameSlotDraft: draft, assemblyFrameSlotPreview: frameSlotPreviewFor(get(), draft).preview });
  };
  return {
    beginFrameSlotFastening: (bracketIds = null) => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null || state.assemblyDrag !== null
        || state.isComputing) return false;
      const draft = createFrameSlotDraft(state.activeDocumentId, bracketIds !== null && bracketIds.length > 0 ? bracketIds : null);
      set({ assemblyFrameSlotDraft: draft, assemblyFrameSlotPreview: { kind: 'issue', issue: 'loading' },
        assemblyBoltedJointDraft: null, assemblyBoltedJointPreview: null, assemblyNestedBoltDraft: null, assemblyNestedBoltPreview: null,
        assemblyCircularWeldDraft: null, assemblyCircularWeldPreview: null, standardPartPickerOpen: false, assemblyDragNotice: null });
      // 族の表は必要な時だけ読む。読み終わった時に同じ打ちかけが続いていれば、ナットの族と記録を置いて予告し直す。
      const request = beginDocumentRequest('assembly.frameSlotFastening', get, get());
      void Promise.all([PRODUCT_CATALOG_REGISTRY.ensure([NUT_FAMILY_ID, BOLT_FAMILY_ID]), loadSlotNutRecords()]).then(([, records]) => {
        const family = PRODUCT_CATALOG_REGISTRY.loaded(NUT_FAMILY_ID);
        const current = get().assemblyFrameSlotDraft;
        if (!request.isCurrent() || current === null || current.documentId !== draft.documentId || family === undefined) return;
        set({ assemblyFrameSlotNut: { family, records } });
        refresh(current);
      }, () => undefined);
      return true;
    },
    pickFrameSlotFace: (target, add = false) => {
      const state = get();
      const draft = state.assemblyFrameSlotDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null) return false;
      const next = appendFrameSlotPick(draft, target, add);
      if (next === null) return false;
      refresh(next);
      return true;
    },
    updateFrameSlotDraft: (patch) => {
      const state = get();
      const draft = state.assemblyFrameSlotDraft;
      if (draft === null || draft.documentId !== state.activeDocumentId) return;
      refresh({ ...draft, ...patch });
    },
    commitFrameSlotFastening: () => {
      const state = get();
      const draft = state.assemblyFrameSlotDraft, view = state.assemblyView;
      if (draft === null || draft.documentId !== state.activeDocumentId || state.assembly === null || view === null || state.isComputing
        || !frameSlotPreviewReady(state.assemblyFrameSlotPreview)) return false;
      const { pairs } = frameSlotPreviewFor(state, draft);
      const result = commitFrameSlotDraft(state.assembly, view, state.assemblyLibrary, draft, state.assemblyFrameSlotNut, pairs);
      if (!result.ok) {
        // 予告の後に形・配置が変わった。文書は変えず、いまの状態で予告し直して理由を見せる。
        set({ assemblyFrameSlotPreview: result.preview });
        return false;
      }
      get().applyAssembly(result.document);
      get().setSelection(result.componentIds);
      set({ assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null });
      return true;
    },
    cancelFrameSlotFastening: () => {
      // 取消は文書も履歴も変えない。下書きと予告だけを消す(読み込んだナットの記録は残す)。
      set({ assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null });
    },
  };
}
