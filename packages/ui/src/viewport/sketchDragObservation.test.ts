import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, createEmptyPartDocument, replaceSketch, type SketchDocument,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { constraintResolveOptions } from '../sketch/constraintActions.js';
import { orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createDragSolveJob } from './dragSketch.js';
import { createSketchDragTiming, sketchDragTimingOwnerChanged, type SketchDragTiming, type SketchTimingContext } from './sketchDragTiming.js';
import { exposeSketchDragObservation, type SketchDragObservation, type SketchDragObservationHost } from './sketchDragObservation.js';
import { createSketchDragSession, type SketchDragSession } from './sketchDragSession.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

// Same real session fixture as sketchDragSession.test.ts: a connected nonlinear corner on the xy plane,
// identity projection, manual animation-frame queue; the dragged point is line-2's end at (10, 8).
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
function newSession(timing?: SketchDragTiming): SketchDragSession {
  return createSketchDragSession({
    scene: { screenToPlanePoint: (x, y) => [x, y, 0] }, project: (point) => [point[0], point[1]],
    getOrbit: () => orbitFrom(0, 0), indicators, releaseCapture: noop, disposed: () => false, timing,
  });
}
/** Precondition: the final target needs more attempts than one frame runs, so its solve is really pending. */
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
  frames.clear(); nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  resetCornerDocument();
});
afterEach(() => { vi.unstubAllGlobals(); resetTestStore(); });

const FINAL: readonly [number, number] = [40, 30];

describe('sketch drag observation (read only)', () => {
  it('publishes only when enabled and an older owner never removes a newer hook', () => {
    const host: SketchDragObservationHost = {};
    exposeSketchDragObservation(host, false, () => newSession().observe())();
    expect(Object.hasOwn(host, 'pcadSketchDragStats')).toBe(false);
    const first = newSession(), second = newSession();
    const unexposeFirst = exposeSketchDragObservation(host, true, () => first.observe());
    const unexposeSecond = exposeSketchDragObservation(host, true, () => second.observe());
    expect(second.begin([10, 8])).toBe(true);
    unexposeFirst();
    expect(host.pcadSketchDragStats?.().active).toBe(true);
    unexposeSecond();
    expect(Object.hasOwn(host, 'pcadSketchDragStats')).toBe(false);
    second.stop(false);
  });

  it('Escape during a pending final solve records the cancellation of that grab and no commit', () => {
    const session = newSession();
    expect(session.observe()).toEqual({ session: 0, active: false, solvePending: false, frameReserved: false,
      releasePending: false, lastCancelled: null, lastCommitted: null });
    expect(session.begin([10, 8])).toBe(true);
    expect(attemptsFor(FINAL)).toBeGreaterThan(4);
    const before = useAppStore.getState();
    session.schedule(FINAL);
    runOneFrame();
    const pending: SketchDragObservation = session.observe();
    expect(Object.isFrozen(pending)).toBe(true);
    expect(pending).toMatchObject({ session: 1, active: true, solvePending: true, frameReserved: true });
    const escapeAt = performance.now();
    session.stop(false); // The interaction's Escape action.
    const after = session.observe();
    expect(after).toMatchObject({ session: 1, active: false, solvePending: false, frameReserved: false,
      releasePending: false, lastCommitted: null });
    expect(after.lastCancelled?.session).toBe(1);
    expect(after.lastCancelled?.atMs).toBeGreaterThanOrEqual(escapeAt);
    expect(pending.active).toBe(true); // An earlier snapshot is a value, not a live view.
    expect(runAllFrames()).toBe(0);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('records a committed release once and a later grab cancellation leaves that commit record unchanged', () => {
    const session = newSession();
    expect(session.begin([10, 8])).toBe(true);
    const undoBefore = useAppStore.getState().undoStack;
    session.schedule(FINAL);
    session.finish();
    expect(session.observe()).toMatchObject({ active: true, releasePending: true, lastCommitted: null });
    const releasedAt = performance.now();
    expect(runAllFrames()).toBeGreaterThan(1);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore.past.length + 1);
    const committed = session.observe();
    expect(committed).toMatchObject({ session: 1, active: false, solvePending: false, lastCancelled: null });
    const record = committed.lastCommitted;
    if (record === null) throw new Error('commit not recorded');
    expect(record.session).toBe(1);
    expect(record.atMs).toBeGreaterThanOrEqual(releasedAt);
    resetCornerDocument();
    expect(session.begin([10, 8])).toBe(true);
    session.schedule(FINAL);
    session.stop(false);
    const later = session.observe();
    expect(later.session).toBe(2);
    expect(later.lastCancelled?.session).toBe(2);
    expect(later.lastCommitted).toEqual(record);
  });
});

it('実sessionの採用resolvedと取消後baselineだけが同じcollectorで描画済みになる', () => {
  const canvas = {};
  let clock = 1000;
  const timing = createSketchDragTiming(canvas, () => clock, 1_700_000_000_000);
  const session = newSession(timing);
  const before = useAppStore.getState();
  const read = (): SketchTimingContext => {
    const state = useAppStore.getState();
    return { canvas, document: state.document, documentVersion: state.documentVersion,
      owner: state.sketchDrag, resolved: state.dragResolved ?? state.resolvedSketch, hidden: false };
  };
  try {
    expect(session.begin([10, 8])).toBe(true);
    session.schedule(FINAL, 900); runAllFrames();
    const preview = useAppStore.getState().dragResolved;
    if (preview === null) throw new Error('Real public job did not adopt a preview');
    timing.setSketch(preview, noop, read); clock = 1100; timing.render(noop, read);
    expect(session.observe().timing?.records[0]).toMatchObject({ eventAtMs: 900, adoptedAtMs: 1000,
      renderedAtMs: 1100, status: 'drawn', kind: 'pointermove' });
    clock = 1200; session.stop(false, 1150, 'escape');
    expect(useAppStore.getState().resolvedSketch).toBe(before.resolvedSketch);
    expect(session.observe().timing?.records[1].renderedAtMs).toBeNull();
    timing.setSketch(before.resolvedSketch, noop, read); clock = 1300; timing.render(noop, read);
    expect(session.observe().timing?.records[1]).toMatchObject({ kind: 'escape', eventAtMs: 1150,
      cancelledAtMs: 1200, renderedAtMs: 1300, status: 'drawn' });
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  } finally { session.stop(false); timing.dispose(); }
});

it('最初のpreview前の取消もownerだけの実store遷移からbaselineを再結合し、render後だけ完了する', () => {
  const canvas = {};
  let clock = 1000, writes = 0;
  const timing = createSketchDragTiming(canvas, () => clock, 1_700_000_000_000);
  const session = newSession(timing), before = useAppStore.getState();
  const read = (): SketchTimingContext => {
    const state = useAppStore.getState();
    return { canvas, document: state.document, documentVersion: state.documentVersion,
      owner: state.sketchDrag, resolved: state.dragResolved ?? state.resolvedSketch, hidden: false };
  };
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.sketchDrag !== previous.sketchDrag) timing.invalidateScene();
    // Canvasと同じ実判定。sceneの境界callbackを通すが、WebGL/画面成功とは数えない。
    if (sketchDragTimingOwnerChanged(timing, next.sketchDrag, previous.sketchDrag)) {
      timing.setSketch(next.dragResolved ?? next.resolvedSketch, () => { writes += 1; }, read);
    }
  });
  try {
    expect(session.begin([10, 8])).toBe(true);
    session.schedule(FINAL, 900);
    expect(session.observe().solvePending).toBe(true);
    expect(useAppStore.getState().dragResolved).toBeNull();
    expect(useAppStore.getState().resolvedSketch).toBe(before.resolvedSketch);
    const active = useAppStore.getState(), writesBeforeCancel = writes;
    timing.render(noop, read);
    expect(timing.snapshot().records[0].renderedAtMs).toBeNull();
    clock = 1200; session.stop(false, 1150, 'escape');
    const cancelled = useAppStore.getState();
    expect(active.sketchDrag).not.toBeNull();
    expect(cancelled.sketchDrag).toBeNull();
    expect(cancelled.dragResolved).toBe(active.dragResolved);
    expect(cancelled.resolvedSketch).toBe(active.resolvedSketch);
    expect(cancelled.document).toBe(before.document);
    expect(cancelled.documentVersion).toBe(before.documentVersion);
    expect(cancelled.undoStack).toBe(before.undoStack);
    expect(writes).toBe(writesBeforeCancel + 1);
    expect(timing.snapshot().records[1]).toMatchObject({ kind: 'escape', cancelledAtMs: 1200, renderedAtMs: null });
    clock = 1300; timing.render(noop, read);
    expect(timing.snapshot().records[1]).toMatchObject({ status: 'drawn', renderedAtMs: 1300 });
    clock = 1400; timing.render(noop, read);
    expect(timing.snapshot().records[1].renderedAtMs).toBe(1300);
    expect(runAllFrames()).toBe(0);
  } finally { unsubscribe(); if (session.active()) session.stop(false); timing.dispose(); }
});
