import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import { readPcadFile, serializeDocument, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument,
  type PartDocument, type ResolvedSketch, type Vec3 } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connected1000Original, connected1000PointId }
  from '../../../model/src/sketch/constraints/connected1000Fixture.testSupport.js';
import { currentConnected1000Part as currentPart, legacyConnected1000Part as legacyPart }
  from '../../../io/src/pcad/connected1000Persistence.testSupport.js';
import { orbitFrom, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { recomputeRetention } from './dragSketch.retentionSupport.js';
import * as dragSolver from './dragSketch.js';
import { createSketchDragSession } from './sketchDragSession.js';
import { createSketchInteractionIndicators } from './sketchInteractionIndicators.js';

const savedAt = '2026-10-26T00:00:00.000Z';

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1, disposed = false;
function oneFrame(): void {
  const next = frames.entries().next();
  if (next.done === true) throw new Error('Expected a pending real drag job');
  const [id, callback] = next.value;
  frames.delete(id); callback(0);
}
function settle(): void {
  // Same original numerical work bound as connected1000.test.ts; no solver
  // iteration cap, scheduling allowance or test timeout is increased.
  const n = 2000, rows = 2000, nnz = 8000;
  const perAttempt = 2 * n * (50 * n + 8 * nnz + 8 * rows + 64) + 50 * n + 64;
  const limit = Math.ceil(50 * 24 * perAttempt / 4096) + 10;
  let count = 0;
  while (frames.size > 0) { oneFrame(); if (++count > limit) throw new Error('Original numerical work bound exceeded'); }
}
function dragSession() {
  return createSketchDragSession({ scene: { screenToPlanePoint: (x, y) => [x, y, 0] },
    project: value => [value[0], value[1]], getOrbit: () => orbitFrom(0, 0),
    indicators: createSketchInteractionIndicators(), releaseCapture: () => undefined, disposed: () => disposed });
}
function reopened(document: PartDocument): PartDocument {
  const read = readPcadFile(writePcadFile(document, { savedAt }));
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}
async function install(document: PartDocument): Promise<void> {
  const beforeVersion = useAppStore.getState().documentVersion;
  useAppStore.getState().resetDocument(document);
  expect(useAppStore.getState().documentVersion).toBe(beforeVersion + 1);
  useAppStore.getState().recordRecomputeRequest(2);
  useAppStore.getState().applyRecompute(document, await recomputeRetention(document));
  useAppStore.getState().recordRecomputeCompletion(2, 'success');
  expect(useAppStore.getState().resolvedPartSketches?.document).toBe(document);
  expect(useAppStore.getState().resolvedPartSketches?.generation).toBe(2);
  useAppStore.setState({ snapEnabled: false });
}
// Independent rigid motions. Legacy has a fixed point (8,6), leaving rotation;
// current W01 has an orientation constraint, leaving translation.
const angle = 0.01, translation = [2, -3] as const;
function expected(index: number, legacy: boolean, edited: boolean): Vec3 {
  const original = connected1000Original(index);
  if (!edited) return original;
  if (!legacy) return [original[0] + translation[0], original[1] + translation[1], 0];
  const x = original[0] - 8, y = original[1] - 6;
  return [8 + x * Math.cos(angle) - y * Math.sin(angle), 6 + x * Math.sin(angle) + y * Math.cos(angle), 0];
}
function geometry(resolved: ResolvedSketch, legacy: boolean, edited: boolean) {
  expect(resolved.errors).toEqual([]);
  const points = new Map(resolved.points.map(item => [item.id, item.position]));
  let maxCoordinateError = 0, maxDistanceResidual = 0;
  const at = (index: number): Vec3 => {
    const value = points.get(connected1000PointId(index));
    if (value === undefined) throw new Error(`Missing point ${index}`);
    return value;
  };
  for (let index = 0; index < 1000; index += 1) {
    const actual = at(index), oracle = expected(index, legacy, edited);
    for (let axis = 0; axis < 3; axis += 1) {
      const error = Math.abs(actual[axis] - oracle[axis]);
      maxCoordinateError = Math.max(maxCoordinateError, error);
      expect(error).toBeLessThanOrEqual(1e-6);
    }
    for (const anchor of index === 1 ? [0] : index > 1 ? [0, 1] : []) {
      const original = connected1000Original(index), origin = connected1000Original(anchor), center = at(anchor);
      const length = Math.hypot(original[0] - origin[0], original[1] - origin[1]);
      const residual = Math.abs(Math.hypot(actual[0] - center[0], actual[1] - center[1]) - length);
      maxDistanceResidual = Math.max(maxDistanceResidual, residual);
      expect(residual).toBeLessThanOrEqual(1e-9);
    }
  }
  if (!legacy) expect(Math.abs(at(1)[1] - at(0)[1] - 6)).toBeLessThanOrEqual(1e-9);
  return { maxCoordinateError, maxDistanceResidual };
}
beforeEach(() => {
  resetTestStore(); frames.clear(); nextFrame = 1; disposed = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

const entrances = [
  { name: 'legacy21 mixed fourteen kinds', make: legacyPart, legacy: true, schema: 21, count: 2010 },
  { name: 'current W01', make: currentPart, legacy: false, schema: 22, count: 1998 },
] as const;

describe('saved/reopened 1000-point editing and history', () => {
  for (const entry of entrances) {
    it(`${entry.name}: one committed edit, cold resave, ten exact Undo/Redo round trips`, async () => {
      const original = entry.make(), bytes = JSON.stringify(original);
      expect(original.schemaVersion).toBe(entry.schema);
      const opened = reopened(original);
      expect(opened.schemaVersion).toBe(22);
      expect(opened.sketches[0].constraints).toEqual(original.sketches[0].constraints);
      expect(opened.sketches[0].constraints).toHaveLength(entry.count);
      await install(opened);
      geometry(useAppStore.getState().resolvedSketch, entry.legacy, false);
      const before = useAppStore.getState(), frozen = JSON.stringify(before.document), drag = dragSession();
      const target = expected(0, entry.legacy, true);
      try {
        expect(drag.begin([0, 0])).toBe(true);
        expect(useAppStore.getState().sketchDrag?.pointKey).toBe(connected1000PointId(0));
        drag.schedule([target[0], target[1]]); oneFrame();
        expect(frames.size).toBe(1);
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().undoStack).toBe(before.undoStack);
        drag.finish(); settle();
        const after = useAppStore.getState();
        expect(after.document).not.toBe(before.document);
        expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
        expect(after.documentVersion).toBe(before.documentVersion);
        expect(after.sketch.constraints).toBe(before.sketch.constraints);
        expect(after.document.references).toBe(before.document.references);
        for (let index = 1000; index < before.sketch.features.length; index += 1)
          expect(after.sketch.features[index]).toBe(before.sketch.features[index]);
        if (entry.legacy) expect(after.sketch.features[1]).toBe(before.sketch.features[1]);
        // The retained derived snapshot still names the previous input even
        // though documentVersion stays unchanged. The new result is bound to
        // this precise input document, request generation and serialized SHA.
        expect(after.resolvedPartSketches?.document).toBe(before.document);
        expect(after.resolvedPartSketches?.document).not.toBe(after.document);
        const inputSha256 = createHash('sha256').update(serializeDocument(after.document, { savedAt })).digest('hex');
        useAppStore.getState().recordRecomputeRequest(2);
        expect(useAppStore.getState().resolvedPartSketches).toBeNull();
        const computed = await recomputeRetention(after.document);
        const errors = geometry(computed.sketches[0].resolved, entry.legacy, true);
        expect(computed.generation).toBe(2); // The shared cold-recompute helper's actual contract.
        useAppStore.getState().applyRecompute(after.document, computed);
        useAppStore.getState().recordRecomputeCompletion(computed.generation, 'success');
        const snapshot = useAppStore.getState().resolvedPartSketches;
        if (snapshot === null) throw new Error('Missing derived snapshot for the reopened edited input');
        expect(snapshot.document).toBe(after.document);
        expect(snapshot.generation).toBe(computed.generation);
        expect(createHash('sha256').update(serializeDocument(snapshot.document, { savedAt })).digest('hex')).toBe(inputSha256);
        const resaved = reopened(after.document);
        expect(resaved).toEqual(after.document);
        geometry((await recomputeRetention(resaved)).sketches[0].resolved, entry.legacy, true);
        const derivedSha256 = createHash('sha256').update(JSON.stringify(computed.sketches[0].resolved.points)).digest('hex');
        stdout.write(`[persist-history-proof] ${JSON.stringify({ entrance: entry.name, inputSha256, derivedSha256,
          generation: computed.generation, points: 1000, constraints: entry.count, undoRedoCycles: 10, ...errors })}\n`);
        drag.finish(); settle(); // repeated release creates no extra history
        expect(useAppStore.getState().undoStack).toBe(after.undoStack);
        for (let cycle = 0; cycle < 10; cycle += 1) {
          useAppStore.getState().undo();
          const undone = useAppStore.getState();
          expect(undone.document).toBe(before.document);
          expect(undone.sketch).toBe(before.sketch);
          expect(undone.sketch.features).toBe(before.sketch.features);
          expect(undone.sketch.constraints).toBe(before.sketch.constraints);
          expect(undone.document.references).toBe(before.document.references);
          expect(undone.documentVersion).toBe(before.documentVersion + 2 * cycle + 1);
          useAppStore.getState().redo();
          const redone = useAppStore.getState();
          expect(redone.document).toBe(after.document);
          expect(redone.sketch).toBe(after.sketch);
          expect(redone.sketch.features).toBe(after.sketch.features);
          expect(redone.sketch.constraints).toBe(after.sketch.constraints);
          expect(redone.document.references).toBe(after.document.references);
          expect(redone.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
          expect(redone.documentVersion).toBe(before.documentVersion + 2 * cycle + 2);
        }
        expect(JSON.stringify(before.document)).toBe(frozen);
        expect(JSON.stringify(original)).toBe(bytes);
      } finally { drag.stop(false); }
    });

    it.each(['escape', 'new-grab', 'document', 'dispose', 'numeric-failure'] as const)(
      `${entry.name}: reopened %s adds zero history, including a dequeued old callback`, async ending => {
        await install(reopened(entry.make()));
        const before = useAppStore.getState(), frozen = JSON.stringify(before.document), drag = dragSession();
        const numericalOutcomes: { converged: boolean; stop: string }[] = [];
        if (ending === 'numeric-failure') {
          // Observe the real job, as in sketchDragSession.cooperative.test.ts.
          // No numerical result, pin, work allowance or stop reason is replaced.
          const realCreate = dragSolver.createDragSolveJob;
          vi.spyOn(dragSolver, 'createDragSolveJob').mockImplementation((...args) => {
            const job = realCreate(...args);
            return { ...job, stepWork: allowance => {
              const progress = job.stepWork(allowance);
              if (progress.status === 'completed' && progress.result.outcome !== null)
                numericalOutcomes.push({ converged: progress.result.outcome.converged, stop: progress.result.outcome.stop });
              return progress;
            } };
          });
        }
        try {
          expect(drag.begin([0, 0])).toBe(true);
          const target = ending === 'numeric-failure' ? [Number.NaN, 1] as const : [40, 30] as const;
          drag.schedule(target); oneFrame(); drag.finish();
          const late = frames.values().next().value;
          if (ending !== 'numeric-failure' && late === undefined) throw new Error('Expected released unfinished real solve');
          if (ending === 'escape') drag.stop(false);
          else if (ending === 'new-grab') expect(drag.begin([0, 0])).toBe(true);
          else if (ending === 'document') useAppStore.getState().resetDocument(createEmptyPartDocument());
          else if (ending === 'dispose') disposed = true;
          const retained = useAppStore.getState();
          late?.(0); settle();
          expect(useAppStore.getState().document).toBe(retained.document);
          expect(useAppStore.getState().undoStack).toBe(retained.undoStack);
          expect(useAppStore.getState().documentVersion).toBe(retained.documentVersion);
          expect(drag.observe().lastCommitted).toBeNull();
          if (ending === 'numeric-failure') {
            expect(numericalOutcomes).toEqual([{ converged: false, stop: 'singular' }]);
            // Failure retains the last finite shape for display (solveSketch's
            // documented contract). It never becomes a document/history edit.
            const preview = useAppStore.getState().dragResolved;
            if (preview !== null) geometry(preview, entry.legacy, false);
          } else expect(useAppStore.getState().dragResolved).toBeNull();
          if (ending !== 'document') {
            expect(useAppStore.getState().document).toBe(before.document);
            expect(useAppStore.getState().sketch.constraints).toBe(before.sketch.constraints);
            expect(useAppStore.getState().document.references).toBe(before.document.references);
          }
          if (ending === 'new-grab') expect(useAppStore.getState().sketchDrag).toBe(retained.sketchDrag);
          expect(drag.active()).toBe(ending === 'new-grab');
          expect(frames.size).toBe(0);
          expect(JSON.stringify(before.document)).toBe(frozen);
        } finally { drag.stop(false); }
      });
  }
});
