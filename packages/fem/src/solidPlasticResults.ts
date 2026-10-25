/**
 * STATUS: PROVISIONAL (unexecuted; native support unproven until Root runs proof-r2). Strict reader of the
 * solidPlasticAnalysis.py encoding. It validates shape and consistency only; it is not exported from the package
 * index and no client path returns it yet.
 */
import type { SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { SOLID_PLASTIC_LIMITS, type SolidPlasticPlan } from './solidPlastic.js';

export const SOLID_PLASTIC_RESULT_SCHEMA = 'pointercad-oofem-solid-plastic-result/1';
export const SOLID_PLASTIC_METHOD = 'oofem-misesmat-htype0-ltrspace-staticstructural/2';
export const SOLID_PLASTIC_SCOPE = 'small-strain-j2-linear-isotropic-hardening-tet4';
/** Free-DOF force balance relative to the largest current nodal force or previously accepted applied/reaction force.
 * Method/2 retains that physical reference through unloading; the numerator is never clamped or replaced. */
export const SOLID_PLASTIC_RESIDUAL_BOUND = 1e-8;

export interface SolidPlasticElementState {
  readonly stressMPa: SolidVector6;
  readonly strain: SolidVector6;
  readonly plasticStrain: SolidVector6;
}
export interface SolidPlasticRecord {
  readonly step: number;
  readonly loadFactor: number;
  readonly displacementMm: readonly SolidVector3[];
  readonly elements: readonly SolidPlasticElementState[];
  readonly freeResidualRatio: number;
}
export interface SolidPlasticNative {
  readonly records: readonly SolidPlasticRecord[];
  readonly yielded: boolean;
}

function fail(detail: string): never {
  throw new Error(`solid-plastic-result: ${detail}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
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
function dense(value: unknown, length: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) fail(`${path} must have exactly ${length} entries`);
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${path} must not have holes`);
  }
  return value;
}
function vector6(value: unknown, path: string): SolidVector6 {
  const v = dense(value, 6, path).map((item, index) => finite(item, `${path}[${index}]`));
  return [v[0], v[1], v[2], v[3], v[4], v[5]];
}

/** Reads the raw runner output for the plan it was produced from; any deviation is refused, never repaired. */
export function readSolidPlasticNative(value: unknown, plan: SolidPlasticPlan): SolidPlasticNative {
  const row = exact(value, ['schema', 'method', 'scope', 'structuralCertification', 'records', 'yielded'], 'result');
  if (row.schema !== SOLID_PLASTIC_RESULT_SCHEMA) fail('unsupported result schema');
  if (row.method !== SOLID_PLASTIC_METHOD) fail('unexpected method');
  if (row.scope !== SOLID_PLASTIC_SCOPE) fail('unexpected scope');
  if (row.structuralCertification !== false) fail('structuralCertification must be false');
  const segments = plan.loadFactor.length - 1;
  const records = dense(row.records, segments, 'records').map((item, index) => {
    const path = `records[${index}]`;
    const r = exact(item, ['step', 'loadFactor', 'displacementMm', 'elements', 'freeResidualRatio'], path);
    const step = (index + 1) * plan.stepsPerSegment;
    if (r.step !== step) fail(`${path}.step must be ${step}`);
    if (r.loadFactor !== plan.loadFactor[index + 1]) fail(`${path}.loadFactor differs from the plan knot`);
    const displacementMm = dense(r.displacementMm, plan.nodes.length, `${path}.displacementMm`).map((u, node) => {
      const xyz = dense(u, 3, `${path}.displacementMm[${node}]`)
        .map((v, axis) => finite(v, `${path}.displacementMm[${node}][${axis}]`));
      return [xyz[0], xyz[1], xyz[2]] as const;
    });
    for (const p of plan.prescribedMm) {
      const axis = 'xyz'.indexOf(p.dof);
      const expected = p.valueMm * plan.loadFactor[index + 1];
      // Infinity > Infinity is false, so an overflowed expectation would accept any displacement.
      if (!Number.isFinite(expected)) fail(`${path}: prescribed displacement of node ${p.node} is not finite`);
      if (Math.abs(displacementMm[p.node][axis] - expected) > 1e-12 * Math.max(1, Math.abs(expected))) {
        fail(`${path}.displacementMm[${p.node}][${axis}] differs from the prescribed value`);
      }
    }
    const elements = dense(r.elements, plan.elements.length, `${path}.elements`).map((e, element) => {
      const state = exact(e, ['stressMPa', 'strain', 'plasticStrain'], `${path}.elements[${element}]`);
      const strain = vector6(state.strain, `${path}.elements[${element}].strain`);
      // Independent of the runner: the declared small-strain scope is enforced again on the decoded result.
      if (strain.some(v => Math.abs(v) > SOLID_PLASTIC_LIMITS.maximumStrain)) {
        fail(`${path}.elements[${element}].strain exceeds ${SOLID_PLASTIC_LIMITS.maximumStrain} (small-strain scope)`);
      }
      return { stressMPa: vector6(state.stressMPa, `${path}.elements[${element}].stressMPa`), strain,
        plasticStrain: vector6(state.plasticStrain, `${path}.elements[${element}].plasticStrain`) };
    });
    const freeResidualRatio = finite(r.freeResidualRatio, `${path}.freeResidualRatio`);
    if (!(freeResidualRatio >= 0 && freeResidualRatio <= SOLID_PLASTIC_RESIDUAL_BOUND)) {
      fail(`${path}.freeResidualRatio exceeds ${SOLID_PLASTIC_RESIDUAL_BOUND}`);
    }
    return { step, loadFactor: plan.loadFactor[index + 1], displacementMm, elements, freeResidualRatio };
  });
  const yielded = records.some(r => r.elements.some(e => e.plasticStrain.some(v => v !== 0)));
  if (row.yielded !== yielded) fail('yielded must state whether any plastic strain is nonzero');
  return { records, yielded };
}
