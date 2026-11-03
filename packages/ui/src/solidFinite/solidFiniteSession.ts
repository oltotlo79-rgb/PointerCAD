import { DEFAULT_SOLID_FINITE_FIELD_VIEW, type SolidFiniteFieldChoice } from './solidFiniteFieldView.js';
import type { CadSolidFiniteOutcome } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { readSolidFiniteCadSavedInput, SOLID_FINITE_CAD_SCHEMA,
  type SolidFiniteCadSavedInput, type AnalysisPropertyEvidence } from '@pointercad/model/beam-analysis';
import { beamExpressionField } from '../beam/beamFields.js';
import { solidExpressionField } from '../solidAnalysis/solidAnalysisSession.js';
import { createSolidBoundaryDraft, solidBoundarySaved, type SolidBoundaryDraft,
  type SolidBoundaryAxis, type SolidGravityField } from '../solidAnalysis/solidBoundaryDraft.js';

export const SOLID_FINITE_FIELDS = ['young', 'poisson', 'yield', 'hardening', 'tx', 'ty', 'tz', 'linear', 'angular',
  'chord', 'volume', 'forceFactors', 'prescribedFactors', 'referenceForce', 'reference'] as const;
export type SolidFiniteField = typeof SOLID_FINITE_FIELDS[number];
export interface SolidFiniteSession extends SolidBoundaryDraft {
  readonly fieldView: SolidFiniteFieldChoice;
  readonly ownerId: string;
  readonly revision: number;
  readonly bodyFeatureId: string | null;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly values: Readonly<Record<SolidFiniteField, string>>;
  readonly focused: SolidFiniteField | null;
  readonly status: 'editing' | 'running' | 'complete' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly result: Extract<CadSolidFiniteOutcome, { kind: 'result' }> | null;
  readonly hardeningEvidence?: AnalysisPropertyEvidence;
}
export type SolidFiniteEdit =
  | { readonly kind: 'field'; readonly field: SolidFiniteField; readonly value: string }
  | { readonly kind: 'support'; readonly face: string; readonly axis: SolidBoundaryAxis;
      readonly fixed?: boolean; readonly displacement?: string }
  | { readonly kind: 'remove-support'; readonly face: string }
  | { readonly kind: 'convert-clamp'; readonly face: string }
  | { readonly kind: 'remove-clamp'; readonly face: string }
  | { readonly kind: 'clear-loaded' }
  | { readonly kind: 'gravity-enabled'; readonly enabled: boolean }
  | { readonly kind: 'gravity'; readonly field: SolidGravityField; readonly value: string };

export function createSolidFiniteSession(ownerId: string, saved?: SolidFiniteCadSavedInput): SolidFiniteSession {
  const boundary = createSolidBoundaryDraft();
  return { fieldView: DEFAULT_SOLID_FINITE_FIELD_VIEW, ownerId, revision: 0, bodyFeatureId: saved?.bodyFeatureId ?? null,
    fixedFaces: saved ? [...saved.fixedFaces] : [], loadedFaces: saved ? [...saved.loadedFaces] : [],
    supports: saved?.supports?.map(row => ({ face: row.face, fixed: [...row.fixed] as [boolean, boolean, boolean],
      displacement: [String(row.prescribedMm?.[0] ?? 0), String(row.prescribedMm?.[1] ?? 0), String(row.prescribedMm?.[2] ?? 0)] as const,
      prescribed: row.prescribedMm !== undefined })) ?? boundary.supports,
    gravity: saved?.gravity === undefined ? boundary.gravity : { enabled: true,
      acceleration: [String(saved.gravity.accelerationMps2[0]), String(saved.gravity.accelerationMps2[1]),
        String(saved.gravity.accelerationMps2[2])], density: String(saved.gravity.densityKgM3) },
    focused: null, boundaryFocused: null, status: 'editing', error: null, result: null,
    ...(saved?.hardeningEvidence === undefined ? {} : { hardeningEvidence: saved.hardeningEvidence }),
    values: saved ? { young: String(saved.youngMPa), poisson: String(saved.poisson), yield: String(saved.yieldStressMPa),
      hardening: String(saved.hardeningModulusMPa), tx: String(saved.tractionMPa[0]), ty: String(saved.tractionMPa[1]),
      tz: String(saved.tractionMPa[2]), linear: String(saved.linearDeflectionMm), angular: String(saved.angularDeflectionRad),
      chord: String(saved.maximumChordDeviationMm), volume: String(saved.maximumVolumeDeviationMm3),
      forceFactors: saved.forceFactors.join(', '), prescribedFactors: saved.prescribedDisplacementFactors.join(', '),
      referenceForce: saved.referenceForceN === undefined ? '' : String(saved.referenceForceN), reference: saved.materialReference }
      : { young: '', poisson: '', yield: '', hardening: '', tx: '0', ty: '0', tz: '', linear: '0.1', angular: '0.3',
        chord: '0.2', volume: '', forceFactors: '', prescribedFactors: '', referenceForce: '', reference: '' } };
}
/** Decimal factors only: no expressions, unit conversion, interpolation or implicit zero. */
export function parseSolidFiniteFactors(source: string): number[] {
  const parts = source.split(',').map(part => part.trim());
  if (parts.length < 1 || parts.length > 200
    || parts.some(part => !/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/u.test(part) || !Number.isFinite(Number(part))))
    throw new Error('Finite step factors must be 1..200 finite decimal values');
  return parts.map(Number);
}
export function solidFiniteSavedInput(session: SolidFiniteSession, documentId: string,
  parameters: readonly Parameter[]): SolidFiniteCadSavedInput {
  const value = (name: 'young' | 'poisson' | 'tx' | 'ty' | 'tz' | 'linear' | 'angular' | 'chord' | 'volume' | 'yield' | 'hardening'): number => {
    const kind = name === 'yield' ? 'young' : name === 'hardening' ? 'tx' : name;
    const result = solidExpressionField(kind, session.values[name], parameters).result;
    if (result.value === null) throw new Error(result.error?.message ?? 'Invalid finite analysis input');
    return result.value.value;
  };
  const reference = session.values.referenceForce.trim();
  const referenceField = reference === '' ? undefined : beamExpressionField('startFx', reference, parameters).result;
  if (referenceField?.value === null) throw new Error(referenceField.error?.message ?? 'Invalid reference force');
  return readSolidFiniteCadSavedInput({ schema: SOLID_FINITE_CAD_SCHEMA, id: 'solid-finite-cad', source: { documentId },
    bodyFeatureId: session.bodyFeatureId, fixedFaces: session.fixedFaces, loadedFaces: session.loadedFaces,
    youngMPa: value('young'), poisson: value('poisson'), yieldStressMPa: value('yield'), hardeningModulusMPa: value('hardening'),
    materialReference: session.values.reference, tractionMPa: [value('tx'), value('ty'), value('tz')],
    forceFactors: parseSolidFiniteFactors(session.values.forceFactors),
    prescribedDisplacementFactors: parseSolidFiniteFactors(session.values.prescribedFactors),
    ...(referenceField?.value === undefined ? {} : { referenceForceN: referenceField.value.value }),
    ...solidBoundarySaved(session, parameters),
    ...(session.hardeningEvidence === undefined ? {} : { hardeningEvidence: session.hardeningEvidence }),
    linearDeflectionMm: value('linear'), angularDeflectionRad: value('angular'),
    maximumChordDeviationMm: value('chord'), maximumVolumeDeviationMm3: value('volume') });
}
