import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { AnalysisMaterialCapacity } from './analysisModel.js';
import { fields, InputIssue, list, number, readOptionalMaterialCapacity, text, vector } from './analysisValidation.js';

/** Only a semantic origin key is saved; runtime indices, mesh and results are never persisted.
 * Keys are resolved by generating the SAME key from the current native-proved face origin.
 * They are never parsed into trusted geometry or used to rescue an ambiguous origin. */
export function solidCadFaceKey(reference: SubShapeRef): string {
  if (reference.fingerprint.kind !== 'face' || reference.origin?.shapeKind !== 'face')
    throw new Error('A persistent face origin is required');
  return JSON.stringify({ bodyFeatureId: reference.bodyFeatureId, origin: reference.origin },
    (_key: string, value: unknown): unknown => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) sorted[key] = Reflect.get(value, key);
      return sorted;
    });
}
/** Schema 1 is the original global surface traction and stays byte-for-byte readable. */
export const SOLID_CAD_TRACTION_SCHEMA = 'pointercad-solid-cad-input/1';
/** Schema 2 is only the signed normal pressure (positive pushes inward). It never carries a traction vector. */
export const SOLID_CAD_PRESSURE_SCHEMA = 'pointercad-solid-cad-input/2';
interface SolidCadSavedInputCommon {
  readonly id: 'solid-cad';
  readonly source: { readonly documentId: string };
  readonly bodyFeatureId: string;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly youngMPa: number;
  readonly poisson: number;
  readonly capacity?: AnalysisMaterialCapacity;
  readonly linearDeflectionMm: number;
  readonly angularDeflectionRad: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
}
export interface SolidCadTractionSavedInput extends SolidCadSavedInputCommon {
  readonly schema: typeof SOLID_CAD_TRACTION_SCHEMA;
  readonly tractionMPa: readonly [number, number, number];
  readonly load?: undefined;
  readonly pressureMPa?: undefined;
}
export interface SolidCadPressureSavedInput extends SolidCadSavedInputCommon {
  readonly schema: typeof SOLID_CAD_PRESSURE_SCHEMA;
  readonly load: 'pressure';
  /** Signed MPa (N/mm²) along the actual outward boundary normal: positive inward (compression), negative outward. */
  readonly pressureMPa: number;
  readonly tractionMPa?: undefined;
}
export type SolidCadSavedInput = SolidCadTractionSavedInput | SolidCadPressureSavedInput;
const COMMON_FIELDS = ['schema', 'id', 'source', 'bodyFeatureId', 'fixedFaces', 'loadedFaces', 'youngMPa', 'poisson',
  'linearDeflectionMm', 'angularDeflectionRad', 'maximumChordDeviationMm', 'maximumVolumeDeviationMm3'] as const;

/** Exactly one load per schema: a pressure file with a traction vector (or the reverse) has an unexpected field set
 * and is refused, as are unknown load kinds and non-finite values. */
export function readSolidCadSavedInput(value: unknown, path = 'solid-cad'): SolidCadSavedInput {
  const pressure = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.get(value, 'schema') === SOLID_CAD_PRESSURE_SCHEMA;
  const hasCapacity = value !== null && typeof value === 'object' && Object.hasOwn(value, 'capacity');
  const row = fields(value, [...COMMON_FIELDS, ...(hasCapacity ? ['capacity'] : []),
    ...(pressure ? ['load', 'pressureMPa'] : ['tractionMPa'])], path);
  if ((row.schema !== SOLID_CAD_TRACTION_SCHEMA && row.schema !== SOLID_CAD_PRESSURE_SCHEMA) || row.id !== 'solid-cad')
    throw new InputIssue('unsupported-schema', path, 'Unsupported solid CAD input version');
  if (pressure && row.load !== 'pressure') throw new InputIssue('invalid-input', path, 'Unsupported solid CAD load');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const bodyFeatureId = text(row.bodyFeatureId, `${path}.bodyFeatureId`);
  const faces = (value: unknown, name: string): readonly string[] => {
    if (Array.isArray(value) && value.length <= 2048) {
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index))
        throw new InputIssue('invalid-input', path, 'Sparse face keys are not supported');
      if (Reflect.ownKeys(value).length !== value.length + 1)
        throw new InputIssue('invalid-input', path, 'Unexpected face-key property');
    }
    const keys = list(value, `${path}.${name}`, 2048, (entry, itemPath) => text(entry, itemPath, 16384));
    if (keys.length === 0 || new Set(keys).size !== keys.length)
      throw new InputIssue('invalid-input', path, 'Select unique persistent faces');
    return keys;
  };
  const positive = (name: string): number => {
    const value = number(row[name], `${path}.${name}`);
    if (!(value > 0)) throw new InputIssue('invalid-input', path, 'Positive physical input required');
    return value;
  };
  const poisson = number(row.poisson, `${path}.poisson`);
  if (!(poisson > -1 && poisson < 0.5)) throw new InputIssue('invalid-input', path, 'Invalid Poisson ratio');
  const chord = number(row.maximumChordDeviationMm, `${path}.maximumChordDeviationMm`);
  const volume = number(row.maximumVolumeDeviationMm3, `${path}.maximumVolumeDeviationMm3`);
  if (chord < 0 || volume < 0) throw new InputIssue('invalid-input', path, 'Nonnegative accuracy limits required');
  // Key order is kept as in schema 1 so saved traction inputs serialize exactly as before.
  const head = { id: 'solid-cad' as const, source: { documentId: text(source.documentId, `${path}.source.documentId`) },
    bodyFeatureId, fixedFaces: faces(row.fixedFaces, 'fixedFaces'), loadedFaces: faces(row.loadedFaces, 'loadedFaces'),
    youngMPa: positive('youngMPa'), poisson, ...readOptionalMaterialCapacity(row, path) };
  const tail = (): Pick<SolidCadSavedInputCommon, 'linearDeflectionMm' | 'angularDeflectionRad'
    | 'maximumChordDeviationMm' | 'maximumVolumeDeviationMm3'> => ({ linearDeflectionMm: positive('linearDeflectionMm'),
    angularDeflectionRad: positive('angularDeflectionRad'), maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume });
  // One explicit branch per schema: each return literal has only its own load fields, so the pressure input can never
  // carry (or be typed with) a traction vector. A conditional union of the two load objects is normalized with optional
  // cross keys and does not narrow by `in` (the strict TS2322 of r2).
  if (pressure) {
    const pressureMPa = number(row.pressureMPa, `${path}.pressureMPa`);
    const input: SolidCadPressureSavedInput = { schema: SOLID_CAD_PRESSURE_SCHEMA, ...head, load: 'pressure', pressureMPa, ...tail() };
    return input;
  }
  const tractionMPa = vector(row.tractionMPa, `${path}.tractionMPa`);
  const input: SolidCadTractionSavedInput = { schema: SOLID_CAD_TRACTION_SCHEMA, ...head, tractionMPa, ...tail() };
  return input;
}
