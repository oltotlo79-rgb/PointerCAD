/** 実カーネルが成功した候補だけを確定し、取消・文書切替・古い応答を履歴へ入れない。 */
import type { AppState } from '../store/appState.js';
import type { SheetMetalToolSession } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import type { buildSheetCreation } from './sheetCommands.js';

export type SheetCreationCandidate = Extract<ReturnType<typeof buildSheetCreation>, { readonly ok: true }>;
function matches(state: AppState, session: SheetMetalToolSession): boolean {
  return state.sheetMetalTool === session && state.activeDocumentId === session.documentId && state.document === session.document
    && state.assembly === null && state.drawing === null;
}
export async function applySheetCreation(session: SheetMetalToolSession, candidate: SheetCreationCandidate, commit: boolean): Promise<void> {
  const state = useAppStore.getState(), computer = state.sheetMetalComputer;
  if (!matches(state, session) || state.isComputing || state.sheetMetalRequestId !== null) return;
  if (computer === null) { useAppStore.setState({ sheetMetalError: t('sheetMetal.computeUnavailable') }); return; }
  const ready = state.sheetMetalPreview;
  const previewFeature = ready?.candidate.solids.find((item) => item.id === candidate.feature.id);
  // 再描画で同じ入力を作り直しても、成功済みの計算を再実行しない。
  // 同じ文書セッションに限定し、式sourceと全参照を含めた入力を比較する。
  if (commit && ready?.session === session && (ready.candidate === candidate.document
    || JSON.stringify(previewFeature) === JSON.stringify(candidate.feature))) {
    state.applyDocument(candidate.document); useAppStore.getState().setSelection([candidate.feature.id]); return;
  }
  const requestId = crypto.randomUUID();
  useAppStore.setState({ sheetMetalRequestId: requestId, sheetMetalError: null });
  const current = () => {
    const latest = useAppStore.getState();
    return matches(latest, session) && latest.sheetMetalRequestId === requestId;
  };
  try {
    const result = await computer(candidate.document, requestId, () => !current());
    if (!current() || result.cancelled) return;
    const body = result.bodies.find((item) => item.featureId === candidate.feature.id);
    if (result.errors.length > 0 || (session.editingFeature === undefined ? body === undefined : result.bodies.length === 0)) {
      useAppStore.setState({ sheetMetalError: result.errors[0]?.message ?? t('sheetMetal.computeFailed') }); return;
    }
    if (commit) {
      useAppStore.getState().applyDocument(candidate.document);
      useAppStore.getState().setSelection([candidate.feature.id]);
    } else {
      const volume = session.editingFeature === undefined ? body?.volume : result.bodies.reduce((sum, item) => sum + item.volume, 0);
      if (volume === undefined) throw new Error(t('sheetMetal.computeFailed'));
      useAppStore.setState({ sheetMetalPreview: { session, candidate: candidate.document, bodies: result.bodies, featureId: candidate.feature.id,
        volume } });
    }
  } catch (error) {
    if (current()) useAppStore.setState({ sheetMetalError: error instanceof Error ? error.message : t('sheetMetal.computeFailed') });
  } finally {
    if (current()) useAppStore.setState({ sheetMetalRequestId: null });
  }
}

export function displayedSheetBodies(state: AppState) {
  const preview = state.sheetMetalPreview;
  return preview !== null && matches(state, preview.session) ? preview.bodies : state.bodies;
}

/** 展開と同じ座標にない作成元スケッチを、展開図へ重ねて描かない。 */
export function isSheetFlatDisplayed(state: AppState): boolean {
  const preview = state.sheetMetalPreview;
  return preview?.flat !== undefined && matches(state, preview.session);
}
