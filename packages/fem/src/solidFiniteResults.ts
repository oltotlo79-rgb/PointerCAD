import { isRecord } from './protocol.js';
import {
  SOLID_FINITE_DOFS, SOLID_FINITE_FREE_RESIDUAL_BOUND, SOLID_FINITE_METHOD, SOLID_FINITE_RESULT_SCHEMA,
  SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT, SOLID_FINITE_SCOPE, SOLID_FINITE_UNITS, type SolidFinitePlan,
} from './solidFinitePlan.js';
import { solidFiniteInputSha256, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';

/**
 * Strict decoder of run_finite_equilibrium's JSON (solidFiniteEquilibrium.py result() with the records of advance()).
 * Every field and shape is the Python one; nothing missing is inferred. Conventions kept apart:
 *   native.F9 / native.S6: the native deformation gradient F and second Piola-Kirchhoff stress S of the element's single
 *     integration point in OOFEM order (F9 [11, 22, 33, 23, 13, 12, 32, 31, 21], S6 [11, 22, 33, 23, 13, 12]);
 *   J = det F, P = F S (first Piola-Kirchhoff), tau = P F^T (Kirchhoff), sigma = tau / J (Cauchy), row-major 3 x 3,
 *     formed by the entry from the native F and S with exactly these expressions, so they are recomputed and compared.
 * Accepted records are the converged steps of a complete run: the count equals the plan steps (a partial list is
 * refused), steps are 1..n with strictly increasing positive time, the native displacements reproduce the prescribed
 * history (relative 1e-12), the native external forces equal the planned dead loads (relative 1e-12) and are exactly 0
 * elsewhere, and the free-DOF residual and force scale equal the entry's free_force_balance of the recorded forces with
 * its running accepted reference (<= 1e-8). A refused commit raises in the entry, so a successful result has none.
 * The result is bound to the validated input copy and its SHA-256; input changes after hashing are refused.
 * The raw reply has no source or input digest. The caller must preserve request/reply ownership; these checks
 * establish consistency with the supplied input, not the origin of the reply.
 * Internal scope only (structuralCertification false); no product, protocol or certification claim.
 */
type Matrix = readonly number[];
export interface SolidFiniteNativeState {
  readonly F9: Matrix;
  readonly S6: Matrix;
}
export interface SolidFiniteElementRecord {
  readonly J: number;
  readonly tau: Matrix;
  readonly P: Matrix;
  readonly sigma: Matrix;
  readonly alpha: number;
  readonly plastic: boolean;
  readonly dissipation: number;
  readonly q: number;
  readonly native: SolidFiniteNativeState;
}
export interface SolidFiniteStepRecord {
  readonly step: number;
  readonly time: number;
  readonly freeResidualRatio: number;
  readonly forceScaleN: number;
  readonly displacementMm: readonly Matrix[];
  readonly internalN: readonly Matrix[];
  readonly externalN: readonly Matrix[];
  readonly elements: readonly SolidFiniteElementRecord[];
}
export interface SolidFiniteResult {
  readonly input: SolidFiniteInput;
  readonly inputSha256: string;
  readonly schema: typeof SOLID_FINITE_RESULT_SCHEMA;
  readonly method: typeof SOLID_FINITE_METHOD;
  readonly units: typeof SOLID_FINITE_UNITS;
  readonly scope: typeof SOLID_FINITE_SCOPE;
  readonly structuralCertification: false;
  readonly freeResidualBound: typeof SOLID_FINITE_FREE_RESIDUAL_BOUND;
  readonly records: readonly SolidFiniteStepRecord[];
  /** Always empty: commit_accepted raises on a refusal, which ends the run without a result. */
  readonly refusedCommits: readonly never[];
  readonly retainedNativeAnalyses: number;
  readonly runtimeAnalysisLimit: typeof SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT;
}

const RESULT_FIELDS = ['schema', 'method', 'units', 'scope', 'structuralCertification', 'freeResidualBound', 'records',
  'refusedCommits', 'retainedNativeAnalyses', 'runtimeAnalysisLimit'];
const RECORD_FIELDS = ['step', 'time', 'freeResidualRatio', 'forceScaleN', 'displacementMm', 'internalN', 'externalN', 'elements'];
const ELEMENT_FIELDS = ['J', 'tau', 'P', 'sigma', 'alpha', 'plastic', 'dissipation', 'q', 'native'];
/** Row-major 3 x 3 index of each OOFEM 9-component position (solidFiniteMaterial.OOFEM9). */
const OOFEM9 = [0, 4, 8, 5, 2, 1, 7, 6, 3];
/** OOFEM 6-component order [11, 22, 33, 23, 13, 12] (solidFiniteMaterial.VOIGT6). */
const VOIGT6: readonly (readonly [number, number])[] = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]];

function fail(detail: string): never {
  throw new Error(`finite-equilibrium-result: ${detail}`);
}
function exactFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const row = value;
  const keys = Reflect.ownKeys(row);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    fail(`${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}
function vector(value: unknown, size: number, path: string): Matrix {
  if (!Array.isArray(value) || value.length !== size) fail(`${path} must have ${String(size)} entries`);
  const items: unknown[] = value;
  return Object.freeze(Array.from({ length: size }, (_, index) => finite(items[index], `${path}[${String(index)}]`)));
}
function rows(value: unknown, count: number, path: string): readonly Matrix[] {
  if (!Array.isArray(value) || value.length !== count) fail(`${path} must have one entry per node (${String(count)})`);
  const items: unknown[] = value;
  return Object.freeze(Array.from({ length: count }, (_, index) => vector(items[index], 3, `${path}[${String(index)}]`)));
}
/** The entry's mm: row-major product with the same term order. */
function mm(a: Matrix, b: Matrix): number[] {
  return [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]));
}
const mt = (a: Matrix): number[] => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const det = (a: Matrix): number => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6])
  + a[2] * (a[3] * a[7] - a[4] * a[6]);
function same(actual: Matrix, expected: Matrix, path: string): void {
  if (actual.some((value, index) => value !== expected[index])) fail(`${path} differs from the value formed from the native F and S`);
}

/** Repeat W34's displacement-derived orientation check, independently of the reported native F/J. */
function checkDisplacementOrientation(plan: SolidFinitePlan, displacement: readonly Matrix[], path: string): void {
  plan.elements.forEach((element, index) => {
    const [a, b, c, d] = element.map(node => plan.nodes[node]);
    const j = [0, 1, 2].flatMap(axis => [b[axis] - a[axis], c[axis] - a[axis], d[axis] - a[axis]]);
    const determinant = det(j);
    // Rows of the inverse reference Jacobian: exactly the arithmetic of shape_gradients in the Python entry.
    const inverse = [j[4] * j[8] - j[5] * j[7], j[2] * j[7] - j[1] * j[8], j[1] * j[5] - j[2] * j[4],
      j[5] * j[6] - j[3] * j[8], j[0] * j[8] - j[2] * j[6], j[2] * j[3] - j[0] * j[5],
      j[3] * j[7] - j[4] * j[6], j[1] * j[6] - j[0] * j[7], j[0] * j[4] - j[1] * j[3]].map(v => v / determinant);
    const gradients = [[0, 1, 2].map(axis => -inverse[axis] - inverse[3 + axis] - inverse[6 + axis]),
      inverse.slice(0, 3), inverse.slice(3, 6), inverse.slice(6, 9)];
    const f = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    element.forEach((node, local) => {
      for (let i = 0; i < 3; i += 1) {
        for (let k = 0; k < 3; k += 1) f[3 * i + k] += displacement[node][i] * gradients[local][k];
      }
    });
    const jacobian = det(f);
    if (!Number.isFinite(jacobian) || !(jacobian > 0)) {
      fail(`${path}.displacementMm inverts or collapses element ${String(index)} (det F = ${String(jacobian)})`);
    }
  });
}

function readElement(value: unknown, path: string, previous: SolidFiniteElementRecord | undefined): SolidFiniteElementRecord {
  const row = exactFields(value, ELEMENT_FIELDS, path);
  const nativeRow = exactFields(row.native, ['F9', 'S6'], `${path}.native`);
  const native: SolidFiniteNativeState = Object.freeze({ F9: vector(nativeRow.F9, 9, `${path}.native.F9`),
    S6: vector(nativeRow.S6, 6, `${path}.native.S6`) });
  const f = Array.from({ length: 9 }, () => 0);
  OOFEM9.forEach((index, k) => { f[index] = native.F9[k]; });
  const s = Array.from({ length: 9 }, () => 0);
  VOIGT6.forEach(([i, j], k) => { s[3 * i + j] = native.S6[k]; s[3 * j + i] = native.S6[k]; });
  const J = finite(row.J, `${path}.J`);
  if (!(J > 0)) fail(`${path}.J must be positive (det F > 0)`);
  if (J !== det(f)) fail(`${path}.J differs from det F of the native F`);
  const P = vector(row.P, 9, `${path}.P`), tau = vector(row.tau, 9, `${path}.tau`), sigma = vector(row.sigma, 9, `${path}.sigma`);
  const formedP = mm(f, s), formedTau = mm(formedP, mt(f));
  same(P, formedP, `${path}.P`);
  same(tau, formedTau, `${path}.tau`);
  same(sigma, formedTau.map(v => v / J), `${path}.sigma`);
  const alpha = finite(row.alpha, `${path}.alpha`), dissipation = finite(row.dissipation, `${path}.dissipation`);
  const q = finite(row.q, `${path}.q`), plastic = row.plastic;
  if (typeof plastic !== 'boolean') fail(`${path}.plastic must be a boolean`);
  if (!(q >= 0)) fail(`${path}.q must not be negative`);
  // alpha_{n+1} = alpha_n + dgamma with dgamma >= 0; an elastic step (dgamma = 0) keeps alpha and has zero dissipation.
  const before = previous?.alpha ?? 0;
  if (!(alpha >= before)) fail(`${path}.alpha must not decrease (${String(before)} -> ${String(alpha)})`);
  if (!plastic && (alpha !== before || dissipation !== 0)) fail(`${path} is elastic but changes alpha or dissipates`);
  return Object.freeze({ J, tau, P, sigma, alpha, plastic, dissipation, q, native });
}

interface Balance { readonly residual: number; readonly scale: number; readonly reference: number }
/** free_force_balance of solidFiniteEquilibrium.py over the recorded forces (same terms; max is order independent). */
function freeForceBalance(internal: readonly Matrix[], external: readonly Matrix[], prescribed: ReadonlySet<number>,
  accepted: number): Balance {
  let scale = Math.max(1e-300, accepted), residual = 0, reference = accepted;
  internal.forEach((row, node) => row.forEach((value, axis) => {
    scale = Math.max(scale, Math.abs(value), Math.abs(external[node][axis]));
  }));
  internal.forEach((row, node) => row.forEach((value, axis) => {
    const key = node * 3 + axis;
    if (!prescribed.has(key)) residual = Math.max(residual, Math.abs(external[node][axis] - value) / scale);
    reference = Math.max(reference, Math.abs(external[node][axis]), prescribed.has(key) ? Math.abs(value) : 0);
  }));
  return { residual, scale, reference };
}

function readRecords(value: unknown, plan: SolidFinitePlan): readonly SolidFiniteStepRecord[] {
  if (!Array.isArray(value) || value.length !== plan.steps) fail(`records must hold all ${String(plan.steps)} accepted steps`);
  const items: unknown[] = value;
  const prescribed = new Map(plan.prescribedMm.map(entry => [entry.node * 3 + SOLID_FINITE_DOFS.indexOf(entry.dof), entry.valuesMm]));
  const loads = new Map(plan.forcesN.map(entry => [entry.node * 3 + SOLID_FINITE_DOFS.indexOf(entry.dof), entry.valuesN]));
  const prescribedKeys = new Set(prescribed.keys());
  const records: SolidFiniteStepRecord[] = [];
  let accepted = 0, time = 0;
  for (let index = 0; index < plan.steps; index += 1) {
    const path = `records[${String(index)}]`;
    const row = exactFields(items[index], RECORD_FIELDS, path);
    if (row.step !== index + 1) fail(`${path}.step must be ${String(index + 1)}`);
    const recordTime = finite(row.time, `${path}.time`);
    if (!(recordTime > time)) fail(`${path}.time must increase (${String(time)} -> ${String(recordTime)})`);
    time = recordTime;
    const displacementMm = rows(row.displacementMm, plan.nodes.length, `${path}.displacementMm`);
    const internalN = rows(row.internalN, plan.nodes.length, `${path}.internalN`);
    const externalN = rows(row.externalN, plan.nodes.length, `${path}.externalN`);
    for (const [key, values] of prescribed) {
      const planned = values[index], actual = displacementMm[Math.floor(key / 3)][key % 3];
      if (!(Math.abs(actual - planned) <= 1e-12 * Math.max(1, Math.abs(planned)))) {
        fail(`${path}.displacementMm does not reproduce the prescribed node ${String(Math.floor(key / 3))} direction ${SOLID_FINITE_DOFS[key % 3]}`);
      }
    }
    externalN.forEach((force, node) => force.forEach((actual, axis) => {
      const planned = loads.get(node * 3 + axis)?.[index] ?? 0;
      const matches = loads.has(node * 3 + axis) ? Math.abs(actual - planned) <= 1e-12 * Math.max(1, Math.abs(planned)) : actual === 0;
      if (!matches) fail(`${path}.externalN of node ${String(node)} direction ${SOLID_FINITE_DOFS[axis]} is not the planned dead load`);
    }));
    checkDisplacementOrientation(plan, displacementMm, path);
    const balance = freeForceBalance(internalN, externalN, prescribedKeys, accepted);
    const freeResidualRatio = finite(row.freeResidualRatio, `${path}.freeResidualRatio`);
    const forceScaleN = finite(row.forceScaleN, `${path}.forceScaleN`);
    if (!(freeResidualRatio >= 0 && freeResidualRatio <= SOLID_FINITE_FREE_RESIDUAL_BOUND)) {
      fail(`${path}.freeResidualRatio must be within ${String(SOLID_FINITE_FREE_RESIDUAL_BOUND)}`);
    }
    if (freeResidualRatio !== balance.residual || forceScaleN !== balance.scale) {
      fail(`${path} free-DOF residual or force scale differs from the recorded internal and external forces`);
    }
    accepted = balance.reference;
    if (!Array.isArray(row.elements) || row.elements.length !== plan.elements.length) {
      fail(`${path}.elements must have one entry per element (${String(plan.elements.length)})`);
    }
    const elementItems: unknown[] = row.elements;
    const before = records.at(-1)?.elements;
    const elements = Object.freeze(Array.from({ length: plan.elements.length },
      (_, e) => readElement(elementItems[e], `${path}.elements[${String(e)}]`, before?.[e])));
    records.push(Object.freeze({ step: index + 1, time: recordTime, freeResidualRatio, forceScaleN, displacementMm, internalN,
      externalN, elements }));
  }
  return Object.freeze(records);
}

function readNative(raw: unknown, plan: SolidFinitePlan): Omit<SolidFiniteResult, 'input' | 'inputSha256'> {
  const row = exactFields(raw, RESULT_FIELDS, 'result');
  if (row.schema !== SOLID_FINITE_RESULT_SCHEMA) fail('unsupported result schema');
  if (row.method !== SOLID_FINITE_METHOD) fail('unexpected method');
  if (row.units !== SOLID_FINITE_UNITS) fail('units must be N-mm-MPa');
  if (row.scope !== SOLID_FINITE_SCOPE) fail('unexpected scope');
  if (row.structuralCertification !== false) fail('structuralCertification must be false');
  if (row.freeResidualBound !== SOLID_FINITE_FREE_RESIDUAL_BOUND) fail('unexpected free residual bound');
  if (row.runtimeAnalysisLimit !== SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT) fail('unexpected runtime analysis limit');
  const retained = row.retainedNativeAnalyses;
  if (typeof retained !== 'number' || !Number.isInteger(retained) || retained < 1 || retained > SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT) {
    fail(`retainedNativeAnalyses must be an integer from 1 to ${String(SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT)}`);
  }
  if (!Array.isArray(row.refusedCommits) || row.refusedCommits.length !== 0) fail('a completed run has no refused commit');
  const records = readRecords(row.records, plan);
  return { schema: SOLID_FINITE_RESULT_SCHEMA, method: SOLID_FINITE_METHOD, units: SOLID_FINITE_UNITS, scope: SOLID_FINITE_SCOPE,
    structuralCertification: false, freeResidualBound: SOLID_FINITE_FREE_RESIDUAL_BOUND, records,
    refusedCommits: Object.freeze([]), retainedNativeAnalyses: retained,
    runtimeAnalysisLimit: SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT };
}

/**
 * Decodes one reply for the validated copy of `value`. `inputSha256` must be the digest computed when the request was
 * prepared; it is recomputed from the copy here, so an input changed after hashing is refused. The raw Python result
 * contains no source or input digest: this function validates its consistency with the supplied input, not its origin.
 * The caller must preserve request/reply ownership (the runtime entry supplies the reply from its own synchronous call).
 */
export async function decodeSolidFinite(raw: unknown, value: SolidFiniteInput, inputSha256: string): Promise<SolidFiniteResult> {
  if (!/^[0-9a-f]{64}$/u.test(inputSha256)) fail('invalid input digest');
  const input = translateSolidFinite(value).input;
  if (await solidFiniteInputSha256(input) !== inputSha256) fail('the input digest does not match the input (stale or mutated)');
  return Object.freeze({ input, inputSha256, ...readNative(raw, input.plan) });
}

/** A decoded result still belongs to `value` (same validated document revision and plan) and its digest. */
export function solidFiniteResultMatches(result: SolidFiniteResult, value: unknown, inputSha256: string): boolean {
  try {
    return result.inputSha256 === inputSha256
      && JSON.stringify(translateSolidFinite(result.input).input) === JSON.stringify(translateSolidFinite(value).input);
  } catch {
    return false;
  }
}
