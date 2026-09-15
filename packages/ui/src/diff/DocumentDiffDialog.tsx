import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentDefinitionComparison, DocumentDefinitionChange, DocumentRelationship, DefinitionDifference } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { runDefinitionDiff } from './definitionDiffClient.js';
import { createDefinitionDiffWorker } from './browserDefinitionDiffWorker.js';
import { pickComparisonFile, type ComparisonFile, type DefinitionDiffExecutor } from './pickComparisonFile.js';
import './documentDiff.css';
import { MaterialDiffPanel } from './MaterialDiffPanel.js';

const execute: DefinitionDiffExecutor = (request, signal) => runDefinitionDiff(request, signal, createDefinitionDiffWorker);
const FIELD_NAMES: Readonly<Record<string, MessageKey>> = {
  name: 'documentDiff.field.name', suppressed: 'documentDiff.field.suppressed', visible: 'documentDiff.field.visible',
  shape: 'documentDiff.field.shape', kind: 'documentDiff.field.kind', sizeX: 'documentDiff.field.x', sizeY: 'documentDiff.field.y', sizeZ: 'documentDiff.field.z',
  x: 'documentDiff.field.x', y: 'documentDiff.field.y', z: 'documentDiff.field.z', radius: 'documentDiff.field.radius',
  diameter: 'documentDiff.field.diameter', height: 'documentDiff.field.height', width: 'documentDiff.field.width',
  depth: 'documentDiff.field.depth', distance: 'documentDiff.field.distance', length: 'documentDiff.field.length',
  angle: 'documentDiff.field.angle', rotation: 'documentDiff.field.angle', value: 'documentDiff.field.value',
  unit: 'documentDiff.field.unit', description: 'documentDiff.field.description', text: 'documentDiff.field.note',
  children: 'documentDiff.field.members', order: 'documentDiff.field.order', origin: 'documentDiff.field.origin',
  constraints: 'documentDiff.field.constraints', activeConfigurationId: 'documentDiff.field.configuration',
};
function fieldName(path: readonly string[]): string {
  return path.length === 0 ? t('documentDiff.field.content') : path.map(segment => {
    const key = FIELD_NAMES[segment]; return key === undefined ? segment : t(key);
  }).join(' / ');
}
function Difference({ difference }: { readonly difference: DefinitionDifference }): React.JSX.Element {
  return <li>
    <p><strong>{fieldName(difference.path)}</strong> · {t(`documentDiff.difference.${difference.kind}`)}</p>
    <dl><dt>{t('documentDiff.before')}</dt><dd><pre>{difference.before}</pre>
      {difference.beforeStoredValue === undefined ? null : <small>{t('documentDiff.storedValue')}: {difference.beforeStoredValue}</small>}</dd>
    <dt>{t('documentDiff.after')}</dt><dd><pre>{difference.after}</pre>
      {difference.afterStoredValue === undefined ? null : <small>{t('documentDiff.storedValue')}: {difference.afterStoredValue}</small>}</dd></dl>
  </li>;
}
function Change({ change }: { readonly change: DocumentDefinitionChange }): React.JSX.Element {
  return <li className={`pcad-document-diff__change pcad-document-diff__change--${change.status}`} data-diff-status={change.status}>
    <h3><span>{t(`documentDiff.status.${change.status}`)}</span> {t(`documentDiff.group.${change.group}`)}: {change.afterName || change.beforeName || t('documentDiff.field.content')}</h3>
    {change.beforeName !== null && change.afterName !== null && change.beforeName !== change.afterName
      ? <p>{change.beforeName} → {change.afterName}</p> : null}
    {change.ownerName === '' ? null : <small>{t('documentDiff.owner')}: {change.ownerName}</small>}
    {change.differences.length === 0 ? null : <details><summary>{t('documentDiff.details')} ({change.differences.length})</summary>
      <ol>{change.differences.map((difference, index) => <Difference key={index} difference={difference} />)}</ol></details>}
  </li>;
}

export function DocumentDiffDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const element = useRef<HTMLDialogElement>(null), controller = useRef<AbortController | null>(null);
  const titleId = useId(), relationId = useId();
  const [before, setBefore] = useState<ComparisonFile | null>(null), [after, setAfter] = useState<ComparisonFile | null>(null);
  const [relationship, setRelationship] = useState<DocumentRelationship | ''>('');
  const [busy, setBusy] = useState<'before' | 'after' | 'compare' | null>(null);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string } | null>(null);
  const [result, setResult] = useState<DocumentDefinitionComparison | null>(null), [page, setPage] = useState(0);
  useEffect(() => {
    const dialog = element.current, previous = document.activeElement;
    dialog?.showModal(); dialog?.querySelector<HTMLElement>('button')?.focus();
    return () => { controller.current?.abort(); controller.current = null; dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const close = (): void => { controller.current?.abort(); onClose(); };
  const selectFile = async (side: 'before' | 'after'): Promise<void> => {
    controller.current?.abort(); const operation = new AbortController(); controller.current = operation;
    setBusy(side); setMessage(null);
    try {
      const selected = await pickComparisonFile(useAppStore.getState().fileGateway, operation.signal, execute);
      if (controller.current !== operation || operation.signal.aborted) return;
      if (selected.status === 'failed') setMessage({ error: true, text: selected.message });
      else if (selected.status === 'ready') {
        if (side === 'before') setBefore(selected.file); else setAfter(selected.file);
        setResult(null); setRelationship(''); setPage(0);
      }
    } finally { if (controller.current === operation) { controller.current = null; if (!operation.signal.aborted) setBusy(null); } }
  };
  const compare = async (): Promise<void> => {
    if (before === null || after === null || relationship === '' || busy !== null) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy('compare'); setMessage(null); setResult(null); setPage(0);
    try {
      const outcome = await execute({ kind: 'compare', before: before.bytes, after: after.bytes, relationship }, operation.signal);
      if (controller.current !== operation || operation.signal.aborted) return;
      if (!outcome.ok) setMessage({ error: true, text: t(outcome.reason === 'timeout' ? 'documentDiff.timeout' : 'documentDiff.failed') });
      else if (outcome.reply.kind === 'failed') setMessage({ error: true, text: outcome.reply.message });
      else if (outcome.reply.kind === 'compared') setResult(outcome.reply.result);
      else setMessage({ error: true, text: t('documentDiff.failed') });
    } finally { if (controller.current === operation) { controller.current = null; if (!operation.signal.aborted) setBusy(null); } }
  };
  const cancel = (): void => {
    controller.current?.abort(); controller.current = null; setBusy(null);
    setMessage({ error: false, text: t('documentDiff.cancelled') });
  };
  const pageSize = 50, changes = result?.changes ?? [];
  return <dialog ref={element} className="pcad-document-diff" aria-labelledby={titleId} data-help-topic="document-diff"
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="pcad-document-diff__definition">
    <header><h2 id={titleId}>{t('documentDiff.title')}</h2><button type="button" onClick={close} title={t('documentDiff.close')}>{t('documentDiff.close')}</button></header>
    <p>{t('documentDiff.intro')}</p>
    <div className="pcad-document-diff__files">{(['before', 'after'] as const).map(side => {
      const file = side === 'before' ? before : after;
      return <section key={side} aria-label={t(`documentDiff.${side}`)}><h3>{t(`documentDiff.${side}`)}</h3>
        <button type="button" disabled={busy !== null} title={t(`documentDiff.pick.${side}`)} onClick={() => { void selectFile(side); }}>{t(`documentDiff.pick.${side}`)}</button>
        <p>{file === null ? t('documentDiff.unselected') : file.fileName}</p>
        {file === null ? null : <p>{file.documentName}</p>}
      </section>;
    })}</div>
    <label htmlFor={relationId}>{t('documentDiff.relationship')}</label>
    <select id={relationId} value={relationship} disabled={busy !== null} onChange={event => {
      const value = event.currentTarget.value;
      if (value === '' || value === 'versions' || value === 'unrelated') { setRelationship(value); setResult(null); setPage(0); }
    }}><option value="">{t('documentDiff.chooseRelationship')}</option><option value="versions">{t('documentDiff.versions')}</option><option value="unrelated">{t('documentDiff.unrelated')}</option></select>
    <p>{t('documentDiff.relationshipHint')}</p>
    <div className="pcad-document-diff__actions"><button type="button" title={t('documentDiff.compare')}
      disabled={before === null || after === null || relationship === '' || busy !== null} onClick={() => { void compare(); }}>{t('documentDiff.compare')}</button>
      {busy === null ? null : <><span role="status">{t(busy === 'compare' ? 'documentDiff.comparing' : 'documentDiff.reading')}</span><button type="button" title={t('documentDiff.cancel')} onClick={cancel}>{t('documentDiff.cancel')}</button></>}
      <button type="button" title={t('documentDiff.help')} onClick={() => useAppStore.getState().openHelpTopic('document-diff')}>{t('documentDiff.help')}</button>
    </div>
    {message === null ? null : <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {result === null ? null : <section aria-label={t('documentDiff.results')}>
      <h3>{t('documentDiff.results')}</h3><p role="status">{changes.length === 0 ? t('documentDiff.noChanges') : t('documentDiff.summary')
        .replace('{added}', String(changes.filter(change => change.status === 'added').length))
        .replace('{removed}', String(changes.filter(change => change.status === 'removed').length))
        .replace('{changed}', String(changes.filter(change => change.status === 'changed').length))}</p>
      <p>{t('documentDiff.geometryNotice')}</p>
      <ol className="pcad-document-diff__changes">{changes.slice(page * pageSize, (page + 1) * pageSize).map(change => <Change key={change.key} change={change} />)}</ol>
      {changes.length <= pageSize ? null : <nav aria-label={t('documentDiff.pages')}>
        <button type="button" disabled={page === 0} title={t('documentDiff.previous')} onClick={() => setPage(page - 1)}>{t('documentDiff.previous')}</button>
        <span>{page + 1} / {Math.ceil(changes.length / pageSize)}</span>
        <button type="button" disabled={(page + 1) * pageSize >= changes.length} title={t('documentDiff.next')} onClick={() => setPage(page + 1)}>{t('documentDiff.next')}</button>
      </nav>}
    </section>}
    </div>
    {result === null || before === null || after === null ? null : <MaterialDiffPanel beforeBytes={before.bytes} afterBytes={after.bytes} />}
  </dialog>;
}
