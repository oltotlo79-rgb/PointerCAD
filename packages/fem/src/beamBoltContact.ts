import type { Vector3 } from './analysisModel.js';
import type { BeamContactInput, BeamContactNumericResult } from './contactModel.js';
import { translateBeamContact, type OofemContactPlan } from './contactTranslation.js';
import { decodeBeamContact } from './contactResults.js';

/** Bilateral elastic axial shank, stress-free at the authored endpoint distance.
 * Compression is permitted but neither buckling nor preload/slip/bearing/plasticity is modelled. */
export interface AxialBoltDefinition {
  readonly id: string;
  readonly nodeIdA: string;
  readonly nodeIdB: string;
  readonly youngPa: number;
  readonly areaM2: number;
}
export interface BeamBoltContactInput {
  readonly schema: 'pointercad-bolt-contact/1';
  readonly contact: BeamContactInput;
  readonly bolts: readonly AxialBoltDefinition[];
}
export interface AxialBoltPlan {
  readonly id: string;
  readonly nodeA: number;
  readonly nodeB: number;
  readonly youngPa: number;
  readonly areaM2: number;
}
export interface BeamBoltContactPlan {
  readonly schema: 'pointercad-bolt-contact-plan/1';
  readonly contact: OofemContactPlan;
  readonly bolts: readonly AxialBoltPlan[];
}
export interface AxialBoltForce {
  readonly id: string;
  readonly extensionM: number;
  /** Tension positive, compression negative. Forces are those the bolt applies to each endpoint. */
  readonly axialForceN: number;
  readonly forceOnAN: Vector3;
  readonly forceOnBN: Vector3;
}
export interface BeamBoltContactResult {
  readonly kind: 'oofem-beam-axial-bolt-contact';
  readonly schema: 'pointercad-bolt-contact-result/1';
  readonly inputSha256: string;
  readonly structuralCertification: false;
  /** Coupled response, not the result of solving the contact-only input independently. */
  readonly contact: BeamContactNumericResult;
  readonly states: readonly { readonly loadFactor: number; readonly bolts: readonly AxialBoltForce[] }[];
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function fields(v: unknown, names: readonly string[]): Record<string, unknown> {
  if (!record(v) || Reflect.ownKeys(v).length !== names.length || names.some(key => !Object.hasOwn(v, key))) {
    throw new Error('bolt-shape: missing or unsupported fields');
  }
  return v;
}
function dense(v: unknown): v is unknown[] {
  return Array.isArray(v) && Reflect.ownKeys(v).length === v.length + 1
    && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
}
function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 1e-30 && v <= 1e30;
}
function boltGeometry(a: Vector3, b: Vector3, youngPa: number, areaM2: number): { normal: Vector3; stiffness: number } {
  const span: Vector3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], length = Math.hypot(...span);
  const stiffness = youngPa * areaM2 / length;
  if (!(length > 1e-9) || !positive(stiffness)) throw new Error('bolt-length-stiffness: unsupported axial tie');
  return { normal: [span[0] / length, span[1] / length, span[2] / length], stiffness };
}

export function translateBeamBoltContact(value: unknown): { input: BeamBoltContactInput; plan: BeamBoltContactPlan } {
  const root = fields(value, ['schema', 'contact', 'bolts']);
  if (root.schema !== 'pointercad-bolt-contact/1') throw new Error('bolt-schema: unsupported input');
  const contact = translateBeamContact(root.contact);
  if (!dense(root.bolts) || root.bolts.length < 1 || root.bolts.length > 64) throw new Error('bolt-count: expected 1..64');
  const ids = new Set<string>(), pairs = new Set<string>();
  const bolts: AxialBoltDefinition[] = [], rows: AxialBoltPlan[] = [];
  for (const value of root.bolts) {
    const row = fields(value, ['id', 'nodeIdA', 'nodeIdB', 'youngPa', 'areaM2']);
    if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 64 || ids.has(row.id)) throw new Error('bolt-id');
    if (typeof row.nodeIdA !== 'string' || typeof row.nodeIdB !== 'string' || row.nodeIdA === row.nodeIdB) throw new Error('bolt-node');
    const a = contact.nodeIds.indexOf(row.nodeIdA), b = contact.nodeIds.indexOf(row.nodeIdB);
    if (a < 0 || b < 0) throw new Error('bolt-node: original nodes required');
    const pair = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (pairs.has(pair)) throw new Error('bolt-duplicate');
    if (!positive(row.youngPa) || !positive(row.areaM2)) throw new Error('bolt-number');
    const nodeA = contact.plan.nodes[a], nodeB = contact.plan.nodes[b];
    boltGeometry(nodeA.positionM, nodeB.positionM, row.youngPa, row.areaM2);
    ids.add(row.id); pairs.add(pair);
    bolts.push({ id: row.id, nodeIdA: row.nodeIdA, nodeIdB: row.nodeIdB, youngPa: row.youngPa, areaM2: row.areaM2 });
    rows.push({ id: row.id, nodeA: nodeA.number, nodeB: nodeB.number, youngPa: row.youngPa, areaM2: row.areaM2 });
  }
  return { input: { schema: 'pointercad-bolt-contact/1', contact: contact.input, bolts },
    plan: { schema: 'pointercad-bolt-contact-plan/1', contact: contact.plan, bolts: rows } };
}
export async function beamBoltContactInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(translateBeamBoltContact(value).input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function close(actual: unknown, expected: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1e-300);
}
function forceVector(raw: unknown, expected: Vector3): Vector3 {
  if (!dense(raw) || raw.length !== 3 || !expected.every((v, i) => close(raw[i], v))) throw new Error('bolt-force: endpoint force mismatch');
  return expected;
}
/** Constitutive and equal/opposite force checks use decoded displacements and original endpoint geometry.
 * Existing contact equilibrium/complementarity and support refusals remain mandatory. */
export function decodeBeamBoltContact(raw: unknown, value: BeamBoltContactInput, hash: string): BeamBoltContactResult {
  const prepared = translateBeamBoltContact(value);
  const root = fields(raw, ['schema', 'contact', 'states']);
  if (root.schema !== 'pointercad-bolt-contact-result/1') throw new Error('bolt-result-schema');
  const contact = decodeBeamContact(root.contact, prepared.input.contact, hash);
  if (!dense(root.states) || root.states.length !== contact.states.length) throw new Error('bolt-state-count');
  const states = root.states.map((rawState, index) => {
    const state = fields(rawState, ['loadFactor', 'bolts']), solved = contact.states[index];
    if (state.loadFactor !== solved.loadFactor || !dense(state.bolts) || state.bolts.length !== prepared.plan.bolts.length) throw new Error('bolt-state-identity');
    const bolts = state.bolts.map((rawBolt, position): AxialBoltForce => {
      const force = fields(rawBolt, ['id', 'extensionM', 'axialForceN', 'forceOnAN', 'forceOnBN']);
      const bolt = prepared.plan.bolts[position];
      const a = solved.nodes.find(node => node.number === bolt.nodeA), b = solved.nodes.find(node => node.number === bolt.nodeB);
      const pa = prepared.plan.contact.nodes.find(node => node.number === bolt.nodeA), pb = prepared.plan.contact.nodes.find(node => node.number === bolt.nodeB);
      if (force.id !== bolt.id || a === undefined || b === undefined || pa === undefined || pb === undefined) throw new Error('bolt-node-identity');
      const { normal, stiffness } = boltGeometry(pa.positionM, pb.positionM, bolt.youngPa, bolt.areaM2);
      const extensionM = normal.reduce((sum, n, axis) => sum + n * (b.displacementM[axis] - a.displacementM[axis]), 0);
      const axialForceN = stiffness * extensionM;
      if (!close(force.extensionM, extensionM) || !close(force.axialForceN, axialForceN)) throw new Error('bolt-constitutive: EA/L response mismatch');
      const forceOnAN = forceVector(force.forceOnAN, [normal[0] * axialForceN, normal[1] * axialForceN, normal[2] * axialForceN]);
      const forceOnBN = forceVector(force.forceOnBN, [-forceOnAN[0], -forceOnAN[1], -forceOnAN[2]]);
      return { id: bolt.id, extensionM, axialForceN, forceOnAN, forceOnBN };
    });
    return { loadFactor: solved.loadFactor, bolts };
  });
  const numeric: BeamContactNumericResult = { schema: contact.schema, method: contact.method, freeDofs: contact.freeDofs,
    meshNodes: contact.meshNodes, meshElements: contact.meshElements, momentLengthM: contact.momentLengthM,
    pivotLimit: contact.pivotLimit, states: contact.states };
  return { kind: 'oofem-beam-axial-bolt-contact', schema: 'pointercad-bolt-contact-result/1', inputSha256: hash,
    structuralCertification: false, contact: numeric, states };
}
