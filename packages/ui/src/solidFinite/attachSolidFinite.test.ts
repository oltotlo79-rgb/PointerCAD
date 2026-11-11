import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource } from '@pointercad/model';
import { decodeTetraMesh, tetraMeshInputSha256, type FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { boundaryMesh, context } from '../solidAnalysis/solidAnalysis.testSupport.js';
import { attachSolidFinite } from './attachSolidFinite.js';
import { solidFiniteSavedInput, type SolidFiniteField } from './solidFiniteSession.js';

/**
 * PROVISIONAL (authored, unexecuted). Same rig as attachSolidAnalysis.test.ts: real store, real attachment, real
 * public client, scripted Worker replies for the mesh stage only (not native execution). The finite request is
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
  const attachment = attachSolidFinite(kernel, useAppStore, () => { const value = port(); ports.push(value); return value.worker; });
  attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: 'box', key: 'box:7' }] });
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidFinite();
  const pick = (index: number, role: 'fixed' | 'loaded') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidFiniteRunner?.captureFaces(role);
  };
  pick(0, 'fixed'); pick(1, 'loaded');
  const fields: [SolidFiniteField, string][] = [['young', '200000'], ['poisson', '0.3'], ['yield', '250'],
    ['hardening', '2000'], ['tz', '2'], ['volume', '0.1'], ['forceFactors', '0'], ['prescribedFactors', '0'], ['referenceForce', '1'],
    ['reference', 'Test benchmark constants, not a material specification']];
  for (const [name, value] of fields) useAppStore.getState().editSolidFinite({ kind: 'field', field: name, value });
  return { attachment, ports, document };
}
const live: ReturnType<typeof install>[] = [];
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidFiniteSession: null, solidFiniteRunner: null }); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

describe('finite CAD attachment: real store and synthetic mesh worker only', () => {
  it('cancels a pending run on edit and ignores its late mesh reply', async () => {
    const rig = install(); live.push(rig);
    useAppStore.getState().solidFiniteRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    useAppStore.getState().editSolidFinite({ kind: 'field', field: 'forceFactors', value: '0, 1' });
    expect(rig.attachment.statistics().live).toBe(0);
    const current = useAppStore.getState().solidFiniteSession;
    await rig.ports[0].replyMesh(); await Promise.resolve();
    expect(useAppStore.getState().solidFiniteSession).toEqual(current);
    expect(current?.status).toBe('editing'); expect(current?.result).toBeNull();
    expect(rig.ports).toHaveLength(1);
  });
  it('reloads the finite draft on Undo and Redo without restoring a result', () => {
    const rig = install(); live.push(rig);
    const before = useAppStore.getState().document;
    const session = useAppStore.getState().solidFiniteSession;
    if (session === null) throw new Error('Missing finite session');
    const definition = solidFiniteSavedInput(session, before.id, before.parameters);
    useAppStore.getState().saveSolidFinite();
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-finite-cad', definition }]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().solidFiniteSession?.values.young).toBe('');
    expect(useAppStore.getState().solidFiniteSession?.result).toBeNull();
    useAppStore.getState().redo();
    const after = useAppStore.getState().solidFiniteSession;
    expect(after?.values.young).toBe('200000'); expect(after?.result).toBeNull();
    expect(after && solidFiniteSavedInput(after, before.id, before.parameters)).toEqual(definition);
  });
  it.each(['gateway', 'owner', 'dispose'] as const)('does not revive an old reply after %s changes', async action => {
    const rig = install(); live.push(rig); useAppStore.getState().solidFiniteRunner?.run();
    await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
    if (action === 'gateway') useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway } });
    else if (action === 'owner') useAppStore.setState({ activeDocumentId: 'different-owner' });
    else rig.attachment.dispose();
    const current = useAppStore.getState().solidFiniteSession;
    await rig.ports[0].replyMesh(); await Promise.resolve();
    expect(useAppStore.getState().solidFiniteSession).toEqual(current);
    expect(rig.attachment.statistics().live).toBe(0);
  });
});
