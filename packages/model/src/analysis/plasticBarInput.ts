import { fields, InputIssue, text } from './analysisValidation.js';
import { analysisPropertyEvidenceKeys, hardeningPropertySeries, readOptionalAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/**
 * Saved configuration of the uniaxial elasto-plastic bar (one per document). Only user inputs are stored, in the
 * panel's units (mm, mm², MPa); the UI restores every field with exactExpressionValueFromNumber (plain decimal, no
 * exponent text) to the same double. Object key order is not significant (compare fields, not JSON). Results, solver
 * handles, digests and run state are never stored. Material values are user-supplied with a stated source; nothing is
 * derived from a steel grade name. Scope: one bar, axial only, small strain, end-displacement control.
 */
export const PLASTIC_BAR_SAVED_SCHEMA = 'pointercad-plastic-bar-input/1';
/** The single saved configuration of a document; distinct from the UUID ids of beam analyses. */
export const PLASTIC_BAR_SAVED_ID = 'plastic-bar';

export interface PlasticBarSavedInput {
  readonly schema: typeof PLASTIC_BAR_SAVED_SCHEMA;
  readonly id: typeof PLASTIC_BAR_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly units: 'N-mm';
  readonly lengthMm: number;
  readonly areaMm2: number;
  readonly youngModulusMPa: number;
  readonly poisson: number;
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
  readonly hardeningEvidence?: AnalysisPropertyEvidence;
  readonly materialSource: { readonly kind: 'user-supplied'; readonly reference: string };
  /** Complete piecewise-linear end-displacement knots; the first is 0 (undeformed). */
  readonly endDisplacementMm: readonly number[];
  readonly stepsPerSegment: number;
}

/** SI values of the solver plan. The UI converts with exactly this function, so saved and solved values agree. */
export interface PlasticBarSiValues {
  readonly lengthM: number;
  readonly areaM2: number;
  readonly youngPa: number;
  readonly poisson: number;
  readonly yieldStressPa: number;
  readonly hardeningModulusPa: number;
  readonly endDisplacementM: readonly number[];
  readonly stepsPerSegment: number;
}
export function plasticBarSiValues(value: Omit<PlasticBarSavedInput, 'schema' | 'id' | 'source' | 'units' | 'materialSource'>): PlasticBarSiValues {
  return { lengthM: value.lengthMm / 1000, areaM2: value.areaMm2 / 1_000_000, youngPa: value.youngModulusMPa * 1_000_000,
    poisson: value.poisson, yieldStressPa: value.yieldStressMPa * 1_000_000,
    hardeningModulusPa: value.hardeningModulusMPa * 1_000_000,
    endDisplacementM: value.endDisplacementMm.map(knot => knot / 1000), stepsPerSegment: value.stepsPerSegment };
}

/** Same bounds as PLASTIC_BAR_LIMITS of @pointercad/fem plasticBar.ts (the model cannot import the solver package). */
const LIMITS = { maximumKnots: 64, maximumStepsPerSegment: 200, maximumSteps: 2000, maximumStrain: 0.05,
  maximumLengthM: 500, maximumAreaM2: 1 } as const;

function fail(path: string, message: string): never {
  throw new InputIssue('plastic-bar', path, message);
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number');
  return value === 0 ? 0 : value;
}

/**
 * Strict reader. Field set, schema, units and source are exact; every rule of readPlasticBarPlan is applied, in the
 * same order and with the same comparisons, to the SI values from plasticBarSiValues. Unknown versions and invalid
 * values are rejected (the document loader reports them); nothing is coerced.
 */
export function readPlasticBarSavedInput(value: unknown, path: string): PlasticBarSavedInput {
  const row = fields(value, ['schema', 'id', 'source', 'units', 'lengthMm', 'areaMm2', 'youngModulusMPa', 'poisson',
    'yieldStressMPa', 'hardeningModulusMPa', 'materialSource', 'endDisplacementMm', 'stepsPerSegment',
    ...analysisPropertyEvidenceKeys(value, 'hardeningEvidence')], path);
  if (row.schema !== PLASTIC_BAR_SAVED_SCHEMA || row.units !== 'N-mm') {
    throw new InputIssue('unsupported-model', path, 'Expected plastic-bar input schema 1 in N-mm units');
  }
  if (row.id !== PLASTIC_BAR_SAVED_ID) fail(`${path}.id`, 'Unexpected plastic-bar input id');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  const materialSource = fields(row.materialSource, ['kind', 'reference'], `${path}.materialSource`);
  if (materialSource.kind !== 'user-supplied') fail(`${path}.materialSource.kind`, 'Material values must be user-supplied');
  const reference = materialSource.reference;
  if (typeof reference !== 'string' || reference.trim() === '' || reference.length > 500) {
    fail(`${path}.materialSource.reference`, 'A stated source of at most 500 characters is required');
  }
  const knots = row.endDisplacementMm;
  if (!Array.isArray(knots) || knots.length < 2 || knots.length > LIMITS.maximumKnots) {
    fail(`${path}.endDisplacementMm`, `Expected 2 to ${LIMITS.maximumKnots} knots`);
  }
  for (let index = 0; index < knots.length; index += 1) {
    if (!Object.hasOwn(knots, index)) fail(`${path}.endDisplacementMm`, 'Knots must not have holes');
  }
  const steps = row.stepsPerSegment;
  if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 1 || steps > LIMITS.maximumStepsPerSegment) {
    fail(`${path}.stepsPerSegment`, `Expected an integer from 1 to ${LIMITS.maximumStepsPerSegment}`);
  }
  const saved: PlasticBarSavedInput = { schema: PLASTIC_BAR_SAVED_SCHEMA, id: PLASTIC_BAR_SAVED_ID, source: { documentId },
    units: 'N-mm', lengthMm: finite(row.lengthMm, `${path}.lengthMm`), areaMm2: finite(row.areaMm2, `${path}.areaMm2`),
    youngModulusMPa: finite(row.youngModulusMPa, `${path}.youngModulusMPa`), poisson: finite(row.poisson, `${path}.poisson`),
    yieldStressMPa: finite(row.yieldStressMPa, `${path}.yieldStressMPa`),
    hardeningModulusMPa: finite(row.hardeningModulusMPa, `${path}.hardeningModulusMPa`),
    materialSource: { kind: 'user-supplied', reference },
    endDisplacementMm: knots.map((knot: unknown, index: number) => finite(knot, `${path}.endDisplacementMm[${index}]`)),
    stepsPerSegment: steps };
  const si = plasticBarSiValues(saved);
  const positive = (number: number, name: string): void => {
    if (!(Number.isFinite(number) && number > 0)) fail(`${path}.${name}`, 'Expected a positive value');
  };
  positive(si.lengthM, 'lengthMm');
  if (si.lengthM > LIMITS.maximumLengthM) fail(`${path}.lengthMm`, 'Length exceeds 500 m');
  positive(si.areaM2, 'areaMm2');
  if (si.areaM2 > LIMITS.maximumAreaM2) fail(`${path}.areaMm2`, 'Area exceeds 1 m²');
  positive(si.youngPa, 'youngModulusMPa');
  if (si.poisson < 0 || si.poisson >= 0.5) fail(`${path}.poisson`, 'Poisson ratio must be in [0, 0.5)');
  positive(si.yieldStressPa, 'yieldStressMPa');
  if (si.yieldStressPa >= si.youngPa) fail(`${path}.yieldStressMPa`, 'Yield stress must be below the Young modulus');
  if (!Number.isFinite(si.hardeningModulusPa) || si.hardeningModulusPa < 0) {
    fail(`${path}.hardeningModulusMPa`, 'Hardening modulus must be finite and not negative (softening is not supported)');
  }
  if (si.endDisplacementM.some(knot => !Number.isFinite(knot))) fail(`${path}.endDisplacementMm`, 'Expected finite knots');
  if (si.endDisplacementM[0] !== 0) fail(`${path}.endDisplacementMm[0]`, 'The first knot must be 0');
  for (let index = 1; index < si.endDisplacementM.length; index += 1) {
    if (si.endDisplacementM[index] === si.endDisplacementM[index - 1]) {
      fail(`${path}.endDisplacementMm[${index}]`, 'Consecutive knots must differ');
    }
  }
  if (si.endDisplacementM.some(knot => Math.abs(knot) / si.lengthM > LIMITS.maximumStrain)) {
    fail(`${path}.endDisplacementMm`, '|end displacement| / length must not exceed 0.05 (small strain)');
  }
  if (steps * (si.endDisplacementM.length - 1) > LIMITS.maximumSteps) fail(`${path}.stepsPerSegment`, 'At most 2000 steps');
  const hardeningEvidence = readOptionalAnalysisPropertyEvidence(row, 'hardeningEvidence', hardeningPropertySeries(saved), path);
  return { ...saved, ...(hardeningEvidence === undefined ? {} : { hardeningEvidence }) };
}
