/**
 * Dragging a sketch point, end point or centre (FR-313).
 *
 * Responsibility: one drag from the grab to its end. While dragging, the document is never
 * changed. Each pointer target gets its own resumable solve job; every animation frame advances only
 * the job of the latest target by a shared allowance of inner work (the nonlinear solve no longer
 * runs to completion inside one frame), and only a finished job of that target becomes the
 * display-only `dragResolved`. `finish` (a pointer release after an actual move) releases the pointer
 * capture at once and commits the document once, as one Undo step, when the job of the final pointer
 * has finished on the same document; an earlier frame is never committed. `stop` (pointercancel,
 * Escape, a replaced document, detach, a new grab) drops the job, the pending release and any frame.
 * Sparse linear work yields within an attempt. Setup/evaluation/finalization still contain indivisible calls.
 *
 * Pointer capture belongs to the caller; the session only asks it to be released.
 */
import { worldToPlane, type ConstrainedSketchJob, type Vec3, type WorkPlane } from '@pointercad/model';
import { constraintContextOfStore, constraintResolveOptions } from '../sketch/constraintActions.js';
import { constraintMarkAt, constraintMarksOf } from '../sketch/constraintPicking.js';
import { chooseSnap, collectSnapCandidates, type ProjectToScreen,
  type SnapCandidate } from '../sketch/snapMath.js';
import { pointSnapRadiusPixels } from '../settings/snapRadiusSetting.js';
import { currentGridSetting } from '../settings/gridSetting.js';
import type { SnapIndicator } from '../store/sketchSlice.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { commitDrag, createDragSolveJob, dragRefusalMessageKey, dragTargetUv, draggableAt, isDraggable,
  type SketchDrag } from './dragSketch.js';
import { gridLayoutFor } from './gridMath.js';
import { pickSketchDragTarget } from './pickSketchDragTarget.js';
import type { SketchDragEndRecord, SketchDragObservation } from './sketchDragObservation.js';
import type { SketchDragTiming } from './sketchDragTiming.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

export interface SketchDragSessionDeps {
  /** E2E時だけ渡す描画時刻collector。通常経路では生成しない。 */
  readonly timing?: SketchDragTiming;
  readonly scene: Pick<ViewportScene, 'screenToPlanePoint'>;
  readonly project: ProjectToScreen;
  readonly getOrbit: () => OrbitState;
  readonly indicators: SketchInteractionIndicators;
  /** Releases the caller's pointer capture. */
  readonly releaseCapture: () => void;
  /** True after the owning interaction was detached; a late frame then does nothing. */
  readonly disposed: () => boolean;
}

export interface SketchDragSession {
  /** A drag grabbed by this session is in progress. */
  readonly active: () => boolean;
  /** The store still shows this session's drag on the document it was grabbed on. */
  readonly isCurrent: (state: Pick<AppState, 'sketchDrag' | 'document'>) => boolean;
  /** Whether a document change leaves the grabbed document. */
  readonly ownsDocument: (document: object) => boolean;
  /** Grabs the draggable point under the pointer. False when there is nothing to grab. */
  readonly begin: (pointer: readonly [number, number]) => boolean;
  /** Solves the latest pointer position once per animation frame. */
  readonly schedule: (pointer: readonly [number, number], eventAtMs?: number) => void;
  /** Pointer release: commits a moved drag once, or selects the constraint mark under an unmoved grab. */
  readonly finish: (pointer?: readonly [number, number], eventAtMs?: number) => void;
  /** Ends the drag. `keepShape` keeps the solved shape displayed until the next recompute. */
  readonly stop: (keepShape: boolean, eventAtMs?: number, kind?: 'escape' | 'pointercancel') => void;
  /** Read-only frozen snapshot for E2E timing evidence; never changes the session. */
  readonly observe: () => SketchDragObservation;
}

/**
 * A cancellation quantum, including the sparse child's inner work. Several cheap quanta may
 * fit in one frame: treating 4096 scalar operations as a whole frame throttles large solves.
 * Setup/finalization still yield separately; their indivisible cost is not bounded by this allowance.
 */
const DRAG_SOLVE_WORK_QUANTUM = 4096;
/** Leave most of a nominal 16.7 ms frame for input, rendering and other application work. */
const DRAG_SOLVE_SLICE_MS = 4;

interface SketchDragWork {
  dragOwner: SketchDrag | null;
  dragDocument: object | null;
  dragPlane: WorkPlane | null;
  dragPointer: readonly [number, number] | null;
  dragSolution: ReadonlyMap<string, Vec3> | null;
  dragJob: ConstrainedSketchJob | null;
  releasePending: boolean;
  generation: number;
  jobGeneration: number;
  solutionGeneration: number;
  timingTarget: number | null;
  timingJobTarget: number | null;
}

interface SketchDragFrameControls extends Pick<SketchDragSessionDeps, 'scene' | 'project' | 'getOrbit' | 'indicators'> {
  readonly stop: SketchDragSession['stop'];
  readonly reserveFrame: () => void;
  readonly commit: () => void;
}

/** Advance a single drag target and expose its result only while its document and generation still match. */
function createSketchDragFrame(deps: SketchDragSessionDeps, work: SketchDragWork,
  controls: SketchDragFrameControls): () => void {
  const { scene, project, getOrbit, indicators, stop, reserveFrame, commit } = controls;
  function dragPointerUv(pointer: readonly [number, number]): readonly [number, number] | null {
    if (work.dragPlane === null) {
      return null;
    }
    const world = scene.screenToPlanePoint(pointer[0], pointer[1], work.dragPlane);
    return world === null ? null : worldToPlane(work.dragPlane, world);
  }

  /**
   * Point snapping while dragging (FR-107). No tracking lines (no line is being drawn). Candidates
   * from the dragged feature itself are excluded, so a line end cannot snap onto its own start.
   */
  function dragSnapAt(pointer: readonly [number, number], featureId: string): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled || work.dragPlane === null) {
      return null;
    }
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], work.dragPlane);
    const candidates = collectSnapCandidates(
      state.resolvedSketch,
      work.dragPlane,
      gridLayoutFor(currentGridSetting(state.displaySettings), getOrbit().distance).spacing,
      onPlane,
    ).filter((candidate) => candidate.featureId !== featureId);
    return chooseSnap(candidates, project, pointer, pointSnapRadiusPixels(state.displaySettings), new Set(state.snapKinds));
  }

  /** Starts the job for one pointer target (replacing the previous job). Snapping is decided here. */
  function startJob(pointer: readonly [number, number], drag: SketchDrag, state: AppState): void {
    deps.timing?.solving();
    work.timingJobTarget = work.timingTarget;
    // Invalidate both a pending job and a completed preview before resolving a newer target.
    work.dragJob?.cancel();
    work.dragJob = null;
    work.dragSolution = null;
    state.beginSketchDrag(drag); // Same owner; the existing API clears the display-only preview.
    indicators.clearOwnedIndicators();
    const snap = dragSnapAt(pointer, drag.featureId);
    const pointerUv = dragPointerUv(pointer);
    const target =
      snap !== null && work.dragPlane !== null
        ? worldToPlane(work.dragPlane, snap.position)
        : pointerUv === null
          ? null
          : dragTargetUv(drag, pointerUv);
    if (target === null) {
      return;
    }
    // Only the mark of the snapped target is shown (no tracking lines).
    const nextIndicator: SnapIndicator | null =
      snap === null
        ? null
        : { screen: project(snap.position) ?? pointer, kind: snap.kind, elementId: snap.elementId };
    indicators.showSnap(nextIndicator);
    work.dragJob = createDragSolveJob(state.sketch, drag, target, constraintResolveOptions(state));
    work.jobGeneration = work.generation;
  }

  /**
   * One frame: start the job of the newest target if there is one, advance the current job by a bounded
   * work allowance, show only a finished result, and commit when a release is pending and done.
   * The document is not changed before the commit; the shape goes to `dragResolved`.
   */
  function runFrame(): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null || drag !== work.dragOwner || state.document !== work.dragDocument) {
      if (work.dragOwner !== null) stop(false);
      return;
    }
    const at = work.dragPointer;
    work.dragPointer = null;
    if (at !== null) startJob(at, drag, state);
    if (work.dragJob !== null) {
      const job = work.dragJob, ownerGeneration = work.jobGeneration;
      const deadline = performance.now() + DRAG_SOLVE_SLICE_MS;
      let progress = job.stepWork(DRAG_SOLVE_WORK_QUANTUM);
      while (progress.status === 'pending' && progress.phase === 'solve'
        && progress.work === DRAG_SOLVE_WORK_QUANTUM && performance.now() < deadline) {
        const current = useAppStore.getState();
        if (ownerGeneration !== work.generation || work.dragJob !== job || current.document !== work.dragDocument
          || current.sketchDrag !== work.dragOwner || deps.disposed()) break;
        progress = job.stepWork(DRAG_SOLVE_WORK_QUANTUM);
      }
      const latest = useAppStore.getState();
      if (ownerGeneration !== work.generation || work.dragJob !== job || latest.document !== work.dragDocument
        || latest.sketchDrag !== work.dragOwner || deps.disposed()) {
        job.cancel();
        if (ownerGeneration === work.generation) stop(false);
        return;
      }
      if (progress.status !== 'completed') {
        if (progress.status === 'pending') reserveFrame();
        else stop(false);
        return;
      }
      const solved = progress.result;
      const outcome = solved.outcome;
      // 処理の終了と数値的成功は別。上限/特異/非有限の結果をpreviewや確定へ流さない。
      // 到達不能なsoft pinのstep/dampingは既存契約を保ち、別の採用判断を必要とする。
      if (outcome !== null && (!outcome.x.every(Number.isFinite)
        || (!outcome.converged && (outcome.stop === 'maxIterations' || outcome.stop === 'singular')))) {
        stop(false);
        useAppStore.getState().setDragRefusal('drag.error.solveFailed');
        return;
      }
      work.dragJob = null;
      work.dragSolution = solved.solution;
      work.solutionGeneration = ownerGeneration;
      if (work.timingJobTarget !== null) deps.timing?.adopt(solved.resolved, work.timingJobTarget);
      useAppStore.getState().setDragResolved(solved.resolved);
    }
    if (work.releasePending) commit();
  }

  return runFrame;
}

export function createSketchDragSession(deps: SketchDragSessionDeps): SketchDragSession {
  const { scene, project, getOrbit, indicators } = deps;
  const work: SketchDragWork = {
    dragOwner: null, dragDocument: null, dragPlane: null, dragPointer: null,
    dragSolution: null, dragJob: null, releasePending: false, generation: 0,
    jobGeneration: -1, solutionGeneration: -1, timingTarget: null, timingJobTarget: null,
  };
  const runFrame = createSketchDragFrame(deps, work, { scene, project, getOrbit, indicators, stop, reserveFrame, commit });
  /** One solve per animation frame (NFR-PF-1). 0 means no frame is reserved. */
  let dragFrameId = 0;
  /**
   * A constraint mark under the grab point . Releasing without moving selects that mark,
   * so neither the end point under a distance mark nor the mark itself becomes unreachable.
   */
  let dragMarkId: string | null = null;
  let latestPointer: readonly [number, number] | null = null;
  let dragHasMoved = false;
  /** Observation only (never read by the drag logic): grab ordinal and the latest recorded ends. */
  let session = 0;
  let committing = false;
  let lastCancelled: SketchDragEndRecord | null = null;
  let lastCommitted: SketchDragEndRecord | null = null;

  function invalidateTarget(): void {
    work.generation += 1;
    if (dragFrameId !== 0) globalThis.cancelAnimationFrame(dragFrameId);
    dragFrameId = 0;
    work.dragJob?.cancel();
    work.dragJob = null;
    work.dragSolution = null;
    work.jobGeneration = -1;
    work.solutionGeneration = -1;
    const state = useAppStore.getState();
    if (work.dragOwner !== null && state.sketchDrag === work.dragOwner && state.document === work.dragDocument) {
      state.beginSketchDrag(work.dragOwner);
    }
  }

  function stop(keepShape: boolean, eventAtMs?: number, kind?: 'escape' | 'pointercancel'): void {
    if (work.dragOwner !== null && !committing) deps.timing?.cancel(eventAtMs, kind);
    const cancelledSession = work.dragOwner !== null && !committing ? session : null;
    work.generation += 1;
    if (dragFrameId !== 0) {
      globalThis.cancelAnimationFrame(dragFrameId);
      dragFrameId = 0;
    }
    work.dragPointer = null;
    work.dragPlane = null;
    work.dragSolution = null;
    dragMarkId = null;
    work.dragJob?.cancel();
    work.dragJob = null;
    work.jobGeneration = -1;
    work.solutionGeneration = -1;
    work.releasePending = false;
    latestPointer = null;
    dragHasMoved = false;
    deps.releaseCapture();
    const state = useAppStore.getState();
    if (work.dragOwner !== null && state.sketchDrag === work.dragOwner) state.endSketchDrag(keepShape && state.document === work.dragDocument);
    work.dragOwner = null;
    work.dragDocument = null;
    indicators.clearOwnedIndicators();
    deps.timing?.end(committing);
    // 中断の完了時刻。job/capture/store/表示の所有を手放す前の時刻で完了を装わない。
    if (cancelledSession !== null) {
      lastCancelled = Object.freeze({ session: cancelledSession, atMs: performance.now() });
    }
  }

  /** Commits the finished solve of the final target once, as one Undo step, if still current. */
  function commit(): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    const solution = work.dragSolution;
    if (drag === null || drag !== work.dragOwner || state.document !== work.dragDocument || solution === null
      || state.dragResolved === null || work.solutionGeneration !== work.generation) {
      stop(false);
      return;
    }
    // Written back in the stored way of specifying the point (decision 2026-09-05, plan A).
    const next = commitDrag(state.sketch, drag, solution, state.dragResolved, work.dragPlane);
    // The released shape stays until the next recompute arrives (no flicker back).
    const committedSession = session;
    committing = true;
    stop(true);
    committing = false;
    if (next !== state.sketch) {
      useAppStore.getState().setSketch(next);
      lastCommitted = Object.freeze({ session: committedSession, atMs: performance.now() });
    }
  }

  /** At most one frame is reserved at a time (NFR-PF-1). */
  function reserveFrame(): void {
    if (dragFrameId !== 0) {
      return;
    }
    const frameGeneration = work.generation;
    const id = globalThis.requestAnimationFrame(() => {
      // A dequeued callback cannot steal the id or work of a newer target/frame.
      if (frameGeneration !== work.generation || dragFrameId !== id) return;
      dragFrameId = 0;
      if (deps.disposed()) { stop(false); return; }
      runFrame();
    });
    dragFrameId = id;
  }

  return {
    active: () => work.dragOwner !== null,
    isCurrent: (state) => state.sketchDrag === work.dragOwner && state.document === work.dragDocument,
    ownsDocument: (document) => document === work.dragDocument,
    /**
     * Grabs end points, centres (12 px) and point features with the same target rule as the
     * constraint tool. A point that cannot be dragged (expression, fixed, derived) is not grabbed;
     * its reason is shown and the caller falls back to ordinary selection.
     */
    begin: (pointer) => {
      // A new grab never inherits an unfinished job or pending release.
      if (work.dragOwner !== null) stop(false);
      const state = useAppStore.getState();
      const context = constraintContextOfStore(state);
      const target = pickSketchDragTarget(state.resolvedSketch, project, pointer);
      if (target === null) {
        return false;
      }
      if (context.variableSet === null || context.plane === null) {
        // A 3D sketch has no work plane; explain and do not grab.
        state.setDragRefusal(dragRefusalMessageKey('freeSketch'));
        return false;
      }
      work.dragPlane = context.plane;
      const grabWorld = scene.screenToPlanePoint(pointer[0], pointer[1], context.plane);
      if (grabWorld === null) {
        work.dragPlane = null;
        return false;
      }
      const outcome = draggableAt(state.sketch, context.variableSet, target, worldToPlane(context.plane, grabWorld));
      if (outcome === null) {
        work.dragPlane = null;
        return false;
      }
      if (!isDraggable(outcome)) {
        work.dragPlane = null;
        state.setDragRefusal(dragRefusalMessageKey(outcome.reason));
        return false;
      }
      state.beginSketchDrag(outcome);
      work.dragOwner = outcome;
      session += 1;
      work.dragDocument = state.document;
      deps.timing?.begin(outcome, state.document, state.documentVersion, session, state.resolvedSketch, outcome.pointKey);
      latestPointer = pointer;
      dragHasMoved = false;
      dragMarkId = constraintMarkAt(constraintMarksOf(state.constraintSummaries), project, pointer);
      // The grabbed element is selected too, so it is highlighted (NFR-UX-7).
      state.setSelection([outcome.featureId]);
      state.setPickAnchor(pointer);
      return true;
    },
    schedule: (pointer, eventAtMs) => {
      // After the release the final target is fixed; later moves do not change what is committed.
      if (work.releasePending) return;
      invalidateTarget();
      work.timingTarget = deps.timing?.target(pointer, eventAtMs) ?? null;
      latestPointer = pointer;
      dragHasMoved = true;
      work.dragPointer = pointer;
      reserveFrame();
    },
    /**
     * The release. Only the dragged point's coordinate is rewritten, as one Undo step.
     * A grab without a move does not change the document.
     */
    finish: (pointer, eventAtMs) => {
      const state = useAppStore.getState();
      const drag = state.sketchDrag;
      if (drag === null || drag !== work.dragOwner || state.document !== work.dragDocument) {
        if (work.dragOwner !== null) stop(false);
        return;
      }
      if (work.releasePending) return;
      // A pointerup may carry a newer position than the last pointermove. An unchanged grab is a click.
      if (pointer !== undefined && (latestPointer === null
        || pointer[0] !== latestPointer[0] || pointer[1] !== latestPointer[1])) {
        invalidateTarget();
        work.timingTarget = deps.timing?.target(pointer, eventAtMs, 'pointerup') ?? null;
        latestPointer = pointer;
        dragHasMoved = true;
        work.dragPointer = pointer;
      }
      if (!dragHasMoved) {
        // Grabbed without moving: no history step. Over a constraint mark this was a click on the mark.
        const markId = dragMarkId;
        stop(false);
        if (markId !== null) {
          useAppStore.getState().setSelectedConstraint(markId);
        }
        return;
      }
      // The pointer is released now; the commit waits for the final target's job, never an earlier frame.
      deps.releaseCapture();
      work.releasePending = true;
      if (work.dragJob === null && work.dragPointer === null) {
        commit();
        return;
      }
      reserveFrame();
    },
    stop,
    observe: () => Object.freeze({
      session,
      active: work.dragOwner !== null,
      solvePending: work.dragOwner !== null && (work.dragJob !== null || work.dragPointer !== null),
      frameReserved: dragFrameId !== 0,
      releasePending: work.releasePending,
      lastCancelled,
      lastCommitted,
      ...(deps.timing === undefined ? {} : { timing: deps.timing.snapshot() }),
    }),
  };
}
