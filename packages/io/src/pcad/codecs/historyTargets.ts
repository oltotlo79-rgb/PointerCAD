import { featureNoteTargetExists, type PartDocument } from '@pointercad/model';

/** 存在しない対象を後から作った同IDの図形へ誤って結び付けない。 */
export function missingHistoryTarget(document: PartDocument, path: string): string | null {
  for (const [index, note] of (document.featureNotes ?? []).entries()) {
    if (!featureNoteTargetExists(document, note.target)) return `${path}.featureNotes[${index}].target`;
  }
  for (const [index, folder] of (document.featureFolders ?? []).entries()) {
    for (const [childIndex, child] of folder.children.entries()) {
      if (child.kind !== 'folder' && !featureNoteTargetExists(document, child)) return `${path}.featureFolders[${index}].children[${childIndex}]`;
    }
  }
  return null;
}
