import type { FemWorkerPort, SolidBucklingInput, SolidBucklingResult, SolidModalInput, SolidModalResult } from '@pointercad/fem';
import type { AnalysisBoundarySource } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSolidAnalysis } from './attachSolidAnalysis.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { initialSolidBucklingState, setSolidBucklingView, solidBucklingPreview } from './solidBucklingState.js';
import { initialSolidModalState, solidModalPreview } from './solidModalState.js';
import { solidAnalysisLayersOf, solidBucklingCurrentSource, solidModalCurrentSource } from './solidModalViewport.js';

/** The buckling shape in the store and the one viewport mode layer: drawn only for the current paired result, exclusive
 * with the modal preview and the stress field, and gone after an edit, a new generation, cancel or close. */
function source() {
  const state = useAppStore.getState();
  return { documentId: state.document.id, revision: state.completedGeneration, meshKey: 'mesh-a' };
}
function bucklingInput(): SolidBucklingInput {
  return { schema: 'pointercad-solid-tet4-buckling/1', modeCount: 2, reference: {
    schema: 'pointercad-solid-tet4/1', source: source(), units: 'N-mm-MPa', numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, false, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [-1000, 0, 0] }], surfaceLoads: [] } };
}
function bucklingResult(request: SolidBucklingInput): SolidBucklingResult {
  return { kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1', scope: 'linear-elastic-prestress-bifurcation',
    units: 'N-mm-MPa', source: request.reference.source, inputSha256: '0'.repeat(64), freeDofs: 2, referenceEquilibriumResidual: 1e-13,
    maximumElementInitialStressError: 1e-12, structuralCertification: false, modes: [
      { number: 1, loadFactor: 26.3, normalizedResidual: 1e-12, shape: [[0, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0, 0]] },
      { number: 2, loadFactor: 91.9, normalizedResidual: 1e-12, shape: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]] }] };
}
function modalInput(): SolidModalInput {
  return { schema: 'pointercad-solid-tet4-modal/1', source: source(), units: 'N-mm-MPa', numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3, densityKgM3: 7850 }],
    constraints: [{ node: 0, fixed: [true, true, true] }], modeCount: 1 };
}
function modalResult(request: SolidModalInput): SolidModalResult {
  return { kind: 'oofem-solid-tet4-modal', method: 'oofem-ltrspace-isole-consistent-mass-numpy-eigh/1', source: request.source,
    inputSha256: '0'.repeat(64), units: 'N-mm-MPa-t-s', structuralCertification: false, applicability: 'supported',
    nodes: request.nodes, fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, false]],
    rigidBodyModes: 0, freeDofs: 9, totalMassT: 1.3e-6,
    modes: [{ number: 1, eigenvaluePerSecondSquared: 4e8, frequencyHz: 3183.1, normalizedResidual: 1e-12,
      massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]] }],
    maximumMassOrthogonalityError: 1e-12, maximumRigidMotionResidual: 0, maximumElementMassError: 1e-14,
    reservedNumericBytes: 100_000, independentMaximumResidual: 1e-12, independentMaximumOrthogonalityError: 1e-12 };
}
const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn(), runModal: vi.fn(), cancelModal: vi.fn(),
  runBuckling: vi.fn(), cancelBuckling: vi.fn() });
function openWithBuckling(): SolidBucklingInput {
  useAppStore.getState().toggleStrength();
  useAppStore.setState({ solidAnalysisRunner: runner() });
  useAppStore.getState().openSolidAnalysis();
  return receiveBuckling();
}
/** A completed, paired buckling reply for the current request id (session already open). */
function receiveBuckling(): SolidBucklingInput {
  const request = bucklingInput();
  const id = useAppStore.getState().startSolidBuckling();
  useAppStore.getState().receiveSolidBuckling(id, { kind: 'result', input: request, result: bucklingResult(request),
    loadedAreaMm2: 0, totalForceN: [-1000, 0, 0] });
  return request;
}
/** The typed previews behind the one mode layer. The layer type (SolidModeDrawing) declares only the drawn members, so
 * the factor, frequency and displaced nodes are read from these, and the layer must equal the matching one. */
const bucklingShown = () => {
  const state = useAppStore.getState();
  return solidBucklingPreview(state.solidBuckling, solidBucklingCurrentSource(state));
};
const modalShown = () => {
  const state = useAppStore.getState();
  return solidModalPreview(state.solidModal, solidModalCurrentSource(state));
};
const reset = () => {
  useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState(),
    solidBuckling: initialSolidBucklingState(), solidBucklingReference: null });
};
beforeEach(() => { resetTestStore(); reset(); });
afterEach(() => { reset(); resetTestStore(); });

describe('buckling mode shape in the store and the viewport layers', () => {
  it('draws the first mode of a new result at once and keeps the stress field and the modal preview off', () => {
    openWithBuckling();
    const id = useAppStore.getState().startSolidModal();
    const modal = modalInput();
    useAppStore.getState().receiveSolidModal(id, { kind: 'result', input: modal, result: modalResult(modal) });
    // The modal result arrived later, but the buckling shape is explicitly shown: the one mode layer draws it.
    const layers = solidAnalysisLayersOf(useAppStore.getState()), shown = bucklingShown();
    expect(layers.field).toBeNull();
    expect(shown !== null && shown.kind === 'preview' ? shown.loadFactor : null).toBe(26.3);
    expect(layers.mode).toEqual(shown);
    // Hiding it gives the one layer back to the modal preview (whose own display is unchanged).
    const state = useAppStore.getState().solidBuckling;
    useAppStore.getState().setSolidBucklingView(state.view, state.amplitudeText, false);
    const back = solidAnalysisLayersOf(useAppStore.getState()).mode, preview = modalShown();
    expect(bucklingShown()).toBeNull();
    expect(preview !== null && preview.kind === 'preview' ? preview.frequencyHz : null).toBe(3183.1);
    expect(back).toEqual(preview);
  });

  it('display choices never touch the document, the request, the result or the factors', () => {
    const request = openWithBuckling();
    const document = useAppStore.getState().document, before = useAppStore.getState().solidBuckling;
    useAppStore.getState().setSolidBucklingView({ modeNumber: 2, amplitudeMm: 25, phase: -1 }, '25', true);
    const after = useAppStore.getState().solidBuckling;
    expect(useAppStore.getState().document).toBe(document);
    expect([after.input, after.result, after.display, after.requestId, after.status])
      .toEqual([request, before.result, before.display, before.requestId, 'result']);
    expect(after.input).toBe(request);
    const mode = solidAnalysisLayersOf(useAppStore.getState()).mode, shown = bucklingShown();
    expect(shown !== null && shown.kind === 'preview' ? [shown.modeNumber, shown.nodePositions[1]] : null)
      .toEqual([2, [10 - 25, 0, 0]]);
    expect(mode).toEqual(shown);
  });

  it('draws nothing for another generation, after a static edit, a cancelled run or close', () => {
    openWithBuckling();
    useAppStore.setState({ completedGeneration: useAppStore.getState().completedGeneration + 1 });
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
    useAppStore.setState({ completedGeneration: useAppStore.getState().completedGeneration - 1 });
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).not.toBeNull();
    useAppStore.getState().editSolidAnalysis('young', '210 GPa');
    expect([useAppStore.getState().solidBuckling.result, useAppStore.getState().solidBuckling.showShape]).toEqual([null, false]);
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
    receiveBuckling();
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).not.toBeNull();
    useAppStore.getState().startSolidBuckling();
    useAppStore.getState().cancelSolidBuckling();
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
    receiveBuckling();
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).not.toBeNull();
    useAppStore.getState().closeSolidAnalysis();
    expect(solidAnalysisLayersOf(useAppStore.getState())).toEqual({ field: null, mode: null });
  });

  it('the actual runner subscription drops the drawn shape on a document-version step (Undo/Redo, reopen) and on dispose', () => {
    const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
    const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => Promise.reject(new Error('not meshed here')) };
    const attachment = attachSolidAnalysis(kernel, useAppStore, () => worker);
    useAppStore.getState().toggleStrength();
    useAppStore.getState().openSolidAnalysis();
    receiveBuckling();
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).not.toBeNull();
    // documentSlice advances documentVersion on every Undo/Redo step; the runner treats it as an input change.
    useAppStore.setState({ documentVersion: useAppStore.getState().documentVersion + 1 });
    expect([useAppStore.getState().solidBuckling.status, useAppStore.getState().solidBuckling.result]).toEqual(['idle', null]);
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
    receiveBuckling();
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).not.toBeNull();
    attachment.dispose();
    expect(useAppStore.getState().solidAnalysisSession).toBeNull();
    expect(solidAnalysisLayersOf(useAppStore.getState())).toEqual({ field: null, mode: null });
  });

  it('cannot show a shape without a result, and a late reply of a replaced request draws nothing', () => {
    const idle = setSolidBucklingView(initialSolidBucklingState(), { modeNumber: 1, amplitudeMm: 10, phase: 1 }, '10', true);
    expect(idle.showShape).toBe(false);
    expect(solidBucklingPreview(idle, { documentId: 'doc', revision: 1, meshKey: 'mesh-a' })).toBeNull();
    openWithBuckling();
    const stale = useAppStore.getState().solidBuckling.requestId;
    useAppStore.getState().startSolidBuckling();
    const request = bucklingInput();
    useAppStore.getState().receiveSolidBuckling(stale, { kind: 'result', input: request, result: bucklingResult(request),
      loadedAreaMm2: 0, totalForceN: [-1000, 0, 0] });
    expect(useAppStore.getState().solidBuckling.status).toBe('running');
    expect(solidAnalysisLayersOf(useAppStore.getState()).mode).toBeNull();
  });
});
