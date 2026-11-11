import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';

type LifecycleState = Pick<AppState, 'fatigueLocalCycleSession' | 'strengthSession' | 'activeDocumentId'>;

/** The local-cycle panel belongs to the strength panel of one document: it closes when the strength panel closes or
 * another document becomes active, so no draft or result is shown against a different owner. */
export function fatigueLocalCycleLifecycle(state: LifecycleState): Pick<AppState, 'fatigueLocalCycleSession'> {
  const session = state.fatigueLocalCycleSession;
  const keep = session !== null && state.strengthSession !== null && session.ownerId === state.activeDocumentId;
  return { fatigueLocalCycleSession: keep ? session : null };
}

/** Applies fatigueLocalCycleLifecycle on every store change and writes only when it changes the session. */
export function attachFatigueLocalCycle(store: StoreApi<AppState> = useAppStore): () => void {
  return store.subscribe(state => {
    const next = fatigueLocalCycleLifecycle(state);
    if (next.fatigueLocalCycleSession !== state.fatigueLocalCycleSession) store.setState(next);
  });
}
