import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import type { FemWorkerPort } from '@pointercad/fem';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { beamDefinition, createBeamSession } from './beamSession.js';

/** Controlled transport only: cancellation and state transitions use the real store/client. */
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
afterEach(() => { attachment?.dispose(); attachment = null; vi.restoreAllMocks(); resetTestStore(); });

describe('saved native preload refuses unsupported beam UI without rewriting inputs', () => {
  it.each(['openBeam', 'reviewBeam', 'runBeam', 'applyBeamInputs'] as const)('%s preserves saved bytes/history and closes through the real runner', action => {
    const f = savedBoltFixture(), u = beamUiFixture();
    const saved = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'native-bolt-preload', definition: f.saved }] });
    const undo = createUndoStack({ document: saved, library: u.state.assemblyLibrary });
    useAppStore.setState({ ...u.state, assembly: saved, assemblyView: null, activeDocumentId: saved.id,
      assemblyUndoStack: undo, beamSession: createBeamSession(saved.id, f.saved.id), fileMessage: null });
    const createWorker = vi.fn(() => new Port());
    attachment = attachBeamAnalysis(useAppStore, createWorker);
    const runner = useAppStore.getState().beamRunner;
    if (runner === null) throw new Error('Real beam attachment did not install its runner');
    const cancel = vi.spyOn(runner, 'cancel'); // call-through: never replaces cancel or document edits.
    const before = useAppStore.getState(), bytes = JSON.stringify(before.assembly);
    useAppStore.getState()[action]();
    const after = useAppStore.getState();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(createWorker).not.toHaveBeenCalled();
    expect(after.beamSession).toBeNull();
    expect(after.assembly).toBe(saved);
    expect(JSON.stringify(after.assembly)).toBe(bytes);
    expect(after.assemblyUndoStack).toBe(undo);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.fileMessage).toMatchObject({ key: 'beam.error.model', failed: true });
    expect(after.fileMessage?.detail).toContain('まだ編集・実行できません');
    expect(after.fileMessage?.detail).toContain('保存内容は保持');
  });

  it('keeps the ordinary saved standard-member open path', () => {
    const u = beamUiFixture(), input = beamDefinition(u.session, u.source, []);
    if (!input.ok) throw new Error('Existing independent standard-member fixture is invalid');
    if (u.state.assembly === null) throw new Error('Assembly fixture required');
    const saved = withBeamAnalysisInputs(u.state.assembly, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'standard-members', definition: input.definition }] });
    useAppStore.setState({ ...u.state, assembly: saved, beamSession: null, fileMessage: null });
    useAppStore.getState().openBeam();
    const session = requireBeamSession();
    expect(session.analysisId).toBe(input.definition.id);
    expect(session.members).toHaveLength(1);
    expect(session.members[0].values.young).toBe('208000');
    expect(session.members[0].confirmed).toBe(false);
    expect(session.reviewed).toBeNull();
    expect(session.result).toBeNull();
    expect(useAppStore.getState().assembly).toBe(saved);
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('cancels an actual pending client on a real document edit, then refuses the saved preload', async () => {
    const u = beamUiFixture(), ports: Port[] = [];
    if (u.state.assembly === null) throw new Error('Assembly fixture required');
    const undo = createUndoStack({ document: u.state.assembly, library: u.state.assemblyLibrary });
    useAppStore.setState({ ...u.state, assemblyUndoStack: undo, beamSession: u.session });
    attachment = attachBeamAnalysis(useAppStore, () => { const p = new Port(); ports.push(p); return p; });
    useAppStore.getState().reviewBeam();
    expect(requireBeamSession().reviewed).not.toBeNull();
    useAppStore.getState().runBeam();
    await vi.waitFor(() => { expect(ports).toHaveLength(1); expect(ports[0].request).not.toBeNull(); });
    expect(ports[0].request?.kind).toBe('analyze-beam-3d');
    const f = savedBoltFixture(), source = { ...f.saved.source, documentId: u.state.assembly.id };
    const associations = f.saved.cadDefinition.axialBolts;
    if (associations === undefined) throw new Error('Saved fixture bolt association required');
    const definition = { ...f.saved, source,
      cadDefinition: { ...f.saved.cadDefinition, source, axialBolts: { ...associations, source } },
      input: { ...f.saved.input, source } };
    const edited = withBeamAnalysisInputs({ ...f.document, id: u.state.assembly.id }, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'native-bolt-preload', definition }] });
    // applyAssembly and the attachment's current-source subscriber are the actual product path.
    useAppStore.getState().applyAssembly(edited, u.state.assemblyLibrary);
    expect(ports[0].terminated).toBe(1);
    expect(attachment.statistics().live).toBe(0);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    const savedBytes = JSON.stringify(useAppStore.getState().assembly), afterEditUndo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().openBeam();
    expect(useAppStore.getState().beamSession).toBeNull();
    expect(useAppStore.getState().fileMessage?.failed).toBe(true);
    expect(JSON.stringify(useAppStore.getState().assembly)).toBe(savedBytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(afterEditUndo);
    expect(ports[0].terminated).toBe(1);
  });
});
