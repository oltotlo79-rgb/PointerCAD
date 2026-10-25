import { transientAxialMatches } from '@pointercad/fem';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';

type LifecycleState = Pick<AppState, 'fatigueSession' | 'fatigueAxialSource' | 'strengthSession' | 'activeDocumentId'
  | 'beamSession'>;
type LifecycleFields = Pick<AppState, 'fatigueSession' | 'fatigueAxialSource'>;

/**
 * The fatigue fields one store state should have, decided from that state alone (never from which other listener ran
 * first). The fatigue panel belongs to one document while the strength panel is open. The kept transient source is
 * first cleared when it is incompatible (strength closed, another document, or the open beam session's revision moved
 * past the kept result), and only then is a new one captured, and only from an accepted, matched transient result of
 * the open strength panel's active document whose revision is the beam session's own. Closing only the beam panel
 * keeps the source (the deliberate preservation case). The decision is idempotent: applied to its own output it
 * returns the same references, so the store write it causes is answered by no further write (fatigue-ui-r2 captured
 * with the strength panel closed and cleared on the nested notification, again and again).
 */
export function fatigueLifecycle(state: LifecycleState): LifecycleFields {
  const open = state.strengthSession !== null, owner = state.activeDocumentId, beam = state.beamSession;
  const session = state.fatigueSession !== null && (!open || state.fatigueSession.ownerId !== owner) ? null : state.fatigueSession;
  let kept = state.fatigueAxialSource;
  if (kept !== null && (!open || kept.ownerId !== owner
    || (beam !== null && beam.analysisId === kept.result.analysisId && beam.revision !== kept.result.analysisRevision))) {
    kept = null;
  }
  if (open && beam !== null && beam.status === 'complete' && beam.reviewed !== null && beam.ownerId === owner
    && beam.result?.kind === 'oofem-beam-transient-3d' && beam.result.analysisId === beam.analysisId
    && beam.result.analysisRevision === beam.revision && beam.transientAxial !== null
    && transientAxialMatches(beam.transientAxial, beam.result)
    && (kept === null || kept.result !== beam.result || kept.axial !== beam.transientAxial)) {
    kept = { ownerId: owner, reviewed: beam.reviewed, result: beam.result, axial: beam.transientAxial };
  }
  return { fatigueSession: session, fatigueAxialSource: kept };
}

/** Applies fatigueLifecycle on every store change and writes only when it changes a field. */
export function attachFatigue(store: StoreApi<AppState> = useAppStore): () => void {
  return store.subscribe(state => {
    const next = fatigueLifecycle(state);
    if (next.fatigueSession !== state.fatigueSession || next.fatigueAxialSource !== state.fatigueAxialSource) {
      store.setState(next);
    }
  });
}
