import { isFiniteNumber } from './valueGuards.js';

import type { Vector3 } from './analysisModel.js';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';

type Solver = 'newton' | 'nsgs';
export interface FrictionSolveOptions { readonly solver: Solver; readonly iterationLimit: number }
export interface FrictionNodeResult {
  readonly number: number;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
}
export interface FrictionContactState {
  readonly id: string;
  readonly state: 'open' | 'closed' | 'stick' | 'slip';
  readonly frictionCoefficient: number;
  readonly normalReactionN: number;
  readonly gapM: number;
  readonly frictionForceN: Vector3;
  readonly slipIncrementM: Vector3;
  readonly accumulatedSlipM: Vector3;
  readonly slipPathLengthM: number;
  readonly dissipatedWorkJ: number;
}
export interface FrictionStepResult {
  readonly step: number;
  readonly iterations: number;
  readonly nodes: readonly FrictionNodeResult[];
  readonly contacts: readonly FrictionContactState[];
  /** Aggregate reporting values only; never a local physical acceptance scale. */
  readonly forceScaleN: number;
  readonly gapScaleM: number;
  /** Dimensionless values independently checked by the Python core against its own local scales.
   * This reader checks their reported bounds; it does not independently solve equilibrium. */
  readonly equilibriumResidual: number;
  readonly penetration: number;
  readonly tension: number;
  readonly complementarity: number;
  readonly frictionConeExcess: number;
  readonly slipLawResidual: number;
}
export interface FrictionContactResult {
  readonly kind: 'pointercad-internal-friction-contact-candidate';
  readonly solver: Solver;
  readonly iterationLimit: number;
  readonly freeDofs: number;
  readonly states: readonly FrictionStepResult[];
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: BeamFrictionContactInput['geometry']['source'];
  readonly inputSha256: string;
  readonly nodeIds: readonly string[];
  readonly input: BeamFrictionContactInput;
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== fields.length) throw new Error('friction-result: object fields');
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !d.enumerable || !('value' in d)) throw new Error('friction-result: object fields');
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, size: number): unknown[] {
  if (!Array.isArray(value) || value.length !== size || Reflect.ownKeys(value).length !== size + 1) {
    throw new Error('friction-result: array size');
  }
  for (let i = 0; i < size; i += 1) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (d === undefined || !('value' in d)) throw new Error('friction-result: sparse array');
  }
  return value;
}
function finite(value: unknown): number {
  if (!isFiniteNumber(value)) throw new Error('friction-result: finite number');
  return value;
}
function integer(value: unknown, min: number): number {
  const n = finite(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error('friction-result: integer');
  return n;
}
function vector(value: unknown): Vector3 {
  const a = array(value, 3);
  return [finite(a[0]), finite(a[1]), finite(a[2])];
}
/** Floating-point roundoff only, with no dimensionful physical threshold. */
function equalArithmetic(actual: number, expected: number, scale: number): boolean {
  return Math.abs(actual - expected) <= 64 * Number.EPSILON * scale;
}
const residualKeys = ['equilibriumResidual', 'penetration', 'tension', 'complementarity',
  'frictionConeExcess', 'slipLawResidual'] as const;
const contactKeys = ['id', 'state', 'frictionCoefficient', 'normalReactionN', 'gapM', 'frictionForceN',
  'slipIncrementM', 'accumulatedSlipM', 'slipPathLengthM', 'dissipatedWorkJ'] as const;

/** Structural reader and input binding only, not a structural-safety or independent physics certification. */
export function decodeFrictionContact(raw: unknown, input: unknown, inputSha256: string,
  options: FrictionSolveOptions): FrictionContactResult {
  if (!/^[0-9a-f]{64}$/u.test(inputSha256)) throw new Error('friction-result: digest');
  const opt = object(options, ['solver', 'iterationLimit']);
  if (opt.solver !== 'newton' && opt.solver !== 'nsgs') throw new Error('friction-result: solver');
  const iterationLimit = integer(opt.iterationLimit, 1);
  const translated = translateBeamFrictionContact(input);
  const plan = translated.plan;
  const root = object(raw, ['kind', 'solver', 'iterationLimit', 'freeDofs', 'states']);
  if (root.kind !== 'pointercad-internal-friction-contact-candidate' || root.solver !== opt.solver
    || root.iterationLimit !== iterationLimit) throw new Error('friction-result: solver identity');
  const freeDofs = plan.nodes.reduce((sum, node) => sum + node.restrained.filter(fixed => !fixed).length, 0);
  if (root.freeDofs !== freeDofs) throw new Error('friction-result: free DOFs');
  const prior = plan.contacts.map(() => ({ accumulated: [0, 0, 0] as Vector3, path: 0, work: 0 }));
  const states = array(root.states, translated.loads.length).map((value, step): FrictionStepResult => {
    const row = object(value, ['step', 'iterations', 'nodes', 'contacts', 'forceScaleN', 'gapScaleM', ...residualKeys]);
    if (row.step !== step) throw new Error('friction-result: step order');
    const iterations = integer(row.iterations, 0);
    if (iterations > iterationLimit) throw new Error('friction-result: iteration limit');
    const forceScaleN = finite(row.forceScaleN), gapScaleM = finite(row.gapScaleM);
    if (forceScaleN <= 0 || gapScaleM <= 0) throw new Error('friction-result: reporting scales');
    const residuals = residualKeys.map(key => {
      const n = finite(row[key]);
      if (n < 0 || n > 1e-9) throw new Error('friction-result: reported residual');
      return n;
    });
    const nodes = array(row.nodes, plan.originalNodeCount).map((value, index): FrictionNodeResult => {
      const n = object(value, ['number', 'displacementM', 'rotationRad']);
      const displacementM = vector(n.displacementM), rotationRad = vector(n.rotationRad);
      if (n.number !== plan.nodes[index].number
        || plan.nodes[index].restrained.some((fixed, axis) => fixed && [...displacementM, ...rotationRad][axis] !== 0)) {
        throw new Error('friction-result: node order or support');
      }
      return { number: plan.nodes[index].number, displacementM, rotationRad };
    });
    const contacts = array(row.contacts, plan.contacts.length).map((value, index): FrictionContactState => {
      const c = object(value, contactKeys), expected = plan.contacts[index];
      if (c.id !== expected.id || c.frictionCoefficient !== translated.friction[expected.id]
        || (c.state !== 'open' && c.state !== 'closed' && c.state !== 'stick' && c.state !== 'slip')) {
        throw new Error('friction-result: contact identity');
      }
      if ((translated.friction[expected.id] === 0 && (c.state === 'stick' || c.state === 'slip'))
        || (translated.friction[expected.id] > 0 && c.state === 'closed')) {
        throw new Error('friction-result: state incompatible with coefficient');
      }
      const normalReactionN = finite(c.normalReactionN), gapM = finite(c.gapM);
      const frictionForceN = vector(c.frictionForceN), slipIncrementM = vector(c.slipIncrementM);
      const accumulatedSlipM = vector(c.accumulatedSlipM), slipPathLengthM = finite(c.slipPathLengthM);
      const dissipatedWorkJ = finite(c.dissipatedWorkJ), previous = prior[index];
      const increment = c.state === 'open' ? [0, 0, 0] : slipIncrementM;
      for (let axis = 0; axis < 3; axis += 1) {
        const expectedValue = previous.accumulated[axis] + increment[axis];
        if (!equalArithmetic(accumulatedSlipM[axis], expectedValue,
          Math.abs(previous.accumulated[axis]) + Math.abs(increment[axis]))) throw new Error('friction-result: accumulated slip');
      }
      const length = Math.hypot(...increment), expectedPath = previous.path + length;
      if (!Number.isFinite(expectedPath) || !equalArithmetic(slipPathLengthM, expectedPath,
        Math.abs(previous.path) + length)) throw new Error('friction-result: slip path');
      const terms = frictionForceN.map((f, axis) => f * slipIncrementM[axis]);
      const expectedWork = previous.work - terms.reduce((sum, x) => sum + x, 0);
      if (!Number.isFinite(expectedWork) || !equalArithmetic(dissipatedWorkJ, expectedWork,
        Math.abs(previous.work) + terms.reduce((sum, x) => sum + Math.abs(x), 0))) {
        throw new Error('friction-result: work history');
      }
      prior[index] = { accumulated: accumulatedSlipM, path: slipPathLengthM, work: dissipatedWorkJ };
      return { id: expected.id, state: c.state, frictionCoefficient: translated.friction[expected.id],
        normalReactionN, gapM, frictionForceN, slipIncrementM, accumulatedSlipM, slipPathLengthM, dissipatedWorkJ };
    });
    return { step, iterations, nodes, contacts, forceScaleN, gapScaleM,
      equilibriumResidual: residuals[0], penetration: residuals[1], tension: residuals[2],
      complementarity: residuals[3], frictionConeExcess: residuals[4], slipLawResidual: residuals[5] };
  });
  return { kind: 'pointercad-internal-friction-contact-candidate', solver: opt.solver, iterationLimit, freeDofs,
    states, analysisId: translated.input.geometry.id, analysisRevision: translated.input.geometry.revision,
    source: translated.input.geometry.source, inputSha256, nodeIds: [...translated.nodeIds], input: translated.input };
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length
      || Reflect.ownKeys(a).length !== a.length + 1 || Reflect.ownKeys(b).length !== b.length + 1) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = Object.getOwnPropertyDescriptor(a, String(i));
      const right = Object.getOwnPropertyDescriptor(b, String(i));
      if (left === undefined || right === undefined || !('value' in left) || !('value' in right)
        || !same(left.value, right.value)) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = Reflect.ownKeys(a);
    return keys.length === Reflect.ownKeys(b).length && keys.every(key => {
      if (typeof key !== 'string') return false;
      const left = Object.getOwnPropertyDescriptor(a, key), right = Object.getOwnPropertyDescriptor(b, key);
      return left !== undefined && right !== undefined && left.enumerable && right.enumerable
        && 'value' in left && 'value' in right && same(left.value, right.value);
    });
  }
  return a === b;
}
/** False for malformed, stale, foreign, or mutated values. */
export function frictionContactResultMatches(value: unknown, input: unknown, hash: string,
  options: FrictionSolveOptions): value is FrictionContactResult {
  try {
    const v = object(value, ['kind', 'solver', 'iterationLimit', 'freeDofs', 'states',
      'analysisId', 'analysisRevision', 'source', 'inputSha256', 'nodeIds', 'input']);
    const decoded = decodeFrictionContact({ kind: v.kind, solver: v.solver, iterationLimit: v.iterationLimit,
      freeDofs: v.freeDofs, states: v.states }, input, hash, options);
    return same(v, decoded);
  } catch { return false; }
}
