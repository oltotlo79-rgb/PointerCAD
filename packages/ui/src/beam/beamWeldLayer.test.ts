import { cadJointContactFixture } from '../../../model/src/analysis/cadJointContact.testSupport.js';
import { prepareCombinedWeldStressInput } from './BeamWeldThroatStressResults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createUndoStack, createEmptyPartDocument, partKeyOf, resolveConstrainedAssembly, buildStandardPartFromSource } from '@pointercad/model';
import type { FemWorkerPort } from '@pointercad/fem';
import { cadWeldLayerFixture } from '../../../model/src/analysis/cadWeldLayer.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { beamDefinition, editBeamSession, restoreBeamSession } from './beamSession.js';
import { attachBeamAnalysis } from './attachBeamAnalysis.js';
import { BeamWeldLayerDefinitions } from './BeamWeldLayers.js';
import { prepareWeldStressInput } from './BeamWeldThroatStressResults.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';
import { selectWeldGroup, updateWeldGroup } from './weldGroupAssociations.js';

beforeEach(resetTestStore);

function fixture(segments?: readonly { readonly start: number; readonly length: number }[], mode: 'weld' | 'joint' | 'initial' = 'weld') {
  const ui = beamUiFixture(), cad = mode === 'weld' ? { ...cadWeldLayerFixture(segments), axialBolts: undefined } : cadJointContactFixture();
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
    weldLayers: { ...cad.associations, source: source.source },
    ...(cad.axialBolts === undefined ? {} : { axialBolts: { ...cad.axialBolts, source: source.source } }),
    ...(mode === 'initial' ? { initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const,
      shortenings: [{ boltId: 'mixed-shank', shorteningMm: .001, source: { kind: 'user-supplied' as const,
        reference: 'prescribed stress-free shortening', condition: 'small-strain elastic' } }] } } : {}) };
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

describe('CAD effective weld layer ownership in the real beam store and client attachment', () => {
  it('associates the whole rendered group and edits shared assumptions with one cancellation', () => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamSession: { ...f.session, weldLayers: f.session.weldLayers.slice(0, 1), reviewed: f.source }, beamRunner: runner });
    const spy = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    interface Props { readonly children?: ReactNode; readonly value?: string | number;
      readonly onChange?: (event: { readonly target: { readonly value: string } }) => void }
    const handlers: NonNullable<Props['onChange']>[] = [];
    let type = 'select', value: string | number = f.session.weldLayers[0].beadComponentId;
    function walk(node: ReactNode): void {
      Children.forEach(node, child => {
        if (!isValidElement<Props>(child)) return;
        if (child.type === type && child.props.value === value && child.props.onChange !== undefined) handlers.push(child.props.onChange);
        walk(child.props.children);
      });
    }
    function Probe(): null { walk(BeamWeldLayerDefinitions({ session: requireBeamSession() })); return null; }
    try {
      renderToStaticMarkup(React.createElement(Probe));
      expect(handlers).toHaveLength(1);
      handlers[0]({ target: { value: String(value) } });
      expect(requireBeamSession().weldLayers.map(w => w.beadComponentId)).toEqual(f.session.weldLayers.map(w => w.beadComponentId));
      expect(requireBeamSession().weldLayers[0].id).toBe(f.session.weldLayers[0].id);
      expect(runner.cancel).toHaveBeenCalledOnce();
      expect(requireBeamSession().reviewed).toBeNull();
      handlers.length = 0; type = 'input'; value = 2;
      renderToStaticMarkup(React.createElement(Probe));
      expect(handlers).toHaveLength(2);
      handlers[0]({ target: { value: '1.5' } });
      expect(requireBeamSession().weldLayers.map(w => w.effectiveThroatMm)).toEqual([1.5, 1.5]);
      expect(runner.cancel).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it('keeps interval IDs when selecting an already associated group and isolates blank draft rows', () => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const rows = f.session.weldLayers;
    const selected = selectWeldGroup(f.source.document, rows, rows[0].id, rows[1].beadComponentId, () => 'unused');
    expect(selected?.map(w => [w.id, w.beadComponentId])).toEqual(rows.map(w => [w.id, w.beadComponentId]));
    const blanks = rows.map(w => ({ ...w, beadComponentId: '' }));
    expect(updateWeldGroup(f.source.document, blanks, blanks[0].id, w => ({ ...w, effectiveThroatMm: 1 }))
      .map(w => w.effectiveThroatMm)).toEqual([1, 2]);
  });
  it('removes a complete group with one rendered action without leaving a partial association', () => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamSession: f.session, beamRunner: runner });
    const spy = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    interface Props { readonly children?: ReactNode; readonly onClick?: () => void }
    const handlers: NonNullable<Props['onClick']>[] = [];
    function walk(node: ReactNode): void {
      Children.forEach(node, child => {
        if (!isValidElement<Props>(child)) return;
        if (child.type === 'button' && child.props.onClick !== undefined) handlers.push(child.props.onClick);
        walk(child.props.children);
      });
    }
    function Probe(): null { walk(BeamWeldLayerDefinitions({ session: requireBeamSession() })); return null; }
    try {
      renderToStaticMarkup(React.createElement(Probe));
      expect(handlers).toHaveLength(3); // One remove action per interval and one add action.
      handlers[0]();
      expect(requireBeamSession().weldLayers).toEqual([]);
      expect(runner.cancel).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
  it('refuses a complete group beyond the existing 64 interval limit without truncating it', () => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const selected = f.session.weldLayers[0];
    const drafts = Array.from({ length: 63 }, (_, index) => ({ ...selected, id: 'draft-'+index, beadComponentId: '' }));
    expect(selectWeldGroup(f.source.document, [selected, ...drafts], selected.id,
      selected.beadComponentId, () => 'second-interval')).toBeNull();
    const allowed = selectWeldGroup(f.source.document, [selected, ...drafts.slice(0, 62)], selected.id,
      selected.beadComponentId, () => 'second-interval');
    expect(allowed).toHaveLength(64);
    expect(allowed?.filter(w => w.beadComponentId !== '').map(w => w.beadComponentId))
      .toEqual(f.session.weldLayers.map(w => w.beadComponentId));
  });
  it('saves all intervals through actual assembly Undo/Redo and restores the explicit gap associations', () => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    useAppStore.setState({ ...f.state, beamSession: f.session,
      assemblyUndoStack: createUndoStack({ document: f.source.document, library: f.source.library }) });
    const attachment = attachBeamAnalysis(useAppStore, () => new Port());
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().applyBeamInputs();
      const saved = useAppStore.getState().assembly?.beamAnalysisInputs;
      const input = saved?.analyses[0];
      if (input?.kind !== 'standard-members' || input.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing multi inputs');
      expect(input.definition.weldLayers?.welds).toEqual(f.session.weldLayers);
      useAppStore.getState().undoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toBeUndefined();
      useAppStore.getState().redoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toEqual(saved);
      useAppStore.getState().openBeam();
      expect(requireBeamSession().weldLayers).toEqual(f.session.weldLayers);
      expect(requireBeamSession().result).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
    } finally { attachment.dispose(); }
  });
  it.each(['second-interval', 'partial-group', 'owner', 'geometry'] as const)(
    'invalidates the complete multi-interval request on %s and drops its late reply', async reason => {
    const f = fixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]), ports: Port[] = [];
    useAppStore.setState({ ...f.state, beamSession: f.session });
    const attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    try {
      useAppStore.getState().reviewBeam();
      expect(requireBeamSession().errorKey).toBeNull();
      useAppStore.getState().runBeam();
      await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
      const request = ports[0].request, lateReply = ports[0].onmessage;
      if (request?.kind !== 'analyze-beam-weld-contact' || lateReply === null) throw new Error('Expected owned multi request');
      expect(request.input.welds.map(w => w.id)).toEqual(f.session.weldLayers.map(w => w.id));
      expect(request.input.welds.map(w => w.widthM)).toEqual([.005, .005]);
      expect(request.input.welds[1].centerM[0] - request.input.welds[0].centerM[0]).toBeCloseTo(.02, 12);
      if (reason === 'second-interval') useAppStore.getState().editBeam({ kind: 'weld-layers',
        welds: updateWeldGroup(f.source.document, f.session.weldLayers, f.session.weldLayers[1].id,
          row => ({ ...row, effectiveThroatMm: 1.5 })) });
      if (reason === 'partial-group') useAppStore.getState().editBeam({ kind: 'weld-layers', welds: f.session.weldLayers.slice(0, 1) });
      if (reason === 'owner') useAppStore.setState({ activeDocumentId: 'other-document' });
      if (reason === 'geometry') useAppStore.setState({ documentVersion: f.state.documentVersion + 1 });
      expect(ports[0].terminated).toBe(1);
      expect(attachment.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
      const invalidated = useAppStore.getState().beamSession;
      lateReply(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'phase', identity: request.identity, phase: 'solving' } }));
      lateReply(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'failure', identity: request.identity,
        failure: { code: 'worker-failed', message: 'late reply from cancelled multi request' } } }));
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(invalidated);
      expect(invalidated?.result ?? null).toBeNull();
      expect(invalidated?.reviewed ?? null).toBeNull();
      if (reason === 'partial-group') {
        useAppStore.getState().reviewBeam();
        expect(requireBeamSession().reviewed).toBeNull();
        expect(requireBeamSession().errorKey).not.toBeNull();
      }
    } finally { attachment.dispose(); }
  });
  it('routes the rendered throat field through cancellation and refuses an empty physical assumption', () => {
    const f = fixture(), runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamSession: { ...f.session, reviewed: f.source }, beamRunner: runner });
    const spy = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    interface Props { readonly children?: ReactNode; readonly value?: string | number;
      readonly onChange?: (event: { readonly target: { readonly value: string } }) => void }
    try {
      const handlers: NonNullable<Props['onChange']>[] = [];
      function walk(node: ReactNode): void {
        Children.forEach(node, child => {
          if (!isValidElement<Props>(child)) return;
          if (child.type === 'input' && child.props.value === 2 && child.props.onChange !== undefined) handlers.push(child.props.onChange);
          walk(child.props.children);
        });
      }
      function Probe(): null { walk(BeamWeldLayerDefinitions({ session: requireBeamSession() })); return null; }
      renderToStaticMarkup(React.createElement(Probe));
      expect(handlers).toHaveLength(1);
      handlers[0]({ target: { value: '' } });
      expect(Number.isNaN(requireBeamSession().weldLayers[0].effectiveThroatMm)).toBe(true);
      expect(requireBeamSession().reviewed).toBeNull();
      expect(runner.cancel).toHaveBeenCalledOnce();
      expect(beamDefinition(requireBeamSession(), f.source, []).ok).toBe(false);
    } finally { spy.mockRestore(); }
  });
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
      expect(input.definition.weldLayers?.welds).toEqual(f.session.weldLayers);
      expect(requireBeamSession().errorKey).toBeNull();
      expect(requireBeamSession().reviewed).toBeNull();
      useAppStore.getState().undoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toBeUndefined();
      useAppStore.getState().redoAssembly();
      expect(useAppStore.getState().assembly?.beamAnalysisInputs).toEqual(saved?.beamAnalysisInputs);
      useAppStore.getState().openBeam();
      expect(requireBeamSession().weldLayers).toEqual(f.session.weldLayers);
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
      if (request?.kind !== 'analyze-beam-weld-contact') throw new Error('Expected the coupled request');
      expect(request.input.welds[0].youngPa).toBe(1e9);
      expect(request.input.welds[0].widthM).toBeCloseTo(.01, 18);
      if (reason === 'edit') useAppStore.getState().editBeam({ kind: 'weld-layers', welds: [] });
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
    const changed = editBeamSession(f.session, { kind: 'connection', id: 'a-beam', end: 'start', nodeId: 'replacement' });
    expect(beamDefinition(changed, f.source, []).ok).toBe(false);
  });
});

describe('weld stress display preparation on the current CAD ownership route', () => {
  it('reconstructs the weld-only input using the same reviewed source and draft as execution', () => {
    const f = fixture(), session = { ...f.session, reviewed: f.source };
    const draft = beamDefinition(session, f.source, f.source.document.parameters);
    if (!draft.ok) throw new Error('Actual restored weld draft refused');
    const prepared = prepareBeamAnalysis(f.source, draft.definition);
    if (!prepared.ok || prepared.kind !== 'weld-contact') throw new Error('Actual CAD weld preparation refused');
    expect(prepareWeldStressInput(session)).toEqual(prepared.input);
    expect(prepareWeldStressInput({ ...session, reviewed: null })).toBeNull();
  });
  it('does not reinterpret a changed/invalid draft as the old weld input', () => {
    const f = fixture(), session = { ...f.session, reviewed: f.source };
    const changed = editBeamSession(session, { kind: 'weld-layers', welds: [{ ...session.weldLayers[0], effectiveThroatMm: NaN }] });
    expect(prepareWeldStressInput(changed)).toBeNull();
  });
});

describe('current CAD preparation keeps the three real stress input variants', () => {
  it.each(['weld', 'joint', 'initial'] as const)('prepares %s without rewriting any protocol kind or input', mode => {
    const f = fixture(undefined, mode), session = { ...f.session, reviewed: f.source };
    const draft = beamDefinition(session, f.source, f.source.document.parameters);
    if (!draft.ok) throw new Error('Current combined CAD draft refused');
    const prepared = prepareBeamAnalysis(f.source, draft.definition);
    if (!prepared.ok) throw new Error('Current combined CAD preparation refused');
    expect(prepared.kind).toBe(mode === 'weld' ? 'weld-contact' : mode === 'joint' ? 'joint-contact' : 'joint-initial-strain');
    expect(prepareCombinedWeldStressInput(session)).toEqual(prepared);
    expect(prepareCombinedWeldStressInput({ ...session, reviewed: null })).toBeNull();
    const changed = editBeamSession(session, { kind: 'weld-layers', welds: [{ ...session.weldLayers[0], effectiveThroatMm: NaN }] });
    expect(prepareCombinedWeldStressInput(changed)).toBeNull();
  });
});
