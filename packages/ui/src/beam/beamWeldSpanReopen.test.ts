import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, createUndoStack, resolveConstrainedAssembly, buildStandardPartFromSource } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import type { FemWorkerPort } from '@pointercad/fem';
import { cadWeldSpanFixture } from '../../../model/src/analysis/cadWeldSpanLayer.testSupport.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { beamDefinition } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
/** Real CAD planner/adapter, controlled publication metadata. No native mesh/solver is claimed. */
function savedFixture() {
  const ui = beamUiFixture(), cad = cadWeldSpanFixture();
  const stamp = { documentId: cad.document.id, documentRevision: ui.state.documentVersion,
    geometryRevision: `${cad.document.id}:${ui.state.completedGeneration}` };
  const definition = { ...cad.definition, source: stamp, weldLayers: { ...cad.associations, source: stamp } };
  const document = withBeamAnalysisInputs(cad.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition }] });
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [key, bodies] of cad.context.bodies) {
    const part = createEmptyPartDocument(), result = { ...resultFor(part), bodies, generation: ui.owner.generation };
    sources.set(key, { document: part, attachments: undefined, result, bodies,
      layouts: bodies.map(captureMeshBodyLayout), displayOwner: null, hiddenOwners: [], current: () => true });
  }
  const owner = { ...ui.owner, document, activeDocumentId: document.id, bodies: cad.context.bodies, sources };
  const resolved = resolveConstrainedAssembly(document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Real CAD placement required');
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id, beamSession: null,
    assemblyUndoStack: createUndoStack({ document, library: ui.state.assemblyLibrary }),
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, bodies: owner.bodies,
      resolved: resolved.resolved, meshOwnership: owner } };
  if (captureBeamSource(state) === null) throw new Error('Controlled current publication required');
  return { state, document, definition };
}


/** Simulate only publication metadata, using the new real document/version/opening and actual resolver.
 * No saved source, input, part, body or placement pin is replaced. No native calculation is claimed. */
function publishCurrent(f: ReturnType<typeof savedFixture>): void {
  const state = useAppStore.getState(), document = state.assembly, template = f.state.assemblyView;
  if (document === null || template === null || template.meshOwnership === undefined) throw new Error('Publication fixture required');
  const generation = state.completedGeneration + 1;
  const resolved = resolveConstrainedAssembly(document, template.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok) throw new Error('Real current CAD resolution required');
  const owner = { ...template.meshOwnership, document, library: state.assemblyLibrary,
    activeDocumentId: state.activeDocumentId, documentVersion: state.documentVersion,
    generation, cancelRequestCount: state.cancelRequestCount };
  useAppStore.setState({ isComputing: false, lastOutcome: 'success', requestedGeneration: generation, completedGeneration: generation,
    assemblyView: { ...template, sourceDocument: document, resolved: resolved.resolved, meshOwnership: owner } });
  expect(captureBeamSource(useAppStore.getState())).not.toBeNull();
}
function confirmMembers(): void {
  for (const m of requireBeamSession().members) useAppStore.getState().editBeam({ kind: 'confirmed', id: m.id, confirmed: true });
}
function saveAndPublish() {
  const f = savedFixture(); useAppStore.setState(f.state); useAppStore.getState().openBeam();
  confirmMembers(); useAppStore.getState().reviewBeam();
  expect(requireBeamSession().reviewed).not.toBeNull();
  const before = useAppStore.getState(); useAppStore.getState().applyBeamInputs();
  // applyAssembly changes the document reference/history, not documentVersion. Recompute changes generation.
  expect(useAppStore.getState().assembly).not.toBe(before.assembly);
  expect(useAppStore.getState().documentVersion).toBe(before.documentVersion);
  expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength((before.assemblyUndoStack?.past.length ?? 0) + 1);
  publishCurrent(f);
  return f;
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
afterEach(() => { attachment?.dispose(); attachment = null; vi.restoreAllMocks(); resetTestStore(); });

describe('saved span explicit reassociation after actual assembly history edit', () => {
  it.each([false, true])('opens an untrusted saved draft after save/publication (separate opening=%s)', separate => {
    const f = saveAndPublish();
    if (separate) {
      const s = useAppStore.getState();
      if (s.assembly === null) throw new Error('Saved document required');
      useAppStore.getState().openAssembly(s.assembly, s.assemblyLibrary);
      useAppStore.setState({ strengthSession: f.state.strengthSession });
      publishCurrent(f);
    }
    useAppStore.getState().closeBeam();
    const before = useAppStore.getState(), bytes = JSON.stringify(before.assembly), undo = before.assemblyUndoStack;
    const runner = { run: vi.fn(), cancel: vi.fn() }; useAppStore.getState().setBeamRunner(runner);
    useAppStore.getState().openBeam();
    const draft = requireBeamSession();
    expect(draft.reviewed).toBeNull(); expect(draft.result).toBeNull();
    expect(draft.members.every(m => !m.confirmed)).toBe(true);
    expect(draft.weldSpanLayers?.source).not.toEqual(captureBeamSource(useAppStore.getState())?.source);
    useAppStore.getState().runBeam(); expect(runner.run).not.toHaveBeenCalled();
    confirmMembers(); useAppStore.getState().reviewBeam();
    const reviewed = requireBeamSession(); expect(reviewed.reviewed).not.toBeNull();
    if (reviewed.reviewed === null) throw new Error('Strict explicit review required');
    const d = beamDefinition(reviewed, reviewed.reviewed, []);
    if (!d.ok) throw new Error('Definition required');
    expect(prepareBeamAnalysis(reviewed.reviewed, d.definition)).toMatchObject({ ok: true, kind: 'weld-span-contact' });
    expect(JSON.stringify(useAppStore.getState().assembly)).toBe(bytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
    useAppStore.getState().runBeam(); expect(runner.run).toHaveBeenCalledWith(reviewed, reviewed.reviewed);
    useAppStore.getState().applyBeamInputs();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength((undo?.past.length ?? 0) + 1);
  });

  it.each(['part', 'pose', 'material', 'missing', 'document', 'owner'] as const)('never reviews a changed %s association', mode => {
    const f = saveAndPublish(); useAppStore.getState().closeBeam();
    const s = useAppStore.getState(), d = s.assembly;
    if (d === null) throw new Error('Saved assembly required');
    const beadId = f.definition.weldLayers.welds[0].beadComponentId;
    const changed = mode === 'document' ? { ...d, id: 'foreign-document' } : { ...d,
      components: d.components.filter(c => mode !== 'missing' || c.id !== beadId).map(c => c.id !== beadId ? c
        : mode === 'material' ? { ...c, materialId: 'changed-material' }
        : mode === 'part' && c.source.kind === 'standardPart' ? { ...c, source: { ...c.source, size: '9x9' } }
        : mode === 'pose' ? { ...c, placement: { ...c.placement, rotation: [0, 0, 0, 1] as const,
          position: [{ ...c.placement.position[0], source: '100' }, c.placement.position[1], c.placement.position[2]] as const } } : c) };
    useAppStore.getState().applyAssembly(changed); publishCurrent(f);
    const before = useAppStore.getState(), bytes = JSON.stringify(before.assembly);
    useAppStore.getState().openBeam();
    if (useAppStore.getState().beamSession !== null) {
      confirmMembers();
      if (mode === 'owner') useAppStore.setState({ beamSession: { ...requireBeamSession(), ownerId: 'old-opening' } });
      useAppStore.getState().reviewBeam();
      expect(useAppStore.getState().beamSession?.reviewed ?? null).toBeNull();
    }
    expect(JSON.stringify(useAppStore.getState().assembly)).toBe(bytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('cancels the real client owner and discards a late phase/failure across another opening', async () => {
    const f = saveAndPublish(); useAppStore.getState().closeBeam(); useAppStore.getState().openBeam();
    confirmMembers(); useAppStore.getState().reviewBeam();
    const ports: Port[] = [];
    attachment = attachBeamAnalysis(useAppStore, () => { const p = new Port(); ports.push(p); return p; });
    useAppStore.getState().runBeam();
    await expect.poll(() => ports[0]?.requests.length ?? 0).toBe(1);
    const p = ports[0], request = p.requests[0], late = p.onmessage;
    if (late === null || request.kind !== 'analyze-beam-weld-span-contact') throw new Error('Dedicated actual client request required');
    const s = useAppStore.getState(); if (s.assembly === null) throw new Error('Saved assembly required');
    useAppStore.getState().openAssembly(s.assembly, s.assemblyLibrary);
    useAppStore.setState({ strengthSession: f.state.strengthSession }); publishCurrent(f);
    useAppStore.getState().openBeam(); const next = requireBeamSession();
    late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'phase', identity: request.identity, phase: 'solving' } }));
    late(new MessageEvent('message', { data: { protocol: request.protocol, kind: 'failure', identity: request.identity,
      failure: { code: 'worker-failed', message: 'late controlled reply' } } }));
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().beamSession).toBe(next); expect(next.reviewed).toBeNull(); expect(next.result).toBeNull();
    expect(p.terminated).toBe(1);
  });
});
