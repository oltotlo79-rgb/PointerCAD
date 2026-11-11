import { liveBodyIds, type PartDocument } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

export type ExtrudeOperation = 'new' | 'join' | 'cut';

export type ExtrudeOperationSelection =
  | { readonly ok: true; readonly operation: 'new' }
  | { readonly ok: true; readonly operation: 'union' | 'subtract'; readonly targetFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** Explicit target only: selection order never chooses a body on the user's behalf. */
export function extrudeOperationSelection(
  document: PartDocument,
  operation: string | undefined,
  targetFeatureId: string | undefined,
): ExtrudeOperationSelection {
  if (operation === undefined || operation === 'new') return { ok: true, operation: 'new' };
  if (operation !== 'join' && operation !== 'cut') return { ok: false, reasonKey: 'shapeError.unknownChoice' };
  if (targetFeatureId === undefined || targetFeatureId === '') {
    return { ok: false, reasonKey: 'solidError.extrudeTargetRequired' };
  }
  const matches = liveBodyIds(document).filter(id => id === targetFeatureId);
  if (matches.length !== 1) return { ok: false, reasonKey: 'solidError.extrudeTargetUnavailable' };
  return { ok: true, operation: operation === 'join' ? 'union' : 'subtract', targetFeatureId };
}

/** Live, unconsumed bodies; display names are the normal editable feature names. */
export function extrudeTargetCandidates(document: PartDocument): readonly { readonly value: string; readonly label: string }[] {
  const live = new Set(liveBodyIds(document));
  return document.solids.filter(feature => live.has(feature.id)).map(feature => ({ value: feature.id, label: feature.name }));
}
