import { useEffect, useId, useRef, useState } from 'react';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import type { FunctionPlotAxis } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { useAppStore } from '../store/useAppStore.js';
import { editFunctionField, FUNCTION_AXES, type FunctionScalarDraft } from './functionPlotDraft.js';
import { prepareFunctionSection } from './functionSectionDraft.js';
import { readFunctionSection, type FunctionSectionAddress } from './functionSectionEdit.js';
import './functionPlot.css';

export function FunctionSectionDialog({ parentId, edit, onClose }: {
  readonly parentId: string; readonly edit?: FunctionSectionAddress; readonly onClose: () => void;
}): React.JSX.Element {
  const [owner] = useState(() => useAppStore.getState()), [close] = useState(() => onClose), id = useId();
  const [previous] = useState(() => edit ? readFunctionSection(owner.document, edit) : null);
  const [axis, setAxis] = useState<FunctionPlotAxis>(previous?.axis ?? 'Z');
  const [field, setField] = useState<FunctionScalarDraft>(() => previous
    ? { source: previous.coordinate.source, angleUnit: previous.coordinate.mathDefinition?.angleUnit ?? 'degree', accepted: previous.coordinate }
    : { source: '', angleUnit: 'degree' });
  const [prepared, setPrepared] = useState(owner.document);
  const [editor, setEditor] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), running = useRef<AbortController | null>(null), mounted = useRef(true);
  const parent = owner.document.solids.find(feature => feature.id === parentId);
  const current = () => mounted.current && useAppStore.getState().document === owner.document
    && useAppStore.getState().documentVersion === owner.documentVersion;
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.document !== owner.document || state.documentVersion !== owner.documentVersion) { running.current?.abort(); close(); }
    });
    return () => {
      mounted.current = false; running.current?.abort(); unsubscribe(); element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [owner, close]);
  const apply = async () => {
    if (!current() || busy) return;
    const abort = new AbortController(), client = createBrowserMathClient();
    running.current = abort; setBusy(true); setMessage('');
    const active = () => current() && running.current === abort && !abort.signal.aborted;
    try {
      const outcome = await prepareFunctionSection(prepared, owner.documentVersion, parentId, axis, field, client, abort.signal, active, edit);
      if (!active() || outcome.status === 'cancelled') return;
      if (outcome.status === 'failed') { setMessage(outcome.message); return; }
      useAppStore.getState().applyDocument(outcome.result.document);
      close();
    } catch (error) { if (active()) setMessage(error instanceof Error ? error.message : t('math.workerFailed')); }
    finally { client.dispose(); if (running.current === abort) { running.current = null; if (mounted.current) setBusy(false); } }
  };
  return <>
    <dialog ref={dialog} className="pcad-function-dialog" aria-labelledby={`${id}-title`} data-help-topic="function-surface"
      onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
      <h2 id={`${id}-title`}>{t(edit ? 'functionSection.edit' : 'functionSection.title')}</h2><p>{parent?.name}</p><p>{t('functionSection.hint')}</p>
      <form onSubmit={event => { event.preventDefault(); void apply(); }}>
        <fieldset disabled={busy}>
          <legend>{t('functionSection.coordinate')}</legend>
          {FUNCTION_AXES.map(value => <label key={value}><input type="radio" name={`${id}-axis`} value={value} checked={axis === value}
            onChange={() => { setAxis(value); setMessage(''); }} />{value}</label>)}
          <div className="pcad-function-field"><label htmlFor={`${id}-coordinate`}>{axis} (mm)</label>
            <input id={`${id}-coordinate`} required value={field.source} onChange={event => { setField(editFunctionField(field, event.target.value)); setMessage(''); }} />
            <button type="button" aria-label={t('math.open')} onClick={() => setEditor(true)}>ƒ</button>
          </div>
          {parent?.kind === 'functionSurface' ? <p>{axis}: {parent.definition.bounds[axis].min.source}{t('display.rangeSeparator')}{parent.definition.bounds[axis].max.source} mm</p> : null}
        </fieldset>
        {message ? <p role="alert">{message}</p> : null}
        {busy ? <p role="status">{t('functionSection.calculating')}</p> : null}
        <div className="pcad-function-actions"><button type="button" onClick={close}>{t('math.cancel')}</button>
          {busy ? <button type="button" onClick={() => { running.current?.abort(); setBusy(false); }}>{t('functionPlot.stop')}</button>
            : <button type="submit">{t(edit ? 'functionSection.update' : 'functionSection.apply')}</button>}
        </div>
      </form>
    </dialog>
    {editor ? <MathExpressionDialog document={prepared} documentVersion={owner.documentVersion} isCurrent={current}
      onClose={() => setEditor(false)} unitLabel="mm" initialAngleUnit={field.angleUnit}
      initialValue={field.accepted ?? { ...number(0), source: field.source }} onApply={(value, document, signal) => {
        if (!current() || signal.aborted) return Promise.resolve({ ok: false, message: t('math.operation.cancelled') });
        setPrepared(document); setField({ source: value.source, angleUnit: value.mathDefinition?.angleUnit ?? field.angleUnit, accepted: value }); setMessage('');
        return Promise.resolve({ ok: true });
      }} /> : null}
  </>;
}
