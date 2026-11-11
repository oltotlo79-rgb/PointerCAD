import { fields, InputIssue, list, number, text } from './analysisValidation.js';

/**
 * Saved free-vibration input of one CAD solid (at most one per document). Only physical inputs and semantic face keys
 * (solidCadFaceKey) are saved; meshes, modes and every display choice (mode, amplitude, phase) are never persisted.
 * An empty fixedFaces list is the free-free case.
 */
export const SOLID_MODAL_CAD_SCHEMA = 'pointercad-solid-modal-cad-input/1';
export interface SolidModalCadSavedInput {
  readonly schema: typeof SOLID_MODAL_CAD_SCHEMA;
  readonly id: 'solid-modal-cad';
  readonly source: { readonly documentId: string };
  readonly bodyFeatureId: string;
  readonly fixedFaces: readonly string[];
  readonly youngMPa: number;
  readonly poisson: number;
  /** Mass density in kg/m^3, as the user entered it (the request converts units, never the saved value). */
  readonly densityKgM3: number;
  readonly modeCount: number;
  readonly linearDeflectionMm: number;
  readonly angularDeflectionRad: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
}
const FIELDS = ['schema', 'id', 'source', 'bodyFeatureId', 'fixedFaces', 'youngMPa', 'poisson', 'densityKgM3', 'modeCount',
  'linearDeflectionMm', 'angularDeflectionRad', 'maximumChordDeviationMm', 'maximumVolumeDeviationMm3'] as const;

export function readSolidModalCadSavedInput(value: unknown, path = 'solid-modal-cad'): SolidModalCadSavedInput {
  const row = fields(value, [...FIELDS], path);
  if (row.schema !== SOLID_MODAL_CAD_SCHEMA || row.id !== 'solid-modal-cad')
    throw new InputIssue('unsupported-schema', path, 'Unsupported solid modal input version');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  if (Array.isArray(row.fixedFaces)) {
    for (let index = 0; index < row.fixedFaces.length; index++) if (!Object.hasOwn(row.fixedFaces, index))
      throw new InputIssue('invalid-input', path, 'Sparse face keys are not supported');
    if (Reflect.ownKeys(row.fixedFaces).length !== row.fixedFaces.length + 1)
      throw new InputIssue('invalid-input', path, 'Unexpected face-key property');
  }
  const fixedFaces = list(row.fixedFaces, `${path}.fixedFaces`, 2048, (entry, itemPath) => text(entry, itemPath, 16384));
  if (new Set(fixedFaces).size !== fixedFaces.length) throw new InputIssue('invalid-input', path, 'Select unique persistent faces');
  const positive = (name: string): number => {
    const result = number(row[name], `${path}.${name}`);
    if (!(result > 0)) throw new InputIssue('invalid-input', path, 'Positive physical input required');
    return result;
  };
  const poisson = number(row.poisson, `${path}.poisson`);
  if (!(poisson > -1 && poisson < 0.5)) throw new InputIssue('invalid-input', path, 'Invalid Poisson ratio');
  const modeCount = number(row.modeCount, `${path}.modeCount`);
  if (!Number.isInteger(modeCount) || modeCount < 1 || modeCount > 20) throw new InputIssue('invalid-input', path, 'Mode count must be 1 to 20');
  const chord = number(row.maximumChordDeviationMm, `${path}.maximumChordDeviationMm`);
  const volume = number(row.maximumVolumeDeviationMm3, `${path}.maximumVolumeDeviationMm3`);
  if (chord < 0 || volume < 0) throw new InputIssue('invalid-input', path, 'Nonnegative accuracy limits required');
  return {
    schema: SOLID_MODAL_CAD_SCHEMA, id: 'solid-modal-cad', source: { documentId: text(source.documentId, `${path}.source.documentId`) },
    bodyFeatureId: text(row.bodyFeatureId, `${path}.bodyFeatureId`), fixedFaces,
    youngMPa: positive('youngMPa'), poisson, densityKgM3: positive('densityKgM3'), modeCount,
    linearDeflectionMm: positive('linearDeflectionMm'), angularDeflectionRad: positive('angularDeflectionRad'),
    maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume,
  };
}
