import type { SolidBucklingInput, SolidBucklingResult, SolidSource } from '@pointercad/fem';
import { SOLID_BUCKLING_CAD_MAX_MODES } from '@pointercad/model/beam-analysis';
import type { CadSolidBucklingFailureCode } from './cadSolidBuckling.js';
import { projectSolidBucklingMode, type SolidBucklingPreview } from './solidBucklingView.js';
import type { SolidModeDisplay } from './solidModeView.js';

/**
 * Linear prestress buckling run state of the solid analysis session (pure transitions, the store slice holds one value).
 * Same request-id rule as the modal state: every run gets a new id and only the reply of the current running id is
 * accepted, so a late reply of a cancelled, edited or replaced request is ignored. A result is shown only when it pairs
 * with the exact request that was sent (solidBucklingDisplayFor); a failure or an unpaired reply never leaves one visible.
 */
export type SolidBucklingStatus = 'idle' | 'running' | 'result' | 'failed' | 'cancelled';
export interface SolidBucklingFactor {
  readonly number: number;
  /** Dimensionless multiplier of the whole reference load set (not a per-load factor, not a strength). */
  readonly loadFactor: number;
  readonly normalizedResidual: number;
}
export interface SolidBucklingDisplay {
  readonly factors: readonly SolidBucklingFactor[];
  readonly loadedAreaMm2: number;
  readonly totalForceN: readonly [number, number, number];
  readonly freeDofs: number;
  readonly referenceEquilibriumResidual: number;
  readonly maximumElementInitialStressError: number;
}
export interface SolidBucklingRunState {
  readonly requestId: number;
  readonly status: SolidBucklingStatus;
  readonly input: SolidBucklingInput | null;
  readonly display: SolidBucklingDisplay | null;
  /** Category of a failure (null: none, or a reply that did not pair with its request). */
  readonly code: CadSolidBucklingFailureCode | null;
  /** The refusal text as reported (kept verbatim). */
  readonly error: string | null;
  /** Number of requested load factors as typed; editing it drops the result. */
  readonly modeCountText: string;
  /** The paired result (its shapes are drawn); null whenever `display` is null. */
  readonly result: SolidBucklingResult | null;
  /** Display-only choice of the drawn shape (mode, amplitude mm, phase) and whether it is drawn. Never saved. */
  readonly view: SolidModeDisplay;
  readonly amplitudeText: string;
  readonly showShape: boolean;
}
export const SOLID_BUCKLING_DEFAULT_AMPLITUDE_MM = 10;
export type SolidBucklingReply =
  | { readonly kind: 'result'; readonly input: SolidBucklingInput; readonly result: SolidBucklingResult;
      readonly loadedAreaMm2: number; readonly totalForceN: readonly [number, number, number] }
  | { readonly kind: 'failed'; readonly code: CadSolidBucklingFailureCode | null; readonly message: string | null };

/** The requested count, or null: an integer 1..SOLID_BUCKLING_CAD_MAX_MODES (the FEM contract bound). */
export function solidBucklingModeCount(state: Pick<SolidBucklingRunState, 'modeCountText'>): number | null {
  const count = state.modeCountText.trim() === '' ? Number.NaN : Number(state.modeCountText);
  return Number.isInteger(count) && count >= 1 && count <= SOLID_BUCKLING_CAD_MAX_MODES ? count : null;
}

/** The display of one reply, or null when the result does not belong to the request: another source (document,
 * revision, mesh), no factor or more than requested, non-sequential numbers, or a factor that is not finite, positive
 * and ascending. The FEM client already re-decodes against the request digest; this repeats the pairing at the UI. */
export function solidBucklingDisplayFor(input: SolidBucklingInput, result: SolidBucklingResult, loadedAreaMm2: number,
  totalForceN: readonly [number, number, number]): SolidBucklingDisplay | null {
  const source = input.reference.source;
  if (result.source.documentId !== source.documentId || result.source.revision !== source.revision
    || result.source.meshKey !== source.meshKey || result.structuralCertification !== false
    || result.scope !== 'linear-elastic-prestress-bifurcation' || result.units !== 'N-mm-MPa') return null;
  const modes = result.modes;
  if (modes.length === 0 || modes.length > input.modeCount) return null;
  for (let index = 0; index < modes.length; index++) {
    const factor = modes[index].loadFactor;
    if (modes[index].number !== index + 1 || !Number.isFinite(factor) || factor <= 0
      || (index > 0 && factor < modes[index - 1].loadFactor)) return null;
  }
  return { factors: modes.map(mode => ({ number: mode.number, loadFactor: mode.loadFactor, normalizedResidual: mode.normalizedResidual })),
    loadedAreaMm2, totalForceN: [totalForceN[0], totalForceN[1], totalForceN[2]], freeDofs: result.freeDofs,
    referenceEquilibriumResidual: result.referenceEquilibriumResidual,
    maximumElementInitialStressError: result.maximumElementInitialStressError };
}

export function initialSolidBucklingState(): SolidBucklingRunState {
  return { requestId: 0, status: 'idle', input: null, display: null, code: null, error: null, modeCountText: '3', result: null,
    view: { modeNumber: 1, amplitudeMm: SOLID_BUCKLING_DEFAULT_AMPLITUDE_MM, phase: 1 },
    amplitudeText: String(SOLID_BUCKLING_DEFAULT_AMPLITUDE_MM), showShape: false };
}

export function startSolidBuckling(state: SolidBucklingRunState): SolidBucklingRunState {
  return { ...state, requestId: state.requestId + 1, status: 'running', input: null, display: null, code: null, error: null,
    result: null, showShape: false };
}

/** Accepts the reply of the current running request only; anything else returns the state unchanged. */
export function receiveSolidBuckling(state: SolidBucklingRunState, requestId: number, reply: SolidBucklingReply): SolidBucklingRunState {
  if (requestId !== state.requestId || state.status !== 'running') return state;
  if (reply.kind === 'failed') return { ...state, status: 'failed', input: null, display: null, code: reply.code, error: reply.message,
    result: null, showShape: false };
  const display = solidBucklingDisplayFor(reply.input, reply.result, reply.loadedAreaMm2, reply.totalForceN);
  if (display === null) return { ...state, status: 'failed', input: null, display: null, code: null, error: null, result: null,
    showShape: false };
  // A new result is drawn at once (its first mode); the amplitude and phase choice is kept.
  return { ...state, status: 'result', input: reply.input, display, code: null, error: null, result: reply.result, showShape: true,
    view: { ...state.view, modeNumber: display.factors[0].number } };
}

export function cancelSolidBuckling(state: SolidBucklingRunState): SolidBucklingRunState {
  return state.status === 'running' ? { ...state, requestId: state.requestId + 1, status: 'cancelled', display: null,
    result: null, showShape: false } : state;
}

/** Edit, close, undo/redo, a reference change or any source change: the request and its result are gone. */
export function invalidateSolidBuckling(state: SolidBucklingRunState): SolidBucklingRunState {
  return { ...state, requestId: state.requestId + 1, status: 'idle', input: null, display: null, code: null, error: null,
    result: null, showShape: false };
}

/** The count edit: like any input edit it cancels a pending run and drops the stale result. */
export function editSolidBucklingCount(state: SolidBucklingRunState, text: string): SolidBucklingRunState {
  return { ...invalidateSolidBuckling(state), modeCountText: text };
}

/** Display-only choice; never touches the request, the result or anything saved. A shape is drawn only for a result. */
export function setSolidBucklingView(state: SolidBucklingRunState, view: SolidModeDisplay, amplitudeText: string,
  showShape: boolean): SolidBucklingRunState {
  return { ...state, view, amplitudeText, showShape: showShape && state.status === 'result' };
}

/** What the viewport should draw: null clears it (no shown result, or no current source). */
export function solidBucklingPreview(state: SolidBucklingRunState, current: SolidSource | null): SolidBucklingPreview | null {
  if (state.status !== 'result' || !state.showShape || state.input === null || state.result === null || current === null) return null;
  return projectSolidBucklingMode(state.input, state.result, current, state.view);
}
