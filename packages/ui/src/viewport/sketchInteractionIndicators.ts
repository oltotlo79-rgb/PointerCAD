/**
 * Transient indicators published by one canvas's sketch interaction (R07): the snap mark, the
 * tracking lines, the inferred-constraint preview and the trim/extend/corner preview.
 *
 * The indicators live in the shared store. Each canvas remembers the exact objects it published,
 * so an old canvas that is detached or ends a drag clears only what it still owns and never
 * clears what a newer canvas has published since (FR-107, FR-110, FR-333, NFR-PF-1).
 */
import type { InferredConstraintPreview } from '../sketch/inferredConstraints.js';
import { sameInferredPreview } from '../sketch/inferredConstraints.js';
import type { TrackCandidate } from '../sketch/trackMath.js';
import { sameEditPreview, type EditPreview } from '../sketch/trimPreview.js';
import type { SnapIndicator } from '../store/sketchSlice.js';
import { useAppStore } from '../store/useAppStore.js';

/** Whether the mark must be republished. The same place is not rewritten (no extra redraw). */
export function sameIndicator(a: SnapIndicator | null, b: SnapIndicator | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.kind === b.kind &&
    a.elementId === b.elementId &&
    a.screen[0] === b.screen[0] &&
    a.screen[1] === b.screen[1]
  );
}

/** One tracking line is the same when the line itself (origin and direction) is the same. */
function sameTrackLine(a: TrackCandidate, b: TrackCandidate): boolean {
  return (
    a.kind === b.kind &&
    a.sourceFeatureId === b.sourceFeatureId &&
    a.angleDegrees === b.angleDegrees &&
    a.origin.every((value, index) => value === b.origin[index]) &&
    a.direction.every((value, index) => value === b.direction[index])
  );
}

/**
 * Whether the tracking lines must be redrawn (FR-110, NFR-PF-1). While the pointer slides along
 * the same line it is the same line, so lines are compared, not pointer positions.
 */
export function sameTrack(a: readonly TrackCandidate[] | null, b: readonly TrackCandidate[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((line, index) => sameTrackLine(line, b[index]));
}

export interface SketchInteractionIndicators {
  /** Publish when the value differs, or when an equal value currently shown belongs to another canvas. */
  readonly showSnap: (next: SnapIndicator | null) => void;
  readonly showTrack: (next: readonly TrackCandidate[] | null) => void;
  readonly showInferred: (next: InferredConstraintPreview | null) => void;
  readonly showEdit: (next: EditPreview | null) => void;
  /** Unconditional removal of the edit preview (the shape is about to change). */
  readonly hideEdit: () => void;
  /** Removes the snap mark, tracking lines and inferred preview shown by anyone (pointer left, other tool). */
  readonly clearSnapIndicators: () => void;
  readonly clearInferredConstraints: () => void;
  /** Removes only the snap/track/inferred objects this canvas still owns (end of drag, detach). */
  readonly clearOwnedIndicators: () => void;
  /** Removes only the edit preview this canvas still owns (detach). */
  readonly clearOwnedEdit: () => void;
}

export function createSketchInteractionIndicators(): SketchInteractionIndicators {
  let ownedSnap: SnapIndicator | null = null;
  let ownedTrack: readonly TrackCandidate[] | null = null;
  let ownedInferred: InferredConstraintPreview | null = null;
  let ownedEdit: EditPreview | null = null;

  function publishSnap(value: SnapIndicator | null): void {
    ownedSnap = null;
    useAppStore.getState().setSnapIndicator(value);
    if (value !== null && useAppStore.getState().snapIndicator === value) ownedSnap = value;
  }

  function publishTrack(value: readonly TrackCandidate[] | null): void {
    ownedTrack = null;
    useAppStore.getState().setTrackIndicator(value);
    if (value !== null && useAppStore.getState().trackIndicator === value) ownedTrack = value;
  }

  function publishInferred(value: InferredConstraintPreview | null): void {
    ownedInferred = null;
    useAppStore.getState().setInferredConstraints(value);
    if (value !== null && useAppStore.getState().inferredConstraints === value) ownedInferred = value;
  }

  function publishEdit(value: EditPreview | null): void {
    ownedEdit = null;
    useAppStore.getState().setEditPreview(value);
    if (value !== null && useAppStore.getState().editPreview === value) ownedEdit = value;
  }

  function clearInferredConstraints(): void {
    if (useAppStore.getState().inferredConstraints !== null) publishInferred(null);
  }

  return {
    showSnap: (next) => {
      const current = useAppStore.getState().snapIndicator;
      if (!sameIndicator(current, next) || (next !== null && current !== ownedSnap)) publishSnap(next);
    },
    showTrack: (next) => {
      const current = useAppStore.getState().trackIndicator;
      if (!sameTrack(current, next) || (next !== null && current !== ownedTrack)) publishTrack(next);
    },
    showInferred: (next) => {
      const current = useAppStore.getState().inferredConstraints;
      if (!sameInferredPreview(current, next) || (next !== null && current !== ownedInferred)) publishInferred(next);
    },
    showEdit: (next) => {
      const current = useAppStore.getState().editPreview;
      if (!sameEditPreview(current, next) || (next !== null && current !== ownedEdit)) publishEdit(next);
    },
    hideEdit: () => { publishEdit(null); },
    clearSnapIndicators: () => {
      const state = useAppStore.getState();
      if (state.snapIndicator !== null) publishSnap(null);
      if (state.trackIndicator !== null) publishTrack(null);
      // The inferred-constraint preview has no line to belong to once the mark is gone (FR-333).
      clearInferredConstraints();
    },
    clearInferredConstraints,
    clearOwnedIndicators: () => {
      if (ownedSnap !== null && useAppStore.getState().snapIndicator === ownedSnap) publishSnap(null);
      if (ownedTrack !== null && useAppStore.getState().trackIndicator === ownedTrack) publishTrack(null);
      if (ownedInferred !== null && useAppStore.getState().inferredConstraints === ownedInferred) publishInferred(null);
      ownedSnap = null;
      ownedTrack = null;
      ownedInferred = null;
    },
    clearOwnedEdit: () => {
      if (ownedEdit !== null && useAppStore.getState().editPreview === ownedEdit) publishEdit(null);
      ownedEdit = null;
    },
  };
}
