import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { cadWeldLayerFixture } from '../../../model/src/analysis/cadWeldLayer.testSupport.js';
import type { FemWorkerPort } from '@pointercad/fem';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { createBeamSession, restoreBeamSession } from './beamSession.js';
import { cadWeldSpanFixture } from '../../../model/src/analysis/cadWeldSpanLayer.testSupport.js';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  postMessage(): void { throw new Error('Unsupported saved span must not execute'); }
  terminate(): void { /* No worker is created in the refusal route. */ }
}
let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; vi.restoreAllMocks(); resetTestStore(); });

describe('saved weld span refuses unsupported legacy beam UI', () => {
  it('restores valid /2 through the dedicated session while preserving the out-of-scope store refusal', () => {
    const f = cadWeldSpanFixture();
    const session = restoreBeamSession(f.document.id, f.definition, []);
    expect(session.weldSpanLayers).toEqual(f.associations);
    expect(session.weldLayers).toEqual([]);
    expect(session.result).toBeNull();
    expect(session.reviewed).toBeNull();
    const corrupt = { ...f.definition, weldLayers: { ...f.associations, welds: f.associations.welds.map(w => ({
      ...w, first: { kind: 'member-span' as const, memberId: 'foreign-member' } })) } };
    expect(() => restoreBeamSession(f.document.id, corrupt, [])).toThrow('weld-span-input');
    expect(f.definition.weldLayers).toEqual(f.associations);
  });
  it.each(['openBeam', 'reviewBeam', 'runBeam', 'applyBeamInputs', 'editBeam'] as const)('%s preserves /2 bytes/history and cancels through the real runner', action => {
    const f = cadWeldLayerFixture(), u = beamUiFixture();
    const weldLayers = { ...f.associations, schema: 'pointercad-cad-weld-layers/2', welds: f.associations.welds.map(w => ({ ...w,
      first: { kind: 'section-node', ...w.first }, second: { kind: 'member-span', memberId: w.second.memberId } })) };
    const saved = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers } }] });
    const undo = createUndoStack({ document: saved, library: u.state.assemblyLibrary });
    useAppStore.setState({ ...u.state, assembly: saved, assemblyView: null, activeDocumentId: saved.id,
      assemblyUndoStack: undo, beamSession: createBeamSession(saved.id, f.definition.id), fileMessage: null });
    const createWorker = vi.fn(() => new Port());
    attachment = attachBeamAnalysis(useAppStore, createWorker);
    const runner = useAppStore.getState().beamRunner;
    if (runner === null) throw new Error('Real runner required');
    const cancel = vi.spyOn(runner, 'cancel');
    const before = useAppStore.getState(), bytes = JSON.stringify(before.assembly);
    expect(() => {
      if (action === 'editBeam') useAppStore.getState().editBeam({ kind: 'focus', field: null });
      else useAppStore.getState()[action]();
    }).not.toThrow();
    const after = useAppStore.getState();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(createWorker).not.toHaveBeenCalled();
    expect(after.beamSession).toBeNull();
    expect(after.assembly).toBe(saved);
    expect(JSON.stringify(after.assembly)).toBe(bytes);
    expect(after.assemblyUndoStack).toBe(undo);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.fileMessage).toMatchObject({ key: 'beam.error.model', failed: true });
    expect(after.fileMessage?.detail).toContain('長手溶接');
    expect(after.fileMessage?.detail).toContain('保存内容は保持');
  });

  it('opens the existing /1 weld association without replacing its saved input', () => {
    const f = cadWeldLayerFixture(), u = beamUiFixture();
    const saved = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers: f.associations } }] });
    useAppStore.setState({ ...u.state, assembly: saved, assemblyView: null, activeDocumentId: saved.id,
      beamSession: null, fileMessage: null });
    expect(() => useAppStore.getState().openBeam()).not.toThrow();
    expect(requireBeamSession().weldLayers).toEqual(f.associations.welds);
    expect(requireBeamSession().reviewed).toBeNull();
    expect(useAppStore.getState().assembly).toBe(saved);
    expect(useAppStore.getState().fileMessage).toBeNull();
  });
});
