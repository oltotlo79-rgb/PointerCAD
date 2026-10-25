/**
 * Read-only observation of the sketch drag session for E2E only (FR-313, NFR-PF-1 timing evidence).
 *
 * The snapshot is a frozen copy of plain values; reading it never changes the session, and there is no
 * setter. Times are `performance.now()` of the page, the same clock as browser input events.
 */

/** One recorded end of a drag: which grab (session ordinal) ended and when. */
export interface SketchDragEndRecord {
  readonly session: number;
  readonly atMs: number;
}

export interface SketchDragObservation {
  /** Ordinal of the latest successful grab; 0 before the first grab. */
  readonly session: number;
  /** A grab of this session is in progress. */
  readonly active: boolean;
  /** A solve job or a not yet started newest target exists for the current grab. */
  readonly solvePending: boolean;
  /** An animation frame is reserved for the current grab. */
  readonly frameReserved: boolean;
  /** A pointer release waits for the final target's solve. */
  readonly releasePending: boolean;
  /** The latest grab that ended without a commit (Escape, pointercancel, replaced document, detach, refusal). */
  readonly lastCancelled: SketchDragEndRecord | null;
  /** The latest grab whose release was committed as one Undo step. */
  readonly lastCommitted: SketchDragEndRecord | null;
}

declare global {
  interface Window {
    /** E2E only: set when VITE_PCAD_E2E=1 by the canvas that owns the sketch interaction. */
    pcadSketchDragStats?: () => SketchDragObservation;
  }
}

/** The host object the hook is published on (the page `window`). */
export interface SketchDragObservationHost {
  pcadSketchDragStats?: () => SketchDragObservation;
}

/**
 * Publishes `read` on the host when enabled. The returned function removes the hook only if it is still
 * the one this call published, so a newer canvas's hook survives an older canvas's detach.
 */
export function exposeSketchDragObservation(
  host: SketchDragObservationHost,
  enabled: boolean,
  read: () => SketchDragObservation,
): () => void {
  if (!enabled) return () => undefined;
  const hook = (): SketchDragObservation => read();
  host.pcadSketchDragStats = hook;
  return () => {
    if (host.pcadSketchDragStats === hook) delete host.pcadSketchDragStats;
  };
}
