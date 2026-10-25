import { createElement as h, useMemo, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { currentReferenceRepairHoverId, hoverReferenceRepair, referenceRepairCurrent, type ReferenceRepairSession, type RepairImpact } from './referenceRepair.js';
import type { RepairCandidate } from './referenceRepairCandidates.js';
import { summarizeRepairReference } from './referenceRepairSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocument } from '../store/documentKind.js';
import { drawingRepairProjection, type DrawingRepairProjectionReading } from '../drawing/referenceRepairProjection.js';
import { createRepairStateSelector } from './referenceRepairState.js';

const drawingHoverReasons: Readonly<Record<Extract<DrawingRepairProjectionReading, { status: 'unavailable' }>['reason'], MessageKey>> = {
  'malformed-descriptor': 'propertyPanel.repair.drawingHoverUncertified',
  'stale-owner': 'propertyPanel.repair.stale',
  'source-not-projected': 'propertyPanel.repair.drawingHoverSource',
  'ambiguous-body': 'propertyPanel.repair.drawingHoverAmbiguous',
  'semantic-unresolved': 'propertyPanel.repair.drawingHoverUncertified',
  'face-provenance-unproved': 'propertyPanel.repair.drawingHoverFace',
  'vertex-provenance-unproved': 'propertyPanel.repair.drawingHoverVertex',
  'no-certified-projection': 'propertyPanel.repair.drawingHoverUncertified',
};

export const REPAIR_STATUS_LABELS: Readonly<Record<RepairImpact['status'], MessageKey>> = {
  matched: 'propertyPanel.repair.unique', missing: 'propertyPanel.repair.missing', ambiguous: 'propertyPanel.repair.ambiguous', pending: 'propertyPanel.repair.pending',
};
const consumerLabels: Readonly<Record<RepairImpact['consumer'], MessageKey>> = {
  machining: 'propertyPanel.repair.machining', appearance: 'propertyPanel.repair.appearance', dimension: 'propertyPanel.repair.dimension',
  mate: 'propertyPanel.repair.mate', reference: 'propertyPanel.repair.reference', sketch: 'propertyPanel.repair.sketch',
  selection: 'propertyPanel.repair.selection', annotation: 'propertyPanel.repair.annotation',
};
export function repairImpactList(impacts: readonly RepairImpact[]): React.ReactElement {
  return h('ul', { 'data-testid': 'reference-repair-impacts' }, impacts.map(item => h('li', { key: item.key },
    `${t(consumerLabels[item.consumer])}: ${item.name} / ${t(REPAIR_STATUS_LABELS[item.status])}${item.issue === undefined ? '' : ` / ${item.issue}`}`)));
}
export function repairButton(key: MessageKey, onClick: () => void, disabled = false): React.ReactElement {
  return h('button', { type: 'button', className: 'pcad-button', title: t(key), disabled, onClick }, t(key));
}
export interface ReferenceRepairDetailProps {
  readonly session: ReferenceRepairSession;
  readonly selected: RepairCandidate | null;
  readonly fresh: boolean;
  readonly ready: boolean;
  readonly onSelect: (candidate: RepairCandidate) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
}

/** All three facts are visible together after opening an unresolved row. */
export function ReferenceRepairDetail({ session, selected, fresh, ready, onSelect, onConfirm, onCancel, onRefresh }: ReferenceRepairDetailProps): React.ReactElement {
  const [selectState] = useState(() => createRepairStateSelector(true));
  const state = useAppStore(selectState), [failedHoverSession, setFailedHoverSession] = useState<ReferenceRepairSession | null>(null);
  const current = fresh && referenceRepairCurrent(session, state), drawing = activeDocument(state).kind === 'drawing';
  const projection = useMemo(() => drawing && current
    ? drawingRepairProjection(state, currentReferenceRepairHoverId(session, state)) : null, [drawing, current, state, session]);
  const reason = projection?.status === 'unavailable' && projection.reason !== 'stale-owner' ? drawingHoverReasons[projection.reason]
    : drawing && current && failedHoverSession === session ? 'propertyPanel.repair.drawingHoverUncertified' : null;
  const hover = (candidate: RepairCandidate | null): void => {
    const admitted = hoverReferenceRepair(session, candidate);
    setFailedHoverSession(candidate !== null && !admitted && referenceRepairCurrent(session) ? session : null);
  };
  return h('div', { 'data-testid': 'reference-repair-detail' },
    h('h4', null, session.slot.name),
    h('p', { role: 'status' }, fresh ? t(REPAIR_STATUS_LABELS[session.status]) : t('propertyPanel.repair.stale')),
    session.slot.available ? null : h('p', null, t('propertyPanel.repair.unavailable')),
    h('h4', null, t('propertyPanel.repair.original')),
    h('p', null, summarizeRepairReference(session.slot.reference)),
    h('h4', null, t('propertyPanel.repair.candidates')),
    session.candidates.length === 0 ? h('p', null, t('propertyPanel.repair.noCandidates')) : null,
    h('ul', null, session.candidates.map((candidate, index) => h('li', { key: index }, h('button', {
      type: 'button', className: 'pcad-button', 'aria-pressed': selected === candidate, disabled: !fresh,
      title: t(candidate.selectable ? 'propertyPanel.repair.choose' : 'propertyPanel.repair.notUnique'),
      onMouseEnter: () => { hover(candidate); },
      onMouseLeave: () => { hover(null); },
      onFocus: () => { hover(candidate); }, onBlur: () => { hover(null); },
      onClick: () => { if (candidate.selectable) onSelect(candidate); },
    }, summarizeRepairReference(candidate.reference), candidate.selectable ? null : ` / ${t('propertyPanel.repair.notUnique')}`)))),
    reason === null ? null : h('p', { role: 'status', 'data-testid': 'reference-repair-hover-unavailable' }, t(reason)),
    h('h4', null, t('propertyPanel.repair.impacts')), repairImpactList(session.impacts),
    repairButton('propertyPanel.repair.confirm', onConfirm, !fresh || selected === null || !selected.selectable),
    repairButton('propertyPanel.repair.cancel', onCancel),
    fresh ? null : repairButton('propertyPanel.repair.refresh', onRefresh, !ready));
}
