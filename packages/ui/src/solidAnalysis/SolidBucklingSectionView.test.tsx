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
function receive(): void {
  const state = useAppStore.getState();
  const request: SolidBucklingInput = { schema: 'pointercad-solid-tet4-buckling/1', modeCount: 2, reference: {
    schema: 'pointercad-solid-tet4/1', source: { documentId: state.document.id, revision: state.completedGeneration, meshKey: 'mesh-a' },
    units: 'N-mm-MPa', numericBudgetBytes: 1_000_000, nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }], materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, false, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [-1000, 0, 0] }], surfaceLoads: [] } };
  const result: SolidBucklingResult = { kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1',
    scope: 'linear-elastic-prestress-bifurcation', units: 'N-mm-MPa', source: request.reference.source, inputSha256: '0'.repeat(64),
    freeDofs: 2, referenceEquilibriumResidual: 1e-13, maximumElementInitialStressError: 1e-12, structuralCertification: false, modes: [
      { number: 1, loadFactor: 26.3, normalizedResidual: 1e-12, shape: [[0, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0, 0]] },
      { number: 2, loadFactor: 91.9, normalizedResidual: 1e-12, shape: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]] }] };
  const id = useAppStore.getState().startSolidBuckling();
  useAppStore.getState().receiveSolidBuckling(id, { kind: 'result', input: request, result, loadedAreaMm2: 0, totalForceN: [-1000, 0, 0] });
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
beforeEach(() => {
  resetTestStore(); reset();
  useAppStore.getState().toggleStrength();
  useAppStore.setState({ solidAnalysisRunner: runner() });
  useAppStore.getState().openSolidAnalysis();
});
afterEach(() => { reset(); resetTestStore(); });

describe('SolidBucklingSection shape view', () => {
  it('offers the shape controls only with a result, labelled as a display amplitude with the meaning stated', () => {
    expect(markupOf(<SolidBucklingSection />)).not.toContain('data-testid="solid-buckling-view"');
    receive();
    const markup = markupOf(<SolidBucklingSection />);
    expect(markup).toContain('data-testid="solid-buckling-view"');
    expect(markup).toContain(t('solidAnalysis.bucklingShapeMeaning'));
    expect(markup).toContain(t('solidAnalysis.modalAmplitude'));
    expect(markup).toMatch(/data-testid="solid-buckling-show" checked=""/);
    expect(markup).toMatch(/<option value="1" selected="">1<\/option><option value="2">2<\/option>/);
    expect(markup).not.toContain('data-testid="solid-buckling-shape-unavailable"');
    expect(markup).toContain(t('solidAnalysis.bucklingLimit'));
  });

  it('flags an invalid amplitude entry and keeps drawing the last valid amplitude', () => {
    receive();
    const before = useAppStore.getState().solidBuckling.view;
    useAppStore.getState().setSolidBucklingView(before, '-3', true);
    const markup = markupOf(<SolidBucklingSection />);
    expect(markup).toContain(t('solidAnalysis.modalAmplitudeInvalid'));
    expect(useAppStore.getState().solidBuckling.view).toBe(before);
  });

  it('says the shape cannot be drawn once the result no longer matches the current generation', () => {
    receive();
    useAppStore.setState({ completedGeneration: useAppStore.getState().completedGeneration + 1 });
    expect(markupOf(<SolidBucklingSection />)).toContain('data-testid="solid-buckling-shape-unavailable"');
  });
});
