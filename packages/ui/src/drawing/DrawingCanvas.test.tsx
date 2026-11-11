import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDrawingDocument, IDENTITY_PLACEMENT, type SolidBody } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { drawingRepairHoverId, clearDrawingRepairDescriptor } from './referenceRepairProjection.js';
import { DrawingCanvas } from './DrawingCanvas.js';

vi.mock('./drawingFont.js', () => ({ drawingFont: { status: 'ready', load: () => Promise.resolve('ready'),
  outline: () => ({ status: 'ready', subpaths: [], fillRule: 'nonzero', metrics: null, missingCharacters: [] }) } }));

beforeEach(() => {
  resetTestStore();
  const fixture = repairFixture();
  const origin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'base', role: 'bottom-front' } } as const;
  const body: SolidBody = { ...fixture.body, origins: { version: 1, state: 'tracked', bindings: [{ origin,
    state: 'unique', current: { kind: 'edge', index: 0 } }] } };
  const document = { ...createDrawingDocument('canvas', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad',
    path: '', contentHash: 'hash', importedAt: '' }), views: [{ id: 'front', name: 'front', kind: 'front' as const,
    position: [100, 100] as const, scale: 1, direction: [0, 1, 0] as const, xDir: [1, 0, 0] as const,
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
  useAppStore.getState().openDrawing(document);
  const provenance = { kind: 'edge', dimensionTarget: true, bodyId: 'worker-body', edgeIndex: 0, occurrenceId: null, parameterRange: [0, 10] };
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [{ viewId: 'front', name: 'front', position: [100, 100], scale: 1,
      visible: [{ curve: { kind: 'segment', from: [100, 100], to: [110, 100] }, provenance },
        { curve: { kind: 'segment', from: [100, 100], to: [110, 100] }, provenance: { ...provenance, bodyId: 'unrelated-body' } }],
      hidden: [], cuttingCurves: [] }], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['worker-body'], center: [0, 0, 0], dimensionInstances: [{
      sourceRef: 'source', bodyId: 'worker-body', body, placement: IDENTITY_PLACEMENT }] } });
  const hover = drawingRepairHoverId(useAppStore.getState(), { sourceRef: 'source' }, { ...fixture.reference, origin }, {});
  if (hover === null) throw new Error('Current descriptor required');
  useAppStore.getState().setHovered(hover);
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => {
  const id = useAppStore.getState().hoveredElementId;
  if (id !== null) clearDrawingRepairDescriptor(id);
  vi.restoreAllMocks(); resetTestStore();
});
const render = (): string => renderToStaticMarkup(createElement(DrawingCanvas));

describe('actual DrawingCanvas repair SVG output', () => {
  it('renders one exact provenance overlay path while retaining two original coincident paths and normal selection', () => {
    const before = useAppStore.getState(), html = render();
    expect(html).toContain('data-reference-repair-hover-status="current"');
    expect(html).toContain('stroke="#f59e0b"');
    expect(html.match(/data-owner-id="reference-repair-drawing:/g)).toHaveLength(1);
    expect(html.match(/data-owner-id="front"/g)).toHaveLength(2);
    expect(useAppStore.getState()).toBe(before);
  });
  it('clearing hover removes actual overlay and retains the original canvas geometry', () => {
    const state = useAppStore.getState(), id = state.hoveredElementId;
    if (id !== null) clearDrawingRepairDescriptor(id);
    state.setHovered(null);
    const html = render();
    expect(html).toContain('data-reference-repair-hover-status="idle"');
    expect(html).not.toContain('stroke="#f59e0b"');
    expect(html.match(/data-owner-id="front"/g)).toHaveLength(2);
  });
  it('a stale source resolution renders no overlay and reports its uncovered reason', () => {
    const source = useAppStore.getState().drawingSourceResolution;
    if (source === null) throw new Error('Source required');
    useAppStore.setState({ drawingSourceResolution: { ...source } });
    const html = render();
    expect(html).toContain('data-reference-repair-hover-reason="stale-owner"');
    expect(html).not.toContain('stroke="#f59e0b"');
    expect(html.match(/data-owner-id="front"/g)).toHaveLength(2);
  });
});
