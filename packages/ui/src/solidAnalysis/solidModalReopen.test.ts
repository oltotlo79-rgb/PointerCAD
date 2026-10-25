import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource, type PartDocument } from '@pointercad/model';
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

/**
 * Behavioral regression for Root review finding v103-root-modal-reopen-review-r1.md: static input A and an
 * independently saved modal input B must each come back as their own problem after a cold reopen. Under the
 * continuation-r1 behavior the modal request after reopen carried A's Young's modulus and restrained face, so the
 * modal-request assertions below fail there (finding, not executed evidence: Root runs this file).
 * Successor of extrude r147 continuation-r3 ec81080a for review r2: a solve request is read only once its worker
 * exists AND has posted a request of the expected kind (see postedRequest and its own regression at the end).
 */
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
/** Readiness: throws until worker `index` exists and has posted a request of exactly `kind`. An absent worker, a
 * worker that has not posted yet, or another kind can never satisfy it (an optional chain on a missing worker is
 * undefined, which the r3 `not.toBeNull()` accepted). */
function postedRequest(ports: readonly { request: () => Request | null }[], index: number, kind: Request['kind']): Request {
  const entry = ports.at(index);
  if (entry === undefined) throw new Error(`worker ${String(index)} does not exist yet`);
  const request = entry.request();
  if (request === null) throw new Error(`worker ${String(index)} has not posted a request`);
  if (request.kind !== kind) throw new Error(`worker ${String(index)} posted ${request.kind}, expected ${kind}`);
  return request;
}
function install() {
  const document = appendSolid(createEmptyPartDocument(), extrudeFeature('box'));
  const ports: ReturnType<typeof port>[] = [];
  const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request =>
    Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() }) };
  const attachment = attachSolidAnalysis(kernel, useAppStore, () => { const value = port(); ports.push(value); return value.worker; });
  const load = (value: PartDocument, generation: number) => {
    useAppStore.getState().resetDocument(value);
    useAppStore.getState().recordRecomputeRequest(generation);
    useAppStore.getState().applyRecompute(value, { ...resultFor(value), generation, bodies: [context().body] });
    useAppStore.getState().recordRecomputeCompletion(generation, 'success');
    attachment.captureResolved(useAppStore.getState().document, generation, { errors: [], steps: [{ featureId: 'box', key: `box:${String(generation)}` }] });
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
  };
  load(document, 7);
  const pick = (index: number, role: 'fixed' | 'loaded') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidAnalysisRunner?.captureFaces(role);
  };
  return { attachment, ports, pick, load };
}
const live: ReturnType<typeof install>[] = [];
const resetModal = () => { useAppStore.setState({ solidModal: initialSolidModalState(), solidModalShared: null }); };
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetModal(); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

function saved(kind: 'solid-cad' | 'solid-modal-cad') {
  const input = useAppStore.getState().document.beamAnalysisInputs?.analyses.find(value => value.kind === kind);
  if (input === undefined || (input.kind !== 'solid-cad' && input.kind !== 'solid-modal-cad')) throw new Error('Missing ' + kind);
  return input.definition;
}
/** Static input A (E 210000, face 0) and, after editing the shared fields, modal input B (E 70000, face 3). */
function saveStaticAThenModalB(rig: ReturnType<typeof install>) {
  rig.pick(0, 'fixed'); rig.pick(1, 'loaded');
  const fields: [SolidField, string][] = [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']];
  for (const [name, value] of fields) useAppStore.getState().editSolidAnalysis(name, value);
  useAppStore.getState().saveSolidAnalysis();
  useAppStore.getState().editSolidAnalysis('young', '70000');
  useAppStore.getState().editSolidAnalysis('poisson', '0.25');
  rig.pick(3, 'fixed');
  useAppStore.getState().editSolidModalInput('density', '2700');
  useAppStore.getState().editSolidModalInput('modeCount', '3');
  useAppStore.getState().saveSolidModal();
  expect(useAppStore.getState().solidModal.error).toBeNull();
  const staticA = saved('solid-cad'), modalB = saved('solid-modal-cad');
  expect([staticA.youngMPa, modalB.youngMPa, modalB.poisson]).toEqual([210000, 70000, 0.25]);
  expect(modalB.fixedFaces).not.toEqual(staticA.fixedFaces);
  return { staticA, modalB };
}
function coldReopen(rig: ReturnType<typeof install>, generation: number) {
  const reopened = parseDocument(serializeDocument(useAppStore.getState().document, { savedAt: '2026-10-19T00:00:00.000Z' }));
  if (!reopened.ok) throw new Error(reopened.error.message);
  useAppStore.getState().closeStrength();
  resetModal();
  rig.load(reopened.document, generation);
}
/** The solve request posted after the meshing reply, read only when that worker exists with exactly `kind`. */
async function solveRequestAfterMesh(rig: ReturnType<typeof install>, run: () => void, kind: Request['kind']): Promise<string> {
  const before = rig.ports.length;
  run();
  await vi.waitFor(() => postedRequest(rig.ports, before, 'mesh-cad-convex-tetra'));
  await rig.ports[before].reply();
  const request = await vi.waitFor(() => postedRequest(rig.ports, before + 1, kind));
  return JSON.stringify(request);
}

describe('independently saved static and modal inputs after a cold reopen (review r1)', () => {
  it('reopens static A for the static run and modal B for the modal run, each from its own saved definition', async () => {
    const rig = install(); live.push(rig);
    const { staticA, modalB } = saveStaticAThenModalB(rig);
    coldReopen(rig, 9);
    const session = useAppStore.getState().solidAnalysisSession;
    expect([session?.values.young, session?.fixedFaces]).toEqual(['210000', staticA.fixedFaces]);
    expect(useAppStore.getState().solidModalShared).toEqual({ bodyFeatureId: modalB.bodyFeatureId, fixedFaces: modalB.fixedFaces,
      youngMPa: 70000, poisson: 0.25, linearDeflectionMm: modalB.linearDeflectionMm, angularDeflectionRad: modalB.angularDeflectionRad,
      maximumChordDeviationMm: modalB.maximumChordDeviationMm, maximumVolumeDeviationMm3: modalB.maximumVolumeDeviationMm3 });
    expect([useAppStore.getState().solidModal.densityText, useAppStore.getState().solidModal.modeCountText]).toEqual(['2700', '3']);
    const staticRequest = await solveRequestAfterMesh(rig, () => { useAppStore.getState().solidAnalysisRunner?.run(); }, 'analyze-solid-tet4');
    expect(staticRequest).toContain('"youngMPa":210000');
    expect(staticRequest).not.toContain('"youngMPa":70000');
    useAppStore.getState().cancelSolidAnalysis();
    const modalRequest = await solveRequestAfterMesh(rig, () => { useAppStore.getState().solidAnalysisRunner?.runModal?.(); },
      'analyze-solid-modal-tet4');
    expect(modalRequest).toContain('"youngMPa":70000');
    expect(modalRequest).toContain('"poisson":0.25');
    // Density may be converted to t/mm^3 by 151's client before posting; E and nu are posted as given in both forms.
    expect(modalRequest).not.toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidModal();
  });

  it('never overwrites the other saved problem and keeps display choices out of both', () => {
    const rig = install(); live.push(rig);
    const { staticA, modalB } = saveStaticAThenModalB(rig);
    coldReopen(rig, 9);
    useAppStore.getState().setSolidModalView({ modeNumber: 2, amplitudeMm: 40, phase: -1 }, '40');
    expect(useAppStore.getState().solidModalShared?.youngMPa).toBe(70000);
    useAppStore.getState().editSolidAnalysis('tz', '5');
    useAppStore.getState().saveSolidAnalysis();
    expect(saved('solid-modal-cad')).toEqual(modalB);
    expect(saved('solid-cad').youngMPa).toBe(staticA.youngMPa);
    useAppStore.getState().editSolidModalInput('modeCount', '4');
    useAppStore.getState().saveSolidModal();
    expect(saved('solid-modal-cad')).toEqual({ ...modalB, modeCount: 4 });
    expect(saved('solid-cad').youngMPa).toBe(staticA.youngMPa);
    expect(JSON.stringify(useAppStore.getState().document.beamAnalysisInputs)).not.toMatch(/amplitude|phase|modeNumber/u);
  });

  it('adopts the panel values for the modal analysis only on the explicit action', async () => {
    const rig = install(); live.push(rig);
    saveStaticAThenModalB(rig);
    coldReopen(rig, 9);
    useAppStore.getState().adoptPanelForSolidModal();
    expect(useAppStore.getState().solidModalShared).toBeNull();
    const modalRequest = await solveRequestAfterMesh(rig, () => { useAppStore.getState().solidAnalysisRunner?.runModal?.(); },
      'analyze-solid-modal-tet4');
    expect(modalRequest).toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidModal();
  });

  it('follows Undo/Redo of the modal save into the cold reopen', () => {
    const rig = install(); live.push(rig);
    const { staticA, modalB } = saveStaticAThenModalB(rig);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-cad', definition: staticA }]);
    useAppStore.getState().redo();
    expect(saved('solid-modal-cad')).toEqual(modalB);
    expect(saved('solid-cad')).toEqual(staticA);
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidModalShared?.youngMPa).toBe(70000);
    expect(useAppStore.getState().solidModalShared?.fixedFaces).toEqual(modalB.fixedFaces);
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
  });

  it('a cold reopen after undoing the modal save holds no independent modal values', () => {
    const rig = install(); live.push(rig);
    saveStaticAThenModalB(rig);
    useAppStore.getState().undo();
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidModalShared).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
  });

  it('keeps one problem when the modal input was saved alone or agrees with the static input', () => {
    const rig = install(); live.push(rig);
    rig.pick(0, 'fixed'); rig.pick(1, 'loaded');
    for (const [name, value] of [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']] as [SolidField, string][]) {
      useAppStore.getState().editSolidAnalysis(name, value);
    }
    useAppStore.getState().editSolidModalInput('density', '7850');
    useAppStore.getState().saveSolidModal();
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidModalShared).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
    useAppStore.getState().saveSolidAnalysis();
    coldReopen(rig, 10);
    expect(useAppStore.getState().solidModalShared).toBeNull();
  });
});

describe('solve-request readiness cannot pass before the worker exists (review r2)', () => {
  it('refuses a missing worker, a worker without a request and another request kind', async () => {
    const idle = port();
    expect(() => postedRequest([], 0, 'analyze-solid-tet4')).toThrow('worker 0 does not exist yet');
    expect(() => postedRequest([idle], 0, 'analyze-solid-tet4')).toThrow('worker 0 has not posted a request');
    const rig = install(); live.push(rig);
    rig.pick(0, 'fixed'); rig.pick(1, 'loaded');
    for (const [name, value] of [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']] as [SolidField, string][]) {
      useAppStore.getState().editSolidAnalysis(name, value);
    }
    const before = rig.ports.length;
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => postedRequest(rig.ports, before, 'mesh-cad-convex-tetra'));
    // The deferred solve worker does not exist until the meshing reply: the r3 predicate's operand is undefined here,
    // which `not.toBeNull()` accepted; the successor predicate refuses it and refuses the meshing kind as the solve kind.
    expect(rig.ports[before + 1]?.request()).toBeUndefined();
    expect(() => postedRequest(rig.ports, before + 1, 'analyze-solid-tet4')).toThrow('does not exist yet');
    expect(() => postedRequest(rig.ports, before, 'analyze-solid-tet4')).toThrow('posted mesh-cad-convex-tetra, expected analyze-solid-tet4');
    await rig.ports[before].reply();
    expect(JSON.stringify(await vi.waitFor(() => postedRequest(rig.ports, before + 1, 'analyze-solid-tet4')))).toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidAnalysis();
  });
});
