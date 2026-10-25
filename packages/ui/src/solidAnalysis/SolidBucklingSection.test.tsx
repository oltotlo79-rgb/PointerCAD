import type { SolidBucklingInput, SolidBucklingResult } from '@pointercad/fem';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidBucklingSection } from './SolidBucklingSection.js';
import { initialSolidBucklingState } from './solidBucklingState.js';

const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn(), runModal: vi.fn(), cancelModal: vi.fn(),
  runBuckling: vi.fn(), cancelBuckling: vi.fn() });
function input(): SolidBucklingInput {
  return { schema: 'pointercad-solid-tet4-buckling/1', modeCount: 2, reference: {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'doc-1', revision: 4, meshKey: 'mesh-a' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1_000_000, nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }], materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 3, fixed: [true, true, true] }], nodalLoads: [], surfaceLoads: [{ nodes: [0, 2, 1], tractionMPa: [0, 0, 1] }] } };
}
function result(request: SolidBucklingInput): SolidBucklingResult {
  const shape: SolidBucklingResult['modes'][number]['shape'] = [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]];
  return { kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1', scope: 'linear-elastic-prestress-bifurcation',
    units: 'N-mm-MPa', source: request.reference.source, inputSha256: '0'.repeat(64), freeDofs: 9, referenceEquilibriumResidual: 1e-13,
    maximumElementInitialStressError: 1e-12, structuralCertification: false,
    modes: [{ number: 1, loadFactor: 120, normalizedResidual: 1e-12, shape }, { number: 2, loadFactor: 340, normalizedResidual: 2e-12, shape }] };
}
function open(value: ReturnType<typeof runner> | null = runner()) {
  useAppStore.getState().toggleStrength();
  useAppStore.setState({ solidAnalysisRunner: value });
  useAppStore.getState().openSolidAnalysis();
}
/**
 * Server rendering normally reads the store's initial snapshot (zustand passes getInitialState as getServerSnapshot),
 * not the state the test just wrote. Same deliberate current-snapshot pattern as ParameterPanel.test.ts: only the
 * snapshot source is replaced for this one render; the real store, selectors and actions are used unchanged.
 */
function markupOf(node: ReactElement): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(node); } finally { snapshot.mockRestore(); }
}
const reset = () => {
  useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidBuckling: initialSolidBucklingState(), solidBucklingReference: null });
};
beforeEach(() => { resetTestStore(); reset(); });
afterEach(() => { reset(); resetTestStore(); });

describe('SolidBucklingSection', () => {
  it('always states the limits and runs only with a valid count and a buckling runner', () => {
    open();
    const ready = markupOf(<SolidBucklingSection />);
    expect(ready).toContain(t('solidAnalysis.bucklingLimit'));
    expect(ready).toContain(t('solidAnalysis.bucklingHelp'));
    expect(ready).toContain(t('solidAnalysis.bucklingEmpty'));
    expect(ready).toMatch(/<label>[^<]*<input type="text" inputmode="numeric" data-testid="solid-buckling-count"/i);
    expect(ready).not.toMatch(/data-testid="solid-buckling-run" disabled=""/);
    useAppStore.getState().editSolidBucklingCount('13');
    const invalid = markupOf(<SolidBucklingSection />);
    expect(invalid).toContain(t('solidAnalysis.bucklingInputInvalid'));
    expect(invalid).toMatch(/data-testid="solid-buckling-run" disabled=""/);
  });

  it('cannot run without a runner that supports the buckling analysis', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
    useAppStore.getState().openSolidAnalysis();
    expect(markupOf(<SolidBucklingSection />)).toMatch(/data-testid="solid-buckling-run" disabled=""/);
  });

  it('lists the paired load factors of the whole reference load with the limits', () => {
    open();
    const request = input();
    const id = useAppStore.getState().startSolidBuckling();
    useAppStore.getState().receiveSolidBuckling(id, { kind: 'result', input: request, result: result(request), loadedAreaMm2: 50, totalForceN: [0, 0, 50] });
    const markup = markupOf(<SolidBucklingSection />);
    expect(markup).toContain(t('solidAnalysis.bucklingFactor'));
    expect(markup).toMatch(/data-testid="solid-buckling-factor-1"><td>1<\/td><td>120<\/td>/);
    expect(markup).toMatch(/data-testid="solid-buckling-factor-2"><td>2<\/td><td>340<\/td>/);
    expect(markup).not.toContain('solid-buckling-factor-3');
    expect(markup).toContain('0, 0, 50 N');
    expect(markup).toContain(t('solidAnalysis.bucklingLimit'));
    expect(markup).not.toContain(t('solidAnalysis.bucklingEmpty'));
  });

  it('explains a tension or stress-free reference and shows no factor', () => {
    open();
    const id = useAppStore.getState().startSolidBuckling();
    const message = 'solid-buckling-no-positive-mode: 0 positive load factor(s) for 3 requested';
    useAppStore.getState().receiveSolidBuckling(id, { kind: 'failed', code: 'buckling-no-compression', message });
    const markup = markupOf(<SolidBucklingSection />);
    expect(markup).toContain(t('solidAnalysis.bucklingNoCompression'));
    expect(markup).toContain(message);
    expect(markup).not.toContain('solid-buckling-factor-');
  });

  it('shows an independently held reference with the explicit adopt action', () => {
    open();
    useAppStore.setState({ solidBucklingReference: { schema: 'pointercad-solid-cad-input/2', id: 'solid-cad', source: { documentId: 'doc-1' },
      bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}', '{"face":3}'], youngMPa: 70000, poisson: 0.25,
      load: 'pressure', pressureMPa: 1.5, linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2,
      maximumVolumeDeviationMm3: 1 } });
    const markup = markupOf(<SolidBucklingSection />);
    expect(markup).toContain(t('solidAnalysis.bucklingOwnInputs'));
    expect(markup).toContain('data-testid="solid-buckling-adopt"');
    expect(markup).toContain('<dd>70000</dd>');
    expect(markup).toContain('<dd>1.5</dd>');
    expect(markup).toContain('<dd>2</dd>');
  });
});
