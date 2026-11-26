import { useAppStore } from '../store/useAppStore.js';

type StoreState = ReturnType<typeof useAppStore.getState>;
type Phase = 'armed' | 'pointerdown' | 'click' | 'target' | 'published' | 'requested' | 'completed' | 'contextlost';
type End = 'collected' | 'cancelled' | 'pagehide' | 'document-changed' | 'completed';

interface ObservationPoint {
  readonly phase: Phase;
  readonly ms: number;
  readonly documentVersion: number;
  readonly requested: number;
  readonly completed: number;
  readonly outcome: StoreState['lastOutcome'];
  readonly onButton?: boolean;
  readonly featureId?: string;
  readonly undoDepth?: number;
}

export interface SurfaceCommitObservation {
  readonly points: readonly ObservationPoint[];
  readonly end: End;
}

interface Arm {
  readonly button: HTMLButtonElement;
  readonly accept: (collect: () => SurfaceCommitObservation) => void;
}

declare global {
  interface HTMLElementEventMap {
    'pcad:test-surface-commit': CustomEvent<Arm>;
  }
}

interface ActiveObservation {
  readonly markTarget: (featureId: string) => void;
  readonly dialogClosed: () => void;
}

const activeObservations = new WeakMap<HTMLDialogElement, ActiveObservation>();

export function recordFunctionSurfaceCommitTarget(dialog: HTMLDialogElement | null, featureId: string): void {
  if (dialog !== null) activeObservations.get(dialog)?.markTarget(featureId);
}

export function listenForFunctionSurfaceCommit(dialog: HTMLDialogElement | null): () => void {
  if (dialog === null) return () => undefined;
  const arm = (event: CustomEvent<Arm>): void => {
    const { button, accept } = event.detail;
    if (!dialog.open || !dialog.contains(button) || button.disabled || activeObservations.has(dialog)) return;
    accept(beginObservation(dialog, button));
  };
  dialog.addEventListener('pcad:test-surface-commit', arm);
  return () => {
    dialog.removeEventListener('pcad:test-surface-commit', arm);
    activeObservations.get(dialog)?.dialogClosed();
  };
}

function beginObservation(dialog: HTMLDialogElement, button: HTMLButtonElement): () => SurfaceCommitObservation {
  const initial = useAppStore.getState();
  const started = performance.now();
  const points: ObservationPoint[] = [];
  const signals = new AbortController();
  let featureId: string | undefined;
  let observedGeneration: number | undefined;
  let end: End | undefined;

  const add = (phase: Phase, state: StoreState, detail?: Pick<ObservationPoint, 'onButton' | 'featureId' | 'undoDepth'>): void => {
    if (points.some(point => point.phase === phase)) return;
    points.push({ phase, ms: performance.now() - started, documentVersion: state.documentVersion,
      requested: state.requestedGeneration, completed: state.completedGeneration, outcome: state.lastOutcome, ...detail });
  };
  const stop = (reason: End): void => {
    if (end !== undefined) return;
    end = reason;
    unsubscribe();
    signals.abort();
    activeObservations.delete(dialog);
  };
  const readStore = (): void => {
    // A recompute subscriber may write synchronously inside the document
    // notification. Read the current store, including any nested write.
    const state = useAppStore.getState();
    if (state.activeDocumentId !== initial.activeDocumentId || state.document.id !== initial.document.id) {
      stop('document-changed');
      return;
    }
    if (featureId === undefined || state.document === initial.document ||
      !state.document.solids.some(item => item.id === featureId && item.kind === 'functionSurface')) return;
    add('published', state, { featureId, undoDepth: state.undoStack.past.length - initial.undoStack.past.length });
    if (observedGeneration === undefined && state.requestedGeneration > initial.requestedGeneration) {
      observedGeneration = state.requestedGeneration;
      add('requested', state);
    }
    if (observedGeneration !== undefined && state.completedGeneration === observedGeneration) {
      add('completed', state);
      stop('completed');
    }
  };
  const unsubscribe = useAppStore.subscribe(readStore);
  const markTarget = (id: string): void => {
    if (featureId !== undefined || initial.document.solids.some(item => item.id === id)) return;
    featureId = id;
    add('target', useAppStore.getState(), { featureId });
  };
  const dialogClosed = (): void => { if (featureId === undefined) stop('cancelled'); };
  activeObservations.set(dialog, { markTarget, dialogClosed });
  const options = { capture: true, signal: signals.signal };
  for (const phase of ['pointerdown', 'click'] as const) {
    document.addEventListener(phase, event => {
      if (event.isTrusted) add(phase, useAppStore.getState(), { onButton: event.composedPath().includes(button) });
    }, options);
  }
  dialog.addEventListener('webglcontextlost', () => add('contextlost', useAppStore.getState()), options);
  dialog.addEventListener('cancel', () => stop('cancelled'), options);
  dialog.addEventListener('close', dialogClosed, options);
  window.addEventListener('pagehide', () => stop('pagehide'), options);
  add('armed', initial);

  return () => {
    const reason = end ?? 'collected';
    stop(reason);
    return { points, end: reason };
  };
}
