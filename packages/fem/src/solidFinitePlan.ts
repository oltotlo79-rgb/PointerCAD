import { createPrefixedError, createFiniteReader, isRecord } from './valueGuards.js';

/**
 * Typed TS reader of the internal finite-strain J2 equilibrium plan of solidFiniteEquilibrium.py (EX-09 W34; internal,
 * no protocol kind, dispatch or UI yet). Its acceptance is the current Python read_plan with the W33 read_parameters of
 * solidFiniteMaterial.py, which validates the same JSON again natively:
 *   4..2000 nodes of 3 finite coordinates, 1..5000 tet4 elements of 4 distinct valid node indices whose
 *   6 V = det(x1 - x0, x2 - x0, x3 - x0) is finite and > 1e-12 x (longest edge)^3, every node used, 1..200 steps,
 *   steps x (nodes + elements) <= 20000 recorded states, per-DOF histories of exactly `steps` finite values with a DOF
 *   prescribed and/or loaded, once per list, at least one prescribed and one free DOF, and referenceForceN (positive) unless a
 *   free-DOF nodal force is nonzero (then its largest |force| is the native force scale).
 * Units N-mm-MPa; time t = step number, time 0 is the undeformed unloaded state; nodal forces are dead loads in the
 * global axes. This is separate from the small-strain path (solidPlastic.ts, MAXIMUM_STRAIN 0.05), which is unchanged.
 */
export const SOLID_FINITE_PLAN_SCHEMA = 'pointercad-finite-j2-equilibrium-plan/1';
export const SOLID_FINITE_RESULT_SCHEMA = 'pointercad-finite-j2-equilibrium/1';
export const SOLID_FINITE_METHOD = 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1';
export const SOLID_FINITE_UNITS = 'N-mm-MPa';
export const SOLID_FINITE_SCOPE = 'finite-strain-j2-linear-isotropic-hardening-tet4-internal';
/** FREE_RESIDUAL_BOUND of solidFiniteEquilibrium.py: accepted free-DOF |external - internal| over the force scale. */
export const SOLID_FINITE_FREE_RESIDUAL_BOUND = 1e-8;
/** MAX_RETAINED_NATIVE_ANALYSES: native analyses one Python runtime may retain (no native destruction exists). */
export const SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT = 8;
export const SOLID_FINITE_LIMITS = { nodes: 2000, elements: 5000, steps: 200, recordedStates: 20000 } as const;
/** MINIMUM_RELATIVE_VOLUME: a tetrahedron with 6 V <= this x (longest edge)^3 is collapsed or inverted. */
export const SOLID_FINITE_MINIMUM_RELATIVE_VOLUME = 1e-12;
export const SOLID_FINITE_DOFS = ['x', 'y', 'z'] as const;
export type SolidFiniteDof = typeof SOLID_FINITE_DOFS[number];

export interface SolidFiniteMaterial {
  readonly youngMPa: number;
  readonly poisson: number;
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
}
export interface SolidFinitePrescribed { readonly node: number; readonly dof: SolidFiniteDof; readonly valuesMm: readonly number[] }
export interface SolidFiniteLoad { readonly node: number; readonly dof: SolidFiniteDof; readonly valuesN: readonly number[] }
export interface SolidFinitePlan {
  readonly schema: typeof SOLID_FINITE_PLAN_SCHEMA;
  readonly units: typeof SOLID_FINITE_UNITS;
  readonly nodes: readonly (readonly [number, number, number])[];
  readonly elements: readonly (readonly [number, number, number, number])[];
  readonly material: SolidFiniteMaterial;
  readonly steps: number;
  readonly prescribedMm: readonly SolidFinitePrescribed[];
  readonly forcesN: readonly SolidFiniteLoad[];
  readonly referenceForceN?: number;
}

const PLAN_FIELDS = ['schema', 'units', 'nodes', 'elements', 'material', 'steps', 'prescribedMm', 'forcesN'] as const;
const MATERIAL_FIELDS = ['youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa'] as const;

const fail: (message: string) => never = createPrefixedError('finite-equilibrium-plan');
/** Exactly the required own string keys plus the listed optional ones; no symbol, inherited or extra field. */
function fields(value: unknown, required: readonly string[], optional: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const row = value;
  const keys = Reflect.ownKeys(row);
  const allowed = keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
  if (!allowed || required.some(name => !Object.hasOwn(row, name))) {
    fail(`${path} must have the fields ${required.join(', ')} (optional: ${optional.join(', ') || 'none'})`);
  }
  return row;
}
const finite = createFiniteReader(fail);
function integer(value: unknown, path: string, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    fail(`${path} must be an integer from ${String(low)} to ${String(high)}`);
  }
  return value === 0 ? 0 : value;
}
function array(value: unknown, path: string, low: number, high: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < low || value.length > high) {
    fail(`${path} must have ${String(low)} to ${String(high)} entries`);
  }
  const items: unknown[] = value;
  return Array.from({ length: items.length }, (_, index) => items[index]);
}

/** 6 x signed volume det(b - a, c - a, d - a), the same expression and order as solidFiniteEquilibrium.signed_volume6. */
export function signedVolume6(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0])
    + u[2] * (v[0] * w[1] - v[1] * w[0]);
}

/** W33 read_parameters: exactly four finite numbers, youngMPa > 0, 0 <= poisson < 0.5, yieldStressMPa > 0, H >= 0. */
function readMaterial(value: unknown): SolidFiniteMaterial {
  const row = fields(value, MATERIAL_FIELDS, [], 'material');
  const [youngMPa, poisson, yieldStressMPa, hardeningModulusMPa] = MATERIAL_FIELDS.map(key => finite(row[key], `material.${key}`));
  if (!(youngMPa > 0)) fail('material.youngMPa must be positive');
  if (!(poisson >= 0 && poisson < 0.5)) fail('material.poisson must be in [0, 0.5)');
  if (!(yieldStressMPa > 0)) fail('material.yieldStressMPa must be positive');
  if (!(hardeningModulusMPa >= 0)) fail('material.hardeningModulusMPa must not be negative (softening is not supported)');
  return Object.freeze({ youngMPa, poisson, yieldStressMPa, hardeningModulusMPa });
}

interface History { readonly node: number; readonly dof: SolidFiniteDof; readonly values: readonly number[] }
/** One DOF history list; `used` holds node * 3 + direction of every DOF already in this list. */
function readHistories(value: unknown, name: 'prescribedMm' | 'forcesN', unit: 'valuesMm' | 'valuesN', nodeCount: number,
  steps: number, used: Set<number>): readonly History[] {
  return array(value, name, 0, nodeCount * 3).map((item, index) => {
    const path = `${name}[${String(index)}]`;
    const entry = fields(item, ['node', 'dof', unit], [], path);
    const node = integer(entry.node, `${path}.node`, 0, nodeCount - 1);
    const dof = SOLID_FINITE_DOFS.find(candidate => candidate === entry.dof);
    if (dof === undefined) fail(`${path}.dof must be x, y or z`);
    const key = node * 3 + SOLID_FINITE_DOFS.indexOf(dof);
    if (used.has(key)) fail(`${path} repeats node ${String(node)} direction ${dof} (a DOF appears at most once per list)`);
    used.add(key);
    const values = Object.freeze(array(entry[unit], `${path}.${unit}`, steps, steps)
      .map((number, k) => finite(number, `${path}.${unit}[${String(k)}]`)));
    return { node, dof, values };
  });
}

/** Validated, deep-frozen copy of a finite equilibrium plan (the same acceptance as solidFiniteEquilibrium.read_plan). */
export function readSolidFinitePlan(value: unknown): SolidFinitePlan {
  const row = fields(value, PLAN_FIELDS, ['referenceForceN'], 'plan');
  if (row.schema !== SOLID_FINITE_PLAN_SCHEMA) fail('unsupported plan schema');
  if (row.units !== SOLID_FINITE_UNITS) fail('units must be N-mm-MPa');
  const nodes = Object.freeze(array(row.nodes, 'nodes', 4, SOLID_FINITE_LIMITS.nodes).map((point, index) => {
    const xyz = array(point, `nodes[${String(index)}]`, 3, 3);
    const copy: readonly [number, number, number] = [finite(xyz[0], `nodes[${String(index)}][0]`),
      finite(xyz[1], `nodes[${String(index)}][1]`), finite(xyz[2], `nodes[${String(index)}][2]`)];
    return Object.freeze(copy);
  }));
  const used = new Set<number>();
  const elements = Object.freeze(array(row.elements, 'elements', 1, SOLID_FINITE_LIMITS.elements).map((element, index) => {
    const ids = array(element, `elements[${String(index)}]`, 4, 4)
      .map((item, local) => integer(item, `elements[${String(index)}][${String(local)}]`, 0, nodes.length - 1));
    if (new Set(ids).size !== 4) fail(`elements[${String(index)}] must use four distinct nodes`);
    const [a, b, c, d] = ids.map(id => nodes[id]);
    const volume6 = signedVolume6(a, b, c, d);
    const edge = Math.max(...[[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]]
      .map(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
    if (!Number.isFinite(volume6) || !(volume6 > SOLID_FINITE_MINIMUM_RELATIVE_VOLUME * edge ** 3)) {
      fail(`elements[${String(index)}] has a non-positive or collapsed reference volume (6V = ${String(volume6)}); `
        + 'order the nodes so that det(x1 - x0, x2 - x0, x3 - x0) > 0');
    }
    ids.forEach(id => used.add(id));
    const copy: readonly [number, number, number, number] = [ids[0], ids[1], ids[2], ids[3]];
    return Object.freeze(copy);
  }));
  if (used.size !== nodes.length) fail('every node must belong to an element');
  const material = readMaterial(row.material);
  const steps = integer(row.steps, 'steps', 1, SOLID_FINITE_LIMITS.steps);
  if (steps * (nodes.length + elements.length) > SOLID_FINITE_LIMITS.recordedStates) {
    fail(`at most ${String(SOLID_FINITE_LIMITS.recordedStates)} recorded node and element states are allowed`);
  }
  const dofs = new Set<number>();
  const prescribedMm: readonly SolidFinitePrescribed[] = Object.freeze(readHistories(row.prescribedMm, 'prescribedMm', 'valuesMm',
    nodes.length, steps, dofs).map(({ node, dof, values }) => Object.freeze({ node, dof, valuesMm: values })));
  const forcesN: readonly SolidFiniteLoad[] = Object.freeze(readHistories(row.forcesN, 'forcesN', 'valuesN',
    nodes.length, steps, new Set<number>()).map(({ node, dof, values }) => Object.freeze({ node, dof, valuesN: values })));
  if (prescribedMm.length === 0) fail('at least one displacement must be prescribed');
  if (prescribedMm.length >= nodes.length * 3) fail('at least one degree of freedom must stay free');
  const largestLoad = forcesN.filter(load => !dofs.has(load.node * 3 + SOLID_FINITE_DOFS.indexOf(load.dof))).reduce((largest, load) => load.valuesN.reduce((m, v) => Math.max(m, Math.abs(v)), largest), 0);
  const plan: SolidFinitePlan = { schema: SOLID_FINITE_PLAN_SCHEMA, units: SOLID_FINITE_UNITS, nodes, elements, material, steps,
    prescribedMm, forcesN };
  if (Object.hasOwn(row, 'referenceForceN')) {
    const referenceForceN = finite(row.referenceForceN, 'referenceForceN');
    if (!(referenceForceN > 0)) fail('referenceForceN must be positive');
    return Object.freeze({ ...plan, referenceForceN });
  }
  if (!(largestLoad > 0)) fail('a history without free-DOF nodal forces needs referenceForceN (native NRSolver force scale of the free DOFs)');
  return Object.freeze(plan);
}
