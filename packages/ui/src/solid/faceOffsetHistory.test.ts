import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextSolidId, nextSolidName, recomputePart, resolvePart,
  type PartDocument, type PartRecomputeResult } from '@pointercad/model';
import { createInspectableNativeKernelForNodeTests, initializeNativeKernelForNodeTests }
  from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { buildEx18DirectSeed, withEx18UnselectedBody } from '../../../model/src/part/ex18RouteBuildersDirect.js';
import { compareEx18Shape } from '../../../model/src/part/ex18ShapeOracle.js';
import { applyNumericTransition, applySolidCommit } from '../sketch/commitToStore.js';
import { commitNumericInput, createNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createBrowserFileGateway } from '../file/fileGateway.js';
import { runSolidTool } from '../shell/menus/solidToolActions.js';
import { solidToolReadiness } from './solidCommands.js';
import { subShapeElementId } from './subShapeSelection.js';
import { consumedIds } from './solidHistoryState.js';
import { documentSha, shapeSha } from './holeThreadHistory.testSupport.js';

const TIMEOUT = 180_000;
beforeAll(initializeNativeKernelForNodeTests, TIMEOUT);
beforeEach(resetTestStore);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function harness() {
  const native = await createInspectableNativeKernelForNodeTests();
  const bridge = native.bridge;
  const dispose = vi.spyOn(bridge, 'dispose');
  const seed = withEx18UnselectedBody(await buildEx18DirectSeed('A', bridge));
  useAppStore.getState().applyDocument(seed.part);
  const write = vi.fn(() => Promise.resolve());
  const gateway = createBrowserFileGateway({ showSaveFilePicker: () => Promise.resolve({ name: 'offset.pcad',
    createWritable: () => Promise.resolve({ write, close: () => Promise.resolve() }) }) });
  await gateway.savePcad('offset.pcad', new Uint8Array(), true);
  write.mockClear();
  useAppStore.getState().setFileGateway(gateway);
  useAppStore.getState().setFileState('offset.pcad', useAppStore.getState().document);
  let hold = false;
  const computed: PartRecomputeResult[] = [];
  const pending: { result: Promise<PartRecomputeResult>; release: () => Promise<void> }[] = [];
  const detach = attachPartRecompute((document, options) => {
    const delayed = hold; hold = false;
    const result = recomputePart(document, bridge, delayed ? { ...options, shouldCancel: () => false } : options)
      .then(value => { computed.push(value); return value; });
    if (!delayed) return result;
    return new Promise<PartRecomputeResult>(resolve => {
      pending.push({ result, release: async () => { resolve(await result); } });
    });
  });
  async function settled() {
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.isComputing).toBe(false);
      expect(state.lastOutcome).toBe('success');
      expect(state.completedGeneration).toBe(state.requestedGeneration);
    }, { timeout: 90_000, interval: 20 });
  }
  await settled();
  const source = useAppStore.getState().bodies.find(body => body.featureId === seed.targetId);
  const face = source?.faces.find(item => item.surfaceKind === 'plane' && item.axis !== null
    && item.axis[0] > 0.99 && Math.abs(item.centroid[0] - 40) < 1e-6);
  if (face === undefined) throw new Error('Missing native end face');
  const faceIndex = face.index;
  function cached(document: PartDocument, id: string) {
    const step = resolvePart(document).steps.find(item => item.featureId === id);
    if (step === undefined) throw new Error(`Missing cached shape ${id}`);
    return native.inspectShape(step.key);
  }
  const borrowed = [seed.targetId, 'direct-unselected'].map(id => {
    const value = cached(useAppStore.getState().document, id);
    return { value, bytes: sha(value.readBrepBytes()),
      ownerDelete: vi.spyOn(value.owner, 'delete'), shapeDelete: vi.spyOn(value.handle, 'delete') };
  });
  function untouched() {
    for (const item of borrowed) {
      expect(item.ownerDelete).not.toHaveBeenCalled();
      expect(item.shapeDelete).not.toHaveBeenCalled();
      expect(sha(item.value.readBrepBytes())).toBe(item.bytes);
    }
    expect(dispose).not.toHaveBeenCalled();
    expect(gateway.hasSaveTarget()).toBe(true);
    expect(write).not.toHaveBeenCalled();
  }
  function begin(value: string) {
    // Match the actual viewport: switch to face picking before selecting the face.
    useAppStore.getState().setSelectionKind('face');
    const selection = [subShapeElementId(seed.targetId, 'face', faceIndex)];
    useAppStore.getState().setSelection(selection);
    const state = useAppStore.getState();
    runSolidTool('faceOffset', solidToolReadiness(state.document, state.selection, 'faceOffset', state.bodies));
    expect(useAppStore.getState().selection).toEqual(selection);
    return input(value);
  }
  function input(value: string) {
    const opened = useAppStore.getState().numericInput;
    if (opened === null) throw new Error('Missing faceOffset input');
    const edited = reduceNumericInput(opened, { type: 'edit', index: 0, source: value });
    useAppStore.getState().updateNumericInput(edited);
    return commitNumericInput(edited);
  }
  async function committed() {
    await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 90_000 });
    await settled();
  }
  function verify(distance: number) {
    const state = useAppStore.getState(), id = state.document.solids.at(-1)?.id;
    if (id === undefined) throw new Error('Missing result');
    const actual = cached(state.document, id).measure();
    const compared = compareEx18Shape(actual, { volume: 9600 + 240 * distance - 72 * Math.PI,
      low: [0, 0, 0], high: [40 + distance, 30, 8],
      holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }] });
    expect(actual.validity.valid).toBe(true);
    expect(actual.validity.closed).toBe(true);
    expect(actual.validity.solidCount).toBe(1);
    expect(actual.throughHoleCount).toBe(1);
    expect(actual.holesComplete).toBe(true);
    expect(compared.volumeRelativeError).toBeLessThanOrEqual(1e-9);
    expect(compared.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
    expect(compared.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6);
    expect(compared.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
    expect(compared.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6);
    expect(compared.failures).toEqual([]);
  }
  return { begin, input, settled, committed, verify, untouched, pending, computed,
    holdNext: () => { hold = true; }, close: () => { try { untouched(); } finally { detach(); native.dispose(); } } };
}

function snapshot() {
  const state = useAppStore.getState();
  return { state, document: documentSha(state.document), shape: shapeSha() };
}
function unchanged(before: ReturnType<typeof snapshot>) {
  const state = useAppStore.getState();
  expect(state.document).toBe(before.state.document);
  expect(documentSha(state.document)).toBe(before.document);
  expect(state.undoStack).toBe(before.state.undoStack);
  expect(shapeSha()).toBe(before.shape);
  expect(state.bodies).toEqual(before.state.bodies);
  expect(state.savedDocument).toBe(before.state.savedDocument);
  expect(state.fileGateway).toBe(before.state.fileGateway);
  expect(state.fileName).toBe(before.state.fileName);
}

describe('faceOffset atomic creation with native geometry and real store', () => {
  it.each(['2+3', '-5'])('%s adopts one document and one Undo/Redo preserving expressions, names and references', async value => {
    const h = await harness();
    try {
      const transition = h.begin(value), before = snapshot();
      applyNumericTransition(transition);
      expect(useAppStore.getState().stagedSolid?.status).toBe('pending');
      unchanged(before);
      await h.committed();
      const after = snapshot(), feature = after.state.document.solids.at(-1);
      expect(feature).toMatchObject({ id: 'faceOffset-1', name: '面の移動1', kind: 'faceOffset',
        offset: { source: value, value: value === '-5' ? -5 : 5 } });
      expect(nextSolidId(after.state.document, 'faceOffset')).toBe('faceOffset-2');
      expect(nextSolidName(after.state.document, 'faceOffset')).toBe('面の移動2');
      expect(after.state.undoStack.past).toHaveLength(before.state.undoStack.past.length + 1);
      expect(after.state.bodies.find(body => body.featureId === 'direct-unselected'))
        .toEqual(before.state.bodies.find(body => body.featureId === 'direct-unselected'));
      h.verify(value === '-5' ? -5 : 5);
      after.state.undo();
      expect(useAppStore.getState().document).toBe(before.state.document);
      await h.settled();
      expect(shapeSha()).toBe(before.shape);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toBe(after.state.document);
      expect(documentSha(useAppStore.getState().document)).toBe(after.document);
      await h.settled();
      expect(shapeSha()).toBe(after.shape);
    } finally { h.close(); }
  }, TIMEOUT);

  it.each(['-28', '0'])('native/model refusal %s keeps the filled input and corrects to one successful history', async value => {
    const h = await harness();
    try {
      const transition = h.begin(value), before = snapshot();
      applyNumericTransition(transition);
      expect(useAppStore.getState().stagedSolid?.status).toBe('pending');
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); }, { timeout: 90_000 });
      unchanged(before); h.untouched();
      const failed = useAppStore.getState().stagedSolid;
      expect(failed?.errors.length).toBeGreaterThan(0);
      if (failed === null) throw new Error('Missing failed candidate');
      expect(consumedIds(failed.placement.document, failed.errors)).not.toContain('direct-seed');
      expect(useAppStore.getState().numericInput?.fields[0].source).toBe(value);
      applyNumericTransition(h.input('5'));
      await h.committed(); h.verify(5);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.state.undoStack.past.length + 1);
    } finally { h.close(); }
  }, TIMEOUT);

  it.each(['escape', 'old-input', 'undo-aba'] as const)('%s rejects a delayed native success and closes only its candidate scope', async scenario => {
    const h = await harness();
    try {
      const transition = h.begin('5');
      h.holdNext(); applyNumericTransition(transition);
      expect(h.pending).toHaveLength(1);
      const result = await h.pending[0].result;
      expect(result.errors).toEqual([]);
      const scope = result.referenceMeshScope;
      if (scope === undefined) throw new Error('Missing native candidate scope');
      const close = vi.spyOn(scope, 'close');
      const staged = useAppStore.getState().stagedSolid;
      if (staged === null) throw new Error('Missing stage');
      if (scenario === 'escape') applyNumericTransition({ kind: 'cancelled' });
      if (scenario === 'old-input') h.input('-5');
      if (scenario === 'undo-aba') {
        const document = useAppStore.getState().document;
        useAppStore.getState().applyDocument({ ...document, name: 'intervening edit' });
        useAppStore.getState().undo();
        expect(useAppStore.getState().document).toBe(document);
        expect(useAppStore.getState().undoStack).not.toBe(staged.ownership.undoStack);
      }
      const before = snapshot();
      await h.pending[0].release();
      await vi.waitFor(() => { expect(close).toHaveBeenCalledTimes(1); });
      if (scenario === 'undo-aba') await h.settled();
      unchanged(before); h.untouched();
      expect(useAppStore.getState().partStager?.confirm(staged.ownership.inputRevision)).toBe('refused');
      if (scenario === 'escape') expect(useAppStore.getState().numericInput).toBeNull();
    } finally { h.close(); }
  }, TIMEOUT);

  it('duplicate confirmation computes and adopts exactly once', async () => {
    const h = await harness();
    try {
      const transition = h.begin('5'), before = snapshot(), count = h.computed.length;
      h.holdNext(); applyNumericTransition(transition); applyNumericTransition(transition);
      expect(h.pending).toHaveLength(1); unchanged(before);
      await h.pending[0].release(); await h.committed(); h.verify(5);
      expect(h.computed).toHaveLength(count + 1);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.state.undoStack.past.length + 1);
    } finally { h.close(); }
  }, TIMEOUT);

  it('has no synchronous fallback when the stager is absent', () => {
    const input = createNumericInput('faceOffset', 'faceOffsetDistance');
    useAppStore.getState().openNumericInput(input, [100, 100]);
    const transition = commitNumericInput(input), before = snapshot();
    if (transition.kind !== 'solidCommitted') throw new Error('Missing face offset commit');
    expect(applySolidCommit(transition.commit)).toBe(false);
    applyNumericTransition(transition);
    unchanged(before);
    expect(useAppStore.getState().numericInput).toBe(transition.state);
    expect(useAppStore.getState().solidErrorKey).toBe('solidError.notYetAvailable');
  });
});
