import React from 'react';
import { analyzeCadSolidFinite } from '@pointercad/fem';
import { createSubShapeReference } from '@pointercad/model';
import { solidCadFaceKey } from '@pointercad/model/beam-analysis';
import { context, finiteSettings, kernel, ownedClient } from '@pointercad/fem/testing/ui-fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidFinitePanel, cauchyVonMises } from './SolidFinitePanel.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  useAppStore.getState().toggleStrength();
  useAppStore.getState().openSolidFinite();
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('finite-strain panel', () => {
  it('shows the two explicit step factors, dead-load limitation and blank material input', () => {
    const session = useAppStore.getState().solidFiniteSession;
    if (!session) throw new Error('Missing real finite session');
    const html = renderToStaticMarkup(<SolidFinitePanel session={session} />);
    expect(html).toContain('data-testid="solid-finite-forceFactors-0"');
    expect(html).toContain('data-testid="solid-finite-prescribedFactors-0"');
    expect(html).toContain('変形に追従する圧力は扱えません');
    expect(html).not.toContain('data-testid="solid-finite-results"');
    expect(session.values.young).toBe(''); expect(session.values.reference).toBe('');
  });
  it('computes equivalent stress from the Cauchy tensor in MPa, including shear', () => {
    expect(cauchyVonMises([100, 0, 0, 0, 0, 0, 0, 0, 0])).toBeCloseTo(100, 12);
    expect(cauchyVonMises([0, 10, 0, 10, 0, 0, 0, 0, 0])).toBeCloseTo(Math.sqrt(3) * 10, 12);
    expect(cauchyVonMises([50, 0, 0, 0, 50, 0, 0, 0, 50])).toBe(0);
  });
  it('renders the actual finite result schema with Cauchy stress and force units', async () => {
    // Synthetic zero-state Worker data checks presentation only; it is not native solver evidence.
    const base = context(), state = useAppStore.getState();
    const fixture = { ...base, documentId: state.document.id, revision: state.completedGeneration };
    const settings = finiteSettings(fixture), synthetic = ownedClient();
    const outcome = await analyzeCadSolidFinite(synthetic.client, kernel(), () => fixture, settings);
    if (outcome.kind !== 'result') throw new Error('Synthetic finite result missing');
    const fixed = createSubShapeReference(fixture.body, 'face', 0), loaded = createSubShapeReference(fixture.body, 'face', 1);
    if (!fixed?.origin || !loaded?.origin) throw new Error('Fixture face references missing');
    const current = useAppStore.getState().solidFiniteSession;
    if (!current) throw new Error('Missing finite session');
    const session = { ...current, bodyFeatureId: 'box', fixedFaces: [solidCadFaceKey(fixed)], loadedFaces: [solidCadFaceKey(loaded)],
      result: outcome, status: 'complete' as const, values: { ...current.values, young: '210000', poisson: '0', yield: '250',
        hardening: '1000', tz: '2', volume: '0.1', forceFactors: '0', prescribedFactors: '0', referenceForce: '1',
        reference: settings.materialReference } };
    const html = renderToStaticMarkup(<SolidFinitePanel session={session} />);
    expect(html).toContain('data-testid="solid-finite-results"');
    expect(html).toContain('data-testid="solid-finite-field-step"');
    expect(html).toContain('data-testid="solid-finite-field-scale"');
    expect(html).toContain('data-testid="solid-finite-field-legend"');
    expect(html).toContain('Cauchy 相当応力 (MPa)');
    expect(html).toContain('支持反力 X, Y, Z (N)');
    expect(html).toContain('最大変位 (mm)');
    synthetic.client.dispose();
  });
  it('renders each supplied history entry as its own step without inserting a zero', () => {
    useAppStore.getState().editSolidFinite({ kind: 'field', field: 'forceFactors', value: '2,-1,2' });
    useAppStore.getState().editSolidFinite({ kind: 'field', field: 'prescribedFactors', value: '1,0,0.5' });
    const session = useAppStore.getState().solidFiniteSession;
    if (!session) throw new Error('Missing real finite session');
    const html = renderToStaticMarkup(<SolidFinitePanel session={session} />);
    expect(html).toContain('data-testid="solid-finite-forceFactors-2"');
    expect(html).not.toContain('data-testid="solid-finite-forceFactors-3"');
    expect(session.values.forceFactors).toBe('2,-1,2');
  });
});
