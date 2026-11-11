import { createDrawingDocument, IDENTITY_PLACEMENT, type SolidBody, type SubShapeRef, type ResolvedDrawingView } from '@pointercad/model';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { drawingRepairHoverId, drawingRepairProjection, clearDrawingRepairDescriptor, drawingRepairDescriptorObservation } from './referenceRepairProjection.js';

const origin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'base', role: 'bottom-front' } } as const;
function setup(swapped = false) {
  const fixture = repairFixture(), index = swapped ? 1 : 0;
  const body: SolidBody = { ...fixture.body, edges: fixture.body.edges.map((edge, at) => ({ ...edge, index: swapped ? 1 - at : at })),
    origins: { version: 1, state: 'tracked', bindings: [{ origin, state: 'unique', current: { kind: 'edge', index } }] } };
  const reference: SubShapeRef = { ...fixture.reference, origin };
  const document = { ...createDrawingDocument('hover', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad',
    path: '', contentHash: 'hash', importedAt: '' }), views: [{ id: 'front', name: 'front', kind: 'front' as const,
    position: [100, 100] as const, scale: 1, direction: [0, 1, 0] as const, xDir: [1, 0, 0] as const,
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
  const matching: ResolvedDrawingView['visible'][number] = { curve: { kind: 'segment', from: [100, 100], to: [110, 100] },
    provenance: { kind: 'edge', dimensionTarget: true, bodyId: 'worker-body', edgeIndex: index,
      occurrenceId: 'component-a', parameterRange: [0, 10] } };
  const projected: ResolvedDrawingView = { viewId: 'front', name: 'front', position: [100, 100], scale: 1,
    visible: [matching, { ...matching, provenance: { ...matching.provenance, occurrenceId: 'component-b' } },
      { ...matching, provenance: { ...matching.provenance, bodyId: 'other-body' } },
      { ...matching, provenance: { ...matching.provenance, sourceRef: 'other-source' } }], hidden: [], cuttingCurves: [] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [projected], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['worker-body'], center: [0, 0, 0], dimensionInstances: [{
      sourceRef: 'source', componentId: 'component-a', bodyId: 'worker-body', body, placement: IDENTITY_PLACEMENT }] } });
  return { body, reference, document, projected, matching, index };
}
const slot = { sourceRef: 'source', componentId: 'component-a' };
function id(reference: SubShapeRef, owner: object = {}): string {
  const value = drawingRepairHoverId(useAppStore.getState(), slot, reference, owner);
  if (value === null) throw new Error('Certified current descriptor required');
  return value;
}
beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('repair projection current provenance', () => {
  it.each([false, true])('semantic edge with swapped index=%s selects only its exact current source/body/occurrence', swapped => {
    const { reference, matching } = setup(swapped), hover = id(reference), before = useAppStore.getState();
    const result = drawingRepairProjection(before, hover);
    expect(result.status).toBe('current');
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].curves).toEqual([matching.curve]);
    expect(useAppStore.getState()).toBe(before);
    clearDrawingRepairDescriptor(hover);
  });
  it('rejects same coordinates from another document source rather than borrowing its projection', () => {
    const { body, reference } = setup(), state = useAppStore.getState(), source = state.drawingSourceResolution;
    if (source === null) throw new Error('Source required');
    useAppStore.setState({ drawingSourceResolution: { ...source, dimensionInstances: [{ sourceRef: 'other-source',
      componentId: 'component-a', bodyId: 'worker-body', body, placement: IDENTITY_PLACEMENT }] } });
    const hover = drawingRepairHoverId(useAppStore.getState(), { ...slot, sourceRef: 'other-source' }, reference, {});
    expect(hover).not.toBeNull();
    expect(drawingRepairProjection(useAppStore.getState(), hover)).toMatchObject({ status: 'unavailable', reason: 'source-not-projected', elements: [] });
    if (hover !== null) clearDrawingRepairDescriptor(hover);
  });
  it.each(['resolution', 'source', 'document-version', 'body'] as const)('invalidates old %s owner without accepting same-looking replacements', change => {
    const { reference } = setup(), hover = id(reference), state = useAppStore.getState();
    if (change === 'resolution' && state.drawingResolution?.ok === true) useAppStore.setState({ drawingResolution: { ...state.drawingResolution } });
    if (change === 'source' && state.drawingSourceResolution !== null) useAppStore.setState({ drawingSourceResolution: { ...state.drawingSourceResolution } });
    if (change === 'document-version') useAppStore.setState({ documentVersion: state.documentVersion + 1 });
    if (change === 'body' && state.drawingSourceResolution !== null) {
      const first = state.drawingSourceResolution.dimensionInstances?.[0];
      if (first === undefined) throw new Error('Instance required');
      useAppStore.setState({ drawingSourceResolution: { ...state.drawingSourceResolution,
        dimensionInstances: [{ ...first, body: { ...first.body } }] } });
    }
    expect(drawingRepairProjection(useAppStore.getState(), hover)).toMatchObject({ status: 'unavailable', reason: 'stale-owner', elements: [] });
    clearDrawingRepairDescriptor(hover);
  });
  it('keeps one bounded weak identity set, rejects old session id, and old cancel cannot clear newer descriptor', () => {
    const { reference } = setup(), first = id(reference, {}), second = id(reference, {});
    expect(first).not.toBe(second);
    expect(drawingRepairDescriptorObservation()).toEqual({ active: true, identityCount: 5 });
    clearDrawingRepairDescriptor(first);
    expect(drawingRepairProjection(useAppStore.getState(), second).status).toBe('current');
    expect(drawingRepairProjection(useAppStore.getState(), first)).toMatchObject({ status: 'unavailable', reason: 'stale-owner' });
    clearDrawingRepairDescriptor(second);
    expect(drawingRepairDescriptorObservation()).toEqual({ active: false, identityCount: 0 });
    expect(drawingRepairProjection(useAppStore.getState(), second).status).toBe('unavailable');
  });
  it('silhouette and uncertified edge provenance cannot become an approximate overlay', () => {
    const { reference, matching } = setup(), state = useAppStore.getState(), resolution = state.drawingResolution;
    if (resolution?.ok !== true) throw new Error('Resolution required');
    const view = resolution.projection.views[0];
    useAppStore.setState({ drawingResolution: { ...resolution, projection: { ...resolution.projection, views: [{ ...view,
      visible: [{ ...matching, provenance: { ...matching.provenance, kind: 'silhouette', dimensionTarget: false } }] }] } } });
    const hover = id(reference);
    expect(drawingRepairProjection(useAppStore.getState(), hover)).toMatchObject({ status: 'unavailable', reason: 'no-certified-projection', elements: [] });
    clearDrawingRepairDescriptor(hover);
  });
  it('malformed, oversized and normal hover strings fail safely', () => {
    setup();
    expect(drawingRepairProjection(useAppStore.getState(), 'ordinary-selection')).toEqual({ status: 'idle', elements: [] });
    for (const value of ['reference-repair-drawing:{', 'reference-repair-drawing:[]', `reference-repair-drawing:${'x'.repeat(17000)}`]) {
      expect(drawingRepairProjection(useAppStore.getState(), value)).toMatchObject({ status: 'unavailable', reason: 'malformed-descriptor', elements: [] });
    }
  });
  it.each(['face', 'vertex'] as const)('%s semantic identity without proven projection stays unavailable', kind => {
    const { body } = setup(), source = useAppStore.getState().drawingSourceResolution;
    if (source === null) throw new Error('Source required');
    const faceOrigin = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'base', role: 'top' } } as const;
    const vertexOrigin = { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'base', role: 'bottom-front-left' } } as const;
    const current: SolidBody = { ...body,
      faces: [{ index: 0, surfaceKind: 'plane', area: 100, centroid: [0, 0, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }],
      vertices: [{ index: 0, position: [0, 0, 0] }], origins: { version: 1, state: 'tracked', bindings: [
        { origin: faceOrigin, state: 'unique', current: { kind: 'face', index: 0 } },
        { origin: vertexOrigin, state: 'unique', current: { kind: 'vertex', index: 0 } },
      ] } };
    useAppStore.setState({ drawingSourceResolution: { ...source, dimensionInstances: [{ sourceRef: 'source', componentId: 'component-a',
      bodyId: 'worker-body', body: current, placement: IDENTITY_PLACEMENT }] } });
    const reference: SubShapeRef = kind === 'face' ? { bodyFeatureId: 'base', index: 0, origin: faceOrigin,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 10], axis: [0, 0, 1], radius: null } }
      : { bodyFeatureId: 'base', index: 0, origin: vertexOrigin, fingerprint: { kind: 'vertex', position: [0, 0, 0] } };
    const hover = id(reference);
    expect(drawingRepairProjection(useAppStore.getState(), hover)).toMatchObject({ status: 'unavailable',
      reason: kind === 'face' ? 'face-provenance-unproved' : 'vertex-provenance-unproved', elements: [] });
    clearDrawingRepairDescriptor(hover);
  });
});
