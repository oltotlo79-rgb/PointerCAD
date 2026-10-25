import { drawingDimensionContext, resolveDrawingGdt, resolveDrawingWelds } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';
import { t } from '../i18n/t.js';

/** Consumer validity is separate from whether its saved shape reference is unique. */
export function repairConsumerIssues(state: AppState): ReadonlyMap<string, string> {
  const issues = new Map<string, string>(), active = activeDocument(state);
  const add = (id: string, messages: readonly string[]): void => {
    if (messages.length > 0) issues.set(id, [issues.get(id), ...messages].filter(message => message !== undefined).join(' / '));
  };
  if (active.kind === 'part') {
    for (const error of state.partErrors) add(error.featureId, [error.message]);
  } else if (active.kind === 'assembly') {
    for (const [id, messages] of state.assemblyView?.mateTargetErrors ?? []) add(id, messages);
    for (const [id, messages] of state.assemblyView?.jointTargetErrors ?? []) add(id, messages);
  } else if (state.drawingResolution?.ok === true && state.drawingSourceResolution !== null) {
    for (const result of state.drawingResolution.dimensions) if (result.status === 'unresolved') add(result.dimension.id,
      [t(result.reason === 'view' ? 'propertyPanel.repair.dimensionView'
        : result.reason === 'measurement' ? 'propertyPanel.repair.dimensionMeasurement' : 'propertyPanel.repair.dimensionTarget')]);
    const context = drawingDimensionContext(state.drawingSourceResolution);
    const gdt = resolveDrawingGdt(active.document, context);
    for (const result of gdt.datums) add(result.datum.id, result.issues.map(issue => issue.message));
    for (const result of gdt.frames) add(result.frame.id, result.issues.map(issue => issue.message));
    for (const result of resolveDrawingWelds(active.document, context)) add(result.symbol.id, result.issues.map(issue => issue.message));
  }
  return issues;
}
