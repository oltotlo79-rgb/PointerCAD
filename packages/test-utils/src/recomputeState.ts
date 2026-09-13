/** Only a completed current generation may end an E2E recomputation wait. */
export interface RecomputeState {
  readonly isComputing: boolean;
  readonly requestedGeneration: number;
  readonly completedGeneration: number;
  readonly lastOutcome: 'idle' | 'success' | 'failed' | 'cancelled' | 'workerBroken';
}

export function recomputeTerminalOutcome(state: RecomputeState | null, baseline: number):
  'waiting' | 'success' | 'failed' | 'workerBroken' {
  if (state === null || state.isComputing || state.completedGeneration <= baseline
    || state.completedGeneration !== state.requestedGeneration) return 'waiting';
  const outcome = state.lastOutcome;
  // Cancellation may precede a replacement request; it is never accepted as success.
  return outcome === 'success' || outcome === 'failed' || outcome === 'workerBroken' ? outcome : 'waiting';
}
