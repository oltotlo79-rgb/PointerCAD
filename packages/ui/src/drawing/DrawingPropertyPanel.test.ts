import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDrawingDocument, IDENTITY_PLACEMENT } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { beginReferenceRepair, cancelReferenceRepair } from '../solid/referenceRepair.js';
import { currentRepairSlots } from '../solid/referenceRepairContext.js';
import { DrawingPropertyPanel } from './DrawingPropertyPanel.js';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

beforeEach(() => {
  resetTestStore();
  const { body, reference } = repairFixture();
  const document = { ...createDrawingDocument('repair drawing', { sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad',
    path: '', contentHash: 'hash', importedAt: '' }), dimensions: [{
    id: 'repair-dimension', kind: 'length' as const, measurement: 'trueDistance' as const,
    targets: ['source', 'other'].map(sourceRef => ({ kind: 'subShape' as const, sourceRef, viewId: 'front', ref: reference })),
    placement: { commonNormalCoordinate: 12, textPosition: null }, reference: false, origin: 'manual' as const, layerId: 'layer-1',
  }] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingSelectedIds: [], drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 1, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['source', 'other'], center: [0, 0, 0],
      dimensionInstances: ['source', 'other'].map(sourceRef => ({ sourceRef, bodyId: sourceRef, body, placement: IDENTITY_PLACEMENT })) } });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.restoreAllMocks(); resetTestStore();
});
const render = (): string => renderToStaticMarkup(createElement(DrawingPropertyPanel));

describe('Drawing repair entry in the actual property panel', () => {
  it('exposes unresolved repair without selection and keeps existing sections and document/history unchanged', () => {
    const before = useAppStore.getState(), html = render();
    expect(html).toContain('data-testid="reference-repair"');
    expect(html).toContain(t('propertyPanel.repair.open'));
    expect(html).toContain('data-property-kind="dimension"');
    expect(html).toContain('data-property-kind="annotation"');
    expect(useAppStore.getState()).toBe(before);
    expect(before.drawingSelectedIds).toEqual([]);
  });
  it('renders original, current candidates and both source impacts together without committing', async () => {
    const session = beginReferenceRepair(currentRepairSlots(useAppStore.getState())[0].key);
    if (session === null) throw new Error('Current drawing repair session required');
    const actual = await vi.importActual<typeof import('react')>('react');
    let selectorReady = false, injected = 0;
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
      const state = actual.useState(initial);
      if (typeof initial === 'function' && typeof state[0] === 'function') selectorReady = true;
      else if (selectorReady && initial === null && injected === 0) {
        selectorReady = false; injected += 1;
        return [session, state[1]];
      }
      return state;
    });
    const before = useAppStore.getState(), html = render();
    expect(injected).toBe(1);
    for (const key of ['propertyPanel.repair.original', 'propertyPanel.repair.candidates', 'propertyPanel.repair.impacts',
      'propertyPanel.repair.cancel', 'propertyPanel.repair.confirm'] as const) expect(html).toContain(t(key));
    expect(html).toContain('辺 99');
    expect(html).toContain('長さ 10 mm');
    expect(html).toContain('長さ 40 mm');
    expect(session.impacts).toHaveLength(2);
    expect(useAppStore.getState()).toBe(before);
    cancelReferenceRepair(session);
  });
  it('preserves selected dimension value/tolerance controls and pending repair disables mutation', () => {
    const state = useAppStore.getState(), resolution = state.drawingResolution, dimension = state.drawing?.dimensions[0];
    if (resolution?.ok !== true || dimension === undefined) throw new Error('Current dimension required');
    useAppStore.setState({ drawingSelectedIds: [dimension.id], drawingBusy: true,
      drawingResolution: { ...resolution, dimensions: [{ dimension, targets: [], value: null, coordinates: null,
        text: 'unresolved dimension value', status: 'unresolved', reason: 'measurement' }] } });
    const before = useAppStore.getState(), html = render();
    expect(html).toContain('unresolved dimension value');
    expect(html).toContain(t('drawing.tolerance.title'));
    expect(html).toContain(t('drawing.error.dimensionReadOnly'));
    expect(html).toContain(t('propertyPanel.repair.pending'));
    expect(html).toContain('disabled=""');
    expect(useAppStore.getState()).toBe(before);
  });
});
