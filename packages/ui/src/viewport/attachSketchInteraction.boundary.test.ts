/**
 * R07: store updates at the boundary of the four input series of `attachSketchInteraction`
 * (selection, drawing, drag, cancel). The traces were recorded from the implementation before
 * its drag session, section handle and transient indicators were split into their own modules;
 * the split must produce exactly the same updates in the same order.
 */
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createPointFeature, DEFAULT_FACE_COLOR, replaceSketch } from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function harness(pickBody: () => string | null = () => null): Harness {
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
  const projection: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay' | 'pickBody'> = {
    worldToScreen: point => [point[0], point[1]], screenToPlanePoint: (x, y) => [x, y, 0], pointerRay: () => null,
    pickBody,
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

// Recorded with the implementation before the split (RUN 20261005-160350-cl-v103-r30-face-unit).
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
