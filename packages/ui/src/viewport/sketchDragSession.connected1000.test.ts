import { createHash } from 'node:crypto';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import {
  absoluteCoordinate, CONSTRAINT_TOLERANCE, createConstrainedSketchJob, createEmptyPartDocument, replaceFeature, replaceSketch, SKETCH_TOLERANCE_MM,
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
import * as dragSolver from './dragSketch.js';
import { commitDrag, type SketchDrag } from './dragSketch.js';
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


describe('1000点の確定処理と中断完了の境界', () => {
  it('全1000seedを独立した平行移動へ一括確定し、元の配列を1000回作り直さない', () => {
    assertCapacityAndConnectivity();
    const before = useAppStore.getState(), document = before.sketch;
    const originalBytes = JSON.stringify(before.document);
    const solution = new Map<string, Vec3>(Array.from({ length: COUNT }, (_, index) => {
      const point = original(index);
      return [idOf(index), [point[0] + 40, point[1] + 30, 0]];
    }));
    const drag: SketchDrag = { pointKey: idOf(0), featureId: idOf(0), field: 'at', index: null,
      startUv: [0, 0], grabUv: [0, 0] };
    // 実時間の代用ではなく、全features配列を作る回数の構造的な退行検査。
    const map = vi.spyOn(document.features, 'map');
    const actual = commitDrag(document, drag, solution);
    expect(map).toHaveBeenCalledTimes(1); // 確定配列を作る1回だけ。
    map.mockRestore();
    expect(actual.constraints).toBe(document.constraints);
    expect(actual.features).toHaveLength(COUNT);
    for (let index = 0; index < COUNT; index += 1) {
      const feature = actual.features[index], point = original(index);
      if (feature.kind !== 'point' || feature.at.mode !== 'absolute') throw new Error('Missing numeric point');
      expect(feature.id).toBe(idOf(index));
      expect(feature.at.x.value).toBe(point[0] + 40);
      expect(feature.at.y.value).toBe(point[1] + 30);
      expect(feature.at.z.value).toBe(0);
    }
    expect(JSON.stringify(before.document)).toBe(originalBytes);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    const invalid = new Map(solution);
    invalid.set(idOf(COUNT - 1), [Number.NaN, 0, 0]);
    expect(commitDrag(document, drag, invalid)).toBe(document);
    const unchanged = new Map(Array.from({ length: COUNT }, (_, index) => [idOf(index), original(index)]));
    expect(commitDrag(document, drag, unchanged)).toBe(document);
  });

  it('同じfeatureの複数欄の更新順は旧replaceFeatureの独立手順と一致する', () => {
    const base = useAppStore.getState().sketch;
    const line = { id: 'both-ends', name: 'both-ends', kind: 'line' as const, planeId: 'xy',
      construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(1, 0, 0) };
    const document = { ...base, features: [...base.features, line] };
    const drag: SketchDrag = { pointKey: 'both-ends:start', featureId: line.id, field: 'from', index: null,
      startUv: [0, 0], grabUv: [0, 0] };
    const first = commitDrag(document, drag, new Map([['both-ends:start', [4, -3, 0]]]));
    const expected = commitDrag(first, { ...drag, pointKey: 'both-ends:end', field: 'to' },
      new Map([['both-ends:end', [5, -3, 0]]]));
    const actual = commitDrag(document, drag,
      new Map([['both-ends:start', [4, -3, 0]], ['both-ends:end', [5, -3, 0]]]));
    expect(actual).toEqual(expected);
    const changed = actual.features.at(-1);
    if (changed?.kind !== 'line') throw new Error('Missing edited line');
    expect(replaceFeature(document, line.id, changed)).toEqual(actual);
  });

  it('中断時刻は実1000点jobとcapture/store/表示の解放後を示し、遅いcallbackは確定しない', () => {
    assertCapacityAndConnectivity();
    const before = useAppStore.getState();
    let clock = 0;
    const timer = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => clock);
    const drag = createSketchDragSession({
      scene: { screenToPlanePoint: (x, y) => [x, y, 0] }, project: point => [point[0], point[1]],
      getOrbit: () => orbitFrom(0, 0),
      indicators: { ...createSketchInteractionIndicators(), clearOwnedIndicators: () => { clock = 17; } },
      releaseCapture: () => { clock = 11; }, disposed: () => false,
    });
    try {
      expect(drag.begin([0, 0])).toBe(true);
      drag.schedule([40, 30]); oneFrame(); drag.finish();
      const late = frames.values().next().value;
      if (late === undefined) throw new Error('Missing unfinished 1000-point job');
      clock = 7;
      drag.stop(false);
      expect(drag.observe().lastCancelled?.atMs).toBe(17);
      expect(drag.observe()).toMatchObject({ active: false, solvePending: false, frameReserved: false, releasePending: false });
      late(0); settle();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().dragResolved).toBeNull();
      expect(drag.observe().lastCommitted).toBeNull();
    } finally { drag.stop(false); timer.mockRestore(); }
  });
});


describe('実1000点jobの非成功結果を確定しない', () => {
  it.each(['maxIterations', 'singular'] as const)('%sのcompletedを成功previewへ読み替えない', expectedStop => {
    assertCapacityAndConnectivity();
    const before = useAppStore.getState(), bytes = JSON.stringify(before.document);
    const outcomes: { converged: boolean; stop: string; maxResidual: number }[] = [];
    const originalFactory = dragSolver.createDragSolveJob;
    const spy = vi.spyOn(dragSolver, 'createDragSolveJob').mockImplementation((document, drag, target, options) => {
      // 公開modelの実job。前者は元反復上限の拒否境界、後者は非有限目標の実拒否。
      // 成功結果やstop理由を作り物へ置換しない。
      const job = expectedStop === 'maxIterations'
        ? createConstrainedSketchJob(document, options, { maxIterations: 0,
          pinned: new Map([[drag.pointKey, target]]) })
        : originalFactory(document, drag, target, options);
      return { ...job, stepWork(budget) {
        const progress = job.stepWork(budget);
        if (progress.status === 'completed' && progress.result.outcome !== null) {
          const result = progress.result.outcome;
          outcomes.push({ converged: result.converged, stop: result.stop, maxResidual: result.maxResidual });
        }
        return progress;
      } };
    });
    const drag = session();
    try {
      expect(drag.begin([0, 0])).toBe(true);
      drag.schedule(expectedStop === 'singular' ? [Number.NaN, 30] : [40, 30]);
      oneFrame();
      drag.finish();
      settle();
      expect(useAppStore.getState().dragRefusalKey).toBe('drag.error.solveFailed');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ converged: false, stop: expectedStop });
      expect(useAppStore.getState().document).toBe(before.document);
      expect(JSON.stringify(useAppStore.getState().document)).toBe(bytes);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().documentVersion).toBe(before.documentVersion);
      expect(useAppStore.getState().dragResolved).toBeNull();
      expect(drag.observe()).toMatchObject({ active: false, solvePending: false, releasePending: false,
        frameReserved: false, lastCommitted: null });
      expect(drag.begin([0, 0])).toBe(true);
      expect(useAppStore.getState().dragRefusalKey).toBeNull();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { drag.stop(false); spy.mockRestore(); }
  });
});

describe('certified translation through the actual 1000-point drag job', () => {
  it('keeps all original geometry and resolves the final target with zero LM iterations and no sparse products', () => {
    assertCapacityAndConnectivity();
    const before = useAppStore.getState(), bytes = JSON.stringify(before.document);
    const drag = session();
    try {
      expect(drag.begin([0, 0])).toBe(true);
      const state = useAppStore.getState();
      if (state.sketchDrag === null) throw new Error('Missing actual drag owner');
      const job = dragSolver.createDragSolveJob(state.sketch, state.sketchDrag, [-20, -20]);
      const stages = [job.stepWork(4096), job.stepWork(4096), job.stepWork(4096)];
      expect(stages.map(stage => [stage.status, stage.phase])).toEqual([
        ['pending', 'solve'], ['pending', 'finalize'], ['completed', 'finalize'],
      ]);
      const complete = stages[2];
      if (complete.status !== 'completed') throw new Error('Missing certified translation result');
      expect(complete.linearWork).toBe(0);
      expect(complete.productEntries).toBe(0);
      expect(complete.result.outcome).toMatchObject({ iterations: 0, converged: true, stop: 'converged', trace: [] });
      expect(complete.result.outcome?.maxResidual).toBeLessThan(CONSTRAINT_TOLERANCE);
      assertGeometry(complete.result.resolved, [-20, -20]);
      expect(JSON.stringify(useAppStore.getState().document)).toBe(bytes);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      console.log(JSON.stringify({ observation: 'connected1000-original-job-work', fixtureSHA256: CONNECTED_1000_FIXTURE_SHA256,
        points: COUNT, constraints: state.sketch.constraints?.length, target: [-20, -20],
        stages: stages.map(({ status, phase, work, totalWork, linearWork, productEntries }) =>
          ({ status, phase, work, totalWork, linearWork, productEntries })),
        iterations: complete.result.outcome?.iterations, maxResidual: complete.result.outcome?.maxResidual,
        browserLatencyMeasured: false }));
    } finally { drag.stop(false); }
  });
});

describe('prearmed observation of the real connected1000 pending window', () => {
  it('observes a real unfinished job before a late read misses it; cancellation still releases ownership', () => {
    const drag = session(), before = useAppStore.getState();
    try {
      expect(drag.begin([0, 0])).toBe(true);
      drag.schedule([-20, -20]);
      oneFrame();
      const observedBeforeCompletion = drag.observe();
      expect(observedBeforeCompletion).toMatchObject({ active: true, solvePending: true, frameReserved: true });
      expect(useAppStore.getState().dragResolved).toBeNull();
      settle();
      expect(drag.observe().solvePending).toBe(false);
      expect(observedBeforeCompletion.solvePending).toBe(true); // A frozen observation, not a fabricated live state.
      const preview = useAppStore.getState().dragResolved;
      if (preview === null) throw new Error('Missing actual final geometry');
      assertGeometry(preview, [-20, -20]);
      drag.schedule([-19, -20]);
      oneFrame();
      expect(drag.observe().solvePending).toBe(true);
      const late = frames.values().next().value;
      if (late === undefined) throw new Error('Missing real pending callback');
      drag.stop(false);
      late(0);
      expect(drag.observe()).toMatchObject({ active: false, solvePending: false, frameReserved: false, lastCommitted: null });
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().dragResolved).toBeNull();
      expect(releases).toBe(1);
    } finally { drag.stop(false); }
  });
});
