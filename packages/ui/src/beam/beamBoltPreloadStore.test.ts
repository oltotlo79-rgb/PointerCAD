import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import type { FemWorkerPort } from '@pointercad/fem';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { prepareNativeBoltPreload } from '../../../fem/src/nativeBoltPreload.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamUiFixture } from './beam.testSupport.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { captureBeamSource } from './beamSource.js';
import { restoreBeamSession } from './beamSession.js';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });
function draft() { const d = useAppStore.getState().boltPreloadDraft; if (d === null) throw new Error('Draft missing'); return d; }
function setup() {
  const f = savedBoltFixture(), ui = beamUiFixture(), view = ui.state.assemblyView;
  if (view === null) throw new Error('Publication fixture missing');
  const source = { ...f.saved.source, geometryRevision: `${f.document.id}:1` }, bolts = f.saved.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('Existing association missing');
  const saved = { ...f.saved, source, input: { ...f.saved.input, source }, cadDefinition: { ...f.saved.cadDefinition, source, axialBolts: { ...bolts, source } } };
  const document = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition: { ...f.definition, id: 'other-analysis', axialBolts: { ...bolts, analysisId: 'other-analysis' } } }, { kind: 'native-bolt-preload', definition: saved }] });
  const owner = { ...ui.owner, document, activeDocumentId: document.id, documentVersion: source.documentRevision, generation: 1 };
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id, documentVersion: source.documentRevision,
    requestedGeneration: 1, completedGeneration: 1, assemblyUndoStack: createUndoStack({ document, library: ui.state.assemblyLibrary }),
    assemblyView: { ...view, sourceDocument: document, meshOwnership: owner } };
  useAppStore.setState(state);
  const ports: Port[] = [];
  attachment = attachBeamAnalysis(useAppStore, () => { const p = new Port(); ports.push(p); return p; });
  useAppStore.getState().openBoltPreload(saved.id);
  return { ...f, saved, document, state, ports };
}
async function review() {
  useAppStore.getState().confirmBoltPreload(true);
  await useAppStore.getState().reviewBoltPreload();
  expect(useAppStore.getState().boltPreloadError).toBeNull(); expect(draft().reviewed).not.toBeNull();
}
async function start(ports: Port[]) {
  const count = ports.length; useAppStore.getState().runBoltPreload();
  await vi.waitFor(() => { expect(ports).toHaveLength(count + 1); expect(ports[count].request?.kind).toBe('analyze-native-bolt-preload'); });
  return ports[count];
}
/** Independent, controlled two-spring oracle for the approved FB50x6 50+50mm CAD fixture.
 * No native execution. cm=100/(200000*300)mm/N=1/600000000m/N, cb=10nm/N.
 * All fixture loads are below separation: N=4000+P/7, Q=4000-6P/7.
 * u=[0,-Qcm/2,-Qcm/2,-Qcm] along +Z, R1=-P, U=cbN²/2+cmQ²/2. */
async function response(port: Port) {
  const request = port.request;
  if (request?.kind !== 'analyze-native-bolt-preload') throw new Error('Dedicated request missing');
  const prepared = await prepareNativeBoltPreload(request.input.plan), cm = 1 / 600000000, cb = 1e-8, s = 7 / 150000;
  expect(prepared.cm).toBeCloseTo(cm, 18); expect(prepared.cb).toBeCloseTo(cb, 18); expect(prepared.plan.shorteningM).toBeCloseTo(s, 16);
  const forceRows = [0, 1000, 0].map((p, i) => {
    const n = 4000 + p / 7, q = 4000 - 6 * p / 7;
    return { stage: i === 0 ? 'tightening' : 'external', externalLoadN: p, boltId: 'tie', extensionM: -q * cm,
      elasticExtensionM: cb * n, boltTensionN: n, memberCompressionN: q, gapM: 0,
      boltEnergyJ: cb * n * n / 2, memberEnergyJ: cm * q * q / 2,
      supportReactions: [1, 2, 3, 4].map(number => ({ number, forceN: [0, 0, number === 1 ? -p : 0] })) };
  });
  return { kind: 'native-bolt-preload-stages', source: request.input.source,
    schema: 'pointercad-native-bolt-preload-result/1', method: 'native-beam3d-plus-series-bolt-and-existing-lcp',
    nativeContactSolver: false, structuralCertification: false, lockedShorteningM: prepared.plan.shorteningM, lockAfterState: 0,
    boltComplianceMPerN: cb, memberComplianceMPerN: cm, planSha256: prepared.inputSha256, states: forceRows,
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 3, meshNodes: 4, meshElements: 2, momentLengthM: .05, pivotLimit: 20,
      states: forceRows.map(row => ({ loadFactor: row.externalLoadN, pivots: 1,
        nodes: [0, -row.memberCompressionN * cm / 2, -row.memberCompressionN * cm / 2, -row.memberCompressionN * cm]
          .map((u, i) => ({ number: i + 1, displacementM: [0, 0, u], rotationRad: [0, 0, 0] })),
        contacts: [{ id: 'interface', state: 'closed', normalReactionN: row.memberCompressionN, gapM: 0 }],
        forceScaleN: 4000, gapScaleM: s, equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0 })) } };
}
function reply(port: Port, result: unknown) {
  const request = port.request; if (request === null) throw new Error('Request missing');
  port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
}
async function completed(port: Port) {
  reply(port, await response(port)); await vi.waitFor(() => expect(useAppStore.getState().boltPreloadStatus).toBe('complete'));
}
describe('actual store and shared client preload boundary (controlled protocol, no native solve)', () => {
  it('restores and invalidates confirmation/review/decoded result on one edit', async () => {
    const f = setup(); expect(draft().saved).toEqual(f.saved); await review(); const p = await start(f.ports); await completed(p);
    expect(draft().result?.kind).toBe('native-bolt-preload-stages');
    useAppStore.getState().editBoltPreload({ kind: 'number', field: 'preloadN', text: '4100' });
    expect(draft().confirmed).toBe(false); expect(draft().reviewed).toBeNull(); expect(draft().result).toBeNull();
    expect(useAppStore.getState().assembly).toBe(f.document);
  });
  it('refuses adoption when source changes during awaited review', async () => {
    const f = setup(); useAppStore.getState().confirmBoltPreload(true);
    const work = useAppStore.getState().reviewBoltPreload();
    useAppStore.setState({ documentVersion: f.state.documentVersion + 1 }); await work;
    expect(draft().reviewed).toBeNull(); expect(draft().result).toBeNull(); expect(f.ports).toHaveLength(0);
  });
  it('refuses an older saved source even when the current publication is valid', async () => {
    const f = setup(), view = useAppStore.getState().assemblyView;
    if (view?.meshOwnership === undefined) throw new Error('Publication missing');
    useAppStore.setState({ documentVersion: f.state.documentVersion + 1,
      assemblyView: { ...view, meshOwnership: { ...view.meshOwnership, documentVersion: f.state.documentVersion + 1 } } });
    useAppStore.getState().confirmBoltPreload(true); await useAppStore.getState().reviewBoltPreload();
    expect(draft().saved.source.documentRevision).toBe(f.saved.source.documentRevision);
    expect(draft().reviewed).toBeNull(); expect(useAppStore.getState().boltPreloadError).not.toBeNull(); expect(f.ports).toHaveLength(0);
  });
  it('dispatches dedicated wire and accepts only the real numeric-decoded owned response', async () => {
    const f = setup(); await review(); const port = await start(f.ports);
    const request = port.request; if (request?.kind !== 'analyze-native-bolt-preload') throw new Error('Wrong route');
    expect(Object.keys(request.input).sort()).toEqual(['plan', 'source']); expect(JSON.stringify(request)).not.toContain('prepared');
    await completed(port);
    expect(draft().result?.states[1].boltTensionN).toBeCloseTo(29000 / 7, 8);
    expect(draft().result?.states[1].memberCompressionN).toBeCloseTo(22000 / 7, 8);
    expect(draft().result?.nativeContactSolver).toBe(false); expect(attachment?.statistics().live).toBe(0);
  });
  it.each(['digest', 'generation'] as const)('refuses a wrong %s without adopting a result', async reason => {
    const f = setup(); await review(); const port = await start(f.ports), result = await response(port), request = port.request;
    if (request === null) throw new Error('Missing request');
    port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol,
      identity: reason === 'generation' ? { ...request.identity, generation: request.identity.generation + 1 } : request.identity,
      kind: 'result', result: reason === 'digest' ? { ...result, planSha256: 'f'.repeat(64) } : result } }));
    await vi.waitFor(() => expect(useAppStore.getState().boltPreloadStatus).toBe('failed'));
    expect(draft().result).toBeNull(); expect(useAppStore.getState().boltPreloadError).toContain('invalid-protocol');
  });
  it.each(['close', 'dispose'] as const)('drops late phase/result after %s and releases once', async reason => {
    const f = setup(); await review(); const p = await start(f.ports), callback = p.onmessage, result = await response(p), request = p.request;
    if (request === null) throw new Error('Request missing');
    if (reason === 'close') useAppStore.getState().closeBoltPreload(); else attachment?.dispose();
    const after = useAppStore.getState().boltPreloadDraft;
    callback?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'phase', phase: 'solving' } }));
    callback?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
    await Promise.resolve(); expect(useAppStore.getState().boltPreloadDraft).toBe(after);
    expect(useAppStore.getState().boltPreloadPhase).toBeNull(); expect(p.terminated).toBe(1); expect(attachment?.statistics().live).toBe(0);
  });
  it('preserves other inputs/member order and saves only authored inputs with exactly one Undo', async () => {
    const f = setup(); await review(); const before = useAppStore.getState(), other = f.document.beamAnalysisInputs?.analyses[0];
    useAppStore.getState().applyBoltPreloadInputs();
    const after = useAppStore.getState(); expect(after.assemblyUndoStack?.past).toHaveLength(1);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.assembly).not.toBe(before.assembly); expect(captureBeamSource(after)).toBeNull();
    expect(after.assembly?.beamAnalysisInputs?.analyses[0]).toEqual(other);
    const saved = after.assembly?.beamAnalysisInputs?.analyses.find(x => x.kind === 'native-bolt-preload');
    expect(saved?.kind).toBe('native-bolt-preload'); if (saved?.kind !== 'native-bolt-preload') throw new Error('Saved entry lost');
    expect(saved.definition.input.memberIds).toEqual(['a-beam', 'b-beam']); expect(saved.definition).toEqual(f.saved);
    expect(JSON.stringify(saved)).not.toMatch(/"(?:result|wire|token|states|positionM)"/u);
    expect(draft().confirmed).toBe(false); expect(draft().reviewed).toBeNull(); expect(f.ports).toHaveLength(0);
  });
  it('keeps the old standard route and cancels its actual pending client', async () => {
    const f = beamUiFixture(), ports: Port[] = []; useAppStore.setState({ ...f.state, beamSession: f.session });
    attachment = attachBeamAnalysis(useAppStore, () => { const p = new Port(); ports.push(p); return p; });
    useAppStore.getState().reviewBeam(); useAppStore.getState().runBeam();
    await vi.waitFor(() => expect(ports[0]?.request?.kind).toBe('analyze-beam-3d'));
    useAppStore.getState().cancelBeam(); expect(ports[0].terminated).toBe(1); expect(useAppStore.getState().beamSession?.status).toBe('cancelled');
  });
  it('supersedes both directions through one client without null-old-session cancelling preload', async () => {
    const f = setup(); await review(); const first = await start(f.ports);
    expect(useAppStore.getState().beamSession).toBeNull(); expect(first.terminated).toBe(0);
    const source = captureBeamSource(useAppStore.getState()); if (source === null) throw new Error('Source missing');
    const restored = restoreBeamSession(f.document.id, f.saved.cadDefinition, []);
    const standard = { ...restored, members: restored.members.map(m => ({ ...m, confirmed: true })), reviewed: source };
    useAppStore.setState({ beamSession: standard });
    useAppStore.getState().beamRunner?.run(standard, source);
    await vi.waitFor(() => expect(f.ports).toHaveLength(2));
    expect(first.terminated).toBe(1); expect(useAppStore.getState().boltPreloadStatus).toBe('cancelled');
    expect(f.ports[1].request?.kind).toBe('analyze-beam-bolt-contact');
    const third = await start(f.ports);
    expect(f.ports[1].terminated).toBe(1); expect(useAppStore.getState().beamSession?.status).toBe('cancelled');
    expect(third.terminated).toBe(0); expect(attachment?.statistics().live).toBe(1);
    useAppStore.getState().cancelBoltPreload(); expect(third.terminated).toBe(1);
  });
});
