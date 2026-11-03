import { isFiniteNumber } from '../valueGuards.js';
import { createInputIssueFail, text } from './analysisValidation.js';
import { hardeningPropertySeries, readOptionalAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';
import type { SolidCadSavedInput } from './solidCadInput.js';

/** Explicit native steps, with undeformed/unloaded t=0 implicit. Never stores mesh or results. */
export const SOLID_FINITE_CAD_SCHEMA = 'pointercad-solid-finite-cad-input/1';
export interface SolidFiniteCadSavedInput {
  readonly schema: typeof SOLID_FINITE_CAD_SCHEMA;
  readonly id: 'solid-finite-cad';
  readonly source: { readonly documentId: string };
  readonly bodyFeatureId: string;
  readonly fixedFaces: readonly string[];
  readonly loadedFaces: readonly string[];
  readonly youngMPa: number;
  readonly poisson: number;
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
  readonly materialReference: string;
  readonly hardeningEvidence?: AnalysisPropertyEvidence;
  /** Reference-geometry dead traction, not follower pressure. */
  readonly tractionMPa: readonly [number, number, number];
  readonly forceFactors: readonly number[];
  readonly prescribedDisplacementFactors: readonly number[];
  readonly referenceForceN?: number;
  readonly supports?: SolidCadSavedInput['supports'];
  readonly gravity?: SolidCadSavedInput['gravity'];
  readonly linearDeflectionMm: number;
  readonly angularDeflectionRad: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
}
const fail: (path: string, message: string) => never = createInputIssueFail('invalid-input');
function exact(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== names.length || names.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail(path, 'Expected exactly the declared own data fields');
  return value as Record<string, unknown>;
}
function finite(value: unknown, path: string, positive = false): number {
  if (!isFiniteNumber(value) || (positive && value <= 0))
    fail(path, 'Expected a finite physical value');
  return value;
}
function dense(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail(path, 'Unsupported collection size or fields');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail(path, 'Expected dense own data entries');
  }
  return value;
}
function triple(value: unknown, path: string): readonly [number, number, number] {
  const row = dense(value, path, 3, 3);
  return [finite(row[0], path), finite(row[1], path), finite(row[2], path)];
}
function faces(value: unknown, path: string): string[] {
  const result = dense(value, path, 0, 2048).map(item => text(item, path, 16384));
  if (new Set(result).size !== result.length) fail(path, 'Select unique persistent faces');
  return result;
}
function support(value: unknown, path: string): NonNullable<SolidFiniteCadSavedInput['supports']>[number] {
  const hasPrescribed = value !== null && typeof value === 'object' && Object.hasOwn(value, 'prescribedMm');
  const row = exact(value, ['face', 'fixed', ...(hasPrescribed ? ['prescribedMm'] : [])], path);
  const components = dense(row.fixed, `${path}.fixed`, 3, 3);
  if (components.some(item => typeof item !== 'boolean') || !components.some(item => item === true))
    fail(path, 'Select at least one fixed direction');
  const fixed = [components[0] === true, components[1] === true, components[2] === true] as const;
  const face = text(row.face, `${path}.face`, 16384);
  if (!hasPrescribed) return { face, fixed };
  const prescribedMm = triple(row.prescribedMm, `${path}.prescribedMm`);
  if (prescribedMm.some((item, axis) => !fixed[axis] && item !== 0)) fail(path, 'Free axes must prescribe zero');
  return { face, fixed, prescribedMm };
}
/** No old history columns, migration, interpolation or inferred material values. */
export function readSolidFiniteCadSavedInput(value: unknown, path = 'solid-finite-cad'): SolidFiniteCadSavedInput {
  const optional = ['supports', 'gravity', 'referenceForceN', 'hardeningEvidence'].filter(name =>
    value !== null && typeof value === 'object' && Object.hasOwn(value, name));
  const row = exact(value, ['schema', 'id', 'source', 'bodyFeatureId', 'fixedFaces', 'loadedFaces', 'youngMPa', 'poisson',
    'yieldStressMPa', 'hardeningModulusMPa', 'materialReference', 'tractionMPa', 'forceFactors', 'prescribedDisplacementFactors',
    'linearDeflectionMm', 'angularDeflectionRad', 'maximumChordDeviationMm', 'maximumVolumeDeviationMm3', ...optional], path);
  if (row.schema !== SOLID_FINITE_CAD_SCHEMA || row.id !== 'solid-finite-cad') fail(path, 'Unsupported finite CAD schema');
  const source = exact(row.source, ['documentId'], `${path}.source`);
  const youngMPa = finite(row.youngMPa, `${path}.youngMPa`, true), poisson = finite(row.poisson, `${path}.poisson`);
  const yieldStressMPa = finite(row.yieldStressMPa, `${path}.yieldStressMPa`, true);
  const hardeningModulusMPa = finite(row.hardeningModulusMPa, `${path}.hardeningModulusMPa`);
  if (poisson < 0 || poisson >= 0.5 || hardeningModulusMPa < 0) fail(path, 'Unsupported material range');
  const materialReference = row.materialReference;
  if (typeof materialReference !== 'string' || materialReference.trim() === '' || materialReference.length > 500)
    fail(path, 'State the material source in at most 500 JS string units');
  const forceFactors = dense(row.forceFactors, `${path}.forceFactors`, 1, 200).map(item => finite(item, path));
  const prescribedDisplacementFactors = dense(row.prescribedDisplacementFactors, `${path}.prescribedDisplacementFactors`,
    forceFactors.length, forceFactors.length).map(item => finite(item, path));
  const fixedFaces = faces(row.fixedFaces, `${path}.fixedFaces`), loadedFaces = faces(row.loadedFaces, `${path}.loadedFaces`);
  const supports = optional.includes('supports') ? dense(row.supports, `${path}.supports`, 1, 2048)
    .map((item, index) => support(item, `${path}.supports[${index}]`)) : undefined;
  if (new Set(supports?.map(item => item.face)).size !== (supports?.length ?? 0)
    || supports?.some(item => fixedFaces.includes(item.face))) fail(path, 'Support faces must be unique and separate from clamps');
  if (fixedFaces.length === 0 && supports === undefined) fail(path, 'Select a clamp or support');
  const gravityRow = optional.includes('gravity') ? exact(row.gravity, ['accelerationMps2', 'densityKgM3'], `${path}.gravity`) : undefined;
  const gravity = gravityRow === undefined ? undefined : {
    accelerationMps2: triple(gravityRow.accelerationMps2, `${path}.gravity.accelerationMps2`),
    densityKgM3: finite(gravityRow.densityKgM3, `${path}.gravity.densityKgM3`, true) };
  const prescribed = supports?.some(item => item.prescribedMm?.some(component => component !== 0)) === true;
  if (loadedFaces.length === 0 && gravity === undefined && !prescribed) fail(path, 'Select a load or explicit displacement control');
  const referenceForceN = optional.includes('referenceForceN') ? finite(row.referenceForceN, `${path}.referenceForceN`, true) : undefined;
  if ((forceFactors.every(item => item === 0) || (loadedFaces.length === 0 && gravity === undefined)) && referenceForceN === undefined)
    fail(path, 'An explicit reference force is required for zero-force/displacement control');
  const chord = finite(row.maximumChordDeviationMm, `${path}.maximumChordDeviationMm`);
  const volume = finite(row.maximumVolumeDeviationMm3, `${path}.maximumVolumeDeviationMm3`);
  if (chord < 0 || volume < 0) fail(path, 'Accuracy limits must be nonnegative');
  const hardeningEvidence = readOptionalAnalysisPropertyEvidence(row, 'hardeningEvidence',
    hardeningPropertySeries({ yieldStressMPa, hardeningModulusMPa }), path);
  return { schema: SOLID_FINITE_CAD_SCHEMA, id: 'solid-finite-cad',
    source: { documentId: text(source.documentId, `${path}.source.documentId`) },
    bodyFeatureId: text(row.bodyFeatureId, `${path}.bodyFeatureId`), fixedFaces, loadedFaces,
    youngMPa, poisson, yieldStressMPa, hardeningModulusMPa, materialReference, tractionMPa: triple(row.tractionMPa, `${path}.tractionMPa`),
    forceFactors, prescribedDisplacementFactors, ...(supports === undefined ? {} : { supports }),
    ...(gravity === undefined ? {} : { gravity }), ...(referenceForceN === undefined ? {} : { referenceForceN }),
    ...(hardeningEvidence === undefined ? {} : { hardeningEvidence }),
    linearDeflectionMm: finite(row.linearDeflectionMm, `${path}.linearDeflectionMm`, true),
    angularDeflectionRad: finite(row.angularDeflectionRad, `${path}.angularDeflectionRad`, true),
    maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume };
}
