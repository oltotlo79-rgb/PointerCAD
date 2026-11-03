import type { SolidFieldMesh } from '../solidAnalysis/solidFieldView.js';
import type { SolidFiniteSession } from './solidFiniteSession.js';
import { buildSolidFiniteFieldMesh, type SolidFiniteFieldChoice } from './solidFiniteFieldView.js';

const cache = new WeakMap<object, { readonly choice: SolidFiniteFieldChoice; readonly mesh: SolidFieldMesh | null }>();

/**
 * Only a completed session may show a field. The attachment clears results on physical edits and rejects late
 * generations. Session revision counts edits; input.source.revision counts CAD recomputations, so they are not compared.
 * Likewise ownerId identifies an open document session, not the persistent document ID; the viewport checks actual ownership.
 * Immutable admitted outcomes are cached by their whole CAD outcome object and all three display choices.
 */
export function solidFiniteFieldOf(session: SolidFiniteSession | null): SolidFieldMesh | null {
  if (session === null || session.status !== 'complete' || session.result === null
    || session.bodyFeatureId !== session.result.mesh.input.source.featureId) return null;
  const choice = session.fieldView, prior = cache.get(session.result);
  if (prior !== undefined && prior.choice.step === choice.step && prior.choice.quantity === choice.quantity
    && prior.choice.deformationScale === choice.deformationScale) return prior.mesh;
  const mesh = buildSolidFiniteFieldMesh(session.result, choice);
  cache.set(session.result, { choice: { ...choice }, mesh });
  return mesh;
}
