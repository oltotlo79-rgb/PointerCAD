import { solidResultReportRows } from '@pointercad/fem';
import { serializeCsvReport } from '../file/csvReport.js';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { hasCurrentConnectionGeometry } from '../sketch/connectionSelection.js';
import type { SolidAnalysisSession } from './solidAnalysisSession.js';

/** Null means the captured session lost ownership; do not publish its old completion. */
export async function exportSolidResultCsv(session: SolidAnalysisSession, signal: AbortSignal): Promise<boolean | null> {
  const before = useAppStore.getState(), outcome = session.result;
  const controller = new AbortController();
  const ownerCurrent = (): boolean => {
    const state = useAppStore.getState(), current = state.solidAnalysisSession;
    return activeDocumentKind(state) === 'part' && hasCurrentConnectionGeometry(state)
      && state.completedGeneration === before.completedGeneration && state.bodies === before.bodies
      && current !== null && current.ownerId === session.ownerId
      && state.activeDocumentId === session.ownerId && state.document === before.document
      && state.documentVersion === before.documentVersion && state.fileGateway === before.fileGateway
      && current.revision === session.revision && current.status === 'complete' && current.result === outcome
      && outcome !== null && outcome.prepared.input.source.documentId === state.document.id
      && outcome.prepared.input.source.revision === state.completedGeneration;
  };
  const isCurrent = (): boolean => !signal.aborted && !controller.signal.aborted && ownerCurrent();
  if (outcome === null || session.status !== 'complete' || !isCurrent()) return null;
  const abort = (): void => { controller.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = useAppStore.subscribe(() => { if (!ownerCurrent()) abort(); });
  try {
    const rows = await solidResultReportRows(outcome.prepared.input, outcome.result);
    if (!isCurrent()) return null;
    const saved = await saveFileAsThrough(before.fileGateway, 'solid-analysis.csv', 'csv', serializeCsvReport(rows),
      { signal: controller.signal, isCurrent });
    return isCurrent() ? saved : null;
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
  }
}
