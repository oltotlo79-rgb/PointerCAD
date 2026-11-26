import { useAppStore } from '../store/useAppStore.js';

type StoreState = ReturnType<typeof useAppStore.getState>;
type PlotKind = 'functionCurve' | 'functionSurface';

function plotFeature(state: StoreState, kind: PlotKind, id: string) {
  if (kind === 'functionSurface') return state.document.solids.find(item => item.id === id && item.kind === kind);
  for (const sketch of state.document.sketches) {
    const feature = sketch.features.find(item => item.id === id && item.kind === kind);
    if (feature !== undefined) return feature;
  }
  return undefined;
}
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

export interface FunctionPlotCommitObservation {
  readonly points: readonly ObservationPoint[];
  readonly end: End;
}

export interface FunctionPlotCommitArm {
  readonly button: HTMLButtonElement;
  readonly accept: (collect: (finish?: boolean) => FunctionPlotCommitObservation) => void;
}

declare global {
  interface HTMLElementEventMap {
    'pcad:test-surface-commit': CustomEvent<FunctionPlotCommitArm>;
    'pcad:test-curve-commit': CustomEvent<FunctionPlotCommitArm>;
  }
}

interface ActiveObservation {
  readonly markTarget: (featureId: string) => void;
  readonly dialogClosed: () => void;
}

const activeObservations = new WeakMap<HTMLDialogElement, ActiveObservation>();

export function recordFunctionPlotCommitTarget(dialog: HTMLDialogElement | null, featureId: string): void {
  if (dialog !== null) activeObservations.get(dialog)?.markTarget(featureId);
}

export function listenForFunctionPlotCommit(dialog: HTMLDialogElement | null): () => void {
  if (dialog === null) return () => undefined;
  const arm = (event: CustomEvent<FunctionPlotCommitArm>): void => {
    const { button, accept } = event.detail;
    if (!dialog.open || !dialog.contains(button) || button.disabled || activeObservations.has(dialog)) return;
    const kind = event.type === 'pcad:test-curve-commit' ? 'functionCurve' : 'functionSurface';
    accept(beginObservation(dialog, button, kind));
  };
  dialog.addEventListener('pcad:test-surface-commit', arm);
  dialog.addEventListener('pcad:test-curve-commit', arm);
  return () => {
    dialog.removeEventListener('pcad:test-surface-commit', arm);
    dialog.removeEventListener('pcad:test-curve-commit', arm);
    activeObservations.get(dialog)?.dialogClosed();
  };
}

function beginObservation(dialog: HTMLDialogElement, button: HTMLButtonElement, kind: PlotKind):
  (finish?: boolean) => FunctionPlotCommitObservation {
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
    if (featureId === undefined || state.document === initial.document) return;
    const feature = plotFeature(state, kind, featureId);
    if (feature === undefined || feature === plotFeature(initial, kind, featureId)) return;
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
    if (featureId !== undefined || (kind === 'functionSurface' && plotFeature(initial, kind, id) !== undefined)) return;
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

  return (finish = true) => {
    const reason = end ?? 'collected';
    if (finish) stop(reason);
    return { points: [...points], end: reason };
  };
}
