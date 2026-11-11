import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * The radial menu offers "point at reference point" in the slot of the point commands while exactly one part
 * reference point is selected. Whether it can run is decided separately by `pointAtReferenceDecision`, so a
 * shown but unavailable entry explains its reason instead of disappearing.
 */
export function pointAtReferenceShownInMenu(state: AppState = useAppStore.getState()): boolean {
  if (state.selection.length !== 1) return false;
  const [id] = state.selection;
  return state.document.references.some((reference) => reference.id === id && reference.kind === 'referencePoint');
}
