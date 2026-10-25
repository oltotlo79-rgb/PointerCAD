import type { Parameter, SolidBody } from '@pointercad/model';
import { readSolidModalCadSavedInput, SOLID_MODAL_CAD_SCHEMA, type SolidCadSavedInput, type SolidModalCadSavedInput }
  from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import type { SolidAnalysisSession } from './solidAnalysisSession.js';
import { sameSolidModalShared, solidModalEffectiveShared, solidModalSharedOf, type SolidModalSharedInput } from './solidModalShared.js';
import { solidModalRequestValues, type SolidModalRunState } from './solidModalState.js';

/**
 * Successor of continuation-r1 solidModalSaved.ts (9ad00037). Review finding r1 (v103-root-modal-reopen-review-r1.md):
 * with a static input A and an independently saved modal input B, reopen restored only density/mode count and the
 * modal run then used A. Now the modal input keeps its own shared values (SolidModalSharedInput) whenever they differ
 * from the saved static input, and the modal run and save use them; the static panel keeps A.
 */
export function solidModalSavedInput(session: SolidAnalysisSession, modal: Pick<SolidModalRunState, 'densityText' | 'modeCountText'>,
  shared: SolidModalSharedInput | null, documentId: string, parameters: readonly Parameter[], bodies: readonly SolidBody[]): SolidModalCadSavedInput {
  const values = solidModalRequestValues(modal);
  if (values === null) throw new Error(t('solidAnalysis.modalInputInvalid'));
  const effective = solidModalEffectiveShared(session, shared, parameters, bodies);
  return readSolidModalCadSavedInput({
    schema: SOLID_MODAL_CAD_SCHEMA, id: 'solid-modal-cad', source: { documentId }, bodyFeatureId: effective.bodyFeatureId,
    fixedFaces: effective.fixedFaces, youngMPa: effective.youngMPa, poisson: effective.poisson,
    densityKgM3: values.densityKgM3, modeCount: values.modeCount,
    linearDeflectionMm: effective.linearDeflectionMm, angularDeflectionRad: effective.angularDeflectionRad,
    maximumChordDeviationMm: effective.maximumChordDeviationMm, maximumVolumeDeviationMm3: effective.maximumVolumeDeviationMm3,
  });
}

/**
 * Reopen. Modal drafts come from the saved modal input. Shared fields:
 * - no static input saved: the panel shows the modal input's shared values (one problem, nothing held apart);
 * - static input saved and equal shared values: nothing held apart;
 * - static input saved and different shared values: the panel keeps the static input and the modal input's own
 *   values are held in `shared`, used by the modal run and save until the user explicitly adopts the panel's values.
 */
export function withSolidModalSaved(session: SolidAnalysisSession, modal: SolidModalRunState, saved: SolidModalCadSavedInput | undefined,
  staticSaved: SolidCadSavedInput | undefined): { readonly session: SolidAnalysisSession; readonly modal: SolidModalRunState; readonly shared: SolidModalSharedInput | null } {
  if (saved === undefined) return { session, modal, shared: null };
  const nextModal = { ...modal, densityText: String(saved.densityKgM3), modeCountText: String(saved.modeCount) };
  const own = solidModalSharedOf(saved);
  if (staticSaved !== undefined) {
    return { session, modal: nextModal, shared: sameSolidModalShared(own, solidModalSharedOf(staticSaved)) ? null : own };
  }
  return { modal: nextModal, shared: null, session: { ...session, bodyFeatureId: saved.bodyFeatureId, fixedFaces: [...saved.fixedFaces],
    values: { ...session.values, young: String(saved.youngMPa), poisson: String(saved.poisson),
      linear: String(saved.linearDeflectionMm), angular: String(saved.angularDeflectionRad),
      chord: String(saved.maximumChordDeviationMm), volume: String(saved.maximumVolumeDeviationMm3) } } };
}
