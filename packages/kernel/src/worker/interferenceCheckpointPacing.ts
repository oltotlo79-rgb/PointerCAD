import type { InterferenceProgress } from '../types.js';

/** Delivery budget, not a speed acceptance target: one tenth of the existing 1s cancellation-display bound.
 * Checked at the existing 64-pair boundary; native/callback/scheduling time is not bounded by this helper. */
const INTERFERENCE_CANDIDATE_DELIVERY_MS = 100;
const MAX_SUPPRESSED_BOUNDARIES = 15;

/** Only the caller's combined message path uses this gate. It never replaces an actual cancellation callback.
 * Broken/stalled clocks cannot suppress delivery indefinitely. No timers, tasks or callback ownership live here. */
export function createInterferenceCheckpointPacing(clock: () => number = () => performance.now()) {
  let previous: number | undefined;
  let deliveredAt: number | undefined;
  let previousPhase: InterferenceProgress['phase'] | undefined;
  let suppressed = 0;
  let unpaced = false;
  return {
    shouldDeliver(phase: InterferenceProgress['phase'], force = false): boolean {
      if (unpaced) return true;
      let now: number;
      try { now = clock(); }
      catch { unpaced = true; return true; }
      if (!Number.isFinite(now) || now < 0 || previous !== undefined && now < previous) {
        unpaced = true; return true;
      }
      previous = now;
      const deliver = phase !== 'candidates' || force || previousPhase !== phase || deliveredAt === undefined
        || now - deliveredAt >= INTERFERENCE_CANDIDATE_DELIVERY_MS || suppressed >= MAX_SUPPRESSED_BOUNDARIES;
      previousPhase = phase;
      if (deliver) {
        // Start time, deliberately not completion time: a slow callback already consumed the delivery budget.
        deliveredAt = now; suppressed = 0;
      } else suppressed += 1;
      return deliver;
    },
  };
}
