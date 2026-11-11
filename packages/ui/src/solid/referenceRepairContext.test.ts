import { createDrawingDocument, IDENTITY_PLACEMENT, type SolidBody } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair, hoverReferenceRepair } from './referenceRepair.js';
import { drawingRepairDescriptorObservation } from '../drawing/referenceRepairProjection.js';

beforeEach(() => {
  resetTestStore();
  const fixture = repairFixture();
  const edgeOrigin = (role: 'bottom-front' | 'top-front' | 'front-left') => ({ version: 1 as const, shapeKind: 'edge' as const,
    identity: { kind: 'box-edge' as const, featureId: 'base', role } });
  const body: SolidBody = { ...fixture.body, origins: { version: 1, state: 'tracked', bindings: [
    { origin: edgeOrigin('bottom-front'), state: 'unique', current: { kind: 'edge', index: 0 } },
    { origin: edgeOrigin('top-front'), state: 'unique', current: { kind: 'edge', index: 1 } },
    { origin: edgeOrigin('front-left'), state: 'missing', reason: 'deleted' },
  ] } };
  const document = { ...createDrawingDocument('repair', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad',
    path: '', contentHash: 'hash', importedAt: '' }), dimensions: [{ id: 'dimension', kind: 'length' as const,
    measurement: 'trueDistance' as const, targets: ['source', 'other'].map(sourceRef => ({ kind: 'subShape' as const,
      sourceRef, viewId: 'front', ref: { ...fixture.reference, origin: edgeOrigin('front-left') } })),
    placement: { commonNormalCoordinate: 12, textPosition: null }, reference: false, origin: 'manual' as const, layerId: 'layer-1' }] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 1, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['source', 'other'], center: [0, 0, 0], dimensionInstances: ['source', 'other'].map(sourceRef => ({
      sourceRef, bodyId: sourceRef, body, placement: IDENTITY_PLACEMENT })) } });
});
afterEach(resetTestStore);
function begin() {
  const session = beginReferenceRepair(currentRepairSlots(useAppStore.getState())[0].key);
  if (session === null || session.candidates.length === 0) throw new Error('Current candidates required');
  return session;
}

describe('Drawing repair transient ownership', () => {
  it('hover/cancel changes no saved JSON, Undo, Redo or ordinary selection', () => {
    const session = begin(), before = useAppStore.getState(), saved = JSON.stringify(before.drawing);
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    expect(useAppStore.getState().hoveredElementId).toMatch(/^reference-repair-drawing:/);
    cancelReferenceRepair(session);
    const after = useAppStore.getState();
    expect(JSON.stringify(after.drawing)).toBe(saved);
    expect(after.drawingUndoStack).toBe(before.drawingUndoStack);
    expect(after.drawingSelectedIds).toBe(before.drawingSelectedIds);
    expect(after.selection).toBe(before.selection);
    expect(after.hoveredElementId).toBeNull();
    expect(drawingRepairDescriptorObservation()).toEqual({ active: false, identityCount: 0 });
  });
  it('old session cancel cannot clear the newer session hovering the same exact candidate', () => {
    const first = begin(), second = begin();
    hoverReferenceRepair(first, first.candidates[0]);
    const firstId = useAppStore.getState().hoveredElementId;
    hoverReferenceRepair(second, second.candidates[0]);
    const secondId = useAppStore.getState().hoveredElementId;
    expect(firstId).not.toBe(secondId);
    cancelReferenceRepair(first);
    expect(useAppStore.getState().hoveredElementId).toBe(secondId);
    expect(drawingRepairDescriptorObservation().active).toBe(true);
    cancelReferenceRepair(second);
  });
  it('cancel leaves another ordinary hover owner unchanged', () => {
    const session = begin();
    hoverReferenceRepair(session, session.candidates[0]);
    useAppStore.getState().setHovered('ordinary-owner');
    cancelReferenceRepair(session);
    expect(useAppStore.getState().hoveredElementId).toBe('ordinary-owner');
    expect(drawingRepairDescriptorObservation().active).toBe(false);
  });
  it('confirm changes only one target and one history entry; double and old-generation confirm change zero', () => {
    const session = begin(), before = useAppStore.getState(), other = before.drawing?.dimensions[0].targets[1];
    expect(commitReferenceRepair(session, session.candidates[0])).toBe('applied');
    const after = useAppStore.getState();
    expect(after.drawing?.dimensions[0].targets[1]).toBe(other);
    expect(after.drawingUndoStack?.past).toHaveLength((before.drawingUndoStack?.past.length ?? 0) + 1);
    expect(commitReferenceRepair(session, session.candidates[0])).toBe('stale');
    expect(useAppStore.getState()).toBe(after);
  });
  it('resolution replacement cancels old hover and rejects stale confirmation', () => {
    const session = begin(); hoverReferenceRepair(session, session.candidates[0]);
    const state = useAppStore.getState(), resolution = state.drawingResolution;
    if (resolution?.ok !== true) throw new Error('Current resolution required');
    useAppStore.setState({ drawingResolution: { ...resolution } });
    const before = useAppStore.getState();
    expect(before.hoveredElementId).toBeNull();
    expect(drawingRepairDescriptorObservation().active).toBe(false);
    expect(commitReferenceRepair(session, session.candidates[0])).toBe('stale');
    expect(useAppStore.getState()).toBe(before);
  });
  it('Doc A→B→A rejects the captured old candidate while an independent strong body borrower remains', () => {
    const session = begin(), document = useAppStore.getState().drawing, candidate = session.candidates[0];
    if (candidate === undefined) throw new Error('Original current candidate required before cancellation');
    const body = candidate.body;
    if (document === null) throw new Error('Drawing required');
    hoverReferenceRepair(session, session.candidates[0]);
    useAppStore.getState().openDrawing({ ...document, id: 'other-document' });
    useAppStore.getState().openDrawing(document);
    const before = useAppStore.getState();
    expect(commitReferenceRepair(session, candidate)).toBe('stale');
    expect(useAppStore.getState()).toBe(before);
    expect(before.hoveredElementId).toBeNull();
    expect(drawingRepairDescriptorObservation().active).toBe(false);
    // Cancellation retires the public cell; the independently captured actual borrower remains live.
    // Neither observation asserts host collection or actual driver GPU release.
    expect(session.candidates).toEqual([]);
    expect(session.slot.bodies).toEqual([]);
    expect(candidate.body).toBe(body);
    expect(body.mesh.positions.byteLength).toBeGreaterThan(0);
  });
  it('an unproven split candidate clears only the same session hover and leaves an ordinary owner intact', () => {
    const state = useAppStore.getState(), source = state.drawingSourceResolution, first = source?.dimensionInstances?.[0];
    if (source === null || first === undefined) throw new Error('Current source required');
    const body = first.body, bindings = body.origins?.state === 'tracked' ? body.origins.bindings : [];
    const missing = bindings.find(binding => binding.origin.identity.kind === 'box-edge' && binding.origin.identity.role === 'front-left');
    if (missing === undefined) throw new Error('Missing origin required');
    const split: SolidBody = { ...body, origins: { version: 1, state: 'tracked', bindings: [bindings[0],
      { origin: missing.origin, state: 'split', candidates: [{ kind: 'edge', index: 1 }, { kind: 'edge', index: 2 }] }] } };
    useAppStore.setState({ drawingSourceResolution: { ...source, dimensionInstances: [{ ...first, body: split }] } });
    const session = begin(), good = session.candidates.find(candidate => candidate.selectable), bad = session.candidates.find(candidate => !candidate.selectable);
    if (good === undefined || bad === undefined) throw new Error('Unique and split candidates required');
    expect(hoverReferenceRepair(session, good)).toBe(true);
    expect(hoverReferenceRepair(session, bad)).toBe(false);
    expect(useAppStore.getState().hoveredElementId).toBeNull();
    expect(hoverReferenceRepair(session, good)).toBe(true);
    useAppStore.getState().setHovered('ordinary-owner');
    expect(hoverReferenceRepair(session, bad)).toBe(false);
    expect(useAppStore.getState().hoveredElementId).toBe('ordinary-owner');
    cancelReferenceRepair(session);
  });
});
