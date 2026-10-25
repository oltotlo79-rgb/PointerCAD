import type { Vector3 } from './analysisModel.js';
import type { BeamContactInput, BeamContactNumericResult } from './contactModel.js';
import { translateBeamContact, type OofemContactPlan } from './contactTranslation.js';
import { decodeBeamContact } from './contactResults.js';

/** Explicit effective compliant throat patch, SI units. No fillet geometry or strength inference. */
export interface WeldLayerGeometry {
  readonly id: string;
  readonly centerM: Vector3;
  readonly normal: Vector3;
  readonly along: Vector3;
  readonly widthM: number;
  readonly lengthM: number;
  readonly thicknessM: number;
  readonly youngPa: number;
  readonly poisson: number;
}
export interface WeldLayerDefinition extends WeldLayerGeometry {
  readonly nodeIdA: string;
  readonly nodeIdB: string;
}
export interface WeldLayerPlan extends WeldLayerGeometry {
  readonly nodeA: number;
  readonly nodeB: number;
}
export interface BeamWeldContactInput {
  readonly schema: 'pointercad-weld-layer/1';
  readonly contact: BeamContactInput;
  readonly welds: readonly WeldLayerDefinition[];
}
export interface BeamWeldContactPlan {
  readonly schema: 'pointercad-weld-layer-plan/1';
  readonly contact: OofemContactPlan;
  readonly welds: readonly WeldLayerPlan[];
}
export interface WeldLayerWrench {
  readonly id: string;
  readonly forceOnAN: Vector3;
  readonly forceOnBN: Vector3;
  /** About the corresponding original node, not the global origin or patch center. */
  readonly momentOnANm: Vector3;
  readonly momentOnBNm: Vector3;
  readonly elasticEnergyJ: number;
}
export interface BeamWeldContactResult {
  readonly kind: 'oofem-beam-weld-layer-contact';
  readonly schema: 'pointercad-weld-layer-result/1';
  readonly inputSha256: string;
  readonly structuralCertification: false;
  readonly contact: BeamContactNumericResult;
  readonly states: readonly { readonly loadFactor: number; readonly welds: readonly WeldLayerWrench[] }[];
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) {
    throw new Error('weld-shape: absent or unsupported fields');
  }
  return value as Record<string, unknown>;
}
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e30) throw new Error('weld-number');
  return value;
}
function positive(value: unknown): number {
  const number = finite(value);
  if (number <= 1e-30) throw new Error('weld-number: positive dimension or modulus required');
  return number;
}
function vector(value: unknown): Vector3 {
  if (!dense(value) || value.length !== 3) throw new Error('weld-vector');
  return [finite(value[0]), finite(value[1]), finite(value[2])];
}
function add(a: Vector3, b: Vector3): Vector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vector3, k: number): Vector3 { return [a[0] * k, a[1] * k, a[2] * k]; }
function sub(a: Vector3, b: Vector3): Vector3 { return add(a, scale(b, -1)); }
function dot(a: Vector3, b: Vector3): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
function geometry(row: Record<string, unknown>): WeldLayerGeometry {
  if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 64) throw new Error('weld-id');
  const centerM = vector(row.centerM), normal = vector(row.normal), along = vector(row.along);
  if (Math.abs(Math.hypot(...normal) - 1) > 1e-10 || Math.abs(Math.hypot(...along) - 1) > 1e-10
    || Math.abs(dot(normal, along)) > 1e-10) throw new Error('weld-frame');
  const widthM = positive(row.widthM), lengthM = positive(row.lengthM), thicknessM = positive(row.thicknessM);
  const youngPa = positive(row.youngPa), poisson = finite(row.poisson);
  if (poisson < 0 || poisson >= .5) throw new Error('weld-material');
  const stiffness = youngPa * widthM * lengthM / thicknessM;
  if (!Number.isFinite(stiffness) || stiffness <= 0) throw new Error('weld-scale');
  return { id: row.id, centerM, normal, along, widthM, lengthM, thicknessM, youngPa, poisson };
}

export function translateBeamWeldContact(value: unknown): { input: BeamWeldContactInput; plan: BeamWeldContactPlan } {
  const root = fields(value, ['schema', 'contact', 'welds']);
  if (root.schema !== 'pointercad-weld-layer/1') throw new Error('weld-schema');
  const contact = translateBeamContact(root.contact);
  if (!dense(root.welds) || root.welds.length < 1 || root.welds.length > 64) throw new Error('weld-count');
  const ids = new Set<string>(), pairs = new Map<string, WeldLayerGeometry[]>();
  const welds: WeldLayerDefinition[] = [], plans: WeldLayerPlan[] = [];
  for (const raw of root.welds) {
    const row = fields(raw, ['id', 'nodeIdA', 'nodeIdB', 'centerM', 'normal', 'along', 'widthM', 'lengthM', 'thicknessM', 'youngPa', 'poisson']);
    const patch = geometry(row);
    if (typeof row.nodeIdA !== 'string' || typeof row.nodeIdB !== 'string' || row.nodeIdA === row.nodeIdB) throw new Error('weld-node');
    const a = contact.nodeIds.indexOf(row.nodeIdA), b = contact.nodeIds.indexOf(row.nodeIdB);
    if (a < 0 || b < 0) throw new Error('weld-node: original nodes required');
    const pair = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (ids.has(patch.id)) throw new Error('weld-duplicate');
    const previous = pairs.get(pair) ?? [];
    for (const other of previous) {
      if ((['normal', 'along'] as const).some(key => patch[key].some((v, i) => Math.abs(v-other[key][i]) > 1e-10))) {
        throw new Error('weld-scope: same-pair patches require aligned frames');
      }
      const delta = sub(patch.centerM, other.centerM), station = dot(delta, patch.along);
      const tolerance = 1e-10*Math.max(patch.widthM, patch.lengthM, other.widthM, other.lengthM);
      if (Math.hypot(...sub(delta, scale(patch.along, station))) > tolerance) {
        throw new Error('weld-scope: same-pair patches require one coplanar centerline');
      }
      const radius = (patch.widthM*dot(patch.along, patch.along)
        + other.widthM*Math.abs(dot(other.along, patch.along))
        + other.lengthM*Math.abs(dot(cross(other.normal, other.along), patch.along)))/2;
      const roundoffScale = radius + patch.along.reduce((sum, v, i) =>
        sum+(Math.abs(patch.centerM[i])+Math.abs(other.centerM[i]))*Math.abs(v), 0);
      if (Math.abs(station) <= radius+32*Number.EPSILON*roundoffScale) {
        throw new Error('weld-duplicate: overlap or unresolved patch separation');
      }
    }
    ids.add(patch.id); pairs.set(pair, [...previous, patch]);
    welds.push({ ...patch, nodeIdA: row.nodeIdA, nodeIdB: row.nodeIdB });
    plans.push({ ...patch, nodeA: contact.plan.nodes[a].number, nodeB: contact.plan.nodes[b].number });
  }
  return { input: { schema: 'pointercad-weld-layer/1', contact: contact.input, welds },
    plan: { schema: 'pointercad-weld-layer-plan/1', contact: contact.plan, welds: plans } };
}
export async function beamWeldContactInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(translateBeamWeldContact(value).input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Reconstruct the physical nodal wrench from the decoded section motion, not from reported joint forces. */
function expectedWrench(w: WeldLayerPlan, pa: Vector3, pb: Vector3,
  ua: Vector3, ub: Vector3, ra: Vector3, rb: Vector3): WeldLayerWrench {
  const q = cross(w.normal, w.along), g = w.youngPa / (2 * (1 + w.poisson));
  const area = w.widthM * w.lengthM / 4;
  let force: Vector3 = [0, 0, 0], ma: Vector3 = [0, 0, 0], mb: Vector3 = [0, 0, 0], energy = 0;
  for (const i of [-1, 1]) for (const j of [-1, 1]) {
    const p = add(w.centerM, add(scale(w.along, i*w.widthM/Math.sqrt(12)), scale(q, j*w.lengthM/Math.sqrt(12))));
    const xa = sub(p, pa), xb = sub(p, pb);
    const relative = sub(add(ub, cross(rb, xb)), add(ua, cross(ra, xa)));
    const f = scale(add(scale(relative, g), scale(w.normal, (w.youngPa-g)*dot(w.normal, relative))), area/w.thicknessM);
    force = add(force, f); ma = add(ma, cross(xa, f)); mb = sub(mb, cross(xb, f));
    energy += dot(relative, f)/2;
  }
  return { id: w.id, forceOnAN: force, forceOnBN: scale(force, -1), momentOnANm: ma, momentOnBNm: mb, elasticEnergyJ: energy };
}
export function decodeBeamWeldContact(raw: unknown, input: BeamWeldContactInput, hash: string): BeamWeldContactResult {
  const prepared = translateBeamWeldContact(input), root = fields(raw, ['schema', 'contact', 'states']);
  if (root.schema !== 'pointercad-weld-layer-result/1') throw new Error('weld-result-schema');
  const contact = decodeBeamContact(root.contact, prepared.input.contact, hash);
  if (!dense(root.states) || root.states.length !== contact.states.length) throw new Error('weld-state-count');
  const states = root.states.map((rawState, index) => {
    const state = fields(rawState, ['loadFactor', 'welds']), solved = contact.states[index];
    if (state.loadFactor !== solved.loadFactor || !dense(state.welds) || state.welds.length !== prepared.plan.welds.length) throw new Error('weld-state-identity');
    const welds = state.welds.map((rawWeld, wi): WeldLayerWrench => {
      const actual = fields(rawWeld, ['id', 'forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm', 'elasticEnergyJ']);
      const w = prepared.plan.welds[wi], a = solved.nodes.find(n => n.number === w.nodeA), b = solved.nodes.find(n => n.number === w.nodeB);
      const pa = prepared.plan.contact.nodes.find(n => n.number === w.nodeA), pb = prepared.plan.contact.nodes.find(n => n.number === w.nodeB);
      if (actual.id !== w.id || a === undefined || b === undefined || pa === undefined || pb === undefined) throw new Error('weld-node-identity');
      const expected = expectedWrench(w, pa.positionM, pb.positionM, a.displacementM, b.displacementM, a.rotationRad, b.rotationRad);
      const length = contact.momentLengthM;
      const norm = Math.max(Math.hypot(...expected.forceOnAN), Math.hypot(...expected.momentOnANm)/length,
        Math.hypot(...expected.momentOnBNm)/length, 1e-300);
      for (const key of ['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const) {
        const found = vector(actual[key]), divisor = key === 'forceOnAN' || key === 'forceOnBN' ? 1 : length;
        if (!Number.isFinite(norm) || found.some((v, axis) => Math.abs(v-expected[key][axis])/divisor > 1e-9*norm)) throw new Error('weld-constitutive-wrench');
      }
      const energy = finite(actual.elasticEnergyJ);
      if (energy < 0 || !Number.isFinite(expected.elasticEnergyJ)
        || Math.abs(energy-expected.elasticEnergyJ) > 1e-9*Math.max(expected.elasticEnergyJ, 1e-300)) throw new Error('weld-constitutive-energy');
      return expected;
    });
    return { loadFactor: solved.loadFactor, welds };
  });
  const numeric: BeamContactNumericResult = { schema: contact.schema, method: contact.method, freeDofs: contact.freeDofs,
    meshNodes: contact.meshNodes, meshElements: contact.meshElements, momentLengthM: contact.momentLengthM,
    pivotLimit: contact.pivotLimit, states: contact.states };
  return { kind: 'oofem-beam-weld-layer-contact', schema: 'pointercad-weld-layer-result/1', inputSha256: hash,
    structuralCertification: false, contact: numeric, states };
}
