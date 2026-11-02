import { beforeEach, describe, expect, it } from 'vitest';
import { createAssemblyDocument } from '@pointercad/model';
import { circularWeldFixture } from '../assembly/circularWeld.testSupport.js';
import { startJoint, startMate } from '../assembly/mateActions.js';
import { circularWeldContext } from './circularWeldActions.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';
import type { AssemblyView } from './assemblySlice.js';

beforeEach(resetTestStore);

async function ready(deep = false) {
  const f = await circularWeldFixture(deep), document = f.context.inputs.document, library = f.context.inputs.library;
  useAppStore.getState().openAssembly(document, library);
  const view: AssemblyView = { sourceDocument: document, source: f.context.inputs, resolved: f.context.view.resolved,
    bodies: f.bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
  useAppStore.setState({ assemblyView: view });
  expect(useAppStore.getState().beginCircularWeld()).toBe(true);
  useAppStore.getState().updateCircularWeldDraft({ radialLeg: '3', normalLeg: '4', radialDirection: 1,
    normalDirection: 1, materialId: 'stainless', mode: 'intermittent', lengths: '10,10', gaps: '5' });
  for (const pick of [f.choices.plane, f.choices.edge, f.choices.cylinder]) expect(useAppStore.getState().pickCircularWeldTarget(pick)).toBe(true);
  const state = useAppStore.getState(), draft = state.assemblyCircularWeldDraft, preview = state.assemblyCircularWeldPreview;
  if (draft === null || preview === null || !preview.ok) throw new Error('Current physical fixture must produce a ready preview');
  return { ...f, document, library, view, draft, preview };
}

describe('circular weld authoring integration', () => {
  it.each([false, true])('creates all beads in one Undo step for nested=%s, then restores them together', async deep => {
    const f = await ready(deep), before = useAppStore.getState();
    expect(before.commitCircularWeld(f.draft, f.preview)).toBe(true);
    const after = useAppStore.getState();
    expect(after.assembly?.components).toHaveLength(f.document.components.length + 2);
    expect(after.assemblyUndoStack?.past).toHaveLength((before.assemblyUndoStack?.past.length ?? 0) + 1);
    expect(after.assemblyCircularWeldDraft).toBeNull();
    after.undoAssembly();
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyCircularWeldPreview).toBeNull();
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assembly).toBe(after.assembly);
  });

  it('adapts only the actual solved source object, refusing same-ID stale document and library', async () => {
    const f = await ready();
    expect(circularWeldContext(f.document, f.library, f.view)?.inputs).toBe(f.view.source);
    expect(circularWeldContext({ ...f.document }, f.library, f.view)).toBeNull();
    expect(circularWeldContext(f.document, { ...f.library }, f.view)).toBeNull();
    expect(circularWeldContext(f.document, f.library, { ...f.view, source: undefined })).toBeNull();
  });

  it.each(['view', 'library', 'cancel', 'generation', 'session', 'draft'] as const)('rejects a preview after %s changes, preserving document and history', async change => {
    const f = await ready(), before = useAppStore.getState();
    if (change === 'view') useAppStore.setState({ assemblyView: { ...f.view } });
    if (change === 'library') useAppStore.setState({ assemblyLibrary: { ...f.library } });
    if (change === 'cancel') useAppStore.setState({ cancelRequestCount: before.cancelRequestCount + 1 });
    if (change === 'generation') useAppStore.setState({ requestedGeneration: before.requestedGeneration + 1 });
    if (change === 'session') useAppStore.setState({ activeDocumentId: before.activeDocumentId + '-next' });
    if (change === 'draft') useAppStore.getState().updateCircularWeldDraft({ normalLeg: '5' });
    expect(useAppStore.getState().commitCircularWeld(f.draft, f.preview)).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('keeps typed values on reselection and makes cancel a document-free operation', async () => {
    const f = await ready(), before = useAppStore.getState();
    before.reselectCircularWeld();
    const draft = useAppStore.getState().assemblyCircularWeldDraft;
    expect(draft?.picks).toEqual([]);
    expect(draft?.radialLeg).toBe('3'); expect(draft?.lengths).toBe('10,10');
    expect(draft?.draftEpoch).not.toBe(f.draft.draftEpoch);
    expect(useAppStore.getState().commitCircularWeld(f.draft, f.preview)).toBe(false);
    useAppStore.getState().cancelCircularWeld();
    expect(useAppStore.getState().assemblyCircularWeldDraft).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('opens an authored circular bead through the weld command, requiring current reselection', async () => {
    const f = await ready();
    expect(useAppStore.getState().commitCircularWeld(f.draft, f.preview)).toBe(true);
    const document = useAppStore.getState().assembly;
    const bead = document?.components.find(component => component.source.kind === 'standardPart' && component.source.options.weldCircular !== undefined);
    if (bead === undefined) throw new Error('Created bead missing');
    useAppStore.getState().setSelection([bead.id]);
    expect(useAppStore.getState().beginFilletWeld()).toBe(true);
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    expect(useAppStore.getState().assemblyCircularWeldDraft?.operation).toBe('replace');
    expect(useAppStore.getState().assemblyCircularWeldDraft?.picks).toEqual([]);
    expect(useAppStore.getState().assemblyCircularWeldPreview).toBeNull();
  });

  it.each(['undo', 'redo', 'open', 'close', 'straight', 'mate', 'joint', 'mate-face', 'joint-face', 'bolt'] as const)('clears authoring when %s changes its lifetime', async action => {
    const f = await ready(), state = useAppStore.getState();
    if (action === 'undo') state.undoAssembly();
    if (action === 'redo') state.redoAssembly();
    if (action === 'open') state.openAssembly({ ...createAssemblyDocument('Reopened circular weld'), id: f.document.id });
    if (action === 'close') state.closeAssembly();
    if (action === 'straight') expect(state.beginFilletWeld()).toBe(true);
    if (action === 'mate') startMate('coincident');
    if (action === 'joint') startJoint('revolute');
    if (action === 'mate-face' || action === 'joint-face') useAppStore.setState({ selectionKind: 'face' });
    if (action === 'mate-face') startMate('coincident');
    if (action === 'joint-face') startJoint('revolute');
    if (action === 'bolt') expect(state.beginBoltedJoint()).toBe(true);
    expect(useAppStore.getState().assemblyCircularWeldDraft).toBeNull();
    expect(useAppStore.getState().assemblyCircularWeldPreview).toBeNull();
  });
});
