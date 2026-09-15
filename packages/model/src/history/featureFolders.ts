import type { PartDocument } from '../part/types.js';
import { featureNoteTargetExists, featureNoteTargetKey, type FeatureNoteTarget } from './featureNotes.js';

export type FeatureFolderMember = FeatureNoteTarget | { readonly kind: 'folder'; readonly id: string };
export interface FeatureFolder {
  readonly id: string;
  readonly name: string;
  readonly children: readonly FeatureFolderMember[];
}
export const FEATURE_FOLDER_MAX_COUNT = 1_024;
export const FEATURE_FOLDER_MAX_DEPTH = 32;
export const FEATURE_FOLDER_NAME_MAX_LENGTH = 128;
export type FeatureFolderProblem = 'invalid-folder' | 'duplicate-folder' | 'duplicate-member'
  | 'missing-folder' | 'missing-feature' | 'cycle' | 'too-deep' | 'too-many';
export type FeatureFolderCheck = { readonly ok: true } | { readonly ok: false; readonly problem: FeatureFolderProblem };

export function featureFolderMemberKey(member: FeatureFolderMember): string {
  return member.kind === 'folder' ? JSON.stringify(['folder', member.id]) : featureNoteTargetKey(member);
}

/** 所属はchildrenだけを正本とし、親を重ねて記録しない。計算順序には触れない。 */
export function checkFeatureFolders(folders: readonly FeatureFolder[]): FeatureFolderCheck {
  if (folders.length > FEATURE_FOLDER_MAX_COUNT) return { ok: false, problem: 'too-many' };
  const byId = new Map<string, FeatureFolder>(), members = new Set<string>();
  for (const folder of folders) {
    if (folder.id === '' || folder.name.trim() === '' || folder.name.length > FEATURE_FOLDER_NAME_MAX_LENGTH) {
      return { ok: false, problem: 'invalid-folder' };
    }
    if (byId.has(folder.id)) return { ok: false, problem: 'duplicate-folder' };
    byId.set(folder.id, folder);
    for (const child of folder.children) {
      const key = featureFolderMemberKey(child);
      if (members.has(key)) return { ok: false, problem: 'duplicate-member' };
      members.add(key);
    }
  }
  for (const folder of folders) {
    for (const member of folder.children) {
      if (member.kind === 'folder' && !byId.has(member.id)) return { ok: false, problem: 'missing-folder' };
    }
  }
  // 根のない循環も全フォルダから辿る。深さ上限で再帰のスタックも制限する。
  const finished = new Map<string, number>(), visiting = new Set<string>();
  const height = (id: string, depth: number): number | FeatureFolderProblem => {
    if (visiting.has(id)) return 'cycle';
    if (depth > FEATURE_FOLDER_MAX_DEPTH) return 'too-deep';
    const known = finished.get(id);
    if (known !== undefined) return depth + known - 1 > FEATURE_FOLDER_MAX_DEPTH ? 'too-deep' : known;
    const folder = byId.get(id);
    if (folder === undefined) return 'missing-folder';
    visiting.add(id); let result = 1;
    for (const child of folder.children) {
      if (child.kind !== 'folder') continue;
      const childHeight = height(child.id, depth + 1);
      if (typeof childHeight !== 'number') return childHeight;
      result = Math.max(result, childHeight + 1);
    }
    visiting.delete(id); finished.set(id, result); return result;
  };
  for (const folder of folders) {
    const result = height(folder.id, 1);
    if (typeof result !== 'number') return { ok: false, problem: result };
  }
  return { ok: true };
}

export class FeatureFolderError extends Error {
  constructor(readonly problem: FeatureFolderProblem) { super(problem); this.name = 'FeatureFolderError'; }
}
function valid(folders: readonly FeatureFolder[]): void {
  const checked = checkFeatureFolders(folders);
  if (!checked.ok) throw new FeatureFolderError(checked.problem);
}
function targetExists(document: PartDocument, folders: readonly FeatureFolder[], member: FeatureFolderMember): void {
  if (member.kind === 'folder') {
    if (!folders.some(folder => folder.id === member.id)) throw new FeatureFolderError('missing-folder');
  } else if (!featureNoteTargetExists(document, member)) throw new FeatureFolderError('missing-feature');
}
function apply(document: PartDocument, folders: readonly FeatureFolder[]): PartDocument {
  valid(folders);
  return { ...document, featureFolders: folders };
}

/** フォルダの見かけの所属だけを変更し、元の図形配列の参照と順序を保持する。 */
export function moveFeatureFolderMember(document: PartDocument, member: FeatureFolderMember, parentId: string | null): PartDocument {
  const folders = document.featureFolders ?? []; valid(folders); targetExists(document, folders, member);
  if (parentId !== null && !folders.some(folder => folder.id === parentId)) throw new FeatureFolderError('missing-folder');
  const key = featureFolderMemberKey(member);
  const current = folders.find(folder => folder.children.some(child => featureFolderMemberKey(child) === key));
  if ((current?.id ?? null) === parentId) return document;
  const moved = folders.map(folder => {
    const kept = folder.children.filter(child => featureFolderMemberKey(child) !== key);
    const children = folder.id === parentId ? [...kept, { ...member }] : kept;
    return children.length === folder.children.length && folder.id !== parentId ? folder : { ...folder, children };
  });
  return apply(document, moved);
}

export function createFeatureFolder(document: PartDocument, name: string, parentId: string | null = null): PartDocument {
  const folders = document.featureFolders ?? []; valid(folders);
  let serial = 1;
  const ids = new Set(folders.map(folder => folder.id));
  while (ids.has(`folder-${serial}`)) serial += 1;
  const id = `folder-${serial}`;
  const created = apply(document, [...folders, { id, name: name.trim(), children: [] }]);
  return parentId === null ? created : moveFeatureFolderMember(created, { kind: 'folder', id }, parentId);
}

export function renameFeatureFolder(document: PartDocument, id: string, name: string): PartDocument {
  const folders = document.featureFolders ?? []; valid(folders);
  const folder = folders.find(item => item.id === id);
  if (folder === undefined) throw new FeatureFolderError('missing-folder');
  const value = name.trim();
  if (folder.name === value) return document;
  return apply(document, folders.map(item => item.id === id ? { ...item, name: value } : item));
}

/** フォルダだけを外す。子は親へ戻し、図形や入れ子のフォルダは削除しない。 */
export function removeFeatureFolder(document: PartDocument, id: string): PartDocument {
  const folders = document.featureFolders ?? []; valid(folders);
  const removed = folders.find(folder => folder.id === id);
  if (removed === undefined) throw new FeatureFolderError('missing-folder');
  return apply(document, folders.filter(folder => folder.id !== id).map(folder => {
    const index = folder.children.findIndex(child => child.kind === 'folder' && child.id === id);
    if (index < 0) return folder;
    return { ...folder, children: [...folder.children.slice(0, index), ...removed.children, ...folder.children.slice(index + 1)] };
  }));
}

/** 実際の図形削除と同じUndo単位で所属を整理し、読込み済みの孤立情報は勝手に消さない。 */
export function pruneRemovedFolderMembers(previous: PartDocument, next: PartDocument): PartDocument {
  if (!next.featureFolders?.length) return next;
  if (previous.solids === next.solids && previous.references === next.references && previous.sketches === next.sketches) return next;
  let changed = false;
  const folders = next.featureFolders.map(folder => {
    const children = folder.children.filter(child => child.kind === 'folder'
      || !featureNoteTargetExists(previous, child) || featureNoteTargetExists(next, child));
    if (children.length === folder.children.length) return folder;
    changed = true; return { ...folder, children };
  });
  return changed ? { ...next, featureFolders: folders } : next;
}
