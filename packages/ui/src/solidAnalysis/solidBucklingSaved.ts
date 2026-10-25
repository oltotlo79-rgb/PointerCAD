import type { Parameter } from '@pointercad/model';
import { readSolidBucklingCadSavedInput, readSolidCadSavedInput, SOLID_BUCKLING_CAD_SCHEMA, type SolidBucklingCadSavedInput,
  type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { createSolidAnalysisSession, solidSavedInput, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { solidBucklingModeCount, type SolidBucklingRunState } from './solidBucklingState.js';

/**
 * Saved buckling input and reopen, with the same rule as the modal input (solidModalSaved.ts): the reference load state is
 * normally the static panel's current input (the very value solidSavedInput saves for the static analysis). A buckling
 * input saved with a different reference keeps it apart: on reopen it is held here, the buckling run and save use it,
 * and the static panel keeps showing and running its own saved input. Nothing is silently mixed.
 */
export function sameSolidCadSaved(left: SolidCadSavedInput, right: SolidCadSavedInput): boolean {
  // The static reader builds every field in one fixed order, so equal inputs serialize identically.
  return JSON.stringify(readSolidCadSavedInput(left)) === JSON.stringify(readSolidCadSavedInput(right));
}

/** What a buckling run and a buckling save use: the reference held apart, or else the panel's current static input. */
export function solidBucklingEffectiveReference(session: SolidAnalysisSession, reference: SolidCadSavedInput | null,
  documentId: string, parameters: readonly Parameter[]): SolidCadSavedInput {
  return reference ?? solidSavedInput(session, documentId, parameters);
}

export function solidBucklingSavedInput(session: SolidAnalysisSession, buckling: Pick<SolidBucklingRunState, 'modeCountText'>,
  reference: SolidCadSavedInput | null, documentId: string, parameters: readonly Parameter[]): SolidBucklingCadSavedInput {
  const modeCount = solidBucklingModeCount(buckling);
  if (modeCount === null) throw new Error(t('solidAnalysis.bucklingInputInvalid'));
  return readSolidBucklingCadSavedInput({ schema: SOLID_BUCKLING_CAD_SCHEMA, id: 'solid-buckling-cad', source: { documentId },
    modeCount, reference: solidBucklingEffectiveReference(session, reference, documentId, parameters) });
}

/**
 * Reopen. The count comes from the saved buckling input. Reference:
 * - no static input saved: the panel shows the buckling reference (one problem, nothing held apart);
 * - static input saved and equal: nothing held apart;
 * - static input saved and different: the panel keeps the static input and the buckling reference is held in
 *   `reference`, used by the buckling run and save until the user explicitly adopts the panel's input.
 */
export function withSolidBucklingSaved(session: SolidAnalysisSession, buckling: SolidBucklingRunState,
  saved: SolidBucklingCadSavedInput | undefined, staticSaved: SolidCadSavedInput | undefined):
  { readonly session: SolidAnalysisSession; readonly buckling: SolidBucklingRunState; readonly reference: SolidCadSavedInput | null } {
  if (saved === undefined) return { session, buckling, reference: null };
  const next = { ...buckling, modeCountText: String(saved.modeCount) };
  if (staticSaved !== undefined) return { session, buckling: next, reference: sameSolidCadSaved(saved.reference, staticSaved) ? null : saved.reference };
  const filled = createSolidAnalysisSession(session.ownerId, saved.reference);
  return { buckling: next, reference: null, session: { ...session, bodyFeatureId: filled.bodyFeatureId, fixedFaces: filled.fixedFaces,
    loadedFaces: filled.loadedFaces, loadMode: filled.loadMode, values: filled.values } };
}
