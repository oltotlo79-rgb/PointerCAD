/**
 * Proportional ELASTIC stress-tensor loading on the existing scalar stress-life path (one finite F2 increment, not the
 * whole multiaxial fatigue feature). Opt-in by its own schema; no existing scalar input is reinterpreted.
 *
 * Each history gives ONE symmetric reference Cauchy stress tensor (MPa, components xx, yy, zz, yz, xz, xy with tensor
 * shear components, the order of the solid results) and chronological signed scalar load factors; the stress at sample
 * k is factor[k] x reference, so the loading is proportional by construction (no arbitrary tensor history is accepted).
 * The scalar handed to the existing rainflow/Miner analysis is the signed von Mises equivalent:
 *   s[k] = factor[k] x sign x vonMises(reference),
 *   vonMises = sqrt(((xx-yy)^2 + (yy-zz)^2 + (zz-xx)^2) / 2 + 3 (yz^2 + xz^2 + xy^2)),
 *   sign = sign of the principal stress of the reference with the largest absolute value.
 * When the largest and the smallest principal stresses have equal absolute values (relative difference at most
 * PRINCIPAL_TIE_TOLERANCE, e.g. pure shear) the sign is +1 (tension) and the conversion reports `signTie: true`; this
 * tie convention belongs to this named method only and is not a statement about the actual normal mean stress. The
 * factor sign is always kept, so a reversed factor gives the reversed equivalent stress.
 * Refused, never guessed: a zero reference (no load defined), a hydrostatic reference (von Mises is zero although the
 * principal stresses are not, so this equivalent does not represent it), a nonzero reference or a nonzero factor whose
 * equivalent stress rounds to zero (it would report no damage for a defined load), and a factor whose equivalent stress
 * exceeds the scalar stress bound (reported at that factor).
 * The curve, its provenance, its mean-stress assumption and the sequence/repeats semantics are those of the existing
 * scalar path: the converted input goes through validateFatigueInput/analyzeFatigue unchanged, so their refusal codes
 * and paths are kept. Not a non-proportional, critical-plane, weld or bolt method, not a code check or certification.
 * Method references (paraphrased in the task handoff): Ansys Mechanical 2024 R2 fatigue options (signed von Mises,
 * proportional history loading) and Altair HyperLife 2023.1 stress-life approach (explicit S-N convention).
 */
import { analyzeFatigue } from './fatigue.js';
import { FATIGUE_INPUT_SCHEMA, MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_STRESS_MPA, validateFatigueInput,
  type FatigueError, type FatigueResult, type FatigueValidation } from './fatigueModel.js';

export const FATIGUE_PROPORTIONAL_TENSOR_SCHEMA = 'pointercad-fatigue-proportional-tensor/1';
export const FATIGUE_PROPORTIONAL_TENSOR_METHOD = 'proportional-elastic-signed-von-mises-absolute-largest-principal/1';
export const FATIGUE_TENSOR_COMPONENTS = 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy';
/** The component keys in the order of FATIGUE_TENSOR_COMPONENTS (the order shown to the user). */
export const FATIGUE_TENSOR_COMPONENT_KEYS = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'] as const;
export type FatigueTensorComponent = typeof FATIGUE_TENSOR_COMPONENT_KEYS[number];
/** Relative tolerance on |largest| - |smallest| principal stress for the documented tension tie-break. */
export const PRINCIPAL_TIE_TOLERANCE = 1e-12;
/** A deviatoric part this small relative to the largest component is hydrostatic within rounding. */
export const HYDROSTATIC_TOLERANCE = 1e-12;

export interface FatigueReferenceTensor {
  readonly unit: 'MPa';
  readonly components: typeof FATIGUE_TENSOR_COMPONENTS;
  readonly xx: number; readonly yy: number; readonly zz: number;
  readonly yz: number; readonly xz: number; readonly xy: number;
}
export interface FatigueTensorConversion {
  readonly historyId: string;
  /** Principal stresses of the reference, descending (MPa). */
  readonly principalStressesMpa: readonly [number, number, number];
  readonly vonMisesReferenceMpa: number;
  /** sign x vonMises of the reference; the scalar history is factor x this value. */
  readonly signedEquivalentReferenceMpa: number;
  readonly signTie: boolean;
}
export type FatigueTensorErrorCode = 'fatigue-tensor-shape' | 'fatigue-tensor-schema' | 'fatigue-tensor-method'
  | 'fatigue-tensor-unit' | 'fatigue-tensor-convention' | 'fatigue-tensor-number' | 'fatigue-tensor-bound'
  | 'fatigue-tensor-history' | 'fatigue-tensor-zero-reference' | 'fatigue-tensor-hydrostatic' | 'fatigue-tensor-underflow';
export interface FatigueTensorError { readonly ok: false; readonly code: FatigueTensorErrorCode; readonly path: string }
export type FatigueTensorConversionResult =
  | { readonly ok: true; readonly input: unknown; readonly conversions: readonly FatigueTensorConversion[] }
  | FatigueTensorError;
export type FatigueTensorAnalysis =
  | { readonly ok: true; readonly result: FatigueResult; readonly method: typeof FATIGUE_PROPORTIONAL_TENSOR_METHOD;
    readonly conversions: readonly FatigueTensorConversion[] }
  | FatigueTensorError | FatigueError;

/** [xx, yy, zz, yz, xz, xy]; every component is present (no defaulting). */
type Tensor = readonly [number, number, number, number, number, number];

const fail = (code: FatigueTensorErrorCode, path: string): FatigueTensorError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** von Mises of a symmetric tensor; exact for a uniaxial tensor (sqrt of an exact square). */
function vonMises([xx, yy, zz, yz, xz, xy]: Tensor): number {
  return Math.sqrt(((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (yz * yz + xz * xz + xy * xy));
}

/**
 * Eigenvalues of a symmetric 3 x 3 tensor, descending, by the closed trigonometric form (deviatoric invariants). Internal:
 * the only caller passes a validated reference already scaled so that its largest |component| is 1 (no overflow or
 * underflow). Returns null for a hydrostatic tensor (deviatoric norm below HYDROSTATIC_TOLERANCE), whose principal
 * directions are undefined.
 */
function principalStresses([xx, yy, zz, yz, xz, xy]: Tensor): readonly [number, number, number] | null {
  const q = (xx + yy + zz) / 3;
  const dx = xx - q, dy = yy - q, dz = zz - q;
  const p2 = dx * dx + dy * dy + dz * dz + 2 * (yz * yz + xz * xz + xy * xy);
  const p = Math.sqrt(p2 / 6);
  if (!(p > HYDROSTATIC_TOLERANCE)) return null;
  // det(B) of B = (A - qI) / p, by cofactors of the first row.
  const bxx = dx / p, byy = dy / p, bzz = dz / p, byz = yz / p, bxz = xz / p, bxy = xy / p;
  const det = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
  const r = Math.min(1, Math.max(-1, det / 2));
  const phi = Math.acos(r) / 3;
  const largest = q + 2 * p * Math.cos(phi);
  const smallest = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  const middle = 3 * q - largest - smallest;
  return [largest, middle, smallest];
}

function readComponent(value: Record<string, unknown>, key: FatigueTensorComponent, path: string): number | FatigueTensorError {
  const component = value[key];
  if (!finite(component)) return fail('fatigue-tensor-number', `${path}.${key}`);
  if (Math.abs(component) > MAX_FATIGUE_STRESS_MPA) return fail('fatigue-tensor-bound', `${path}.${key}`);
  return component === 0 ? 0 : component;
}

function readReference(value: unknown, path: string): Tensor | FatigueTensorError {
  if (!record(value) || !exactKeys(value, ['unit', 'components', ...FATIGUE_TENSOR_COMPONENT_KEYS])) {
    return fail('fatigue-tensor-shape', path);
  }
  if (value.unit !== 'MPa') return fail('fatigue-tensor-unit', `${path}.unit`);
  if (value.components !== FATIGUE_TENSOR_COMPONENTS) return fail('fatigue-tensor-convention', `${path}.components`);
  const xx = readComponent(value, 'xx', path);
  if (typeof xx !== 'number') return xx;
  const yy = readComponent(value, 'yy', path);
  if (typeof yy !== 'number') return yy;
  const zz = readComponent(value, 'zz', path);
  if (typeof zz !== 'number') return zz;
  const yz = readComponent(value, 'yz', path);
  if (typeof yz !== 'number') return yz;
  const xz = readComponent(value, 'xz', path);
  if (typeof xz !== 'number') return xz;
  const xy = readComponent(value, 'xy', path);
  if (typeof xy !== 'number') return xy;
  return [xx, yy, zz, yz, xz, xy];
}

function readFactors(value: unknown, path: string): number[] | FatigueTensorError {
  if (!dense(value)) return fail('fatigue-tensor-shape', path);
  if (value.length < 1 || value.length > MAX_FATIGUE_HISTORY_POINTS) return fail('fatigue-tensor-history', path);
  const factors: number[] = [];
  for (const [index, factor] of value.entries()) {
    if (!finite(factor)) return fail('fatigue-tensor-number', `${path}[${index}]`);
    factors.push(factor);
  }
  return factors;
}

/** Signed equivalent of one validated reference; the tensor is scaled by its largest |component| before squaring. */
function convert(reference: Tensor, historyId: string, path: string): FatigueTensorConversion | FatigueTensorError {
  const [xx, yy, zz, yz, xz, xy] = reference;
  const scale = Math.max(Math.abs(xx), Math.abs(yy), Math.abs(zz), Math.abs(yz), Math.abs(xz), Math.abs(xy));
  if (scale === 0) return fail('fatigue-tensor-zero-reference', path);
  const unit: Tensor = [xx / scale, yy / scale, zz / scale, yz / scale, xz / scale, xy / scale];
  const principal = principalStresses(unit);
  if (principal === null) return fail('fatigue-tensor-hydrostatic', path);
  const [largest, middle, smallest] = principal;
  const tie = Math.abs(Math.abs(largest) - Math.abs(smallest)) <= PRINCIPAL_TIE_TOLERANCE * Math.max(Math.abs(largest), Math.abs(smallest));
  // Not hydrostatic, so the extreme principal stresses differ and the one with the larger |value| is nonzero.
  const signed = tie ? 1 : Math.sign(Math.abs(largest) > Math.abs(smallest) ? largest : smallest);
  const vonMisesReferenceMpa = scale * vonMises(unit);
  // A defined (nonzero, non-hydrostatic) reference must never become a zero equivalent stress.
  if (!(vonMisesReferenceMpa > 0)) return fail('fatigue-tensor-underflow', path);
  return { historyId, principalStressesMpa: [scale * largest, scale * middle, scale * smallest], vonMisesReferenceMpa,
    signedEquivalentReferenceMpa: signed * vonMisesReferenceMpa, signTie: tie };
}

/** factor x equivalent for every factor; a zero factor is a legitimate zero stress, a nonzero one must stay nonzero. */
function scaledStresses(factors: readonly number[], equivalentMpa: number, path: string): number[] | FatigueTensorError {
  const stresses: number[] = [];
  for (const [index, factor] of factors.entries()) {
    const stress = factor * equivalentMpa;
    if (factor !== 0 && stress === 0) return fail('fatigue-tensor-underflow', `${path}[${index}]`);
    if (!(Math.abs(stress) <= MAX_FATIGUE_STRESS_MPA)) return fail('fatigue-tensor-bound', `${path}[${index}]`);
    stresses.push(stress === 0 ? 0 : stress);
  }
  return stresses;
}

/**
 * Converts the opt-in tensor input to the existing scalar fatigue input (unknown data in, unknown data out: the curve
 * is passed through untouched for validateFatigueInput). Fresh arrays; the caller's input is never mutated.
 */
export function proportionalTensorFatigueInput(value: unknown): FatigueTensorConversionResult {
  if (!record(value) || !exactKeys(value, ['schema', 'method', 'curve', 'histories'])) return fail('fatigue-tensor-shape', '$');
  if (value.schema !== FATIGUE_PROPORTIONAL_TENSOR_SCHEMA) return fail('fatigue-tensor-schema', 'schema');
  if (value.method !== FATIGUE_PROPORTIONAL_TENSOR_METHOD) return fail('fatigue-tensor-method', 'method');
  const rows = value.histories;
  if (!dense(rows)) return fail('fatigue-tensor-shape', 'histories');
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORIES) return fail('fatigue-tensor-history', 'histories');
  const histories: Record<string, unknown>[] = [];
  const conversions: FatigueTensorConversion[] = [];
  for (const [index, row] of rows.entries()) {
    const path = `histories[${index}]`;
    if (!record(row) || !exactKeys(row, ['id', 'reference', 'loadFactors', 'sequence', 'repeats', 'source'])) {
      return fail('fatigue-tensor-shape', path);
    }
    const reference = readReference(row.reference, `${path}.reference`);
    if ('ok' in reference) return reference;
    const factors = readFactors(row.loadFactors, `${path}.loadFactors`);
    if ('ok' in factors) return factors;
    const conversion = convert(reference, typeof row.id === 'string' ? row.id : '', `${path}.reference`);
    if ('ok' in conversion) return conversion;
    const stressMpa = scaledStresses(factors, conversion.signedEquivalentReferenceMpa, `${path}.loadFactors`);
    if ('ok' in stressMpa) return stressMpa;
    conversions.push(conversion);
    // id, sequence, repeats and source keep their keys, so the scalar reader reports their exact paths.
    histories.push({ id: row.id, unit: 'MPa', stressMpa, sequence: row.sequence, repeats: row.repeats, source: row.source });
  }
  return { ok: true, input: { schema: FATIGUE_INPUT_SCHEMA, curve: value.curve, histories }, conversions };
}

/** Validates the converted input with the existing scalar reader (exact codes and paths), for callers that need it. */
export function validateProportionalTensorFatigueInput(value: unknown): FatigueValidation | FatigueTensorError {
  const converted = proportionalTensorFatigueInput(value);
  return converted.ok ? validateFatigueInput(converted.input) : converted;
}

/** Converts, then runs the existing scalar rainflow/Miner analysis on the signed equivalent histories. */
export function analyzeProportionalTensorFatigue(value: unknown): FatigueTensorAnalysis {
  const converted = proportionalTensorFatigueInput(value);
  if (!converted.ok) return converted;
  const analysis = analyzeFatigue(converted.input);
  if (!analysis.ok) return analysis;
  return { ok: true, result: analysis.result, method: FATIGUE_PROPORTIONAL_TENSOR_METHOD, conversions: converted.conversions };
}
