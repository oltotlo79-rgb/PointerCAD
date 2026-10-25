import { createElement as h, useEffect, useMemo, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocument } from '../store/documentKind.js';
import { currentRepairSlots, repairContextReady, repairContextTokens } from './referenceRepairContext.js';
import { repairResolution, type RepairCandidate } from './referenceRepairCandidates.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair,
  referenceRepairCurrent, referenceRepairImpacts, type ReferenceRepairSession } from './referenceRepair.js';
import { ReferenceRepairDetail, REPAIR_STATUS_LABELS, repairButton, repairImpactList } from './referenceRepairDetail.js';
import { createRepairStateSelector } from './referenceRepairState.js';

/** Uses the existing property area and hover channel. All draft values are display-only. */
export function ReferenceRepairSection(): React.ReactElement | null {
  const [selectState] = useState(() => createRepairStateSelector());
  const state = useAppStore(selectState);
  const [session, setSession] = useState<ReferenceRepairSession | null>(null);
  const [selected, setSelected] = useState<RepairCandidate | null>(null);
  const [review, setReview] = useState<ReferenceRepairSession | null>(null);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (session === null) return;
    return () => { cancelReferenceRepair(session); };
  }, [session]);
  const rows = useMemo(() => currentRepairSlots(state).map(slot => ({ slot, status: repairResolution(slot).status })), [state]);
  const impacts = useMemo(() => review === null || review.tokens[2] !== state.activeDocumentId
    || review.tokens[1] !== activeDocument(state).document ? null : referenceRepairImpacts(state, review.slot), [state, review]);
  const ready = repairContextReady(state);
  if (rows.length === 0 && session === null && review === null) return null;
  const fresh = session !== null && referenceRepairCurrent(session, state);
  const visible = rows.filter(row => showAll || row.status !== 'matched');
  function open(key: string): void {
    if (session !== null) cancelReferenceRepair(session);
    setSession(beginReferenceRepair(key)); setSelected(null); setMessage(null); setReview(null);
  }
  function confirm(): void {
    if (session === null || selected === null) return;
    const result = commitReferenceRepair(session, selected);
    if (result === 'applied') {
      setReview({ ...session, tokens: repairContextTokens(useAppStore.getState()) });
      setSession(null); setSelected(null); setMessage('propertyPanel.repair.applied');
    } else setMessage(result === 'stale' ? 'propertyPanel.repair.stale' : result === 'unchanged' ? 'propertyPanel.repair.unchanged' : 'propertyPanel.repair.notUnique');
  }
  return h('section', { className: 'pcad-section', 'data-testid': 'reference-repair' },
    h('h3', { className: 'pcad-section__title' }, t('propertyPanel.repair.title')),
    h('p', null, t('propertyPanel.repair.scope')),
    ready ? null : h('p', { role: 'status' }, t('propertyPanel.repair.pending')),
    repairButton(showAll ? 'propertyPanel.repair.showUnresolved' : 'propertyPanel.repair.showAll', () => { setShowAll(!showAll); }),
    h('ul', null, visible.map(({ slot, status }) => h('li', { key: slot.key }, h('button', {
      type: 'button', className: 'pcad-button', disabled: !ready, title: t('propertyPanel.repair.open'),
      onClick: () => { open(slot.key); },
    }, `${slot.name} / ${t(slot.available ? REPAIR_STATUS_LABELS[status] : 'propertyPanel.repair.unavailable')}`)))),
    session === null ? null : h(ReferenceRepairDetail, { session, selected, fresh, ready,
      onSelect: setSelected, onConfirm: confirm,
      onCancel: () => { cancelReferenceRepair(session); setSession(null); setSelected(null); setMessage(null); },
      onRefresh: () => { open(session.slot.key); } }),
    message === null ? null : h('p', { role: 'status' }, t(message)),
    review === null || review.tokens[2] !== state.activeDocumentId
      || review.tokens[1] !== activeDocument(state).document ? null : h('div', null, h('h4', null, t('propertyPanel.repair.rechecked')),
      repairImpactList(impacts ?? [])),
  );
}
