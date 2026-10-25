import { expressionValueFromNumber } from '@pointercad/expression';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch } from '@pointercad/model';
import type { ConstrainedSketchJob, SketchConstraint, SketchDocument, SketchFeature } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constraintResolveOptions } from '../sketch/constraintActions.js';
import { orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import * as dragSolver from './dragSketch.js';
import { createSketchDragSession } from './sketchDragSession.js';
import { createSketchInteractionIndicators } from './sketchInteractionIndicators.js';

const COUNT = 1000;
const realCreateDragSolveJob = dragSolver.createDragSolveJob;
const frames = new Map<number, FrameRequestCallback>();
const observed: ReturnType<ConstrainedSketchJob['stepWork']>[] = [];
let nextFrame = 1, disposed = false, cancels = 0;
// Deterministic work cost: existing cancellation cases stop after each real quantum.
// Scheduling tests below vary that cost without replacing any numerical result.
let clockMs = 0, quantumCostMs = 4;
function sketch(base: SketchDocument): SketchDocument {
  const features: SketchFeature[] = Array.from({ length: COUNT }, (_, i) => ({
    id: `p${i}`, name: `p${i}`, kind: 'point', planeId: 'xy', at: absoluteCoordinate(20 * i, 0, 0),
  }));
  const constraints: SketchConstraint[] = [];
  for (let i = 1; i < COUNT; i += 1) for (const kind of ['horizontalDistance', 'verticalDistance'] as const) {
    constraints.push({ id: `${kind}${i}`, name: kind, kind, a: { kind: 'point', pointId: 'p0' },
      b: { kind: 'point', pointId: `p${i}` }, length: expressionValueFromNumber(kind === 'horizontalDistance' ? 20 * i : 0) });
  }
  return { ...base, features, constraints };
}
function install(): void {
  resetTestStore();
  const empty = createEmptyPartDocument(), document = replaceSketch(empty, sketch(empty.sketches[0]));
  const state = useAppStore.getState();
  state.resetDocument(document); state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success'); useAppStore.setState({ snapEnabled: false });
}
function oneFrame(): FrameRequestCallback {
  const first = frames.entries().next();
  if (first.done) throw new Error('Expected a pending public frame');
  const [id, callback] = first.value; frames.delete(id); callback(0); return callback;
}
function settle(limit = 1): number {
  let completed = 0;
  for (let count = 0; frames.size > 0; count += 1) {
    if (count >= limit) throw new Error('Public owner exceeded the reference job frame count');
    oneFrame();
    completed += 1;
  }
  return completed;
}
function session() {
  return createSketchDragSession({ scene: { screenToPlanePoint: (x, y) => [x, y, 0] },
    project: point => [point[0], point[1]], getOrbit: () => orbitFrom(0, 0),
    indicators: createSketchInteractionIndicators(), releaseCapture: () => undefined, disposed: () => disposed });
}
function reachInnerWork(): void {
  // Initial vector passes plus multiply setup, before its first stored entry; no CG iteration multiplier.
  const firstEntryFrames = Math.ceil((20 * (2 * COUNT) + 2 * COUNT + 64) / 4096) + 2;
  for (let count = 0; count < firstEntryFrames; count += 1) {
    oneFrame();
    const current = observed.at(-1);
    if (current !== undefined && current.productEntries > 0) {
      expect(current.status).toBe('pending'); expect(current.phase).toBe('solve');
      // First observed product cannot be complete: its two passes visit 2*(4*999+2) entries.
      expect(current.productEntries).toBeLessThan(2 * (4 * (COUNT - 1) + 2));
      expect(useAppStore.getState().dragResolved).toBeNull();
      return;
    }
  }
  throw new Error('No real sparse operator work reached');
}
beforeEach(() => {
  frames.clear(); observed.length = 0; nextFrame = 1; disposed = false; cancels = 0;
  clockMs = 0; quantumCostMs = 4;
  vi.spyOn(globalThis.performance, 'now').mockImplementation(() => clockMs);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(dragSolver, 'createDragSolveJob').mockImplementation((...args) => {
    const job = realCreateDragSolveJob(...args);
    return { ...job, stepWork(budget) {
      const progress = job.stepWork(budget); observed.push(progress); clockMs += quantumCostMs; return progress;
    },
      cancel() { cancels += 1; job.cancel(); } };
  });
  install();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

describe('public RAF cancellation during actual sparse operator work', () => {
  it.each([
    { costMs: 0.5, expectedQuanta: 8 },
    { costMs: 5, expectedQuanta: 1 },
  ])('uses available frame time at $costMs ms per quantum and still yields for cancellation', ({ costMs, expectedQuanta }) => {
    quantumCostMs = costMs;
    const drag = session(); expect(drag.begin([0, 0])).toBe(true);
    const before = useAppStore.getState(); drag.schedule([5, 3]);
    oneFrame(); // Indivisible setup always yields before numerical work.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.work).toBe(1);
    const start = clockMs;
    oneFrame();
    expect(observed).toHaveLength(1 + expectedQuanta);
    expect(observed.slice(1).every(progress => progress.work === 4096)).toBe(true);
    expect(clockMs - start).toBe(expectedQuanta * costMs);
    expect(frames.size).toBe(1);
    expect(drag.observe()).toMatchObject({ active: true, solvePending: true, frameReserved: true });
    drag.finish();
    const late = frames.values().next().value;
    if (late === undefined) throw new Error('Missing bounded continuation');
    const calls = observed.length;
    drag.stop(false); late(0);
    expect(observed).toHaveLength(calls);
    expect(frames.size).toBe(0);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it.each(['escape', 'document', 'dispose', 'new-grab'] as const)(
    '%s cancels a released inner solve and rejects its dequeued callback', ending => {
      const drag = session(); expect(drag.begin([0, 0])).toBe(true);
      const before = useAppStore.getState(); drag.schedule([5, 3]); reachInnerWork(); drag.finish();
      const late = frames.values().next().value;
      if (late === undefined) throw new Error('Missing queued callback');
      if (ending === 'escape') drag.stop(false);
      else if (ending === 'document') useAppStore.getState().resetDocument(createEmptyPartDocument());
      else if (ending === 'dispose') disposed = true;
      else expect(drag.begin([0, 0])).toBe(true);
      const retained = useAppStore.getState(); late(0); settle();
      expect(cancels).toBeGreaterThan(0);
      expect(useAppStore.getState().document).toBe(retained.document);
      expect(useAppStore.getState().undoStack).toBe(retained.undoStack);
      expect(useAppStore.getState().dragResolved).toBeNull();
      if (ending !== 'document') expect(useAppStore.getState().document).toBe(before.document);
      drag.stop(false);
    });

  it('batches cheap real work without changing any reference progress or the committed geometry', () => {
    quantumCostMs = 0.5;
    const drag = session(); expect(drag.begin([0, 0])).toBe(true);
    const before = useAppStore.getState();
    if (before.sketchDrag === null) throw new Error('Missing reference owner');
    const reference = realCreateDragSolveJob(before.sketch, before.sketchDrag, [7, 4], constraintResolveOptions(before));
    const expected: ReturnType<ConstrainedSketchJob['stepWork']>[] = [];
    const n = 2 * COUNT, rows = 2 * COUNT, entries = 4 * (COUNT - 1) + 2;
    const workLimit = 50 * 24 * (2 * n * (50 * n + 8 * entries + 8 * rows + 64) + 50 * n + 64) + 10;
    for (let call = 0; call < Math.ceil(workLimit / 4096) + 3; call += 1) {
      const progress = reference.stepWork(4096); expected.push(progress);
      if (progress.status !== 'pending') break;
    }
    expect(expected.at(-1)?.status).toBe('completed');
    drag.schedule([7, 4]); drag.finish();
    expect(settle(expected.length)).toBeLessThan(expected.length);
    expect(observed).toEqual(expected);
    const after = useAppStore.getState();
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(after.dragResolved?.errors).toEqual([]);
    for (let i = 0; i < COUNT; i += 1) {
      const point = after.dragResolved?.points.find(entry => entry.id === `p${i}`);
      expect(Math.abs((point?.position[0] ?? NaN) - 20 * i - 7)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs((point?.position[1] ?? NaN) - 4)).toBeLessThanOrEqual(1e-6);
    }
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(before.document);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after.document);
    drag.stop(false);
  });

  it('cancels a replaced pointer immediately, ignores the old callback, and commits the later solve once', () => {
    const drag = session(); expect(drag.begin([0, 0])).toBe(true);
    const before = useAppStore.getState(); drag.schedule([5, 3]); reachInnerWork();
    const late = frames.values().next().value;
    if (late === undefined) throw new Error('Missing old callback');
    const previousCancels = cancels;
    drag.schedule([7, 4]);
    expect(cancels).toBe(previousCancels + 1);
    const queued = [...frames.keys()]; late(0);
    expect([...frames.keys()]).toEqual(queued);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().dragResolved).toBeNull();
    const current = useAppStore.getState();
    if (current.sketchDrag === null) throw new Error('Missing current drag owner');
    const reference = realCreateDragSolveJob(current.sketch, current.sketchDrag, [7, 4], constraintResolveOptions(current));
    const expected: ReturnType<ConstrainedSketchJob['stepWork']>[] = [];
    const n = 2 * COUNT, rows = 2 * COUNT, entries = 4 * (COUNT - 1) + 2;
    const workLimit = 50 * 24 * (2 * n * (50 * n + 8 * entries + 8 * rows + 64) + 50 * n + 64) + 10;
    for (let call = 0; call < Math.ceil(workLimit / 4096) + 3; call += 1) {
      const progress = reference.stepWork(4096); expected.push(progress);
      if (progress.status !== 'pending') break;
    }
    expect(expected.at(-1)?.status).toBe('completed');
    const offset = observed.length;
    drag.finish([7, 4]);
    expect(settle(expected.length)).toBe(expected.length);
    expect(observed.slice(offset)).toEqual(expected);
    const after = useAppStore.getState();
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(after.dragResolved?.errors).toEqual([]);
    for (let i = 0; i < COUNT; i += 1) {
      const point = after.dragResolved?.points.find(entry => entry.id === `p${i}`);
      expect(Math.abs((point?.position[0] ?? NaN) - 20 * i - 7)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs((point?.position[1] ?? NaN) - 4)).toBeLessThanOrEqual(1e-6);
    }
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(before.document);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(after.document);
    drag.stop(false);
  });
});
