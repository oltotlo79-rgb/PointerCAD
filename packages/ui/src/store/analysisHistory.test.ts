import { createHash } from 'node:crypto';
import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource, type PartDocument } from '@pointercad/model';
import { withBeamAnalysisInputs, type BeamAnalysisInput, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { serializeDocument } from '@pointercad/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BENCHMARK_EDITS, BENCHMARK_REFERENCE } from '../plasticBar/plasticBar.testSupport.js';
import { beamUiFixture } from '../beam/beam.testSupport.js';
import { attachSolidAnalysis } from '../solidAnalysis/attachSolidAnalysis.js';
import { boundaryMesh, context } from '../solidAnalysis/solidAnalysis.testSupport.js';
import { initialSolidModalState } from '../solidAnalysis/solidModalState.js';
import { initialSolidBucklingState } from '../solidAnalysis/solidBucklingState.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { extrudeFeature, resetTestStore, resultFor, tick } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

const SAVED_AT = '2026-10-25T00:00:00.000Z';
const digest = (document: PartDocument): string => createHash('sha256')
  .update(serializeDocument(document, { savedAt: SAVED_AT })).digest('hex');

// Explicit saved inputs, independent of the UI save/reader return values. Units
// are the existing saved contract: mm, N, MPa, kg/m3; no solver is run here.
function savedEntries(documentId: string): readonly BeamAnalysisInput[] {
  const common = { source: { documentId }, bodyFeatureId: 'box', fixedFaces: ['bottom'], youngMPa: 210000, poisson: 0.3,
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
  const reference: SolidCadSavedInput = { ...common, schema: 'pointercad-solid-cad-input/1', id: 'solid-cad',
    loadedFaces: ['top'], tractionMPa: [0, 0, -2] };
  return [
    { kind: 'solid-cad', definition: reference },
    { kind: 'solid-plastic-cad', definition: { ...common, schema: 'pointercad-solid-plastic-cad-input/1', id: 'solid-plastic-cad',
      loadedFaces: ['top'], tractionMPa: [0, 0, -2], yieldStressMPa: 250, hardeningModulusMPa: 2000,
      materialReference: 'Manufactured history test, no material capacity claim', loadFactor: [0, 1, 0], stepsPerSegment: 4 } },
    { kind: 'solid-modal-cad', definition: { ...common, schema: 'pointercad-solid-modal-cad-input/1', id: 'solid-modal-cad', densityKgM3: 7850, modeCount: 2 } },
    { kind: 'solid-buckling-cad', definition: { schema: 'pointercad-solid-buckling-cad-input/1', id: 'solid-buckling-cad',
      source: { documentId }, modeCount: 2, reference } },
  ];
}
function installPart(): void {
  const base = createEmptyPartDocument();
  useAppStore.getState().resetDocument(withBeamAnalysisInputs(base, { schema: 'pointercad-beam-inputs/1', analyses: savedEntries(base.id) }));
  useAppStore.getState().toggleStrength();
  // Controlled geometry-validation dependency only. History and all edit/save
  // actions below are the actual store; no native or UI result is fabricated.
  useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), validate: vi.fn(), captureFaces: vi.fn() },
    solidPlasticRunner: { run: vi.fn(), cancel: vi.fn(), validate: vi.fn(), captureFaces: vi.fn() } });
}
const solidCases = [
  { kind: 'solid-cad', open: () => useAppStore.getState().openSolidAnalysis(),
    edit: () => useAppStore.getState().editSolidAnalysis('young', '205 GPa'),
    view: () => useAppStore.getState().setSolidAnalysisFieldView({ deformationScale: 4 }),
    save: () => useAppStore.getState().saveSolidAnalysis(), cancel: () => useAppStore.getState().cancelSolidAnalysis(),
    patch: { youngMPa: 205000 } },
  { kind: 'solid-plastic-cad', open: () => useAppStore.getState().openSolidPlastic(),
    edit: () => useAppStore.getState().editSolidPlastic('hardening', '3000'),
    view: () => useAppStore.getState().focusSolidPlastic('hardening'),
    save: () => useAppStore.getState().saveSolidPlastic(), cancel: () => useAppStore.getState().cancelSolidPlastic(),
    patch: { hardeningModulusMPa: 3000 } },
  { kind: 'solid-modal-cad', open: () => useAppStore.getState().openSolidAnalysis(),
    edit: () => useAppStore.getState().editSolidModalInput('modeCount', '4'),
    view: () => useAppStore.getState().setSolidModalView({ modeNumber: 1, amplitudeMm: 3, phase: -1 }, '3'),
    save: () => useAppStore.getState().saveSolidModal(), cancel: () => useAppStore.getState().cancelSolidModal(),
    patch: { modeCount: 4 } },
  { kind: 'solid-buckling-cad', open: () => useAppStore.getState().openSolidAnalysis(),
    edit: () => useAppStore.getState().editSolidBucklingCount('3'),
    view: () => useAppStore.getState().setSolidBucklingView({ modeNumber: 1, amplitudeMm: 2, phase: 1 }, '2', false),
    save: () => useAppStore.getState().saveSolidBuckling(), cancel: () => useAppStore.getState().cancelSolidBuckling(),
    patch: { modeCount: 3 } },
] as const;

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ solidAnalysisSession: null, solidPlasticSession: null, solidAnalysisRunner: null, solidPlasticRunner: null,
    solidModal: initialSolidModalState(), solidBuckling: initialSolidBucklingState() });
});
afterEach(() => { useAppStore.getState().closeSolidAnalysis(); useAppStore.getState().closeSolidPlastic(); resetTestStore(); });

describe('real analysis input history, independent saved values and complete document identity', () => {
  it.each(solidCases)('$kind: draft/display/cancel are zero history; commit is one and Undo/Redo restore every input and ID', row => {
    installPart();
    const before = useAppStore.getState(), hash = digest(before.document);
    row.open(); row.edit(); row.view(); row.cancel();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(digest(useAppStore.getState().document)).toBe(hash);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    // Cancel does not commit. A later explicit Save is a separate operation.
    row.save();
    const after = useAppStore.getState();
    const previous = before.document.beamAnalysisInputs?.analyses.find(input => input.kind === row.kind);
    if (previous === undefined || previous.kind === 'manual') throw new Error('Explicit saved fixture missing');
    const expectedEntries = [...(before.document.beamAnalysisInputs?.analyses.filter(input => input.kind !== row.kind) ?? []),
      { kind: row.kind, definition: { ...previous.definition, ...row.patch } }];
    expect(after.document).toEqual({ ...before.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: expectedEntries } });
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(after.undoStack.present).toBe(after.document);
    expect(digest(after.document)).not.toBe(hash);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(digest(useAppStore.getState().document)).toBe(hash);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(after.document);
    expect(useAppStore.getState().document).toEqual({ ...before.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: expectedEntries } });
  });

  it.each(solidCases)('$kind: an old open-session owner cannot write into a newly opened document', row => {
    installPart(); row.open(); row.edit();
    const foreign = createEmptyPartDocument();
    useAppStore.getState().resetDocument(foreign);
    const before = useAppStore.getState();
    row.save();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it.each(['part', 'assembly'] as const)('plastic-bar %s: real edit/save, one history, entire-document Undo/Redo and other inputs unchanged', owner => {
    installPart();
    if (owner === 'assembly') {
      const f = beamUiFixture();
      useAppStore.getState().openAssembly(f.state.assembly ?? f.owner.document, f.state.assemblyLibrary);
      useAppStore.getState().toggleStrength();
    }
    const before = useAppStore.getState(), document = before.assembly ?? before.document;
    useAppStore.getState().openPlasticBar();
    for (const edit of BENCHMARK_EDITS) useAppStore.getState().editPlasticBar(edit);
    useAppStore.getState().cancelPlasticBar();
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    useAppStore.getState().savePlasticBar();
    const after = useAppStore.getState(), saved = after.assembly ?? after.document;
    expect(saved.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'plastic-bar')).toEqual(document.beamAnalysisInputs?.analyses ?? []);
    expect(saved.beamAnalysisInputs?.analyses.find(input => input.kind === 'plastic-bar')).toEqual({ kind: 'plastic-bar', definition: {
      schema: 'pointercad-plastic-bar-input/1', id: 'plastic-bar', source: { documentId: document.id }, units: 'N-mm', youngModulusMPa: 200000,
      poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      materialSource: { kind: 'user-supplied', reference: BENCHMARK_REFERENCE }, lengthMm: 1000, areaMm2: 100,
      endDisplacementMm: [0, 2.5, 0, -2.5, 0], stepsPerSegment: 1,
    } });
    expect(owner === 'part' ? after.undoStack.past.length : after.assemblyUndoStack?.past.length)
      .toBe((owner === 'part' ? before.undoStack.past.length : before.assemblyUndoStack?.past.length ?? 0) + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly ?? useAppStore.getState().document).toEqual(document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly ?? useAppStore.getState().document).toEqual(saved);
  });

  it('plastic-bar refuses an old session after a real document reopen', () => {
    installPart(); useAppStore.getState().openPlasticBar();
    for (const edit of BENCHMARK_EDITS) useAppStore.getState().editPlasticBar(edit);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    const before = useAppStore.getState();
    useAppStore.getState().savePlasticBar();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('invalid inputs never clear a real redo branch or add a history entry', () => {
    installPart();
    const initial = useAppStore.getState();
    initial.applyDocument({ ...initial.document, name: 'First actual edit' });
    const first = useAppStore.getState(); first.applyDocument({ ...first.document, name: 'Second actual edit' });
    useAppStore.getState().undo();
    const before = useAppStore.getState();
    expect(before.undoStack.future).toHaveLength(1);
    useAppStore.getState().openSolidAnalysis(); useAppStore.getState().editSolidAnalysis('young', 'NaN');
    useAppStore.getState().saveSolidAnalysis();
    useAppStore.getState().editSolidModalInput('modeCount', '0'); useAppStore.getState().saveSolidModal();
    useAppStore.getState().editSolidBucklingCount('0'); useAppStore.getState().saveSolidBuckling();
    useAppStore.getState().openSolidPlastic(); useAppStore.getState().editSolidPlastic('reference', '');
    useAppStore.getState().saveSolidPlastic();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('real solid runner cancels on Undo/Redo and cannot resume an old awaited boundary mesh', async () => {
    const initial = appendSolid(createEmptyPartDocument(), extrudeFeature('box'));
    useAppStore.getState().resetDocument(initial);
    useAppStore.getState().applyDocument({ ...initial, name: 'Actual history checkpoint' });
    const document = useAppStore.getState().document;
    useAppStore.getState().recordRecomputeRequest(7);
    useAppStore.getState().applyRecompute(document, { ...resultFor(document), generation: 7, bodies: [context().body] });
    useAppStore.getState().recordRecomputeCompletion(7, 'success');
    const gate: { release: () => void } = { release: () => { throw new Error('Boundary not started'); } };
    const boundary = new Promise<void>(resolve => { gate.release = resolve; });
    const ports = vi.fn(() => { throw new Error('Cancelled boundary must not create a Worker'); });
    const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => boundary.then(() =>
      ({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() })) };
    const attachment = attachSolidAnalysis(kernel, useAppStore, ports);
    try {
      attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: 'box', key: 'box:7' }] });
      useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
      useAppStore.getState().setSelection([subShapeElementId('box', 'face', 0)], { kind: 'pick' });
      useAppStore.getState().solidAnalysisRunner?.captureFaces('fixed');
      for (const [name, value] of [['young', '210000'], ['poisson', '0'], ['volume', '0.1']] as const)
        useAppStore.getState().editSolidAnalysis(name, value);
      useAppStore.getState().editSolidModalInput('density', '7850');
      useAppStore.getState().solidAnalysisRunner?.runModal?.();
      expect(useAppStore.getState().solidModal.status).toBe('running');
      const id = useAppStore.getState().solidModal.requestId;
      useAppStore.getState().undo(); useAppStore.getState().redo();
      const after = useAppStore.getState();
      expect(after.solidModal.requestId).toBeGreaterThan(id);
      expect(after.solidModal.display).toBeNull();
      gate.release(); await tick(); await tick();
      expect(ports).not.toHaveBeenCalled();
      expect(useAppStore.getState().solidModal.display).toBeNull();
      expect(useAppStore.getState().solidModal.status).not.toBe('running');
      expect(useAppStore.getState().document).toBe(after.document);
      expect(useAppStore.getState().undoStack).toBe(after.undoStack);
    } finally { gate.release(); attachment.dispose(); }
  });
});
