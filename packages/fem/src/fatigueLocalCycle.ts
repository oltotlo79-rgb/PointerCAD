/**
 * Mean-stress corrected strain-life for ONE documented constant-amplitude LOCAL cycle (a finite slice; history pairing
 * of stresses with rainflow cycles is a separate, later task). The user gives the local strain extrema and the local
 * stress extrema of the same stabilized cycle (measured or from an elastic-plastic analysis), with provenance:
 *   epsilon_a = (strainMax - strainMin) / 2,  sigma_m = (stressMax + stressMin) / 2,  sigma_max = stressMax.
 * A stress is never derived from a strain (no Hooke substitution) and never taken from an unrelated cycle.
 * Relations (Altair OptiStruct uniaxial fatigue, Mean Stress Correction,
 * https://help.altair.com/hwsolvers/os/topics/solvers/os/analysis_fatigue_uniaxial_r.htm):
 *   Morrow: epsilon_a = (sigma_f' - sigma_m) / E * (2N)^b + epsilon_f' * (2N)^c          (requires sigma_m < sigma_f')
 *   SWT:    sigma_max * epsilon_a = sigma_f'^2 / E * (2N)^(2b) + sigma_f' * epsilon_f' * (2N)^(b + c)
 *                                                                                         (requires sigma_max > 0)
 * The SWT right side is the algebraic substitution of the Basquin and Coffin-Manson terms into sigma_max * epsilon_a
 * (an inference, not a copied implementation). The SWT prediction for a zero or negative maximum stress is not
 * realistic and is refused, never reported as an infinite life or as zero damage. Morrow reuses the strain-life core
 * of fatigueStrainLife.ts unchanged. Material coefficients, their source and their calibrated life interval are the
 * user's own (validated by the same reader as fatigueStrainLife.ts); no life outside that interval is reported.
 * Units: stresses MPa, strains dimensionless, N cycles and 2N reversals. Uniaxial only; no code check or certification.
 *
 * Floating-point bound: the solver stops when the bracket of x = ln(2N) is at most STRAIN_LIFE_LOG_TOLERANCE (1e-12),
 * so the root itself is known to a relative 5e-13 in N. Each evaluation of the right side has a relative rounding error
 * of a few units in the last place (< 1e-15); since |d ln f / dx| >= 2e-3 for the admitted exponents
 * (b, c <= -1e-3), that moves x by at most about 2e-12. The reported N is therefore within a relative 3e-12 of the exact
 * root of the rounded inputs; tests use 1e-9.
 */
import { MAX_FATIGUE_STRESS_MPA, type FatigueSource } from './fatigueModel.js';
import { STRAIN_LIFE_INPUT_SCHEMA, STRAIN_LIFE_LOG_TOLERANCE, STRAIN_LIFE_MAX_ITERATIONS, analyzeStrainLife,
  validateStrainLifeInput, type StrainLifeCalibration, type StrainLifeErrorCode, type StrainLifeMaterial,
  type StrainLifeStrainDerivation } from './fatigueStrainLife.js';

export const LOCAL_CYCLE_INPUT_SCHEMA = 'pointercad-strain-life-local-cycle/1';
export const LOCAL_CYCLE_RESULT_SCHEMA = 'pointercad-strain-life-local-cycle-result/1';
/** |strain| above 1 (100 %) is refused as a unit error, the same limit as the strain-history reader. */
export const LOCAL_CYCLE_MAX_ABS_STRAIN = 1;

export type LocalCycleCorrection = 'morrow' | 'swt';
/** Extrema of one stabilized local cycle; tension positive. */
export interface LocalCycle {
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly stressUnit: 'MPa';
  readonly derivation: StrainLifeStrainDerivation;
  readonly strainMax: number;
  readonly strainMin: number;
  readonly stressMax: number;
  readonly stressMin: number;
  readonly source: FatigueSource;
}
export interface LocalCycleInput {
  readonly schema: typeof LOCAL_CYCLE_INPUT_SCHEMA;
  readonly correction: LocalCycleCorrection;
  readonly material: StrainLifeMaterial;
  readonly cycle: LocalCycle;
}
export type LocalCycleErrorCode = 'local-cycle-shape' | 'local-cycle-schema' | 'local-cycle-correction' | 'local-cycle-unit'
  | 'local-cycle-strain-measure' | 'local-cycle-number' | 'local-cycle-bound' | 'local-cycle-extrema' | 'local-cycle-source'
  | 'swt-nonpositive-maximum-stress' | 'swt-parameter-underflow';
/** Material refusals and Morrow refusals keep the strain-life code; their path is material.* or 'cycle'. */
export interface LocalCycleError {
  readonly ok: false;
  readonly code: LocalCycleErrorCode | StrainLifeErrorCode;
  readonly path: string;
}
export type LocalCycleValidation = { readonly ok: true; readonly input: LocalCycleInput } | LocalCycleError;
export interface LocalCycleResult {
  readonly schema: typeof LOCAL_CYCLE_RESULT_SCHEMA;
  readonly method: 'basquin-coffin-manson/1+morrow-elastic-term/1' | 'basquin-coffin-manson/1+smith-watson-topper/1';
  readonly scope: 'uniaxial-constant-amplitude-local-cycle-strain-life-estimate';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly materialId: string;
  readonly correction: LocalCycleCorrection;
  readonly calibration: StrainLifeCalibration;
  readonly strainAmplitude: number;
  readonly meanStressMpa: number;
  readonly maximumStressMpa: number;
  /** sigma_max * epsilon_a [MPa] for SWT; null for Morrow. */
  readonly swtParameterMpa: number | null;
  /** Inside the calibrated interval; reversalsToFailure is exactly 2 * cyclesToFailure. */
  readonly cyclesToFailure: number;
  readonly reversalsToFailure: number;
  readonly damagePerCycle: number;
  readonly solver: { readonly method: 'bisection-log-reversals/1'; readonly iterations: number;
    readonly logReversalsHalfWidth: number; readonly relativeResidual: number };
}
export type LocalCycleAnalysis = { readonly ok: true; readonly result: LocalCycleResult } | LocalCycleError;

const fail = (code: LocalCycleErrorCode, path: string): LocalCycleError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readSource(value: unknown, path: string): FatigueSource | LocalCycleError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('local-cycle-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) {
    return fail('local-cycle-source', path);
  }
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}
/** A strain-life input of fatigueStrainLife.ts for a material that is still unknown data (the reader checks the
 * material before the loading, so with a valid loading every refusal is a material refusal). */
function strainLifeInput(material: unknown, strainAmplitude: number, meanStressMpa: number, derivation: StrainLifeStrainDerivation,
  source: FatigueSource): Record<string, unknown> {
  return { schema: STRAIN_LIFE_INPUT_SCHEMA, meanStressCorrection: 'morrow', material,
    loading: { strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless', derivation, strainAmplitude,
      meanStressMpa, source } };
}
const PROBE_SOURCE: FatigueSource = { kind: 'user-supplied', reference: 'Material validation probe; not a load',
  condition: 'Validates the material only' };
function readMaterial(value: unknown): StrainLifeMaterial | LocalCycleError {
  const checked = validateStrainLifeInput(strainLifeInput(value, 1, 0, 'measured', PROBE_SOURCE));
  return checked.ok ? checked.input.material : checked;
}

function readNumber(value: Record<string, unknown>, key: string, limit: number): number | LocalCycleError {
  const number = value[key];
  if (!finite(number)) return fail('local-cycle-number', `cycle.${key}`);
  if (Math.abs(number) > limit) return fail('local-cycle-bound', `cycle.${key}`);
  return number;
}
const failed = (value: number | LocalCycleError): value is LocalCycleError => typeof value !== 'number';

function readCycle(value: unknown): LocalCycle | LocalCycleError {
  const keys = ['strainMeasure', 'strainUnit', 'stressUnit', 'derivation', 'strainMax', 'strainMin', 'stressMax', 'stressMin',
    'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('local-cycle-shape', 'cycle');
  if (value.strainMeasure !== 'local-total-strain') return fail('local-cycle-strain-measure', 'cycle.strainMeasure');
  const derivation = value.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') return fail('local-cycle-strain-measure', 'cycle.derivation');
  if (value.strainUnit !== 'dimensionless') return fail('local-cycle-unit', 'cycle.strainUnit');
  if (value.stressUnit !== 'MPa') return fail('local-cycle-unit', 'cycle.stressUnit');
  const strainMax = readNumber(value, 'strainMax', LOCAL_CYCLE_MAX_ABS_STRAIN);
  if (failed(strainMax)) return strainMax;
  const strainMin = readNumber(value, 'strainMin', LOCAL_CYCLE_MAX_ABS_STRAIN);
  if (failed(strainMin)) return strainMin;
  const stressMax = readNumber(value, 'stressMax', MAX_FATIGUE_STRESS_MPA);
  if (failed(stressMax)) return stressMax;
  const stressMin = readNumber(value, 'stressMin', MAX_FATIGUE_STRESS_MPA);
  if (failed(stressMin)) return stressMin;
  // One cycle has a strain range and a stress range; equal or reversed extrema do not describe a cycle.
  if (!(strainMax > strainMin)) return fail('local-cycle-extrema', 'cycle.strainMin');
  if (!(stressMax > stressMin)) return fail('local-cycle-extrema', 'cycle.stressMin');
  const source = readSource(value.source, 'cycle.source');
  if ('ok' in source) return source;
  return { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation, strainMax,
    strainMin, stressMax, stressMin, source };
}

/** Strict reader of unknown data; returns fresh values so later caller mutation cannot change an analysis. */
export function validateLocalCycleInput(value: unknown): LocalCycleValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'correction', 'material', 'cycle'])) return fail('local-cycle-shape', '$');
  if (value.schema !== LOCAL_CYCLE_INPUT_SCHEMA) return fail('local-cycle-schema', 'schema');
  const correction = value.correction;
  if (correction !== 'morrow' && correction !== 'swt') return fail('local-cycle-correction', 'correction');
  const material = readMaterial(value.material);
  if ('ok' in material) return material;
  const cycle = readCycle(value.cycle);
  if ('ok' in cycle) return cycle;
  return { ok: true, input: { schema: LOCAL_CYCLE_INPUT_SCHEMA, correction, material, cycle } };
}

const amplitudeOf = (cycle: LocalCycle): number => (cycle.strainMax - cycle.strainMin) / 2;
const meanOf = (cycle: LocalCycle): number => (cycle.stressMax + cycle.stressMin) / 2;

interface SwtTerms { readonly elastic: number; readonly elasticExponent: number; readonly mixed: number; readonly mixedExponent: number }
function swtTerms(material: StrainLifeMaterial): SwtTerms {
  const { fatigueStrengthCoefficientMpa: strength, elasticModulusMpa: modulus } = material;
  return { elastic: strength * strength / modulus, elasticExponent: 2 * material.fatigueStrengthExponent,
    mixed: strength * material.fatigueDuctilityCoefficient,
    mixedExponent: material.fatigueStrengthExponent + material.fatigueDuctilityExponent };
}
/** With the strain-life limits each term lies in [1e-7 * exp(-4 * 28.4), 1e5]: positive, never overflowing. */
function swtAt(terms: SwtTerms, x: number): number {
  return terms.elastic * Math.exp(terms.elasticExponent * x) + terms.mixed * Math.exp(terms.mixedExponent * x);
}
/** The SWT right side [MPa] at `reversals` (= 2N) for a validated material, evaluated exactly as the solver does;
 * null outside the calibrated interval (no extrapolation). */
export function swtParameterAt(material: StrainLifeMaterial, reversals: number): number | null {
  const { minimumCycles, maximumCycles } = material.calibration;
  if (!finite(reversals) || reversals < 2 * minimumCycles || reversals > 2 * maximumCycles) return null;
  return swtAt(swtTerms(material), Math.log(reversals));
}

function solveSwt(input: LocalCycleInput): LocalCycleAnalysis {
  const { material, cycle } = input, { calibration } = material;
  if (!(cycle.stressMax > 0)) return fail('swt-nonpositive-maximum-stress', 'cycle.stressMax');
  const strainAmplitude = amplitudeOf(cycle), target = cycle.stressMax * strainAmplitude;
  // A product too small for a number is not a verified long life: it is refused, never reported as infinite.
  if (!(target > 0)) return fail('swt-parameter-underflow', 'cycle.stressMax');
  const terms = swtTerms(material);
  const shortest = 2 * calibration.minimumCycles, longest = 2 * calibration.maximumCycles;
  const low = Math.log(shortest), high = Math.log(longest);
  const atLow = swtAt(terms, low), atHigh = swtAt(terms, high);
  if (!(atLow > atHigh)) return { ok: false, code: 'strain-life-flat', path: 'material.calibration' };
  if (target > atLow) return { ok: false, code: 'strain-life-shorter-than-calibration', path: 'cycle' };
  if (target < atHigh) return { ok: false, code: 'strain-life-longer-than-calibration', path: 'cycle' };
  // Invariant: swtAt(lo) >= target >= swtAt(hi); both calibration endpoints are inclusive.
  let lo = low, hi = high, iterations = 0;
  if (target === atLow) hi = low;
  else if (target === atHigh) lo = high;
  while (hi - lo > STRAIN_LIFE_LOG_TOLERANCE) {
    if (iterations === STRAIN_LIFE_MAX_ITERATIONS) return { ok: false, code: 'strain-life-not-converged', path: 'cycle' };
    const mid = lo + (hi - lo) / 2;
    if (mid <= lo || mid >= hi) break; // adjacent doubles: the bracket cannot shrink further
    iterations += 1;
    const at = swtAt(terms, mid);
    if (at === target) { lo = mid; hi = mid; } else if (at > target) lo = mid; else hi = mid;
  }
  const reversals = hi === low ? shortest : lo === high ? longest
    : Math.min(Math.max(Math.exp(lo + (hi - lo) / 2), shortest), longest);
  const cyclesToFailure = reversals / 2;
  return { ok: true, result: { schema: LOCAL_CYCLE_RESULT_SCHEMA, method: 'basquin-coffin-manson/1+smith-watson-topper/1',
    scope: 'uniaxial-constant-amplitude-local-cycle-strain-life-estimate', codeCompliance: false, structuralCertification: false,
    materialId: material.id, correction: 'swt', calibration, strainAmplitude, meanStressMpa: meanOf(cycle),
    maximumStressMpa: cycle.stressMax, swtParameterMpa: target, cyclesToFailure, reversalsToFailure: reversals,
    damagePerCycle: 1 / cyclesToFailure, solver: { method: 'bisection-log-reversals/1', iterations,
      logReversalsHalfWidth: (hi - lo) / 2, relativeResidual: (swtAt(terms, Math.log(reversals)) - target) / target } } };
}

function solveMorrow(input: LocalCycleInput): LocalCycleAnalysis {
  const { material, cycle } = input;
  const strainAmplitude = amplitudeOf(cycle), meanStressMpa = meanOf(cycle);
  const analysis = analyzeStrainLife(strainLifeInput(material, strainAmplitude, meanStressMpa, cycle.derivation, cycle.source));
  // The strain-life core reports loading.* paths; here the loading is derived from the cycle extrema.
  if (!analysis.ok) return { ok: false, code: analysis.code, path: analysis.path.startsWith('loading') ? 'cycle' : analysis.path };
  const { result } = analysis;
  return { ok: true, result: { schema: LOCAL_CYCLE_RESULT_SCHEMA, method: 'basquin-coffin-manson/1+morrow-elastic-term/1',
    scope: 'uniaxial-constant-amplitude-local-cycle-strain-life-estimate', codeCompliance: false, structuralCertification: false,
    materialId: material.id, correction: 'morrow', calibration: material.calibration, strainAmplitude, meanStressMpa,
    maximumStressMpa: cycle.stressMax, swtParameterMpa: null, cyclesToFailure: result.cyclesToFailure,
    reversalsToFailure: result.reversalsToFailure, damagePerCycle: result.damagePerCycle, solver: result.solver } };
}

/** Validates unknown input and solves the selected mean-stress corrected relation for the one local cycle. */
export function analyzeLocalCycle(value: unknown): LocalCycleAnalysis {
  const checked = validateLocalCycleInput(value);
  if (!checked.ok) return checked;
  return checked.input.correction === 'swt' ? solveSwt(checked.input) : solveMorrow(checked.input);
}
