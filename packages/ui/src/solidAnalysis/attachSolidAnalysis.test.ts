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
import type { SolidField } from './solidAnalysisSession.js';

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
  const pick = (index: number, role: 'fixed' | 'loaded') => {
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
describe('actual UI attachment and public client, analytic Worker replies (not native execution)', () => {
  it('connects current CAD faces through both public requests to accepted stress, force and reaction', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidAnalysisRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].reply();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
    await rig.ports[1].reply();
    await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
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
    expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
    useAppStore.getState().cancelSolidAnalysis();
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
