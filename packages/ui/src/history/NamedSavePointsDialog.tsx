import { useEffect, useId, useRef, useState } from 'react';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { DocumentDiffDialog } from '../diff/DocumentDiffDialog.js';
import { ComparisonLimitError, createNamedSavePointActions, type NamedSavePointActions, type SavePointComparison } from './namedSavePointActions.js';
import { SavePointError, type NamedSavePoint, type SavePointErrorCode, type SavePointKind } from './namedSavePoints.js';
import './NamedSavePointsDialog.css';

export interface NamedSavePointsLabels {
  readonly title: string;
  readonly name: string;
  readonly create: string;
  readonly clone: string;
  readonly compare: string;
  readonly restore: string;
  readonly before: string;
  readonly after: string;
  readonly close: string;
  readonly cancel: string;
  readonly empty: string;
  readonly busy: string;
  readonly cancelled: string;
  readonly restored: string;
  /** 件数と容量の上限の案内。 */
  readonly limits: string;
  readonly kinds: Readonly<Record<SavePointKind, string>>;
  /** 各操作欄の説明(title)。操作の結果と、文書へ与える影響を短く書く。 */
  readonly hints: Readonly<Record<'close' | 'name' | 'create' | 'select' | 'clone' | 'before' | 'after' | 'compare' | 'restore' | 'restoreKind' | 'cancel', string>>;
  readonly errors: Readonly<Record<SavePointErrorCode, string>>;
}

export function NamedSavePointsDialog({ onClose, labels, actions: suppliedActions }: {
  readonly onClose: () => void;
  readonly labels: NamedSavePointsLabels;
  readonly actions?: NamedSavePointActions;
}): React.JSX.Element {
  const [defaultActions] = useState(createNamedSavePointActions);
  const actions = suppliedActions ?? defaultActions;
  const element = useRef<HTMLDialogElement>(null), operation = useRef<AbortController | null>(null);
  const latestLabels = useRef(labels);
  latestLabels.current = labels;
  const nameId = useId(), titleId = useId();
  const [name, setName] = useState(''), [points, setPoints] = useState<readonly NamedSavePoint[]>([]);
  const [selectedId, setSelectedId] = useState(''), [beforeId, setBeforeId] = useState(''), [afterId, setAfterId] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const activeKind = useAppStore(state => activeDocumentKind(state));
  const [comparison, setComparison] = useState<SavePointComparison | null>(null);

  useEffect(() => {
    const dialog = element.current, previous = document.activeElement;
    dialog?.showModal(); dialog?.querySelector<HTMLElement>('input')?.focus();
    return () => {
      operation.current?.abort(); operation.current = null; dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); operation.current = controller;
    setBusy(true);
    void actions.list(controller.signal).then(items => {
      if (operation.current !== controller || controller.signal.aborted) return;
      setPoints(items); setSelectedId(items[0]?.id ?? '');
    }).catch(error => {
      if (operation.current === controller && !controller.signal.aborted)
        setMessage({ text: error instanceof SavePointError ? latestLabels.current.errors[error.reason]
          : latestLabels.current.errors.unavailable, error: true });
    }).finally(() => {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    });
    return () => controller.abort();
  }, [actions]);

  const stop = (): void => {
    operation.current?.abort(); operation.current = null; setBusy(false);
    setMessage({ text: labels.cancelled, error: false });
  };
  const close = (): void => { operation.current?.abort(); operation.current = null; onClose(); };
  const run = async (task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setMessage(null);
    try { await task(controller.signal); }
    catch (error) {
      if (operation.current === controller && !controller.signal.aborted)
        setMessage({ text: error instanceof ComparisonLimitError ? error.message
          : error instanceof SavePointError ? labels.errors[error.reason] : labels.errors.unavailable, error: true });
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    }
  };
  const selected = points.find(point => point.id === selectedId);
  const hasSelection = selected !== undefined;
  const restorable = selected !== undefined && selected.kind === activeKind;
  return <>
    <dialog ref={element} className="pcad-named-save-points" aria-labelledby={titleId}
      data-help-topic="save-and-open" title={labels.title}
      onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2 id={titleId}>{labels.title}</h2><button type="button" title={labels.hints.close} onClick={close}>{labels.close}</button></header>
      <p>{labels.limits}</p>
      <label htmlFor={nameId}>{labels.name}</label>
      <input id={nameId} title={labels.hints.name} value={name} maxLength={128} onChange={event => setName(event.currentTarget.value)} />
      <button type="button" title={labels.hints.create} disabled={busy || name.trim().length === 0}
        onClick={() => { void run(async signal => { const created = await actions.createAndList(name, signal);
          if (signal.aborted) return; setPoints(created.points); setSelectedId(created.point.id); setName(''); }); }}>{labels.create}</button>
      {points.length === 0 ? <p>{labels.empty}</p> : <ul>{points.map(point => <li key={point.id}>
        <label><input type="radio" name="named-save-point" title={labels.hints.select} checked={selectedId === point.id}
          disabled={busy} onChange={() => setSelectedId(point.id)} />{point.name}<small> ({labels.kinds[point.kind]})</small></label>
        <time dateTime={point.createdAt}>{point.createdAt}</time>
      </li>)}</ul>}
      <div className="pcad-named-save-points__actions">
        <button type="button" title={labels.hints.clone} disabled={busy || !hasSelection || name.trim().length === 0}
          onClick={() => { void run(async signal => { const result = await actions.cloneAndList(selectedId, name, signal);
            if (signal.aborted) return;
            if (!result.listing.ok) throw new SavePointError(result.listing.reason, result.listing.message);
            setPoints(result.listing.points); setSelectedId(result.point.id); setName(''); }); }}>{labels.clone}</button>
        <button type="button" title={labels.hints.before} disabled={busy || !hasSelection} onClick={() => setBeforeId(selectedId)}>{labels.before}</button>
        <button type="button" title={labels.hints.after} disabled={busy || !hasSelection} onClick={() => setAfterId(selectedId)}>{labels.after}</button>
        <button type="button" title={labels.hints.compare} disabled={busy || beforeId === '' || afterId === ''}
          onClick={() => { void run(async signal => { const selected = await actions.comparison(beforeId, afterId, signal);
            if (!signal.aborted) setComparison(selected); }); }}>{labels.compare}</button>
        <button type="button" title={restorable || !hasSelection ? labels.hints.restore : labels.hints.restoreKind} disabled={busy || !restorable}
          onClick={() => { void run(async signal => { await actions.restore(selectedId, signal);
            if (!signal.aborted) { setMessage({ text: labels.restored, error: false }); onClose(); } }); }}>{labels.restore}</button>
      </div>
      <p>{labels.before}: {points.find(point => point.id === beforeId)?.name ?? labels.empty}
        {' / '}{labels.after}: {points.find(point => point.id === afterId)?.name ?? labels.empty}</p>
      {busy ? <p role="status">{labels.busy} <button type="button" title={labels.hints.cancel} onClick={stop}>{labels.cancel}</button></p> : null}
      {message === null ? null : <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </dialog>
    {comparison === null ? null : <DocumentDiffDialog initial={comparison} onClose={() => setComparison(null)} />}
  </>;
}
