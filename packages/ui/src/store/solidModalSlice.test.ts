import type { SolidModalInput, SolidModalResult } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
import { initialSolidModalState } from '../solidAnalysis/solidModalState.js';
import { solidAnalysisLayersOf } from '../solidAnalysis/solidModalViewport.js';

function source() {
  const state = useAppStore.getState();
  return { documentId: state.document.id, revision: state.completedGeneration, meshKey: 'mesh-a' };
}
function input(): SolidModalInput {
  return {
    schema: 'pointercad-solid-tet4-modal/1', source: source(), units: 'N-mm-MPa', numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3, densityKgM3: 7850 }],
    constraints: [{ node: 0, fixed: [true, true, true] }], modeCount: 1,
  };
}
function result(request: SolidModalInput): SolidModalResult {
  return {
    kind: 'oofem-solid-tet4-modal', method: 'oofem-ltrspace-isole-consistent-mass-numpy-eigh/1', source: request.source,
    inputSha256: '0'.repeat(64), units: 'N-mm-MPa-t-s', structuralCertification: false, applicability: 'supported',
    nodes: request.nodes, fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, false]],
    rigidBodyModes: 0, freeDofs: 9, totalMassT: 1.3e-6,
    modes: [{ number: 1, eigenvaluePerSecondSquared: 4e8, frequencyHz: 3183.1, normalizedResidual: 1e-12,
      massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]] }],
    maximumMassOrthogonalityError: 1e-12, maximumRigidMotionResidual: 0, maximumElementMassError: 1e-14,
    reservedNumericBytes: 100_000, independentMaximumResidual: 1e-12, independentMaximumOrthogonalityError: 1e-12,
  };
}
function runner() {
  return { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn(), runModal: vi.fn(), cancelModal: vi.fn() };
}
function openWithResult(mockedRunner = runner()): SolidModalInput {
  useAppStore.getState().toggleStrength();
  useAppStore.setState({ solidAnalysisRunner: mockedRunner });
  useAppStore.getState().openSolidAnalysis();
  useAppStore.getState().editSolidModalInput('density', '7850');
  const request = input();
  const id = useAppStore.getState().startSolidModal();
  useAppStore.getState().receiveSolidModal(id, { kind: 'result', input: request, result: result(request) });
  return request;
}

beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState() }); });
afterEach(() => { useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState() }); resetTestStore(); });

describe('solid modal in the analysis store', () => {
  it('accepts only the current request and drops the result on static edit, close and reopen', () => {
    const mockedRunner = runner();
    openWithResult(mockedRunner);
    const stale = useAppStore.getState().solidModal.requestId;
    const current = useAppStore.getState().startSolidModal();
    const request = input();
    useAppStore.getState().receiveSolidModal(stale, { kind: 'result', input: request, result: result(request) });
    expect(useAppStore.getState().solidModal.status).toBe('running');
    useAppStore.getState().receiveSolidModal(current, { kind: 'result', input: request, result: result(request) });
    expect(useAppStore.getState().solidModal.status).toBe('result');
    useAppStore.getState().editSolidAnalysis('young', '210 GPa');
    expect(useAppStore.getState().solidModal.display).toBeNull();
    useAppStore.getState().receiveSolidModal(current, { kind: 'result', input: request, result: result(request) });
    expect(useAppStore.getState().solidModal.status).toBe('idle');
    const cancelModal = mockedRunner.cancelModal;
    useAppStore.getState().closeSolidAnalysis();
    expect(cancelModal).toHaveBeenCalled();
    expect(useAppStore.getState().solidModal.display).toBeNull();
    useAppStore.getState().openSolidAnalysis();
    expect(useAppStore.getState().solidModal.status).toBe('idle');
    // The typed physical input survives close/reopen in the same app session; nothing was written to the document.
    expect(useAppStore.getState().solidModal.densityText).toBe('7850');
  });

  it('display changes never touch the document, the request or the result', () => {
    const request = openWithResult();
    const document = useAppStore.getState().document, display = useAppStore.getState().solidModal.display;
    useAppStore.getState().setSolidModalView({ modeNumber: 1, amplitudeMm: 4, phase: -1 }, '4');
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().solidModal.input).toBe(request);
    expect(useAppStore.getState().solidModal.display).toBe(display);
  });

  it('cancels a running request through the runner and ignores its late reply', () => {
    const mockedRunner = runner();
    const cancelModal = mockedRunner.cancelModal;
    openWithResult(mockedRunner);
    const id = useAppStore.getState().startSolidModal();
    useAppStore.getState().cancelSolidModal();
    expect(cancelModal).toHaveBeenCalled();
    const request = input();
    useAppStore.getState().receiveSolidModal(id, { kind: 'result', input: request, result: result(request) });
    expect([useAppStore.getState().solidModal.status, useAppStore.getState().solidModal.display]).toEqual(['cancelled', null]);
  });

  it('keeps the stress field and the mode preview exclusive and clears the mode for another generation', () => {
    openWithResult();
    const layers = solidAnalysisLayersOf(useAppStore.getState());
    expect(layers.mode?.kind).toBe('preview');
    expect(layers.field).toBeNull();
    useAppStore.setState({ completedGeneration: useAppStore.getState().completedGeneration + 1 });
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
    useAppStore.getState().closeSolidAnalysis();
    expect(solidAnalysisLayersOf(useAppStore.getState())).toEqual({ field: null, mode: null });
  });

  it('saves only the physical modal input, keeps other inputs and restores the drafts on reopen; Undo removes it', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: runner() });
    useAppStore.getState().openSolidAnalysis();
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing solid session');
    useAppStore.setState({ solidAnalysisSession: { ...session, bodyFeatureId: 'box', fixedFaces: ['{"face":1}'] } });
    useAppStore.getState().editSolidAnalysis('young', '205 GPa');
    useAppStore.getState().editSolidAnalysis('poisson', '0.3');
    useAppStore.getState().editSolidAnalysis('volume', '1');
    useAppStore.getState().editSolidModalInput('density', '7850');
    useAppStore.getState().editSolidModalInput('modeCount', '4');
    useAppStore.getState().setSolidModalView({ modeNumber: 3, amplitudeMm: 25, phase: -1 }, '25');
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidModal();
    expect(useAppStore.getState().solidModal.error).toBeNull();
    const analyses = useAppStore.getState().document.beamAnalysisInputs?.analyses ?? [];
    const saved = analyses.find(value => value.kind === 'solid-modal-cad');
    expect(saved?.kind === 'solid-modal-cad' ? [saved.definition.densityKgM3, saved.definition.modeCount, saved.definition.fixedFaces] : null)
      .toEqual([7850, 4, ['{"face":1}']]);
    expect(JSON.stringify(saved)).not.toMatch(/amplitude|phase|modeNumber/);
    useAppStore.getState().closeSolidAnalysis();
    useAppStore.setState({ solidModal: initialSolidModalState() });
    useAppStore.getState().openSolidAnalysis();
    expect([useAppStore.getState().solidModal.densityText, useAppStore.getState().solidModal.modeCountText]).toEqual(['7850', '4']);
    expect(useAppStore.getState().solidAnalysisSession?.bodyFeatureId).toBe('box');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(before.beamAnalysisInputs);
  });
});
