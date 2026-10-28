import { createFunctionMathSource, createMathBackend, executeFunctionCurveWorkRequest,
  executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createInspectableNativeKernelForNodeTests, createNativeKernelBridgeForNodeTests, initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { expressionValueFromNumber } from '@pointercad/expression';
import { parseDocument, readPcadFile, serializeDocument, writePcadFile } from '@pointercad/io';
import {
  absoluteCoordinate, appendFeature, appendReference, appendSolid, createEmptyPartDocument, createEmptySketchDocument,
  DEFAULT_FACE_COLOR, replaceSketch, resolvePart, createFunctionCurve, recomputePart,
  type PartDocument, type PartRecomputeOptions, type PartRecomputeResult,
} from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { attachPartRecompute, type PartRecomputer } from '../store/attachKernel.js';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentStagedSolid } from '../store/recomputeSlice.js';
import { applyEditCommit, applyNumericTransition, applySolidCommit, previewExtrudeTransition } from './commitToStore.js';
import { chooseNumericInput, createNumericInput, reduceNumericInput, toggleNumericInput,
  type EditInputCommit, type SolidInputCommit } from './numericInput.js';

beforeEach(resetTestStore);

function part(): PartDocument {
  const sketch = appendFeature(appendFeature(createEmptySketchDocument(), {
    id: 'rect', name: '矩形1', planeId: 'xy', kind: 'rectangle', construction: false,
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
  }), { id: 'face', name: '面1', planeId: 'xy', kind: 'face', color: DEFAULT_FACE_COLOR,
    boundary: [{ featureId: 'rect' }] });
  return appendSolid(replaceSketch(createEmptyPartDocument(), sketch), {
    id: 'extrude', name: '押し出し1', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: 'face' }, distance: expressionValueFromNumber(10),
    reversed: false, symmetric: false,
  });
}
function extrudePlan(document: PartDocument, curves: number): string {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  expect(resolved.sketches[0].resolved.errors).toEqual([]);
  expect(resolved.steps).toHaveLength(1);
  const step = resolved.steps[0];
  expect(step.featureId).toBe('extrude');
  if (step.plan.kind !== 'extrude') throw new Error('Missing extrusion');
  expect(step.plan.profile).toHaveLength(curves);
  expect(step.plan.distance).toBe(10);
  return step.key;
}

describe('角加工の確定は既存面と押し出しの参照を保つ(F07)', () => {
  it.each(['sketchFillet', 'sketchChamfer'] as const)('%sの確定・Undo/Redo・保存読込', (tool) => {
    const document = part(), beforeKey = extrudePlan(document, 4);
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setActiveTool(tool);
    useAppStore.getState().setSelection(['rect#0', 'rect#1']);
    const commit: EditInputCommit = {
      kind: 'edit', tool, step: tool === 'sketchFillet' ? 'sketchFilletRadius' : 'sketchChamferSize',
      values: { cornerRadius: expressionValueFromNumber(5), cornerDistance1: expressionValueFromNumber(3) },
      flags: {}, choices: { chamferMode: 'equal' },
    };
    expect(applyEditCommit(commit)).toBe(true);
    const after = useAppStore.getState().document;
    expect(extrudePlan(after, 5)).not.toBe(beforeKey);
    expect(after.solids).toEqual(document.solids);
    expect(useAppStore.getState().activeTool).toBe(tool);
    expect(useAppStore.getState().selection).toHaveLength(1);
    expect(useAppStore.getState().editErrorKey).toBeNull();
    expect(useAppStore.getState().editNoticeKey).toBe('corner.notice.faceBoundary');
    expect(t('corner.notice.faceBoundary')).toContain('面の境界も更新しました');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(document);
    expect(extrudePlan(useAppStore.getState().document, 4)).toBe(beforeKey);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(after);
    extrudePlan(useAppStore.getState().document, 5);
    const reopened = parseDocument(serializeDocument(after));
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Could not reopen saved document');
    expect(reopened.document.sketches[0].features).toEqual(after.sketches[0].features);
    expect(reopened.document.solids).toEqual(after.solids);
    expect(extrudePlan(reopened.document, 5)).toBe(extrudePlan(after, 5));
  });

  it('境界の更新を拒否したら文書・Undo・選択・入力を保持し、理由を出す', () => {
    const initial = useAppStore.getState().document;
    const source = part(), sketch = source.sketches[0];
    const broken = replaceSketch(source, { ...sketch, features: sketch.features.map((feature) =>
      feature.kind === 'face' ? { ...feature, boundary: [{ featureId: 'rect', index: 0 }] } : feature) });
    useAppStore.getState().applyDocument(broken);
    useAppStore.getState().setActiveTool('sketchFillet');
    useAppStore.getState().setSelection(['rect#0', 'rect#1']);
    const input = createNumericInput('sketchFillet', 'sketchFilletRadius');
    useAppStore.getState().updateNumericInput(input);
    const history = useAppStore.getState().undoStack;
    applyNumericTransition({ kind: 'editCommitted', state: input, commit: {
      kind: 'edit', tool: 'sketchFillet', step: 'sketchFilletRadius',
      values: { cornerRadius: expressionValueFromNumber(5) }, flags: {}, choices: {},
    } });
    const state = useAppStore.getState();
    expect(state.document).toBe(broken);
    expect(state.undoStack).toBe(history);
    expect(state.selection).toEqual(['rect#0', 'rect#1']);
    expect(state.numericInput).toBe(input);
    expect(state.editErrorKey).toBe('corner.error.faceBoundary');
    expect(state.editNoticeKey).toBeNull();
    expect(t('corner.error.faceBoundary')).toContain('線と面は変更していません');
    state.undo();
    expect(useAppStore.getState().document).toBe(initial);
  });
});


describe('押し出しは形を計算してから1回で確定する(EX-14)', () => {
  interface Pending {
    readonly document: PartDocument;
    readonly options: PartRecomputeOptions;
    readonly settle: (result: PartRecomputeResult) => void;
  }
  function attachControlled() {
    const calls: Pending[] = [];
    const recompute: PartRecomputer = (document, options) => new Promise<PartRecomputeResult>((resolve) => {
      calls.push({ document, options, settle: resolve });
    });
    return { calls, detach: attachPartRecompute(recompute) };
  }
  /** The scheduled generation and a known receipt with the post-token union for exactly that document. */
  function success(call: Pending, featureIds: readonly string[]): PartRecomputeResult {
    const generation = call.options.generation ?? -1;
    return { ...resultFor(call.document), generation, bodies: featureIds.map(bodyFor),
      meshJsAccounting: { documentId: call.document.id, partId: call.document.id, generation,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 110,
          cacheProtectedBytes: 240, retainedReplyBytes: 300, requestPeakReservedBytes: 1000 },
        final: { status: 'known', limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 0, cacheProtectedBytes: 130,
          displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 190, replyCloneReservedBytes: 60 } } };
  }
  function extrudeCommit(operation: string, target: string): SolidInputCommit {
    return { kind: 'solid', tool: 'extrude', step: 'extrudeDistance', values: { distance: expressionValueFromNumber(5) },
      flags: {}, shapeChoices: { extrudeOperation: operation, extrudeTarget: target } };
  }
  async function ready() {
    const document = part();
    useAppStore.getState().applyDocument(document);
    const control = attachControlled();
    control.calls[0].settle(success(control.calls[0], ['extrude']));
    await vi.waitFor(() => { expect(useAppStore.getState().lastOutcome).toBe('success'); });
    useAppStore.getState().setSelection(['face']);
    const input = createNumericInput('extrude', 'extrudeDistance', 'absolute', {
      extrudeTargets: [{ value: 'extrude', label: '押し出し1' }] });
    useAppStore.getState().updateNumericInput(input);
    return { ...control, document, input };
  }

  it.each(['join', 'cut'] as const)('%s waits with the input open, then adopts that exact document once with one Undo/Redo', async (operation) => {
    const { calls, detach, document, input } = await ready();
    try {
      const history = useAppStore.getState().undoStack;
      applyNumericTransition({ kind: 'solidCommitted', state: input, commit: extrudeCommit(operation, 'extrude') });
      // Pending: no document-only success, the input stays open for the result.
      expect(useAppStore.getState().document).toBe(document);
      expect(useAppStore.getState().undoStack).toBe(history);
      expect(useAppStore.getState().numericInput).toBe(input);
      expect(calls).toHaveLength(2);
      const staged = calls[1];
      expect(staged.document.solids.map((solid) => solid.kind)).toEqual(['extrude', 'extrude', 'boolean']);
      const final = staged.document.solids.at(-1);
      if (final?.kind !== 'boolean') throw new Error('Expected the composed boolean');
      expect(final).toMatchObject({ operation: operation === 'join' ? 'union' : 'subtract', targetFeatureId: 'extrude',
        toolFeatureId: staged.document.solids.at(-2)?.id });
      staged.settle(success(staged, [final.id]));
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); });
      const after = useAppStore.getState();
      expect(after.document).toBe(staged.document);
      expect(after.undoStack.past).toHaveLength(history.past.length + 1);
      expect(after.selection).toEqual([final.id]);
      expect(after.requestedGeneration).toBe(staged.options.generation);
      expect(after.completedGeneration).toBe(staged.options.generation);
      expect(calls).toHaveLength(2);
      after.undo();
      expect(useAppStore.getState().document).toBe(document);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toBe(after.document);
      const reopened = parseDocument(serializeDocument(after.document));
      if (!reopened.ok) throw new Error('Could not reopen composed extrusion');
      expect(reopened.document.solids).toEqual(after.document.solids);
      expect(reopened.document.sketches).toEqual(after.document.sketches);
    } finally { detach(); }
  });

  it('an invalid target keeps document/history/selection/input and explains why, without any computation', async () => {
    const { calls, detach, document, input } = await ready();
    try {
      const before = useAppStore.getState();
      applyNumericTransition({ kind: 'solidCommitted', state: input, commit: extrudeCommit('join', 'deleted') });
      const state = useAppStore.getState();
      expect(state.document).toBe(document);
      expect(state.undoStack).toBe(before.undoStack);
      expect(state.selection).toEqual(before.selection);
      expect(state.numericInput).toBe(input);
      expect(state.solidErrorKey).toBe('solidError.extrudeTargetUnavailable');
      expect(calls).toHaveLength(1);
    } finally { detach(); }
  });

  it('a failed computation keeps everything and shows an actionable message; preview never changes the document', async () => {
    const { calls, detach, document, input } = await ready();
    try {
      const history = useAppStore.getState().undoStack;
      previewExtrudeTransition({ kind: 'solidCommitted', state: input, commit: extrudeCommit('new', '') });
      expect(calls).toHaveLength(2);
      calls[1].settle({ ...success(calls[1], ['extrude']),
        errors: [{ featureId: 'extrude-2', code: 'kernelFailed', message: 'failed' }] });
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); });
      applyNumericTransition({ kind: 'solidCommitted', state: input, commit: extrudeCommit('new', '') });
      const state = useAppStore.getState();
      expect(state.document).toBe(document);
      expect(state.undoStack).toBe(history);
      expect(state.numericInput).toBe(input);
      expect(state.solidErrorKey).toBe('solidError.extrudeFailed');
      expect(t('solidError.extrudeFailed')).toContain('決定');
      expect(calls).toHaveLength(2);
    } finally { detach(); }
  });

  it('command-line style confirmation keeps the filled values visible, ignores duplicates, and recovers after a failure', async () => {
    const { calls, detach, document, input } = await ready();
    try {
      const history = useAppStore.getState().undoStack;
      // The command line confirms a filled copy of the open input (not the stored one).
      const filled = reduceNumericInput(input, { type: 'edit', index: 0, source: '7' });
      const typed = (source: string, value: number) => ({ kind: 'solidCommitted' as const,
        state: reduceNumericInput(input, { type: 'edit', index: 0, source }),
        commit: { ...extrudeCommit('new', ''), values: { distance: expressionValueFromNumber(value) } } });
      applyNumericTransition({ ...typed('7', 7), state: filled });
      expect(useAppStore.getState().numericInput).toBe(filled);
      expect(calls).toHaveLength(2);
      // A repeated Enter while computing waits for the same calculation (no second request, no second Undo step).
      applyNumericTransition({ ...typed('7', 7), state: filled });
      expect(calls).toHaveLength(2);
      calls[1].settle({ ...success(calls[1], ['extrude']),
        errors: [{ featureId: 'extrude-2', code: 'kernelFailed', message: 'failed' }] });
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); });
      // After the failure: same document and history, the input with the typed value stays open.
      expect(useAppStore.getState().document).toBe(document);
      expect(useAppStore.getState().undoStack).toBe(history);
      expect(useAppStore.getState().numericInput).toBe(filled);
      // Recovery: a corrected value is a new input, computed once and adopted with one Undo step.
      const corrected = typed('8', 8);
      applyNumericTransition(corrected);
      expect(useAppStore.getState().numericInput).toBe(corrected.state);
      expect(calls).toHaveLength(3);
      const created = calls[2].document.solids.at(-1);
      if (created === undefined) throw new Error('Expected the new extrusion');
      calls[2].settle(success(calls[2], ['extrude', created.id]));
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); });
      expect(useAppStore.getState().document).toBe(calls[2].document);
      expect(useAppStore.getState().undoStack.past).toHaveLength(history.past.length + 1);
    } finally { detach(); }
  });

  it('has no synchronous extrusion bypass: without the geometry scheduler nothing is committed', () => {
    const document = part();
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setSelection(['face']);
    const history = useAppStore.getState().undoStack;
    expect(applySolidCommit(extrudeCommit('new', ''))).toBe(false);
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(history);
    expect(useAppStore.getState().solidErrorKey).toBe('solidError.extrudeUnavailable');
  });
});


// EX-04.03: real expression sampling and OCCT, without an injected pre-smoothed curve.
describe('数式の閉じた輪郭を実際の切削確定まで渡す(EX-04.03)', () => {
  let backend: ReturnType<typeof createMathBackend>;
  beforeAll(async () => { backend = createMathBackend(); await initializeNativeKernelForNodeTests(); }, 180_000);

  function formulaPart(text = 'X^2/10+1', customPlane = false): PartDocument {
    const plain = part();
    const source = customPlane ? appendReference(plain, { id: 'formula-plane', name: '式の作業平面',
      kind: 'referencePlane', visible: true,
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(2) } }) : plain;
    const original = source.sketches[0], planeId = customPlane ? 'formula-plane' : 'xy', z = customPlane ? 2 : 0;
    const value = expressionValueFromNumber;
    const formula = (text: string) => createFunctionMathSource(text, 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [] }, backend);
    const curve = createFunctionCurve(original, {
      format: 'pointercad-function/1',
      bounds: { X: { min: value(0), max: value(10) }, Y: { min: value(0), max: value(12) },
        Z: { min: value(-1), max: value(3) } },
      tolerance: value(0.001),
      formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: formula(text), Z: formula(String(z)) } },
    });
    const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ({
      id, name: id, kind: 'line' as const, planeId, construction: false,
      from: absoluteCoordinate(x1, y1, z), to: absoluteCoordinate(x2, y2, z),
    });
    let sketch = appendFeature(original, curve);
    for (const segment of [line('close-right', 10, 11, 10, 0), line('close-bottom', 10, 0, 0, 0),
      line('close-left', 0, 0, 0, 1)]) sketch = appendFeature(sketch, segment);
    sketch = appendFeature(sketch, { id: 'formula-face', name: '式の切削輪郭', kind: 'face', planeId,
      boundary: [curve.id, 'close-right', 'close-bottom', 'close-left'].map(featureId => ({ featureId })),
      color: DEFAULT_FACE_COLOR });
    return replaceSketch(source, sketch);
  }
  function options(document: PartDocument): PartRecomputeOptions {
    return { generation: 1, math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
      client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
          { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)),
            declaredIds: new Set() }).result }) } },
      functions: { curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) } } };
  }
  async function formulaSettled(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAppStore.getState().isComputing).toBe(false);
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    }, { timeout: 60_000 });
  }
  const commit: SolidInputCommit = { kind: 'solid', tool: 'cut', step: 'cutPlane', values: {}, flags: {},
    shapeChoices: { cutPlaneKind: 'profile' } };
  function publish(document: PartDocument, result: PartRecomputeResult): void {
    const store = useAppStore.getState();
    store.applyDocument(document);
    useAppStore.getState().recordRecomputeRequest(1);
    useAppStore.getState().applyRecompute(document, result);
    useAppStore.getState().recordRecomputeCompletion(1, 'success');
    useAppStore.getState().setSelection(['extrude', 'formula-face']);
  }

  it.each([false, true])('実評価した放物線の切削は独立積分の体積となり保存再計算と1回のUndo/Redoを保つ(customPlane=%s)', async (customPlane) => {
    const bridge = createNativeKernelBridgeForNodeTests();
    let detach = (): void => {};
    try {
      const before = formulaPart('X^2/10+1', customPlane);
      const computed = await recomputePart(before, bridge, options(before));
      expect(computed.cancelled).toBe(false); expect(computed.errors).toEqual([]);
      expect(computed.bodies).toHaveLength(1); expect(computed.bodies[0].volume).toBeCloseTo(12000, 6);
      const resolved = computed.sketches.find(sketch => sketch.sketchId === before.activeSketchId)?.resolved;
      const face = resolved?.faces.find(candidate => candidate.featureId === 'formula-face');
      if (face === undefined) throw new Error('Evaluated formula profile is missing');
      const closing = face.curves.find(curve => curve.kind === 'segment');
      if (closing?.kind !== 'segment') throw new Error('Closing edge is missing');
      expect(closing.from[2]).toBe(customPlane ? 2 : 0);
      publish(before, computed);
      detach = attachPartRecompute((document, scheduled) => recomputePart(document, bridge, { ...options(document), ...scheduled }));
      await vi.waitFor(() => { expect(useAppStore.getState().isComputing).toBe(false);
        expect(useAppStore.getState().lastOutcome).toBe('success');
        expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
      }, { timeout: 60_000 });
      useAppStore.getState().setActiveTool('cut');
      useAppStore.getState().setSelection(['extrude', 'formula-face']);
      useAppStore.getState().updateNumericInput(chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', 'profile'));
      const pending = useAppStore.getState(), originalShape = shapeSha();
      expect(applySolidCommit(commit)).toBe(false);
      expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack).toBe(pending.undoStack);
      expect(useAppStore.getState().solidErrorKey).toBeNull();
      expect(currentStagedSolid(useAppStore.getState())).toMatchObject({ status: 'pending', confirmRequested: true });
      await vi.waitUntil(() => useAppStore.getState().numericInput === null
        || currentStagedSolid(useAppStore.getState())?.status === 'failed', { timeout: 60_000 });
      expect(currentStagedSolid(useAppStore.getState())).not.toMatchObject({ status: 'failed' });
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
      const after = useAppStore.getState().document;
      expect(after.sketches).toBe(before.sketches);
      expect(after.solids.slice(before.solids.length).map(feature => feature.kind)).toEqual(['extrude', 'boolean']);
      const result = await recomputePart(after, bridge, options(after));
      expect(result.cancelled).toBe(false); expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].isValid).toBe(true); expect(result.bodies[0].bodyKind).toBe('solid');
      // Integral_0^10 (X^2/10 + 1) dX = 130/3 mm², through a 10 mm plate.
      const expected = 12000 - 10 * 130 / 3;
      expect(Math.abs(result.bodies[0].volume - expected)).toBeLessThan(0.1);
      await formulaSettled();
      const accepted = useAppStore.getState(), finalShape = shapeSha();
      expect(accepted.undoStack.past).toHaveLength(pending.undoStack.past.length + 1);
      expect(accepted.undoStack.future).toHaveLength(0);
      accepted.undo(); expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack.past).toHaveLength(pending.undoStack.past.length);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      await formulaSettled(); expect(shapeSha()).toBe(originalShape);
      useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after);
      expect(useAppStore.getState().document.solids).toBe(after.solids);
      expect(useAppStore.getState().document.sketches).toBe(after.sketches);
      expect(useAppStore.getState().undoStack.past).toHaveLength(pending.undoStack.past.length + 1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      await formulaSettled(); expect(shapeSha()).toBe(finalShape);
      const reopened = parseDocument(serializeDocument(after));
      if (!reopened.ok) throw new Error('Formula cut did not reopen');
      expect(reopened.document.sketches).toEqual(after.sketches);
      expect(reopened.document.solids).toEqual(after.solids);
      const regenerated = await recomputePart(reopened.document, bridge, options(reopened.document));
      expect(regenerated.errors).toEqual([]); expect(regenerated.bodies).toHaveLength(1);
      expect(regenerated.bodies[0].isValid).toBe(true); expect(regenerated.bodies[0].bodyKind).toBe('solid');
      expect(Math.abs(regenerated.bodies[0].volume - expected)).toBeLessThan(0.1);
    } finally { detach(); bridge.dispose(); }
  }, 60_000);

  it('EX-04.UNDO 式の両側を1回で戻し、PCAD再開後の式編集も元ID・参照・実形状へ戻す', async () => {
    const bridge = createNativeKernelBridgeForNodeTests();
    let detach = (): void => {};
    try {
      const before = formulaPart(), computed = await recomputePart(before, bridge, options(before));
      expect(computed.errors).toEqual([]); expect(computed.cancelled).toBe(false);
      publish(before, computed);
      detach = attachPartRecompute((document, scheduled) => recomputePart(document, bridge, { ...options(document), ...scheduled }));
      await formulaSettled();
      useAppStore.getState().setActiveTool('cut');
      useAppStore.getState().setSelection(['extrude', 'formula-face']);
      useAppStore.getState().updateNumericInput(toggleNumericInput(
        chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', 'profile'), 'cutKeepBoth'));
      const pending = useAppStore.getState(), originalShape = shapeSha();
      expect(applySolidCommit({ ...commit, flags: { cutKeepBoth: true } })).toBe(false);
      expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack).toBe(pending.undoStack);
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
      await formulaSettled();
      const accepted = useAppStore.getState(), after = accepted.document;
      const cuts = after.solids.filter(feature => feature.kind === 'boolean');
      expect(cuts).toHaveLength(2); expect(cuts[1].pairedWith).toBe(cuts[0].id);
      expect(accepted.bodies.map(body => body.featureId)).toEqual(cuts.map(feature => feature.id));
      expect(accepted.undoStack.past).toHaveLength(pending.undoStack.past.length + 1);
      expect(accepted.undoStack.future).toHaveLength(0);
      const volumes = (outside: number, inside: number): void => {
        const bodies = useAppStore.getState().bodies;
        expect(bodies).toHaveLength(2);
        for (const [index, body] of bodies.entries()) {
          expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
          expect(Math.abs((body.volume ?? Number.NaN) - [outside, inside][index])).toBeLessThan(0.1);
        }
        expect(Math.abs(bodies.reduce((sum, body) => sum + (body.volume ?? Number.NaN), 0) - 12000)).toBeLessThan(0.1);
      };
      volumes(12000 - 10 * 130 / 3, 10 * 130 / 3);
      const cutShape = shapeSha(), cutIds = cuts.map(feature => feature.id);
      accepted.undo(); expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack.past).toHaveLength(pending.undoStack.past.length);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      await formulaSettled(); expect(shapeSha()).toBe(originalShape);
      useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after);
      expect(useAppStore.getState().document.solids).toBe(after.solids);
      expect(useAppStore.getState().document.sketches).toBe(after.sketches);
      expect(useAppStore.getState().undoStack.past).toHaveLength(pending.undoStack.past.length + 1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      await formulaSettled(); expect(shapeSha()).toBe(cutShape);

      const reopened = readPcadFile(writePcadFile(after, { savedAt: '2026-10-26T00:00:00.000Z' }));
      if (!reopened.ok) throw new Error(reopened.error.code);
      expect(reopened.document).toEqual(after);
      useAppStore.getState().applyDocument(reopened.document, { opensDocument: true });
      await formulaSettled();
      const opened = useAppStore.getState().document, openedShape = shapeSha();
      expect(openedShape).toBe(cutShape);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(opened);
      expect(shapeSha()).toBe(openedShape);
      const sketch = opened.sketches[0];
      const features = sketch.features.map(feature => {
        if (feature.kind !== 'functionCurve') return feature;
        const definition = feature.definition;
        if (definition.formula.kind !== 'coordinate-curve' || definition.formula.independent !== 'X') throw new Error('Expected X coordinate curve');
        return { ...feature, definition: { ...definition, formula: { ...definition.formula,
          outputs: { ...definition.formula.outputs, Y: createFunctionMathSource('X^2/20+X/2+1', 'text', 'radian',
            { axes: ['X'], parameters: [], coefficients: [] }, backend) } } } };
      });
      // Endpoint values remain 1 and 11; integral_0^10 (X²/20+X/2+1) = 155/3.
      const edited = replaceSketch(opened, { ...sketch, features });
      useAppStore.getState().applyDocument(edited);
      expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      expect(edited.solids).toBe(opened.solids);
      expect(edited.solids.filter(feature => feature.kind === 'boolean').map(feature => feature.id)).toEqual(cutIds);
      await formulaSettled(); volumes(12000 - 10 * 155 / 3, 10 * 155 / 3);
      const editedShape = shapeSha(); expect(editedShape).not.toBe(openedShape);
      useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(opened);
      expect(useAppStore.getState().document.solids).toBe(opened.solids);
      expect(useAppStore.getState().document.sketches).toBe(opened.sketches);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      await formulaSettled(); expect(shapeSha()).toBe(openedShape);
      useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(edited);
      expect(useAppStore.getState().document.solids).toBe(edited.solids);
      expect(useAppStore.getState().document.sketches).toBe(edited.sketches);
      expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      await formulaSettled(); expect(shapeSha()).toBe(editedShape);
    } finally { detach(); bridge.dispose(); }
  }, 60_000);

  it('計算中・取消・古い世代・別所有者・履歴途中・形の変更・失敗結果では式の切削を積まない', async () => {
    const bridge = createNativeKernelBridgeForNodeTests();
    try {
      const document = formulaPart(), computed = await recomputePart(document, bridge, options(document));
      expect(computed.errors).toEqual([]);
      type State = ReturnType<typeof useAppStore.getState>;
      const cases: readonly Partial<State>[] = [
        { isComputing: true }, { recomputeCancelled: true }, { requestedGeneration: 2 },
        { completedGeneration: 0 }, { lastOutcome: 'failed' }, { timelineIndex: 0 },
        { activeDocumentId: 'foreign-session' },
        { document: { ...document, solids: document.solids.map(feature => feature.kind === 'extrude'
          ? { ...feature, distance: expressionValueFromNumber(20) } : feature) } },
      ];
      for (const change of cases) {
        resetTestStore(); publish(document, computed); useAppStore.setState(change);
        const state = useAppStore.getState(), history = state.undoStack, before = state.document;
        expect(applySolidCommit(commit)).toBe(false);
        expect(useAppStore.getState().document).toBe(before); expect(useAppStore.getState().undoStack).toBe(history);
        expect(useAppStore.getState().solidErrorKey).toBe('cutError.profileInvalid');
      }
      // An old result may arrive after a public same-shape reopen. Capture belongs to the old session.
      resetTestStore();
      useAppStore.getState().applyDocument(document);
      useAppStore.getState().recordRecomputeRequest(1);
      const owner = useAppStore.getState().activeDocumentId;
      const reopened = { ...document, name: 'reopened' };
      useAppStore.getState().applyDocument(reopened, { opensDocument: true });
      expect(useAppStore.getState().activeDocumentId).not.toBe(owner);
      useAppStore.getState().applyRecompute(document, computed);
      useAppStore.getState().recordRecomputeCompletion(1, 'success');
      useAppStore.getState().setSelection(['extrude', 'formula-face']);
      expect(useAppStore.getState().resolvedPartSketches).toBeNull();
      const reopenedHistory = useAppStore.getState().undoStack;
      expect(applySolidCommit(commit)).toBe(false);
      expect(useAppStore.getState().document).toBe(reopened);
      expect(useAppStore.getState().undoStack).toBe(reopenedHistory);
      // Cancellation retires even a completed profile immediately, before another callback arrives.
      resetTestStore(); publish(document, computed); useAppStore.getState().cancelRecompute();
      expect(useAppStore.getState().resolvedPartSketches).toBeNull();
      expect(applySolidCommit(commit)).toBe(false);
      // A late response claiming success cannot undo a real cancellation after its request.
      resetTestStore(); useAppStore.getState().applyDocument(document);
      useAppStore.getState().recordRecomputeRequest(1);
      useAppStore.getState().cancelRecompute();
      useAppStore.getState().applyRecompute(document, computed);
      expect(useAppStore.getState().resolvedPartSketches).toBeNull();
      resetTestStore(); publish(document, { ...computed, cancelled: true });
      expect(useAppStore.getState().resolvedPartSketches).toBeNull();
      expect(applySolidCommit(commit)).toBe(false);
      // A genuinely non-finite formula must not borrow the preceding successful profile.
      const invalid = formulaPart('1/(X-X)');
      const failed = await recomputePart(invalid, bridge, options(invalid));
      expect(failed.errors.length).toBeGreaterThan(0);
      resetTestStore(); publish(document, computed); publish(invalid, failed);
      expect(useAppStore.getState().resolvedPartSketches).toBeNull();
      const failedHistory = useAppStore.getState().undoStack;
      expect(applySolidCommit(commit)).toBe(false);
      expect(useAppStore.getState().document).toBe(invalid);
      expect(useAppStore.getState().undoStack).toBe(failedHistory);
    } finally { bridge.dispose(); }
  }, 60_000);
});


import { documentSha, nativeHistoryHarness, shapeSha, holeWallCount,
  type HistoryOperation, type HistorySurface } from '../solid/holeThreadHistory.testSupport.js';

/** This uses the actual scheduler and native kernel; only delivery of a late reply is controlled. */
async function nativeCutHarness(kind: 'arc' | 'ellipse', scenario: 'intersecting' | 'separated' | 'touch-only' | 'inside-hole' = 'intersecting') {
  const native = await createInspectableNativeKernelForNodeTests(), bridge = native.bridge, value = expressionValueFromNumber;
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const common = { id: 'cut-blade', name: '切る曲線', planeId: 'xy', construction: false,
    center: absoluteCoordinate(scenario === 'separated' ? 50 : 5,
      scenario === 'separated' ? 50 : scenario === 'touch-only' ? -3 : scenario === 'inside-hole' ? 5 : 0, 0),
    startAngle: value(0), endAngle: value(scenario === 'inside-hole' ? 360 : 180) };
  const conic = kind === 'arc' ? { ...common, kind, radius: value(scenario === 'inside-hole' ? 1 : 3) }
    : { ...common, kind, majorRadius: value(4), minorRadius: value(2), rotation: value(0) };
  let document = appendSolid(replaceSketch(empty, appendFeature(sketch, conic)), {
    id: 'cut-stock', name: '箱', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(5, 5, 5) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(10), sizeY: value(10), sizeZ: value(10) },
  });
  if (scenario === 'inside-hole') {
    document = replaceSketch(document, appendFeature(document.sketches[0], {
      id: 'cut-face', name: '穴内の輪郭', kind: 'face', planeId: 'xy', color: DEFAULT_FACE_COLOR,
      boundary: [{ featureId: 'cut-blade' }],
    }));
    document = appendSolid(appendSolid(document, {
      id: 'existing-hole-tool', name: '既存穴の工具', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(5, 5, -1) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'cylinder', radius: value(2), height: value(12) },
    }), { id: 'cut-stock-hole', name: '穴のある箱', kind: 'boolean', suppressed: false,
      operation: 'subtract', targetFeatureId: 'cut-stock', toolFeatureId: 'existing-hole-tool' });
  }
  const targetId = scenario === 'inside-hole' ? 'cut-stock-hole' : 'cut-stock';
  useAppStore.getState().applyDocument(document, { opensDocument: true });
  let holdNext = false;
  const held: { readonly result: Promise<PartRecomputeResult>; readonly release: () => Promise<void> }[] = [];
  const results: PartRecomputeResult[] = [];
  const detach = attachPartRecompute((candidate, options) => {
    const delayed = holdNext; holdNext = false;
    // A successful native answer must still be discarded after cancellation or a new owner.
    const result = recomputePart(candidate, bridge, delayed ? { ...options, shouldCancel: () => false } : options)
      .then(computed => { results.push(computed); return computed; });
    if (!delayed) return result;
    return new Promise<PartRecomputeResult>(resolve => {
      held.push({ result, release: async () => { resolve(await result); } });
    });
  });
  async function settled(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAppStore.getState().isComputing).toBe(false);
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(useAppStore.getState().requestedGeneration).toBe(useAppStore.getState().completedGeneration);
    }, { timeout: 60_000 });
  }
  try { await settled(); } catch (error: unknown) { detach(); native.dispose(); throw error; }
  const targetKey = resolvePart(document).steps.find(step => step.featureId === targetId)?.key;
  if (targetKey === undefined) { detach(); native.dispose(); throw new Error('Missing cut target key'); }
  const borrowed = native.inspectShape(targetKey);
  function begin(bladeId = scenario === 'inside-hole' ? 'cut-face' : 'cut-blade'): SolidInputCommit {
    useAppStore.getState().setActiveTool('cut');
    useAppStore.getState().setSelection([targetId, bladeId]);
    const input = toggleNumericInput(chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', 'profile'), 'cutKeepBoth');
    useAppStore.getState().updateNumericInput(input);
    return { kind: 'solid', tool: 'cut', step: 'cutPlane', values: {}, flags: { cutKeepBoth: true },
      shapeChoices: { cutPlaneKind: 'profile' } };
  }
  return { document, borrowed, results, held, begin, settled, holdNext: () => { holdNext = true; },
    dispose: () => { detach(); native.dispose(); } };
}

describe('EX-04.UNDO 不足する片側と斜め平面の実形状履歴', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  it.each([
    { kind: 'plane', both: false, inside: 500 },
    { kind: 'plane', both: true, inside: 500 },
    { kind: 'arc', both: false, inside: 45 * Math.PI },
    { kind: 'ellipse', both: false, inside: 40 * Math.PI },
  ] as const)('$kind both=$both: 1回のUndo/Redoで元ID・参照・shape bytesを復帰する', async ({ kind, both, inside }) => {
    // Plane cuts reuse the same real stock; its unselected curve is not the blade.
    const harness = await nativeCutHarness(kind === 'plane' ? 'arc' : kind);
    try {
      let commit: SolidInputCommit;
      if (kind === 'plane') {
        useAppStore.getState().setActiveTool('cut');
        useAppStore.getState().setSelection(['cut-stock']);
        let input = toggleNumericInput(chooseNumericInput(createNumericInput('cut', 'cutPlane'),
          'cutPlaneKind', 'pointAndAxis'), 'cutPointByCoordinate');
        if (both) input = toggleNumericInput(input, 'cutKeepBoth');
        useAppStore.getState().updateNumericInput(input);
        commit = { kind: 'solid', tool: 'cut', step: 'cutPlane',
          values: { cutPointX: expressionValueFromNumber(5), cutPointY: expressionValueFromNumber(5),
            cutPointZ: expressionValueFromNumber(5), cutTilt: { source: '15*2', value: 30, display: '30' } },
          flags: { cutPointByCoordinate: true, cutKeepBoth: both }, shapeChoices: { cutPlaneKind: 'pointAndAxis' } };
      } else {
        const drafted = harness.begin();
        const input = useAppStore.getState().numericInput;
        if (input === null) throw new Error('Missing cut input');
        useAppStore.getState().updateNumericInput(toggleNumericInput(input, 'cutKeepBoth'));
        commit = { ...drafted, flags: { cutKeepBoth: false } };
      }
      const before = useAppStore.getState(), originalShape = shapeSha();
      expect(applySolidCommit(commit)).toBe(false);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
      await harness.settled();
      const after = useAppStore.getState();
      const cuts = after.document.solids.filter(feature => feature.kind === 'cut' || feature.kind === 'surfaceCut');
      expect(cuts).toHaveLength(both ? 2 : 1);
      expect(cuts.every(feature => feature.kind === (kind === 'plane' ? 'cut' : 'surfaceCut'))).toBe(true);
      expect(after.bodies.map(body => body.featureId)).toEqual(cuts.map(feature => feature.id));
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(after.undoStack.future).toHaveLength(0);
      expect(after.selection).toEqual([cuts[0].id]);
      if (kind === 'plane') {
        const planeCut = cuts[0];
        if (planeCut.kind !== 'cut' || planeCut.plane.kind !== 'pointAndAxis') throw new Error('Expected tilted plane');
        expect(planeCut.plane.tilt).toEqual({ source: '15*2', value: 30, display: '30' });
        expect(after.document.references.length).toBe(before.document.references.length + 1);
      }
      for (const [index, body] of after.bodies.entries()) {
        const expected = cuts[index].keep === 'negative' ? inside : 1000 - inside;
        expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
        expect(Math.abs((body.volume ?? Number.NaN) - expected) / expected).toBeLessThanOrEqual(1e-9);
      }
      if (both) expect(Math.abs(after.bodies.reduce((sum, body) => sum + (body.volume ?? Number.NaN), 0) - 1000) / 1000).toBeLessThanOrEqual(1e-9);
      const acceptedShape = shapeSha(), ids = cuts.map(feature => feature.id);
      after.undo(); expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().document.references).toBe(before.document.references);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      await harness.settled(); expect(shapeSha()).toBe(originalShape);
      useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after.document);
      expect(useAppStore.getState().document.references).toBe(after.document.references);
      expect(useAppStore.getState().document.sketches).toBe(after.document.sketches);
      expect(useAppStore.getState().document.solids).toBe(after.document.solids);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      await harness.settled(); expect(shapeSha()).toBe(acceptedShape);
      expect(useAppStore.getState().bodies.map(body => body.featureId)).toEqual(ids);
    } finally { harness.dispose(); }
  }, 180_000);
});

describe('EX-04.02 切断の実stagerは成功した形を1回だけ採用する', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  it.each([
    { kind: 'arc', caller: 'transition', inside: 45 * Math.PI },
    { kind: 'ellipse', caller: 'direct', inside: 40 * Math.PI },
  ] as const)('$kind / $caller: 計算中の保持と成功・保存・Undo/Redo', async ({ kind, caller, inside }) => {
    const harness = await nativeCutHarness(kind);
    try {
      const commit = harness.begin(), before = useAppStore.getState(), originalShape = shapeSha();
      if (caller === 'direct') expect(applySolidCommit(commit)).toBe(false);
      else {
        if (before.numericInput === null) throw new Error('Missing cut input');
        applyNumericTransition({ kind: 'solidCommitted', state: before.numericInput, commit });
      }
      const pending = useAppStore.getState();
      expect(pending.document).toBe(before.document); expect(pending.undoStack).toBe(before.undoStack);
      expect(pending.selection).toBe(before.selection); expect(pending.numericInput).toBe(before.numericInput);
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
      await harness.settled();
      const after = useAppStore.getState(), cuts = after.document.solids.filter(feature => feature.kind === 'surfaceCut');
      expect(cuts).toHaveLength(2); expect(after.bodies.map(body => body.featureId)).toEqual(cuts.map(cut => cut.id));
      expect(after.document.sketches).toBe(before.document.sketches);
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(after.selection).toEqual([cuts[0].id]); expect(after.activeTool).toBe('select');
      for (const [index, body] of after.bodies.entries()) {
        const expected = cuts[index].keep === 'negative' ? inside : 1000 - inside;
        expect(body.volume).toBeDefined();
        expect(Math.abs((body.volume ?? Number.NaN) - expected) / expected).toBeLessThanOrEqual(1e-9);
        expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
      }
      const reopened = parseDocument(serializeDocument(after.document));
      if (!reopened.ok) throw new Error(reopened.error.code);
      expect(reopened.document.solids).toEqual(after.document.solids);
      expect(reopened.document.sketches).toEqual(after.document.sketches);
      const finalShape = shapeSha();
      after.undo(); expect(useAppStore.getState().document).toBe(before.document);
      await harness.settled(); expect(shapeSha()).toBe(originalShape);
      useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after.document);
      await harness.settled(); expect(shapeSha()).toBe(finalShape);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    } finally { harness.dispose(); }
  }, 180_000);

  it.each([
    { scenario: 'separated', reason: 'no-intersection' },
    { scenario: 'touch-only', reason: 'touch-only' },
    { scenario: 'inside-hole', reason: null },
  ] as const)('$scenario: 実native拒否で文書・履歴・選択・借用形を保ち、Undo/Redo各1回も保つ', async ({ scenario, reason }) => {
    const harness = await nativeCutHarness('arc', scenario);
    try {
      // Give rejection a real pre-existing history step; an empty Undo stack would hide corruption.
      useAppStore.getState().applyDocument({ ...harness.document, name: '拒否前の正常な変更' });
      await harness.settled();
      const commit = harness.begin(), before = useAppStore.getState(), shape = shapeSha(), sha = documentSha(before.document);
      const borrowedBytes = harness.borrowed.readBrepBytes();
      expect(before.undoStack.past).toHaveLength(1);
      expect(before.undoStack.future).toHaveLength(0);
      if (scenario === 'inside-hole') {
        expect(before.bodies).toHaveLength(1);
        expect(before.bodies[0].volume).toBeCloseTo(1000 - 40 * Math.PI, 6);
      }
      expect(applySolidCommit(commit)).toBe(false);
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); }, { timeout: 60_000 });
      const after = useAppStore.getState(), errors = harness.results.at(-1)?.errors;
      if (reason !== null) expect(errors?.some(error => 'reason' in error && error.reason === reason)).toBe(true);
      else expect(errors?.some(error => error.message ===
        '切る輪郭が立体に届かず、何も削れませんでした。輪郭の位置や大きさを見直してください。')).toBe(true);
      expect(after.document).toBe(before.document);
      expect(documentSha(after.document)).toBe(sha);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length);
      expect(after.undoStack.future).toHaveLength(before.undoStack.future.length);
      expect(after.selection).toBe(before.selection);
      expect(after.bodies).toBe(before.bodies);
      expect(shapeSha()).toBe(shape);
      expect(harness.borrowed.readBrepBytes()).toEqual(borrowedBytes);
      expect(after.numericInput).toBe(before.numericInput);
      expect(after.stagedSolid?.errors[0]?.message.length).toBeGreaterThan(0);
      after.undo();
      expect(useAppStore.getState().document).toBe(harness.document);
      expect(useAppStore.getState().undoStack.past).toHaveLength(0);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      await harness.settled();
      expect(shapeSha()).toBe(shape);
      expect(harness.borrowed.readBrepBytes()).toEqual(borrowedBytes);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      await harness.settled();
      expect(shapeSha()).toBe(shape);
      expect(harness.borrowed.readBrepBytes()).toEqual(borrowedBytes);
    } finally { harness.dispose(); }
  }, 90_000);

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '公開cutPositionが%sなら確定せず、文書・履歴・選択・借用形を変えない', async position => {
      const harness = await nativeCutHarness('arc');
      try {
        harness.begin();
        useAppStore.getState().setSelection(['cut-stock']);
        useAppStore.getState().updateNumericInput(chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', 'axisZ'));
        const before = useAppStore.getState(), sha = documentSha(before.document), shape = shapeSha();
        const borrowedBytes = harness.borrowed.readBrepBytes();
        const commit: SolidInputCommit = { kind: 'solid', tool: 'cut', step: 'cutPlane',
          values: { cutPosition: expressionValueFromNumber(position) }, flags: {}, shapeChoices: { cutPlaneKind: 'axisZ' } };
        expect(applySolidCommit(commit)).toBe(false);
        const after = useAppStore.getState();
        expect(after.solidErrorKey).toBe('cutError.expressionInvalid');
        expect(after.document).toBe(before.document);
        expect(documentSha(after.document)).toBe(sha);
        expect(after.undoStack).toBe(before.undoStack);
        expect(after.undoStack.past).toHaveLength(before.undoStack.past.length);
        expect(after.undoStack.future).toHaveLength(before.undoStack.future.length);
        expect(after.selection).toBe(before.selection);
        expect(after.numericInput).toBe(before.numericInput);
        expect(shapeSha()).toBe(shape);
        expect(harness.borrowed.readBrepBytes()).toEqual(borrowedBytes);
      } finally { harness.dispose(); }
    }, 90_000);

  it('公開モデルの自己交差輪郭を確定しても、文書・履歴・選択・借用形を変えない', async () => {
    const harness = await nativeCutHarness('arc');
    try {
      const points = [[1, 1], [9, 9], [9, 1], [1, 9]] as const;
      let sketch = harness.document.sketches[0];
      for (const [index, point] of points.entries()) {
        const next = points[(index + 1) % points.length];
        sketch = appendFeature(sketch, { id: `bow-${index}`, name: '交差線', kind: 'line', planeId: 'xy', construction: false,
          from: absoluteCoordinate(point[0], point[1], 0), to: absoluteCoordinate(next[0], next[1], 0) });
      }
      sketch = appendFeature(sketch, { id: 'bow-face', name: '自己交差輪郭', kind: 'face', planeId: 'xy',
        color: DEFAULT_FACE_COLOR, boundary: points.map((_, index) => ({ featureId: `bow-${index}` })) });
      useAppStore.getState().applyDocument(replaceSketch(harness.document, sketch));
      await vi.waitFor(() => {
        expect(useAppStore.getState().isComputing).toBe(false);
        expect(useAppStore.getState().requestedGeneration).toBe(useAppStore.getState().completedGeneration);
      }, { timeout: 60_000 });
      const commit = harness.begin('bow-face'), before = useAppStore.getState();
      const sha = documentSha(before.document), shape = shapeSha(), borrowedBytes = harness.borrowed.readBrepBytes();
      expect(before.bodies).toHaveLength(1);
      expect(applySolidCommit(commit)).toBe(false);
      const after = useAppStore.getState();
      expect(after.solidErrorKey).toBe('cutError.profileSelfIntersects');
      expect(after.document).toBe(before.document);
      expect(documentSha(after.document)).toBe(sha);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length);
      expect(after.undoStack.future).toHaveLength(before.undoStack.future.length);
      expect(after.selection).toBe(before.selection);
      expect(after.numericInput).toBe(before.numericInput);
      expect(shapeSha()).toBe(shape);
      expect(harness.borrowed.readBrepBytes()).toEqual(borrowedBytes);
    } finally { harness.dispose(); }
  }, 90_000);

  it.each(['cancelled', 'new-owner'] as const)('%s: 遅れたnative成功を採用しない', async scenario => {
    const harness = await nativeCutHarness('arc');
    try {
      const commit = harness.begin(), before = useAppStore.getState();
      harness.holdNext();
      if (before.numericInput === null) throw new Error('Missing cut input');
      applyNumericTransition({ kind: 'solidCommitted', state: before.numericInput, commit });
      expect(harness.held).toHaveLength(1);
      const late = await harness.held[0].result;
      expect(late.errors).toEqual([]); expect(late.cancelled).toBe(false); expect(late.bodies).toHaveLength(2);
      if (scenario === 'cancelled') applyNumericTransition({ kind: 'cancelled' });
      else useAppStore.getState().applyDocument({ ...before.document, name: '別の所有者' }, { opensDocument: true });
      const retained = useAppStore.getState();
      await harness.held[0].release();
      await harness.settled();
      const after = useAppStore.getState();
      expect(currentStagedSolid(after)).toBeNull();
      if (scenario === 'cancelled') expect(after.stagedSolid).toBeNull();
      else if (after.stagedSolid !== null) expect(after.partStager?.owns(after.stagedSolid)).toBe(false);
      expect(after.document).toBe(retained.document); expect(after.undoStack).toBe(retained.undoStack);
      expect(after.selection).toEqual(retained.selection);
      expect(after.document.solids.some(feature => feature.kind === 'surfaceCut')).toBe(false);
      if (scenario === 'cancelled') {
        expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
        expect(after.selection).toBe(before.selection); expect(shapeSha()).toBe(shapeSha(before.bodies));
      } else expect(after.activeDocumentId).not.toBe(before.activeDocumentId);
    } finally { harness.dispose(); }
  }, 90_000);
});

describe('EX-05 machining creation uses native results and one store history step', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  const cases: readonly [HistorySurface, HistoryOperation][] = [
    ['plane', 'through'], ['plane', 'blind'], ['plane', 'thread'], ['plane', 'counterbore'],
    ['cylinder', 'through'], ['cylinder', 'blind'], ['cylinder', 'thread'], ['cylinder', 'counterbore'],
  ];
  it.each(cases)('%s %s: confirm, Undo once, Redo once preserve definitions, IDs and native holes', async (surface, operation) => {
    const harness = await nativeHistoryHarness(surface);
    try {
      const commit = harness.begin(operation);
      const before = useAppStore.getState();
      const beforeDefinitions = structuredClone(before.document);
      const beforeShape = shapeSha();
      harness.confirm(commit);
      await harness.committed();
      const after = useAppStore.getState();
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(after.document.solids).toHaveLength(before.document.solids.length + 1);
      const feature = after.document.solids.at(-1);
      if (feature?.kind !== 'hole' && feature?.kind !== 'threadHole') throw new Error('Missing machining feature');
      expect(feature.depth).toEqual(commit.flags.through ? { kind: 'through' } : { kind: 'blind', depth: commit.values.depth });
      if (feature.kind === 'hole') expect(feature.diameter).toEqual(commit.values.diameter);
      else {
        expect(feature.threadLength).toEqual(commit.values.threadLength);
        expect(feature.representation).toBe('simplified');
      }
      if (surface === 'cylinder') expect(feature.cylindrical?.locations).toEqual([
        { height: commit.values.holeCylinderHeight, angle: commit.values.holeCylinderAngle },
      ]);
      if (operation === 'counterbore') expect(feature.entry).toEqual({ kind: 'counterbore',
        diameter: commit.values.counterboreDiameter, depth: commit.values.counterboreDepth });
      expect(after.bodies).toHaveLength(1);
      const radius = feature.kind === 'hole' ? 3 : feature.drillDiameter.value / 2;
      const walls = holeWallCount(after.bodies[0], radius);
      expect(walls).toBe(1);
      expect(after.bodies[0].volume).toBeLessThan(before.bodies[0].volume);
      const afterDefinitions = structuredClone(after.document), afterSha = documentSha(after.document);
      const afterShape = shapeSha(), volume = after.bodies[0].volume;
      after.undo();
      expect(useAppStore.getState().document).toEqual(beforeDefinitions);
      expect(documentSha(useAppStore.getState().document)).toBe(documentSha(before.document));
      await harness.settled();
      expect(shapeSha()).toBe(beforeShape);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toEqual(afterDefinitions);
      expect(documentSha(useAppStore.getState().document)).toBe(afterSha);
      await harness.settled();
      expect(useAppStore.getState().bodies[0].volume).toBeCloseTo(volume, 7);
      expect(holeWallCount(useAppStore.getState().bodies[0], radius)).toBe(walls);
      expect(shapeSha()).toBe(afterShape);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    } finally { harness.dispose(); }
  }, 180_000);

  it.each(['blind', 'thread'] as const)('%s: native kernel refusal leaves document SHA, mesh signature and history unchanged', async operation => {
    const harness = await nativeHistoryHarness('plane', true);
    try {
      const commit = harness.begin(operation), before = useAppStore.getState();
      const sha = documentSha(before.document), shape = shapeSha();
      harness.confirm(commit);
      await vi.waitFor(() => { expect(harness.results).toHaveLength(2); }, { timeout: 90_000 });
      const refused = harness.results[1];
      expect(refused.cancelled).toBe(false);
      expect(refused.errors.some(error => error.code === 'kernelFailed')).toBe(true);
      expect(documentSha(useAppStore.getState().document)).toBe(sha);
      expect(useAppStore.getState().document).toEqual(before.document);
      expect(shapeSha()).toBe(shape);
      expect(useAppStore.getState().bodies).toBe(before.bodies);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().numericInput).toBe(before.numericInput);
      expect(useAppStore.getState().stagedSolid?.status).toBe('failed');
    } finally { harness.dispose(); }
  }, 180_000);
});

describe('EX-05 machining confirmation restores the normal tool state', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);

  it('holes and threads close input and select the created solid with and without a scheduler', async () => {
    for (const operation of ['blind', 'thread'] as const) {
      for (const staged of [false, true]) {
        resetTestStore();
        const harness = await nativeHistoryHarness('plane');
        if (!staged) harness.dispose();
        try {
          expect(useAppStore.getState().partStager !== null).toBe(staged);
          const commit = harness.begin(operation);
          const before = useAppStore.getState();
          expect(before.numericInput?.step).toBe(commit.step);
          expect(before.activeTool).toBe(commit.tool);
          expect(before.selection.length).toBeGreaterThan(0);
          harness.confirm(commit);
          if (staged) {
            // Computing keeps the existing input, selection and history until success.
            const pending = useAppStore.getState();
            expect(pending.numericInput).toBe(before.numericInput);
            expect(pending.activeTool).toBe(commit.tool);
            expect(pending.selection).toEqual(before.selection);
            expect(pending.document).toBe(before.document);
            expect(pending.undoStack).toBe(before.undoStack);
            await harness.committed();
          }
          const after = useAppStore.getState();
          const feature = after.document.solids.at(-1);
          expect(feature?.kind).toBe(commit.tool);
          expect(after.numericInput).toBeNull();
          expect(after.activeTool).toBe('select');
          expect(after.selection).toEqual([feature?.id]);
          expect(after.solidErrorKey).toBeNull();
          expect(after.document.solids).toHaveLength(before.document.solids.length + 1);
          expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
          after.undo();
          expect(useAppStore.getState().document).toEqual(before.document);
          if (staged) await harness.settled();
        } finally {
          if (staged) harness.dispose();
        }
      }
    }
  }, 180_000);
});
