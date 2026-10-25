import type { Vector3 } from './analysisModel.js';
import type { BeamContactNumericResult } from './contactModel.js';
import type { AxialBoltForce } from './beamBoltContact.js';
import { translateBeamJointContact, type BeamJointContactInput, type BeamJointContactPlan } from './beamJointContact.js';
import { decodeBeamWeldContact, type WeldLayerWrench } from './beamWeldContact.js';

export interface ShankShortening { readonly boltId: string; readonly shorteningM: number }
export interface BeamJointInitialStrainInput {
  readonly schema: 'pointercad-joint-initial-strain/1';
  readonly joint: BeamJointContactInput;
  /** Prescribed stress-free shortening, not final bolt force or tightening torque. */
  readonly shortenings: readonly ShankShortening[];
}
export interface BeamJointInitialStrainPlan {
  readonly schema: 'pointercad-joint-initial-strain-plan/1';
  readonly joint: BeamJointContactPlan;
  readonly shortenings: readonly ShankShortening[];
}
export interface InitialStrainBoltForce extends AxialBoltForce {
  readonly elasticExtensionM: number;
  readonly elasticEnergyJ: number;
}
export interface BeamJointInitialStrainResult {
  readonly kind: 'oofem-beam-joint-initial-strain';
  readonly schema: 'pointercad-joint-initial-strain-result/1';
  readonly inputSha256: string;
  readonly structuralCertification: false;
  readonly contact: BeamContactNumericResult;
  readonly states: readonly { readonly loadFactor: number; readonly bolts: readonly InitialStrainBoltForce[];
    readonly welds: readonly WeldLayerWrench[] }[];
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('initial-strain-shape');
  return value as Record<string, unknown>;
}
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length+1
    && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
export function translateBeamJointInitialStrain(value: unknown): { input: BeamJointInitialStrainInput; plan: BeamJointInitialStrainPlan } {
  const root = fields(value, ['schema', 'joint', 'shortenings']);
  if (root.schema !== 'pointercad-joint-initial-strain/1') throw new Error('initial-strain-schema');
  const joint = translateBeamJointContact(root.joint);
  if (!dense(root.shortenings) || root.shortenings.length !== joint.plan.bolts.length) throw new Error('initial-strain-count');
  const byId = new Map<string, number>();
  for (const value of root.shortenings) {
    const row = fields(value, ['boltId', 'shorteningM']);
    if (typeof row.boltId !== 'string' || byId.has(row.boltId)) throw new Error('initial-strain-identity');
    const bolt = joint.plan.bolts.find(b => b.id === row.boltId);
    if (bolt === undefined || typeof row.shorteningM !== 'number' || !Number.isFinite(row.shorteningM)) throw new Error('initial-strain-value');
    const a = joint.plan.contact.nodes[bolt.nodeA-1].positionM, b = joint.plan.contact.nodes[bolt.nodeB-1].positionM;
    const length = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    if (row.shorteningM < 0 || row.shorteningM >= length) throw new Error('initial-strain-stress-free-length');
    byId.set(row.boltId, row.shorteningM);
  }
  const shortenings = joint.plan.bolts.map(b => {
    const shorteningM = byId.get(b.id);
    if (shorteningM === undefined) throw new Error('initial-strain-identity');
    return { boltId: b.id, shorteningM };
  });
  return { input: { schema: 'pointercad-joint-initial-strain/1', joint: joint.input, shortenings },
    plan: { schema: 'pointercad-joint-initial-strain-plan/1', joint: joint.plan, shortenings } };
}
export async function beamJointInitialStrainInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(translateBeamJointInitialStrain(value).input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function close(actual: unknown, expected: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual-expected) <= 1e-9*Math.max(Math.abs(expected), 1e-300);
}
function forceVector(actual: unknown, expected: Vector3): Vector3 {
  if (!dense(actual) || actual.length !== 3 || !expected.every((v, i) => close(actual[i], v))) throw new Error('initial-strain-force');
  return expected;
}
export function decodeBeamJointInitialStrain(raw: unknown, value: BeamJointInitialStrainInput, hash: string): BeamJointInitialStrainResult {
  const prepared = translateBeamJointInitialStrain(value), root = fields(raw, ['schema', 'contact', 'states']);
  if (root.schema !== 'pointercad-joint-initial-strain-result/1' || !dense(root.states)) throw new Error('initial-strain-result-schema');
  const rows = root.states.map(state => fields(state, ['loadFactor', 'bolts', 'welds']));
  const welds = decodeBeamWeldContact({ schema: 'pointercad-weld-layer-result/1', contact: root.contact,
    states: rows.map(row => ({ loadFactor: row.loadFactor, welds: row.welds })) },
  { schema: 'pointercad-weld-layer/1', contact: prepared.input.joint.contact, welds: prepared.input.joint.welds }, hash);
  const states = rows.map((row, index) => {
    const state = welds.contact.states[index];
    if (row.loadFactor !== state.loadFactor || !dense(row.bolts) || row.bolts.length !== prepared.plan.joint.bolts.length) throw new Error('initial-strain-state');
    const bolts = row.bolts.map((rawBolt, i): InitialStrainBoltForce => {
      const force = fields(rawBolt, ['id', 'extensionM', 'elasticExtensionM', 'axialForceN', 'forceOnAN', 'forceOnBN', 'elasticEnergyJ']);
      const bolt = prepared.plan.joint.bolts[i];
      const a = state.nodes.find(n => n.number === bolt.nodeA), b = state.nodes.find(n => n.number === bolt.nodeB);
      if (force.id !== bolt.id || a === undefined || b === undefined) throw new Error('initial-strain-node');
      const pa = prepared.plan.joint.contact.nodes[bolt.nodeA-1].positionM, pb = prepared.plan.joint.contact.nodes[bolt.nodeB-1].positionM;
      const span: Vector3 = [pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]], length = Math.hypot(...span);
      const normal = span.map(v => v/length), stiffness = bolt.youngPa*bolt.areaM2/length;
      const extensionM = normal.reduce((sum, n, axis) => sum+n*(b.displacementM[axis]-a.displacementM[axis]), 0);
      const elasticExtensionM = extensionM+prepared.plan.shortenings[i].shorteningM;
      const axialForceN = stiffness*elasticExtensionM, elasticEnergyJ = stiffness*elasticExtensionM*elasticExtensionM/2;
      if (!close(force.extensionM, extensionM) || !close(force.elasticExtensionM, elasticExtensionM)
        || !close(force.axialForceN, axialForceN) || !close(force.elasticEnergyJ, elasticEnergyJ)) throw new Error('initial-strain-constitutive');
      const forceOnAN = forceVector(force.forceOnAN, [normal[0]*axialForceN, normal[1]*axialForceN, normal[2]*axialForceN]);
      const forceOnBN = forceVector(force.forceOnBN, [-forceOnAN[0], -forceOnAN[1], -forceOnAN[2]]);
      return { id: bolt.id, extensionM, elasticExtensionM, axialForceN, forceOnAN, forceOnBN, elasticEnergyJ };
    });
    return { loadFactor: state.loadFactor, bolts, welds: welds.states[index].welds };
  });
  return { kind: 'oofem-beam-joint-initial-strain', schema: 'pointercad-joint-initial-strain-result/1',
    inputSha256: hash, structuralCertification: false, contact: welds.contact, states };
}
