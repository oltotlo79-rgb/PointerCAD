import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack, partKeyOf, resolveConstrainedAssembly, buildStandardPartFromSource } from '@pointercad/model';
import type { FemWorkerPort } from '@pointercad/fem';
import { cadAxialBoltFixture } from '../../../model/src/analysis/cadAxialBolt.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { beamDefinition, editBeamSession, restoreBeamSession } from './beamSession.js';
import { attachBeamAnalysis } from './attachBeamAnalysis.js';

beforeEach(resetTestStore);

function fixture() {
  const ui = beamUiFixture(), cad = cadAxialBoltFixture();
  const document = cad.document;
  const owner = { ...ui.owner, document, activeDocumentId: document.id };
  const resolved = resolveConstrainedAssembly(document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Actual CAD fixture did not resolve');
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, resolved: resolved.resolved, meshOwnership: owner } };
  const source = captureBeamSource(state);
  if (source === null) throw new Error('Expected current owned publication');
  const definition = { ...cad.definition, source: source.source,
    axialBolts: { ...cad.associations, source: source.source } };
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

describe('CAD axial bolt ownership in the real beam store and client attachment', () => {
  it('saves and restores exact associations through actual assembly Undo/Redo without false stale warning', () => {
    const f = fixture();
    useAppStore.setState({ ...f.state, beamSession: f.session,
      assemblyUndoStack: createUndoStack({ document: f.source.document, library: f.source.library }) });
    const attachment = attachBeamAnalysis(useAppStore, () => new Port());
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      expect(requireBeamSession().reviewed).not.toBeNull();
      useAppStore.getState().cancelBeam();
      useAppStore.getState().applyBeamInputs();
      const saved = useAppStore.getState().assembly;
      const input = saved?.beamAnalysisInputs?.analyses[0];
      if (input?.kind !== 'standard-members' || input.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing saved inputs');
      expect(input.definition.axialBolts?.bolts).toEqual(f.session.axialBolts);
      expect(requireBeamSession().errorKey).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
      useAppStore.getState().undoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toBeUndefined();
      useAppStore.getState().redoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toEqual(saved?.beamAnalysisInputs);
      useAppStore.getState().openBeam();
      expect(requireBeamSession().axialBolts).toEqual(f.session.axialBolts);
      expect(requireBeamSession().result).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
    } finally { attachment.dispose(); }
  });
  it.each(['edit', 'cancel', 'owner', 'geometry'] as const)(
    'dispatches the coupled request and releases ownership on %s', async reason => {
    const f = fixture(), ports: Port[] = [];
    useAppStore.setState({ ...f.state, beamSession: f.session });
    const attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().runBeam();
      await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
      const request = ports[0].request;
      if (request?.kind !== 'analyze-beam-bolt-contact') throw new Error('Expected the coupled request');
      expect(request.input.bolts[0].youngPa).toBe(1e9);
      expect(request.input.bolts[0].areaM2).toBeCloseTo(1e-5, 18);
      if (reason === 'edit') useAppStore.getState().editBeam({ kind: 'axial-bolts', bolts: [] });
      if (reason === 'cancel') useAppStore.getState().cancelBeam();
      if (reason === 'owner') useAppStore.setState({ activeDocumentId: 'other-document' });
      if (reason === 'geometry') useAppStore.setState({ documentVersion: f.state.documentVersion + 1 });
      expect(ports[0].terminated).toBe(1);
      expect(useAppStore.getState().beamSession?.result ?? null).toBeNull();
      if (reason !== 'cancel') expect(useAppStore.getState().beamSession?.reviewed ?? null).toBeNull();
      if (reason === 'geometry') expect(requireBeamSession().errorKey).toBe('beam.error.changed');
    } finally { attachment.dispose(); }
  });
  it('refuses silent uncoupled mode switching and endpoint reassignment after restore', () => {
    const f = fixture();
    expect(beamDefinition(editBeamSession(f.session, { kind: 'analysis-type', value: 'static' }), f.source, []).ok).toBe(false);
    const changed = editBeamSession(f.session, { kind: 'connection', id: 'a-beam', end: 'end', nodeId: 'replacement' });
    expect(beamDefinition(changed, f.source, []).ok).toBe(false);
  });
});
