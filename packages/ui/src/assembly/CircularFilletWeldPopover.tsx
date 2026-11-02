import { DENSITY_MATERIALS } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { densityMaterialLabelKey } from '../solid/MeasurementSections.js';
import type { CircularDraftFields, CircularDraftPreview, CircularFilletWeldDraft } from './circularFilletWeldDraft.js';

export interface CircularFilletWeldPopoverProps {
  readonly draft: CircularFilletWeldDraft | null;
  readonly preview: CircularDraftPreview | null;
  readonly onChange: (patch: CircularDraftFields) => void;
  readonly onCommit: (draft: CircularFilletWeldDraft, preview: Extract<CircularDraftPreview, { readonly ok: true }>) => void;
  readonly onCancel: () => void;
  readonly onReselect: () => void;
}

type SourceField = 'radialLeg' | 'normalLeg' | 'start' | 'lengths' | 'gaps';
function sourcePatch(field: SourceField, value: string): CircularDraftFields {
  switch (field) {
    case 'radialLeg': return { radialLeg: value };
    case 'normalLeg': return { normalLeg: value };
    case 'start': return { start: value };
    case 'lengths': return { lengths: value };
    case 'gaps': return { gaps: value };
  }
}
function issueText(reason: string): string {
  switch (reason) {
    case 'stale': case 'preview-changed': return t('assembly.circularFilletWeld.issue.stale');
    case 'picks': return t('assembly.circularFilletWeld.issue.picks');
    case 'dimension': return t('assembly.circularFilletWeld.issue.dimension');
    case 'segments': return t('assembly.circularFilletWeld.issue.segments');
    case 'material': return t('assembly.circularFilletWeld.issue.material');
    default: return t('assembly.circularFilletWeld.issue.geometry');
  }
}

function PlanSummary({ preview }: { readonly preview: Extract<CircularDraftPreview, { readonly ok: true }> }): React.JSX.Element {
  const edge = preview.request.edge.reference.fingerprint;
  const angle = preview.request.intervals.reduce((sum, row) => sum + Math.abs(row.toParameter - row.fromParameter), 0);
  const section = preview.request.section;
  // Display-only integrals of the producer-admitted meridian triangle. No plan/contact admission here.
  const length = edge.kind === 'edge' && edge.radius !== null ? edge.radius * angle : null;
  const volume = edge.kind === 'edge' && edge.radius !== null
    ? angle * section.radialLegMm * section.normalLegMm / 2 * (edge.radius + section.radialDirection * section.radialLegMm / 3) : null;
  const text = (value: number | null): string => value === null || !Number.isFinite(value)
    ? t('assembly.circularFilletWeld.summaryUnavailable') : String(Math.round(value * 1000) / 1000);
  return <div className="pcad-popover__fields" data-testid="circular-weld-plan">
    <p data-testid="circular-weld-count">{`${t('assembly.filletWeld.segmentCount')} ${String(preview.plan.beads.length)}`}</p>
    <p data-testid="circular-weld-total">{`${t('assembly.filletWeld.totalLength')} ${text(length)}`}</p>
    <p data-testid="circular-weld-volume">{`${t('assembly.circularFilletWeld.nominalVolume')} ${text(volume)}`}</p>
    <p role="status">{t('assembly.circularFilletWeld.contactConfirmed')}</p>
    <p className="pcad-field__hint">{t('assembly.filletWeld.strengthNote')}</p>
  </div>;
}

/** Props own the draft and preview. Only callbacks cross the document/history boundary. */
export function CircularFilletWeldPopover({ draft, preview, onChange, onCommit, onCancel, onReselect }: CircularFilletWeldPopoverProps): React.JSX.Element | null {
  const first = useRef<HTMLInputElement>(null);
  const composing = useRef(false), compositionKey = useRef(false), pending = useRef(false), cancelled = useRef(false);
  const invalidatedPreview = useRef<CircularDraftPreview | null>(null);
  const [editing, setEditing] = useState(false), [ime, setIme] = useState(false);
  useEffect(() => {
    composing.current = false; compositionKey.current = false; cancelled.current = false;
    pending.current = false; invalidatedPreview.current = null; setEditing(false); setIme(false);
    first.current?.focus();
  }, [draft?.documentId, draft?.weldId]);
  useEffect(() => {
    if (preview?.ok && preview.draft === draft && preview !== invalidatedPreview.current) {
      pending.current = false; setEditing(false);
    }
  }, [draft, preview]);
  if (draft === null) return null;
  const bound = preview?.ok === true && preview.draft === draft && draft.picks.length === 3;
  const ready = bound && !editing && !ime;
  const title = t(draft.operation === 'replace' ? 'assembly.circularFilletWeld.editTitle' : 'assembly.circularFilletWeld.title');
  const prompt = draft.picks.length === 0 ? 'assembly.circularFilletWeld.pickPlane'
    : draft.picks.length === 1 ? 'assembly.circularFilletWeld.pickEdge'
      : draft.picks.length === 2 ? 'assembly.circularFilletWeld.pickCylinder' : 'assembly.circularFilletWeld.picked';
  const invalidate = (): void => {
    invalidatedPreview.current = preview; pending.current = true; setEditing(true);
  };
  const change = (patch: CircularDraftFields): void => {
    if (Object.entries(patch).every(([key, value]) => Reflect.get(draft, key) === value)) return;
    invalidate(); onChange(patch);
  };
  const cancel = (): void => {
    if (cancelled.current) return;
    cancelled.current = true; onCancel();
  };
  return <form className="pcad-popover pcad-popover--fillet-weld" role="dialog" aria-label={title}
    onCompositionStart={() => { composing.current = true; compositionKey.current = true; setIme(true); }}
    onCompositionEnd={() => { composing.current = false; setIme(false); }}
    onPointerDownCapture={() => { compositionKey.current = false; }}
    onKeyDown={(event) => {
      compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
      if (compositionKey.current || event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); cancel();
    }}
    onSubmit={(event) => {
      event.preventDefault();
      if (composing.current || compositionKey.current || pending.current || cancelled.current || !ready || !preview?.ok) return;
      invalidate(); onCommit(draft, preview);
    }}>
    <DraggableWindowTitle className="pcad-popover__title">{title}</DraggableWindowTitle>
    {draft.operation === 'replace' && draft.picks.length === 0 ? <p role="status" data-testid="circular-weld-edit-guide">{t('assembly.circularFilletWeld.editGuide')}</p> : null}
    <p role="status" data-testid="circular-weld-prompt">{t(prompt)}</p>
    <div className="pcad-popover__fields">
      {([['radialLeg', 'assembly.circularFilletWeld.radialLeg'], ['normalLeg', 'assembly.circularFilletWeld.normalLeg']] as const).map(([field, label], index) =>
        <label className="pcad-field" key={field}><span className="pcad-field__label">{t(label)}</span>
          <input className="pcad-field__input" ref={index === 0 ? first : undefined} data-testid={`circular-weld-${field}`}
            value={draft[field]} title={t(label)} onChange={(event) => change(sourcePatch(field, event.currentTarget.value))} />
        </label>)}
      {(['radialDirection', 'normalDirection'] as const).map(field => <label className="pcad-field" key={field}>
        <span className="pcad-field__label">{t(field === 'radialDirection' ? 'assembly.circularFilletWeld.radialDirection' : 'assembly.circularFilletWeld.normalDirection')}</span>
        <select className="pcad-field__input" data-testid={`circular-weld-${field}`} value={draft[field] === null ? '' : String(draft[field])}
          title={t(field === 'radialDirection' ? 'assembly.circularFilletWeld.radialDirection' : 'assembly.circularFilletWeld.normalDirection')}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            if (raw !== '' && raw !== '1' && raw !== '-1') return;
            const value = raw === '' ? null : raw === '1' ? 1 : -1;
            change(field === 'radialDirection' ? { radialDirection: value } : { normalDirection: value });
          }}>
          <option value="">{t('assembly.filletWeld.materialChoose')}</option>
          <option value="1">{t(field === 'radialDirection' ? 'assembly.circularFilletWeld.outward' : 'assembly.circularFilletWeld.positive')}</option>
          <option value="-1">{t(field === 'radialDirection' ? 'assembly.circularFilletWeld.inward' : 'assembly.circularFilletWeld.negative')}</option>
        </select>
      </label>)}
      <label className="pcad-field"><span className="pcad-field__label">{t('assembly.filletWeld.mode')}</span>
        <select className="pcad-field__input" data-testid="circular-weld-mode" value={draft.mode} title={t('assembly.guide.weldMode')}
          onChange={(event) => { const value = event.currentTarget.value; if (value === 'continuous' || value === 'intermittent') change({ mode: value }); }}>
          <option value="continuous">{t('assembly.filletWeld.mode.continuous')}</option>
          <option value="intermittent">{t('assembly.filletWeld.mode.intermittent')}</option>
        </select>
      </label>
      {([['start', 'assembly.filletWeld.start'], ['lengths', draft.mode === 'continuous' ? 'assembly.circularFilletWeld.length' : 'assembly.filletWeld.lengths']] as const).map(([field, label]) =>
        <label className="pcad-field" key={field}><span className="pcad-field__label">{t(label)}</span>
          <input className="pcad-field__input" data-testid={`circular-weld-${field}`} value={draft[field]} title={t(label)}
            onChange={(event) => change(sourcePatch(field, event.currentTarget.value))} />
        </label>)}
      {draft.mode === 'intermittent' ? <label className="pcad-field"><span className="pcad-field__label">{t('assembly.filletWeld.gaps')}</span>
        <input className="pcad-field__input" data-testid="circular-weld-gaps" value={draft.gaps} title={t('assembly.guide.weldGaps')}
          onChange={(event) => change(sourcePatch('gaps', event.currentTarget.value))} />
      </label> : null}
      <p className="pcad-field__hint">{t(draft.mode === 'continuous' ? 'assembly.circularFilletWeld.fullCircleHint' : 'assembly.circularFilletWeld.intervalsHint')}</p>
      <label className="pcad-field"><span className="pcad-field__label">{t('assembly.filletWeld.material')}</span>
        <select className="pcad-field__input" data-testid="circular-weld-material" value={draft.materialId} title={t('assembly.guide.weldMaterial')}
          onChange={(event) => change({ materialId: event.currentTarget.value })}>
          <option value="">{t('assembly.filletWeld.materialChoose')}</option>
          {DENSITY_MATERIALS.map(material => <option key={material.id} value={material.id}>{t(densityMaterialLabelKey(material.id))}</option>)}
        </select>
      </label>
    </div>
    {bound && !editing ? <PlanSummary preview={preview} /> : preview?.ok === false ? <p role="status">{issueText(preview.reason)}</p>
      : <p role="status">{t('assembly.circularFilletWeld.issue.stale')}</p>}
    <div className="pcad-popover__actions">
      <button type="submit" className="pcad-button" data-testid="circular-weld-commit" disabled={!ready} title={t('assembly.filletWeld.commitTooltip')}>{t('assembly.filletWeld.commit')}</button>
      <button type="button" className="pcad-button" data-testid="circular-weld-reselect" title={t('assembly.circularFilletWeld.reselectHint')}
        onClick={() => { invalidate(); onReselect(); }}>{t('assembly.circularFilletWeld.reselect')}</button>
      <button type="button" className="pcad-button" data-testid="circular-weld-cancel" title={t('assembly.filletWeld.cancelTooltip')} onClick={cancel}>{t('assembly.filletWeld.cancel')}</button>
    </div>
  </form>;
}
