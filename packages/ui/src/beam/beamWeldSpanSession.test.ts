import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyPartDocument, resolveConstrainedAssembly, buildStandardPartFromSource, partKeyOf } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import type { FemWorkerPort } from '@pointercad/fem';
import { cadWeldSpanFixture } from '@pointercad/model/testing/analysis-fixtures';
import { cadWeldLayerFixture } from '@pointercad/model/testing/analysis-fixtures';
import { cadJointContactFixture } from '@pointercad/model/testing/analysis-fixtures';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { beamDefinition, editBeamSession, restoreBeamSession } from './beamSession.js';
import { captureBeamSource } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';

// The A fixture uses actual FB50x6x20 CAD/planner/apply and hand-fixed millimetres.
// Publication ownership below is controlled metadata, not a native-generated display receipt.
function spanFixture(mixed = false) {
  const ui = beamUiFixture(), cad = cadWeldSpanFixture(mixed);
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [key, bodies] of cad.context.bodies) {
    const part = createEmptyPartDocument(), result = { ...resultFor(part), bodies, generation: ui.owner.generation };
    sources.set(key, { document: part, attachments: undefined, result, bodies,
      layouts: bodies.map(captureMeshBodyLayout), displayOwner: null, hiddenOwners: [], current: () => true });
  }
  const owner = { ...ui.owner, document: cad.document, activeDocumentId: cad.document.id, bodies: cad.context.bodies, sources };
  const resolved = resolveConstrainedAssembly(cad.document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Actual span CAD must resolve');
  const state = { ...ui.state, assembly: cad.document, activeDocumentId: cad.document.id,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: cad.document, bodies: owner.bodies,
      resolved: resolved.resolved, meshOwnership: owner } };
  const source = captureBeamSource(state);
  if (source === null) throw new Error('Exact current controlled publication required');
  const associations = { ...cad.associations, source: source.source };
  const definition = { ...cad.definition, source: source.source, weldLayers: associations };
  const occurrences = cad.document.components.map(component => ({ path: [component.id],
    partKey: partKeyOf(component.source), label: component.name }));
  const restored = restoreBeamSession(cad.document.id, definition, occurrences);
  const session = { ...restored, members: restored.members.map(member => ({ ...member, confirmed: true })) };
  return { state, source, session, definition, occurrences, associations };
}

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  readonly requests: Parameters<FemWorkerPort['postMessage']>[0][] = [];
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.requests.push(request); }
  terminate(): void { this.terminated++; }
}
let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

describe('dedicated saved /2 weld span session and owned dispatch', () => {
  it.each([false, true])('roundtrips explicit /2 and all side identities (mixed=%s), without history/result/trust', mixed => {
    const f = spanFixture(mixed), before = JSON.stringify(f.source.document);
    expect(f.session.weldLayers).toEqual([]);
    expect(f.session.weldSpanLayers).toEqual(f.associations);
    expect(f.session.reviewed).toBeNull();
    expect(f.session.result).toBeNull();
    const checked = beamDefinition(f.session, f.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Expected strict span definition');
    expect(checked.definition.weldLayers).toEqual(f.associations);
    expect(checked.definition.weldLayers?.schema).toBe('pointercad-cad-weld-layers/2');
    const saved = withBeamAnalysisInputs(f.source.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: checked.definition }] });
    const read = readBeamAnalysisInputs(saved.beamAnalysisInputs, saved.id);
    if (!read.ok || read.value.analyses[0]?.kind !== 'standard-members') throw new Error('Expected persisted span');
    const restored = restoreBeamSession(saved.id, read.value.analyses[0].definition, f.occurrences);
    const again = beamDefinition({ ...restored, members: restored.members.map(m => ({ ...m, confirmed: true })) }, f.source, []);
    expect(again).toEqual(checked);
    expect(restored.reviewed).toBeNull();
    expect(restored.result).toBeNull();
    expect(JSON.stringify(f.source.document)).toBe(before);
  });

  it('edits /2 independently, invalidates review and does not rewrite its source identity', () => {
    const f = spanFixture();
    const edited = editBeamSession({ ...f.session, reviewed: f.source }, { kind: 'weld-span-layers', value: {
      ...f.associations, welds: f.associations.welds.map(w => ({ ...w, youngMPa: 1200 })) } });
    expect(edited.reviewed).toBeNull();
    expect(edited.result).toBeNull();
    expect(edited.revision).toBe(f.session.revision + 1);
    expect(edited.weldLayers).toEqual([]);
    expect(edited.weldSpanLayers?.source).toEqual(f.source.source);
    const checked = beamDefinition(edited, f.source, []);
    expect(checked.ok).toBe(true);
    const stale = { ...edited, weldSpanLayers: { ...f.associations,
      analysisRevision: edited.revision, source: { ...f.associations.source, geometryRevision: 'other' } } };
    expect(beamDefinition(stale, f.source, [])).toMatchObject({ ok: false, key: 'beam.error.model' });
  });

  it('rejects simultaneous legacy/bolt/initial strain instead of dropping any inputs', () => {
    const f = spanFixture(), old = cadWeldLayerFixture(), joint = cadJointContactFixture();
    for (const session of [{ ...f.session, weldLayers: old.associations.welds },
      { ...f.session, axialBolts: joint.axialBolts.bolts },
      { ...f.session, initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const, shortenings: [] } }]) {
      const checked = beamDefinition(session, f.source, []);
      expect(checked.ok).toBe(false);
      if (checked.ok) throw new Error('Unsupported mixed inputs must be refused');
      expect(checked.diagnostic).toContain('weld-span-mixed');
    }
    const altered = { ...f.definition, weldLayers: { ...f.associations, unknown: 1 } };
    expect(() => restoreBeamSession(f.source.document.id, altered, f.occurrences)).toThrow('weld-span-input');
    expect(prepareBeamAnalysis(f.source, { ...f.definition, axialBolts: joint.axialBolts })).toMatchObject({ ok: false, issue: { code: 'weld-span-mixed' } });
  });

  it('strictly prepares the real CAD span with the independent 10mm/2mm/1mm dimensions', () => {
    const f = spanFixture(), checked = beamDefinition(f.session, f.source, []);
    if (!checked.ok) throw new Error('Definition required');
    const prepared = prepareBeamAnalysis(f.source, checked.definition);
    if (!prepared.ok || prepared.kind !== 'weld-span-contact') throw new Error('Dedicated span route required');
    expect(prepared.input.schema).toBe('pointercad-weld-span/1');
    expect(prepared.input.patches[0]).toMatchObject({ widthM: .01, lengthM: .002,
      thicknessM: .001, youngPa: 1e9 });
    expect(prepared.input.patches[0].first).toEqual({ kind: 'member-span', memberId: 'a-beam' });
    expect(prepared.input.patches[0].second).toEqual({ kind: 'member-span', memberId: 'b-beam' });
  });

  it.each(['cancel', 'supersede', 'wrong-source', 'dispose'] as const)('dispatches once through real client and drops late replies after %s', async mode => {
    const f = spanFixture(), ports: Port[] = [];
    const session = { ...f.session, reviewed: f.source };
    useAppStore.setState({ ...f.state, beamSession: session });
    attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    const runner = useAppStore.getState().beamRunner;
    if (runner === null) throw new Error('Actual attachment runner required');
    runner.run(session, f.source);
    await expect.poll(() => ports[0]?.requests.length ?? 0).toBe(1);
    const port = ports[0], request = port.requests[0], late = port.onmessage;
    if (request.kind !== 'analyze-beam-weld-span-contact' || late === null) throw new Error('Dedicated request required');
    expect(ports).toHaveLength(1);
    expect(requireBeamSession().status).toBe('running');
    if (mode === 'cancel') runner.cancel();
    if (mode === 'supersede') runner.run(session, f.source);
    if (mode === 'wrong-source') useAppStore.setState({ documentVersion: f.state.documentVersion + 1 });
    if (mode === 'dispose') attachment.dispose();
    const after = useAppStore.getState().beamSession;
    late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'phase', identity: request.identity, phase: 'solving' } }));
    late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'failure', identity: request.identity,
      failure: { code: 'worker-failed', message: 'controlled late failure, not a native solve' } } }));
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().beamSession).toBe(after);
    if (mode === 'dispose') expect(after).toBeNull();
    else {
      if (after === null) throw new Error('Live session must remain after cancellation');
      expect(after.result).toBeNull();
    }
    expect(port.terminated).toBe(1);
    expect(useAppStore.getState().assembly).toBe(f.source.document);
    if (mode === 'supersede') runner.cancel();
  });
});
