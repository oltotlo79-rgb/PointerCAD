import type { PartDocument } from '../part/types.js';

/** 所属を含めて対象を識別し、別スケッチの同じIDへメモを移さない。 */
export type FeatureNoteTarget =
  | { readonly kind: 'solid' | 'reference' | 'sketch'; readonly id: string }
  | { readonly kind: 'sketch-feature'; readonly sketchId: string; readonly id: string };
export interface FeatureNote { readonly target: FeatureNoteTarget; readonly text: string }
export const FEATURE_NOTE_MAX_LENGTH = 16_384;

export function featureNoteTargetKey(target: FeatureNoteTarget): string {
  return JSON.stringify(target.kind === 'sketch-feature'
    ? [target.kind, target.sketchId, target.id] : [target.kind, target.id]);
}
export function featureNoteTargetExists(document: PartDocument, target: FeatureNoteTarget): boolean {
  switch (target.kind) {
    case 'solid': return document.solids.some(feature => feature.id === target.id);
    case 'reference': return document.references.some(feature => feature.id === target.id);
    case 'sketch': return document.sketches.some(sketch => sketch.id === target.id);
    case 'sketch-feature': return document.sketches.some(sketch => sketch.id === target.sketchId
      && sketch.features.some(feature => feature.id === target.id));
  }
}
export function featureNoteOf(document: PartDocument, target: FeatureNoteTarget): string {
  const key = featureNoteTargetKey(target);
  return document.featureNotes?.find(note => featureNoteTargetKey(note.target) === key)?.text ?? '';
}
export function setFeatureNote(document: PartDocument, target: FeatureNoteTarget, text: string): PartDocument {
  if (!featureNoteTargetExists(document, target)) throw new RangeError('メモの対象が見つかりません。');
  if (text.length > FEATURE_NOTE_MAX_LENGTH) throw new RangeError('メモの文字数が上限を超えています。');
  const value = text.trim() === '' ? '' : text;
  if (featureNoteOf(document, target) === value) return document;
  const key = featureNoteTargetKey(target), previous = document.featureNotes ?? [];
  const kept = previous.filter(note => featureNoteTargetKey(note.target) !== key);
  const featureNotes = value === '' ? kept : [...kept, { target: { ...target }, text: value }];
  return { ...document, featureNotes };
}
/** この編集で削除した対象のメモだけを除き、対象の削除と一度でUndoできるようにする。 */
export function pruneRemovedFeatureNotes(previous: PartDocument, next: PartDocument): PartDocument {
  if (!next.featureNotes?.length) return next;
  if (previous.solids === next.solids && previous.references === next.references && previous.sketches === next.sketches) return next;
  const kept = next.featureNotes.filter(note => !featureNoteTargetExists(previous, note.target)
    || featureNoteTargetExists(next, note.target));
  return kept.length === next.featureNotes.length ? next : { ...next, featureNotes: kept };
}
