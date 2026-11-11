import type { CadSolidPlasticOutcome } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { readSolidPlasticCadSavedInput, SOLID_PLASTIC_CAD_SCHEMA,
  type SolidPlasticCadSavedInput } from '@pointercad/model/beam-analysis';
import { solidExpressionField } from '../solidAnalysis/solidAnalysisSession.js';
import { t } from '../i18n/t.js';

/** Expression fields reuse the linear solid fields (same units and IME-capable parser); history and reference are text. */
export const SOLID_PLASTIC_FIELDS = ['young', 'poisson', 'yield', 'hardening', 'tx', 'ty', 'tz', 'linear', 'angular',
  'chord', 'volume', 'steps', 'history', 'reference'] as const;
export type SolidPlasticField = typeof SOLID_PLASTIC_FIELDS[number];
export interface SolidPlasticSession {
  readonly ownerId: string;
  readonly revision: number;
  readonly bodyFeatureId: string | null;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly values: Readonly<Record<SolidPlasticField, string>>;
  readonly focused: SolidPlasticField | null;
  readonly status: 'editing' | 'running' | 'complete' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly result: Extract<CadSolidPlasticOutcome, { kind: 'result' }> | null;
}
export function createSolidPlasticSession(ownerId: string, saved?: SolidPlasticCadSavedInput): SolidPlasticSession {
  return { ownerId, revision: 0, bodyFeatureId: saved?.bodyFeatureId ?? null,
    fixedFaces: saved ? [...saved.fixedFaces] : [], loadedFaces: saved ? [...saved.loadedFaces] : [], focused: null,
    status: 'editing', error: null, result: null,
    values: saved ? { young: String(saved.youngMPa), poisson: String(saved.poisson), yield: String(saved.yieldStressMPa),
      hardening: String(saved.hardeningModulusMPa), tx: String(saved.tractionMPa[0]), ty: String(saved.tractionMPa[1]),
      tz: String(saved.tractionMPa[2]), linear: String(saved.linearDeflectionMm), angular: String(saved.angularDeflectionRad),
      chord: String(saved.maximumChordDeviationMm), volume: String(saved.maximumVolumeDeviationMm3),
      steps: String(saved.stepsPerSegment), history: saved.loadFactor.join(', '), reference: saved.materialReference }
      // No material default: E, nu, yield and hardening must be entered with their source.
      : { young: '', poisson: '', yield: '', hardening: '', tx: '0', ty: '0', tz: '', linear: '0.1', angular: '0.3',
        chord: '0.2', volume: '', steps: '4', history: '0, 1, 0', reference: '' } };
}
/** The load history is a list of dimensionless factors; every entry must be a plain finite decimal number. */
export function parseLoadHistory(source: string): number[] {
  const parts = source.split(',').map(part => part.trim());
  if (parts.some(part => !/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/u.test(part))) throw new Error(t('solidPlastic.historyInvalid'));
  return parts.map(Number);
}
export function solidPlasticSavedInput(session: SolidPlasticSession, documentId: string,
  parameters: readonly Parameter[]): SolidPlasticCadSavedInput {
  const value = (name: 'young' | 'poisson' | 'tx' | 'ty' | 'tz' | 'linear' | 'angular' | 'chord' | 'volume'): number => {
    const result = solidExpressionField(name, session.values[name], parameters).result;
    if (result.value === null) throw new Error(result.error?.message ?? 'Invalid analysis input');
    return result.value.value;
  };
  // Yield stress uses the Young-modulus field kind (positive MPa) and hardening the signed-stress kind (MPa).
  const stress = (name: 'yield' | 'hardening'): number => {
    const result = solidExpressionField(name === 'yield' ? 'young' : 'tx', session.values[name], parameters).result;
    if (result.value === null) throw new Error(result.error?.message ?? 'Invalid analysis input');
    return result.value.value;
  };
  const steps = Number(session.values.steps.trim());
  return readSolidPlasticCadSavedInput({ schema: SOLID_PLASTIC_CAD_SCHEMA, id: 'solid-plastic-cad', source: { documentId },
    bodyFeatureId: session.bodyFeatureId, fixedFaces: session.fixedFaces, loadedFaces: session.loadedFaces,
    youngMPa: value('young'), poisson: value('poisson'), yieldStressMPa: stress('yield'), hardeningModulusMPa: stress('hardening'),
    materialReference: session.values.reference, tractionMPa: [value('tx'), value('ty'), value('tz')],
    loadFactor: parseLoadHistory(session.values.history), stepsPerSegment: steps,
    linearDeflectionMm: value('linear'), angularDeflectionRad: value('angular'),
    maximumChordDeviationMm: value('chord'), maximumVolumeDeviationMm3: value('volume') });
}
