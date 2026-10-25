import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource } from '@pointercad/model';
import { decodeTetraMesh, tetraMeshInputSha256, type FemWorkerPort } from '@pointercad/fem';
import { parseDocument, serializeDocument } from '@pointercad/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { attachSolidAnalysis } from './attachSolidAnalysis.js';
import { boundaryMesh, context } from './solidAnalysis.testSupport.js';
import type { SolidField } from './solidAnalysisSession.js';
import { initialSolidModalState } from './solidModalState.js';

// Same rig as attachSolidAnalysis.test.ts: the actual attachment, FemClient and Worker protocol with analytic replies.
type Request = Parameters<FemWorkerPort['postMessage']>[0];
function port() {
  let request: Request | null = null;
  const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: value => { request = value; }, terminate: vi.fn() };
  return { worker, request: () => request, reply: async () => {
    if (!request) throw new Error('No request');
    const message = request;
    if (message.kind !== 'mesh-cad-convex-tetra') throw new Error('Only the meshing phase is answered here');
    const input = message.input;
    const result = decodeTetraMesh({ coordinates: [...input.coordinates, 1, 1.5, 2],
      tetrahedra: input.triangles.flatMap((_, i, all) => i % 3 === 0 ? [8, all[i], all[i + 1], all[i + 2]] : []),
      boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
    worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: message.protocol, kind: 'result', identity: message.identity, result } }));
  } };
}
function install() {
  const body = context().body, document = appendSolid(createEmptyPartDocument(), extrudeFeature('box'));
  useAppStore.getState().resetDocument(document);
  useAppStore.getState().recordRecomputeRequest(7);
  useAppStore.getState().applyRecompute(document, { ...resultFor(document), generation: 7, bodies: [body] });
  useAppStore.getState().recordRecomputeCompletion(7, 'success');
  const ports: ReturnType<typeof port>[] = [];
  const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request =>
    Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() }) };
  const attachment = attachSolidAnalysis(kernel, useAppStore, () => { const value = port(); ports.push(value); return value.worker; });
  attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: 'box', key: 'box:7' }] });
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
  const pick = (index: number, role: 'fixed' | 'loaded') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidAnalysisRunner?.captureFaces(role);
  };
  pick(0, 'fixed'); pick(1, 'loaded');
  const fields: [SolidField, string][] = [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']];
  for (const [name, value] of fields) useAppStore.getState().editSolidAnalysis(name, value);
  useAppStore.getState().editSolidModalInput('density', '7850');
  return { attachment, ports, document, pick };
}
const live: ReturnType<typeof install>[] = [];
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null, solidModal: initialSolidModalState() }); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

describe('modal run in the actual solid analysis attachment', () => {
  it('starts the static meshing path for the modal request through the same client', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidAnalysisRunner?.runModal?.();
    expect(useAppStore.getState().solidModal.status).toBe('running');
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    expect(rig.attachment.statistics().live).toBe(1);
  });

  it.each(['static edit', 'load mode', 'face capture', 'modal input', 'modal cancel', 'close', 'document'] as const)(
    'a %s while the modal run is meshing terminates the owned worker and drops the late reply', async change => {
      const rig = install(); live.push(rig);
      useAppStore.getState().solidAnalysisRunner?.runModal?.();
      await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
      const id = useAppStore.getState().solidModal.requestId;
      if (change === 'static edit') useAppStore.getState().editSolidAnalysis('young', '205000');
      else if (change === 'load mode') useAppStore.getState().setSolidAnalysisLoadMode('pressure');
      else if (change === 'face capture') rig.pick(2, 'fixed');
      else if (change === 'modal input') useAppStore.getState().editSolidModalInput('modeCount', '3');
      else if (change === 'modal cancel') useAppStore.getState().cancelSolidModal();
      else if (change === 'close') useAppStore.getState().closeStrength();
      else useAppStore.getState().resetDocument(createEmptyPartDocument());
      // The owned work itself is cancelled, not only ignored.
      expect(rig.attachment.statistics().live).toBe(0);
      expect(useAppStore.getState().solidModal.requestId).toBeGreaterThan(id);
      await rig.ports[0].reply();
      await Promise.resolve();
      expect(useAppStore.getState().solidModal.display).toBeNull();
      expect(useAppStore.getState().solidModal.status === 'running').toBe(false);
      expect(rig.ports).toHaveLength(1);
    });

  it('a modal run leaves the static inputs untouched and its cancel releases the worker', async () => {
    const rig = install(); live.push(rig);
    const before = useAppStore.getState().solidAnalysisSession;
    useAppStore.getState().solidAnalysisRunner?.runModal?.();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    expect(useAppStore.getState().solidAnalysisSession?.values).toEqual(before?.values);
    expect(useAppStore.getState().solidAnalysisSession?.fixedFaces).toEqual(before?.fixedFaces);
    useAppStore.getState().cancelSolidModal();
    expect(rig.attachment.statistics().live).toBe(0);
  });

  it('saves only the physical modal input beside the static input, through Undo/Redo, the real codec and a cold reopen', () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().editSolidModalInput('modeCount', '4');
    useAppStore.getState().setSolidModalView({ modeNumber: 2, amplitudeMm: 25, phase: -1 }, '25');
    useAppStore.getState().saveSolidAnalysis();
    const staticOnly = useAppStore.getState().document;
    useAppStore.getState().saveSolidModal();
    expect(useAppStore.getState().solidModal.error).toBeNull();
    const both = useAppStore.getState().document;
    const kinds = both.beamAnalysisInputs?.analyses.map(input => input.kind);
    expect(kinds).toEqual(['solid-cad', 'solid-modal-cad']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(staticOnly.beamAnalysisInputs);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(both.beamAnalysisInputs);
    // Saving the static input again keeps the modal one.
    useAppStore.getState().editSolidAnalysis('tz', '3');
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses.find(input => input.kind === 'solid-modal-cad'))
      .toEqual(both.beamAnalysisInputs?.analyses.find(input => input.kind === 'solid-modal-cad'));
    const text = serializeDocument(useAppStore.getState().document, { savedAt: '2026-10-19T00:00:00.000Z' });
    expect(text).not.toMatch(/amplitude|phase|modeNumber|frequencyHz/u);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    useAppStore.getState().closeStrength();
    useAppStore.setState({ solidModal: initialSolidModalState() });
    useAppStore.getState().resetDocument(reopened.document);
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
    expect([useAppStore.getState().solidModal.densityText, useAppStore.getState().solidModal.modeCountText]).toEqual(['7850', '4']);
    // Display choices were never persisted: the cold view is the default one.
    expect(useAppStore.getState().solidModal.view).toEqual(initialSolidModalState().view);
    expect(useAppStore.getState().solidAnalysisSession?.fixedFaces).toHaveLength(1);
  });
});
