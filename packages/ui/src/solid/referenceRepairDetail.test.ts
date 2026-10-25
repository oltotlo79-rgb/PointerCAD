import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDrawingDocument, createSubShapeReference, IDENTITY_PLACEMENT, type SolidBody, type ResolvedDrawingView } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, cancelReferenceRepair, currentReferenceRepairHoverId, hoverReferenceRepair, type ReferenceRepairSession } from './referenceRepair.js';
import { ReferenceRepairDetail } from './referenceRepairDetail.js';
import { drawingRepairProjection } from '../drawing/referenceRepairProjection.js';
import { t } from '../i18n/t.js';

beforeEach(() => {
  resetTestStore();
  // Observe the actual store in SSR; the projection and session functions are never mocked.
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function drawingSession(kind: 'face' | 'vertex' | 'edge', certifiedEdge = false): ReferenceRepairSession {
  const fixture = repairFixture();
  const faceOrigin = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'base', role: 'top' } } as const;
  const vertexOrigin = { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'base', role: 'bottom-front-left' } } as const;
  const edgeOrigin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'base', role: 'bottom-front' } } as const;
  const body: SolidBody = { ...fixture.body,
    faces: [{ index: 0, surfaceKind: 'plane', area: 100, centroid: [0, 0, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }],
    vertices: [{ index: 0, position: [0, 0, 0] }],
    edges: [fixture.body.edges[0]],
    origins: { version: 1, state: 'tracked', bindings: [
      { origin: faceOrigin, state: 'unique', current: { kind: 'face', index: 0 } },
      { origin: vertexOrigin, state: 'unique', current: { kind: 'vertex', index: 0 } },
      { origin: edgeOrigin, state: 'unique', current: { kind: 'edge', index: 0 } },
    ] },
  };
  const reference = createSubShapeReference(body, kind, 0);
  if (reference === null) throw new Error('Actual current semantic reference required');
  const document: DrawingDocument = { ...createDrawingDocument('reason', { sourceRef: 'source', sourceKind: 'part',
    fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '' }),
    views: [{ id: 'front', name: 'front', kind: 'front', position: [100, 100], scale: 1,
      direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' }],
    annotations: [{ id: 'note', kind: 'leaderNote', text: 'Current candidate', position: [100, 90],
      height: 3, layerId: 'layer-1', sourceTarget: { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: reference } }],
  };
  const projected: ResolvedDrawingView = { viewId: 'front', name: 'front', position: [100, 100], scale: 1,
    visible: certifiedEdge ? [{ curve: { kind: 'segment', from: [100, 100], to: [110, 100] },
      provenance: { kind: 'edge', dimensionTarget: true, bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 10] } }] : [],
    hidden: [], cuttingCurves: [] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [projected], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['worker-body'], center: [0, 0, 0], dimensionInstances: [{
      sourceRef: 'source', bodyId: 'worker-body', body, placement: IDENTITY_PLACEMENT }] } });
  const slot = currentRepairSlots(useAppStore.getState()).find(slot => slot.ownerId === 'note');
  if (slot === undefined) throw new Error('Actual Drawing annotation repair slot required');
  const session = beginReferenceRepair(slot.key);
  if (session === null || session.candidates.length !== 1 || !session.candidates[0].selectable) throw new Error('Owned current candidate required');
  return session;
}

function markup(session: ReferenceRepairSession, fresh = true): string {
  return renderToStaticMarkup(createElement(ReferenceRepairDetail, { session, selected: session.candidates[0] ?? null, fresh, ready: true,
    onSelect: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onRefresh: vi.fn() }));
}

describe('Drawing candidate visible projection feedback', () => {
  it.each(['face', 'vertex'] as const)('shows the actual current %s provenance limitation, without saved/history/selection changes', kind => {
    const session = drawingSession(kind), before = useAppStore.getState();
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    const state = useAppStore.getState();
    expect(drawingRepairProjection(state, currentReferenceRepairHoverId(session, state))).toMatchObject({ status: 'unavailable',
      reason: kind === 'face' ? 'face-provenance-unproved' : 'vertex-provenance-unproved', elements: [] });
    expect(markup(session)).toContain(t(kind === 'face' ? 'propertyPanel.repair.drawingHoverFace' : 'propertyPanel.repair.drawingHoverVertex'));
    expect(state.drawing).toBe(before.drawing);
    expect(state.drawingUndoStack).toBe(before.drawingUndoStack);
    expect(state.drawingSelectedIds).toBe(before.drawingSelectedIds);
    expect(state.selection).toBe(before.selection);
    cancelReferenceRepair(session);
  });

  it('reports an actual edge without certified projected curves and hides after hover exit', () => {
    const session = drawingSession('edge');
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    expect(drawingRepairProjection(useAppStore.getState(), currentReferenceRepairHoverId(session))).toMatchObject({ status: 'unavailable', reason: 'no-certified-projection' });
    expect(markup(session)).toContain(t('propertyPanel.repair.drawingHoverUncertified'));
    expect(hoverReferenceRepair(session, null)).toBe(true);
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    cancelReferenceRepair(session);
  });

  it('does not claim unavailability for a real certified current edge projection', () => {
    const session = drawingSession('edge', true);
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    expect(drawingRepairProjection(useAppStore.getState(), currentReferenceRepairHoverId(session)).status).toBe('current');
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    cancelReferenceRepair(session);
  });

  it.each(['cancel', 'resolution', 'document-version'] as const)('removes the explanation after %s, even if the caller still supplies fresh=true', change => {
    const session = drawingSession('face');
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    expect(markup(session)).toContain('reference-repair-hover-unavailable');
    const state = useAppStore.getState();
    if (change === 'cancel') cancelReferenceRepair(session);
    if (change === 'resolution' && state.drawingResolution?.ok === true) useAppStore.setState({ drawingResolution: { ...state.drawingResolution } });
    if (change === 'document-version') useAppStore.setState({ documentVersion: state.documentVersion + 1 });
    expect(currentReferenceRepairHoverId(session)).toBeNull();
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    cancelReferenceRepair(session);
  });

  it('a second actual owned session does not make the first detail display its feedback', () => {
    const first = drawingSession('face'), second = beginReferenceRepair(first.slot.key);
    if (second === null) throw new Error('Second current owned session required');
    expect(hoverReferenceRepair(first, first.candidates[0])).toBe(true);
    expect(hoverReferenceRepair(second, second.candidates[0])).toBe(true);
    expect(markup(first)).not.toContain('reference-repair-hover-unavailable');
    expect(markup(second)).toContain(t('propertyPanel.repair.drawingHoverFace'));
    cancelReferenceRepair(first);
    expect(markup(second)).toContain(t('propertyPanel.repair.drawingHoverFace'));
    cancelReferenceRepair(second);
  });

  it('Part candidate and ordinary non-Drawing hover never produce a Drawing warning', () => {
    const fixture = repairFixture();
    useAppStore.getState().applyDocument(fixture.document);
    useAppStore.setState({ bodies: [fixture.body], isComputing: false, requestedGeneration: 1, completedGeneration: 1,
      lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null });
    const session = beginReferenceRepair(currentRepairSlots(useAppStore.getState())[0].key);
    if (session === null) throw new Error('Part session required');
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    expect(drawingRepairProjection(useAppStore.getState(), currentReferenceRepairHoverId(session))).toEqual({ status: 'idle', elements: [] });
    useAppStore.getState().setHovered('ordinary-owner');
    expect(markup(session)).not.toContain('reference-repair-hover-unavailable');
    cancelReferenceRepair(session);
  });
});
