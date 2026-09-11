import { evaluateExpressionExact, type ExactExpressionValue } from '@pointercad/expression';
import { METRIC_THREADS } from '../thread/metricThread.js';
import { findBoltStressArea, type BoltStressArea } from './boltStressAreas.js';

export type TensileAreaMethod = 'table' | 'approximation';
export type TensileAreaOutcome = {
  readonly ok: true;
  readonly area: ExactExpressionValue;
  readonly method: TensileAreaMethod;
  readonly sourceId: BoltStressArea['sourceId'] | 'metric-approximation';
} | { readonly ok: false; readonly reason: 'invalid-thread' | 'unverified-table' | 'invalid-area' };

/** Table rounding is intentional. Approximation is an explicit choice, never a silent fallback. */
export function tensileStressArea(diameterMm: number, pitchMm: number, method: TensileAreaMethod = 'table'): TensileAreaOutcome {
  const size = METRIC_THREADS.find((thread) => thread.diameter === diameterMm);
  if (!Number.isFinite(diameterMm) || !Number.isFinite(pitchMm) || size === undefined
    || (size.coarsePitch !== pitchMm && size.finePitch !== pitchMm)) return { ok: false, reason: 'invalid-thread' };
  const table = findBoltStressArea(diameterMm, pitchMm);
  if (method === 'table' && table === undefined) return { ok: false, reason: 'unverified-table' };
  const source = method === 'table' ? String(table?.areaMm2) : `pi/4*(${String(diameterMm)}-0.9382*${String(pitchMm)})^2`;
  const evaluated = evaluateExpressionExact(source);
  if (!evaluated.ok || !Number.isFinite(evaluated.value.value) || evaluated.value.value <= 0) return { ok: false, reason: 'invalid-area' };
  return { ok: true, area: evaluated.value, method, sourceId: method === 'table' && table !== undefined ? table.sourceId : 'metric-approximation' };
}
