import { vi } from 'vitest';
import { prepareDocumentSession, SecurePartIdentityError } from './fileSlice.js';
/** 文書の種類。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  addComponent,
  createAssemblyDocument,
  createComponentFor,
  createEmptyPartDocument,
  resolveAssembly,
  type AssemblyInterferenceResult,
  type JointFrame,
  type AssemblyDocument,
  type MechanismGearCoupling,
  type MechanismCamCoupling,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  activeDocumentKind,
  activePartDocument,
} from './documentKind.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  tick,
} from './testing/createTestStore.js';
import { createMateDraft } from '../assembly/mateCommands.js';
import type { AssemblyInterferenceRunner } from '../assembly/interferenceActions.js';
import { t } from '../i18n/t.js';
import {
  DEFAULT_STANDARD_PART_PICKER,
} from '../assembly/standardPartPicker.js';

beforeEach(resetTestStore);

describe('EX12 immutable authored coupling edit', () => {
  function gears() {
    let base = createAssemblyDocument('gears');
    for (const name of ['ground', 'a', 'b', 'c']) {
      const component = createComponentFor(base, { kind: 'part', partRef: name }, { partName: name });
      base = addComponent(base, { ...component, fixed: name === 'ground' });
    }
    const ground = base.components[0];
    if (ground === undefined) throw new Error('fixture');
    const document: AssemblyDocument = { ...base, joints: base.components.slice(1).map((component, i) => ({
      id: `j${String(i)}`, name: component.name, kind: 'revolute',
      a: { kind: 'origin', componentId: component.id, element: 'origin' },
      b: { kind: 'origin', componentId: ground.id, element: 'origin' },
      minValue: null, maxValue: null, suppressed: false })) };
    const frame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    useAppStore.getState().openAssembly(document);
    const view = { sourceDocument: document, resolved: resolveAssembly(document), bodies: new Map(),
      appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      jointFrames: new Map(document.joints.map(j => [j.id, { a: frame, b: frame }])) };
    useAppStore.setState({ assemblyView: view });
    const coupling: MechanismGearCoupling = { id: 'gear-ab', kind: 'gear', jointAId: 'j0', jointBId: 'j1',
      ratio: expressionValueFromNumber(-2), phaseDeg: expressionValueFromNumber(0),
      referenceAngleA: 0, suppressed: false };
    return { document, view, coupling };
  }
  it('create/edit/remove commits one Undo each and retains authored expressions', () => {
    const f = gears();
    expect(useAppStore.getState().setAssemblyMechanismCouplings([f.coupling])).toBe(true);
    const created = useAppStore.getState().assembly;
    if (created === null) throw new Error('fixture');
    expect(created).not.toBe(f.document);
    expect(f.document.mechanismCouplings).toBeUndefined();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: created } });
    const edited = { ...f.coupling, ratio: { ...f.coupling.ratio, source: '-3', value: 999 } };
    expect(useAppStore.getState().setAssemblyMechanismCouplings([edited])).toBe(true);
    expect(useAppStore.getState().assembly?.mechanismCouplings?.[0].ratio.source).toBe('-3');
    expect(useAppStore.getState().setAssemblyMechanismCouplings([])).toBe(true);
    expect(useAppStore.getState().assembly?.mechanismCouplings).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mechanismCouplings?.[0].ratio.source).toBe('-3');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mechanismCouplings?.[0].ratio.source).toBe('-2');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.document);
  });
  it('refuses invalid expressions, stale view and contradictory loop without document or Undo mutation', () => {
    const f = gears(), before = useAppStore.getState();
    const invalid = { ...f.coupling, ratio: { ...f.coupling.ratio, source: 'undefinedRatio' } };
    expect(before.setAssemblyMechanismCouplings([invalid])).toBe(false);
    const ab = { ...f.coupling, ratio: expressionValueFromNumber(1) };
    const bc = { ...ab, id: 'gear-bc', jointAId: 'j1', jointBId: 'j2' };
    const ac = { ...ab, id: 'gear-ac', jointBId: 'j2', phaseDeg: expressionValueFromNumber(10) };
    expect(before.setAssemblyMechanismCouplings([ab, bc, ac])).toBe(false);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: { ...f.document } } });
    expect(before.setAssemblyMechanismCouplings([f.coupling])).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
  });
});

describe('EX12 immutable authored cam-follower edit', () => {
  /** Cam revolute and follower slider share the fixed ground; the follower's slider origin is the roller centre. */
  function cams(followerX = 29) {
    let base = createAssemblyDocument('cams');
    for (const name of ['ground', 'cam', 'follower']) {
      const component = createComponentFor(base, { kind: 'part', partRef: name }, { partName: name });
      base = addComponent(base, { ...component, fixed: name === 'ground', placement: { ...component.placement,
        position: [expressionValueFromNumber(name === 'follower' ? followerX : 0), expressionValueFromNumber(0), expressionValueFromNumber(0)] } });
    }
    const [ground, cam, follower] = base.components;
    if (ground === undefined || cam === undefined || follower === undefined) throw new Error('fixture');
    const document: AssemblyDocument = { ...base, joints: [
      { id: 'jc', name: 'cam', kind: 'revolute', a: { kind: 'origin', componentId: cam.id, element: 'origin' },
        b: { kind: 'origin', componentId: ground.id, element: 'origin' }, minValue: null, maxValue: null, suppressed: false },
      { id: 'jf', name: 'follower', kind: 'slider', a: { kind: 'origin', componentId: follower.id, element: 'origin' },
        b: { kind: 'origin', componentId: ground.id, element: 'origin' }, minValue: null, maxValue: null, suppressed: false }] };
    const camFrame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const sliderFrame: JointFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
    useAppStore.getState().openAssembly(document);
    const view = { sourceDocument: document, resolved: resolveAssembly(document), bodies: new Map(),
      appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      jointFrames: new Map([['jc', { a: camFrame, b: camFrame }], ['jf', { a: sliderFrame, b: sliderFrame }]]) };
    useAppStore.setState({ assemblyView: view });
    // R 20, e 5, r 4, phase 0: the roller centre is 29 mm from the cam axis at the authored cam angle 0.
    const coupling: MechanismCamCoupling = { id: 'cam-1', kind: 'cam', camJointId: 'jc', followerJointId: 'jf',
      discRadiusMm: expressionValueFromNumber(20), eccentricityMm: expressionValueFromNumber(5),
      rollerRadiusMm: expressionValueFromNumber(4), phaseDeg: expressionValueFromNumber(0),
      referenceAngleCam: 0, suppressed: false };
    return { document, view, coupling };
  }
  it('create/edit/remove commits one Undo each and retains authored expressions', () => {
    const f = cams();
    expect(useAppStore.getState().setAssemblyCamCouplings([f.coupling])).toBe(true);
    const created = useAppStore.getState().assembly;
    if (created === null) throw new Error('fixture');
    expect(created).not.toBe(f.document);
    expect(f.document.camCouplings).toBeUndefined();
    expect(created.mechanismCouplings).toBe(f.document.mechanismCouplings);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: created } });
    const edited = { ...f.coupling, rollerRadiusMm: { ...f.coupling.rollerRadiusMm, source: '2+2', value: 999 } };
    expect(useAppStore.getState().setAssemblyCamCouplings([edited])).toBe(true);
    expect(useAppStore.getState().assembly?.camCouplings?.[0].rollerRadiusMm.source).toBe('2+2');
    expect(useAppStore.getState().setAssemblyCamCouplings([])).toBe(true);
    expect(useAppStore.getState().assembly?.camCouplings).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.camCouplings?.[0].rollerRadiusMm.source).toBe('2+2');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.camCouplings?.[0].rollerRadiusMm.source).toBe('4');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.document);
  });
  it('refuses no contact, unsupported geometry, multiple drivers and a stale view without document or Undo mutation', () => {
    const f = cams(), before = useAppStore.getState();
    for (const invalid of [
      [{ ...f.coupling, eccentricityMm: expressionValueFromNumber(24) }],
      [{ ...f.coupling, phaseDeg: { ...f.coupling.phaseDeg, source: 'undefinedPhase' } }],
      [{ ...f.coupling, camJointId: 'jf', followerJointId: 'jc' }],
      [f.coupling, { ...f.coupling, id: 'cam-2' }],
    ]) expect(before.setAssemblyCamCouplings(invalid)).toBe(false);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: { ...f.document } } });
    expect(before.setAssemblyCamCouplings([f.coupling])).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
  });
  it('refuses a roller centre on the cam axis (the follower side cannot be told)', () => {
    const f = cams(0), before = useAppStore.getState();
    expect(before.setAssemblyCamCouplings([f.coupling])).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });
});

describe('P7-31 規格部品の繰り返し配置', () => {
  it('既定のM8×30六角ボルトをEnter相当で続けて置き、Undoは1個ずつ戻す', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('規格部品'));
    expect(useAppStore.getState().openStandardPartPicker()).toBe(true);

    for (let count = 1; count <= 2; count += 1) {
      expect(useAppStore.getState().placeStandardPart(
        DEFAULT_STANDARD_PART_PICKER.category,
        DEFAULT_STANDARD_PART_PICKER.choiceKey,
        DEFAULT_STANDARD_PART_PICKER.lengthSource,
      )).toBe(true);
      const state = useAppStore.getState();
      expect(state.assembly?.components).toHaveLength(count);
      expect(state.standardPartPickerOpen).toBe(true);
      expect(state.assembly?.components.at(-1)?.source).toMatchObject({
        kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
        options: { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' },
      });
    }

    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });
});

describe('文書の種類の切替(P7 §0.a-0.10、タスク5)', () => {
  it('起動直後はアセンブリを開いていない(部品の画面)', () => {
    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
  });

  it('アセンブリを開くと種類が変わり、部品は読めなくなる(同時に 2 つ開かない)', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);

    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(activeDocumentKind(useAppStore.getState())).toBe('assembly');
    expect(activePartDocument(useAppStore.getState())).toBeNull();
  });

  it('閉じると部品の画面へ戻る', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    useAppStore.getState().closeAssembly();

    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
    expect(activePartDocument(useAppStore.getState())).toBe(useAppStore.getState().document);
  });

  it('新しい部品を作ると、開いていたアセンブリは閉じる', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    useAppStore.getState().resetDocument(createEmptyPartDocument());

    expect(useAppStore.getState().assembly).toBeNull();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
  });

  it('アセンブリを開いても部品の欄と履歴は保ち、文書の寿命は進める', () => {
    const before = useAppStore.getState();
    const document = before.document;
    const undoStack = before.undoStack;
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));

    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
    expect(useAppStore.getState().documentVersion).toBe(before.documentVersion + 1);
  });
});

describe('配置中の一時状態(P7 タスク11b)', () => {
  it.each(['undo', 'redo'] as const)('空履歴の%sはdraftを破棄し、履歴・版・再計算世代を増やさない', (operation) => {
    const document = createAssemblyDocument('組立');
    useAppStore.getState().openAssembly(document);
    const before = useAppStore.getState();
    useAppStore.setState({ assemblyMateDraft: createMateDraft(before.activeDocumentId, 'coincident') });
    useAppStore.getState()[operation]();
    const after = useAppStore.getState();
    expect(after.assemblyMateDraft).toBeNull();
    expect(after.assembly).toBe(document);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.requestedGeneration).toBe(before.requestedGeneration);
    expect(after.assemblyView).toBe(before.assemblyView);
  });

  it('表示専用overlayをUndo snapshotへ入れず、通常編集では残さない', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);
    const state = useAppStore.getState();
    useAppStore.setState({
      assemblyDragOverlay: {
        document: assembly,
        library: state.assemblyLibrary,
        documentId: state.activeDocumentId,
        version: state.documentVersion,
        generation: state.requestedGeneration,
        placements: new Map(),
        validatedIds: [],
      },
      assemblyDragNotice: 'dragging',
    });
    useAppStore.getState().applyAssembly({ ...assembly, name: '変更後' });
    const edited = useAppStore.getState();
    expect(edited.assemblyDragOverlay).toBeNull();
    expect(edited.assemblyDragNotice).toBeNull();
    expect(Object.keys(edited.assemblyUndoStack?.present ?? {}).sort()).toEqual(['document', 'library']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(useAppStore.getState().assemblyDragOverlay).toBeNull();
  });

  it('確定編集は配置状態を消し、Undoを1段だけ積む', () => {
    const assembly = createAssemblyDocument('組み立て1');
    useAppStore.getState().openAssembly(assembly);
    const documentId = useAppStore.getState().activeDocumentId;
    useAppStore.setState({
      assemblyPlacement: { kind: 'choosing', requestId: 'request-1', documentId },
    });

    useAppStore.getState().applyAssembly({ ...assembly, name: '変更後' });

    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
  });

  it('別文書を開くと配置状態を消し、文書IDを更新する', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    const documentId = useAppStore.getState().activeDocumentId;
    useAppStore.setState({
      assemblyPlacement: { kind: 'choosing', requestId: 'request-1', documentId },
    });

    useAppStore.getState().openAssembly(createAssemblyDocument('組み立て2'));

    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().activeDocumentId).not.toBe(documentId);
  });
});

describe('P7-22/35 表示専用の動きと分解履歴', () => {
  const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  function withComponents() {
    let document = createAssemblyDocument('組立');
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'a' }, { partName: 'A' }));
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'b' }, { partName: 'B' }));
    return document;
  }

  it('2部品の分解を1回で確定し、Undo 1回でステップを消す', () => {
    const document = withComponents();
    useAppStore.getState().openAssembly(document);
    useAppStore.setState({ selection: document.components.map((component) => component.id) });
    expect(useAppStore.getState().beginAssemblyExplode()).toBe(true);
    expect(useAppStore.getState().commitAssemblyExplode('12*2', '分解1', { kind: 'world', axis: 'y' })).toBe(true);
    const committed = useAppStore.getState();
    expect(committed.assembly?.presentation).toHaveLength(1);
    expect(committed.assembly?.presentation[0].body).toMatchObject({ kind: 'explode',
      componentIds: document.components.map((component) => component.id),
      direction: { kind: 'world', axis: 'y' }, distance: { source: '12*2', value: 24 } });
    expect(committed.assemblyUndoStack?.past).toHaveLength(1);
    committed.undo();
    expect(useAppStore.getState().assembly?.presentation).toEqual([]);
  });

  it('時間軸は表示配置だけを変え、文書とUndo履歴を変更しない', () => {
    const initial = withComponents();
    useAppStore.getState().openAssembly(initial);
    useAppStore.setState({ selection: [initial.components[0].id] });
    useAppStore.getState().beginAssemblyExplode();
    useAppStore.getState().commitAssemblyExplode('50', '分解1');
    const document = useAppStore.getState().assembly;
    if (document === null) throw new Error('fixture');
    const resolved = resolveAssembly(document);
    useAppStore.setState({ assemblyView: { sourceDocument: document, resolved,
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().setAssemblyMotionTime(1)).toBe(true);
    expect(useAppStore.getState().assembly).toBe(document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(stack);
    expect(useAppStore.getState().assemblyMotionPlacements?.get(document.components[0].id)?.position[2]).toBe(50);
  });

  it('確定編集で再生・一時配置・分解draftを必ず破棄する', () => {
    const document = withComponents();
    useAppStore.getState().openAssembly(document);
    useAppStore.setState({ selection: [document.components[0].id] });
    useAppStore.getState().beginAssemblyExplode();
    useAppStore.setState({ assemblyMotionPlaying: true, assemblyMotionTime: 0.5,
      assemblyMotionPlacements: new Map(), assemblyMotionSourceDocument: document });
    useAppStore.getState().applyAssembly({ ...document, name: '変更後' });
    const state = useAppStore.getState();
    expect(state.assemblyMotionPlaying).toBe(false);
    expect(state.assemblyMotionTime).toBe(0);
    expect(state.assemblyMotionPlacements).toBeNull();
    expect(state.assemblyMotionSourceDocument).toBeNull();
    expect(state.assemblyExplodeDraft).toBeNull();
  });

  it('別文書を開いても前文書の表示配置を持ち越さない', () => {
    const first = withComponents();
    useAppStore.getState().openAssembly(first);
    useAppStore.setState({ assemblyMotionPlaying: true, assemblyMotionTime: 1,
      assemblyMotionPlacements: new Map(), assemblyMotionSourceDocument: first });
    useAppStore.getState().openAssembly(createAssemblyDocument('次'));
    const state = useAppStore.getState();
    expect(state.assemblyMotionPlaying).toBe(false);
    expect(state.assemblyMotionPlacements).toBeNull();
    expect(state.assemblyMotionSourceDocument).toBeNull();
  });

  it('解決結果が届く前は再生を開始しない', () => {
    const initial = withComponents();
    const document = { ...initial, presentation: [{ id: 'step-1', name: '分解1', start: 0, end: 1,
      body: { kind: 'explode' as const, componentIds: [initial.components[0].id],
        direction: { kind: 'world' as const, axis: 'z' as const }, distance: expressionValueFromNumber(10) } }] };
    useAppStore.getState().openAssembly(document);
    useAppStore.getState().setAssemblyMotionPlaying(true);
    expect(useAppStore.getState().assemblyMotionPlaying).toBe(false);
  });

  it('ジョイントの範囲外入力を端へ丸め、表示配置だけを更新する', () => {
    const initial = withComponents();
    const [a, b] = initial.components;
    const document = { ...initial,
      components: [{ ...a, fixed: false }, { ...b, fixed: true }],
      joints: [{ id: 'joint-1', name: '移動1', kind: 'slider' as const,
        a: { kind: 'origin' as const, componentId: a.id, element: 'z' as const },
        b: { kind: 'origin' as const, componentId: b.id, element: 'z' as const },
        minValue: expressionValueFromNumber(-5), maxValue: expressionValueFromNumber(10), suppressed: false }] };
    useAppStore.getState().openAssembly(document);
    const resolved = resolveAssembly(document);
    useAppStore.setState({ assemblyView: { sourceDocument: document, resolved,
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      mateTargets: new Map(), jointFrames: new Map([['joint-1', { a: FRAME, b: FRAME }]]) } });
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'translation', 20)).toBe(true);
    const state = useAppStore.getState();
    expect(state.assemblyMotionJointValues.get('joint-1\u0000translation')).toBeCloseTo(10, 8);
    expect(state.assemblyMotionNotice).toMatchObject({ kind: 'rangeEnd', min: -5, max: 10, value: 10 });
    expect(state.assembly).toBe(document);
    expect(state.assemblyUndoStack).toBe(stack);
  });
});

describe('P7-26 表示専用の干渉解析状態', () => {
  function publishAssembly() {
    let document = createAssemblyDocument('干渉確認');
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'a' }, { partName: '部品A' }));
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef: 'b' }, { partName: '部品B' }));
    useAppStore.getState().openAssembly(document);
    const view = { sourceDocument: document, resolved: resolveAssembly(document),
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
    useAppStore.setState({ assemblyView: view });
    return { document, view, a: document.components[0].id, b: document.components[1].id };
  }

  function checked(requestId: string, a: string, b: string): AssemblyInterferenceResult {
    return { kind: 'checked', failure: null, requestId,
      pairs: [{ aComponentId: a, bComponentId: b, volume: 125,
        mesh: { positions: new Float32Array(9), normals: new Float32Array(9),
          indices: new Uint32Array([0, 1, 2]), triangleCount: 1 } }],
      failures: [], skips: [], totalPairCount: 1, checkedPairCount: 1,
      skippedPairCount: 0, pendingPairCount: 0, cancelled: false };
  }

  function deferredChecks() {
    const pending: {
      requestId: string;
      options: Parameters<AssemblyInterferenceRunner['check']>[1];
      resolve(value: AssemblyInterferenceResult): void;
      reject(error: Error): void;
    }[] = [];
    const runner: AssemblyInterferenceRunner = {
      check: (input, options) => new Promise((resolve, reject) => {
        pending.push({ requestId: input.requestId, options, resolve, reject });
      }),
      measureGap: () => Promise.resolve(null),
    };
    useAppStore.getState().setAssemblyInterferenceRunner(runner);
    return pending;
  }

  it('accepts a refreshed view wrapper with the same computation inputs', async () => {
    const fixture = publishAssembly();
    const pending = deferredChecks();
    const before = useAppStore.getState();
    before.runAssemblyInterference();
    const request = pending[0];
    if (request === undefined) throw new Error('missing request');
    useAppStore.setState({ assemblyView: { ...fixture.view } });
    expect(useAppStore.getState().assemblyView).not.toBe(fixture.view);
    expect(request.options?.shouldCancel?.()).toBe(false);
    request.options?.onProgress?.({ requestId: request.requestId, phase: 'mesh',
      completedPairs: 1, totalPairs: 1, completedComponents: 2, totalComponents: 2 });
    expect(useAppStore.getState().assemblyInterferenceProgress?.completedPairs).toBe(1);
    request.resolve(checked(request.requestId, fixture.a, fixture.b));
    await tick();
    const after = useAppStore.getState();
    expect(after.assemblyInterferenceResult?.pairs).toHaveLength(1);
    expect(after.assemblyInterferenceSelectedKey).toBe(`interference:${fixture.a}:${fixture.b}`);
    expect(after.isCheckingAssemblyInterference).toBe(false);
    expect(after.assemblyInterferenceRequestId).toBeNull();
    expect(after.assemblyInterferenceProgress).toBeNull();
    expect(after.assemblyInterferenceError).toBeNull();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.documentVersion).toBe(before.documentVersion);
  });

  it.each(['document', 'session', 'version', 'resolved', 'bodies', 'placements'] as const)(
    'rejects a changed %s input and clears only its still-current request', async (changed) => {
      const fixture = publishAssembly();
      const pending = deferredChecks();
      useAppStore.getState().runAssemblyInterference();
      const request = pending[0];
      if (request === undefined) throw new Error('missing request');
      switch (changed) {
        case 'document': useAppStore.setState({ assembly: { ...fixture.document, name: 'changed' } }); break;
        case 'session': useAppStore.setState({ activeDocumentId: 'different-session' }); break;
        case 'version': useAppStore.setState({ documentVersion: useAppStore.getState().documentVersion + 1 }); break;
        case 'resolved': useAppStore.setState({ assemblyView: {
          ...fixture.view, resolved: { ...fixture.view.resolved },
        } }); break;
        case 'bodies': useAppStore.setState({ assemblyView: {
          ...fixture.view, bodies: new Map(fixture.view.bodies),
        } }); break;
        case 'placements': {
          const placements = new Map(fixture.view.resolved.placements);
          placements.set(fixture.a, { position: [10, 0, 0], rotation: [0, 0, 0, 1] });
          useAppStore.setState({ assemblyMotionSourceDocument: fixture.document,
            assemblyMotionPlacements: placements });
          break;
        }
      }
      expect(request.options?.shouldCancel?.()).toBe(true);
      request.options?.onProgress?.({ requestId: request.requestId, phase: 'mesh',
        completedPairs: 1, totalPairs: 1, completedComponents: 2, totalComponents: 2 });
      expect(useAppStore.getState().assemblyInterferenceProgress).toBeNull();
      request.resolve(checked(request.requestId, fixture.a, fixture.b));
      await tick();
      const state = useAppStore.getState();
      expect(state.assemblyInterferenceResult).toBeNull();
      expect(state.assemblyInterferenceSelectedKey).toBeNull();
      expect(state.isCheckingAssemblyInterference).toBe(false);
      expect(state.assemblyInterferenceRequestId).toBeNull();
      expect(state.assemblyInterferenceProgress).toBeNull();
      expect(state.assemblyInterferenceError).toBe(t('assembly.interference.inputsChanged'));
    },
  );

  it.each(['resolve', 'reject'] as const)('keeps the new request when the old one later %ss', async (outcome) => {
    const fixture = publishAssembly();
    const pending = deferredChecks();
    useAppStore.getState().runAssemblyInterference();
    useAppStore.getState().runAssemblyInterference();
    const old = pending[0], current = pending[1];
    if (old === undefined || current === undefined) throw new Error('missing requests');
    expect(old.options?.shouldCancel?.()).toBe(true);
    old.options?.onProgress?.({ requestId: old.requestId, phase: 'mesh',
      completedPairs: 1, totalPairs: 1, completedComponents: 2, totalComponents: 2 });
    if (outcome === 'resolve') old.resolve(checked(old.requestId, fixture.a, fixture.b));
    else old.reject(new Error('old failure'));
    await tick();
    expect(useAppStore.getState().assemblyInterferenceRequestId).toBe(current.requestId);
    expect(useAppStore.getState().isCheckingAssemblyInterference).toBe(true);
    expect(useAppStore.getState().assemblyInterferenceProgress).toBeNull();
    expect(useAppStore.getState().assemblyInterferenceResult).toBeNull();
    expect(useAppStore.getState().assemblyInterferenceError).toBeNull();
    current.resolve(checked(current.requestId, fixture.a, fixture.b));
    await tick();
    expect(useAppStore.getState().assemblyInterferenceResult?.requestId).toBe(current.requestId);
    expect(useAppStore.getState().isCheckingAssemblyInterference).toBe(false);
  });

  it('解析結果・進捗・選択を文書とUndoへ混ぜない', async () => {
    const fixture = publishAssembly();
    const runner: AssemblyInterferenceRunner = {
      check: (input, options) => {
        options?.onProgress?.({ requestId: input.requestId, phase: 'common',
          completedPairs: 1, totalPairs: 1, completedComponents: 2, totalComponents: 2 });
        return Promise.resolve(checked(input.requestId, fixture.a, fixture.b));
      },
      measureGap: () => Promise.resolve(null),
    };
    useAppStore.getState().setAssemblyInterferenceRunner(runner);
    const before = useAppStore.getState();
    useAppStore.getState().runAssemblyInterference();
    await tick();
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.documentVersion).toBe(before.documentVersion);
    expect(after.assemblyInterferenceResult?.pairs).toHaveLength(1);
    expect(after.assemblyInterferenceSelectedKey).toBe(`interference:${fixture.a}:${fixture.b}`);
  });

  it('閉じた要求を中止扱いにし、遅れて届いた結果を復活させない', async () => {
    const fixture = publishAssembly();
    let settle: ((value: AssemblyInterferenceResult) => void) | undefined;
    let shouldCancel: (() => boolean | Promise<boolean>) | undefined;
    const runner: AssemblyInterferenceRunner = {
      check: (_input, options) => {
        shouldCancel = options?.shouldCancel;
        return new Promise((resolve) => { settle = resolve; });
      },
      measureGap: () => Promise.resolve(null),
    };
    useAppStore.getState().setAssemblyInterferenceRunner(runner);
    useAppStore.getState().runAssemblyInterference();
    const requestId = useAppStore.getState().assemblyInterferenceRequestId;
    expect(requestId).not.toBeNull();
    useAppStore.getState().closeAssemblyInterference();
    expect(shouldCancel === undefined ? false : await shouldCancel()).toBe(true);
    if (requestId === null || settle === undefined) throw new Error('fixture');
    settle(checked(requestId, fixture.a, fixture.b));
    await tick();
    const state = useAppStore.getState();
    expect(state.assemblyInterferenceOpen).toBe(false);
    expect(state.assemblyInterferenceResult).toBeNull();
    expect(state.isCheckingAssemblyInterference).toBe(false);
  });

  it('確定編集で古い解析結果と選択をまとめて破棄する', async () => {
    const fixture = publishAssembly();
    const runner: AssemblyInterferenceRunner = {
      check: (input) => Promise.resolve(checked(input.requestId, fixture.a, fixture.b)),
      measureGap: () => Promise.resolve(null),
    };
    useAppStore.getState().setAssemblyInterferenceRunner(runner);
    useAppStore.getState().runAssemblyInterference();
    await tick();
    useAppStore.getState().applyAssembly({ ...fixture.document, name: '編集後' });
    const state = useAppStore.getState();
    expect(state.assemblyInterferenceOpen).toBe(false);
    expect(state.assemblyInterferenceResult).toBeNull();
    expect(state.assemblyInterferenceSelectedKey).toBeNull();
  });
});

describe('atomic secure session at actual assembly store boundaries', () => {
  it('reset refuses before evaluating its update callback and preserves every old state field', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('Existing owner'));
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, clearSaveTarget } });
    const before = useAppStore.getState();
    const update = vi.fn(() => ({ fileName: 'must-not-commit.pcad' }));
    vi.stubGlobal('crypto', {});
    try {
      expect(() => before.resetAssembly(update)).toThrow(SecurePartIdentityError);
      expect(update).not.toHaveBeenCalled();
      expect(clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toBe(before);
      expect(useAppStore.getState()).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });

  it('open and close refuse before clearing an actual saved target or changing the current owner', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('Existing owner'));
    const next = createAssemblyDocument('Next owner');
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway,
      hasSaveTarget: () => true, clearSaveTarget } });
    const before = useAppStore.getState();
    vi.stubGlobal('crypto', {});
    try {
      expect(() => before.openAssembly(next)).toThrow(SecurePartIdentityError);
      expect(useAppStore.getState()).toBe(before);
      expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
      expect(() => before.closeAssembly()).toThrow(SecurePartIdentityError);
      expect(useAppStore.getState()).toBe(before);
      expect(clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a genuine prepared session reaches open and reset unchanged after both entropy APIs disappear', () => {
    const session = prepareDocumentSession();
    const document = createAssemblyDocument('Prepared owner');
    const update = vi.fn(() => ({ fileName: 'prepared.pcad' }));
    vi.stubGlobal('crypto', {});
    try {
      useAppStore.getState().openAssembly(document, undefined, { preparedSession: session });
      expect(useAppStore.getState().assembly).toBe(document);
      expect(useAppStore.getState().activeDocumentId).toBe(session.id);
      useAppStore.getState().resetAssembly(update, session);
      expect(update).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().fileName).toBe('prepared.pcad');
      expect(useAppStore.getState().activeDocumentId).toBe(session.id);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a plain-object prepared session is rejected before the real reset callback and target effects', () => {
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, clearSaveTarget } });
    const before = useAppStore.getState();
    const update = vi.fn(() => ({ fileName: 'forged.pcad' }));
    expect(() => { Reflect.apply(before.resetAssembly, undefined, [update, { id: 'forged-session' }]); })
      .toThrow(SecurePartIdentityError);
    expect(update).not.toHaveBeenCalled();
    expect(clearSaveTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    expect(useAppStore.getState()).toEqual(before);
  });
});
