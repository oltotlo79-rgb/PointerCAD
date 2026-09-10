import type { AppState } from '../store/appState.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { helpTopic } from './helpLibrary.js';

export function contextualHelpTopic(state: AppState, explicit?: string | null, textEntry = false): string {
  if (explicit !== undefined && explicit !== null && helpTopic(explicit) !== undefined) return explicit;
  if (state.helpTopicId !== null) return state.helpTopicId;
  const kind = activeDocumentKind(state);
  if (kind === 'drawing') {
    if (state.drawingEditor?.kind === 'view') return state.drawingEditor.constructionKind === 'section' ? 'drawing-section' : 'drawing-views';
    if (state.drawingEditor?.kind === 'layer') return 'drawing-layer';
    if (state.drawingTool === 'note') return 'drawing-note';
    if (state.drawingTool === 'annotation') return 'surface-finish';
    if (state.drawingTool === 'dimension') return 'dimension';
    if (state.drawingTool === 'dimensionSeries') return 'dimension-series';
    if (state.drawingTool === 'balloon') return 'drawing-bom';
    if (state.drawingEditor?.kind === 'table') return state.drawingEditor.tableKind === 'bom' ? 'drawing-bom' : 'drawing-table';
    return 'drawing';
  }
  if (textEntry) return 'numeric-input';
  if (kind === 'assembly') {
    if (state.assemblyMateDraft !== null) return state.assemblyMateDraft.jointKind === undefined ? 'mate' : 'joint';
    if (state.assemblyPlacement !== null) return 'assembly-place';
    return 'assembly';
  }
  if (state.activeConstraintKind !== null) return 'constraints';
  return state.activeTool === 'select' ? 'viewport' : 'sketch-tools';
}
