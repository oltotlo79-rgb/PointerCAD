import { checkFeatureFolders, FEATURE_FOLDER_MAX_COUNT, type FeatureFolder, type FeatureFolderMember } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, joinPath, readString, type Checked } from '../guards.js';
import { readHistoryFeatureTarget } from './featureNotes.js';

function readMember(value: unknown, path: string): Checked<FeatureFolderMember> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  if (record.value.kind !== 'folder') return readHistoryFeatureTarget(value, path);
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  return id.value === '' ? fieldProblem(joinPath(path, 'id'), 'type') : { ok: true, value: { kind: 'folder', id: id.value } };
}

export function readFeatureFolders(value: unknown, path: string): Checked<readonly FeatureFolder[]> {
  if (!Array.isArray(value) || value.length > FEATURE_FOLDER_MAX_COUNT) return fieldProblem(path, 'type');
  const folders: FeatureFolder[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const location = indexPath(path, i), item: unknown = value[i], record = checkRecord(item, location);
    if (!record.ok) return record;
    const id = readString(record.value, 'id', location), name = readString(record.value, 'name', location);
    if (!id.ok) return id;
    if (!name.ok) return name;
    const rawChildren = record.value.children, children: FeatureFolderMember[] = [];
    if (!Array.isArray(rawChildren)) return fieldProblem(joinPath(location, 'children'), 'type');
    for (let j = 0; j < rawChildren.length; j += 1) {
      const child: unknown = rawChildren[j];
      const member = readMember(child, indexPath(joinPath(location, 'children'), j));
      if (!member.ok) return member;
      children.push(member.value);
    }
    folders.push({ id: id.value, name: name.value, children });
  }
  return checkFeatureFolders(folders).ok ? { ok: true, value: folders } : fieldProblem(path, 'type');
}

export function serializeFeatureFolders(folders: readonly FeatureFolder[]): readonly FeatureFolder[] {
  const checked = readFeatureFolders(folders, 'featureFolders');
  if (!checked.ok) throw new RangeError('履歴フォルダの内容を保存できません。');
  return checked.value;
}
