import { createHash } from 'node:crypto';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import {
  CONSTRAINT_TOLERANCE, createEmptyPartDocument, replaceSketch, SKETCH_TOLERANCE_MM,
  type ResolvedSketch, type Vec3,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTED_1000_FIXTURE_SHA256, CONNECTED_1000_POINT_COUNT, connected1000FixtureText, connected1000Original,
  connected1000PointId, connected1000Sketch,
} from '../../../model/src/sketch/constraints/connected1000Fixture.testSupport.js';
import { constraintContextOfStore } from '../sketch/constraintActions.js';
import { orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { recomputeRetention } from './dragSketch.retentionSupport.js';
import { createSketchDragSession } from './sketchDragSession.js';
import { createSketchInteractionIndicators } from './sketchInteractionIndicators.js';

// Exactly 1000 distinct free points. All 998 outer points belong to triangles
// sharing the same two anchors, not independent pairs or unconstrained filler.
// The input is the one fixed EX-13 W01 fixture (model connected1000Fixture.testSupport.ts), also used by
// diagnose.test.ts and the Web/Electron scripts: 1997 distances, then the 6-8-10 anchor triangle's
// vertical distance fixes orientation on its initial positive-x branch. Translation is still free;
// the actual drag pin determines its final value. Its SHA-256 is asserted below.
const COUNT = CONNECTED_1000_POINT_COUNT;
const idOf = connected1000PointId;
const original = connected1000Original;
function install(): void {
  resetTestStore();
  const empty = createEmptyPartDocument();
  const document = replaceSketch(empty, connected1000Sketch(empty.sketches[0]));
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  // Existing store fixture resolves the actual initial coordinates only. No
  // solver output is mocked: every move below uses the real public drag job.
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
  useAppStore.setState({ snapEnabled: false });
}
function assertCapacityAndConnectivity(): void {
  const state = useAppStore.getState();
  expect(state.sketch.features).toHaveLength(COUNT);
  expect(state.sketch.features.every(feature => feature.kind === 'point')).toBe(true);
  expect(new Set(state.sketch.features.map(feature => feature.id)).size).toBe(COUNT);
  expect(new Set(state.resolvedSketch.points.map(point => JSON.stringify(point.position))).size).toBe(COUNT);
  expect(state.resolvedSketch.points).toHaveLength(COUNT);
  expect(constraintContextOfStore(state).variableSet?.variables).toHaveLength(2000);
  const constraints = state.sketch.constraints ?? [];
  // The installed input is byte for byte the fixed fixture (same SHA-256 as the model test and the scripts).
  expect(createHash('sha256').update(connected1000FixtureText(state.sketch.features, constraints)).digest('hex'))
    .toBe(CONNECTED_1000_FIXTURE_SHA256);
  expect(constraints).toHaveLength(1998);
  expect(constraints.filter(constraint => constraint.kind === 'distance')).toHaveLength(1997);
  const adjacency = new Map<string, Set<string>>();
  for (const constraint of constraints) {
    if ((constraint.kind !== 'distance' && constraint.kind !== 'verticalDistance')
      || constraint.a.kind !== 'point' || constraint.b.kind !== 'point') throw new Error('Unexpected capacity constraint');
    const first = adjacency.get(constraint.a.pointId) ?? new Set<string>();
    const second = adjacency.get(constraint.b.pointId) ?? new Set<string>();
    first.add(constraint.b.pointId); second.add(constraint.a.pointId);
    adjacency.set(constraint.a.pointId, first); adjacency.set(constraint.b.pointId, second);
  }
  const reached = new Set<string>([idOf(0)]), queue = [idOf(0)];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  expect(reached.size).toBe(COUNT);
}
function assertGeometry(resolved: ResolvedSketch, translation: readonly [number, number]): void {
  expect(resolved.errors).toEqual([]);
  expect(resolved.points).toHaveLength(COUNT);
  const points = new Map(resolved.points.map(point => [point.id, point.position]));
  const at = (index: number): Vec3 => {
    const point = points.get(idOf(index));
    if (point === undefined) throw new Error(`Missing actual point ${index}`);
    return point;
  };
  // Closed-form coordinates and elementary Euclidean lengths, never another solve.
  for (let index = 0; index < COUNT; index += 1) {
    const actual = at(index), initial = original(index);
    expect(Math.abs(actual[0] - initial[0] - translation[0])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
    expect(Math.abs(actual[1] - initial[1] - translation[1])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
    expect(actual[2]).toBe(0);
    for (const anchor of index === 1 ? [0] : index >= 2 ? [0, 1] : []) {
      const center = at(anchor), originalCenter = original(anchor);
      const expected = Math.hypot(initial[0] - originalCenter[0], initial[1] - originalCenter[1]);
      expect(Math.abs(Math.hypot(actual[0] - center[0], actual[1] - center[1]) - expected))
        .toBeLessThanOrEqual(CONSTRAINT_TOLERANCE);
    }
  }
  const first = at(0), second = at(1);
  expect(Math.abs(second[1] - first[1] - 6)).toBeLessThanOrEqual(CONSTRAINT_TOLERANCE);
  expect(Math.abs(Math.atan2(second[1] - first[1], second[0] - first[0]) - Math.atan2(6, 8)))
    .toBeLessThanOrEqual(SKETCH_TOLERANCE_MM / 10);
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1, releases = 0, disposed = false;
function oneFrame(): FrameRequestCallback {
  const next = frames.entries().next();
  if (next.done === true) throw new Error('Expected pending real solve frame');
  const [id, callback] = next.value;
  frames.delete(id); callback(0); return callback;
}
function settle(): void {
  // The old 301-frame guard counted four complete attempts per frame. Frames now
  // carry 4096 inner units. Bound the same 50*24 attempts and 2*n CG iterations:
  // at most 50*n+8*nnz+8*rows+64 units per CG iteration, including true residual
  // and representation checks. This changes scheduling units, not solver caps.
  const n = 2 * COUNT, rows = 2 * COUNT, nnz = 8 * COUNT;
  const perAttempt = 2 * n * (50 * n + 8 * nnz + 8 * rows + 64) + 50 * n + 64;
  const frameLimit = Math.ceil(50 * 24 * perAttempt / 4096) + 10;
  let count = 0;
  while (frames.size > 0) { oneFrame(); if (++count > frameLimit) throw new Error('Solve did not settle within original numerical work bounds'); }
}
function session() {
  return createSketchDragSession({
    scene: { screenToPlanePoint: (x, y) => [x, y, 0] }, project: point => [point[0], point[1]],
    getOrbit: () => orbitFrom(0, 0), indicators: createSketchInteractionIndicators(),
    releaseCapture: () => { releases += 1; }, disposed: () => disposed,
  });
}
beforeEach(() => {
  frames.clear(); nextFrame = 1; releases = 0; disposed = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  install();
});
afterEach(() => { vi.unstubAllGlobals(); resetTestStore(); });

describe('connected 1000-point nonlinear public drag session', () => {
  it('replaces unfinished targets and commits only the final pointerup once, with independent geometry, recompute, true IO and Undo/Redo', async () => {
    assertCapacityAndConnectivity();
    assertGeometry(useAppStore.getState().resolvedSketch, [0, 0]);
    const drag = session(), before = useAppStore.getState();
    const originalBytes = JSON.stringify(before.document);
    const final = [40, 30] as const;
    try {
      expect(drag.begin([0, 0])).toBe(true);
      expect(useAppStore.getState().sketchDrag?.pointKey).toBe(idOf(0));
      drag.schedule([12, -8]);
      oneFrame();
      // A real unfinished solve is required, rather than merely an uncalled RAF.
      expect(frames.size).toBe(1);
      expect(useAppStore.getState().dragResolved).toBeNull();
      drag.schedule([25, 20]);
      oneFrame();
      expect(useAppStore.getState().dragResolved).toBeNull();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      drag.finish(final);
      expect(releases).toBe(1);
      expect(useAppStore.getState().document).toBe(before.document);
      drag.schedule([99, 99]); // Released target is immutable.
      settle();
      const after = useAppStore.getState(), preview = after.dragResolved;
      if (preview === null) throw new Error('No completed public drag geometry');
      assertGeometry(preview, final);
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(after.document).not.toBe(before.document);
      expect(drag.active()).toBe(false);
      const point = after.sketch.features.find(feature => feature.id === idOf(0));
      if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Dragged stored point missing');
      expect(Math.abs(point.at.x.value - final[0])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
      expect(Math.abs(point.at.y.value - final[1])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
      expect(after.sketch.constraints).toBe(before.sketch.constraints);
      for (let index = 0; index < COUNT; index += 1) {
        const saved = after.sketch.features[index];
        if (saved.kind !== 'point' || saved.at.mode !== 'absolute') throw new Error('Missing editable point seed');
        expect(Math.abs(saved.at.x.value - original(index)[0] - final[0])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
        expect(Math.abs(saved.at.y.value - original(index)[1] - final[1])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
      }
      useAppStore.getState().recordRecomputeRequest(2);
      const recomputed = await recomputeRetention(after.document);
      assertGeometry(recomputed.sketches[0].resolved, final);
      useAppStore.getState().applyRecompute(after.document, recomputed);
      useAppStore.getState().recordRecomputeCompletion(2, 'success');
      expect(useAppStore.getState().dragResolved).toBeNull();
      assertGeometry(useAppStore.getState().resolvedSketch, final);
      const reopened = readPcadFile(writePcadFile(after.document));
      if (!reopened.ok) throw new Error(reopened.error.message);
      expect(reopened.document.sketches[0].constraints).toEqual(after.sketch.constraints);
      const cold = await recomputeRetention(reopened.document);
      assertGeometry(cold.sketches[0].resolved, final);
      expect(JSON.stringify(before.document)).toBe(originalBytes);
      drag.finish(final); settle();
      expect(useAppStore.getState().document).toBe(after.document);
      expect(useAppStore.getState().undoStack).toBe(after.undoStack);
      useAppStore.getState().undo();
      expect(useAppStore.getState().document).toBe(before.document);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toBe(after.document);
    } finally { drag.stop(false); }
  });

  it.each(['escape', 'stale-document', 'disposed'] as const)('%s cannot commit a released unfinished 1000-point solve', ending => {
    assertCapacityAndConnectivity();
    const drag = session(), before = useAppStore.getState();
    try {
      expect(drag.begin([0, 0])).toBe(true);
      drag.schedule([40, 30]); oneFrame();
      expect(useAppStore.getState().dragResolved).toBeNull();
      expect(frames.size).toBe(1);
      drag.finish();
      const late = frames.values().next().value;
      if (late === undefined) throw new Error('Final solve callback missing');
      if (ending === 'escape') drag.stop(false); // The public interaction's Escape action.
      else if (ending === 'stale-document') useAppStore.getState().resetDocument(createEmptyPartDocument());
      else disposed = true;
      const retained = useAppStore.getState();
      late(0); settle(); // Even a callback already dequeued when cancelled cannot commit.
      expect(useAppStore.getState().document).toBe(retained.document);
      expect(useAppStore.getState().undoStack).toBe(retained.undoStack);
      expect(useAppStore.getState().dragResolved).toBeNull();
      if (ending !== 'stale-document') {
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      }
    } finally { drag.stop(false); }
  });
});
