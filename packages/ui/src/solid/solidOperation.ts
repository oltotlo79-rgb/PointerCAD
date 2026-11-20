import { liveBodyIds, type PartDocument } from '@pointercad/model';
import type { ExtrudeOperationSelection } from './extrudeOperation.js';
import { primitiveToolOf } from './primitiveCommands.js';

/** 作成時に結果と相手を選べる道具。 */
export function supportsSolidOperation(tool: string): boolean {
  return tool === 'extrude' || tool === 'revolve' || primitiveToolOf(tool) !== null;
}

/**
 * 選択の順番では決めない。位置と向きから提案はする(面を張らずに領域を押した時。`extrudeSuggestion.ts`)が、
 * 確定するのは利用者: ここは欄に入っている結果と相手(提案で入った物も、手で選んだ物も同じ)だけを読む。
 */
export function solidOperationSelection(
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
export function solidTargetCandidates(document: PartDocument): readonly { readonly value: string; readonly label: string }[] {
  const live = new Set(liveBodyIds(document));
  return document.solids.filter(feature => live.has(feature.id)).map(feature => ({ value: feature.id, label: feature.name }));
}
