import { comparePlasticBar, plasticBarReference, plasticBarSchedule, PLASTIC_BAR_LIMITS, PLASTIC_BAR_RESULT_SCHEMA,
  type PlasticBarPlan, type PlasticBarSample } from './plasticBar.js';
import { translatePlasticBar, type PlasticBarInput, type PlasticBarSource } from './plasticBarTranslation.js';

export const PLASTIC_BAR_METHOD = 'oofem-misesmat-htype0-truss1d-staticstructural/1';
export const PLASTIC_BAR_SCOPE = 'uniaxial-small-strain-j2-linear-isotropic-hardening-displacement-control';
/**
 * Bounds stated in plasticBarNative.proof.md (plastic1) before any native execution and enforced here unchanged:
 * one uniform element evaluates the same closed-form 1D return as the reference, so only Newton convergence
 * (rtolf 1e-10) and rounding remain. Strain = end displacement / length is the B-matrix product itself and gets the
 * same 1e-12 bound as the prescribed displacement (stated here, before execution).
 */
export const PLASTIC_BAR_TOLERANCES = {
  displacement: 1e-12,
  strain: 1e-12,
  stress: 1e-8,
  plasticStrain: 1e-8,
  force: 1e-8,
  equilibrium: 1e-8,
} as const;

export interface PlasticBarNativeSample extends PlasticBarSample {
  /** The prescribed end displacement of this step, from the plan's knots. */
  readonly targetDisplacementM: number;
}
export interface PlasticBarDeviation {
  readonly stress: number;
  readonly plasticStrain: number;
  readonly force: number;
  readonly displacement: number;
  readonly strain: number;
}
export interface PlasticBarResult {
  readonly kind: 'oofem-plastic-bar-1d';
  readonly method: typeof PLASTIC_BAR_METHOD;
  readonly scope: typeof PLASTIC_BAR_SCOPE;
  readonly structuralCertification: false;
  readonly source: PlasticBarSource;
  readonly inputSha256: string;
  readonly samples: readonly PlasticBarNativeSample[];
  readonly yielded: boolean;
  readonly maximumEquilibriumMismatch: number;
  /** Largest scaled differences from the independent return-mapping reference (all within PLASTIC_BAR_TOLERANCES). */
  readonly referenceDeviation: PlasticBarDeviation;
}

function fail(detail: string): never {
  throw new Error(`plastic-bar-result: ${detail}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const row = value;
  if (Reflect.ownKeys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    fail(`${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}
const sampleFields = ['step', 'targetDisplacementM', 'endDisplacementM', 'strain', 'stressPa', 'plasticStrain',
  'axialForceN'] as const;
const rawFields = ['schema', 'method', 'scope', 'structuralCertification', 'samples', 'yielded',
  'maximumEquilibriumMismatch'] as const;

/**
 * Strict reader of the native runner's JSON, used before any comparison. Rejects a wrong schema/method/scope, a
 * certification claim, extra or missing fields, an empty or holey sample list, a count other than the plan's
 * schedule, misnumbered steps, a target other than the schedule, every non-finite number, an inconsistent yielded
 * flag or equilibrium measure, and any deviation from the independent reference beyond PLASTIC_BAR_TOLERANCES.
 */
export function readPlasticBarNative(raw: unknown, plan: PlasticBarPlan): {
  readonly samples: PlasticBarNativeSample[]; readonly yielded: boolean;
  readonly maximumEquilibriumMismatch: number; readonly referenceDeviation: PlasticBarDeviation;
} {
  const row = exactFields(raw, rawFields, 'result');
  if (row.schema !== PLASTIC_BAR_RESULT_SCHEMA) fail('unsupported result schema');
  if (row.method !== PLASTIC_BAR_METHOD) fail('unexpected method');
  if (row.scope !== PLASTIC_BAR_SCOPE) fail('unexpected scope');
  if (row.structuralCertification !== false) fail('structuralCertification must be false');
  const schedule = plasticBarSchedule(plan);
  if (!denseArray(row.samples) || row.samples.length === 0) fail('samples must be a non-empty dense array');
  if (row.samples.length !== schedule.length || schedule.length > PLASTIC_BAR_LIMITS.maximumSteps) {
    fail(`expected ${schedule.length} samples, received ${row.samples.length}`);
  }
  const samples = row.samples.map((value: unknown, index: number): PlasticBarNativeSample => {
    const path = `samples[${index}]`;
    const sample = exactFields(value, sampleFields, path);
    if (sample.step !== index + 1) fail(`${path}.step must be ${index + 1}`);
    const targetDisplacementM = finite(sample.targetDisplacementM, `${path}.targetDisplacementM`);
    if (targetDisplacementM !== schedule[index]) fail(`${path}.targetDisplacementM differs from the plan schedule`);
    return { step: index + 1, targetDisplacementM,
      endDisplacementM: finite(sample.endDisplacementM, `${path}.endDisplacementM`),
      strain: finite(sample.strain, `${path}.strain`), stressPa: finite(sample.stressPa, `${path}.stressPa`),
      plasticStrain: finite(sample.plasticStrain, `${path}.plasticStrain`),
      axialForceN: finite(sample.axialForceN, `${path}.axialForceN`) };
  });
  if (typeof row.yielded !== 'boolean' || row.yielded !== samples.some(sample => sample.plasticStrain !== 0)) {
    fail('yielded must state whether any sample has non-zero plastic strain');
  }
  const mismatch = finite(row.maximumEquilibriumMismatch, 'maximumEquilibriumMismatch');
  const { areaM2, material: { yieldStressPa, youngPa } } = plan;
  // Same operations and order as the runner: maximum absolute mismatch first, then one division.
  const recomputed = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.axialForceN - sample.stressPa * areaM2)), 0)
    / (yieldStressPa * areaM2);
  if (mismatch !== recomputed) fail('maximumEquilibriumMismatch does not match the samples');
  if (!(mismatch <= PLASTIC_BAR_TOLERANCES.equilibrium)) fail('end force and stress x area disagree beyond 1e-8');
  const compared = comparePlasticBar(samples, plasticBarReference(plan), plan);
  const strainScale = yieldStressPa / youngPa;
  const strain = samples.reduce((max, sample) => Math.max(max,
    Math.abs(sample.strain - sample.endDisplacementM / plan.lengthM) / strainScale), 0);
  const referenceDeviation: PlasticBarDeviation = { ...compared, strain };
  for (const name of ['displacement', 'strain', 'stress', 'plasticStrain', 'force'] as const) {
    // Written as !(x <= bound) so that a NaN deviation is rejected as well.
    if (!(referenceDeviation[name] <= PLASTIC_BAR_TOLERANCES[name])) {
      fail(`${name} deviates from the independent reference by ${referenceDeviation[name]} (bound ${PLASTIC_BAR_TOLERANCES[name]})`);
    }
  }
  return { samples, yielded: row.yielded, maximumEquilibriumMismatch: mismatch, referenceDeviation };
}

export function decodePlasticBar(raw: unknown, input: PlasticBarInput, inputSha256: string): PlasticBarResult {
  if (!/^[0-9a-f]{64}$/u.test(inputSha256)) fail('input digest must be 64 lowercase hexadecimal characters');
  const prepared = translatePlasticBar(input);
  const read = readPlasticBarNative(raw, prepared.plan);
  return { kind: 'oofem-plastic-bar-1d', method: PLASTIC_BAR_METHOD, scope: PLASTIC_BAR_SCOPE,
    structuralCertification: false, source: prepared.input.source, inputSha256, ...read };
}

/** Shape check used by the protocol; association with an input is plasticBarResultMatches. */
export function isPlasticBarResult(value: unknown): value is PlasticBarResult {
  if (!isRecord(value) || value.kind !== 'oofem-plastic-bar-1d' || value.method !== PLASTIC_BAR_METHOD
    || value.scope !== PLASTIC_BAR_SCOPE || value.structuralCertification !== false
    || !isRecord(value.source) || typeof value.source.documentId !== 'string'
    || typeof value.source.revision !== 'number' || !Number.isSafeInteger(value.source.revision)
    || typeof value.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.inputSha256)
    || typeof value.yielded !== 'boolean' || typeof value.maximumEquilibriumMismatch !== 'number'
    || !Number.isFinite(value.maximumEquilibriumMismatch) || !isRecord(value.referenceDeviation)
    || !denseArray(value.samples) || value.samples.length === 0
    || value.samples.length > PLASTIC_BAR_LIMITS.maximumSteps) return false;
  const deviation = value.referenceDeviation;
  return ['stress', 'plasticStrain', 'force', 'displacement', 'strain'].every(name =>
    typeof deviation[name] === 'number' && Number.isFinite(deviation[name]))
    && value.samples.every((sample: unknown) => isRecord(sample)
      && sampleFields.every(name => typeof sample[name] === 'number' && Number.isFinite(sample[name])));
}

/** Compare the complete decoded result, ignoring only object property insertion order (as transientResults.ts). */
function sameResultStructure(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length
      || Reflect.ownKeys(value).length !== value.length + 1
      || Reflect.ownKeys(expected).length !== expected.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !Object.hasOwn(expected, index)
        || !sameResultStructure(value[index], expected[index])) return false;
    }
    return true;
  }
  if (isRecord(value) && isRecord(expected)) {
    const keys = Reflect.ownKeys(value);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key)
        && sameResultStructure(value[key], expected[key]));
  }
  return value === expected;
}

/** True only for a result decoded from exactly this input and digest; stale or foreign results are rejected. */
export function plasticBarResultMatches(value: unknown, input: PlasticBarInput, hash: string): value is PlasticBarResult {
  if (!isPlasticBarResult(value)) return false;
  try {
    const decoded = decodePlasticBar({ schema: PLASTIC_BAR_RESULT_SCHEMA, method: value.method, scope: value.scope,
      structuralCertification: false, samples: value.samples.map(sample => ({ step: sample.step,
        targetDisplacementM: sample.targetDisplacementM, endDisplacementM: sample.endDisplacementM,
        strain: sample.strain, stressPa: sample.stressPa, plasticStrain: sample.plasticStrain,
        axialForceN: sample.axialForceN })),
      yielded: value.yielded, maximumEquilibriumMismatch: value.maximumEquilibriumMismatch }, input, hash);
    return sameResultStructure(value, decoded);
  } catch { return false; }
}
