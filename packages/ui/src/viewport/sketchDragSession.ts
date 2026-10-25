/**
 * Dragging a sketch point, end point or centre (FR-313, P4b task 14; R07).
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
import { chooseSnap, collectSnapCandidates, SNAP_RADIUS_PIXELS, type ProjectToScreen,
  type SnapCandidate } from '../sketch/snapMath.js';
import type { SnapIndicator } from '../store/sketchSlice.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { commitDrag, createDragSolveJob, dragRefusalMessageKey, dragTargetUv, draggableAt, isDraggable,
  type SketchDrag } from './dragSketch.js';
import { gridSpacing } from './gridMath.js';
import { pickSketchDragTarget } from './pickSketchDragTarget.js';
import type { SketchDragEndRecord, SketchDragObservation } from './sketchDragObservation.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

export interface SketchDragSessionDeps {
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
  readonly schedule: (pointer: readonly [number, number]) => void;
  /** Pointer release: commits a moved drag once, or selects the constraint mark under an unmoved grab. */
  readonly finish: (pointer?: readonly [number, number]) => void;
  /** Ends the drag. `keepShape` keeps the solved shape displayed until the next recompute. */
  readonly stop: (keepShape: boolean) => void;
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

export function createSketchDragSession(deps: SketchDragSessionDeps): SketchDragSession {
  const { scene, project, getOrbit, indicators } = deps;
  let dragOwner: SketchDrag | null = null;
  let dragDocument: object | null = null;
  /**
   * The work plane while dragging. Decided once at the grab and kept until the release; the rule
   * is the same as the model's (`constraintContextOfStore`).
   */
  let dragPlane: WorkPlane | null = null;
  /** One solve per animation frame (NFR-PF-1). 0 means no frame is reserved. */
  let dragFrameId = 0;
  /** The last pointer position of the frame; only that one is solved. */
  let dragPointer: readonly [number, number] | null = null;
  /** The last solved coordinates, written back to the document on release. */
  let dragSolution: ReadonlyMap<string, Vec3> | null = null;
  /**
   * A constraint mark under the grab point (P4b task 13). Releasing without moving selects that mark,
   * so neither the end point under a distance mark nor the mark itself becomes unreachable.
   */
  let dragMarkId: string | null = null;
  /** The solve job of the latest pointer target; replaced by every newer target, dropped by `stop`. */
  let dragJob: ConstrainedSketchJob | null = null;
  /** A release arrived while the final target was pending or solving: commit once its job finishes. */
  let releasePending = false;
  let latestPointer: readonly [number, number] | null = null;
  let dragHasMoved = false;
  let generation = 0;
  let jobGeneration = -1;
  let solutionGeneration = -1;
  /** Observation only (never read by the drag logic): grab ordinal and the latest recorded ends. */
  let session = 0;
  let committing = false;
  let lastCancelled: SketchDragEndRecord | null = null;
  let lastCommitted: SketchDragEndRecord | null = null;

  function invalidateTarget(): void {
    generation += 1;
    if (dragFrameId !== 0) globalThis.cancelAnimationFrame(dragFrameId);
    dragFrameId = 0;
    dragJob?.cancel();
    dragJob = null;
    dragSolution = null;
    jobGeneration = -1;
    solutionGeneration = -1;
    const state = useAppStore.getState();
    if (dragOwner !== null && state.sketchDrag === dragOwner && state.document === dragDocument) {
      state.beginSketchDrag(dragOwner);
    }
  }

  function dragPointerUv(pointer: readonly [number, number]): readonly [number, number] | null {
    if (dragPlane === null) {
      return null;
    }
    const world = scene.screenToPlanePoint(pointer[0], pointer[1], dragPlane);
    return world === null ? null : worldToPlane(dragPlane, world);
  }

  /**
   * Point snapping while dragging (FR-107). No tracking lines (no line is being drawn). Candidates
   * from the dragged feature itself are excluded, so a line end cannot snap onto its own start.
   */
  function dragSnapAt(pointer: readonly [number, number], featureId: string): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled || dragPlane === null) {
      return null;
    }
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], dragPlane);
    const candidates = collectSnapCandidates(
      state.resolvedSketch,
      dragPlane,
      gridSpacing(getOrbit().distance),
      onPlane,
    ).filter((candidate) => candidate.featureId !== featureId);
    return chooseSnap(candidates, project, pointer, SNAP_RADIUS_PIXELS, new Set(state.snapKinds));
  }

  function stop(keepShape: boolean): void {
    if (dragOwner !== null && !committing) lastCancelled = Object.freeze({ session, atMs: globalThis.performance.now() });
    generation += 1;
    if (dragFrameId !== 0) {
      globalThis.cancelAnimationFrame(dragFrameId);
      dragFrameId = 0;
    }
    dragPointer = null;
    dragPlane = null;
    dragSolution = null;
    dragMarkId = null;
    dragJob?.cancel();
    dragJob = null;
    jobGeneration = -1;
    solutionGeneration = -1;
    releasePending = false;
    latestPointer = null;
    dragHasMoved = false;
    deps.releaseCapture();
    const state = useAppStore.getState();
    if (dragOwner !== null && state.sketchDrag === dragOwner) state.endSketchDrag(keepShape && state.document === dragDocument);
    dragOwner = null;
    dragDocument = null;
    indicators.clearOwnedIndicators();
  }

  /** Starts the job for one pointer target (replacing the previous job). Snapping is decided here. */
  function startJob(pointer: readonly [number, number], drag: SketchDrag, state: AppState): void {
    // Invalidate both a pending job and a completed preview before resolving a newer target.
    dragJob?.cancel();
    dragJob = null;
    dragSolution = null;
    state.beginSketchDrag(drag); // Same owner; the existing API clears the display-only preview.
    indicators.clearOwnedIndicators();
    const snap = dragSnapAt(pointer, drag.featureId);
    const pointerUv = dragPointerUv(pointer);
    const target =
      snap !== null && dragPlane !== null
        ? worldToPlane(dragPlane, snap.position)
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
    dragJob = createDragSolveJob(state.sketch, drag, target, constraintResolveOptions(state));
    jobGeneration = generation;
  }

  /** Commits the finished solve of the final target once, as one Undo step, if still current. */
  function commit(): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    const solution = dragSolution;
    if (drag === null || drag !== dragOwner || state.document !== dragDocument || solution === null
      || state.dragResolved === null || solutionGeneration !== generation) {
      stop(false);
      return;
    }
    // Written back in the stored way of specifying the point (decision 2026-09-05, plan A).
    const next = commitDrag(state.sketch, drag, solution, state.dragResolved, dragPlane);
    // The released shape stays until the next recompute arrives (no flicker back).
    const committedSession = session;
    committing = true;
    stop(true);
    committing = false;
    if (next !== state.sketch) {
      useAppStore.getState().setSketch(next);
      lastCommitted = Object.freeze({ session: committedSession, atMs: globalThis.performance.now() });
    }
  }

  /**
   * One frame: start the job of the newest target if there is one, advance the current job by a bounded
   * work allowance, show only a finished result, and commit when a release is pending and done.
   * The document is not changed before the commit; the shape goes to `dragResolved` (§2.2).
   */
  function runFrame(): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null || drag !== dragOwner || state.document !== dragDocument) {
      if (dragOwner !== null) stop(false);
      return;
    }
    const at = dragPointer;
    dragPointer = null;
    if (at !== null) startJob(at, drag, state);
    if (dragJob !== null) {
      const job = dragJob, ownerGeneration = jobGeneration;
      const deadline = globalThis.performance.now() + DRAG_SOLVE_SLICE_MS;
      let progress = job.stepWork(DRAG_SOLVE_WORK_QUANTUM);
      while (progress.status === 'pending' && progress.phase === 'solve'
        && progress.work === DRAG_SOLVE_WORK_QUANTUM && globalThis.performance.now() < deadline) {
        const current = useAppStore.getState();
        if (ownerGeneration !== generation || dragJob !== job || current.document !== dragDocument
          || current.sketchDrag !== dragOwner || deps.disposed()) break;
        progress = job.stepWork(DRAG_SOLVE_WORK_QUANTUM);
      }
      const latest = useAppStore.getState();
      if (ownerGeneration !== generation || dragJob !== job || latest.document !== dragDocument
        || latest.sketchDrag !== dragOwner || deps.disposed()) {
        job.cancel();
        if (ownerGeneration === generation) stop(false);
        return;
      }
      if (progress.status !== 'completed') {
        if (progress.status === 'pending') reserveFrame();
        else stop(false);
        return;
      }
      const solved = progress.result;
      dragJob = null;
      dragSolution = solved.solution;
      solutionGeneration = ownerGeneration;
      useAppStore.getState().setDragResolved(solved.resolved);
    }
    if (releasePending) commit();
  }

  /** At most one frame is reserved at a time (NFR-PF-1). */
  function reserveFrame(): void {
    if (dragFrameId !== 0) {
      return;
    }
    const frameGeneration = generation;
    const id = globalThis.requestAnimationFrame(() => {
      // A dequeued callback cannot steal the id or work of a newer target/frame.
      if (frameGeneration !== generation || dragFrameId !== id) return;
      dragFrameId = 0;
      if (deps.disposed()) { stop(false); return; }
      runFrame();
    });
    dragFrameId = id;
  }

  return {
    active: () => dragOwner !== null,
    isCurrent: (state) => state.sketchDrag === dragOwner && state.document === dragDocument,
    ownsDocument: (document) => document === dragDocument,
    /**
     * Grabs end points, centres (12 px) and point features with the same target rule as the
     * constraint tool. A point that cannot be dragged (expression, fixed, derived) is not grabbed;
     * its reason is shown and the caller falls back to ordinary selection.
     */
    begin: (pointer) => {
      // A new grab never inherits an unfinished job or pending release.
      if (dragOwner !== null) stop(false);
      const state = useAppStore.getState();
      const context = constraintContextOfStore(state);
      const target = pickSketchDragTarget(state.resolvedSketch, project, pointer);
      if (target === null) {
        return false;
      }
      if (context.variableSet === null || context.plane === null) {
        // A 3D sketch has no work plane; explain and do not grab (§0.a-0.3).
        state.setDragRefusal(dragRefusalMessageKey('freeSketch'));
        return false;
      }
      dragPlane = context.plane;
      const grabWorld = scene.screenToPlanePoint(pointer[0], pointer[1], context.plane);
      if (grabWorld === null) {
        dragPlane = null;
        return false;
      }
      const outcome = draggableAt(state.sketch, context.variableSet, target, worldToPlane(context.plane, grabWorld));
      if (outcome === null) {
        dragPlane = null;
        return false;
      }
      if (!isDraggable(outcome)) {
        dragPlane = null;
        state.setDragRefusal(dragRefusalMessageKey(outcome.reason));
        return false;
      }
      state.beginSketchDrag(outcome);
      dragOwner = outcome;
      session += 1;
      dragDocument = state.document;
      latestPointer = pointer;
      dragHasMoved = false;
      dragMarkId = constraintMarkAt(constraintMarksOf(state.constraintSummaries), project, pointer);
      // The grabbed element is selected too, so it is highlighted (NFR-UX-7).
      state.setSelection([outcome.featureId]);
      state.setPickAnchor(pointer);
      return true;
    },
    schedule: (pointer) => {
      // After the release the final target is fixed; later moves do not change what is committed.
      if (releasePending) return;
      invalidateTarget();
      latestPointer = pointer;
      dragHasMoved = true;
      dragPointer = pointer;
      reserveFrame();
    },
    /**
     * The release (§0.a-0.4). Only the dragged point's coordinate is rewritten, as one Undo step.
     * A grab without a move does not change the document.
     */
    finish: (pointer) => {
      const state = useAppStore.getState();
      const drag = state.sketchDrag;
      if (drag === null || drag !== dragOwner || state.document !== dragDocument) {
        if (dragOwner !== null) stop(false);
        return;
      }
      if (releasePending) return;
      // A pointerup may carry a newer position than the last pointermove. An unchanged grab is a click.
      if (pointer !== undefined && (latestPointer === null
        || pointer[0] !== latestPointer[0] || pointer[1] !== latestPointer[1])) {
        invalidateTarget();
        latestPointer = pointer;
        dragHasMoved = true;
        dragPointer = pointer;
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
      releasePending = true;
      if (dragJob === null && dragPointer === null) {
        commit();
        return;
      }
      reserveFrame();
    },
    stop,
    observe: () => Object.freeze({
      session,
      active: dragOwner !== null,
      solvePending: dragOwner !== null && (dragJob !== null || dragPointer !== null),
      frameReserved: dragFrameId !== 0,
      releasePending,
      lastCancelled,
      lastCommitted,
    }),
  };
}
