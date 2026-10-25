import type { CadSolidOutcome } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { readSolidCadSavedInput, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { plasticBarExpressionField } from '../beam/beamFields.js';
import { DEFAULT_SOLID_FIELD_VIEW, type SolidFieldViewChoice } from './solidFieldState.js';

export const SOLID_FIELDS = ['young', 'poisson', 'tx', 'ty', 'tz', 'pressure', 'linear', 'angular', 'chord', 'volume'] as const;
export type SolidField = typeof SOLID_FIELDS[number];
/** Exactly one surface load is analysed and saved: a global traction vector or a signed normal pressure. */
export type SolidLoadMode = 'traction' | 'pressure';
const LOAD_FIELDS: Readonly<Record<SolidLoadMode, readonly SolidField[]>> = { traction: ['tx', 'ty', 'tz'], pressure: ['pressure'] };
/** The fields shown and evaluated for a mode. Drafts of the other mode are kept but never read or saved. */
export function solidFieldsFor(mode: SolidLoadMode): readonly SolidField[] {
  const hidden = LOAD_FIELDS[mode === 'traction' ? 'pressure' : 'traction'];
  return SOLID_FIELDS.filter(name => !hidden.includes(name));
}
export interface SolidAnalysisSession {
  readonly ownerId: string;
  readonly revision: number;
  readonly bodyFeatureId: string | null;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly loadMode: SolidLoadMode;
  readonly values: Readonly<Record<SolidField, string>>;
  readonly focused: SolidField | null;
  readonly status: 'editing' | 'running' | 'complete' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly result: Extract<CadSolidOutcome, { kind: 'result' }> | null;
  /** Field view display choice (quantity, deformation scale). Display only: never part of the saved input. */
  readonly fieldView: SolidFieldViewChoice;
}
export function createSolidAnalysisSession(ownerId: string, saved?: SolidCadSavedInput): SolidAnalysisSession {
  const load = saved === undefined ? { tx: '0', ty: '0', tz: '', pressure: '' }
    : saved.schema === 'pointercad-solid-cad-input/2' ? { tx: '0', ty: '0', tz: '', pressure: String(saved.pressureMPa) }
      : { tx: String(saved.tractionMPa[0]), ty: String(saved.tractionMPa[1]), tz: String(saved.tractionMPa[2]), pressure: '' };
  return { ownerId, revision: 0, bodyFeatureId: saved?.bodyFeatureId ?? null,
    fixedFaces: saved ? [...saved.fixedFaces] : [], loadedFaces: saved ? [...saved.loadedFaces] : [], focused: null,
    loadMode: saved?.schema === 'pointercad-solid-cad-input/2' ? 'pressure' : 'traction',
    status: 'editing', error: null, result: null, fieldView: { ...DEFAULT_SOLID_FIELD_VIEW },
    values: saved ? { young: String(saved.youngMPa), poisson: String(saved.poisson), ...load,
      linear: String(saved.linearDeflectionMm), angular: String(saved.angularDeflectionRad),
      chord: String(saved.maximumChordDeviationMm), volume: String(saved.maximumVolumeDeviationMm3) }
      : { young: '', poisson: '', ...load, linear: '0.1', angular: '0.3', chord: '0.2', volume: '' } };
}
/** Reuse the existing expression/unit parser and IME-capable field. Stress and pressure use signed MPa. */
export function solidExpressionField(name: SolidField, source: string, parameters: readonly Parameter[]): ReturnType<typeof plasticBarExpressionField> {
  const kind = name === 'young' ? 'young' : name === 'tx' || name === 'ty' || name === 'tz' || name === 'pressure' ? 'hardening'
    : name === 'linear' || name === 'chord' ? 'knot' : 'poisson';
  const field = plasticBarExpressionField(kind, name, source, parameters);
  const labels = { young: 'solidAnalysis.young', poisson: 'solidAnalysis.poisson', tx: 'solidAnalysis.tx',
    ty: 'solidAnalysis.ty', tz: 'solidAnalysis.tz', pressure: 'solidAnalysis.pressure', linear: 'solidAnalysis.linear',
    angular: 'solidAnalysis.angular', chord: 'solidAnalysis.chord', volume: 'solidAnalysis.volume' } as const;
  return { ...field, field: { ...field.field, labelKey: labels[name],
    tooltipKey: name === 'pressure' ? 'solidAnalysis.pressureHelp' : 'solidAnalysis.expressionHelp' },
    unitLabel: name === 'volume' ? 'mm³' : name === 'angular' ? 'rad' : field.unitLabel };
}
export function solidSavedInput(session: SolidAnalysisSession, documentId: string,
  parameters: readonly Parameter[]): SolidCadSavedInput {
  const value = (name: SolidField): number => {
    const result = solidExpressionField(name, session.values[name], parameters).result;
    if (result.value === null) throw new Error(result.error?.message ?? 'Invalid analysis input');
    return result.value.value;
  };
  const common = { id: 'solid-cad', source: { documentId },
    bodyFeatureId: session.bodyFeatureId, fixedFaces: session.fixedFaces, loadedFaces: session.loadedFaces,
    youngMPa: value('young'), poisson: value('poisson') };
  // Only the selected mode is evaluated: hidden drafts of the other load neither block nor leak into the saved input.
  const load = session.loadMode === 'pressure'
    ? { schema: 'pointercad-solid-cad-input/2', ...common, load: 'pressure', pressureMPa: value('pressure') }
    : { schema: 'pointercad-solid-cad-input/1', ...common, tractionMPa: [value('tx'), value('ty'), value('tz')] };
  return readSolidCadSavedInput({ ...load,
    linearDeflectionMm: value('linear'), angularDeflectionRad: value('angular'),
    maximumChordDeviationMm: value('chord'), maximumVolumeDeviationMm3: value('volume') });
}
