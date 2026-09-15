import { Fragment, type ReactNode } from 'react';
import { featureFolderMemberKey, type FeatureFolder, type FeatureFolderMember } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { featureFolderLabels } from './featureFolderLabels.js';
import './featureFolders.css';

export function FeatureFolderTree({ folders, collapsed, onToggle, renderMember, onEdit }: {
  readonly folders: readonly FeatureFolder[];
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly renderMember: (member: Exclude<FeatureFolderMember, { readonly kind: 'folder' }>) => ReactNode;
  readonly onEdit: (folder: FeatureFolder) => void;
}): React.JSX.Element {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const labels = featureFolderLabels(folders);
  const nested = new Set(folders.flatMap(folder => folder.children.flatMap(child => child.kind === 'folder' ? [child.id] : [])));
  const render = (folder: FeatureFolder): React.JSX.Element => {
    const open = !collapsed.has(folder.id);
    return <li key={folder.id} className="pcad-feature-folder" data-feature-folder-id={folder.id}>
      <div className="pcad-feature-folder__heading">
        <button type="button" aria-expanded={open} title={t('historyFolder.toggle')} onClick={() => onToggle(folder.id)}>{labels.get(folder.id)?.name ?? folder.name}<span aria-hidden="true">{open ? ' ▾' : ' ▸'}</span></button>
        <button type="button" title={t('historyFolder.edit')} aria-label={t('historyFolder.editNamed').replace('{name}', labels.get(folder.id)?.name ?? folder.name)}
          onClick={() => onEdit(folder)}>{t('historyFolder.edit')}</button>
      </div>
      {open ? <ul className="pcad-feature-folder__children">{folder.children.length === 0
        ? <li className="pcad-tree__hint">{t('historyFolder.empty')}</li>
        : folder.children.map(member => {
          if (member.kind !== 'folder') return <Fragment key={featureFolderMemberKey(member)}>{renderMember(member)}</Fragment>;
          const child = byId.get(member.id);
          return child === undefined ? null : render(child);
        })}</ul> : null}
    </li>;
  };
  return <li data-help-topic="history-notes"><ul className="pcad-feature-folders">{folders.filter(folder => !nested.has(folder.id)).map(render)}</ul></li>;
}
