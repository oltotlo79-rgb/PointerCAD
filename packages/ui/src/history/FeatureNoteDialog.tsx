import { useEffect, useId, useRef, useState } from 'react';
import { FEATURE_NOTE_MAX_LENGTH, featureNoteOf, featureNoteTargetExists, setFeatureNote, type FeatureNoteTarget } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import './featureNotes.css';

export interface FeatureNoteDraft {
  readonly target: FeatureNoteTarget;
  readonly name: string;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly original: string;
}

/** 入力中の焦点をメモ内へ保ち、閉じる際には元の操作対象へ戻す。 */
export function FeatureNoteDialog({ draft, onClose }: { readonly draft: FeatureNoteDraft; readonly onClose: () => void }): React.JSX.Element {
  const element = useRef<HTMLDialogElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId(), inputId = useId(), helpId = useId();
  const [text, setText] = useState(draft.original), [conflict, setConflict] = useState(false);
  const tooLong = text.length > FEATURE_NOTE_MAX_LENGTH;
  useEffect(() => {
    const dialog = element.current, previous = document.activeElement;
    dialog?.showModal(); input.current?.focus();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const commit = (value: string): void => {
    const state = useAppStore.getState();
    if (state.document.id !== draft.documentId || state.documentVersion !== draft.documentVersion
      || !featureNoteTargetExists(state.document, draft.target)) { onClose(); return; }
    if (featureNoteOf(state.document, draft.target) !== draft.original) { setConflict(true); return; }
    if (value.length > FEATURE_NOTE_MAX_LENGTH) return;
    const next = setFeatureNote(state.document, draft.target, value);
    if (next !== state.document) state.applyDocument(next);
    onClose();
  };
  return <dialog ref={element} className="pcad-feature-note" aria-labelledby={titleId} data-help-topic="history-notes"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === 'F1') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().openHelpTopic('history-notes'); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); commit(text);
      }
    }}>
    <form onSubmit={event => { event.preventDefault(); commit(text); }}>
      <h2 id={titleId}>{t('historyNote.title')}</h2>
      <p className="pcad-feature-note__target">{draft.name}</p>
      <label htmlFor={inputId}>{t('historyNote.label')}</label>
      <textarea title={t('historyNote.hint').replace('{max}', String(FEATURE_NOTE_MAX_LENGTH))} id={inputId} ref={input} value={text} rows={8} aria-describedby={helpId} aria-invalid={tooLong}
        onChange={event => setText(event.currentTarget.value)} />
      <p id={helpId}>{t('historyNote.hint').replace('{max}', String(FEATURE_NOTE_MAX_LENGTH))}</p>
      {tooLong ? <p role="alert">{t('historyNote.tooLong').replace('{max}', String(FEATURE_NOTE_MAX_LENGTH))}</p> : null}
      {conflict ? <p role="alert">{t('historyNote.conflict')}</p> : null}
      <footer>
        <button type="button" title={t('historyNote.help')} onClick={() => useAppStore.getState().openHelpTopic('history-notes')}>{t('historyNote.help')}</button>
        {draft.original === '' ? null : <button type="button" title={t('historyNote.delete')} onClick={() => commit('')}>{t('historyNote.delete')}</button>}
        <button type="button" title={t('historyNote.cancel')} onClick={onClose}>{t('historyNote.cancel')}</button>
        <button type="submit" title={t('historyNote.apply')} disabled={tooLong || conflict}>{t('historyNote.apply')}</button>
      </footer>
    </form>
  </dialog>;
}
