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
import { initialSolidBucklingState } from './solidBucklingState.js';

/**
 * The buckling run, save and reopen through the actual runner (attachSolidAnalysis), the actual FemClient and a fake
 * worker that answers only the meshing phase (same rig as the 152 solidModalReopen.test.ts). The buckling request is read
 * as posted: its reference must be the static problem (the panel's, or an independently saved one), never a mix.
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
const resetAnalyses = () => {
  useAppStore.setState({ solidModal: initialSolidModalState(), solidModalShared: null,
    solidBuckling: initialSolidBucklingState(), solidBucklingReference: null });
};
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetAnalyses(); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

function definitionOf(kind: 'solid-cad' | 'solid-buckling-cad' | 'solid-modal-cad') {
  const input = useAppStore.getState().document.beamAnalysisInputs?.analyses.find(value => value.kind === kind);
  if (input === undefined || input.kind !== kind) throw new Error('Missing ' + kind);
  return input;
}
/** Static problem A: restrained face 0, loaded face 1, E 210000, nu 0, traction (0, 0, 2) MPa. */
function enterStaticA(rig: ReturnType<typeof install>) {
  rig.pick(0, 'fixed'); rig.pick(1, 'loaded');
  const fields: [SolidField, string][] = [['young', '210000'], ['poisson', '0'], ['tx', '0'], ['ty', '0'], ['tz', '2'], ['volume', '0.1']];
  for (const [name, value] of fields) useAppStore.getState().editSolidAnalysis(name, value);
}
function coldReopen(rig: ReturnType<typeof install>, generation: number) {
  const reopened = parseDocument(serializeDocument(useAppStore.getState().document, { savedAt: '2026-10-19T00:00:00.000Z' }));
  if (!reopened.ok) throw new Error(reopened.error.message);
  useAppStore.getState().closeStrength();
  resetAnalyses();
  rig.load(reopened.document, generation);
}
async function solveRequestAfterMesh(rig: ReturnType<typeof install>, run: () => void, kind: Request['kind']): Promise<string> {
  const before = rig.ports.length;
  run();
  await vi.waitFor(() => postedRequest(rig.ports, before, 'mesh-cad-convex-tetra'));
  await rig.ports[before].reply();
  const request = await vi.waitFor(() => postedRequest(rig.ports, before + 1, kind));
  return JSON.stringify(request);
}
const runBuckling = () => { useAppStore.getState().solidAnalysisRunner?.runBuckling?.(); };
/** Keys that exist only in a computed buckling result (SolidBucklingResult and its modes), never in a saved input. */
const COMPUTED_ONLY_KEYS = new Set(['loadFactor', 'normalizedResidual', 'shape', 'freeDofs', 'referenceEquilibriumResidual',
  'maximumElementInitialStressError', 'structuralCertification']);
const FACE_KEY_LISTS = new Set(['fixedFaces', 'loadedFaces']);
/**
 * Every object key path of a saved structure. A saved face key is a JSON text (solidCadFaceKey) whose legitimate
 * origin carries shapeKind: 'face', so each one is opened and walked too instead of being matched as a substring.
 */
function savedKeyPaths(value: unknown, path: readonly string[] = []): readonly (readonly string[])[] {
  if (Array.isArray(value)) {
    const faceKeys = FACE_KEY_LISTS.has(path.at(-1) ?? '');
    return value.flatMap((item: unknown, index: number) =>
      savedKeyPaths(faceKeys && typeof item === 'string' ? JSON.parse(item) as unknown : item, [...path, String(index)]));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]: [string, unknown]) => [[...path, key], ...savedKeyPaths(child, [...path, key])]);
}

describe('solid buckling through the actual runner', () => {
  it('posts the static panel problem as the reference with the requested count', async () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    useAppStore.getState().editSolidBucklingCount('3');
    const request = await solveRequestAfterMesh(rig, runBuckling, 'analyze-solid-buckling-tet4');
    expect(request).toContain('"schema":"pointercad-solid-tet4-buckling/1"');
    expect(request).toContain('"modeCount":3');
    expect(request).toContain('"youngMPa":210000');
    expect(request).toContain('"tractionMPa":[0,0,2]');
    expect(request).toContain('"nodalLoads":[]');
    expect(useAppStore.getState().solidBuckling.status).toBe('running');
    useAppStore.getState().cancelSolidBuckling();
    expect(useAppStore.getState().solidBuckling.status).toBe('cancelled');
  });

  it('refuses an invalid count before meshing and never posts a request', () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    useAppStore.getState().editSolidBucklingCount('13');
    const before = rig.ports.length;
    runBuckling();
    expect(rig.ports.length).toBe(before);
    expect(useAppStore.getState().solidBuckling.status).toBe('failed');
    expect(useAppStore.getState().solidBuckling.display).toBeNull();
  });

  it('drops a running buckling request on a static edit, a face capture and close', async () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    for (const change of [() => { useAppStore.getState().editSolidAnalysis('young', '200000'); }, () => { rig.pick(2, 'fixed'); },
      () => { useAppStore.getState().closeSolidAnalysis(); }]) {
      if (useAppStore.getState().solidAnalysisSession === null) useAppStore.getState().openSolidAnalysis();
      const before = rig.ports.length;
      runBuckling();
      await vi.waitFor(() => postedRequest(rig.ports, before, 'mesh-cad-convex-tetra'));
      const id = useAppStore.getState().solidBuckling.requestId;
      change();
      expect(useAppStore.getState().solidBuckling.status).toBe('idle');
      expect(useAppStore.getState().solidBuckling.requestId).toBeGreaterThan(id);
    }
  });

  it('saves only the count and the reference static input; Undo removes it', () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    useAppStore.getState().editSolidBucklingCount('5');
    const before = useAppStore.getState().document;
    const session = useAppStore.getState().solidAnalysisSession;
    useAppStore.getState().saveSolidBuckling();
    expect(useAppStore.getState().solidBuckling.error).toBeNull();
    const saved = definitionOf('solid-buckling-cad');
    expect(saved.kind === 'solid-buckling-cad' ? [saved.definition.modeCount, saved.definition.reference.youngMPa,
      saved.definition.reference.tractionMPa] : null).toEqual([5, 210000, [0, 0, 2]]);
    // The legitimate face reference is saved: exactly the captured faces, each a persistent face origin of the box.
    const reference = saved.kind === 'solid-buckling-cad' ? saved.definition.reference : null;
    expect([reference?.fixedFaces.length, reference?.loadedFaces.length]).toEqual([1, 1]);
    expect([reference?.fixedFaces, reference?.loadedFaces]).toEqual([session?.fixedFaces, session?.loadedFaces]);
    for (const face of [...(reference?.fixedFaces ?? []), ...(reference?.loadedFaces ?? [])]) {
      const parsed: unknown = JSON.parse(face);
      expect(parsed).toMatchObject({ bodyFeatureId: 'box', origin: { shapeKind: 'face' } });
    }
    // No computed result field anywhere in the saved structure, the face keys included; shapeKind only in the face keys.
    const paths = savedKeyPaths(useAppStore.getState().document.beamAnalysisInputs);
    expect(new Set(paths.filter(path => path.at(-1) === 'shapeKind').map(path => path.find(part => FACE_KEY_LISTS.has(part)))))
      .toEqual(new Set(['fixedFaces', 'loadedFaces']));
    expect(paths.filter(path => COMPUTED_ONLY_KEYS.has(path.at(-1) ?? '')).map(path => path.join('.'))).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(before.beamAnalysisInputs);
  });

  it('does not save an invalid count and reports it', () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    useAppStore.getState().editSolidBucklingCount('0');
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidBuckling();
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().solidBuckling.error).not.toBeNull();
  });
});

describe('independently saved static and buckling inputs after a cold reopen', () => {
  /** Static A saved; then the panel is edited to E 70000 on loaded face 2 and buckling input B is saved from it. */
  function saveStaticAThenBucklingB(rig: ReturnType<typeof install>) {
    enterStaticA(rig);
    useAppStore.getState().saveSolidAnalysis();
    useAppStore.getState().editSolidAnalysis('young', '70000');
    rig.pick(2, 'loaded');
    useAppStore.getState().editSolidBucklingCount('2');
    useAppStore.getState().saveSolidBuckling();
    expect(useAppStore.getState().solidBuckling.error).toBeNull();
    const staticA = definitionOf('solid-cad'), bucklingB = definitionOf('solid-buckling-cad');
    if (staticA.kind !== 'solid-cad' || bucklingB.kind !== 'solid-buckling-cad') throw new Error('Unexpected kinds');
    expect([staticA.definition.youngMPa, bucklingB.definition.reference.youngMPa]).toEqual([210000, 70000]);
    expect(bucklingB.definition.reference.loadedFaces).not.toEqual(staticA.definition.loadedFaces);
    return { staticA: staticA.definition, bucklingB: bucklingB.definition };
  }

  it('holds the buckling reference apart and runs each analysis with its own saved problem', async () => {
    const rig = install(); live.push(rig);
    const { staticA, bucklingB } = saveStaticAThenBucklingB(rig);
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
    expect(useAppStore.getState().solidAnalysisSession?.loadedFaces).toEqual(staticA.loadedFaces);
    expect(useAppStore.getState().solidBucklingReference).toEqual(bucklingB.reference);
    expect(useAppStore.getState().solidBuckling.modeCountText).toBe('2');
    const bucklingRequest = await solveRequestAfterMesh(rig, runBuckling, 'analyze-solid-buckling-tet4');
    expect(bucklingRequest).toContain('"youngMPa":70000');
    expect(bucklingRequest).not.toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidBuckling();
    const staticRequest = await solveRequestAfterMesh(rig, () => { useAppStore.getState().solidAnalysisRunner?.run(); }, 'analyze-solid-tet4');
    expect(staticRequest).toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidAnalysis();
  });

  it('adopts the panel input for the buckling analysis only on the explicit action', async () => {
    const rig = install(); live.push(rig);
    saveStaticAThenBucklingB(rig);
    coldReopen(rig, 9);
    useAppStore.getState().adoptPanelForSolidBuckling();
    expect(useAppStore.getState().solidBucklingReference).toBeNull();
    const request = await solveRequestAfterMesh(rig, runBuckling, 'analyze-solid-buckling-tet4');
    expect(request).toContain('"youngMPa":210000');
    useAppStore.getState().cancelSolidBuckling();
  });

  it('fills the panel from a buckling input saved alone and compares a modal input with it', () => {
    const rig = install(); live.push(rig);
    enterStaticA(rig);
    useAppStore.getState().saveSolidBuckling();
    useAppStore.getState().editSolidAnalysis('young', '70000');
    useAppStore.getState().editSolidModalInput('density', '2700');
    useAppStore.getState().saveSolidModal();
    expect(useAppStore.getState().solidModal.error).toBeNull();
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
    expect(useAppStore.getState().solidAnalysisSession?.values.tz).toBe('2');
    expect(useAppStore.getState().solidBucklingReference).toBeNull();
    expect(useAppStore.getState().solidModalShared?.youngMPa).toBe(70000);
  });

  it('a cold reopen after undoing the buckling save holds no buckling input', () => {
    const rig = install(); live.push(rig);
    saveStaticAThenBucklingB(rig);
    useAppStore.getState().undo();
    coldReopen(rig, 9);
    expect(useAppStore.getState().solidBucklingReference).toBeNull();
    expect(useAppStore.getState().solidBuckling.modeCountText).toBe(initialSolidBucklingState().modeCountText);
    expect(useAppStore.getState().solidAnalysisSession?.values.young).toBe('210000');
  });
});
