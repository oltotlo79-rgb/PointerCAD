import { featureFolderMemberKey, type FeatureFolder, type FeatureNoteTarget } from '@pointercad/model';

/** 検索で選んだ行の所属だけを開く。スケッチに含まれる行は親スケッチの所属も辿る。 */
export function featureFolderAncestors(folders: readonly FeatureFolder[], target: FeatureNoteTarget): ReadonlySet<string> {
  const parents = new Map(folders.flatMap(folder => folder.children.map(child => [featureFolderMemberKey(child), folder.id] as const)));
  let parent = parents.get(featureFolderMemberKey(target));
  if (parent === undefined && target.kind === 'sketch-feature') parent = parents.get(featureFolderMemberKey({ kind: 'sketch', id: target.sketchId }));
  const result = new Set<string>();
  while (parent !== undefined && !result.has(parent)) {
    result.add(parent); parent = parents.get(featureFolderMemberKey({ kind: 'folder', id: parent }));
  }
  return result;
}
