import type { BeamNodalLoad, Vector3, Vector6 } from './analysisModel.js';
import type { BeamBucklingInput, BucklingRestraints } from './bucklingModel.js';
import { translateBeamModal, type OofemModalPlan } from './modalTranslation.js';

export interface OofemBucklingPlan extends Omit<OofemModalPlan, 'schema' | 'nodes'> {
  readonly schema: 'pointercad-oofem-buckling-plan/1';
  readonly nodes: readonly (OofemModalPlan['nodes'][number] & { readonly restrained: BucklingRestraints })[];
}
const free: BucklingRestraints = [false, false, false, false, false, false];

// The model's public beam-analysis subpath exports readBeamAnalysis, not its
// internal fields/list/load readers. Keep the new request envelope validation
// here; geometry still uses the existing public, strict decoder unchanged.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !(name in value))) {
    throw new Error(`buckling-shape: ${path}`);
  }
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value
    || [...value].some(character => character.charCodeAt(0) < 32)) throw new Error(`buckling-text: ${path}`);
  return value;
}
function list<T>(value: unknown, path: string, maximum: number, read: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`buckling-size: ${path}`);
  return value.map((item: unknown, index: number) => read(item, `${path}[${index}]`));
}
function vector(value: unknown, path: string): Vector3 {
  const components = list(value, path, 3, item => {
    if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 1e30) {
      throw new Error(`buckling-number: ${path}`);
    }
    return item === 0 ? 0 : item;
  });
  if (components.length !== 3) throw new Error(`buckling-vector: ${path}`);
  return [components[0], components[1], components[2]];
}
function readLoads(value: unknown): BeamNodalLoad[] {
  const rows = list<BeamNodalLoad>(value, 'referenceLoads', 1024, (item, path) => {
    const load = fields(item, ['id', 'kind', 'nodeId', 'force', 'moment'], path);
    if (load.kind !== 'nodal') throw new Error('buckling-load: only dead nodal loads are supported');
    return { id: text(load.id, path), kind: 'nodal', nodeId: text(load.nodeId, path),
      force: vector(load.force, path), moment: vector(load.moment, path) };
  });
  if (new Set(rows.map(load => load.id)).size !== rows.length) throw new Error('buckling-load: duplicate load id');
  return rows;
}

export function translateBeamBuckling(value: unknown): {
  readonly input: BeamBucklingInput; readonly plan: OofemBucklingPlan;
} {
  const row = fields(value, ['schema', 'geometry', 'supports', 'referenceLoads'], '$');
  if (row.schema !== 'pointercad-beam-buckling/1') throw new Error('buckling-schema: unsupported input');
  const prepared = translateBeamModal(row.geometry);
  if (prepared.document.constraints.length !== 0) {
    throw new Error('buckling-supports: geometry must be unrestrained; use explicit six-DOF supports');
  }
  const originalIds = new Set(prepared.document.nodes.map(node => node.id));
  const supports = list(row.supports, 'supports', 128, (value, path) => {
    const support = fields(value, ['nodeId', 'restrained'], path);
    const nodeId = text(support.nodeId, `${path}.nodeId`);
    const mask = support.restrained;
    if (!originalIds.has(nodeId) || !Array.isArray(mask) || mask.length !== 6
      || !mask.every((item: unknown) => typeof item === 'boolean') || !mask.some(Boolean)) {
      throw new Error('buckling-supports: expected an existing node and six explicit boolean restraints');
    }
    const restrained: BucklingRestraints = [mask[0] === true, mask[1] === true, mask[2] === true, mask[3] === true, mask[4] === true, mask[5] === true];
    return { nodeId, restrained };
  });
  const supportMap = new Map(supports.map(support => [support.nodeId, support.restrained]));
  if (supportMap.size !== supports.length || supports.length === 0) {
    throw new Error('buckling-supports: duplicate or absent supports');
  }
  const referenceLoads = readLoads(row.referenceLoads);
  if (referenceLoads.some(load => !originalIds.has(load.nodeId))) throw new Error('buckling-load: missing node');
  const lengthScale = prepared.document.units === 'N-mm' ? 0.001 : 1;
  const nodes = prepared.plan.nodes.map(node => {
    const loads = referenceLoads.filter(load => load.nodeId === node.id);
    const sum = (axis: number): number => loads.reduce((total, load) => total
      + (axis < 3 ? load.force[axis] : load.moment[axis - 3] * lengthScale), 0);
    const load: Vector6 = [sum(0), sum(1), sum(2), sum(3), sum(4), sum(5)];
    if (load.some(component => !Number.isFinite(component) || Math.abs(component) > 1e30)) {
      throw new Error('buckling-load: invalid combined reference load');
    }
    return { ...node, restrained: supportMap.get(node.id) ?? free, load };
  });
  if (!nodes.some(node => node.load.some(component => component !== 0))) {
    throw new Error('buckling-load: zero reference load');
  }
  const freeDofs = nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0);
  if (freeDofs < prepared.plan.modeCount) throw new Error('buckling-supports: insufficient free degrees of freedom');
  const input: BeamBucklingInput = {
    schema: 'pointercad-beam-buckling/1', geometry: prepared.document, supports, referenceLoads,
  };
  return { input, plan: { ...prepared.plan, schema: 'pointercad-oofem-buckling-plan/1', nodes } };
}

export async function bucklingInputSha256(value: unknown): Promise<string> {
  const input = translateBeamBuckling(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
