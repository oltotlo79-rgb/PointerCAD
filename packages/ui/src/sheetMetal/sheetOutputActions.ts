import { queueDocumentSave } from '../file/documentSaveQueue.js';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { hasSaveRecoveryCopy } from '../file/saveFailure.js';
import { t } from '../i18n/t.js';
import type { SheetMetalPreview } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SheetOutputFormat } from './sheetOutputComputer.js';

export async function exportSheet(preview: SheetMetalPreview, format: SheetOutputFormat): Promise<void> {
  const before = useAppStore.getState(), flat = preview.flat, computer = before.sheetOutputComputer;
  if (flat === undefined || before.sheetMetalPreview !== preview || before.sheetMetalTool !== preview.session
    || before.document !== preview.candidate || before.activeDocumentId !== preview.session.documentId
    || before.isComputing || before.sheetMetalRequestId !== null || before.assembly !== null || before.drawing !== null) return;
  const sheet = before.sheetMetalBodies.get(flat.definition.sourceFeatureId);
  if (computer === null || sheet === undefined) { useAppStore.setState({ sheetMetalError: t('sheetMetal.computeUnavailable') }); return; }
  const requestId = crypto.randomUUID();
  useAppStore.setState({ sheetMetalRequestId: requestId, sheetMetalError: null });
  const current = () => {
    const latest = useAppStore.getState();
    return latest.sheetMetalRequestId === requestId && latest.sheetMetalPreview === preview && latest.document === preview.candidate
      && latest.sheetMetalTool === preview.session && latest.activeDocumentId === preview.session.documentId && latest.fileGateway === before.fileGateway;
  };
  try {
    const file = await computer({ document: before.document, sheet, definition: flat.definition, importedShapes: before.importedShapes, format, requestId }, () => !current());
    if (!current()) return;
    await queueDocumentSave(before, async (sameDocument) => {
      if (!current() || !sameDocument()) return;
      const saved = await saveFileAsThrough(before.fileGateway, file.fileName, file.kind, file.bytes);
      if (saved && current() && sameDocument()) before.setFileMessage({ key: 'sheetMetal.exported', failed: false });
    });
  } catch (error) {
    if (current()) useAppStore.setState({ sheetMetalError: hasSaveRecoveryCopy(error) ? t('file.saveRecoveryCopyRetained')
      : error instanceof Error ? error.message : t('sheetMetal.exportFailed') });
  } finally { if (current()) useAppStore.setState({ sheetMetalRequestId: null }); }
}
