import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource } from '@pointercad/model';
import { decodeTetraMesh, tetraMeshInputSha256, decodeSolidAnalysis, solidInputSha256,
  type FemWorkerPort, type SolidVector3 } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { t } from '../i18n/t.js';
import { attachSolidAnalysis } from './attachSolidAnalysis.js';
import { boundaryMesh, context } from './solidAnalysis.testSupport.js';
import { solidSavedInput, type SolidField } from './solidAnalysisSession.js';
import { SOLID_BOUNDARY_AXES, type SolidBoundaryAxis } from './solidBoundaryDraft.js';

type Request = Parameters<FemWorkerPort['postMessage']>[0];
function port() {
  let request: Request | null = null;
  const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: value => { request = value; }, terminate: vi.fn() };
  return { worker, request: () => request, reply: async () => {
    if (!request) throw new Error('No request');
    const message = request;
    if (message.kind === 'mesh-cad-convex-tetra') {
      const input = message.input;
      const result = decodeTetraMesh({ coordinates: [...input.coordinates, 1, 1.5, 2],
        tetrahedra: input.triangles.flatMap((_, i, all) => i % 3 === 0 ? [8, all[i], all[i + 1], all[i + 2]] : []),
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: message.protocol, kind: 'result', identity: message.identity, result } }));
    } else if (message.kind === 'analyze-solid-tet4') {
      const input = message.input, stress = 2, young = input.materials[0].youngMPa;
      const sub = (a: SolidVector3, b: SolidVector3): SolidVector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const cross = (a: SolidVector3, b: SolidVector3): SolidVector3 =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      // Independent uniform zz stress: force at node i = sigma_zz * oriented opposite-face area_z / 3.
      const elementForcesN = input.elements.map(element => {
        const [a, b, c, d] = element.nodes.map(index => input.nodes[index]);
        const gradientsTimesDet = [cross(sub(c, b), sub(d, b)).map(value => -value),
          cross(sub(c, a), sub(d, a)), cross(sub(d, a), sub(b, a)), cross(sub(b, a), sub(c, a))];
        return gradientsTimesDet.flatMap(vector => [0, 0, stress * vector[2] / 6]);
      });
      const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
        displacementMm: input.nodes.map(node => [0, 0, stress * node[2] / young]), elementForcesN,
        reservedNumericBytes: 1000000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: message.protocol, kind: 'result', identity: message.identity, result } }));
    } else throw new Error('Unexpected beam route');
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
  const pick = (index: number, role: 'fixed' | 'loaded' | 'support') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidAnalysisRunner?.captureFaces(role);
  };
  pick(0, 'fixed'); pick(1, 'loaded');
  const fields: [SolidField, string][] = [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']];
  for (const [name, value] of fields) useAppStore.getState().editSolidAnalysis(name, value);
  return { attachment, ports, document, pick };
}
const live: ReturnType<typeof install>[] = [];
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

describe('transient stage failures', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('clears a failed mesh stage without creating a structural worker', async () => {
    vi.stubGlobal('ErrorEvent', undefined);
    const rig = install(); live.push(rig); useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('meshing');
    const error: ErrorEvent = Object.assign(new Event('error'), {
      message: 'mesh worker refused', filename: '', lineno: 0, colno: 0, error: new Error('mesh worker refused'),
    });
    rig.ports[0].worker.onerror?.(error);
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('failed'));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBeNull();
    expect(rig.ports).toHaveLength(1); expect(rig.attachment.statistics().live).toBe(0);
  });
});

function enterBoundary(rig: ReturnType<typeof install>, kind: 'supports' | 'gravity' | 'both'): void {
  const state = useAppStore.getState();
  if (kind !== 'gravity') {
    const fixed = state.solidAnalysisSession?.fixedFaces[0];
    if (!fixed) throw new Error('Missing initial clamp');
    state.removeSolidFixedFace(fixed);
    const faces: readonly (readonly [number, SolidBoundaryAxis, string])[] = [[5, 'x', '0.125'], [2, 'y', '-0.25'], [0, 'z', '0.5']];
    for (const [index, axis, value] of faces) {
      rig.pick(index, 'support');
      const row = useAppStore.getState().solidAnalysisSession?.supports?.at(-1);
      if (!row) throw new Error('Missing captured support');
      for (const other of SOLID_BOUNDARY_AXES) if (other !== axis) state.editSolidSupport(row.face, other, { fixed: false });
      state.editSolidSupport(row.face, axis, { displacement: value });
    }
  }
  if (kind !== 'supports') {
    state.setSolidGravityEnabled(true);
    state.editSolidGravity('x', '1.25'); state.editSolidGravity('y', '-9.81'); state.editSolidGravity('z', '2.5');
    state.editSolidGravity('density', '7800'); state.clearSolidLoadedFaces();
  }
}
function currentDefinition() {
  const state = useAppStore.getState(), session = state.solidAnalysisSession;
  if (!session) throw new Error('Missing boundary session');
  return solidSavedInput(session, state.document.id, state.document.parameters);
}
describe('authored boundary definitions through the real attachment (input transport, not native solve evidence)', () => {
  it.each(['supports', 'gravity', 'both'] as const)('keeps %s through save, reopen, Undo/Redo and the public solver request', async kind => {
    const rig = install(); live.push(rig); enterBoundary(rig, kind);
    const state = useAppStore.getState();
    state.saveSolidAnalysis();
    const first = currentDefinition();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses.find(row => row.kind === 'solid-cad'))
      .toEqual({ kind: 'solid-cad', definition: first });
    state.closeSolidAnalysis(); state.openSolidAnalysis(); expect(currentDefinition()).toEqual(first);
    if (kind === 'gravity') state.editSolidGravity('density', '7900');
    else {
      const face = useAppStore.getState().solidAnalysisSession?.supports?.[0].face;
      if (!face) throw new Error('Missing support');
      state.editSolidSupport(face, 'x', { displacement: '0.25' });
    }
    state.saveSolidAnalysis(); const second = currentDefinition(); expect(second).not.toEqual(first);
    state.undo(); expect(currentDefinition()).toEqual(first);
    state.redo(); expect(currentDefinition()).toEqual(second);
    state.solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    const request = rig.ports[1].request();
    if (request?.kind !== 'analyze-solid-tet4') throw new Error('Missing solid solver request');
    expect(request.input.source.documentId).toBe(state.document.id);
    expect(request.input.units).toBe('N-mm-MPa');
    if (kind !== 'gravity') expect(request.input.constraints.find(row => row.node === 0))
      .toEqual({ node: 0, fixed: [true, true, true], prescribedMm: [0.25, -0.25, 0.5] });
    else expect(request.input.constraints.every(row => row.prescribedMm === undefined)).toBe(true);
    if (kind !== 'supports') {
      expect(request.input.gravity).toEqual({ accelerationMps2: [1.25, -9.81, 2.5],
        densities: [{ materialId: 'material', densityKgM3: kind === 'gravity' ? 7900 : 7800 }] });
      expect(request.input.surfaceLoads).toEqual([]);
    } else {
      expect(request.input.gravity).toBeUndefined();
      expect(request.input.surfaceLoads.map(row => row.tractionMPa)).toEqual([[0, 0, 2], [0, 0, 2]]);
    }
    // No invented native answer: the new physical conditions are inspected at the real public request boundary.
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('running');
    state.cancelSolidAnalysis(); expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
  });
  it.each(['support', 'gravity'] as const)('rejects a late mesh after a %s edit', async kind => {
    const rig = install(); live.push(rig); enterBoundary(rig, 'both');
    const state = useAppStore.getState(); state.solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    if (kind === 'gravity') state.editSolidGravity('density', '7900');
    else {
      const face = state.solidAnalysisSession?.supports?.[0].face;
      if (!face) throw new Error('Missing support');
      state.editSolidSupport(face, 'x', { displacement: '0.75' });
    }
    await rig.ports[0].reply(); await Promise.resolve();
    expect(rig.ports).toHaveLength(1);
    expect(useAppStore.getState().solidAnalysisSession).toMatchObject({ status: 'editing', result: null });
    expect(rig.attachment.statistics().live).toBe(0);
  });
  it.each(['conflict', 'rigid'] as const)('shows the %s refusal from the actual W12 translation without posting a solve', async kind => {
    const rig = install(); live.push(rig); enterBoundary(rig, 'supports');
    const state = useAppStore.getState(), rows = state.solidAnalysisSession?.supports;
    if (!rows || rows.length !== 3) throw new Error('Missing support fixture');
    if (kind === 'conflict') state.editSolidSupport(rows[1].face, 'x', { fixed: true });
    else for (const row of rows) {
      state.editSolidSupport(row.face, 'x', { fixed: true }); state.editSolidSupport(row.face, 'x', { displacement: '0' });
      state.editSolidSupport(row.face, 'y', { fixed: false }); state.editSolidSupport(row.face, 'z', { fixed: false });
    }
    state.solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('failed'));
    expect(useAppStore.getState().solidAnalysisSession?.error)
      .toBe(t(kind === 'conflict' ? 'solidAnalysis.supportConflict' : 'solidAnalysis.supportRigid'));
    expect(rig.ports).toHaveLength(1); expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
  });
  it('refuses duplicate or unresolved support faces before a worker can run', () => {
    const rig = install(); live.push(rig); rig.pick(0, 'support');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBe(t('solidAnalysis.supportDuplicate'));
    enterBoundary(rig, 'supports');
    const state = useAppStore.getState(), session = state.solidAnalysisSession;
    if (!session?.supports) throw new Error('Missing supports');
    useAppStore.setState({ solidAnalysisSession: { ...session,
      supports: session.supports.map((row, index) => index === 0 ? { ...row, face: 'unresolved-native-origin' } : row) } });
    expect(() => state.solidAnalysisRunner?.validate()).toThrow(t('solidAnalysis.changed'));
    expect(rig.ports).toHaveLength(0);
  });
});
describe('actual UI attachment and public client, analytic Worker replies (not native execution)', () => {
  it('connects current CAD faces through both public requests to accepted stress, force and reaction', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidAnalysisRunner?.run();
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('preparing');
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('meshing');
    expect(currentDefinition()).not.toHaveProperty('stage');
    const meshRequest = rig.ports[0].request();
    if (!meshRequest) throw new Error('Missing mesh request');
    rig.ports[0].worker.onmessage?.(new MessageEvent<unknown>('message', { data: {
      protocol: meshRequest.protocol, kind: 'phase', identity: meshRequest.identity, phase: 'solving',
    } }));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('meshing');
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('solving');
    await rig.ports[1].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBeNull();
    const result = useAppStore.getState().solidAnalysisSession?.result;
    expect(result?.prepared.loadedAreaMm2).toBe(6); expect(result?.prepared.totalForceN).toEqual([0, 0, 12]);
    expect(result?.result.elements.every(element => Math.abs(element.stressMPa[2] - 2) < 1e-10)).toBe(true);
    expect(result?.result.reactionN.reduce((sum, vector) => sum + vector[2], 0)).toBeCloseTo(-12, 10);
    expect(rig.attachment.statistics()).toEqual({ created: 2, terminated: 2, live: 0 });
    const displacement = result?.result.displacementMm[4][2];
    if (displacement === undefined) throw new Error('Missing accepted displacement');
    useAppStore.getState().editSolidAnalysis('young', '420000');
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[2]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[2].reply();
    await vi.waitFor(() => expect(rig.ports[3]?.request()?.kind).toBe('analyze-solid-tet4'));
    await rig.ports[3].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
    expect(useAppStore.getState().solidAnalysisSession?.result?.result.displacementMm[4][2]).toBeCloseTo(displacement / 2, 12);
    expect(rig.attachment.statistics()).toEqual({ created: 4, terminated: 4, live: 0 });
  });
  it.each(['edit', 'cancel', 'close', 'document'] as const)('discards a late mesh after %s', async change => {
    const rig = install(); live.push(rig); useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    if (change === 'edit') useAppStore.getState().editSolidAnalysis('tz', '3');
    else if (change === 'cancel') useAppStore.getState().cancelSolidAnalysis();
    else if (change === 'close') useAppStore.getState().closeStrength();
    else useAppStore.getState().resetDocument(createEmptyPartDocument());
    await rig.ports[0].reply();
    await Promise.resolve();
    expect(useAppStore.getState().solidAnalysisSession?.result ?? null).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.stage ?? null).toBeNull();
    expect(rig.ports).toHaveLength(1); expect(rig.attachment.statistics().live).toBe(0);
  });
  it('terminates an in-flight solid request and keeps an older completion out of the next run', async () => {
    const rig = install(); live.push(rig); useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    useAppStore.getState().editSolidAnalysis('tz', '3');
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[2]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[1].reply();
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('running');
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBe('meshing');
    expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
    useAppStore.getState().cancelSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession?.stage).toBeNull();
    expect(rig.attachment.statistics()).toEqual({ created: 3, terminated: 3, live: 0 });
  });
  it('revalidates restored semantic origins and rejects missing selections or stale resolved keys', () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().setSelection([]);
    useAppStore.getState().solidAnalysisRunner?.captureFaces('fixed');
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('failed');
    rig.pick(0, 'fixed');
    useAppStore.getState().saveSolidAnalysis();
    const saved = useAppStore.getState().document.beamAnalysisInputs;
    expect(saved?.analyses[0].kind).toBe('solid-cad');
    useAppStore.getState().closeSolidAnalysis(); useAppStore.getState().openSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing reopened session');
    useAppStore.setState({ solidAnalysisSession: { ...session, loadedFaces: ['unknown-origin'] } });
    expect(() => useAppStore.getState().solidAnalysisRunner?.validate()).toThrow();
    expect(rig.ports).toHaveLength(0);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toBeUndefined();
  });
  it('keeps the session, a pending face capture and an in-flight run when only its own inputs are saved', async () => {
    const rig = install(); live.push(rig);
    // A face picked before the save is still captured after it (the save is not a geometry change).
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', 1)], { kind: 'pick' });
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses[0].kind).toBe('solid-cad');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('editing');
    useAppStore.getState().solidAnalysisRunner?.captureFaces('loaded');
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('editing');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.loadedFaces).toHaveLength(1);
    // Saving again while a run waits for its mesh neither cancels it nor shows the changed warning.
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('running');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBeNull();
    expect(rig.attachment.statistics()).toEqual({ created: 1, terminated: 0, live: 1 });
    useAppStore.getState().cancelSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('cancelled');
    expect(rig.attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
    // Undo of the second save is not a geometry change either (the first save's inputs remain).
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses[0].kind).toBe('solid-cad');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBeNull();
    // The history step still discards drafts (documentVersion advanced): status and result are reset, only the false
    // shape/input warning is absent.
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('editing');
    expect(useAppStore.getState().solidAnalysisSession?.result ?? null).toBeNull();
  });
  it('still cancels and invalidates when the document changes shape, and drops the late mesh', async () => {
    const rig = install(); live.push(rig); useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    const state = useAppStore.getState();
    // A new solids array is a shape change for affectsShape (reference comparison of shape fields).
    state.applyDocument({ ...state.document, solids: [...state.document.solids] });
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('editing');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBe(t('solidAnalysis.changed'));
    await rig.ports[0].reply();
    await Promise.resolve();
    expect(useAppStore.getState().solidAnalysisSession?.result ?? null).toBeNull();
    expect(rig.ports).toHaveLength(1); expect(rig.attachment.statistics().live).toBe(0);
    // Undo of that shape change is a shape change as well: after clearing the warning by an edit, Undo reports it again.
    useAppStore.getState().editSolidAnalysis('tz', '2');
    expect(useAppStore.getState().solidAnalysisSession?.error).toBeNull();
    useAppStore.getState().undo();
    expect(useAppStore.getState().solidAnalysisSession?.error).toBe(t('solidAnalysis.changed'));
  });
});

describe('signed pressure through the actual attachment and public FEM request (analytic Worker replies)', () => {
  /** Independent of the FEM code: the loaded face 1 is the box top z = 4 (2 x 3 mm, outward normal +z), so a pressure p
   * pushing inward is the traction -p e_z on every loaded triangle and the resultant is -6 p e_z N. */
  async function runPressure(source: string, pressure: number) {
    const rig = install(); live.push(rig);
    // A hidden malformed traction draft must neither block the pressure run nor leak into its request.
    useAppStore.getState().editSolidAnalysis('tz', 'not a number');
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    useAppStore.getState().editSolidAnalysis('pressure', source);
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    const request = rig.ports[1].request();
    if (request?.kind !== 'analyze-solid-tet4') throw new Error('Missing solid request');
    // An independent mutable accumulator (SolidVector3 is a readonly tuple).
    const resultant: number[] = [0, 0, 0];
    let area = 0;
    expect(request.input.surfaceLoads.length).toBeGreaterThan(0);
    for (const load of request.input.surfaceLoads) {
      const [a, b, c] = load.nodes.map(index => request.input.nodes[index]);
      for (const node of [a, b, c]) expect(node[2]).toBeCloseTo(4, 12);
      const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - a[0], c[1] - a[1]];
      const triangleArea = Math.abs(u[0] * v[1] - u[1] * v[0]) / 2;
      area += triangleArea;
      expect(load.tractionMPa[0]).toBeCloseTo(0, 12); expect(load.tractionMPa[1]).toBeCloseTo(0, 12);
      expect(load.tractionMPa[2]).toBeCloseTo(-pressure, 12);
      for (let axis = 0; axis < 3; axis += 1) resultant[axis] += triangleArea * load.tractionMPa[axis];
    }
    expect(area).toBeCloseTo(6, 12);
    expect(resultant[2]).toBeCloseTo(-6 * pressure, 12);
    return rig;
  }
  it.each([['3/2', 1.5], ['-2', -2], ['0', 0]] as const)('pressure %s MPa reaches the request as inward normal traction', async (source, value) => {
    const rig = await runPressure(source, value);
    useAppStore.getState().cancelSolidAnalysis();
    expect(rig.attachment.statistics().live).toBe(0);
  });
  it('an outward pressure of 2 MPa completes with the uniform zz stress the analytic reply is built for', async () => {
    // The analytic reply is the uniform state sigma_zz = 2 MPa, which balances exactly a 2 MPa outward pull on the top.
    const rig = await runPressure('-2', -2);
    await rig.ports[1].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
    const result = useAppStore.getState().solidAnalysisSession?.result;
    expect(result?.prepared.loadedAreaMm2).toBe(6);
    expect(result?.prepared.totalForceN[0]).toBeCloseTo(0, 12); expect(result?.prepared.totalForceN[1]).toBeCloseTo(0, 12);
    expect(result?.prepared.totalForceN[2]).toBeCloseTo(12, 12);
    expect(result?.result.reactionN.reduce((sum, vector) => sum + vector[2], 0)).toBeCloseTo(-12, 10);
    expect(rig.attachment.statistics()).toEqual({ created: 2, terminated: 2, live: 0 });
  });

  it('switching back to traction keeps the traction draft and the old behavior', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    useAppStore.getState().editSolidAnalysis('pressure', '5');
    useAppStore.getState().setSolidAnalysisLoadMode('traction');
    expect(useAppStore.getState().solidAnalysisSession?.values.tz).toBe('2');
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    const request = rig.ports[1].request();
    if (request?.kind !== 'analyze-solid-tet4') throw new Error('Missing solid request');
    expect(request.input.surfaceLoads.every(load => load.tractionMPa.join() === '0,0,2')).toBe(true);
    await rig.ports[1].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
    expect(useAppStore.getState().solidAnalysisSession?.result?.prepared.totalForceN).toEqual([0, 0, 12]);
  });

  it('a mode switch while meshing cancels the run and drops the late reply', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('editing');
    await rig.ports[0].reply();
    await Promise.resolve();
    expect(useAppStore.getState().solidAnalysisSession?.result ?? null).toBeNull();
    expect(rig.ports).toHaveLength(1); expect(rig.attachment.statistics().live).toBe(0);
  });

  it('an invalid pressure fails without a request, and the saved pressure survives save, Undo/Redo and reopen', () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    useAppStore.getState().editSolidAnalysis('pressure', '1/0');
    useAppStore.getState().solidAnalysisRunner?.run();
    expect(useAppStore.getState().solidAnalysisSession?.status).toBe('failed');
    expect(rig.ports).toHaveLength(0);
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().document).toBe(before);
    useAppStore.getState().editSolidAnalysis('pressure', '-0.75');
    useAppStore.getState().saveSolidAnalysis();
    const savedDefinition = (): unknown => useAppStore.getState().document.beamAnalysisInputs?.analyses[0];
    expect(savedDefinition()).toMatchObject({ kind: 'solid-cad', definition: { schema: 'pointercad-solid-cad-input/2',
      load: 'pressure', pressureMPa: -0.75 } });
    expect(JSON.stringify(savedDefinition())).not.toContain('tractionMPa');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toBeUndefined();
    useAppStore.getState().redo();
    expect(savedDefinition()).toMatchObject({ definition: { load: 'pressure', pressureMPa: -0.75 } });
    useAppStore.getState().closeSolidAnalysis(); useAppStore.getState().openSolidAnalysis();
    const reopened = useAppStore.getState().solidAnalysisSession;
    expect(reopened?.loadMode).toBe('pressure');
    expect(reopened?.values.pressure).toBe('-0.75');
    expect(reopened?.result ?? null).toBeNull();
  });
});
