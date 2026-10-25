import type { SolidModalInput, SolidModalResult, SolidSource } from '@pointercad/fem';
import { solidModeResultFor } from './solidModalDisplay.js';
import { projectSolidMode, type SolidModeDisplay, type SolidModePreview, type SolidModeResult } from './solidModeView.js';

/**
 * Modal run state of the solid analysis session (pure transitions; the store slice holds one value of this).
 * Every run gets a new request id; a reply is accepted only for the current id while running, so a late reply of a
 * cancelled, edited or replaced request is ignored. The request is built after meshing (cadSolidModal.ts), so the
 * reply carries the exact request that was sent; the result is paired only with that request (solidModeResultFor).
 * A display choice never changes the request, the result or anything saved. A failure never leaves a result visible.
 */
export type SolidModalStatus = 'idle' | 'running' | 'result' | 'failed' | 'cancelled';
export interface SolidModalRunState {
  readonly requestId: number;
  readonly status: SolidModalStatus;
  readonly input: SolidModalInput | null;
  readonly display: SolidModeResult | null;
  readonly error: string | null;
  readonly view: SolidModeDisplay;
  readonly amplitudeText: string;
  /** Physical modal inputs as typed (mass density kg/m^3, number of modes). Editing them drops the result. */
  readonly densityText: string;
  readonly modeCountText: string;
}

/** Physical modal inputs, or null: density finite and > 0 (kg/m^3), mode count an integer 1..20. */
export function solidModalRequestValues(state: Pick<SolidModalRunState, 'densityText' | 'modeCountText'>):
  { readonly densityKgM3: number; readonly modeCount: number } | null {
  const density = state.densityText.trim() === '' ? Number.NaN : Number(state.densityText);
  const count = state.modeCountText.trim() === '' ? Number.NaN : Number(state.modeCountText);
  if (!Number.isFinite(density) || density <= 0 || !Number.isInteger(count) || count < 1 || count > 20) return null;
  return { densityKgM3: density, modeCount: count };
}

/** A physical input edit: like a static input edit it cancels a pending run and drops the stale result. */
export function editSolidModalInput(state: SolidModalRunState, field: 'density' | 'modeCount', text: string): SolidModalRunState {
  return { ...invalidateSolidModal(state), ...(field === 'density' ? { densityText: text } : { modeCountText: text }) };
}
export type SolidModalReply =
  | { readonly kind: 'result'; readonly input: SolidModalInput; readonly result: SolidModalResult }
  | { readonly kind: 'failed'; readonly message: string | null };

export const SOLID_MODAL_DEFAULT_AMPLITUDE_MM = 10;

export function initialSolidModalState(): SolidModalRunState {
  return { requestId: 0, status: 'idle', input: null, display: null, error: null,
    view: { modeNumber: 1, amplitudeMm: SOLID_MODAL_DEFAULT_AMPLITUDE_MM, phase: 1 }, amplitudeText: String(SOLID_MODAL_DEFAULT_AMPLITUDE_MM),
    densityText: '', modeCountText: '6' };
}

export function startSolidModal(state: SolidModalRunState): SolidModalRunState {
  return { ...state, requestId: state.requestId + 1, status: 'running', input: null, display: null, error: null };
}

/** Accepts the reply of the current running request only; anything else returns the state unchanged. */
export function receiveSolidModal(state: SolidModalRunState, requestId: number, reply: SolidModalReply): SolidModalRunState {
  if (requestId !== state.requestId || state.status !== 'running') return state;
  if (reply.kind === 'failed') return { ...state, status: 'failed', input: null, display: null, error: reply.message };
  const display = solidModeResultFor(reply.input, reply.result);
  if (display === null || display.modes.length === 0) return { ...state, status: 'failed', input: null, display: null, error: null };
  return { ...state, status: 'result', input: reply.input, display, error: null, view: { ...state.view, modeNumber: display.modes[0].number } };
}

export function cancelSolidModal(state: SolidModalRunState): SolidModalRunState {
  return state.status === 'running' ? { ...state, requestId: state.requestId + 1, status: 'cancelled', display: null } : state;
}

/** Edit, close, undo/redo or any source change: the request and its result are gone. */
export function invalidateSolidModal(state: SolidModalRunState): SolidModalRunState {
  return { ...state, requestId: state.requestId + 1, status: 'idle', input: null, display: null, error: null };
}

/** Display-only choice; never touches the request, the result or anything saved. */
export function setSolidModalView(state: SolidModalRunState, view: SolidModeDisplay, amplitudeText: string): SolidModalRunState {
  return { ...state, view, amplitudeText };
}

/** What the viewport should draw: null clears it (no result, or no current source). */
export function solidModalPreview(state: SolidModalRunState, current: SolidSource | null): SolidModePreview | null {
  if (state.status !== 'result' || state.display === null || current === null) return null;
  return projectSolidMode(state.display, current, state.view);
}
