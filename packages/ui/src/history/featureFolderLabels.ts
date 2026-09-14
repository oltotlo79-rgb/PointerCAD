import type { FeatureFolder } from '@pointercad/model';
import { t } from '../i18n/t.js';

/** 同名の兄弟にも表示上の番号を付け、移動先とツリーを同じ名前で識別する。 */
export function featureFolderLabels(folders: readonly FeatureFolder[]): ReadonlyMap<string, { readonly name: string; readonly path: string }> {
  const parents = new Map<string, string>(), names = new Map<string, string>();
  for (const folder of folders) for (const child of folder.children) if (child.kind === 'folder') parents.set(child.id, folder.id);
  for (const folder of folders) {
    const siblings = folders.filter(other => parents.get(other.id) === parents.get(folder.id));
    if (siblings.filter(other => other.name === folder.name).length === 1) { names.set(folder.id, folder.name); continue; }
    const occupied = new Set(siblings.flatMap(other => [other.name, names.get(other.id) ?? '']));
    let index = 1, label: string;
    do {
      label = t('historyFolder.duplicateName').replace('{name}', folder.name).replace('{index}', String(index));
      index += 1;
    } while (occupied.has(label));
    names.set(folder.id, label);
  }
  const path = (id: string): string => {
    const parent = parents.get(id), name = names.get(id) ?? '';
    const segment = /["/\\\r\n]/u.test(name) ? JSON.stringify(name) : name;
    return parent === undefined ? segment : `${path(parent)} / ${segment}`;
  };
  return new Map(folders.map(folder => [folder.id, { name: names.get(folder.id) ?? folder.name, path: path(folder.id) }]));
}
