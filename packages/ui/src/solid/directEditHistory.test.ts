import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as ev } from '@pointercad/expression';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, nextSolidId, nextSolidName,
  recomputePart, replaceSolid, resolveSubShapeReference, type SubShapeRef, type PartDocument, type PartRecomputeResult,
  type SolidBody } from '@pointercad/model';
import { createNativeKernelBridgeForNodeTests, initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { buildEx18DirectSeed, withEx18UnselectedBody } from '../../../model/src/part/ex18RouteBuildersDirect.js';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { commitNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { runSolidTool } from '../shell/menus/solidToolActions.js';
import { solidToolReadiness } from './solidCommands.js';
import { subShapeElementId } from './subShapeSelection.js';
import { documentSha, shapeSha } from './holeThreadHistory.testSupport.js';
import { summarizeSolid, setSolidField } from './solidSummary.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair } from './referenceRepair.js';
import type { DirectEditToolId } from './directEditCommands.js';
import { consumedIds } from './solidHistoryState.js';
import { createBrowserFileGateway } from '../file/fileGateway.js';

const TIMEOUT = 180_000;
beforeAll(initializeNativeKernelForNodeTests, TIMEOUT);
beforeEach(resetTestStore);

async function harness(tool: DirectEditToolId) {
  const bridge = createNativeKernelBridgeForNodeTests();
  const seed = tool === 'holeTranslate' ? await buildEx18DirectSeed('A', bridge) : {
    part: appendSolid(createEmptyPartDocument(), { id: 'box', name: 'Box', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: ev(40), sizeY: ev(30), sizeZ: ev(8) } }), targetId: 'box',
  };
  const document = withEx18UnselectedBody(seed).part;
  useAppStore.getState().applyDocument(document, { opensDocument: true });
  const write = vi.fn(() => Promise.resolve());
  const gateway = createBrowserFileGateway({ showSaveFilePicker: () => Promise.resolve({
    name: 'direct-edit-source.pcad', createWritable: () => Promise.resolve({ write, close: () => Promise.resolve() }),
  }) });
  await gateway.savePcad('direct-edit-source.pcad', new Uint8Array(), true);
  expect(gateway.hasSaveTarget()).toBe(true);
  write.mockClear();
  useAppStore.getState().setFileGateway(gateway);
  useAppStore.getState().setFileState('direct-edit-source.pcad', document);
  const results: PartRecomputeResult[] = [];
  let hold = false;
  const pending: { result: Promise<PartRecomputeResult>; release: () => Promise<void> }[] = [];
  const detach = attachPartRecompute((candidate, options) => {
    const delayed = hold;
    hold = false;
    const result = recomputePart(candidate, bridge, delayed ? { ...options, shouldCancel: () => false } : options)
      .then(computed => { results.push(computed); return computed; });
    if (!delayed) return result;
    return new Promise<PartRecomputeResult>(resolve => {
      pending.push({ result, release: async () => { resolve(await result); } });
    });
  });
  async function settled(): Promise<void> {
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.isComputing).toBe(false);
      expect(state.lastOutcome).toBe('success');
      expect(state.completedGeneration).toBe(state.requestedGeneration);
    }, { timeout: 90_000, interval: 20 });
  }
  const initial = beginDocumentRequest('test.directEditHistory.initial');
  await settled();
  expect(initial.isCurrent()).toBe(true);
  const source = useAppStore.getState().bodies.find(body => body.featureId === seed.targetId);
  if (source === undefined) throw new Error('Missing native source');
  const face = source.faces.find(entry => tool === 'holeTranslate' ? entry.surfaceKind === 'cylinder'
    : entry.axis !== null && entry.axis[2] > 0.99 && Math.abs(entry.centroid[2] - 8) < 1e-6);
  if (face === undefined) throw new Error('Missing native face');
  const selection = [subShapeElementId(seed.targetId, 'face', face.index)];
  if (tool === 'faceRotate') {
    const hinge = source.edges.find(edge => edge.curveKind === 'line'
      && Math.hypot(edge.midpoint[0] - 20, edge.midpoint[1], edge.midpoint[2] - 8) < 1e-6);
    if (hinge === undefined) throw new Error('Missing native hinge');
    selection.unshift(subShapeElementId(seed.targetId, 'edge', hinge.index));
  }
  function begin(value: string) {
    useAppStore.getState().setSelection(selection);
    const state = useAppStore.getState();
    runSolidTool(tool, solidToolReadiness(state.document, state.selection, tool, state.bodies));
    let input = useAppStore.getState().numericInput;
    if (input === null) throw new Error('Input did not open');
    input = reduceNumericInput(input, { type: 'edit', index: 0, source: value });
    useAppStore.getState().updateNumericInput(input);
    return commitNumericInput(input);
  }
  async function committed() {
    await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 90_000, interval: 20 });
    await settled();
  }
  return { document, source, results, pending, begin, settled, committed,
    holdNext: () => { hold = true; }, dispose: () => {
      detach(); bridge.dispose();
      expect(gateway.hasSaveTarget()).toBe(true);
      expect(write).not.toHaveBeenCalled();
    } };
}

function verify(body: SolidBody, tool: DirectEditToolId, value: number) {
  const expected = tool === 'holeTranslate' ? 9600 - 72 * Math.PI : 9600 + 18000 * Math.tan(value * Math.PI / 180);
  expect(body.isValid).toBe(true);
  expect(Math.abs(body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
  if (tool === 'holeTranslate') {
    const hole = body.faces.find(face => face.surfaceKind === 'cylinder');
    if (hole === undefined) throw new Error('Missing hole');
    expect(Math.hypot(hole.centroid[0] - (10 + value), hole.centroid[1] - 15)).toBeLessThanOrEqual(1e-6);
    expect(hole.radius).toBeCloseTo(3, 10);
  } else {
    const face = body.faces.find(entry => entry.axis !== null && entry.axis[2] > 0.9);
    if (face?.axis === null || face === undefined) throw new Error('Missing rotated face');
    expect(Math.abs(Math.atan2(-face.axis[1], face.axis[2]) - value * Math.PI / 180)).toBeLessThanOrEqual(1e-8);
  }
}

function resultBody(): SolidBody {
  const state = useAppStore.getState(), id = state.document.solids.at(-1)?.id;
  const body = state.bodies.find(item => item.featureId === id);
  if (body === undefined) throw new Error('Missing direct edit result');
  return body;
}

describe('direct edits through numeric input, real store and native geometry', () => {
  it.each([['holeTranslate', 2], ['holeTranslate', -2], ['faceRotate', 5], ['faceRotate', -5]] as const)(
    '%s %s creates one history entry and exact Undo/Redo documents', async (tool, amount) => {
      const h = await harness(tool);
      try {
        const transition = h.begin(String(amount)), before = useAppStore.getState(), beforeSha = documentSha(before.document);
        const beforeShape = shapeSha();
        applyNumericTransition(transition);
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().undoStack).toBe(before.undoStack);
        await h.committed();
        const after = useAppStore.getState(), feature = after.document.solids.at(-1);
        expect(feature?.id).toBe(`${tool}-1`);
        expect(feature?.name).toBe(tool === 'holeTranslate' ? '穴の移動1' : '面の回転1');
        expect(nextSolidId(after.document, tool)).toBe(`${tool}-2`);
        expect(nextSolidName(after.document, tool)).toBe(tool === 'holeTranslate' ? '穴の移動2' : '面の回転2');
        expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
        expect(after.savedDocument).toBe(before.savedDocument);
        expect(after.fileGateway).toBe(before.fileGateway);
        expect(after.fileName).toBe(before.fileName);
        expect(after.bodies.find(body => body.featureId === 'direct-unselected'))
          .toEqual(before.bodies.find(body => body.featureId === 'direct-unselected'));
        verify(resultBody(), tool, amount);
        const afterSha = documentSha(after.document), afterShape = shapeSha();
        after.undo();
        expect(useAppStore.getState().document).toEqual(before.document);
        expect(documentSha(useAppStore.getState().document)).toBe(beforeSha);
        await h.settled();
        expect(shapeSha()).toBe(beforeShape);
        useAppStore.getState().redo();
        expect(useAppStore.getState().document).toEqual(after.document);
        expect(documentSha(useAppStore.getState().document)).toBe(afterSha);
        await h.settled();
        expect(shapeSha()).toBe(afterShape);
        verify(resultBody(), tool, amount);
      } finally { h.dispose(); }
    }, TIMEOUT);

  it.each(['holeTranslate', 'faceRotate'] as const)('%s re-edits existing property fields and reevaluates variables', async tool => {
    const h = await harness(tool);
    try {
      applyNumericTransition(h.begin(tool === 'holeTranslate' ? '1+1' : '10/2'));
      await h.committed();
      const before = useAppStore.getState(), feature = before.document.solids.at(-1);
      if (feature?.kind !== tool) throw new Error('Missing feature');
      const value = tool === 'holeTranslate' ? -2 : -5;
      const formula = { ...ev(value), source: 'amount' };
      const key = tool === 'holeTranslate' ? 'translationX' : 'rotationAngle';
      const edited = setSolidField(feature, key, formula);
      const changed: PartDocument = { ...replaceSolid(before.document, feature.id, edited), parameters: [{
        name: 'amount', value: ev(value), unit: tool === 'holeTranslate' ? 'mm' : 'degree', description: '',
      }] };
      useAppStore.getState().applyDocument(changed);
      await h.settled();
      verify(resultBody(), tool, value);
      expect(summarizeSolid(changed, edited).fields.find(field => field.key === key)?.value.source).toBe('amount');
      expect(edited.id).toBe(feature.id);
      expect(edited.name).toBe(feature.name);
      const after = useAppStore.getState();
      after.undo();
      expect(useAppStore.getState().document).toEqual(before.document);
      await h.settled();
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toEqual(after.document);
      await h.settled();
      useAppStore.getState().applyDocument({ ...after.document,
        parameters: after.document.parameters.map(parameter => ({ ...parameter, value: ev(-value) })) });
      await h.settled();
      verify(resultBody(), tool, -value);
      if (feature.kind === 'holeTranslate') {
        for (const [field, index] of [['translationX', 0], ['translationY', 1], ['translationZ', 2]] as const) {
          const result = setSolidField(feature, field, ev(1));
          expect(result).toEqual({ ...feature, translation: feature.translation.map((entry, i) => i === index ? ev(1) : entry) });
        }
        const current = useAppStore.getState(), target = current.document.solids.at(-1);
        if (target?.kind !== 'holeTranslate') throw new Error('Missing translated hole');
        const yz = setSolidField(setSolidField(target, 'translationY', { ...ev(2), source: '1+1' }),
          'translationZ', { ...ev(0), source: '1-1' });
        useAppStore.getState().applyDocument(replaceSolid(current.document, target.id, yz));
        await h.settled();
        const body = resultBody(), hole = body.faces.find(face => face.surfaceKind === 'cylinder');
        if (hole === undefined) throw new Error('Missing reedited hole');
        expect(Math.hypot(hole.centroid[0] - 12, hole.centroid[1] - 17, hole.centroid[2] - 4)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(body.volume - (9600 - 72 * Math.PI)) / (9600 - 72 * Math.PI)).toBeLessThanOrEqual(1e-9);
        expect(useAppStore.getState().document.solids.at(-1)).toEqual(yz);
        useAppStore.getState().undo();
        expect(useAppStore.getState().document).toEqual(current.document);
        await h.settled();
        verify(resultBody(), tool, 2);
      }
    } finally { h.dispose(); }
  }, TIMEOUT);

  it.each(['holeTranslate', 'faceRotate'] as const)('%s native refusal and cancelled successful candidate preserve source/history/save destination', async tool => {
    const h = await harness(tool);
    try {
      const transition = h.begin(tool === 'holeTranslate' ? '-7' : '-20'), before = useAppStore.getState();
      const sha = documentSha(before.document), shape = shapeSha();
      applyNumericTransition(transition);
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); }, { timeout: 90_000 });
      expect(useAppStore.getState().stagedSolid?.errors.length).toBeGreaterThan(0);
      expect(documentSha(useAppStore.getState().document)).toBe(sha);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().savedDocument).toBe(before.savedDocument);
      expect(useAppStore.getState().fileGateway).toBe(before.fileGateway);
      expect(useAppStore.getState().fileName).toBe(before.fileName);
      expect(shapeSha()).toBe(shape);
      applyNumericTransition({ kind: 'cancelled' });
      const next = h.begin(tool === 'holeTranslate' ? '2' : '5');
      h.holdNext();
      applyNumericTransition(next);
      expect(h.pending).toHaveLength(1);
      expect((await h.pending[0].result).errors).toEqual([]);
      applyNumericTransition({ kind: 'cancelled' });
      await h.pending[0].release();
      await new Promise<void>(resolve => { setTimeout(resolve, 0); });
      expect(documentSha(useAppStore.getState().document)).toBe(sha);
      expect(shapeSha()).toBe(shape);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().savedDocument).toBe(before.savedDocument);
      expect(useAppStore.getState().fileGateway).toBe(before.fileGateway);
      expect(useAppStore.getState().fileName).toBe(before.fileName);
    } finally { h.dispose(); }
  }, TIMEOUT);

  it.each(['holeTranslate', 'faceRotate'] as const)('%s repairs its face and hinge through current-body references', async tool => {
    const h = await harness(tool);
    try {
      applyNumericTransition(h.begin(tool === 'holeTranslate' ? '2' : '5'));
      await h.committed();
      const original = useAppStore.getState().document, feature = original.solids.at(-1);
      if (feature?.kind !== 'holeTranslate' && feature?.kind !== 'faceRotate') throw new Error('Missing feature');
      for (const field of feature.kind === 'faceRotate' ? ['face', 'hinge'] as const : ['face'] as const) {
        const ref = field === 'hinge' && feature.kind === 'faceRotate' ? feature.hinge : feature.face;
        const broken: SubShapeRef = { ...ref, origin: field === 'hinge'
          ? { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'missing-producer', role: 'top-front' } }
          : { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'missing-producer', role: 'top' } }, index: 9999,
          fingerprint: { ...ref.fingerprint, position: [999, 999, 999] as const } };
        expect(resolveSubShapeReference(h.source, broken).status).toBe('missing');
        const changed: PartDocument = replaceSolid(original, feature.id, { ...feature, [field]: broken });
        const generation = useAppStore.getState().completedGeneration;
        useAppStore.getState().applyDocument(changed);
        await vi.waitFor(() => {
          expect(useAppStore.getState().isComputing).toBe(false);
          expect(useAppStore.getState().completedGeneration).toBeGreaterThan(generation);
          expect(useAppStore.getState().lastOutcome).toBe('failed');
        }, { timeout: 90_000 });
        expect(consumedIds(useAppStore.getState().document, useAppStore.getState().partErrors)).not.toContain(feature.targetFeatureId);
        const slot = currentRepairSlots(useAppStore.getState()).find(item => item.ownerId === feature.id && item.reference === broken);
        if (slot === undefined) throw new Error('Missing repair slot');
        const session = beginReferenceRepair(slot.key);
        if (session === null) throw new Error('Missing repair session');
        const candidate = session.candidates.find(item => item.reference.index === ref.index && item.selectable);
        if (candidate === undefined) throw new Error(JSON.stringify({ message: 'Missing current source candidate',
          field, expected: ref.index, bodies: slot.bodies.map(body => body.featureId),
          candidates: session.candidates.map(item => ({ index: item.reference.index, selectable: item.selectable })),
          errors: useAppStore.getState().partErrors }));
        const before = useAppStore.getState();
        cancelReferenceRepair(session);
        expect(useAppStore.getState().document).toBe(before.document);
        const active = beginReferenceRepair(slot.key);
        if (active === null) throw new Error('Missing repair session');
        const current = active.candidates.find(item => item.reference.index === ref.index && item.selectable);
        if (current === undefined) throw new Error('Missing repair candidate');
        expect(commitReferenceRepair(active, current)).toBe('applied');
        expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
        await h.settled();
        verify(resultBody(), tool, tool === 'holeTranslate' ? 2 : 5);
      }
    } finally { h.dispose(); }
  }, TIMEOUT);
});
