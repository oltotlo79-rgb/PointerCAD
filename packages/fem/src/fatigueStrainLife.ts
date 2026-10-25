/**
 * Strain-life core of the low-cycle fatigue work (a bounded first slice, not the whole feature): ONE constant-amplitude
 * local total strain amplitude -> cycles to failure. Separate from the stress-life rainflow/Miner/Goodman API of
 * fatigue.ts and fatigueModel.ts, which is unchanged.
 * Relation (Basquin elastic term + Coffin-Manson plastic term, optional Morrow mean-stress correction of the elastic term):
 *   epsilon_a = (sigma_f' - sigma_m) / E * (2 N_f) ** b + epsilon_f' * (2 N_f) ** c        ('none': sigma_m omitted)
 * N_f is cycles and 2 N_f reversals; strains are dimensionless; E and stresses are MPa (= N/mm2); b, c < 0.
 * Primary formula/convention: Altair OptiStruct uniaxial fatigue, Strain-Life section,
 * https://help.altair.com/hwsolvers/os/topics/solvers/os/analysis_fatigue_uniaxial_r.htm
 * Every coefficient, its condition and its calibrated life interval are explicit user inputs: no material property
 * (SS400, S45C or any other) is built in or inferred, and no life outside the calibrated interval is reported.
 * The input must be a local total (elastic + plastic) strain amplitude; an elastic equivalent stress divided by E is
 * not one, and no notch conversion (Neuber, Glinka) is made here. No cycle counting, damage summation, multiaxial
 * method, code check or certification is claimed.
 */
import { FATIGUE_REFERENCE_CYCLE_LIMITS, MAX_FATIGUE_STRESS_MPA, type FatigueSource } from './fatigueModel.js';

export const STRAIN_LIFE_INPUT_SCHEMA = 'pointercad-strain-life/1';
export const STRAIN_LIFE_RESULT_SCHEMA = 'pointercad-strain-life-result/1';
/** Unit-consistency limits, not material values: a modulus in GPa (hundreds) or in Pa (about 1e11) is refused. */
export const STRAIN_LIFE_ELASTIC_MODULUS_LIMITS_MPA = { minimum: 1e3, maximum: 1e7 } as const;
export const STRAIN_LIFE_STRENGTH_COEFFICIENT_LIMITS_MPA = { minimum: 1, maximum: MAX_FATIGUE_STRESS_MPA } as const;
export const STRAIN_LIFE_DUCTILITY_COEFFICIENT_LIMITS = { minimum: 1e-6, maximum: 10 } as const;
/** Both exponents must be negative; the range is a numerical-conditioning limit, not a material value. */
export const STRAIN_LIFE_EXPONENT_LIMITS = { minimum: -2, maximum: -1e-3 } as const;
/** Calibrated life interval in cycles: at least one reversal (half a cycle), at most the stress-life cycle limit.
 * With every limit above, x = ln(2 N_f) lies in [0, ln(2e12) < 28.4], each power lies in [exp(-56.8) > 2e-25, 1],
 * the elastic coefficient is at most (1e4 + 1e4) / 1e3 = 20 and the curve stays in [2e-31, 30]: never overflowing,
 * never underflowing to zero. */
export const STRAIN_LIFE_CYCLE_LIMITS = { minimum: 0.5, maximum: FATIGUE_REFERENCE_CYCLE_LIMITS.maximum } as const;
/** Bisection stops when the bracket of x = ln(2 N_f) is this narrow: a relative life uncertainty of about 1e-12.
 * A bracket of width < 28.4 needs 45 halvings; the iteration bound is a guard, never a silent stop. */
export const STRAIN_LIFE_LOG_TOLERANCE = 1e-12;
export const STRAIN_LIFE_MAX_ITERATIONS = 128;

/** 'none' applies the curve as fitted (fully reversed) and therefore refuses a nonzero mean stress instead of
 * silently ignoring it; 'morrow' subtracts the mean stress from sigma_f' in the elastic term only. */
export type StrainLifeMeanStressCorrection = 'none' | 'morrow';
/** How the local strain was obtained. A linear-elastic equivalent stress divided by E is deliberately not an option. */
export type StrainLifeStrainDerivation = 'measured' | 'elastic-plastic-analysis';
/** Inclusive life interval (cycles) over which the coefficients were fitted or validated. */
export interface StrainLifeCalibration { readonly minimumCycles: number; readonly maximumCycles: number }
export interface StrainLifeMaterial {
  readonly id: string;
  readonly stressUnit: 'MPa';
  readonly elasticModulusMpa: number;
  /** sigma_f' */
  readonly fatigueStrengthCoefficientMpa: number;
  /** b */
  readonly fatigueStrengthExponent: number;
  /** epsilon_f' */
  readonly fatigueDuctilityCoefficient: number;
  /** c */
  readonly fatigueDuctilityExponent: number;
  readonly calibration: StrainLifeCalibration;
  /** Must identify the coefficient source, the material condition and the calibration interval; not checked. */
  readonly source: FatigueSource;
}
export interface StrainLifeLoading {
  readonly strainMeasure: 'local-total-strain-amplitude';
  readonly strainUnit: 'dimensionless';
  readonly derivation: StrainLifeStrainDerivation;
  /** Half of the local total strain range (not a percentage). */
  readonly strainAmplitude: number;
  /** Mean stress of the stabilized local cycle, tension positive. */
  readonly meanStressMpa: number;
  readonly source: FatigueSource;
}
export interface StrainLifeInput {
  readonly schema: typeof STRAIN_LIFE_INPUT_SCHEMA;
  readonly meanStressCorrection: StrainLifeMeanStressCorrection;
  readonly material: StrainLifeMaterial;
  readonly loading: StrainLifeLoading;
}

export type StrainLifeErrorCode = 'strain-life-shape' | 'strain-life-schema' | 'strain-life-id' | 'strain-life-unit'
  | 'strain-life-number' | 'strain-life-sign' | 'strain-life-bound' | 'strain-life-calibration' | 'strain-life-source'
  | 'strain-life-strain-measure' | 'strain-life-correction' | 'strain-life-mean' | 'strain-life-morrow-domain'
  | 'strain-life-zero-amplitude' | 'strain-life-flat' | 'strain-life-shorter-than-calibration'
  | 'strain-life-longer-than-calibration' | 'strain-life-not-converged';
export interface StrainLifeError { readonly ok: false; readonly code: StrainLifeErrorCode; readonly path: string }
export type StrainLifeValidation = { readonly ok: true; readonly input: StrainLifeInput } | StrainLifeError;

export interface StrainLifeResult {
  readonly schema: typeof STRAIN_LIFE_RESULT_SCHEMA;
  readonly method: 'basquin-coffin-manson/1' | 'basquin-coffin-manson/1+morrow-elastic-term/1';
  readonly scope: 'uniaxial-constant-amplitude-local-strain-life-estimate';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly materialId: string;
  readonly meanStressCorrection: StrainLifeMeanStressCorrection;
  readonly strainAmplitude: number;
  readonly meanStressMpa: number;
  readonly calibration: StrainLifeCalibration;
  /** Always inside the calibrated interval; reversalsToFailure is exactly 2 * cyclesToFailure. */
  readonly cyclesToFailure: number;
  readonly reversalsToFailure: number;
  /** 1 / cyclesToFailure (Miner's term of one cycle); finite and positive by the interval limits. */
  readonly damagePerCycle: number;
  /** The two curve terms at the solved life (fitted parts, not a measured elastic/plastic split). */
  readonly curveElasticStrainAmplitude: number;
  readonly curvePlasticStrainAmplitude: number;
  readonly solver: {
    readonly method: 'bisection-log-reversals/1';
    readonly iterations: number;
    /** Half the final bracket width in ln(2 N_f): a bound on the relative life error of the root itself. */
    readonly logReversalsHalfWidth: number;
    /** (curve amplitude at the reported life - input amplitude) / input amplitude. */
    readonly relativeResidual: number;
  };
}
export type StrainLifeAnalysis = { readonly ok: true; readonly result: StrainLifeResult } | StrainLifeError;

const fail = (code: StrainLifeErrorCode, path: string): StrainLifeError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const failed = (value: number | StrainLifeError): value is StrainLifeError => typeof value !== 'number';

function readSource(value: unknown, path: string): FatigueSource | StrainLifeError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('strain-life-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) {
    return fail('strain-life-source', path);
  }
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}
/** Finite, of the required sign (Math.sign(-0) is -0, so a zero of either sign is refused), then within limits. */
function readNumber(value: Record<string, unknown>, key: string, path: string, sign: 1 | -1,
  limits: { readonly minimum: number; readonly maximum: number }): number | StrainLifeError {
  const number = value[key];
  if (!finite(number)) return fail('strain-life-number', `${path}.${key}`);
  if (Math.sign(number) !== sign) return fail('strain-life-sign', `${path}.${key}`);
  if (number < limits.minimum || number > limits.maximum) return fail('strain-life-bound', `${path}.${key}`);
  return number;
}

function readCalibration(value: unknown): StrainLifeCalibration | StrainLifeError {
  const path = 'material.calibration';
  if (!record(value) || !exactKeys(value, ['minimumCycles', 'maximumCycles'])) return fail('strain-life-shape', path);
  const minimumCycles = readNumber(value, 'minimumCycles', path, 1, STRAIN_LIFE_CYCLE_LIMITS);
  if (failed(minimumCycles)) return minimumCycles;
  const maximumCycles = readNumber(value, 'maximumCycles', path, 1, STRAIN_LIFE_CYCLE_LIMITS);
  if (failed(maximumCycles)) return maximumCycles;
  if (!(minimumCycles < maximumCycles)) return fail('strain-life-calibration', `${path}.maximumCycles`);
  return { minimumCycles, maximumCycles };
}

function readMaterial(value: unknown): StrainLifeMaterial | StrainLifeError {
  const path = 'material';
  const keys = ['id', 'stressUnit', 'elasticModulusMpa', 'fatigueStrengthCoefficientMpa', 'fatigueStrengthExponent',
    'fatigueDuctilityCoefficient', 'fatigueDuctilityExponent', 'calibration', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('strain-life-shape', path);
  if (!text(value.id, 64)) return fail('strain-life-id', `${path}.id`);
  if (value.stressUnit !== 'MPa') return fail('strain-life-unit', `${path}.stressUnit`);
  const elasticModulusMpa = readNumber(value, 'elasticModulusMpa', path, 1, STRAIN_LIFE_ELASTIC_MODULUS_LIMITS_MPA);
  if (failed(elasticModulusMpa)) return elasticModulusMpa;
  const fatigueStrengthCoefficientMpa = readNumber(value, 'fatigueStrengthCoefficientMpa', path, 1,
    STRAIN_LIFE_STRENGTH_COEFFICIENT_LIMITS_MPA);
  if (failed(fatigueStrengthCoefficientMpa)) return fatigueStrengthCoefficientMpa;
  const fatigueStrengthExponent = readNumber(value, 'fatigueStrengthExponent', path, -1, STRAIN_LIFE_EXPONENT_LIMITS);
  if (failed(fatigueStrengthExponent)) return fatigueStrengthExponent;
  const fatigueDuctilityCoefficient = readNumber(value, 'fatigueDuctilityCoefficient', path, 1,
    STRAIN_LIFE_DUCTILITY_COEFFICIENT_LIMITS);
  if (failed(fatigueDuctilityCoefficient)) return fatigueDuctilityCoefficient;
  const fatigueDuctilityExponent = readNumber(value, 'fatigueDuctilityExponent', path, -1, STRAIN_LIFE_EXPONENT_LIMITS);
  if (failed(fatigueDuctilityExponent)) return fatigueDuctilityExponent;
  const calibration = readCalibration(value.calibration);
  if ('ok' in calibration) return calibration;
  const source = readSource(value.source, `${path}.source`);
  if ('ok' in source) return source;
  return { id: value.id, stressUnit: 'MPa', elasticModulusMpa, fatigueStrengthCoefficientMpa, fatigueStrengthExponent,
    fatigueDuctilityCoefficient, fatigueDuctilityExponent, calibration, source };
}

function readLoading(value: unknown): StrainLifeLoading | StrainLifeError {
  const path = 'loading';
  const keys = ['strainMeasure', 'strainUnit', 'derivation', 'strainAmplitude', 'meanStressMpa', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('strain-life-shape', path);
  const derivation = value.derivation;
  if (value.strainMeasure !== 'local-total-strain-amplitude') return fail('strain-life-strain-measure', `${path}.strainMeasure`);
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    return fail('strain-life-strain-measure', `${path}.derivation`);
  }
  if (value.strainUnit !== 'dimensionless') return fail('strain-life-unit', `${path}.strainUnit`);
  const strainAmplitude = value.strainAmplitude;
  if (!finite(strainAmplitude)) return fail('strain-life-number', `${path}.strainAmplitude`);
  if (strainAmplitude < 0) return fail('strain-life-sign', `${path}.strainAmplitude`);
  // No strain cycle: neither zero damage nor an infinite life is a verified result of this curve.
  if (strainAmplitude === 0) return fail('strain-life-zero-amplitude', `${path}.strainAmplitude`);
  const meanStressMpa = value.meanStressMpa;
  if (!finite(meanStressMpa)) return fail('strain-life-number', `${path}.meanStressMpa`);
  if (Math.abs(meanStressMpa) > MAX_FATIGUE_STRESS_MPA) return fail('strain-life-bound', `${path}.meanStressMpa`);
  const source = readSource(value.source, `${path}.source`);
  if ('ok' in source) return source;
  return { strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless', derivation, strainAmplitude,
    meanStressMpa, source };
}

/** Strict reader of unknown data; returns fresh values so later caller mutation cannot change an analysis. */
export function validateStrainLifeInput(value: unknown): StrainLifeValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'meanStressCorrection', 'material', 'loading'])) {
    return fail('strain-life-shape', '$');
  }
  if (value.schema !== STRAIN_LIFE_INPUT_SCHEMA) return fail('strain-life-schema', 'schema');
  const meanStressCorrection = value.meanStressCorrection;
  if (meanStressCorrection !== 'none' && meanStressCorrection !== 'morrow') {
    return fail('strain-life-correction', 'meanStressCorrection');
  }
  const material = readMaterial(value.material);
  if ('ok' in material) return material;
  const loading = readLoading(value.loading);
  if ('ok' in loading) return loading;
  if (meanStressCorrection === 'none' && loading.meanStressMpa !== 0) return fail('strain-life-mean', 'loading.meanStressMpa');
  // Morrow needs sigma_f' - sigma_m > 0; IEEE subtraction of two different finite values is never zero.
  if (meanStressCorrection === 'morrow' && !(material.fatigueStrengthCoefficientMpa > loading.meanStressMpa)) {
    return fail('strain-life-morrow-domain', 'loading.meanStressMpa');
  }
  return { ok: true, input: { schema: STRAIN_LIFE_INPUT_SCHEMA, meanStressCorrection, material, loading } };
}

interface CurveTerms {
  readonly elastic: number;
  readonly elasticExponent: number;
  readonly plastic: number;
  readonly plasticExponent: number;
}
function curveTerms(input: StrainLifeInput): CurveTerms {
  const { material, loading } = input;
  const mean = input.meanStressCorrection === 'morrow' ? loading.meanStressMpa : 0;
  return { elastic: (material.fatigueStrengthCoefficientMpa - mean) / material.elasticModulusMpa,
    elasticExponent: material.fatigueStrengthExponent, plastic: material.fatigueDuctilityCoefficient,
    plasticExponent: material.fatigueDuctilityExponent };
}
/** Both curve terms at x = ln(2 N_f); powers are written as exponentials of x so that the solver works in x. */
function termsAt(terms: CurveTerms, x: number): { readonly elastic: number; readonly plastic: number } {
  return { elastic: terms.elastic * Math.exp(terms.elasticExponent * x), plastic: terms.plastic * Math.exp(terms.plasticExponent * x) };
}
function amplitudeAt(terms: CurveTerms, x: number): number {
  const { elastic, plastic } = termsAt(terms, x);
  return elastic + plastic;
}

/** The curve's total strain amplitude at `reversals` (= 2 N_f) for an input accepted by validateStrainLifeInput,
 * evaluated exactly as the solver does; null outside the calibrated interval (no extrapolation). */
export function strainLifeAmplitudeAt(input: StrainLifeInput, reversals: number): number | null {
  const { minimumCycles, maximumCycles } = input.material.calibration;
  if (!finite(reversals) || reversals < 2 * minimumCycles || reversals > 2 * maximumCycles) return null;
  return amplitudeAt(curveTerms(input), Math.log(reversals));
}

/** Validates unknown input and solves the curve for the life in x = ln(2 N_f) by bisection over the calibrated
 * interval. With positive coefficients and negative exponents the curve strictly decreases in x, so the root is unique;
 * the endpoint values must also differ numerically. Typed refusals, never a thrown TypeError or an extrapolated life. */
export function analyzeStrainLife(value: unknown): StrainLifeAnalysis {
  const checked = validateStrainLifeInput(value);
  if (!checked.ok) return checked;
  const { input } = checked, { material, loading } = input, { calibration } = material;
  const target = loading.strainAmplitude, terms = curveTerms(input);
  const shortest = 2 * calibration.minimumCycles, longest = 2 * calibration.maximumCycles;
  const low = Math.log(shortest), high = Math.log(longest);
  const atLow = amplitudeAt(terms, low), atHigh = amplitudeAt(terms, high);
  if (!(atLow > atHigh)) return fail('strain-life-flat', 'material.calibration');
  if (target > atLow) return fail('strain-life-shorter-than-calibration', 'loading.strainAmplitude');
  if (target < atHigh) return fail('strain-life-longer-than-calibration', 'loading.strainAmplitude');
  // Invariant: amplitudeAt(lo) >= target >= amplitudeAt(hi). Both calibration endpoints are inclusive.
  let lo = low, hi = high, iterations = 0;
  if (target === atLow) hi = low;
  else if (target === atHigh) lo = high;
  while (hi - lo > STRAIN_LIFE_LOG_TOLERANCE) {
    if (iterations === STRAIN_LIFE_MAX_ITERATIONS) return fail('strain-life-not-converged', 'loading.strainAmplitude');
    const mid = lo + (hi - lo) / 2;
    if (mid <= lo || mid >= hi) break; // adjacent doubles: the bracket cannot shrink further
    iterations += 1;
    const at = amplitudeAt(terms, mid);
    if (at === target) { lo = mid; hi = mid; } else if (at > target) lo = mid; else hi = mid;
  }
  // An endpoint keeps the user's exact cycles; an interior exp() is clamped into the interval against rounding.
  const reversals = hi === low ? shortest : lo === high ? longest
    : Math.min(Math.max(Math.exp(lo + (hi - lo) / 2), shortest), longest);
  const cyclesToFailure = reversals / 2;
  const parts = termsAt(terms, Math.log(reversals));
  return { ok: true, result: { schema: STRAIN_LIFE_RESULT_SCHEMA,
    method: input.meanStressCorrection === 'morrow' ? 'basquin-coffin-manson/1+morrow-elastic-term/1' : 'basquin-coffin-manson/1',
    scope: 'uniaxial-constant-amplitude-local-strain-life-estimate', codeCompliance: false, structuralCertification: false,
    materialId: material.id, meanStressCorrection: input.meanStressCorrection, strainAmplitude: target,
    meanStressMpa: loading.meanStressMpa, calibration, cyclesToFailure, reversalsToFailure: reversals,
    damagePerCycle: 1 / cyclesToFailure, curveElasticStrainAmplitude: parts.elastic, curvePlasticStrainAmplitude: parts.plastic,
    solver: { method: 'bisection-log-reversals/1', iterations, logReversalsHalfWidth: (hi - lo) / 2,
      relativeResidual: (parts.elastic + parts.plastic - target) / target } } };
}
