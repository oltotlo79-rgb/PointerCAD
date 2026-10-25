import type { SolidAnalysisSession } from './solidAnalysisSession.js';
import { buildSolidFieldMesh, type SolidFieldMesh, type SolidFieldQuantity } from './solidFieldView.js';

/** Display choice of the field view; part of the session only, never saved with the analysis input. */
export interface SolidFieldViewChoice {
  readonly quantity: SolidFieldQuantity;
  /** Deformation magnification, finite and >= 0 (0 shows the undeformed mesh). */
  readonly deformationScale: number;
}
export const DEFAULT_SOLID_FIELD_VIEW: SolidFieldViewChoice = { quantity: 'vonMises', deformationScale: 1 };

const cache = new WeakMap<object, { readonly quantity: SolidFieldQuantity; readonly scale: number; readonly mesh: SolidFieldMesh | null }>();

/**
 * The field to draw, only from a completed current result of the session. Failed, cancelled, running, editing and
 * stale sessions have `result === null` (attachSolidAnalysis / solidAnalysisSlice clear it), so they draw nothing.
 * The mesh is rebuilt only when the result object, quantity or scale change.
 */
export function solidAnalysisFieldOf(session: SolidAnalysisSession | null): SolidFieldMesh | null {
  if (session === null || session.status !== 'complete' || session.result === null) return null;
  const { quantity, deformationScale } = session.fieldView;
  const cached = cache.get(session.result);
  if (cached !== undefined && cached.quantity === quantity && cached.scale === deformationScale) return cached.mesh;
  const mesh = buildSolidFieldMesh(session.result, quantity, deformationScale);
  cache.set(session.result, { quantity, scale: deformationScale, mesh });
  return mesh;
}
