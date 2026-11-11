import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource } from '@pointercad/model';
import { decodeTetraMesh, tetraMeshInputSha256, type FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { boundaryMesh, context } from '../solidAnalysis/solidAnalysis.testSupport.js';
import { attachSolidPlastic } from './attachSolidPlastic.js';
import { solidPlasticSavedInput, type SolidPlasticField } from './solidPlasticSession.js';

/**
 * PROVISIONAL (authored, unexecuted). Same rig as attachSolidAnalysis.test.ts: real store, real attachment, real
 * public client, scripted Worker replies for the mesh stage only (not native execution). The plasticity request is
 * observed but never answered here, so no solver result is fabricated.
 */
type Request = Parameters<FemWorkerPort['postMessage']>[0];
function port() {
  let request: Request | null = null;
  const terminate = vi.fn<() => void>();
  const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: value => { request = value; }, terminate };
  return { worker, terminate, request: () => request, replyMesh: async () => {
    if (!request || request.kind !== 'mesh-cad-convex-tetra') throw new Error('No mesh request');
    const message = request, input = message.input;
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
  const attachment = attachSolidPlastic(kernel, useAppStore, () => { const value = port(); ports.push(value); return value.worker; });
  attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: 'box', key: 'box:7' }] });
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidPlastic();
  const pick = (index: number, role: 'fixed' | 'loaded') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidPlasticRunner?.captureFaces(role);
  };
  pick(0, 'fixed'); pick(1, 'loaded');
  const fields: [SolidPlasticField, string][] = [['young', '200000'], ['poisson', '0.3'], ['yield', '250'],
    ['hardening', '2000'], ['tz', '2'], ['volume', '0.1'], ['history', '0, 1, 0'], ['steps', '2'],
    ['reference', 'Test benchmark constants, not a material specification']];
  for (const [name, value] of fields) useAppStore.getState().editSolidPlastic(name, value);
  return { attachment, ports, document };
}
const live: ReturnType<typeof install>[] = [];
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidPlasticSession: null, solidPlasticRunner: null }); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

describe('solid plasticity UI attachment (authored, unexecuted; mesh-stage replies only)', () => {
  it.each(['editing', 'cancelled', 'running'] as const)('persists input with the real attachment after %s without a false stale warning', async phase => {
    const rig = install(); live.push(rig);
    const before = useAppStore.getState().document;
    const session = useAppStore.getState().solidPlasticSession;
    if (!session) throw new Error('Missing actual session');
    const expected = solidPlasticSavedInput(session, before.id, before.parameters);
    if (phase !== 'editing') {
      useAppStore.getState().solidPlasticRunner?.run();
      await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
      if (phase === 'cancelled') {
        useAppStore.getState().cancelSolidPlastic();
        expect(useAppStore.getState().solidPlasticSession?.status).toBe('cancelled');
        expect(rig.attachment.statistics().live).toBe(0);
      }
    }
    useAppStore.getState().saveSolidPlastic();
    const after = useAppStore.getState().document;
    expect(after).not.toBe(before);
    expect(after.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-plastic-cad', definition: expected }]);
    expect(useAppStore.getState().solidPlasticSession?.error).toBeNull();
    expect(useAppStore.getState().solidPlasticSession?.result).toBeNull();
    if (phase !== 'editing') {
      const savedSession = useAppStore.getState().solidPlasticSession;
      await rig.ports[0].replyMesh();
      await Promise.resolve();
      expect(rig.ports).toHaveLength(1);
      expect(rig.attachment.statistics().live).toBe(0);
      expect(useAppStore.getState().solidPlasticSession).toEqual(savedSession);
      expect(useAppStore.getState().document).toBe(after);
    } else expect(rig.ports).toHaveLength(0);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(before.beamAnalysisInputs);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(after.beamAnalysisInputs);
    useAppStore.getState().closeSolidPlastic(); useAppStore.getState().openSolidPlastic();
    const reopened = useAppStore.getState().solidPlasticSession;
    if (!reopened) throw new Error('Missing reopened session');
    expect(solidPlasticSavedInput(reopened, after.id, after.parameters)).toEqual(expected);
  });

  it.each(['geometry', 'input', 'owner'] as const)('still refuses condition saving after real %s invalidation', change => {
    const rig = install(); live.push(rig);
    if (change === 'geometry') {
      useAppStore.getState().applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature('other')));
      expect(useAppStore.getState().solidPlasticSession?.error).toBeTruthy();
    } else if (change === 'input') useAppStore.getState().editSolidPlastic('history', '0, invalid');
    else useAppStore.setState({ activeDocumentId: 'different-owner' });
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidPlastic();
    expect(useAppStore.getState().document).toBe(before);
    expect(before.beamAnalysisInputs).toBeUndefined();
    if (change === 'owner') expect(useAppStore.getState().solidPlasticSession).toBeNull();
    else expect(useAppStore.getState().solidPlasticSession?.error).toBeTruthy();
    expect(rig.ports).toHaveLength(0);
  });

  it('meshes the current CAD solid, then sends a plasticity request instead of a linear one', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidPlasticRunner?.run();
    expect(useAppStore.getState().solidPlasticSession?.status).toBe('running');
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    await rig.ports[0].replyMesh();
    await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-plastic-tet4'));
    expect(rig.ports).toHaveLength(2);
    expect(rig.ports[1].request()?.kind).not.toBe('analyze-solid-tet4');
    expect(useAppStore.getState().solidPlasticSession?.status).toBe('running');
    useAppStore.getState().cancelSolidPlastic();
    expect(useAppStore.getState().solidPlasticSession?.status).toBe('cancelled');
    expect(rig.attachment.statistics().live).toBe(0);
  });

  it.each(['edit', 'cancel', 'close', 'document'] as const)('discards a late mesh after %s and keeps no result', async change => {
    const rig = install(); live.push(rig); useAppStore.getState().solidPlasticRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    if (change === 'edit') useAppStore.getState().editSolidPlastic('history', '0, 2, 0');
    else if (change === 'cancel') useAppStore.getState().cancelSolidPlastic();
    else if (change === 'close') useAppStore.getState().closeStrength();
    else useAppStore.getState().resetDocument(createEmptyPartDocument());
    await rig.ports[0].replyMesh();
    await Promise.resolve();
    expect(useAppStore.getState().solidPlasticSession?.result ?? null).toBeNull();
    expect(rig.ports).toHaveLength(1);
    expect(rig.attachment.statistics().live).toBe(0);
  });

  it.each(['fixed', 'loaded'] as const)('cancels pending mesh when %s face capture is rejected and ignores its late reply', async role => {
    const rig = install(); live.push(rig);
    const input = useAppStore.getState().solidPlasticSession;
    useAppStore.getState().solidPlasticRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    useAppStore.getState().setSelection([]);
    useAppStore.getState().solidPlasticRunner?.captureFaces(role);
    const failed = useAppStore.getState().solidPlasticSession;
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBeTruthy();
    expect(failed?.result).toBeNull();
    expect(failed?.bodyFeatureId).toBe(input?.bodyFeatureId);
    expect(failed?.fixedFaces).toEqual(input?.fixedFaces);
    expect(failed?.loadedFaces).toEqual(input?.loadedFaces);
    expect(failed?.values).toEqual(input?.values);
    expect(failed?.revision).toBe(input?.revision);
    expect(rig.attachment.statistics().live).toBe(0);
    expect(rig.ports[0].terminate).toHaveBeenCalledOnce();
    await rig.ports[0].replyMesh();
    await Promise.resolve();
    expect(rig.ports).toHaveLength(1);
    expect(rig.attachment.statistics().live).toBe(0);
    expect(useAppStore.getState().solidPlasticSession).toEqual(failed);
  });

  it('refuses to run with an invalid history and reports a user-facing message without sending anything', () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().editSolidPlastic('history', '0, a');
    useAppStore.getState().solidPlasticRunner?.run();
    const session = useAppStore.getState().solidPlasticSession;
    expect(session?.status).toBe('failed');
    expect(session?.error).toBeTruthy();
    expect(rig.ports).toHaveLength(0);
  });

  it('dispose releases the runner and the session', () => {
    const rig = install();
    rig.attachment.dispose();
    expect(useAppStore.getState().solidPlasticRunner).toBeNull();
    expect(useAppStore.getState().solidPlasticSession).toBeNull();
  });
});
