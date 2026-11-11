import { appendSolid, createEmptyPartDocument, type SolidBody } from '@pointercad/model';
import type { FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { t } from '../i18n/t.js';
import { attachShellAnalysis } from './attachShellAnalysis.js';
import { sheetBody, sheetKernel } from './shellAnalysis.testSupport.js';
import type { ShellField } from './shellAnalysisSession.js';

/**
 * The real UI -> analyzeCadShell -> femShellNativeRunner -> FemClient.analyzeShell -> Worker path, up to the Worker
 * boundary. The Worker here is a recording port that never answers: these tests check what is sent, the ownership of
 * the one Worker per run and the state on cancel/close/change. They are NOT native evidence; the numbers of the native
 * answer (+/-6M/t^2 pure bending) are checked by the fem tests (cadShellAnalysis.test.ts) with the native runtime.
 */
type Request = Parameters<FemWorkerPort['postMessage']>[0];
function recordingPort() {
  const requests: Request[] = [];
  const terminate = vi.fn();
  const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: value => { requests.push(value); }, terminate };
  return { worker, requests, terminate };
}
const FEATURE = 'plate';

function install(body: SolidBody = sheetBody(FEATURE)) {
  const document = appendSolid(createEmptyPartDocument(), extrudeFeature(FEATURE));
  useAppStore.getState().resetDocument(document);
  useAppStore.getState().recordRecomputeRequest(7);
  useAppStore.getState().applyRecompute(document, { ...resultFor(document), generation: 7, bodies: [body] });
  useAppStore.getState().recordRecomputeCompletion(7, 'success');
  const ports: ReturnType<typeof recordingPort>[] = [];
  const attachment = attachShellAnalysis(sheetKernel(), useAppStore, () => { const port = recordingPort(); ports.push(port); return port.worker; });
  attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: FEATURE, key: `${FEATURE}:7` }] });
  useAppStore.getState().toggleStrength(); useAppStore.getState().openShellAnalysis();
  const pick = (kind: 'face' | 'edge' | 'vertex', indexes: readonly number[], role: 'midsurface' | 'support' | 'load') => {
    useAppStore.getState().setSelection(indexes.map(index => subShapeElementId(FEATURE, kind, index)), { kind: 'pick' });
    useAppStore.getState().shellAnalysisRunner?.capture(role);
  };
  return { attachment, ports, document, pick };
}
/** Explicit user entries (pure bending of the fem test: M = 100 N mm/mm about y on x = 40 and -M on x = 0). */
function enterBending(rig: ReturnType<typeof install>): void {
  rig.pick('face', [0], 'midsurface');
  rig.pick('vertex', [0, 3, 1], 'support');
  rig.pick('edge', [1, 3], 'load');
  const state = useAppStore.getState(), session = state.shellAnalysisSession;
  if (!session) throw new Error('No session');
  const [origin, far, corner] = session.supports;
  for (const dof of ['ux', 'uy', 'uz'] as const) state.setShellSupportFixed(origin.key, dof, true);
  for (const dof of ['ux', 'uz'] as const) state.setShellSupportFixed(far.key, dof, true);
  state.setShellSupportFixed(corner.key, 'uz', true);
  const [right, left] = session.edgeLoads;
  for (const component of ['fx', 'fy', 'fz', 'mx', 'mz'] as const) { state.editShellEdgeLoad(right.key, component, '0'); state.editShellEdgeLoad(left.key, component, '0'); }
  state.editShellEdgeLoad(right.key, 'my', '100'); state.editShellEdgeLoad(left.key, 'my', '-100');
  const fields: [ShellField, string][] = [['thickness', '2'], ['young', '210000'], ['poisson', '0.3']];
  for (const [name, value] of fields) state.editShellAnalysis(name, value);
  state.editShellMaterialSource({ kind: 'user-supplied', reference: 'test entry', condition: 'room temperature' });
}
const live: ReturnType<typeof install>[] = [];
function rig(body?: SolidBody) { const value = install(body); live.push(value); return value; }
const session = () => { const value = useAppStore.getState().shellAnalysisSession; if (!value) throw new Error('No session'); return value; };
async function posted(value: ReturnType<typeof install>): Promise<Request> {
  await vi.waitFor(() => { expect(value.ports[0]?.requests.length).toBe(1); });
  return value.ports[0].requests[0];
}

beforeEach(() => { resetTestStore(); useAppStore.setState({ shellAnalysisSession: null, shellAnalysisRunner: null }); });
afterEach(() => { for (const value of live.splice(0)) value.attachment.dispose(); resetTestStore(); });

describe('shell analysis screen -> real FEM client path', () => {
  it('sends exactly the entered sheet, material, supports and edge moments to one TR_SHELL02 Worker request', async () => {
    const value = rig(); enterBending(value);
    expect(session().result).toBeNull();
    useAppStore.getState().shellAnalysisRunner?.run();
    expect(session().status).toBe('running');
    const request = await posted(value);
    expect(request.kind).toBe('analyze-shell-tr-shell02');
    if (request.kind !== 'analyze-shell-tr-shell02') throw new Error('Unexpected request');
    expect(request.input.materials).toEqual([{ id: 'material', youngMPa: 210000, poisson: 0.3 }]);
    expect(new Set(request.input.elements.map(element => element.thicknessMm))).toEqual(new Set([2]));
    expect(request.input.source.documentId).toBe(useAppStore.getState().document.id);
    expect(request.input.constraints.length).toBe(3);
    // Statics of a uniform edge moment: the work-equivalent nodal moments on an edge sum to m * edge length
    // (+100 N mm/mm * 30 mm on x = 40, -100 * 30 on x = 0); a pure moment about the edge adds no force.
    const momentYAt = (x: number): number => request.input.nodalLoads
      .filter(load => request.input.nodes[load.node][0] === x).reduce((sum, load) => sum + load.momentNmm[1], 0);
    expect(momentYAt(40)).toBeCloseTo(3000, 9);
    expect(momentYAt(0)).toBeCloseTo(-3000, 9);
    expect(request.input.nodalLoads.flatMap(load => load.forceN).every(component => Math.abs(component) <= 1e-12)).toBe(true);
    expect(value.attachment.statistics()).toEqual({ created: 1, terminated: 0, live: 1 });
  });

  it('cancel releases the Worker and shows the cancelled state without a result', async () => {
    const value = rig(); enterBending(value);
    useAppStore.getState().shellAnalysisRunner?.run();
    await posted(value);
    useAppStore.getState().cancelShellAnalysis();
    expect(session().status).toBe('cancelled'); expect(session().result).toBeNull();
    expect(value.attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('a physical edit during the run cancels it, advances the revision and keeps no result; a view change does not', async () => {
    const value = rig(); enterBending(value);
    useAppStore.getState().shellAnalysisRunner?.run();
    await posted(value);
    const running = session();
    useAppStore.getState().setShellAnalysisView('yy');
    expect(session().revision).toBe(running.revision); expect(session().status).toBe('running');
    expect(value.attachment.statistics().live).toBe(1);
    useAppStore.getState().editShellAnalysis('thickness', '3');
    expect(session().revision).toBe(running.revision + 1); expect(session().status).toBe('editing');
    expect(session().result).toBeNull();
    expect(value.attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('closing the panel and closing the parent release the Worker and drop the session', async () => {
    const value = rig(); enterBending(value);
    useAppStore.getState().shellAnalysisRunner?.run();
    await posted(value);
    useAppStore.getState().closeStrength();
    expect(useAppStore.getState().shellAnalysisSession).toBeNull();
    expect(value.attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('a document change during the run drops the run and reports the change', async () => {
    const value = rig(); enterBending(value);
    useAppStore.getState().shellAnalysisRunner?.run();
    await posted(value);
    useAppStore.getState().recordRecomputeRequest(8);
    expect(session().status).not.toBe('complete'); expect(session().result).toBeNull();
    expect(value.attachment.statistics().live).toBe(0);
  });

  it('refuses a solid body as midsurface before any Worker exists', () => {
    const value = rig(sheetBody(FEATURE, 'solid'));
    value.pick('face', [0], 'midsurface');
    expect(session().error).toBe(t('shellAnalysis.notSheet'));
    expect(session().midsurfaceFaces).toEqual([]);
    expect(value.attachment.statistics().created).toBe(0);
  });

  it('stops with the adapter refusal when a saved support origin has no unique counterpart on the current body', () => {
    const value = rig(); enterBending(value);
    const state = useAppStore.getState(), current = session();
    // A support whose saved origin names an edge role the current sheet does not have (deleted/renamed topology).
    const missing = { key: 'gone', kind: 'edge' as const, fixed: current.supports[0].fixed,
      origin: { version: 1 as const, shapeKind: 'edge' as const, identity: { kind: 'box-edge' as const, featureId: FEATURE,
        role: 'bottom-front' as const } } };
    useAppStore.setState({ shellAnalysisSession: { ...current, supports: [...current.supports, missing] } });
    state.shellAnalysisRunner?.run();
    expect(session().status).toBe('failed');
    expect(session().error).toContain(t('shellAnalysis.failure.supportUnresolved'));
    expect(value.attachment.statistics().created).toBe(0);
  });

  it('does not run without explicit fixed directions and material source (no silent all-fixed or default steel)', () => {
    const value = rig();
    value.pick('face', [0], 'midsurface'); value.pick('edge', [3], 'support');
    expect(session().supports[0].fixed).toEqual([false, false, false, false, false, false]);
    useAppStore.getState().shellAnalysisRunner?.run();
    expect(session().status).toBe('failed');
    expect(session().error).toBe(t('shellAnalysis.needFixedDof'));
    expect(value.attachment.statistics().created).toBe(0);
  });

  it('saves the definition into the part document and reopens it unchanged after closing', () => {
    const value = rig(); enterBending(value);
    useAppStore.getState().saveShellAnalysis();
    const saved = useAppStore.getState().document.beamAnalysisInputs?.analyses.find(row => row.kind === 'shell-cad-analysis');
    expect(saved?.kind).toBe('shell-cad-analysis');
    const before = session();
    useAppStore.getState().closeShellAnalysis(); useAppStore.getState().openShellAnalysis();
    const reopened = session();
    expect(reopened.supports.map(row => row.fixed)).toEqual(before.supports.map(row => row.fixed));
    expect(reopened.materialSource).toEqual(before.materialSource);
    expect(reopened.result).toBeNull();
    expect(value.attachment.statistics().created).toBe(0);
  });
});
