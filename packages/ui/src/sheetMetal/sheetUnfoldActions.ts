/** 展開に成功してから固定面を保存する。表示切替だけならUndoへ追加しない。 */
import { setSheetUnfoldDefinition, type SheetUnfoldDefinition } from '@pointercad/model';
import { t } from '../i18n/t.js';
import type { SheetMetalToolSession } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';

export async function showSheetUnfold(session: SheetMetalToolSession, definition: SheetUnfoldDefinition): Promise<void> {
  const state = useAppStore.getState();
  if (session.kind !== 'sheetUnfold' || state.sheetMetalTool !== session || state.document !== session.document
    || state.activeDocumentId !== session.documentId || state.isComputing || state.sheetMetalRequestId !== null
    || state.assembly !== null || state.drawing !== null) return;
  const sheet = state.sheetMetalBodies.get(definition.sourceFeatureId), computer = state.sheetMetalFlatComputer;
  if (sheet === undefined) { useAppStore.setState({ sheetMetalError: t('sheetMetal.needBase') }); return; }
  if (computer === null) { useAppStore.setState({ sheetMetalError: t('sheetMetal.computeUnavailable') }); return; }
  const next = setSheetUnfoldDefinition(state.document, sheet, definition);
  if (!next.ok) { useAppStore.setState({ sheetMetalError: next.message }); return; }
  const requestId = crypto.randomUUID();
  useAppStore.setState({ sheetMetalRequestId: requestId, sheetMetalError: null });
  const current = () => {
    const latest = useAppStore.getState();
    return latest.sheetMetalTool === session && latest.document === session.document && latest.activeDocumentId === session.documentId
      && latest.sheetMetalRequestId === requestId && latest.assembly === null && latest.drawing === null;
  };
  try {
    const result = await computer(sheet, definition, requestId, () => !current());
    if (!current()) return;
    if (!result.ok) {
      if (!result.cancelled) useAppStore.setState({ sheetMetalError: result.message });
      return;
    }
    if (next.value !== state.document) useAppStore.getState().applyDocument(next.value);
    const active = next.value === state.document ? session : { ...session, document: next.value };
    useAppStore.setState({ sheetMetalTool: active, sheetMetalRequestId: null, sheetMetalError: null,
      sheetMetalPreview: { session: active, candidate: next.value, bodies: [result.body], featureId: result.body.featureId,
        volume: result.body.volume, flat: { definition, geometry: result.geometry } }, selection: [] });
  } catch (error) {
    if (current()) useAppStore.setState({ sheetMetalError: error instanceof Error ? error.message : t('sheetMetal.computeFailed') });
  } finally {
    if (current()) useAppStore.setState({ sheetMetalRequestId: null });
  }
}
