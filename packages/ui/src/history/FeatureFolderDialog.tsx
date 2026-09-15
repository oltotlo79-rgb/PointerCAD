import { useEffect, useId, useRef, useState } from 'react';
import { createFeatureFolder, FEATURE_FOLDER_NAME_MAX_LENGTH, FeatureFolderError, featureFolderMemberKey,
  moveFeatureFolderMember, removeFeatureFolder, renameFeatureFolder, type FeatureFolder, type FeatureFolderMember,
  type FeatureFolderProblem, type FeatureNoteTarget } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { featureFolderLabels } from './featureFolderLabels.js';
import './featureNotes.css';

export type FeatureFolderDraft = {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly originalFolders: string;
} & ({ readonly mode: 'create' } | { readonly mode: 'edit'; readonly folderId: string }
  | { readonly mode: 'move'; readonly target: FeatureNoteTarget; readonly name: string });

function descendantIds(folders: readonly FeatureFolder[], id: string): ReadonlySet<string> {
  const byId = new Map(folders.map(folder => [folder.id, folder])), result = new Set<string>(), pending = [id];
  while (pending.length !== 0) {
    const next = pending.pop(); if (next === undefined || result.has(next)) continue;
    result.add(next);
    for (const child of byId.get(next)?.children ?? []) if (child.kind === 'folder') pending.push(child.id);
  }
  return result;
}

export function FeatureFolderDialog({ draft, onClose }: {
  readonly draft: FeatureFolderDraft;
  readonly onClose: () => void;
}): React.JSX.Element {
  const document = useAppStore(state => state.document), folders = document.featureFolders ?? [];
  const target: FeatureFolderMember | null = draft.mode === 'create' ? null : draft.mode === 'edit'
    ? { kind: 'folder', id: draft.folderId } : draft.target;
  const initial = draft.mode === 'edit' ? folders.find(folder => folder.id === draft.folderId) : undefined;
  const [name, setName] = useState(initial?.name ?? '');
  const [parentId, setParentId] = useState(() => target === null ? '' : folders.find(folder =>
    folder.children.some(child => featureFolderMemberKey(child) === featureFolderMemberKey(target)))?.id ?? '');
  const [problem, setProblem] = useState<FeatureFolderProblem | 'conflict' | null>(null);
  const element = useRef<HTMLDialogElement>(null), titleId = useId(), nameId = useId(), parentIdInput = useId();
  const excluded = draft.mode === 'edit' ? descendantIds(folders, draft.folderId) : new Set<string>();
  const labels = featureFolderLabels(folders);
  const invalidName = draft.mode !== 'move' && (name.trim() === '' || name.length > FEATURE_FOLDER_NAME_MAX_LENGTH);
  useEffect(() => {
    const dialog = element.current, previous = globalThis.document.activeElement;
    dialog?.showModal(); dialog?.querySelector<HTMLElement>('input, select')?.focus();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const commit = (remove = false): void => {
    const state = useAppStore.getState();
    if (state.document.id !== draft.documentId || state.documentVersion !== draft.documentVersion) { onClose(); return; }
    if (JSON.stringify(state.document.featureFolders ?? []) !== draft.originalFolders) { setProblem('conflict'); return; }
    try {
      const parent = parentId === '' ? null : parentId;
      const next = draft.mode === 'create' ? createFeatureFolder(state.document, name, parent)
        : draft.mode === 'move' ? moveFeatureFolderMember(state.document, draft.target, parent)
          : remove ? removeFeatureFolder(state.document, draft.folderId)
            : moveFeatureFolderMember(renameFeatureFolder(state.document, draft.folderId, name), { kind: 'folder', id: draft.folderId }, parent);
      if (next !== state.document) state.applyDocument(next);
      onClose();
    } catch (error) {
      if (!(error instanceof FeatureFolderError)) throw error;
      setProblem(error.problem);
    }
  };
  return <dialog ref={element} className="pcad-feature-note" aria-labelledby={titleId} data-help-topic="history-notes"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); if (!invalidName) commit();
      }
    }}>
    <form onSubmit={event => { event.preventDefault(); if (!invalidName) commit(); }}>
      <h2 id={titleId}>{t(draft.mode === 'move' ? 'historyFolder.moveTitle' : 'historyFolder.title')}</h2>
      {draft.mode === 'move' ? <p>{draft.name}</p> : <>
        <label htmlFor={nameId}>{t('historyFolder.name')}</label>
        <input title={t('historyFolder.nameHint').replace('{max}', String(FEATURE_FOLDER_NAME_MAX_LENGTH))} id={nameId} value={name} aria-invalid={invalidName} onChange={event => { setName(event.currentTarget.value); setProblem(null); }} />
        <p>{t('historyFolder.nameHint').replace('{max}', String(FEATURE_FOLDER_NAME_MAX_LENGTH))}</p>
      </>}
      <label htmlFor={parentIdInput}>{t('historyFolder.parent')}</label>
      <select title={t('controlGuide.folder.parent')} id={parentIdInput} value={parentId} onChange={event => { setParentId(event.currentTarget.value); setProblem(null); }}>
        <option value="">{t('historyFolder.root')}</option>
        {folders.map(folder => <option key={folder.id} value={folder.id} disabled={excluded.has(folder.id)}>{labels.get(folder.id)?.path ?? folder.name}</option>)}
      </select>
      <p>{t('historyFolder.orderHint')}</p>
      {problem === null ? null : <p role="alert">{t(`historyFolder.problem.${problem}`)}</p>}
      <footer>
        <button type="button" title={t('historyNote.help')} onClick={() => useAppStore.getState().openHelpTopic('history-notes')}>{t('historyNote.help')}</button>
        {draft.mode === 'edit' ? <button type="button" title={t('historyFolder.removeHint')} onClick={() => commit(true)}>{t('historyFolder.remove')}</button> : null}
        <button type="button" title={t('historyNote.cancel')} onClick={onClose}>{t('historyNote.cancel')}</button>
        <button type="submit" title={t('historyFolder.apply')} disabled={invalidName || problem === 'conflict'}>{t('historyFolder.apply')}</button>
      </footer>
    </form>
  </dialog>;
}
