import type { Parameter, SolidBody } from '@pointercad/model';
import type { SolidCadSavedInput, SolidModalCadSavedInput } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { solidExpressionField, type SolidAnalysisSession } from './solidAnalysisSession.js';

/**
 * The physical inputs a static and a modal analysis share (body, restrained faces, E, nu, meshing tolerances).
 * A modal input saved independently of the static one keeps its own values: on reopen they are held here, the modal
 * run uses them, and the static panel keeps showing and running its own saved values. Nothing is silently mixed.
 */
export interface SolidModalSharedInput {
  readonly bodyFeatureId: string;
  readonly fixedFaces: readonly string[];
  readonly youngMPa: number;
  readonly poisson: number;
  readonly linearDeflectionMm: number;
  readonly angularDeflectionRad: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
}

export function solidModalSharedOf(saved: SolidModalCadSavedInput | SolidCadSavedInput): SolidModalSharedInput {
  return { bodyFeatureId: saved.bodyFeatureId, fixedFaces: [...saved.fixedFaces], youngMPa: saved.youngMPa, poisson: saved.poisson,
    linearDeflectionMm: saved.linearDeflectionMm, angularDeflectionRad: saved.angularDeflectionRad,
    maximumChordDeviationMm: saved.maximumChordDeviationMm, maximumVolumeDeviationMm3: saved.maximumVolumeDeviationMm3 };
}

export function sameSolidModalShared(left: SolidModalSharedInput, right: SolidModalSharedInput): boolean {
  return left.bodyFeatureId === right.bodyFeatureId && left.fixedFaces.length === right.fixedFaces.length
    && left.fixedFaces.every((face, index) => face === right.fixedFaces[index]) && left.youngMPa === right.youngMPa
    && left.poisson === right.poisson && left.linearDeflectionMm === right.linearDeflectionMm
    && left.angularDeflectionRad === right.angularDeflectionRad && left.maximumChordDeviationMm === right.maximumChordDeviationMm
    && left.maximumVolumeDeviationMm3 === right.maximumVolumeDeviationMm3;
}

/** The shared fields as the static panel currently shows them (evaluated with the document parameters). */
export function solidPanelShared(session: SolidAnalysisSession, parameters: readonly Parameter[], bodies: readonly SolidBody[]): SolidModalSharedInput {
  const evaluated = (name: 'young' | 'poisson' | 'linear' | 'angular' | 'chord' | 'volume'): number => {
    const result = solidExpressionField(name, session.values[name], parameters).result;
    if (result.value === null) throw new Error(result.error?.message ?? t('solidAnalysis.failed'));
    return result.value.value;
  };
  const solids = bodies.filter(body => body.isValid && body.bodyKind === 'solid');
  const bodyFeatureId = session.bodyFeatureId ?? (solids.length === 1 ? solids[0].featureId : null);
  if (bodyFeatureId === null) throw new Error(t('solidAnalysis.selectBody'));
  return { bodyFeatureId, fixedFaces: [...session.fixedFaces], youngMPa: evaluated('young'), poisson: evaluated('poisson'),
    linearDeflectionMm: evaluated('linear'), angularDeflectionRad: evaluated('angular'),
    maximumChordDeviationMm: evaluated('chord'), maximumVolumeDeviationMm3: evaluated('volume') };
}

/** What a modal run and a modal save use: the independently held modal values, or else the panel's current ones. */
export function solidModalEffectiveShared(session: SolidAnalysisSession, shared: SolidModalSharedInput | null,
  parameters: readonly Parameter[], bodies: readonly SolidBody[]): SolidModalSharedInput {
  return shared ?? solidPanelShared(session, parameters, bodies);
}
