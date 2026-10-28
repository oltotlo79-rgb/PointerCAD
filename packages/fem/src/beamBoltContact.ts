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


/** Separate opt-in finite-length frame shank. No old axial or Worker input accepts this schema. */
export interface FrameBoltSource { readonly kind: 'published' | 'measured' | 'user-supplied'; readonly reference: string; readonly condition: string }
export interface FrameBoltQuantity { readonly role: string; readonly value: number; readonly source: FrameBoltSource }
export interface FrameBoltLimits { readonly classId: string; readonly materialConditionId: string; readonly tensionPa: number; readonly shearPa: number; readonly bendingPa: number; readonly source: FrameBoltSource }
export interface FrameBoltSection {
  readonly materialConditionId: string; readonly tensileArea: FrameBoltQuantity; readonly shearArea: FrameBoltQuantity;
  readonly modulusY: FrameBoltQuantity; readonly modulusZ: FrameBoltQuantity;
  readonly fibreYM: FrameBoltQuantity; readonly fibreZM: FrameBoltQuantity; readonly limits: FrameBoltLimits | null;
}
export interface FrameBoltDeclaration {
  readonly id: string; readonly memberId: string; readonly model: 'centroidal-frame-shank-explicit-end-coupling';
  readonly couplingSource: FrameBoltSource; readonly shorteningM: FrameBoltQuantity;
  readonly threadCompliance: FrameBoltQuantity; readonly headCompliance: FrameBoltQuantity; readonly bearingCompliance: FrameBoltQuantity;
  readonly section: FrameBoltSection;
}
export interface FrameBoltContactInput { readonly schema: 'pointercad-frame-bolt-contact/1'; readonly contact: BeamContactInput; readonly bolt: FrameBoltDeclaration }
export interface FrameBoltContactPlan { readonly schema: 'pointercad-frame-bolt-contact/1'; readonly contact: OofemContactPlan; readonly bolt: FrameBoltDeclaration & { readonly member: number } }
export type FrameBoltAssessment =
  | { readonly status: 'unevaluated'; readonly stressPa: number; readonly ratio: null }
  | { readonly status: 'zero-demand'; readonly stressPa: 0; readonly ratio: null }
  | { readonly status: 'compared'; readonly stressPa: number; readonly ratio: number };
export interface FrameBoltActions {
  readonly forceOnAN: Vector3; readonly forceOnBN: Vector3; readonly momentOnANm: Vector3; readonly momentOnBNm: Vector3;
  readonly axialForceN: number; readonly shearYN: number; readonly shearZN: number; readonly bendingYNm: number; readonly bendingZNm: number;
  readonly elasticEnergyJ: number; readonly transverseEnergyJ: number;
}
function fbFields(v: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = fields(v, keys);
  if (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null) throw new Error('frame-prototype');
  for (const key of keys) if (Object.getOwnPropertyDescriptor(row, key)?.get !== undefined
    || Object.getOwnPropertyDescriptor(row, key)?.set !== undefined) throw new Error('frame-accessor');
  return row;
}
function fbData(v: unknown, depth = 0): void {
  if (depth > 32) throw new Error('frame-depth');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('frame-number'); return; }
  if (typeof v !== 'object') throw new Error('frame-data');
  if (Array.isArray(v)) {
    if (!dense(v) || v.length > 10000) throw new Error('frame-array');
    for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, i); if (d?.get !== undefined || d?.set !== undefined) throw new Error('frame-accessor'); fbData(v[i], depth + 1); }
    return;
  }
  if (!record(v) || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) throw new Error('frame-data');
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== 'string') throw new Error('frame-key');
    const d = Object.getOwnPropertyDescriptor(v, key); if (d?.get !== undefined || d?.set !== undefined) throw new Error('frame-accessor');
    fbData(v[key], depth + 1);
  }
}
function fbText(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 2048 || v.trim() !== v || Array.from(v).some(character => character.charCodeAt(0) < 32)) throw new Error('frame-source');
  return v;
}
function fbNumber(v: unknown, zero = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || (zero ? v < 0 : v <= 1e-30) || v > 1e30) throw new Error('frame-number');
  return v;
}
function fbSource(v: unknown): FrameBoltSource {
  const r = fbFields(v, ['kind', 'reference', 'condition']);
  if (r.kind !== 'published' && r.kind !== 'measured' && r.kind !== 'user-supplied') throw new Error('frame-source');
  return { kind: r.kind, reference: fbText(r.reference), condition: fbText(r.condition) };
}
function fbQuantity(v: unknown, role: string, zero = false): FrameBoltQuantity {
  const r = fbFields(v, ['role', 'value', 'source']); if (r.role !== role) throw new Error('frame-quantity-role');
  return { role, value: fbNumber(r.value, zero), source: fbSource(r.source) };
}
function fbSection(v: unknown): FrameBoltSection {
  const r = fbFields(v, ['materialConditionId', 'tensileArea', 'shearArea', 'modulusY', 'modulusZ', 'fibreYM', 'fibreZM', 'limits']);
  let limits: FrameBoltLimits | null = null;
  if (r.limits !== null) {
    const l = fbFields(r.limits, ['classId', 'materialConditionId', 'tensionPa', 'shearPa', 'bendingPa', 'source']);
    limits = { classId: fbText(l.classId), materialConditionId: fbText(l.materialConditionId), tensionPa: fbNumber(l.tensionPa), shearPa: fbNumber(l.shearPa), bendingPa: fbNumber(l.bendingPa), source: fbSource(l.source) };
  }
  return { materialConditionId: fbText(r.materialConditionId), tensileArea: fbQuantity(r.tensileArea, 'tensile-area-m2'),
    shearArea: fbQuantity(r.shearArea, 'plain-shank-shear-area-m2'), modulusY: fbQuantity(r.modulusY, 'section-modulus-y-m3'), modulusZ: fbQuantity(r.modulusZ, 'section-modulus-z-m3'),
    fibreYM: fbQuantity(r.fibreYM, 'extreme-y-m'), fibreZM: fbQuantity(r.fibreZM, 'extreme-z-m'), limits };
}
export function readFrameBoltContact(value: unknown): { readonly input: FrameBoltContactInput; readonly plan: FrameBoltContactPlan } {
  fbData(value);
  const root = fbFields(value, ['schema', 'contact', 'bolt']); if (root.schema !== 'pointercad-frame-bolt-contact/1') throw new Error('frame-schema');
  const prepared = translateBeamContact(root.contact), b = fbFields(root.bolt, ['id', 'memberId', 'model', 'couplingSource', 'shorteningM', 'threadCompliance', 'headCompliance', 'bearingCompliance', 'section']);
  if (b.model !== 'centroidal-frame-shank-explicit-end-coupling') throw new Error('frame-model');
  if (prepared.input.geometry.modal?.segmentsPerMember !== 1) throw new Error('frame-subdivision: explicit unsplit shank required');
  const memberId = fbText(b.memberId), index = prepared.input.geometry.members.findIndex(m => m.id === memberId);
  const member = prepared.plan.members[index]; if (index < 0 || member === undefined) throw new Error('frame-member');
  const pairs = prepared.plan.members.filter(m => (m.nodes[0] === member.nodes[0] && m.nodes[1] === member.nodes[1]) || (m.nodes[0] === member.nodes[1] && m.nodes[1] === member.nodes[0]));
  if (pairs.length !== 1) throw new Error('frame-double-count');
  const bolt: FrameBoltDeclaration = { id: fbText(b.id), memberId, model: b.model, couplingSource: fbSource(b.couplingSource),
    shorteningM: fbQuantity(b.shorteningM, 'shortening-m', true), threadCompliance: fbQuantity(b.threadCompliance, 'thread-compliance-m-per-n', true),
    headCompliance: fbQuantity(b.headCompliance, 'head-compliance-m-per-n', true), bearingCompliance: fbQuantity(b.bearingCompliance, 'bearing-compliance-m-per-n', true), section: fbSection(b.section) };
  if (bolt.shorteningM.value >= member.frame.lengthM) throw new Error('frame-shortening');
  const section = prepared.plan.sections[member.section - 1], material = prepared.plan.materials[member.material - 1];
  const c = member.frame.lengthM / (material.youngPa * section.areaM2) + bolt.threadCompliance.value + bolt.headCompliance.value + bolt.bearingCompliance.value;
  fbNumber(c); fbNumber(1 / c);
  if (bolt.shorteningM.value > 0) fbNumber(bolt.shorteningM.value / c);
  if (bolt.section.tensileArea.value > section.areaM2 || !close(bolt.section.shearArea.value, section.areaM2)
    || !close(bolt.section.modulusY.value, section.iyM4 / bolt.section.fibreZM.value)
    || !close(bolt.section.modulusZ.value, section.izM4 / bolt.section.fibreYM.value)) throw new Error('frame-section-mismatch');
  return { input: { schema: root.schema, contact: prepared.input, bolt }, plan: { schema: root.schema, contact: prepared.plan, bolt: { ...bolt, member: member.number } } };
}
export async function frameBoltContactInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(readFrameBoltContact(value).input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
}
function fbVector(v: unknown): Vector3 {
  if (!dense(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e30)) throw new Error('frame-vector');
  return [Number(v[0]), Number(v[1]), Number(v[2])];
}
function fbCross(a: Vector3, b: Vector3): Vector3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
/** Constitutive verification, not a solver: no unknown displacements are solved here. */
export function frameBoltEndActions(plan: FrameBoltContactPlan, uA: Vector3, rA: Vector3, uB: Vector3, rB: Vector3): FrameBoltActions {
  const m = plan.contact.members[plan.bolt.member - 1], s = plan.contact.sections[m.section - 1], mat = plan.contact.materials[m.material - 1], L = m.frame.lengthM;
  const axes = [m.frame.x, m.frame.y, m.frame.z];
  const local = (v: Vector3): number[] => axes.map(a => a.reduce((sum, x, i) => sum + x * v[i], 0));
  const global = (v: readonly number[]): Vector3 => [0, 1, 2].map(i => axes.reduce((sum, a, j) => sum + a[i] * v[j], 0)).reduce<Vector3>((v, x, i) => i === 0 ? [x, v[1], v[2]] : i === 1 ? [v[0], x, v[2]] : [v[0], v[1], x], [0, 0, 0]);
  const a = [...local(fbVector(uA)), ...local(fbVector(rA))], b = [...local(fbVector(uB)), ...local(fbVector(rB))];
  const c = L / (mat.youngPa * s.areaM2) + plan.bolt.threadCompliance.value + plan.bolt.headCompliance.value + plan.bolt.bearingCompliance.value;
  const N = (b[0] - a[0] + plan.bolt.shorteningM.value) / c, G = mat.youngPa / (2 * (1 + mat.poisson));
  const qA = [-N, 0, 0, G * s.torsionM4 / L * (a[3] - b[3]), 0, 0], qB = [N, 0, 0, -qA[3], 0, 0];
  for (const [v, r, inertia, sign] of [[1, 5, s.izM4, 1], [2, 4, s.iyM4, -1]]) {
    const phi = 12 * mat.youngPa * inertia / (s.shearFactor * G * s.areaM2 * L * L);
    const k = 12 * mat.youngPa * inertia / ((1 + phi) * L ** 3), h = k * L / 2;
    const d = mat.youngPa * inertia / ((1 + phi) * L);
    qA[v] = k * (a[v] - b[v]) + sign * h * (a[r] + b[r]); qB[v] = -qA[v];
    qA[r] = sign * h * (a[v] - b[v]) + d * ((4 + phi) * a[r] + (2 - phi) * b[r]);
    qB[r] = sign * h * (a[v] - b[v]) + d * ((2 - phi) * a[r] + (4 + phi) * b[r]);
  }
  const transverse = qA.reduce((sum, x, i) => sum + (i === 0 ? 0 : x * a[i] + qB[i] * b[i]), 0) / 2;
  const energy = N * N * c / 2 + transverse;
  if (![...qA, ...qB, energy].every(Number.isFinite) || energy < -1e-12) throw new Error('frame-constitutive');
  return { forceOnAN: global(qA.slice(0, 3).map(x => -x)), forceOnBN: global(qB.slice(0, 3).map(x => -x)), momentOnANm: global(qA.slice(3).map(x => -x)), momentOnBNm: global(qB.slice(3).map(x => -x)),
    axialForceN: N, shearYN: qB[1], shearZN: qB[2], bendingYNm: Math.max(Math.abs(qA[4]), Math.abs(qB[4])), bendingZNm: Math.max(Math.abs(qA[5]), Math.abs(qB[5])), elasticEnergyJ: Math.max(0, energy), transverseEnergyJ: transverse };
}
export function assessFrameBoltSection(section: FrameBoltSection, action: FrameBoltActions): { readonly tension: FrameBoltAssessment; readonly shear: FrameBoltAssessment; readonly bending: FrameBoltAssessment } {
  const mode = (stressPa: number, limit: number | undefined): FrameBoltAssessment => {
    if (!Number.isFinite(stressPa) || stressPa < 0) throw new Error('frame-stress');
    if (section.limits === null || section.limits.materialConditionId !== section.materialConditionId || limit === undefined) return { status: 'unevaluated', stressPa, ratio: null };
    if (stressPa === 0) return { status: 'zero-demand', stressPa: 0, ratio: null };
    const ratio = limit / stressPa; if (!Number.isFinite(ratio)) throw new Error('frame-ratio');
    return { status: 'compared', stressPa, ratio };
  };
  return { tension: mode(Math.max(0, action.axialForceN) / section.tensileArea.value, section.limits?.tensionPa),
    shear: mode(Math.hypot(action.shearYN, action.shearZN) / section.shearArea.value, section.limits?.shearPa),
    bending: mode(action.bendingYNm / section.modulusY.value + action.bendingZNm / section.modulusZ.value, section.limits?.bendingPa) };
}
export function decodeFrameBoltContact(raw: unknown, value: unknown, hash: string) {
  fbData(raw); const prepared = readFrameBoltContact(value), root = fbFields(raw, ['schema', 'inputSha256', 'contact', 'states']);
  if (root.schema !== 'pointercad-frame-bolt-contact-result/1' || !/^[0-9a-f]{64}$/u.test(hash) || root.inputSha256 !== hash) throw new Error('frame-result-identity');
  const contact = decodeBeamContact(root.contact, prepared.input.contact, hash);
  if (!dense(root.states) || root.states.length !== contact.states.length) throw new Error('frame-stage-count');
  const m = prepared.plan.contact.members[prepared.plan.bolt.member - 1], pa = prepared.plan.contact.nodes[m.nodes[0] - 1].positionM, pb = prepared.plan.contact.nodes[m.nodes[1] - 1].positionM;
  const states = root.states.map((v, index) => {
    const row = fbFields(v, ['loadFactor', 'boltId', 'member', 'forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm', 'axialForceN', 'shearYN', 'shearZN', 'bendingYNm', 'bendingZNm', 'elasticEnergyJ', 'transverseEnergyJ']);
    const solved = contact.states[index], a = solved.nodes.find(n => n.number === m.nodes[0]), b = solved.nodes.find(n => n.number === m.nodes[1]);
    if (row.loadFactor !== solved.loadFactor || row.boltId !== prepared.input.bolt.id || row.member !== m.number || a === undefined || b === undefined) throw new Error('frame-stage-identity');
    const action = frameBoltEndActions(prepared.plan, a.displacementM, a.rotationRad, b.displacementM, b.rotationRad);
    for (const key of ['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const) {
      const actual = fbVector(row[key]); if (actual.some((x, i) => Math.abs(x - action[key][i]) > 1e-8)) throw new Error('frame-end-action');
    }
    for (const key of ['axialForceN', 'shearYN', 'shearZN', 'bendingYNm', 'bendingZNm', 'elasticEnergyJ', 'transverseEnergyJ'] as const) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Math.abs(Number(row[key]) - action[key]) > 1e-9 * Math.max(1, Math.abs(action[key]))) throw new Error('frame-constitutive');
    }
    const arm: Vector3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const mb = fbCross(arm, action.forceOnBN);
    for (let i = 0; i < 3; i++) if (Math.abs(action.forceOnAN[i] + action.forceOnBN[i]) > 1e-8 || Math.abs(action.momentOnANm[i] + action.momentOnBNm[i] + mb[i]) > 1e-8) throw new Error('frame-equilibrium');
    return { loadFactor: solved.loadFactor, boltId: prepared.input.bolt.id, member: m.number, ...action, assessment: assessFrameBoltSection(prepared.input.bolt.section, action) };
  });
  return { kind: 'frame-bolt-contact' as const, schema: 'pointercad-frame-bolt-contact-result/1' as const, inputSha256: hash, source: prepared.input.contact.geometry.source, analysisId: prepared.input.contact.geometry.id, analysisRevision: prepared.input.contact.geometry.revision, structuralCertification: false as const, nativeContactSolver: false as const, contact, states };
}
