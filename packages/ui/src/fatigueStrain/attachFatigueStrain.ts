import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';

type LifecycleState = Pick<AppState, 'fatigueStrainSession' | 'strengthSession' | 'activeDocumentId'>;

/** The strain-life panel belongs to the strength panel of one document: it closes when the strength panel closes or
 * another document becomes active, so a draft or result is never shown against a different document. */
export function fatigueStrainLifecycle(state: LifecycleState): Pick<AppState, 'fatigueStrainSession'> {
  const session = state.fatigueStrainSession;
  const keep = session !== null && state.strengthSession !== null && session.ownerId === state.activeDocumentId;
  return { fatigueStrainSession: keep ? session : null };
}

/** Applies fatigueStrainLifecycle on every store change and writes only when it changes the session. */
export function attachFatigueStrain(store: StoreApi<AppState> = useAppStore): () => void {
  return store.subscribe(state => {
    const next = fatigueStrainLifecycle(state);
    if (next.fatigueStrainSession !== state.fatigueStrainSession) store.setState(next);
  });
}
