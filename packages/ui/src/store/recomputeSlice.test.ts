import { expressionValueFromNumber } from '@pointercad/expression';
/** 再計算・進捗。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createAssemblyDocument,
  createEmptyPartDocument,
  createPrimitiveFeature,
  createDirectKernelBridge,
  recomputePart,
  documentUpTo,
  createPointFeature,
  type PartDocument,
  type PartRecomputeResult,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  attachPartRecompute,
} from './attachKernel.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { captureSolidMeshAdmission, isSolidMeshAdmissionCurrent } from '../viewport/solidMeshAdmission.js';
import {
  accountingSnapshot,
  captureStagedSolidOwnership,
  currentStagedSolid,
  isStagedSolidOwnershipCurrent,
  type PartStager,
  type StagedSolidState,
} from './recomputeSlice.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  createFakeRecompute,
  resultFor,
  tick,
  documentWithPoint,
  partWithPoint,
  extrudeFeature,
  bodyFor,
} from './testing/createTestStore.js';

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({
    requestedGeneration: 0,
    completedGeneration: 0,
    lastOutcome: 'idle',
    meshJsAccounting: null,
    partStager: null,
    stagedSolid: null,
  });
});

describe('段階計算の所有と、1回きりの採用の札', () => {
  /** 手立ての偽物が持つ、成功した段階計算 1 つ(計算の順番の持ち主の検査は extrudePreview.test.ts)。 */
  function stagedFixture(status: StagedSolidState['status'] = 'ready') {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('first')));
    // 段階計算は開いている入力の窓のもの。
    useAppStore.setState({ numericInput: createNumericInput('extrude', 'extrudeDistance') });
    let owned: StagedSolidState | null = null;
    const stager: PartStager = { stage: () => null, confirm: () => 'refused', cancel: () => undefined,
      owns: (staged) => staged === owned };
    useAppStore.getState().setPartStager(stager);
    const state = useAppStore.getState();
    const ownership = captureStagedSolidOwnership(state, stager, 1);
    if (ownership === null) throw new Error('A part document with this stager must be ownable');
    const prepared = appendSolid(state.document, extrudeFeature('extrude-new'));
    const result: PartRecomputeResult = { ...resultFor(prepared), generation: 5,
      bodies: [bodyFor('first'), bodyFor('extrude-new')] };
    const staged: StagedSolidState = Object.freeze({ ownership, fingerprint: 'k', finalFeatureId: 'extrude-new',
      placement: { document: prepared, timelineIndex: null, inserted: false }, displayed: prepared, status,
      result: status === 'ready' ? result : null, accounting: null, wholeGeneration: null, errors: [], errorMessage: null,
      failure: status === 'failed' ? 'failed' : null, confirmRequested: true });
    owned = staged;
    useAppStore.getState().publishStagedSolid(staged);
    return { stager, staged, base: state.document, prepared, result };
  }

  it.each(['document', 'undoStack', 'activeDocumentId', 'timelineIndex', 'selection', 'importedShapes',
    'importedMeshes', 'cancelRequestCount', 'stager', 'assembly', 'numericInput', 'numericInputRevision'] as const)('%s が変われば今の段階計算ではない', (field) => {
    const { staged } = stagedFixture();
    const state = useAppStore.getState();
    expect(currentStagedSolid(state)).toBe(staged);
    const changed = field === 'document' ? { ...state, document: { ...state.document } }
      : field === 'undoStack' ? { ...state, undoStack: { ...state.undoStack } }
      : field === 'activeDocumentId' ? { ...state, activeDocumentId: 'other-session' }
      : field === 'timelineIndex' ? { ...state, timelineIndex: 0 }
      : field === 'selection' ? { ...state, selection: [...state.selection] }
      : field === 'importedShapes' ? { ...state, importedShapes: new Map(state.importedShapes) }
      : field === 'importedMeshes' ? { ...state, importedMeshes: new Map(state.importedMeshes) }
      : field === 'cancelRequestCount' ? { ...state, cancelRequestCount: state.cancelRequestCount + 1 }
      : field === 'stager' ? { ...state, partStager: null }
      : field === 'numericInput' ? { ...state, numericInput: null }
      : field === 'numericInputRevision' ? { ...state, numericInputRevision: state.numericInputRevision + 1 }
      : { ...state, assembly: createAssemblyDocument('assembly') };
    expect(isStagedSolidOwnershipCurrent(changed, staged.ownership)).toBe(false);
    expect(currentStagedSolid(changed)).toBeNull();
  });

  it('手立てが手放した段階計算は、所有の欄が同じでも今のものではない', () => {
    const { staged } = stagedFixture();
    const state = useAppStore.getState();
    expect(currentStagedSolid({ ...state, stagedSolid: { ...staged } })).toBeNull();
  });

  it('札は1回きりで、別の手立ての札では採用しない。採用は文書・Undo1段・形・世代を一緒に反映する', () => {
    const { stager, staged, base, prepared, result } = stagedFixture();
    const pastLength = useAppStore.getState().undoStack.past.length;
    const foreign: PartStager = { ...stager, owns: () => true };
    expect(useAppStore.getState().adoptStagedSolid({ stager: foreign, staged })).toBe(false);
    expect(useAppStore.getState().document).toBe(base);
    const ticket = { stager, staged };
    expect(useAppStore.getState().adoptStagedSolid(ticket)).toBe(true);
    const after = useAppStore.getState();
    expect(after.document).toBe(prepared);
    expect(after.undoStack.past).toHaveLength(pastLength + 1);
    expect(after.undoStack.past[pastLength]).toBe(base);
    expect(after.bodies).toBe(result.bodies);
    expect(after.requestedGeneration).toBe(5);
    expect(after.completedGeneration).toBe(5);
    expect(after.lastOutcome).toBe('success');
    expect(after.isComputing).toBe(false);
    expect(after.stagedSolid).toBeNull();
    expect(useAppStore.getState().adoptStagedSolid(ticket)).toBe(false);
    expect(useAppStore.getState().undoStack.past).toHaveLength(pastLength + 1);
    expect(useAppStore.getState().document).toBe(prepared);
  });

  it.each(['pending', 'failed'] as const)('%s の段階計算は採用しない(何も変えない)', (status) => {
    const { stager, staged, base } = stagedFixture(status);
    const before = useAppStore.getState();
    expect(before.adoptStagedSolid({ stager, staged })).toBe(false);
    const after = useAppStore.getState();
    expect(after.document).toBe(base);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.requestedGeneration).toBe(before.requestedGeneration);
    expect(after.stagedSolid).toBe(staged);
  });
});

describe('request-local JS accounting adoption', () => {
  const reading = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130,
    cacheRetiredBytes: 110, cacheProtectedBytes: 240, retainedReplyBytes: 300,
    requestPeakReservedBytes: 1000 };
  function receipt(document: PartDocument, generation = 7): NonNullable<PartRecomputeResult['meshJsAccounting']> {
    return { documentId: document.id, partId: document.id, generation, reading: { ...reading } };
  }
  function complete(document: PartDocument, generation = 7): PartRecomputeResult {
    return { ...resultFor(document), generation, meshJsAccounting: receipt(document, generation) };
  }

  it.each([
    { failureAt: 'kernel', timelineIndex: null }, { failureAt: 'kernel', timelineIndex: 1 },
    { failureAt: 'model', timelineIndex: null }, { failureAt: 'model', timelineIndex: 1 },
  ] as const)('preserves a failed $failureAt result through the actual bridge, store and admission at $timelineIndex', async ({ failureAt, timelineIndex }) => {
    const empty = createEmptyPartDocument();
    const good = { ...createPrimitiveFeature(empty, 'box'), id: 'good' };
    const bad = { ...createPrimitiveFeature(empty, 'box'), id: 'bad', shape: {
      kind: 'box' as const, sizeX: expressionValueFromNumber(failureAt === 'model' ? -1 : 10),
      sizeY: expressionValueFromNumber(10), sizeZ: expressionValueFromNumber(10),
    } };
    const full = appendSolid(appendSolid(appendSolid(empty, good), bad),
      { ...createPrimitiveFeature(empty, 'box'), id: 'tail', suppressed: true });
    useAppStore.getState().applyDocument(full);
    useAppStore.getState().setTimelineIndex(timelineIndex);
    function unused(): never { throw new Error('Unused operation in mixed-result API fixture'); }
    // Actual direct bridge/conversion/model pipeline; only the native API reply is a controlled fixture.
    const bridge = createDirectKernelBridge({
      readCachedBodies: unused, functionSketchCurves: unused, tessellateSketch: unused,
      offsetSketchCurves: unused, projectSketchCurves: unused, sectionSketchCurves: unused,
      hiddenLineViews: unused, sectionViews: unused, measure: unused, exportShapes: unused,
      importShape: unused, inspectPrintability: unused,
      recomputeSolids(request) {
        const localMesh = request.localMesh;
        if (localMesh === undefined) throw new Error('Missing production local mesh policy');
        expect(request.steps.map(step => step.id)).toContain('good');
        expect(request.steps.some(step => step.id === 'bad')).toBe(failureAt === 'kernel');
        const body = bodyFor('good'), mesh = body.mesh;
        const bytes = mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength;
        return Promise.resolve({ bodies: [{ id: 'good', positions: mesh.positions, normals: mesh.normals,
          indices: mesh.indices, edgePositions: mesh.edgePositions, triangleCount: mesh.triangleCount,
          faceCount: 0, edgeCount: 0, volume: body.volume, bodyKind: 'solid' as const,
          faces: [], edges: [], vertices: [], threadMarks: [],
          coordinateFrame: { space: 'local' as const, origin: [1e9, 0, 0] as const, ...localMesh } }],
          failures: failureAt === 'kernel' ? [{ id: 'bad', message: 'independent geometry failed' }] : [],
          cacheHits: 0, cancelled: false,
          meshJsAccounting: { status: 'known' as const, limitBytes: localMesh.maximumLiveMeshBytes,
            cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
            retainedReplyBytes: bytes * 2, requestPeakReservedBytes: bytes * 2 },
          meshJsFinalAccounting: { status: 'known' as const, limitBytes: localMesh.maximumLiveMeshBytes,
            cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
            displayBackingBytes: bytes, replyBackingBytes: bytes, retainedBackingBytes: bytes, replyCloneReservedBytes: bytes },
        });
      },
    });
    const detach = attachPartRecompute((document, options) => recomputePart(document, bridge, options));
    try {
      await vi.waitFor(() => expect(useAppStore.getState().lastOutcome).toBe('failed'));
      const state = useAppStore.getState(), accounting = state.meshJsAccounting;
      expect(state.bodies.map(body => body.featureId)).toEqual(['good']);
      expect(state.partErrors.some(error => error.featureId === 'bad')).toBe(true);
      expect(state.completedGeneration).toBe(state.requestedGeneration);
      expect(accounting?.outcome).toBe('failed');
      expect(accounting?.document).toBe(full);
      expect(accounting?.timelineIndex).toBe(timelineIndex);
      expect(accounting?.receipt.final?.status).toBe('known');
      if (accounting === null) throw new Error('Missing mixed-result accounting');
      const admission = captureSolidMeshAdmission(state);
      expect(admission?.bodies).toBe(state.bodies);
      if (admission === null) throw new Error('Missing successful-subset admission');
      for (const changed of [
        { ...state, lastOutcome: 'success' as const },
        { ...state, lastOutcome: 'workerBroken' as const },
        { ...state, requestedGeneration: state.requestedGeneration + 1 },
        { ...state, timelineIndex: timelineIndex === null ? 1 : null },
        { ...state, activeDocumentId: 'other-session' },
        { ...state, document: { ...full, solids: [...full.solids] } },
        { ...state, meshJsAccounting: { ...accounting, receipt: { ...accounting.receipt, final: undefined } } },
      ]) {
        expect(isSolidMeshAdmissionCurrent(admission, changed)).toBe(false);
        expect(captureSolidMeshAdmission(changed)).toBeNull();
      }
      state.cancelRecompute();
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
      expect(captureSolidMeshAdmission(useAppStore.getState())).toBeNull();
    } finally { detach(); bridge.dispose(); }
  });

  it.each([0, 1e6, 1e9])('adopts a real timeline prefix at origin %s with final accounting and retires its ownership', origin => {
    const state = useAppStore.getState();
    const document = appendSolid(appendSolid(partWithPoint(), extrudeFeature('first')), extrudeFeature('second'));
    useAppStore.setState({ document, timelineIndex: 0 });
    const prefix = documentUpTo(document, 0);
    expect(prefix).not.toBe(document);
    expect(prefix.solids).toHaveLength(1);
    const final = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 0,
      cacheProtectedBytes: 130, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 190,
      replyCloneReservedBytes: 60 };
    const bodies = [{ ...bodyFor('first'), coordinateFrame: { space: 'local' as const,
      origin: [origin, 0, 0] as const, maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 1000 } }];
    const result: PartRecomputeResult = { ...complete(prefix), bodies,
      meshJsAccounting: { ...receipt(prefix), final } };
    state.recordRecomputeRequest(7);
    state.applyRecompute(prefix, result);
    state.recordRecomputeCompletion(7, 'success');
    const adopted = useAppStore.getState(), accounting = adopted.meshJsAccounting;
    expect(accounting?.document).toBe(document);
    expect(accounting?.timelineIndex).toBe(0);
    expect(accounting?.receipt.final).toEqual(final);
    const admission = captureSolidMeshAdmission(adopted);
    expect(admission?.bodies).toBe(bodies);
    if (admission === null) throw new Error('Missing prefix admission');
    expect(isSolidMeshAdmissionCurrent(admission, adopted)).toBe(true);
    expect(captureSolidMeshAdmission({ ...adopted, document: { ...document, name: 'appearance only' } })).not.toBeNull();
    for (const changed of [
      { ...adopted, timelineIndex: null },
      { ...adopted, document: { ...document, solids: [...document.solids] } },
      { ...adopted, requestedGeneration: 8 },
      { ...adopted, recomputeCancelled: true },
    ]) {
      expect(isSolidMeshAdmissionCurrent(admission, changed)).toBe(false);
      expect(captureSolidMeshAdmission(changed)).toBeNull();
    }
    // Missing final accounting is still inadmissible for a valid prefix.
    state.applyRecompute(prefix, { ...result, meshJsAccounting: receipt(prefix) });
    state.recordRecomputeCompletion(7, 'success');
    expect(captureSolidMeshAdmission(useAppStore.getState())).toBeNull();
    // A same-length prefix containing a different feature is never paired with this receipt.
    state.applyRecompute({ ...prefix, solids: [{ ...prefix.solids[0], name: 'different instance' }] }, result);
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
    state.applyRecompute(prefix, result);
    state.cancelRecompute();
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
    state.recordRecomputeRequest(8);
    state.applyRecompute(prefix, result);
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
  });

  it('copies a bounded receipt once and keeps the existing WASM lifetime separate', () => {
    const state = useAppStore.getState(), document = state.document;
    const kernelMemory = { usedBytes: 91, limitBytes: 100 };
    state.recordKernelMemory(kernelMemory);
    state.recordRecomputeRequest(7);
    const result = complete(document);
    state.applyRecompute(document, result);
    state.recordRecomputeCompletion(7, 'success');
    const snapshot = useAppStore.getState().meshJsAccounting;
    expect(snapshot?.document).toBe(document);
    expect(snapshot?.bodies).toBe(result.bodies);
    expect(snapshot?.activeDocumentId).toBe(useAppStore.getState().activeDocumentId);
    expect(snapshot?.receipt).toEqual(receipt(document));
    expect(snapshot?.receipt).not.toBe(result.meshJsAccounting);
    expect(snapshot?.receipt.reading).not.toBe(result.meshJsAccounting?.reading);
    expect(useAppStore.getState().kernelMemory).toEqual(kernelMemory);
    state.recordRecomputeRequest(8);
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
    state.applyRecompute(document, { ...resultFor(document), generation: 8 });
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
    expect(useAppStore.getState().kernelMemory).toEqual(kernelMemory);
  });

  it.each(['missing', 'unknown', 'cancelled', 'failed', 'oldResult', 'oldReceipt', 'otherDocument',
    'otherReceipt', 'history', 'changedShape', 'NaN', 'overflow', 'protected', 'peak'] as const)(
    'clears a previously known receipt for %s', scenario => {
      const state = useAppStore.getState();
      const document = appendSolid(appendSolid(state.document, extrudeFeature('first')), extrudeFeature('second'));
      useAppStore.setState({ document });
      state.recordRecomputeRequest(7);
      state.applyRecompute(document, complete(document));
      expect(useAppStore.getState().meshJsAccounting).not.toBeNull();
      let result = complete(document);
      let target = document;
      const base = receipt(document);
      if (scenario === 'missing') result = { ...resultFor(document), generation: 7 };
      if (scenario === 'unknown') result = { ...result, meshJsAccounting: { ...base,
        reading: { status: 'unknown', limitBytes: 1000, reason: 'missing-counts' } } };
      if (scenario === 'cancelled') result = { ...result, cancelled: true };
      if (scenario === 'failed') result = { ...result,
        errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: 'failed' }] };
      if (scenario === 'oldResult') result = { ...result, generation: 6 };
      if (scenario === 'oldReceipt') result = { ...result, meshJsAccounting: { ...base, generation: 6 } };
      if (scenario === 'otherDocument') target = { ...document, id: 'other' };
      if (scenario === 'otherReceipt') result = { ...result, meshJsAccounting: { ...base, documentId: 'other' } };
      if (scenario === 'history') useAppStore.setState({ timelineIndex: 0 });
      if (scenario === 'changedShape') target = { ...document, solids: [...document.solids] };
      if (scenario === 'NaN') result = { ...result, meshJsAccounting: { ...base,
        reading: { ...reading, cacheActiveBytes: NaN } } };
      if (scenario === 'overflow') result = { ...result, meshJsAccounting: { ...base,
        reading: { ...reading, cacheActiveBytes: Number.MAX_SAFE_INTEGER } } };
      if (scenario === 'protected') result = { ...result, meshJsAccounting: { ...base,
        reading: { ...reading, cacheProtectedBytes: 241 } } };
      if (scenario === 'peak') result = { ...result, meshJsAccounting: { ...base,
        reading: { ...reading, requestPeakReservedBytes: 539 } } };
      state.applyRecompute(target, result);
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
    },
  );

  it.each(['failed', 'workerBroken', 'cancelled'] as const)('clears at %s completion and immediate cancel', outcome => {
    const state = useAppStore.getState(), document = state.document;
    state.recordRecomputeRequest(7);
    state.applyRecompute(document, complete(document));
    state.recordRecomputeCompletion(7, outcome);
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
    state.applyRecompute(document, complete(document));
    state.cancelRecompute();
    expect(useAppStore.getState().meshJsAccounting).toBeNull();
  });

  it('a new request clears the snapshot before a delayed old receipt arrives', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      const first = fake.calls[0];
      first.settle(complete(first.document, first.options.generation));
      await tick();
      expect(useAppStore.getState().meshJsAccounting?.receipt.generation).toBe(1);
      useAppStore.getState().setSketch(documentWithPoint());
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
      const second = fake.calls[1];
      second.settle({ ...complete(second.document, second.options.generation),
        meshJsAccounting: receipt(first.document, 1) });
      await tick();
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
      expect(useAppStore.getState().completedGeneration).toBe(2);
      expect(useAppStore.getState().lastOutcome).toBe('success');
    } finally { detach(); }
  });

  it('copies a valid post-token union with the receipt and refuses an invalid one', () => {
    const state = useAppStore.getState(), document = state.document;
    const final = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130, cacheRetiredBytes: 0,
      cacheProtectedBytes: 130, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 190,
      replyCloneReservedBytes: 60 };
    state.recordRecomputeRequest(7);
    const result: PartRecomputeResult = { ...complete(document), meshJsAccounting: { ...receipt(document), final } };
    state.applyRecompute(document, result);
    const snapshot = useAppStore.getState().meshJsAccounting;
    expect(snapshot?.receipt.final).toEqual(final);
    expect(snapshot?.receipt.final).not.toBe(final);
    expect(Object.isFrozen(snapshot?.receipt.final)).toBe(true);
    for (const forged of [{ ...final, replyCloneReservedBytes: 0 }, { ...final, limitBytes: 999 },
      { ...final, cacheActiveBytes: 881, cacheProtectedBytes: 130, retainedBackingBytes: 941 }]) {
      state.recordRecomputeRequest(7);
      state.applyRecompute(document, { ...complete(document), meshJsAccounting: { ...receipt(document), final: forged } });
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
    }
  });

  it('pairs receipt with the exact adopted bodies and clears at body/session/history completion mismatch', () => {
    const state = useAppStore.getState(), document = state.document;
    for (const scenario of ['bodies', 'session', 'history'] as const) {
      useAppStore.setState({ timelineIndex: null, activeDocumentId: state.activeDocumentId });
      state.recordRecomputeRequest(7);
      const result = complete(document);
      state.applyRecompute(document, result);
      expect(useAppStore.getState().meshJsAccounting?.bodies).toBe(result.bodies);
      if (scenario === 'bodies') useAppStore.setState({ bodies: [...result.bodies] });
      if (scenario === 'session') useAppStore.setState({ activeDocumentId: 'different-session' });
      if (scenario === 'history') useAppStore.setState({ timelineIndex: 0 });
      state.recordRecomputeCompletion(7, 'success');
      expect(useAppStore.getState().meshJsAccounting).toBeNull();
    }
  });
});

describe('Workerで検証した数学係数の表示値', () => {
  it.each(['current', 'cancelled', 'generation', 'parameters', 'document'] as const)(
    '%sの結果は現在の文書と一致する場合だけ係数表へ反映する', (scenario) => {
      const state = useAppStore.getState(), document = state.document;
      const previous = state.parameterAnalysis;
      const analysis = { ...previous, variables: new Map([['検証済み', 42]]), nonLengthVariables: new Set(['検証済み']) };
      state.recordRecomputeRequest(7);
      const target = scenario === 'parameters' ? { ...document, parameters: [...document.parameters] }
        : scenario === 'document' ? { ...document, id: 'another-document' } : document;
      state.applyRecompute(target, { ...resultFor(document), parameterAnalysis: analysis,
        generation: scenario === 'generation' ? 6 : 7, cancelled: scenario === 'cancelled' });
      expect(useAppStore.getState().parameterAnalysis).toBe(scenario === 'current' ? analysis : previous);
      expect(useAppStore.getState().document).toBe(document);
      if (scenario === 'current') expect(useAppStore.getState().nonLengthVariables).toBe(analysis.nonLengthVariables);
    },
  );
});

describe('文書の変化に応じた再計算の予約(要件§6.3)', () => {
  it('つないだ直後に今の文書を1回計算し、結果を反映する', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document).toBe(useAppStore.getState().document);
    expect(fake.calls[0].options.generation).toBe(1);

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().documentName).toBe('スケッチ1');
    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().completedGeneration).toBe(
      useAppStore.getState().requestedGeneration,
    );
    expect(useAppStore.getState().lastOutcome).toBe('success');
    detach();
  });

  it('計算を1回終えると、幾何カーネルを読み込み終えたと記録する(§0.a-0.23 ⑨)', async () => {
    expect(useAppStore.getState().kernelLoaded).toBe(false);
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().kernelLoaded).toBe(true);
    detach();
  });

  it('文書が変わるたびに計算し、結果をストアへ入れる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].document).toBe(useAppStore.getState().document);
    // 世代番号は依頼のたびに 1 つ増える(古い応答を捨てる目印、NFR-PF-4)。
    expect(fake.calls[1].options.generation).toBe(2);

    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toEqual(['点1']);
    expect(useAppStore.getState().resolvedSketch.points).toHaveLength(1);
    detach();
  });

  it('計算中に続けて変えても重ねず、最後の文書だけを次に回す(連続入力)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const first = documentWithPoint();
    const second = appendFeature(first, createPointFeature(first, absoluteCoordinate(4, 5, 6)));
    const third = appendFeature(second, createPointFeature(second, absoluteCoordinate(7, 8, 9)));

    useAppStore.getState().setSketch(first);
    const started = useAppStore.getState().document;
    useAppStore.getState().setSketch(second);
    useAppStore.getState().setSketch(third);
    // 1 本目が終わるまでは次を始めない。
    expect(fake.calls).toHaveLength(2);

    fake.calls[1].settle(resultFor(started));
    await tick();

    // 間に挟まった second は捨て、最新の third だけを計算する。
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    expect(fake.calls[2].document.sketches[0]).toBe(third);
    // 途中の結果では計算中の札を下ろさない。
    expect(useAppStore.getState().isComputing).toBe(true);

    fake.calls[2].settle(resultFor(fake.calls[2].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toHaveLength(3);
    detach();
  });

  it('外した後は文書が変わっても計算しない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    detach();

    useAppStore.getState().setSketch(documentWithPoint());
    await tick();
    expect(fake.calls).toHaveLength(1);
  });

  it('計算が投げたら理由を出して計算中を下ろす(FR-504)', async () => {
    const detach = attachPartRecompute(() => Promise.reject(new Error('計算できません')));
    await tick();
    expect(useAppStore.getState().errorMessage).toBe('計算できません');
    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().completedGeneration).toBe(1);
    expect(useAppStore.getState().lastOutcome).toBe('failed');
    detach();
  });

  it('ボディと失敗と命中数を反映し、進捗は下ろす(FR-504、NFR-PF-3)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 1,
      label: '押し出しextrude-1',
    });
    expect(useAppStore.getState().recomputeProgress).not.toBeNull();

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
      errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
      cacheHits: 3,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0].featureId).toBe('extrude-1');
    expect(state.partErrors).toHaveLength(1);
    expect(state.cacheHits).toBe(3);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
    // ソリッドの失敗はスケッチの控えへ混ぜない(要素 id が違う)。
    expect(state.sketchErrors).toEqual([]);
  });

  it('スケッチの失敗はいま編集しているスケッチの控えへ写す(FR-504)', () => {
    const document = partWithPoint();
    const featureId = document.sketches[0].features[0].id;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      errors: [{ featureId, code: 'kernelFailed', message: '面を作れませんでした: 失敗' }],
    });

    const state = useAppStore.getState();
    expect(state.sketchErrors).toHaveLength(1);
    expect(state.sketchErrors[0].featureId).toBe(featureId);
    expect(state.sketchErrors[0].code).toBe('kernelFailed');
    expect(state.partErrors).toHaveLength(1);
  });
});

describe('進捗と中止(NFR-PF-4、§0.a-0.22)', () => {
  it('計算中の進み具合を受け取って持つ', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    fake.calls[0].options.onProgress?.({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });
    expect(useAppStore.getState().recomputeProgress).toEqual({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(useAppStore.getState().recomputeProgress).toBeNull();
    detach();
  });

  it('中止を頼むと、いま走っている計算の shouldCancel が立つ', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    const shouldCancel = fake.calls[0].options.shouldCancel;
    expect(shouldCancel?.()).toBe(false);
    useAppStore.getState().cancelRecompute();
    expect(shouldCancel?.()).toBe(true);
    detach();
  });

  it('次に始まる計算は前の中止を引きずらない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    useAppStore.getState().cancelRecompute();
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);

    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();
    useAppStore.getState().setSketch(documentWithPoint());

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.shouldCancel?.()).toBe(false);
    detach();
  });

  it('中止された結果では前のボディを消さない(半分だけの形を出さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
    });
    expect(useAppStore.getState().bodies).toHaveLength(1);

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [],
      cancelled: true,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
  });

  it('中止を頼んでいないときは何も起きない(例外にならない)', () => {
    useAppStore.getState().cancelRecompute();
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('起動直後は中止の知らせを持たない(タスク25)', () => {
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('中止で終わると知らせが立ち、進捗は下りる(NFR-PF-4、タスク25)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 3,
      label: '押し出し1',
    });

    useAppStore
      .getState()
      .applyRecompute(document, { ...resultFor(document), cancelled: true });

    const state = useAppStore.getState();
    expect(state.recomputeCancelled).toBe(true);
    expect(state.recomputeProgress).toBeNull();
    // 中止は失敗ではないので、赤い帯になる errorMessage は立てない。
    expect(state.errorMessage).toBeNull();
  });

  it('attachKernel で中止された世代は cancelled として完了する(P7 タスク52)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();

    const state = useAppStore.getState();
    expect(state.requestedGeneration).toBe(1);
    expect(state.completedGeneration).toBe(1);
    expect(state.lastOutcome).toBe('cancelled');
    detach();
  });

  it('最後まで走った計算が終わると中止の知らせは下りる', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().applyRecompute(document, resultFor(document));
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('文書が変わると中止の知らせは消える(時間では消さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().setSketch(documentWithPoint());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('元に戻す・やり直す・新しくやり直すでも中止の知らせは消える', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const document = useAppStore.getState().document;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().undo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().redo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });
});

it('snapshots main backing separately without rewriting the Worker receipt', () => {
  const document = useAppStore.getState().document;
  const buffer = new ArrayBuffer(64);
  const buffers = [buffer];
  const receipt = { documentId: document.id, partId: 'part', generation: 1, reading: {
    status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
    cacheProtectedBytes: 0, retainedReplyBytes: 0, requestPeakReservedBytes: 0 } };
  const result = { ...resultFor(document), generation: 1, meshJsAccounting: receipt,
    mainMeshBacking: { buffers, retainedBackingBytes: 64, limitBytes: 1064 } };
  const snapshot = accountingSnapshot(document, null, useAppStore.getState().activeDocumentId, result, receipt);
  buffers.push(new ArrayBuffer(128));
  expect(snapshot.mainMeshBacking?.buffers).toEqual([buffer]);
  expect(snapshot.mainMeshBacking?.retainedBackingBytes).toBe(64);
  expect(snapshot.receipt).toEqual(receipt);
  expect(snapshot.receipt.reading.limitBytes).toBe(1000);
});
