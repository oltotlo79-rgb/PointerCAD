/**
 * R07: store updates at the boundary of the four input series of `attachSketchInteraction`
 * (selection, drawing, drag, cancel). The traces were recorded from the implementation before
 * its drag session, section handle and transient indicators were split into their own modules;
 * the split must produce exactly the same updates in the same order.
 */
import { createHash } from 'node:crypto';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createPointFeature, DEFAULT_FACE_COLOR,
  FREE_WORK_PLANE_ID, replaceSketch, type SketchLineFeature } from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constraintMarksOf } from '../sketch/constraintPicking.js';
import { createNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import type { AppState } from '../store/appState.js';
import { bodyFor, orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import type { ViewportScene } from './createViewportScene.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetTestStore(); });

const WATCHED = ['document', 'undoStack', 'selection', 'connectionSelection', 'hoveredElementId', 'pickAnchor',
  'numericInput', 'pendingStart', 'sketchDrag', 'dragResolved', 'dragRefusalKey', 'snapIndicator', 'trackIndicator',
  'inferredConstraints', 'editPreview', 'editErrorKey', 'selectedConstraintId', 'requestedGeneration',
  'sectionView'] as const satisfies readonly (keyof AppState)[];

interface Harness {
  readonly send: (type: string, x?: number, y?: number, modifiers?: { readonly shiftKey?: boolean }) => void;
  readonly key: (key: string) => void;
  readonly frames: Map<number, FrameRequestCallback>;
  readonly captured: Set<number>;
  readonly detach: () => void;
  /** Listener types added to and removed from the canvas, in call order. */
  readonly listeners: () => { readonly added: readonly string[]; readonly removed: readonly string[] };
}

function harness(pickBody: () => string | null = () => null,
  extra: Partial<Pick<ViewportScene, 'pickFaceAt'>> = {}): Harness {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const captured = new Set<number>();
  const added: string[] = [], removed: string[] = [];
  const target = new EventTarget();
  const canvas = Object.assign(target, {
    addEventListener: (...args: Parameters<EventTarget['addEventListener']>): void => {
      added.push(args[0]); EventTarget.prototype.addEventListener.apply(target, args);
    },
    removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>): void => {
      removed.push(args[0]); EventTarget.prototype.removeEventListener.apply(target, args);
    },
    clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
    setPointerCapture: (id: number): void => { captured.add(id); },
    hasPointerCapture: (id: number): boolean => captured.has(id),
    releasePointerCapture: (id: number): void => { captured.delete(id); },
    focus: (): void => {},
  }) as HTMLCanvasElement;
  const projection: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay' | 'pickBody'>
    & Partial<Pick<ViewportScene, 'pickFaceAt'>> = {
      worldToScreen: point => [point[0], point[1]], screenToPlanePoint: (x, y) => [x, y, 0], pointerRay: () => null,
      pickBody, ...extra,
    };
  const attached = attachSketchInteraction(canvas, projection as ViewportScene, () => orbitFrom(0, 0), () => false);
  return {
    frames, captured, detach: () => { attached.detach(); }, listeners: () => ({ added, removed }),
    send: (type, x = 40, y = 50, modifiers = {}) => {
      canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' || type === 'pointermove' ? 0 : 1,
        clientX: x, clientY: y, altKey: false, shiftKey: modifiers.shiftKey === true, ctrlKey: false, metaKey: false,
      }));
    },
    key: key => { canvas.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key })); },
  };
}

function resetPointDocument(): void {
  resetTestStore();
  const empty = createEmptyPartDocument();
  const sketch = appendFeature(empty.sketches[0], createPointFeature(empty.sketches[0], absoluteCoordinate(40, 50, 0)));
  const document = replaceSketch(empty, sketch);
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
  useAppStore.setState({ snapEnabled: false });
}

/** Each store notification is written as "step: changed keys" in the order they happen. */
function record(run: (step: (name: string, act: () => void) => void) => void): string[] {
  const trace: string[] = [];
  let current = 'start';
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    const changed = WATCHED.filter(key => next[key] !== previous[key]);
    if (changed.length > 0) trace.push(`${current}: ${changed.join(',')}`);
  });
  try { run((name, act) => { current = name; act(); }); } finally { unsubscribe(); }
  return trace;
}

function runFrames(frames: Map<number, FrameRequestCallback>): void {
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
}

describe('attachSketchInteraction の4系列の境界でのストア更新(R07)', () => {
  it('選択: ホバー、Shift での追加と解除、空き場所での解除、画面外', () => {
    resetPointDocument();
    const h = harness();
    try {
      const trace = record(step => {
        step('hover', () => { h.send('pointermove'); });
        step('shift-pick', () => { h.send('pointerdown', 40, 50, { shiftKey: true }); });
        step('shift-up', () => { h.send('pointerup'); });
        step('shift-unpick', () => { h.send('pointerdown', 40, 50, { shiftKey: true }); });
        step('reselect', () => { h.send('pointerdown', 40, 50, { shiftKey: true }); });
        step('empty-click', () => { h.send('pointerdown', 300, 300); });
        step('leave', () => { h.send('pointerleave'); });
      });
      expect(trace).toEqual(SELECTION_TRACE);
      expect(useAppStore.getState().selection).toEqual([]);
      expect(h.captured.size).toBe(0);
    } finally { h.detach(); }
  });

  it('作図: 点と線分の押下は数値入力だけを開き、文書を変えない', () => {
    resetPointDocument();
    useAppStore.getState().setActiveTool('point');
    const h = harness();
    try {
      const before = useAppStore.getState().document;
      const trace = record(step => {
        step('hover', () => { h.send('pointermove', 100, 120); });
        step('point-down', () => { h.send('pointerdown', 100, 120); });
        step('point-up', () => { h.send('pointerup', 100, 120); });
        step('line-tool', () => { useAppStore.getState().setActiveTool('line'); });
        step('line-down', () => { h.send('pointerdown', 10, 10); });
      });
      expect(trace).toEqual(DRAWING_TRACE);
      expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().numericInput?.toolId).toBe('line');
    } finally { h.detach(); }
  });

  it('ドラッグ: 掴む・動かす・解く・離すで1回だけ文書を確定する', () => {
    resetPointDocument();
    const h = harness();
    try {
      const before = useAppStore.getState();
      const trace = record(step => {
        step('grab', () => { h.send('pointerdown'); });
        step('move', () => { h.send('pointermove', 55, 60); });
        step('frame', () => { runFrames(h.frames); });
        step('release', () => { h.send('pointerup', 55, 60); });
      });
      expect(trace).toEqual(DRAG_TRACE);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(h.captured.size).toBe(0);
    } finally { h.detach(); }
  });

  it('取消: pointercancel・Esc・破棄は確定せず、遅れた pointerup と RAF でも変えない', () => {
    resetPointDocument();
    useAppStore.setState({ snapEnabled: true });
    const h = harness();
    try {
      const before = useAppStore.getState();
      const trace = record(step => {
        step('grab', () => { h.send('pointerdown'); });
        step('move', () => { h.send('pointermove', 55, 60); });
        step('frame', () => { runFrames(h.frames); });
        step('cancel', () => { h.send('pointercancel', 55, 60); });
        step('late-up', () => { h.send('pointerup', 55, 60); runFrames(h.frames); });
        step('grab-again', () => { h.send('pointerdown'); });
        step('move-again', () => { h.send('pointermove', 70, 80); runFrames(h.frames); });
        step('escape-drag', () => { h.key('Escape'); });
        step('escape-selection', () => { h.key('Escape'); });
        step('hover-snap', () => { h.send('pointermove', 41, 50); });
        step('detach', () => { h.detach(); });
        step('after-detach', () => { h.send('pointerdown'); h.send('pointermove', 90, 90); h.key('Escape'); });
      });
      expect(trace).toEqual(CANCEL_TRACE);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(h.frames.size).toBe(0);
      expect(h.captured.size).toBe(0);
    } finally { h.detach(); }
  });
});

describe('attachSketchInteraction の100回の装着と破棄(R07)', () => {
  it('引っぱり・断面のつまみ・吸着の印を持ったまま破棄しても、捕捉・RAF・印・購読が残らず、破棄後の入力でストアが変わらない', () => {
    resetPointDocument();
    useAppStore.setState({ snapEnabled: true });
    useAppStore.getState().toggleSectionView();
    const subscribe = vi.spyOn(useAppStore, 'subscribe');
    const before = useAppStore.getState();
    for (let index = 0; index < 100; index++) {
      const h = harness();
      const traceAfterDetach = record(step => {
        step('hover', () => { h.send('pointermove', 41, 50); });
        // Even cycles grab the section handle at the origin, odd cycles drag the point.
        if (index % 2 === 0) step('section', () => { h.send('pointerdown', 0, 0); h.send('pointermove', 5, 5); });
        else step('drag', () => { h.send('pointerdown'); h.send('pointermove', 55, 60); });
        step('detach', () => { h.detach(); h.detach(); });
      });
      expect(traceAfterDetach.some(line => line.startsWith('detach: ') && line.includes('snapIndicator'))).toBe(true);
      expect(h.captured.size).toBe(0);
      expect(h.frames.size).toBe(0);
      const state = useAppStore.getState();
      expect([state.sketchDrag, state.dragResolved, state.snapIndicator, state.trackIndicator, state.editPreview])
        .toEqual([null, null, null, null, null]);
      const late = record(step => {
        step('late', () => { h.send('pointerdown'); h.send('pointermove', 70, 80); h.send('pointerup'); h.key('Escape'); });
      });
      expect(late).toEqual([]);
      const { added, removed } = h.listeners();
      expect(added).toHaveLength(6);
      expect([...removed].sort()).toEqual([...added].sort());
    }
    expect(subscribe).toHaveBeenCalledTimes(100 + 200);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
});

/*
 * 座標の決め方・立体の当たり判定・編集の道具・拘束・作図の押下を、attachSketchInteraction の
 * 外側(canvas のイベント)から通し、各段のストアの更新の順と、その段の後に見える結果(欄の値・選択・
 * 印・予告・文書)の要約を比べる。期待値は、これらの責務を別のモジュールへ移す前の実装で記録した。
 */
const DETAIL_WATCHED = [...WATCHED, 'activeTool', 'activeConstraintKind', 'constraintTargets', 'constraintErrorMessage',
  'constraintPrompt', 'freeSketchPlane', 'workPlaneId', 'selectionKind'] as const satisfies readonly (keyof AppState)[];

/** One step's visible outcome: the open input, selection, indicators, previews and the active sketch. */
function outcome(): string {
  const state = useAppStore.getState();
  const input = state.numericInput;
  return JSON.stringify({
    input: input === null ? null : { tool: input.toolId, step: input.step, mode: input.mode,
      fields: input.fields.map(field => field.source), textOrigin: input.textOrigin ?? null },
    selection: state.selection, hovered: state.hoveredElementId, anchor: state.pickAnchor, pending: state.pendingStart,
    snap: state.snapIndicator, track: state.trackIndicator, inferred: state.inferredConstraints,
    edit: state.editPreview, editError: state.editErrorKey, targets: state.constraintTargets,
    selectedConstraint: state.selectedConstraintId, freePlane: state.freeSketchPlane, features: state.sketch.features,
  });
}

/** Changed keys per store notification, then a digest of the outcome after each step. */
function recordDetail(run: (step: (name: string, act: () => void) => void) => void): string[] {
  const trace: string[] = [];
  let current = 'start';
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    const changed = DETAIL_WATCHED.filter(key => next[key] !== previous[key]);
    if (changed.length > 0) trace.push(`${current}: ${changed.join(',')}`);
  });
  try {
    run((name, act) => {
      current = name;
      act();
      trace.push(`${name} = ${createHash('sha256').update(outcome()).digest('hex').slice(0, 16)}`);
    });
  } finally { unsubscribe(); }
  return trace;
}

function sketchLine(id: string, from: readonly [number, number], to: readonly [number, number]): SketchLineFeature {
  return { id, name: id, planeId: 'xy', kind: 'line', construction: false,
    from: absoluteCoordinate(from[0], from[1], 0), to: absoluteCoordinate(to[0], to[1], 0) };
}

function resetLineDocument(lines: readonly SketchLineFeature[]): void {
  resetTestStore();
  const empty = createEmptyPartDocument();
  const sketch = lines.reduce((current, line) => appendFeature(current, line), empty.sketches[0]);
  const document = replaceSketch(empty, sketch);
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
  useAppStore.setState({ snapEnabled: false });
}

function press(h: Harness, x: number, y: number): void { h.send('pointerdown', x, y); h.send('pointerup', x, y); }

describe('attachSketchInteraction から移す責務の境界(R07)', () => {
  it('座標: 点の吸着・向きの吸着・相対・極・線分の終点と推定の予告・3D スケッチの作図面', () => {
    resetPointDocument();
    useAppStore.setState({ snapEnabled: true });
    useAppStore.getState().setActiveTool('point');
    const h = harness();
    try {
      const trace = recordDetail(step => {
        step('snap-hover', () => { h.send('pointermove', 49, 50); });
        step('snap-down', () => { press(h, 49, 50); });
        step('track-hover', () => { h.send('pointermove', 150, 51); });
        step('track-down', () => { press(h, 150, 51); });
        step('relative-down', () => {
          useAppStore.setState({ snapEnabled: false });
          useAppStore.getState().openNumericInput(reduceNumericInput(createNumericInput('point', 'point'),
            { type: 'setMode', mode: 'relative' }), [0, 0]);
          press(h, 100, 120);
        });
        step('polar-down', () => {
          useAppStore.getState().openNumericInput(reduceNumericInput(createNumericInput('point', 'point'),
            { type: 'setMode', mode: 'polar' }), [0, 0]);
          press(h, 100, 120);
        });
        step('line-end-open', () => {
          useAppStore.getState().setActiveTool('line');
          useAppStore.getState().openNumericInput(reduceNumericInput(createNumericInput('line', 'lineEnd'),
            { type: 'setMode', mode: 'relative' }), [0, 0]);
          useAppStore.getState().setPendingStart(absoluteCoordinate(10, 10, 0));
        });
        step('infer-hover', () => { h.send('pointermove', 60, 10); });
        step('infer-shift', () => { h.send('pointermove', 60, 10, { shiftKey: true }); });
        step('line-end-down', () => { press(h, 60, 11); });
        step('free-plane', () => {
          useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
          useAppStore.getState().setActiveTool('point');
        });
        step('free-down', () => { press(h, 100, 120); });
      });
      expect(trace).toEqual(COORDINATE_TRACE);
    } finally { h.detach(); }
  });

  it('編集の道具: トリム・延長・角の丸め・投影・断面・球面上の点(交点の外れ)', () => {
    resetLineDocument([
      sketchLine('trim-a', [0, 300], [200, 300]), sketchLine('trim-b', [100, 250], [100, 350]),
      sketchLine('extend-a', [300, 0], [350, 0]), sketchLine('extend-b', [400, -50], [400, 50]),
      sketchLine('corner-a', [100, 100], [200, 100]), sketchLine('corner-b', [200, 100], [200, 200]),
    ]);
    const h = harness();
    try {
      const trace = recordDetail(step => {
        step('trim-tool', () => { useAppStore.getState().setActiveTool('trim'); });
        step('trim-hover', () => { h.send('pointermove', 50, 300); });
        step('trim-click', () => { press(h, 50, 300); });
        step('trim-miss', () => { press(h, 600, 600); });
        step('extend-tool', () => { useAppStore.getState().setActiveTool('extend'); });
        step('extend-hover', () => { h.send('pointermove', 340, 0); });
        step('extend-click', () => { press(h, 340, 0); });
        step('corner-tool', () => { useAppStore.getState().setActiveTool('sketchFillet'); });
        step('corner-hover', () => { h.send('pointermove', 198, 102); });
        step('corner-click', () => { press(h, 198, 102); });
        step('corner-miss', () => { press(h, 600, 600); });
        step('projection-tool', () => { useAppStore.getState().setActiveTool('projectedCurve'); });
        step('projection-miss', () => { press(h, 600, 600); });
        step('section-tool', () => { useAppStore.getState().setActiveTool('planeSection'); });
        step('section-miss', () => { press(h, 600, 600); });
        step('escape', () => { h.key('Escape'); });
        step('sphere-tool', () => { useAppStore.getState().setActiveTool('sphereGridPoint'); });
        step('sphere-hover', () => { h.send('pointermove', 150, 100); });
        step('sphere-click', () => { press(h, 150, 100); });
      });
      expect(trace).toEqual(EDIT_TOOL_TRACE);
    } finally { h.detach(); }
  });

  it('選択の種類と拘束: 面の当たり・立体・拘束の道具の押下と空き場所・拘束の印', () => {
    resetLineDocument([sketchLine('c-a', [0, 0], [100, 0]), sketchLine('c-b', [0, 50], [100, 80])]);
    useAppStore.setState({ bodies: [bodyFor('body')] });
    const h = harness(() => 'body', { pickFaceAt: (x: number) => (x < 500 ? { featureId: 'body', faceIndex: 0 } : null) });
    try {
      const trace = recordDetail(step => {
        step('face-kind', () => { useAppStore.getState().setSelectionKind('face'); });
        step('face-hover', () => { h.send('pointermove', 50, 0); });
        step('face-click', () => { press(h, 50, 0); });
        step('face-empty', () => { press(h, 600, 600); });
        step('body-kind', () => { useAppStore.getState().setSelectionKind('body'); });
        step('body-click', () => { press(h, 300, 300); });
        step('horizontal-tool', () => { useAppStore.getState().setConstraintTool('horizontal'); });
        step('horizontal-pick', () => { press(h, 50, 65); });
        step('constraint-empty', () => { press(h, 600, 600); });
        step('parallel-tool', () => { useAppStore.getState().setConstraintTool('parallel'); });
        step('parallel-first', () => { press(h, 50, 0); });
        step('parallel-second', () => { press(h, 50, 50); });
        step('constraint-escape', () => { h.key('Escape'); });
        step('selection-escape', () => { h.key('Escape'); });
        step('mark-click', () => {
          // The summaries come from the recompute; one mark at the horizontal constraint is enough for the hit.
          useAppStore.setState({ constraintSummaries: [{ id: 'constraint-1', kind: 'horizontal', label: 'H1', detail: 'c-b',
            symbol: 'H', value: null, valueText: null, anchors: [{ position: [50, 65, 0], onPoint: false }], state: 'ok',
            stateMessage: null }] });
          const [mark] = constraintMarksOf(useAppStore.getState().constraintSummaries);
          if (mark === undefined) throw new Error('constraint mark missing');
          press(h, mark.position[0] + mark.offset[0], mark.position[1] + mark.offset[1]);
        });
        step('mark-miss', () => { press(h, 600, 600); });
      });
      expect(trace).toEqual(SELECTION_KIND_TRACE);
    } finally { h.detach(); }
  });
});

describe('selection filters at the actual pointer boundary', () => {
  function overlappingSketch(): string {
    resetPointDocument();
    const state = useAppStore.getState();
    const pointId = state.resolvedSketch.points[0].id;
    useAppStore.setState({ bodies: [bodyFor('body')], resolvedSketch: { ...state.resolvedSketch,
      segments: [{ kind: 'segment', featureId: 'curve', from: [20, 50, 0], to: [60, 50, 0] }],
      faces: [{ featureId: 'face', color: DEFAULT_FACE_COLOR, curves: [
        { kind: 'segment', featureId: 'face', from: [20, 30, 0], to: [60, 30, 0] },
        { kind: 'segment', featureId: 'face', from: [60, 30, 0], to: [60, 70, 0] },
        { kind: 'segment', featureId: 'face', from: [60, 70, 0], to: [20, 70, 0] },
        { kind: 'segment', featureId: 'face', from: [20, 70, 0], to: [20, 30, 0] },
      ] }],
    } });
    return pointId;
  }

  it('all 16 independent filter combinations preserve priority among enabled candidates for click and hover', () => {
    const pointId = overlappingSketch();
    const h = harness(() => 'body');
    try {
      for (let mask = 0; mask < 16; mask++) {
        const filter = { vertex: (mask & 1) !== 0, edge: (mask & 2) !== 0, face: (mask & 4) !== 0, body: (mask & 8) !== 0 };
        const expected = filter.vertex ? pointId : filter.edge ? 'curve' : filter.face ? 'face' : filter.body ? 'body' : null;
        const state = useAppStore.getState();
        state.setDisplaySettings({ ...state.displaySettings, selectionFilter: filter });
        state.setSelection([]);
        h.send('pointermove');
        expect(useAppStore.getState().hoveredElementId).toBe(expected);
        h.send('pointerdown', 40, 50, { shiftKey: true });
        expect(useAppStore.getState().selection).toEqual(expected === null ? [] : [expected]);
        h.send('pointerup');
      }
    } finally { h.detach(); }
  });

  it.each([
    { filter: { vertex: false, edge: true, face: true, body: true }, expected: 'curve' },
    { filter: { vertex: false, edge: false, face: true, body: true }, expected: 'face' },
    { filter: { vertex: false, edge: false, face: false, body: true }, expected: 'body' },
  ])('a normal click reaches $expected behind a disabled point without starting a sketch drag', ({ filter, expected }) => {
    overlappingSketch();
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, selectionFilter: filter });
    const pickBody = vi.fn(() => 'body');
    const h = harness(pickBody);
    try {
      h.send('pointermove');
      expect(useAppStore.getState().hoveredElementId).toBe(expected);
      h.send('pointerdown');
      expect(useAppStore.getState().selection).toEqual([expected]);
      expect(useAppStore.getState().sketchDrag).toBeNull();
      expect(h.captured.size).toBe(0);
      expect(pickBody).toHaveBeenCalledTimes(expected === 'body' ? 2 : 0);
    } finally { h.detach(); }
  });

  it('disabled snap candidates cannot restore selection hover, while coordinate drawing retains snapping', () => {
    resetPointDocument();
    const state = useAppStore.getState();
    const pointId = state.resolvedSketch.points[0].id;
    state.setDisplaySettings({ ...state.displaySettings, selectionFilter: { vertex: false, edge: false, face: false, body: false } });
    useAppStore.setState({ snapEnabled: true });
    const h = harness();
    try {
      // Outside the six-pixel pick radius, inside the twelve-pixel snap radius.
      h.send('pointermove', 49, 50);
      expect(useAppStore.getState().hoveredElementId).toBeNull();
      h.send('pointerdown', 40, 50);
      expect(useAppStore.getState().selection).toEqual([]);
      expect(useAppStore.getState().sketchDrag).toBeNull();
      h.send('pointerup');
      state.setActiveTool('point');
      h.send('pointermove', 49, 50);
      expect(useAppStore.getState().hoveredElementId).toBe(pointId);
      expect(useAppStore.getState().snapIndicator?.elementId).toBe(pointId);
    } finally { h.detach(); }
  });

  it.each(['trim', 'extend'] as const)('%s cannot hover or edit a disabled sketch curve', tool => {
    overlappingSketch();
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, selectionFilter: { vertex: true, edge: false, face: true, body: true } });
    state.setActiveTool(tool);
    const document = useAppStore.getState().document;
    const h = harness();
    try {
      h.send('pointermove', 50, 50);
      expect(useAppStore.getState().hoveredElementId).toBeNull();
      h.send('pointerdown', 50, 50);
      expect(useAppStore.getState().document).toBe(document);
      expect(useAppStore.getState().selection).toEqual([]);
    } finally { h.detach(); }
  });
});

// Recorded with the implementation before the split (2026-10-05 16:03:50 before-split recording).
const SELECTION_TRACE: readonly string[] = [
  'hover: hoveredElementId',
  'shift-pick: pickAnchor',
  'shift-pick: selection,connectionSelection',
  'shift-unpick: pickAnchor',
  'shift-unpick: selection,connectionSelection',
  'reselect: pickAnchor',
  'reselect: selection,connectionSelection',
  'empty-click: selection,connectionSelection',
  'empty-click: pickAnchor',
  'leave: hoveredElementId',
];
const DRAWING_TRACE: readonly string[] = [
  'point-down: numericInput',
  'line-tool: numericInput',
  'line-down: numericInput',
];
const DRAG_TRACE: readonly string[] = [
  'grab: sketchDrag',
  'grab: selection,connectionSelection',
  'grab: pickAnchor',
  'frame: dragResolved',
  'release: sketchDrag',
  'release: document,undoStack,selection',
];
const CANCEL_TRACE: readonly string[] = [
  'grab: sketchDrag',
  'grab: selection,connectionSelection',
  'grab: pickAnchor',
  'frame: snapIndicator',
  'frame: dragResolved',
  'cancel: sketchDrag,dragResolved',
  'cancel: snapIndicator',
  'grab-again: sketchDrag',
  'grab-again: selection,connectionSelection',
  'grab-again: pickAnchor',
  'move-again: snapIndicator',
  'move-again: dragResolved',
  'escape-drag: sketchDrag,dragResolved',
  'escape-drag: snapIndicator',
  'escape-selection: selection,connectionSelection',
  'hover-snap: hoveredElementId',
  'hover-snap: snapIndicator',
  'detach: snapIndicator',
];
/*
 * Recorded 2026-11-12 18:56 with attachSketchInteraction.ts before the coordinate, solid picking, edit tool,
 * constraint, selection and drawing responsibilities left the function (SHA-256
 * 2d725888300887921b5de9b517436d1fefdb554023e5fb2f3313b7f80e15a454). `name = digest` is the first 16 hex
 * characters of the SHA-256 of `outcome()` after that step.
 */
const COORDINATE_TRACE: readonly string[] = [
  'snap-hover: hoveredElementId',
  'snap-hover: snapIndicator',
  'snap-hover = a97df72bd19ae263',
  'snap-down: numericInput',
  'snap-down = ddc6ea5fe266fd03',
  'track-hover: hoveredElementId',
  'track-hover: snapIndicator',
  'track-hover: trackIndicator',
  'track-hover = 5b9d0d3ef31e80d8',
  'track-down: numericInput',
  'track-down = 9093dbf3db415133',
  'relative-down: numericInput',
  'relative-down: numericInput',
  'relative-down = 3496735fca585df6',
  'polar-down: numericInput',
  'polar-down: numericInput',
  'polar-down = cfb5c567cc11b92b',
  'line-end-open: numericInput,snapIndicator,trackIndicator,activeTool',
  'line-end-open: numericInput',
  'line-end-open: pendingStart',
  'line-end-open = d05d3e46b74490d8',
  'infer-hover: inferredConstraints',
  'infer-hover = 7f191038b46536dc',
  'infer-shift: inferredConstraints',
  'infer-shift = d05d3e46b74490d8',
  'line-end-down: numericInput',
  'line-end-down = f21f221ff30dd500',
  'free-plane: workPlaneId',
  'free-plane: numericInput,pendingStart,activeTool',
  'free-plane = e901e241dbdc5a01',
  'free-down: freeSketchPlane',
  'free-down: numericInput',
  'free-down = 7d743aa178e2f19e',
];
const EDIT_TOOL_TRACE: readonly string[] = [
  'trim-tool: activeTool',
  'trim-tool = 528bc930390cb641',
  'trim-hover: hoveredElementId',
  'trim-hover: editPreview',
  'trim-hover = 6897dac5621f226d',
  'trim-click: editPreview',
  'trim-click: document,undoStack,selection',
  'trim-click = ec158dac2d01460b',
  'trim-miss: editErrorKey',
  'trim-miss = c95f3e8da5ea94c5',
  'extend-tool: editErrorKey,activeTool',
  'extend-tool = ec158dac2d01460b',
  'extend-hover: hoveredElementId',
  'extend-hover: editPreview',
  'extend-hover = e8a8d0d8953ca257',
  'extend-click: editPreview',
  'extend-click: document,undoStack,selection',
  'extend-click = 5c220a6377a12d02',
  'corner-tool: activeTool',
  'corner-tool = 5c220a6377a12d02',
  'corner-hover: hoveredElementId',
  'corner-hover: editPreview',
  'corner-hover = b9dfdd5e587d6021',
  'corner-click: selection,connectionSelection',
  'corner-click: pickAnchor',
  'corner-click: numericInput',
  'corner-click = b74b21267b165c7e',
  'corner-miss: editErrorKey',
  'corner-miss = 8bcec04287cf9777',
  'projection-tool: selection,numericInput,editPreview,editErrorKey,activeTool,selectionKind',
  'projection-tool = 03cbf5fc9294b1b1',
  'projection-miss: editErrorKey',
  'projection-miss = 916d52c607fa96b2',
  'section-tool: selection,editErrorKey,activeTool,selectionKind',
  'section-tool = 03cbf5fc9294b1b1',
  'section-miss: editErrorKey',
  'section-miss = 847a328187d9c14c',
  'escape: selection,connectionSelection,editErrorKey',
  'escape: activeTool',
  'escape = 03cbf5fc9294b1b1',
  'sphere-tool: activeTool',
  'sphere-tool = 03cbf5fc9294b1b1',
  'sphere-hover: hoveredElementId',
  'sphere-hover = 15165a26d8f7a1d1',
  'sphere-click: pickAnchor',
  'sphere-click: selection,connectionSelection',
  'sphere-click = 1f0cee93d04ed0e9',
];
const SELECTION_KIND_TRACE: readonly string[] = [
  'face-kind: selection,selectionKind',
  'face-kind = dd44e0306effe1f8',
  'face-hover: hoveredElementId',
  'face-hover = fe6680da2b981d0f',
  'face-click: pickAnchor',
  'face-click: selection,connectionSelection',
  'face-click = 08336a6a54458d47',
  'face-empty: selection,connectionSelection',
  'face-empty: pickAnchor',
  'face-empty = fe6680da2b981d0f',
  'body-kind: selection,connectionSelection,selectionKind',
  'body-kind = fe6680da2b981d0f',
  'body-click: pickAnchor',
  'body-click: selection,connectionSelection',
  'body-click = 955df1d1d86a3fee',
  'horizontal-tool: selection,activeConstraintKind',
  'horizontal-tool = 93aefdd281ac7c0a',
  'horizontal-pick: pickAnchor',
  'horizontal-pick: selection,connectionSelection',
  'horizontal-pick: constraintTargets',
  'horizontal-pick: document,undoStack,selection,hoveredElementId',
  'horizontal-pick: constraintTargets',
  'horizontal-pick: selectedConstraintId',
  'horizontal-pick = b04001157ff50f28',
  'constraint-empty: constraintTargets',
  'constraint-empty: selection,connectionSelection',
  'constraint-empty = 501a80b668e342e6',
  'parallel-tool: activeConstraintKind,constraintTargets',
  'parallel-tool: selection,activeConstraintKind',
  'parallel-tool = 501a80b668e342e6',
  'parallel-first: pickAnchor',
  'parallel-first: selection,connectionSelection',
  'parallel-first: constraintTargets',
  'parallel-first = b6cfd5493afd5a71',
  'parallel-second: constraintTargets',
  'parallel-second: selection,connectionSelection',
  'parallel-second = 00234c4353dc79e1',
  'constraint-escape: selection,connectionSelection',
  'constraint-escape: activeConstraintKind,constraintTargets',
  'constraint-escape: selection',
  'constraint-escape = 00234c4353dc79e1',
  'selection-escape: selection,connectionSelection',
  'selection-escape: selectedConstraintId',
  'selection-escape = 9ccb68197b463907',
  'mark-click: selectedConstraintId',
  'mark-click = 00234c4353dc79e1',
  'mark-miss: pickAnchor',
  'mark-miss: selection,connectionSelection',
  'mark-miss = e7c2247cfc59a76b',
];
