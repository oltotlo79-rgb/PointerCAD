import { beforeEach, describe, expect, it, vi } from 'vitest';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { BeamWeldLayerDefinitions } from './BeamWeldLayers.js';
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

describe('one owned mixed joint request from current CAD and saved associations', () => {
  it('saves both explicit families through actual Undo/Redo and reopens without a derived result', () => {
    const f = fixture();
    useAppStore.setState({ ...f.state, beamSession: f.session,
      assemblyUndoStack: createUndoStack({ document: f.source.document, library: f.source.library }) });
    const attachment = attachBeamAnalysis(useAppStore, () => new Port());
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().applyBeamInputs();
      const saved = useAppStore.getState().assembly?.beamAnalysisInputs;
      const row = saved?.analyses[0];
      if (row?.kind !== 'standard-members' || row.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing mixed inputs');
      expect(row.definition.axialBolts?.bolts).toEqual(f.session.axialBolts);
      expect(row.definition.weldLayers?.welds).toEqual(f.session.weldLayers);
      useAppStore.getState().undoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toBeUndefined();
      useAppStore.getState().redoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toEqual(saved);
      useAppStore.getState().openBeam();
      expect(requireBeamSession().axialBolts).toEqual(f.session.axialBolts);
      expect(requireBeamSession().weldLayers).toEqual(f.session.weldLayers);
      expect(requireBeamSession().result).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
    } finally { attachment.dispose(); }
  });
  it('allows the rendered weld add action while a bolt exists and invalidates review once', () => {
    const f = fixture(), runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamSession: { ...f.session, reviewed: f.source }, beamRunner: runner });
    const spy = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    interface Props { readonly children?: ReactNode; readonly disabled?: boolean; readonly onClick?: () => void }
    const buttons: Props[] = [];
    function walk(node: ReactNode): void {
      Children.forEach(node, child => {
        if (!isValidElement<Props>(child)) return;
        if (child.type === 'button' && child.props.onClick !== undefined) buttons.push(child.props);
        walk(child.props.children);
      });
    }
    function Probe(): null { walk(BeamWeldLayerDefinitions({ session: requireBeamSession() })); return null; }
    try {
      renderToStaticMarkup(React.createElement(Probe));
      expect(buttons).toHaveLength(3);
      expect(buttons[2].disabled).toBe(false);
      buttons[2].onClick?.();
      expect(requireBeamSession().weldLayers).toHaveLength(3);
      expect(requireBeamSession().axialBolts).toEqual(f.session.axialBolts);
      expect(requireBeamSession().reviewed).toBeNull();
      expect(runner.cancel).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
  it.each(['bolt', 'weld', 'cancel', 'owner', 'geometry'] as const)(
    'dispatches both families once and drops protocol-valid late events after %s invalidation', async reason => {
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
      if (request?.kind !== 'analyze-beam-joint-contact' || late === null) throw new Error('Missing mixed request');
      expect(request.input.bolts.map(b => b.id)).toEqual(f.session.axialBolts.map(b => b.id));
      expect(request.input.welds.map(w => w.id)).toEqual(f.session.weldLayers.map(w => w.id));
      if (reason === 'bolt') useAppStore.getState().editBeam({ kind: 'axial-bolts',
        bolts: f.session.axialBolts.map(b => ({ ...b, effectiveAreaMm2: 12 })) });
      if (reason === 'weld') useAppStore.getState().editBeam({ kind: 'weld-layers',
        welds: f.session.weldLayers.map(w => ({ ...w, effectiveThroatMm: 1.5 })) });
      if (reason === 'cancel') useAppStore.getState().cancelBeam();
      if (reason === 'owner') useAppStore.setState({ activeDocumentId: 'another-document' });
      if (reason === 'geometry') useAppStore.setState({ documentVersion: f.state.documentVersion + 1 });
      expect(attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
      const cancelled = useAppStore.getState().beamSession;
      late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'phase', identity: request.identity, phase: 'solving' } }));
      late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'failure', identity: request.identity,
        failure: { code: 'worker-failed', message: 'late mixed response' } } }));
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(cancelled);
      expect(cancelled?.result ?? null).toBeNull();
      if (reason !== 'cancel') expect(cancelled?.reviewed ?? null).toBeNull();
    } finally { attachment.dispose(); }
  });
  it.each(['bolt', 'weld'] as const)('refuses a stale %s family without falling back to the other solver', family => {
    const f = fixture(), draft = beamDefinition(f.session, f.source, []);
    if (!draft.ok || draft.definition.schema !== 'pointercad-standard-beam/5'
      || draft.definition.axialBolts === undefined || draft.definition.weldLayers === undefined) throw new Error('Missing mixed definition');
    const changed = family === 'bolt'
      ? { ...draft.definition, axialBolts: { ...draft.definition.axialBolts, analysisRevision: 999 } }
      : { ...draft.definition, weldLayers: { ...draft.definition.weldLayers, analysisRevision: 999 } };
    expect(prepareBeamAnalysis(f.source, changed)).toMatchObject({ ok: false, issue: { code: 'joint-input' } });
    expect(beamDefinition(editBeamSession(f.session, { kind: 'analysis-type', value: 'static' }), f.source, []).ok).toBe(false);
  });
});

