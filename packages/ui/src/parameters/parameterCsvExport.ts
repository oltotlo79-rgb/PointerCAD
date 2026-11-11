import { serializeParameterCsv, type PartDocument } from '@pointercad/model';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocumentKind } from '../store/documentKind.js';

interface CsvExportAttempt {
  readonly pending: { current: AbortController | null };
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly busy: (value: boolean) => void;
  readonly issues: (value: readonly string[]) => void;
  readonly status: (value: string) => void;
}

/** One panel-owned export; cancellation cannot undo bytes already written externally. */
export async function exportParameterCsv(attempt: CsvExportAttempt): Promise<void> {
  const { pending, document, documentVersion } = attempt;
  if (pending.current !== null) return;
  const controller = new AbortController();
  const documentId = useAppStore.getState().activeDocumentId;
  const ownerCurrent = (): boolean => {
    const state = useAppStore.getState();
    return activeDocumentKind(state) === 'part' && state.activeDocumentId === documentId
      && state.document === document && state.documentVersion === documentVersion;
  };
  if (!ownerCurrent()) return;
  pending.current = controller;
  const current = (): boolean => pending.current === controller && !controller.signal.aborted && ownerCurrent();
  const release = (): void => {
    if (pending.current === controller) { pending.current = null; attempt.busy(false); }
  };
  const unsubscribe = useAppStore.subscribe(() => { if (!ownerCurrent()) controller.abort(); });
  const cancelled = (): void => { unsubscribe(); release(); };
  controller.signal.addEventListener('abort', cancelled, { once: true });
  attempt.busy(true);
  attempt.issues([]);
  attempt.status('');
  try {
    if (document.parameters.length === 0) { attempt.issues([t('parameter.csv.emptyExport')]); return; }
    const bytes = serializeParameterCsv(document.parameters);
    const saved = await saveFileAsThrough(useAppStore.getState().fileGateway, 'parameters.csv', 'csv', bytes,
      { signal: controller.signal, isCurrent: current });
    if (current()) attempt.status(t(saved ? 'parameter.csv.exported' : 'parameter.csv.exportCancelled'));
  } catch (error) {
    if (current()) attempt.issues([error instanceof Error ? error.message : t('parameter.csv.mathCheckFailed')]);
  } finally {
    unsubscribe();
    controller.signal.removeEventListener('abort', cancelled);
    release();
  }
}
