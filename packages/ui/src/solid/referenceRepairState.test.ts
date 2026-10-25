import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { createRepairStateSelector } from './referenceRepairState.js';
import { ReferenceRepairSection } from './referenceRepairPanel.js';
import * as candidates from './referenceRepairCandidates.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, cancelReferenceRepair, referenceRepairCurrent } from './referenceRepair.js';

beforeEach(() => {
  resetTestStore();
  const { document, body } = repairFixture();
  useAppStore.getState().applyDocument(document);
  useAppStore.setState({ bodies: [body], isComputing: false, requestedGeneration: 1, completedGeneration: 1,
    lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

it('keeps the panel snapshot on unrelated hover and drag-notice updates; detail follows hover', () => {
  const panel = createRepairStateSelector(), detail = createRepairStateSelector(true);
  const initial = useAppStore.getState();
  expect(panel(initial)).toBe(initial); expect(detail(initial)).toBe(initial);
  useAppStore.getState().setHovered('unrelated');
  const hovered = useAppStore.getState();
  expect(panel(hovered)).toBe(initial); expect(detail(hovered)).toBe(hovered);
  const unrelated = { ...hovered, canvasMessage: 'unrelated operation', assemblyDragNotice: 'dragging' as const };
  expect(panel(unrelated)).toBe(initial); expect(detail(unrelated)).toBe(hovered);
});

it('invalidates on document/history, geometry, generation, cancellation and diagnostic changes', () => {
  const original = useAppStore.getState();
  const changes = [
    { ...original, document: { ...original.document } },
    { ...original, activeDocumentId: original.activeDocumentId + '-other' },
    { ...original, documentVersion: original.documentVersion + 1 },
    { ...original, bodies: [...original.bodies] },
    { ...original, requestedGeneration: original.requestedGeneration + 1 },
    { ...original, completedGeneration: original.completedGeneration + 1 },
    { ...original, cancelRequestCount: original.cancelRequestCount + 1 },
    { ...original, isComputing: true }, { ...original, recomputeCancelled: true },
    { ...original, drawingBusy: !original.drawingBusy }, { ...original, lastOutcome: 'failed' as const },
    { ...original, timelineIndex: 0 }, { ...original, partErrors: [...original.partErrors] },
    { ...original, errorMessage: 'changed diagnostic' },
  ];
  for (const changed of changes) {
    const select = createRepairStateSelector();
    select(original); expect(select(changed)).toBe(changed); expect(select(original)).toBe(original);
  }
});

it('resolves each displayed slot only once, rather than resolving it again for the label', () => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const count = currentRepairSlots(useAppStore.getState()).length;
  const resolve = vi.spyOn(candidates, 'repairResolution');
  renderToStaticMarkup(createElement(ReferenceRepairSection));
  expect(count).toBeGreaterThan(0); expect(resolve).toHaveBeenCalledTimes(count);
});

it('keeps live session invalidation after a relevant update despite unrelated snapshot reuse', () => {
  const select = createRepairStateSelector(), initial = useAppStore.getState();
  const slot = currentRepairSlots(initial)[0];
  if (slot === undefined) throw new Error('Missing repair fixture');
  const session = beginReferenceRepair(slot.key);
  if (session === null) throw new Error('Missing repair session');
  select(initial); useAppStore.getState().setHovered('unrelated');
  expect(select(useAppStore.getState())).toBe(initial); expect(referenceRepairCurrent(session)).toBe(true);
  useAppStore.setState({ requestedGeneration: initial.requestedGeneration + 1 });
  expect(select(useAppStore.getState())).toBe(useAppStore.getState());
  expect(referenceRepairCurrent(session)).toBe(false);
  cancelReferenceRepair(session);
});
