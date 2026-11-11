import { fields, InputIssue, list, number, text, vector } from './analysisValidation.js';
import { analysisPropertyEvidenceKeys, hardeningPropertySeries, readOptionalAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/**
 * Saved definition of a CAD continuum-plasticity analysis (small-strain J2, linear isotropic hardening, tet4).
 * Same persistence rules as solidCadInput.ts: only semantic face-origin keys (solidCadFaceKey) and user inputs are saved;
 * mesh, runtime indices and results are never persisted. Material values are user-supplied with a stated reference;
 * nothing is derived from a grade name. Bounds mirror the solver plan limits (fem SOLID_PLASTIC_LIMITS) so a saved
 * document cannot hold a history the solver refuses.
 */
export const SOLID_PLASTIC_CAD_SCHEMA = 'pointercad-solid-plastic-cad-input/1';
export const SOLID_PLASTIC_CAD_LIMITS = { maximumKnots: 64, maximumStepsPerSegment: 200, maximumSteps: 2000 } as const;
export interface SolidPlasticCadSavedInput {
  readonly schema: typeof SOLID_PLASTIC_CAD_SCHEMA;
  readonly id: 'solid-plastic-cad';
  readonly source: { readonly documentId: string };
  readonly bodyFeatureId: string;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly youngMPa: number;
  readonly poisson: number;
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
  readonly hardeningEvidence?: AnalysisPropertyEvidence;
  readonly materialReference: string;
  /** Reference traction; the applied traction at each step is this vector times the load factor. */
  readonly tractionMPa: readonly [number, number, number];
  /** Load-factor history: first knot 0; unloading and reversal are later knots of smaller or opposite value. */
  readonly loadFactor: readonly number[];
  readonly stepsPerSegment: number;
  readonly linearDeflectionMm: number;
  readonly angularDeflectionRad: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
}
/** Shared with the solver plan reader (fem solidPlastic.ts isReference): code points, explicit whitespace set. */
const REFERENCE_WHITESPACE: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000, 0xfeff]);

export function readSolidPlasticCadSavedInput(value: unknown, path = 'solid-plastic-cad'): SolidPlasticCadSavedInput {
  const row = fields(value, ['schema', 'id', 'source', 'bodyFeatureId', 'fixedFaces', 'loadedFaces', 'youngMPa', 'poisson',
    'yieldStressMPa', 'hardeningModulusMPa', 'materialReference', 'tractionMPa', 'loadFactor', 'stepsPerSegment',
    'linearDeflectionMm', 'angularDeflectionRad', 'maximumChordDeviationMm', 'maximumVolumeDeviationMm3',
    ...analysisPropertyEvidenceKeys(value, 'hardeningEvidence')], path);
  if (row.schema !== SOLID_PLASTIC_CAD_SCHEMA || row.id !== 'solid-plastic-cad')
    throw new InputIssue('unsupported-schema', path, 'Unsupported solid plasticity input version');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const faces = (entry: unknown, name: string): readonly string[] => {
    if (Array.isArray(entry)) for (let index = 0; index < entry.length; index++) if (!Object.hasOwn(entry, index))
      throw new InputIssue('invalid-input', path, 'Sparse face keys are not supported');
    const keys = list(entry, `${path}.${name}`, 2048, (item, itemPath) => text(item, itemPath, 16384));
    if (keys.length === 0 || new Set(keys).size !== keys.length)
      throw new InputIssue('invalid-input', path, 'Select unique persistent faces');
    return keys;
  };
  const positive = (name: string): number => {
    const result = number(row[name], `${path}.${name}`);
    if (!(result > 0)) throw new InputIssue('invalid-input', path, 'Positive physical input required');
    return result;
  };
  const youngMPa = positive('youngMPa');
  const poisson = number(row.poisson, `${path}.poisson`);
  // The solver plan accepts [0, 0.5); the saved input uses the same range so it never saves an unrunnable value.
  if (!(poisson >= 0 && poisson < 0.5)) throw new InputIssue('invalid-input', path, 'Invalid Poisson ratio');
  const yieldStressMPa = positive('yieldStressMPa');
  if (!(yieldStressMPa < youngMPa)) throw new InputIssue('invalid-input', path, 'Yield stress must be below Young modulus');
  const hardeningModulusMPa = number(row.hardeningModulusMPa, `${path}.hardeningModulusMPa`);
  if (!(hardeningModulusMPa >= 0)) throw new InputIssue('invalid-input', path, 'Softening is not supported');
  const reference = row.materialReference;
  if (typeof reference !== 'string') throw new InputIssue('invalid-input', path, 'Material source required');
  const points = Array.from(reference, character => character.codePointAt(0) ?? 0);
  if (points.length > 500 || !points.some(point => !REFERENCE_WHITESPACE.has(point)))
    throw new InputIssue('invalid-input', path, 'State where the material values come from (at most 500 characters)');
  const knots = list(row.loadFactor, `${path}.loadFactor`, SOLID_PLASTIC_CAD_LIMITS.maximumKnots,
    (item, itemPath) => number(item, itemPath));
  if (knots.length < 2 || knots[0] !== 0) throw new InputIssue('invalid-input', path, 'The load history must start at 0');
  for (let index = 1; index < knots.length; index++) if (knots[index] === knots[index - 1])
    throw new InputIssue('invalid-input', path, 'Consecutive load factors must differ');
  const steps = row.stepsPerSegment;
  if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 1
    || steps > SOLID_PLASTIC_CAD_LIMITS.maximumStepsPerSegment || steps * (knots.length - 1) > SOLID_PLASTIC_CAD_LIMITS.maximumSteps)
    throw new InputIssue('invalid-input', path, 'Invalid number of load steps');
  const chord = number(row.maximumChordDeviationMm, `${path}.maximumChordDeviationMm`);
  const volume = number(row.maximumVolumeDeviationMm3, `${path}.maximumVolumeDeviationMm3`);
  if (chord < 0 || volume < 0) throw new InputIssue('invalid-input', path, 'Nonnegative accuracy limits required');
  const hardeningEvidence = readOptionalAnalysisPropertyEvidence(row, 'hardeningEvidence',
    hardeningPropertySeries({ yieldStressMPa, hardeningModulusMPa }), path);
  return { schema: SOLID_PLASTIC_CAD_SCHEMA, id: 'solid-plastic-cad',
    source: { documentId: text(source.documentId, `${path}.source.documentId`) },
    bodyFeatureId: text(row.bodyFeatureId, `${path}.bodyFeatureId`),
    fixedFaces: faces(row.fixedFaces, 'fixedFaces'), loadedFaces: faces(row.loadedFaces, 'loadedFaces'),
    youngMPa, poisson, yieldStressMPa, hardeningModulusMPa, materialReference: reference,
    tractionMPa: vector(row.tractionMPa, `${path}.tractionMPa`), loadFactor: knots, stepsPerSegment: steps,
    linearDeflectionMm: positive('linearDeflectionMm'), angularDeflectionRad: positive('angularDeflectionRad'),
    maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume,
    ...(hardeningEvidence === undefined ? {} : { hardeningEvidence }) };
}
