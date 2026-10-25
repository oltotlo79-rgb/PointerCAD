import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack, createEmptyPartDocument, partKeyOf, resolveConstrainedAssembly, buildStandardPartFromSource } from '@pointercad/model';
import type { FemWorkerPort } from '@pointercad/fem';
import { cadJointContactFixture } from '../../../model/src/analysis/cadJointContact.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { beamDefinition, editBeamSession, restoreBeamSession } from './beamSession.js';
import { attachBeamAnalysis } from './attachBeamAnalysis.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

beforeEach(resetTestStore);

function fixture() {
  const ui = beamUiFixture(), cad = cadJointContactFixture();
  const document = cad.document;
  // Metadata-only publication fixture using the actual analytic CAD bodies.
  // Every body-map entry has its exact result/layout owner; this is not a bridge-issued receipt.
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [key, bodies] of cad.context.bodies) {
    const part = createEmptyPartDocument();
    const result = { ...resultFor(part), bodies, generation: ui.owner.generation };
    sources.set(key, { document: part, attachments: undefined, result, bodies,
      layouts: bodies.map(captureMeshBodyLayout), displayOwner: null, hiddenOwners: [], current: () => true });
  }
  const owner = { ...ui.owner, document, activeDocumentId: document.id, bodies: cad.context.bodies, sources };
  const resolved = resolveConstrainedAssembly(document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Actual CAD fixture did not resolve');
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, bodies: owner.bodies, resolved: resolved.resolved, meshOwnership: owner } };
  const source = captureBeamSource(state);
  if (source === null) throw new Error('Expected current owned publication');
  const definition = { ...cad.definition, source: source.source,
    initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const, shortenings: [{ boltId: 'mixed-shank', shorteningMm: .001,
      source: { kind: 'user-supplied' as const, reference: 'prescribed stress-free shortening', condition: 'small-strain elastic' } }] },
    axialBolts: { ...cad.axialBolts, source: source.source }, weldLayers: { ...cad.associations, source: source.source } };
  const restored = restoreBeamSession(document.id, definition, document.components.map(component => ({
    path: [component.id], partKey: partKeyOf(component.source), label: component.name })));
  const session = { ...restored, members: restored.members.map(member => ({ ...member, confirmed: true })) };
  return { state, source, session };
}

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}

describe('initial-strain current CAD ownership and saved state', () => {
  it('saves explicit shortening and provenance through Undo/Redo and reopens without results or review', () => {
    const f = fixture();
    useAppStore.setState({ ...f.state, beamSession: f.session,
      assemblyUndoStack: createUndoStack({ document: f.source.document, library: f.source.library }) });
    const attachment = attachBeamAnalysis(useAppStore, () => new Port());
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().applyBeamInputs();
      const saved = useAppStore.getState().assembly?.beamAnalysisInputs, row = saved?.analyses[0];
      if (row?.kind !== 'standard-members' || row.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing initial-strain saved input');
      expect(row.definition.initialStrain).toEqual(f.session.initialStrain);
      expect(row.definition.axialBolts?.bolts).toEqual(f.session.axialBolts);
      expect(row.definition.weldLayers?.welds).toEqual(f.session.weldLayers);
      useAppStore.getState().undoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toBeUndefined();
      useAppStore.getState().redoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toEqual(saved);
      useAppStore.getState().openBeam();
      expect(requireBeamSession().initialStrain).toEqual(f.session.initialStrain);
      expect(requireBeamSession().result).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
    } finally { attachment.dispose(); }
  });
  it.each(['shortening', 'bolt', 'weld', 'cancel', 'owner', 'geometry'] as const)(
    'cancels the same request and ignores captured late protocol-valid events after %s changes', async reason => {
    const f = fixture(), ports: Port[] = [];
    useAppStore.setState({ ...f.state, beamSession: f.session });
    const attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().runBeam();
      await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
      expect(ports).toHaveLength(1);
      const request = ports[0].request, late = ports[0].onmessage;
      if (request?.kind !== 'analyze-beam-joint-initial-strain' || late === null || f.session.initialStrain === null) throw new Error('Missing initial-strain request');
      expect(request.input.shortenings).toEqual([{ boltId: 'mixed-shank', shorteningM: .000001 }]);
      expect(request.input.joint.bolts.map(b => b.id)).toEqual(f.session.axialBolts.map(b => b.id));
      expect(request.input.joint.welds.map(w => w.id)).toEqual(f.session.weldLayers.map(w => w.id));
      if (reason === 'shortening') useAppStore.getState().editBeam({ kind: 'initial-strain', value: { ...f.session.initialStrain,
        shortenings: f.session.initialStrain.shortenings.map(row => ({ ...row, shorteningMm: .002 })) } });
      if (reason === 'bolt') useAppStore.getState().editBeam({ kind: 'axial-bolts', bolts: f.session.axialBolts.map(b => ({ ...b, effectiveAreaMm2: 12 })) });
      if (reason === 'weld') useAppStore.getState().editBeam({ kind: 'weld-layers', welds: f.session.weldLayers.map(w => ({ ...w, effectiveThroatMm: 1.5 })) });
      if (reason === 'cancel') useAppStore.getState().cancelBeam();
      if (reason === 'owner') useAppStore.setState({ activeDocumentId: 'another-document' });
      if (reason === 'geometry') useAppStore.setState({ documentVersion: f.state.documentVersion+1 });
      expect(attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
      const cancelled = useAppStore.getState().beamSession;
      late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'phase', identity: request.identity, phase: 'solving' } }));
      late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'failure', identity: request.identity,
        failure: { code: 'worker-failed', message: 'late initial-strain result' } } }));
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(cancelled);
      expect(cancelled?.result ?? null).toBeNull();
      if (reason !== 'cancel') expect(cancelled?.reviewed ?? null).toBeNull();
    } finally { attachment.dispose(); }
  });
  it('refuses invalid rest length without choosing the unstrained route, while explicit disabling restores that route', () => {
    const f = fixture(), draft = beamDefinition(f.session, f.source, []);
    if (!draft.ok || draft.definition.schema !== 'pointercad-standard-beam/5' || draft.definition.initialStrain === undefined) throw new Error('Missing initial strain');
    expect(prepareBeamAnalysis(f.source, { ...draft.definition, initialStrain: { ...draft.definition.initialStrain,
      shortenings: draft.definition.initialStrain.shortenings.map(row => ({ ...row, shorteningMm: 10 })) } }))
      .toMatchObject({ ok: false, issue: { code: 'initial-strain-input' } });
    expect(beamDefinition(editBeamSession(f.session, { kind: 'analysis-type', value: 'static' }), f.source, []).ok).toBe(false);
    const unstrained = beamDefinition(editBeamSession(f.session, { kind: 'initial-strain', value: null }), f.source, []);
    if (!unstrained.ok) throw new Error('Expected explicit unstrained input');
    expect(prepareBeamAnalysis(f.source, unstrained.definition)).toMatchObject({ ok: true, kind: 'joint-contact' });
  });
});

