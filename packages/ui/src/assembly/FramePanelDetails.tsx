import { evaluateExpression } from '@pointercad/expression';
import { canMachinePanelBoard, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { useEffect, useState, type KeyboardEvent } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { familyKindKey, listedRows } from './catalogFamilyChoices.js';
import { DOOR_CONNECTOR_PREFIX, DOOR_FAMILIES, DOOR_HOLDER_PREFIX } from './frameDoorActions.js';
import { FRAME_PANEL_FAMILIES, framePanelPlan, framePanelReasonText, placeFramePanelInstallation, type FramePanelOptions } from './framePanelActions.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };
const FAMILIES = [...FRAME_PANEL_FAMILIES, DOOR_FAMILIES.hinge];
const HOLE_FIELDS = { holeDiameter: 'catalog.framePanel.holeDiameter', holeX: 'catalog.framePanel.holeX',
  holeY: 'catalog.framePanel.holeY' } satisfies Readonly<Record<string, MessageKey>>;
const EMPTY_DRAFT = { familyId: FENCE_PANEL_FAMILY, row: '', gap: '0', flip: false,
  drill: false, holeDiameter: '', holeX: '', holeY: '', holderKey: '', connectorKey: '' };
type PanelDraft = typeof EMPTY_DRAFT;
type Preview = Extract<ReturnType<typeof framePanelPlan>, { readonly ok: true }>;

function PanelLengthField({ label, value, onChange, guide }: { readonly label: MessageKey; readonly value: string;
  readonly onChange: (value: string) => void; readonly guide?: MessageKey }): React.JSX.Element {
  return <label className="pcad-field">
    <span className="pcad-field__label">{t(label)}</span>
    <input title={guide === undefined ? undefined : t(guide)} className="pcad-field__input" value={value} onKeyDown={keepEnter}
      onChange={(event) => { onChange(event.currentTarget.value); }} />
    <span className="pcad-field__unit">mm</span>
  </label>;
}

function PanelFittingField({ label, prefix, value, onChange }: { readonly label: MessageKey; readonly prefix: string; readonly value: string;
  readonly onChange: (value: string) => void }): React.JSX.Element {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(DOOR_FAMILIES.hinge);
  const rows = family === undefined ? [] : listedRows(family).filter((row) => row.key.startsWith(prefix));
  return <label className="pcad-field">
    <span className="pcad-field__label">{t(label)}</span>
    <select title={t(label === 'catalog.framePanel.holder' ? 'catalog.framePanel.holderGuide' : 'catalog.framePanel.connectorGuide')}
      className="pcad-field__input" value={value} onChange={(event) => { onChange(event.currentTarget.value); }}>
      <option value="">{t('catalog.framePanel.noFitting')}</option>
      {rows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
    </select>
  </label>;
}

function PanelMachiningFields({ draft, update }: { readonly draft: PanelDraft; readonly update: (values: Partial<PanelDraft>) => void }):
React.JSX.Element {
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.framePanel.machining')}</span>
      <select className="pcad-field__input" value={draft.drill ? 'circle' : ''} title={t('catalog.framePanel.machiningGuide')}
        onChange={(event) => { update({ drill: event.currentTarget.value === 'circle' }); }}>
        <option value="">{t('catalog.framePanel.unmachined')}</option>
        <option value="circle">{t('catalog.framePanel.throughHole')}</option>
      </select>
    </label>
    {draft.drill ? <>
      <p>{t('catalog.framePanel.holeGuide')}</p>
      <PanelLengthField label={HOLE_FIELDS.holeDiameter} value={draft.holeDiameter} onChange={(holeDiameter) => { update({ holeDiameter }); }} />
      <PanelLengthField label={HOLE_FIELDS.holeX} value={draft.holeX} onChange={(holeX) => { update({ holeX }); }} />
      <PanelLengthField label={HOLE_FIELDS.holeY} value={draft.holeY} onChange={(holeY) => { update({ holeY }); }} />
    </> : null}
  </>;
}

function PanelPlanPreview({ plan, flip }: { readonly plan: Preview; readonly flip: boolean }): React.JSX.Element {
  const { width, height } = plan.opening;
  const { fittings, hole } = plan;
  const margin = Math.max(width, height) * 0.04;
  return <>
    <p>{t('catalog.framePanel.preview').replace('{width}', String(width)).replace('{height}', String(height))}</p>
    {hole === null && fittings.length === 0 && !flip ? null : <svg role="img" aria-label={t('catalog.framePanel.previewDrawing')}
      width="200" height="112" viewBox={`${-margin} ${-margin} ${width + 2 * margin} ${height + 2 * margin}`}>
      <rect width={width} height={height} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
      {hole === null ? null : <circle cx={hole.x} cy={height - hole.y} r={hole.diameter / 2}
        fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />}
    </svg>}
    {hole === null ? null : <p>{t('catalog.framePanel.previewHole').replace('{diameter}', String(hole.diameter))
      .replace('{x}', String(hole.x)).replace('{y}', String(hole.y))}</p>}
    {fittings.length === 0 ? null : <p>{t('catalog.framePanel.previewFittings')
      .replace('{holders}', String(fittings.filter((part) => part.itemKey.startsWith(DOOR_HOLDER_PREFIX)).length))
      .replace('{connectors}', String(fittings.filter((part) => part.itemKey.startsWith(DOOR_CONNECTOR_PREFIX)).length))}</p>}
  </>;
}

function PanelRowFields({ draft, update, ready }: { readonly draft: PanelDraft; readonly update: (values: Partial<PanelDraft>) => void;
  readonly ready: boolean }): React.JSX.Element {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(draft.familyId);
  return <>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.framePanel.family')}</span>
      <select className="pcad-field__input" value={draft.familyId} title={t('catalog.framePanel.familyGuide')} onChange={(event) => {
        update({ familyId: event.currentTarget.value, row: '', drill: false });
      }}>
        {FRAME_PANEL_FAMILIES.map((id) => <option key={id} value={id}>
          {t(familyKindKey(PRODUCT_CATALOG_REGISTRY.entry(id)?.kindKey ?? ''))}</option>)}
      </select>
    </label>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('catalog.framePanel.panel')}</span>
      <select title={t('catalog.framePanel.panelGuide')} className="pcad-field__input" value={draft.row}
        onChange={(event) => { update({ row: event.currentTarget.value, drill: false }); }}>
        <option value="">{t('catalog.framePanel.panelNone')}</option>
        {(family === undefined || !ready ? [] : listedRows(family)).map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
      </select>
    </label>
  </>;
}

export function FramePanelDetails({ catalogItemKey, catalogFamilyId }: { readonly catalogItemKey?: string; readonly catalogFamilyId?: string }):
React.JSX.Element {
  // The open picker owns this temporary form. The assembly is updated only by the confirm action.
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [message, setMessage] = useState<{ readonly role: 'status' | 'alert'; readonly text: string } | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'failed'>(() =>
    FAMILIES.every((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined) ? 'ready' : 'loading');
  useAppStore((state) => state.selection);
  useAppStore((state) => state.assemblyView);
  useEffect(() => {
    if (catalogStatus !== 'loading') return;
    let live = true;
    void PRODUCT_CATALOG_REGISTRY.ensure(FAMILIES).then(
      () => { if (live) setCatalogStatus('ready'); },
      () => { if (live) setCatalogStatus('failed'); },
    );
    return () => { live = false; };
  }, [catalogStatus]);
  const familyId = catalogFamilyId ?? draft.familyId;
  const itemKey = catalogItemKey ?? draft.row;
  const row = PRODUCT_CATALOG_REGISTRY.loaded(familyId)?.rows.find((candidate) => candidate.key === itemKey);
  const drill = row !== undefined && canMachinePanelBoard(row) && draft.drill;
  const options: FramePanelOptions = { familyId, flip: draft.flip, holderKey: draft.holderKey, connectorKey: draft.connectorKey,
    hole: drill ? { holeDiameter: draft.holeDiameter, holeX: draft.holeX, holeY: draft.holeY } : {} };
  const gap = evaluateExpression(draft.gap);
  const checked = gap.ok ? framePanelPlan(itemKey, gap.value.value, options) : { ok: false, reason: 'invalidNumber' } as const;
  const plan = drill && checked.ok && checked.hole === null ? { ok: false, reason: 'invalidHole' } as const : checked;
  const update = (values: Partial<PanelDraft>): void => {
    setDraft((current) => ({ ...current, ...values }));
    setMessage(null);
  };
  const place = (): void => {
    if (catalogStatus !== 'ready' || !plan.ok || !gap.ok) return;
    const placed = placeFramePanelInstallation(itemKey, gap.value.value, options);
    setMessage(placed.ok
      ? { role: 'status', text: t(plan.fittings.length === 0 ? 'catalog.framePanel.placed' : 'catalog.framePanel.placedWithFittings') }
      : { role: 'alert', text: framePanelReasonText(placed.reason) });
  };
  return <details className="pcad-popover__hint">
    <summary>{t('catalog.framePanel.title')}</summary>
    <p>{t('catalog.framePanel.hint')}</p>
    {catalogItemKey === undefined ? <PanelRowFields draft={draft} update={update} ready={catalogStatus === 'ready'} /> : null}
    <PanelLengthField label="catalog.framePanel.gap" guide="catalog.framePanel.gapGuide" value={draft.gap} onChange={(value) => { update({ gap: value }); }} />
    <label className="pcad-field">
      <input type="checkbox" title={t('catalog.framePanel.flipGuide')} checked={draft.flip} onChange={(event) => { update({ flip: event.currentTarget.checked }); }} />
      <span className="pcad-field__label">{t('catalog.framePanel.flip')}</span>
    </label>
    {row !== undefined && canMachinePanelBoard(row) ? <PanelMachiningFields draft={draft} update={update} /> : null}
    <PanelFittingField label="catalog.framePanel.holder" prefix={DOOR_HOLDER_PREFIX} value={draft.holderKey}
      onChange={(holderKey) => { update({ holderKey }); }} />
    <PanelFittingField label="catalog.framePanel.connector" prefix={DOOR_CONNECTOR_PREFIX} value={draft.connectorKey}
      onChange={(connectorKey) => { update({ connectorKey }); }} />
    {catalogStatus === 'failed' ? <p role="alert" className="pcad-field__message">{framePanelReasonText('unavailable')}</p>
      : plan.ok ? <PanelPlanPreview plan={plan} flip={draft.flip} /> : <p className="pcad-field__message">{framePanelReasonText(plan.reason)}</p>}
    <button type="button" className="pcad-button pcad-button--action" disabled={catalogStatus !== 'ready' || !plan.ok} title={t('catalog.framePanel.placeGuide')}
      onClick={place}>{t('catalog.framePanel.place')}</button>
    <button type="button" className="pcad-button" title={t('catalog.framePanel.cancelGuide')} onClick={(event) => {
      const details = event.currentTarget.closest('details');
      if (details !== null) {
        details.open = false;
        details.querySelector('summary')?.focus();
      }
      setDraft(EMPTY_DRAFT);
      setMessage(null);
    }}>{t('catalog.framePanel.cancel')}</button>
    {message === null ? null : <p role={message.role}>{message.text}</p>}
  </details>;
}
