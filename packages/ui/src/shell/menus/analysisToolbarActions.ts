import type { EditToolReadiness } from '../../sketch/editCommands.js';
import type { AppState } from '../../store/appState.js';
import { activeDocumentKind } from '../../store/documentKind.js';
import { useAppStore } from '../../store/useAppStore.js';
import { ANALYSIS_MENU_ITEMS, type AnalysisToolId } from './analysisMenuItems.js';

const isSolidFormulationSwitch = (opened: AnalysisToolId | 'blocked' | null, target: AnalysisToolId): boolean =>
  (opened === 'solidPlastic' && target === 'solidFinite') || (opened === 'solidFinite' && target === 'solidPlastic');

/** A primitive selector avoids rerendering the toolbar for every edited numeric field. */
export function openAnalysisTool(state: AppState): AnalysisToolId | 'blocked' | null {
  if (state.boltPreloadDraft !== null || state.boltPreloadAuthor !== null) return 'blocked';
  const opened = ANALYSIS_MENU_ITEMS.filter(item => item.isOpen(state));
  if (opened.length > 1) return 'blocked';
  return opened[0]?.id ?? null;
}

export function analysisToolbarReadiness(state: AppState, id: AnalysisToolId): EditToolReadiness {
  const item = ANALYSIS_MENU_ITEMS.find(entry => entry.id === id);
  if (item === undefined) return { ready: false, reasonKey: 'command.unavailable.action' };
  if (!item.documentKinds.some(kind => kind === activeDocumentKind(state))) {
    return { ready: false, reasonKey: 'command.unavailable.document' };
  }
  const opened = openAnalysisTool(state);
  return opened !== null && opened !== id && !isSolidFormulationSwitch(opened, id)
    ? { ready: false, reasonKey: 'toolbar.analysis.closeCurrent' }
    : { ready: true, reasonKey: null };
}

/** Recheck at activation time. Only an explicit small/finite switch closes the other formulation; unrelated panels stay protected. */
export function runAnalysisTool(id: AnalysisToolId): EditToolReadiness {
  const state = useAppStore.getState(), readiness = analysisToolbarReadiness(state, id);
  if (!readiness.ready) return readiness;
  const item = ANALYSIS_MENU_ITEMS.find(entry => entry.id === id);
  if (item === undefined) return { ready: false, reasonKey: 'command.unavailable.action' };
  const opened = openAnalysisTool(state);
  if (isSolidFormulationSwitch(opened, id)) {
    if (opened === 'solidPlastic') state.closeSolidPlastic();
    else state.closeSolidFinite();
    // Abort listeners can synchronously open a newer tool; that owner wins.
    const afterCancel = openAnalysisTool(useAppStore.getState());
    if (afterCancel !== null && afterCancel !== id) return { ready: false, reasonKey: 'toolbar.analysis.closeCurrent' };
  }
  if (useAppStore.getState().strengthSession === null) useAppStore.getState().toggleStrength();
  const latest = useAppStore.getState();
  if (!item.isOpen(latest)) item.open(latest);
  return item.isOpen(useAppStore.getState()) ? readiness
    : { ready: false, reasonKey: 'command.unavailable.action' };
}
