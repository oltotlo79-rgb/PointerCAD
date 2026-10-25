import { useEffect, useRef, useState } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildSteelBendEdit, commitSteelBendEdit, readSteelBendEditInput,
  type SteelBendEditResult, type SteelBendEditTarget, type SteelBendSources } from './steelBendPicker.js';

const FIELDS = [
  ['radius', 'assembly.steel.bend.radius'], ['angleDegrees', 'assembly.steel.bend.angle'],
  ['directionDegrees', 'assembly.steel.bend.direction'],
  ['firstLeg', 'assembly.steel.bend.firstLeg'], ['secondLeg', 'assembly.steel.bend.secondLeg'],
] as const;
const ERRORS = {
  invalidExpression: 'assembly.steel.bend.invalidExpression', invalidRadius: 'assembly.steel.bend.invalidRadius',
  invalidAngle: 'assembly.steel.bend.invalidAngle', invalidLength: 'assembly.steel.bend.invalidLength',
  invalidDirection: 'assembly.steel.bend.invalidDirection',
  invalidSection: 'assembly.steel.bend.invalidSection', insufficientLegLength: 'assembly.steel.bend.insufficientLegLength',
  radiusTooTight: 'assembly.steel.bend.radiusTooTight', unsupportedSource: 'assembly.steel.bend.unsupportedSource',
  invalidStockLength: 'assembly.steel.bend.invalidStockLength', stockLengthMismatch: 'assembly.steel.bend.stockLengthMismatch',
  missing: 'assembly.steel.bend.reedit.missing', modified: 'assembly.steel.bend.reedit.modified',
  unsupported: 'assembly.steel.bend.reedit.unsupported', unavailable: 'assembly.steel.bend.reedit.unavailable',
  failed: 'assembly.steel.bend.reedit.failed',
} as const;

/** Plain expression text fields follow the existing picker/placement controls and IME lifecycle. */
export function SteelBendFields({ sources, result, onChange }: {
  readonly sources: SteelBendSources;
  readonly result: SteelBendEditResult | null;
  readonly onChange: (sources: SteelBendSources) => void;
}): React.JSX.Element {
  return <>
    {FIELDS.map(([field, label]) => <label key={field} className="pcad-field">
      <span className="pcad-field__label">{t(label)}</span>
      <input className="pcad-field__input" title={t('assembly.steel.bend.expressionGuide')}
        value={sources[field] ?? '0'} onChange={(event) => onChange({ ...sources, [field]: event.currentTarget.value })} />
    </label>)}
    <label className="pcad-field">
      <span className="pcad-field__label">{t('assembly.steel.bend.radiusConvention')}</span>
      <select className="pcad-field__input" title={t('assembly.steel.bend.radiusConvention')}
        value={sources.radiusConvention} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === 'inside' || value === 'outside') onChange({ ...sources, radiusConvention: value });
        }}>
        <option value="inside">{t('assembly.steel.bend.inside')}</option>
        <option value="outside">{t('assembly.steel.bend.outside')}</option>
      </select>
    </label>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('assembly.steel.bend.legConvention')}</span>
      <select className="pcad-field__input" title={t('assembly.steel.bend.legConvention')}
        value={sources.legDimension} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === 'inside' || value === 'outside' || value === 'tangent') onChange({ ...sources, legDimension: value });
        }}>
        <option value="tangent">{t('assembly.steel.bend.tangent')}</option>
        <option value="inside">{t('assembly.steel.bend.inside')}</option>
        <option value="outside">{t('assembly.steel.bend.outside')}</option>
      </select>
    </label>
    {result === null ? null : result.ok ? <p role="status">
      {t('assembly.steel.bend.requiredLength').replace('{length}', String(result.geometry.centrelineLengthMm))}
    </p> : <p role="alert">{t(ERRORS[result.reason])}</p>}
    <p className="pcad-popover__hint">{t('assembly.steel.bend.directionGuide')}</p>
    <p className="pcad-popover__hint">{t('assembly.steel.bend.allowance')}</p>
  </>;
}

/** The draft is local to this cancellable form; only the explicit commit publishes a document. */
export function SteelBendEditForm({ target, onClose }: {
  readonly target: SteelBendEditTarget;
  readonly onClose: () => void;
}): React.JSX.Element {
  const saved = readSteelBendEditInput(target.document);
  const [sources, setSources] = useState<SteelBendSources | null>(() => saved.ok ? saved.sources : null);
  const [failure, setFailure] = useState<SteelBendEditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const computing = useAppStore(state => state.isComputing);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const result = sources === null ? null : buildSteelBendEdit(target.document, sources);
  const cancel = (): void => { request.current?.abort(); onClose(); };
  const submit = (): void => {
    if (composing.current || compositionKey.current || request.current !== null || computing
      || sources === null || result?.ok !== true) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    void commitSteelBendEdit(target, sources, controller.signal).then(outcome => {
      if (controller.signal.aborted) return;
      if (outcome.ok) onClose();
      else setFailure(outcome);
    }).finally(() => {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    });
  };
  return <form className="pcad-popover pcad-popover--standard-part" role="dialog"
    aria-label={t('assembly.steel.bend.reedit.title')} aria-busy={busy}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onPointerDownCapture={() => { compositionKey.current = false; }}
    onSubmit={event => { event.preventDefault(); submit(); }}
    onKeyDown={event => {
      compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
      if (compositionKey.current || event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); cancel();
    }}>
    <DraggableWindowTitle className="pcad-popover__title">{t('assembly.steel.bend.reedit.title')}</DraggableWindowTitle>
    <p>{target.document.name}</p>
    <p className="pcad-popover__hint">{t('assembly.steel.bend.reedit.guide')}</p>
    {sources === null ? <p role="alert">{t(ERRORS[saved.ok ? 'missing' : saved.reason])}</p>
      : <div className="pcad-popover__fields"><SteelBendFields sources={sources} result={failure ?? result}
        onChange={next => { if (!busy) { setSources(next); setFailure(null); } }} /></div>}
    <div className="pcad-popover__actions">
      <button type="submit" className="pcad-button pcad-button--action" disabled={busy || computing || result?.ok !== true}
        title={t('assembly.steel.bend.reedit.applyGuide')}>{t('assembly.steel.bend.reedit.apply')}</button>
      <button type="button" className="pcad-button" onClick={cancel}
        title={t('assembly.steel.bend.reedit.cancelGuide')}>{t('assembly.steel.bend.reedit.cancel')}</button>
    </div>
  </form>;
}
