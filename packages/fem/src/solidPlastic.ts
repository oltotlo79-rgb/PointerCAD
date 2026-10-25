/**
 * PROVISIONAL (unexecuted; native support unproven until Root runs proof-r2): small-strain J2 plasticity of tet4
 * solids through OOFEM ltrspace + MisesMat htype 0 + StaticStructural. This module is the plan contract and its strict
 * reader only. It exposes no analysis entry point and no success result; nothing dispatches it before the native
 * proof passes.
 *
 * Conventions reused from the adopted solid path (solidAnalysisModel.ts): units N-mm-MPa, 0-based node indices,
 * tet4 node order as OOFEM ltrspace. Voigt order [xx, yy, zz, yz, xz, xy] with engineering shear
 * (structural3delement.C:81-83). The material follows plasticBar.ts: user-supplied values with a stated source,
 * linear isotropic hardening H >= 0, no softening, nothing derived from a grade name.
 */
import type { SolidVector3 } from './solidAnalysisModel.js';

export const SOLID_PLASTIC_PLAN_SCHEMA = 'pointercad-oofem-solid-plastic-plan/1';
export const SOLID_PLASTIC_LIMITS = {
  maximumNodes: 2000,
  maximumElements: 5000,
  maximumKnots: 64,
  maximumStepsPerSegment: 200,
  maximumSteps: 2000,
  /** Small-strain formulation: the runner refuses any native strain component beyond this magnitude. */
  maximumStrain: 0.05,
  /**
   * Result size bound: states are recorded only at the end of each load-factor segment, so
   * (knots - 1) * (nodes + elements) must not exceed this.
   */
  maximumRecordedStates: 20000,
} as const;

export type SolidPlasticDof = 'x' | 'y' | 'z';
export interface SolidPlasticMaterial {
  readonly youngMPa: number;
  readonly poisson: number;
  /** Initial uniaxial yield stress sigma0. */
  readonly yieldStressMPa: number;
  /** Linear isotropic hardening modulus H; 0 = perfectly plastic. */
  readonly hardeningModulusMPa: number;
  readonly source: { readonly kind: 'user-supplied'; readonly reference: string };
}
export interface SolidPlasticPlan {
  readonly schema: typeof SOLID_PLASTIC_PLAN_SCHEMA;
  readonly units: 'N-mm-MPa';
  readonly nodes: readonly SolidVector3[];
  readonly elements: readonly (readonly [number, number, number, number])[];
  readonly material: SolidPlasticMaterial;
  /** Prescribed displacement per node and direction, multiplied by the load factor; unlisted DOFs are free. */
  readonly prescribedMm: readonly { readonly node: number; readonly dof: SolidPlasticDof; readonly valueMm: number }[];
  /** Nodal forces on free DOFs, multiplied by the same load factor. */
  readonly forcesN: readonly { readonly node: number; readonly dof: SolidPlasticDof; readonly forceN: number }[];
  /** Piecewise-linear load factor knots; the first knot is 0 (undeformed, at rest). */
  readonly loadFactor: readonly number[];
  readonly stepsPerSegment: number;
}

function fail(detail: string): never {
  throw new Error(`solid-plastic: ${detail}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const row = value;
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    fail(`${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value === 0 ? 0 : value;
}
function positive(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!(number > 0)) fail(`${path} must be positive`);
  return number;
}
function denseArray(value: unknown, path: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${path} must have ${minimum} to ${maximum} entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${path} must not have holes`);
  }
  return value;
}
function nodeIndex(value: unknown, count: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= count) {
    fail(`${path} must be a node index from 0 to ${count - 1}`);
  }
  return value;
}
/**
 * Explicit whitespace code points shared with solidPlasticAnalysis.py (not String.prototype.trim or str.strip, whose
 * sets differ between the two languages).
 */
const REFERENCE_WHITESPACE: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000, 0xfeff]);
/** Length in Unicode code points (Python len), not UTF-16 units; at least one non-whitespace code point. */
function isReference(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const points = Array.from(value, character => character.codePointAt(0) ?? 0);
  return points.length <= 500 && points.some(point => !REFERENCE_WHITESPACE.has(point));
}
function dof(value: unknown, path: string): SolidPlasticDof {
  if (value !== 'x' && value !== 'y' && value !== 'z') fail(`${path} must be x, y or z`);
  return value;
}

/** The single TS reader for the plan; solidPlasticAnalysis.py mirrors the same acceptance and message prefixes. */
export function readSolidPlasticPlan(value: unknown): SolidPlasticPlan {
  const row = record(value, ['schema', 'units', 'nodes', 'elements', 'material', 'prescribedMm', 'forcesN',
    'loadFactor', 'stepsPerSegment'], 'plan');
  if (row.schema !== SOLID_PLASTIC_PLAN_SCHEMA) fail('unsupported plan schema');
  if (row.units !== 'N-mm-MPa') fail('units must be N-mm-MPa');
  const nodes = denseArray(row.nodes, 'nodes', 4, SOLID_PLASTIC_LIMITS.maximumNodes).map((point, index) => {
    const xyz = denseArray(point, `nodes[${index}]`, 3, 3);
    return [finite(xyz[0], `nodes[${index}][0]`), finite(xyz[1], `nodes[${index}][1]`),
      finite(xyz[2], `nodes[${index}][2]`)] as const;
  });
  const elements = denseArray(row.elements, 'elements', 1, SOLID_PLASTIC_LIMITS.maximumElements).map((element, index) => {
    const ids = denseArray(element, `elements[${index}]`, 4, 4).map((id, local) =>
      nodeIndex(id, nodes.length, `elements[${index}][${local}]`));
    if (new Set(ids).size !== 4) fail(`elements[${index}] must use four distinct nodes`);
    return [ids[0], ids[1], ids[2], ids[3]] as const;
  });
  const m = record(row.material, ['youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa', 'source'], 'material');
  const youngMPa = positive(m.youngMPa, 'material.youngMPa');
  const poisson = finite(m.poisson, 'material.poisson');
  if (poisson < 0 || poisson >= 0.5) fail('material.poisson must be in [0, 0.5)');
  const yieldStressMPa = positive(m.yieldStressMPa, 'material.yieldStressMPa');
  if (yieldStressMPa >= youngMPa) fail('material.yieldStressMPa must be below material.youngMPa (yield strain < 1)');
  const hardeningModulusMPa = finite(m.hardeningModulusMPa, 'material.hardeningModulusMPa');
  if (hardeningModulusMPa < 0) fail('material.hardeningModulusMPa must not be negative (softening is not supported)');
  const source = record(m.source, ['kind', 'reference'], 'material.source');
  if (source.kind !== 'user-supplied') fail('material.source.kind must be user-supplied');
  if (!isReference(source.reference)) {
    fail('material.source.reference must be a non-empty statement of where the values come from (at most 500 characters)');
  }
  const seen = new Set<string>();
  const prescribedMm = denseArray(row.prescribedMm, 'prescribedMm', 1, nodes.length * 3).map((item, index) => {
    const p = record(item, ['node', 'dof', 'valueMm'], `prescribedMm[${index}]`);
    const node = nodeIndex(p.node, nodes.length, `prescribedMm[${index}].node`);
    const direction = dof(p.dof, `prescribedMm[${index}].dof`);
    const key = `${node}:${direction}`;
    if (seen.has(key)) fail(`prescribedMm[${index}] repeats a node direction`);
    seen.add(key);
    return { node, dof: direction, valueMm: finite(p.valueMm, `prescribedMm[${index}].valueMm`) };
  });
  if (seen.size >= nodes.length * 3) fail('at least one degree of freedom must stay free');
  const loaded = new Set<string>();
  const forcesN = denseArray(row.forcesN, 'forcesN', 0, nodes.length * 3).map((item, index) => {
    const f = record(item, ['node', 'dof', 'forceN'], `forcesN[${index}]`);
    const node = nodeIndex(f.node, nodes.length, `forcesN[${index}].node`);
    const direction = dof(f.dof, `forcesN[${index}].dof`);
    const key = `${node}:${direction}`;
    if (seen.has(key)) fail(`forcesN[${index}] acts on a prescribed direction`);
    if (loaded.has(key)) fail(`forcesN[${index}] repeats a node direction`);
    loaded.add(key);
    return { node, dof: direction, forceN: finite(f.forceN, `forcesN[${index}].forceN`) };
  });
  const loadFactor = denseArray(row.loadFactor, 'loadFactor', 2, SOLID_PLASTIC_LIMITS.maximumKnots)
    .map((knot, index) => finite(knot, `loadFactor[${index}]`));
  if (loadFactor[0] !== 0) fail('the first load-factor knot must be 0');
  // Finite operands can still overflow: every scaled prescription and load must stay finite at every knot.
  prescribedMm.forEach((p, index) => {
    if (loadFactor.some(knot => !Number.isFinite(p.valueMm * knot))) {
      fail(`prescribedMm[${index}].valueMm times a load-factor knot must be finite`);
    }
  });
  forcesN.forEach((f, index) => {
    if (loadFactor.some(knot => !Number.isFinite(f.forceN * knot))) {
      fail(`forcesN[${index}].forceN times a load-factor knot must be finite`);
    }
  });
  for (let index = 1; index < loadFactor.length; index += 1) {
    if (loadFactor[index] === loadFactor[index - 1]) fail('consecutive load-factor knots must differ');
  }
  const stepsPerSegment = row.stepsPerSegment;
  if (typeof stepsPerSegment !== 'number' || !Number.isSafeInteger(stepsPerSegment) || stepsPerSegment < 1
    || stepsPerSegment > SOLID_PLASTIC_LIMITS.maximumStepsPerSegment) {
    fail(`stepsPerSegment must be an integer from 1 to ${SOLID_PLASTIC_LIMITS.maximumStepsPerSegment}`);
  }
  if (stepsPerSegment * (loadFactor.length - 1) > SOLID_PLASTIC_LIMITS.maximumSteps) {
    fail(`at most ${SOLID_PLASTIC_LIMITS.maximumSteps} steps are allowed`);
  }
  if ((loadFactor.length - 1) * (nodes.length + elements.length) > SOLID_PLASTIC_LIMITS.maximumRecordedStates) {
    fail(`at most ${SOLID_PLASTIC_LIMITS.maximumRecordedStates} recorded node and element states are allowed`);
  }
  return { schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa', nodes, elements,
    material: { youngMPa, poisson, yieldStressMPa, hardeningModulusMPa,
      source: { kind: 'user-supplied', reference: source.reference } },
    prescribedMm, forcesN, loadFactor, stepsPerSegment };
}
