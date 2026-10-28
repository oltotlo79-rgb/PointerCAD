import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, createEmptyPartDocument, replaceSketch, type SketchDocument,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { constraintContextOfStore, constraintResolveOptions } from '../sketch/constraintActions.js';
import { orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrag, createDragSolveJob, solveWithDrag } from './dragSketch.js';
import { createSketchDragSession, type SketchDragSession } from './sketchDragSession.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

/*
 * The real drag session with a manual animation-frame queue. Screen and plane coordinates coincide (xy plane, identity
 * projection). The sketch is a connected nonlinear corner: line-1 horizontal, line-1 end coincident with line-2 start,
 * |line-2| = 10. The dragged point is line-2's end at (10, 8).
 */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function runOneFrame(): boolean {
  const first = frames.entries().next();
  if (first.done === true) return false;
  const [id, callback] = first.value;
  frames.delete(id);
  callback(0);
  return true;
}
function runAllFrames(limit = 10_000): number {
  let count = 0;
  while (runOneFrame()) {
    count += 1;
    if (count > limit) throw new Error('frames did not settle');
  }
  return count;
}

function cornerSketch(base: SketchDocument): SketchDocument {
  const num = expressionValueFromNumber;
  const line1 = appendFeature(base, { id: 'line-1', name: 'line-1', planeId: 'xy', kind: 'line', construction: false,
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0) });
  const line2 = appendFeature(line1, { id: 'line-2', name: 'line-2', planeId: 'xy', kind: 'line', construction: false,
    from: absoluteCoordinate(10, 0, 0), to: absoluteCoordinate(10, 8, 0) });
  return { ...line2, constraints: [
    { id: 'h-1', name: 'h', kind: 'horizontal', target: { kind: 'curve', element: { featureId: 'line-1' } } },
    { id: 'c-1', name: 'c', kind: 'coincident', a: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      b: { kind: 'vertex', featureId: 'line-2', vertex: 'start' } },
    { id: 'd-1', name: 'd', kind: 'distance', a: { kind: 'vertex', featureId: 'line-2', vertex: 'start' },
      b: { kind: 'vertex', featureId: 'line-2', vertex: 'end' }, length: num(10) },
  ] };
}

function resetCornerDocument(): void {
  resetTestStore();
  const empty = createEmptyPartDocument();
  const document = replaceSketch(empty, cornerSketch(empty.sketches[0]));
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
  useAppStore.setState({ snapEnabled: false });
}

const noop = (): void => undefined;
const indicators: SketchInteractionIndicators = {
  showSnap: noop, showTrack: noop, showInferred: noop, showEdit: noop, hideEdit: noop, clearSnapIndicators: noop,
  clearInferredConstraints: noop, clearOwnedIndicators: noop, clearOwnedEdit: noop,
};

let disposed = false;
let planeAvailable = true;
let releases = 0;
function newSession(): SketchDragSession {
  return createSketchDragSession({
    scene: { screenToPlanePoint: (x, y) => planeAvailable ? [x, y, 0] : null },
    project: (point) => [point[0], point[1]],
    getOrbit: () => orbitFrom(0, 0),
    indicators,
    releaseCapture: () => { releases += 1; },
    disposed: () => disposed,
  });
}

/** Damping attempts the job of `target` needs (precondition: more than the 4 the session runs per frame). */
function attemptsFor(target: readonly [number, number]): number {
  const state = useAppStore.getState();
  const drag = state.sketchDrag;
  if (drag === null) throw new Error('no drag');
  const job = createDragSolveJob(state.sketch, drag, target, constraintResolveOptions(state));
  let units = 1;
  while (job.step(1) === null) units += 1;
  return units;
}

beforeEach(() => {
  frames.clear(); nextFrame = 1; disposed = false; releases = 0; planeAvailable = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  resetCornerDocument();
});
afterEach(() => { vi.unstubAllGlobals(); resetTestStore(); });

const FINAL: readonly [number, number] = [40, 30];

describe('sketch drag session: bounded resumable solving', () => {
  it('a release with the final pointer still pending commits exactly the final target once, after its job finishes', () => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    expect(attemptsFor(FINAL)).toBeGreaterThan(4);
    const undoBefore = useAppStore.getState().undoStack;
    session.schedule([12, 9]);
    runOneFrame();
    session.schedule(FINAL);
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null) throw new Error('no drag');
    const plane = constraintContextOfStore(state).plane;
    const expectedSolve = solveWithDrag(state.sketch, drag, FINAL, constraintResolveOptions(state));
    const expected = commitDrag(state.sketch, drag, expectedSolve.solution, expectedSolve.resolved, plane);
    const before = useAppStore.getState().sketch;
    session.finish();
    expect(releases).toBe(1); // capture released at once, before the job finishes
    expect(useAppStore.getState().sketch).toBe(before); // nothing committed yet: the final target is still solving
    expect(runAllFrames()).toBeGreaterThan(1);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore.past.length + 1);
    expect(useAppStore.getState().sketch).toEqual(expected);
    expect(session.active()).toBe(false);
    const committed = useAppStore.getState().document;
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toEqual(state.document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toEqual(committed);
  });

  it.each(['escape', 'document', 'dispose', 'new grab'] as const)('%s during the final job commits nothing and leaves no preview', (ending) => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    expect(attemptsFor(FINAL)).toBeGreaterThan(4);
    const undoBefore = useAppStore.getState().undoStack;
    const sketchBefore = useAppStore.getState().sketch;
    session.schedule(FINAL);
    runOneFrame(); // the job has started but not finished
    expect(useAppStore.getState().dragResolved).toBeNull();
    session.finish(); // release pending
    if (ending === 'escape') session.stop(false);
    else if (ending === 'document') {
      resetCornerDocument(); // a replaced document: the owner no longer matches
    } else if (ending === 'dispose') disposed = true;
    else expect(session.begin([0, 0])).toBe(true);
    runAllFrames();
    if (ending !== 'document') {
      // Zero commits: neither a history step nor a changed sketch.
      expect(useAppStore.getState().undoStack).toBe(undoBefore);
      expect(useAppStore.getState().sketch).toBe(sketchBefore);
    }
    if (ending !== 'dispose' && ending !== 'new grab') expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('an intermediate target is never shown once a newer pointer arrived', () => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    const shown: unknown[] = [];
    const unsubscribe = useAppStore.subscribe((state) => { if (state.dragResolved !== null) shown.push(state.dragResolved); });
    try {
      session.schedule([25, 20]);
      runOneFrame();
      session.schedule(FINAL);
      runAllFrames();
    } finally { unsubscribe(); }
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null) throw new Error('no drag');
    const final = solveWithDrag(state.sketch, drag, FINAL, constraintResolveOptions(state)).resolved;
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.at(-1)).toEqual(final);
  });

  it('grabbed without moving: no history step', () => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    const undoBefore = useAppStore.getState().undoStack;
    session.finish();
    runAllFrames();
    expect(useAppStore.getState().undoStack).toBe(undoBefore);
    expect(session.active()).toBe(false);
  });
});


describe('latest invalid drag target supersedes every earlier solve', () => {
  it.each(['pending', 'completed'] as const)('%s old target cannot publish or commit after an invalid latest target', phase => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    expect(attemptsFor(FINAL)).toBeGreaterThan(4);
    const before = useAppStore.getState();
    session.schedule(FINAL);
    runOneFrame();
    if (phase === 'completed') {
      runAllFrames();
      expect(useAppStore.getState().dragResolved).not.toBeNull();
    } else expect(useAppStore.getState().dragResolved).toBeNull();
    planeAvailable = false;
    session.schedule([45, 35]);
    runAllFrames();
    expect(useAppStore.getState().dragResolved).toBeNull();
    expect(session.active()).toBe(true);
    session.finish([45, 35]);
    runAllFrames();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().dragResolved).toBeNull();
    expect(session.active()).toBe(false);
  });

  it.each(['pending', 'completed'] as const)('%s old target is discarded and a later valid target can complete once', phase => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    const before = useAppStore.getState();
    const drag = before.sketchDrag;
    if (drag === null) throw new Error('no drag');
    session.schedule(FINAL);
    runOneFrame();
    if (phase === 'completed') runAllFrames();
    planeAvailable = false;
    session.schedule([45, 35]);
    runAllFrames();
    expect(useAppStore.getState().dragResolved).toBeNull();
    planeAvailable = true;
    const final = [30, 25] as const;
    const solved = solveWithDrag(before.sketch, drag, final, constraintResolveOptions(before));
    const expected = commitDrag(before.sketch, drag, solved.solution, solved.resolved, constraintContextOfStore(before).plane);
    session.schedule(final);
    session.finish(final);
    runAllFrames();
    expect(useAppStore.getState().sketch).toEqual(expected);
    expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(session.active()).toBe(false);
  });
});

describe('a drag that needs no nonlinear solve is shown after one frame (2026-10-25 regression)', () => {
  /*
   * The corner without its constraints: the drag only places the point, so its job has nothing to solve. Since the
   * cooperative drag frames (2026-10-18) that job reported "pending" after its setup and the shape appeared one frame
   * late; the interaction tests (attachSketchInteraction*.test.ts) expect it after one frame.
   */
  function resetUnconstrainedDocument(): void {
    resetTestStore();
    const empty = createEmptyPartDocument();
    const document = replaceSketch(empty, { ...cornerSketch(empty.sketches[0]), constraints: [] });
    const state = useAppStore.getState();
    state.resetDocument(document);
    state.recordRecomputeRequest(1);
    state.applyRecompute(document, { ...resultFor(document), generation: 1 });
    state.recordRecomputeCompletion(1, 'success');
    useAppStore.setState({ snapEnabled: false });
  }
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([0, 5])('one frame shows the placed shape and the release commits it without another frame (%i ms per clock read)',
    msPerRead => {
      resetUnconstrainedDocument();
      // 5 ms per read: the 4 ms solve slice of the frame is already spent when the setup returns.
      let clock = 0;
      vi.spyOn(globalThis.performance, 'now').mockImplementation(() => { clock += msPerRead; return clock; });
      const session = newSession();
      expect(session.begin([10, 8])).toBe(true);
      const before = useAppStore.getState();
      const drag = before.sketchDrag;
      if (drag === null) throw new Error('no drag');
      const expected = solveWithDrag(before.sketch, drag, FINAL, constraintResolveOptions(before));
      expect(expected.outcome).toBeNull(); // placed, not solved
      session.schedule(FINAL);
      expect(frames.size).toBe(1);
      runOneFrame();
      expect(useAppStore.getState().dragResolved).toEqual(expected.resolved);
      expect(frames.size).toBe(0);
      expect(session.observe()).toMatchObject({ active: true, solvePending: false, frameReserved: false });
      expect(useAppStore.getState().document).toBe(before.document);
      session.finish(FINAL);
      expect(frames.size).toBe(0);
      expect(useAppStore.getState().sketch).toEqual(
        commitDrag(before.sketch, drag, expected.solution, expected.resolved, constraintContextOfStore(before).plane));
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(session.active()).toBe(false);
    });
});

it('既存の内部schedule/stopは観測collectorなしで互換のまま動く', () => {
  const session = newSession(), before = useAppStore.getState();
  try {
    expect(session.begin([10, 8])).toBe(true);
    session.schedule([40, 30]); session.stop(false);
    expect(Object.hasOwn(session.observe(), 'timing')).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  } finally { session.stop(false); }
});
