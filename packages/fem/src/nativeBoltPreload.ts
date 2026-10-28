import type { PropertySource, Vector3 } from './analysisModel.js';
import type { BeamBoltContactPlan } from './beamBoltContact.js';
import type { BoltPreloadDeclaration } from './boltPreloadStages.js';
import { decodeContactNumericResult, type BeamContactNumericResult } from './contactModel.js';
import type { OofemContactPlan } from './contactTranslation.js';

type NativeContactPlan = Omit<OofemContactPlan, 'members'> & { readonly members: readonly Pick<OofemContactPlan['members'][number], 'number' | 'nodes' | 'material' | 'section' | 'frame'>[] };
type NativeBoltPlan = Omit<BeamBoltContactPlan, 'contact'> & { readonly contact: NativeContactPlan };

export interface NativeBoltPreloadPlan {
  readonly schema: 'pointercad-native-bolt-preload-plan/1';
  readonly boltPlan: NativeBoltPlan;
  readonly shorteningM: number;
  readonly declaration: BoltPreloadDeclaration;
}
export interface PreparedNativeBoltPreload {
  readonly plan: NativeBoltPreloadPlan; readonly encoded: string; readonly inputSha256: string;
  readonly cb: number; readonly cm: number; readonly normal: Vector3; readonly momentLengthM: number;
}
export interface NativeBoltPreloadState {
  readonly stage: 'tightening' | 'external'; readonly externalLoadN: number; readonly boltId: string;
  readonly extensionM: number; readonly elasticExtensionM: number; readonly boltTensionN: number;
  readonly memberCompressionN: number; readonly gapM: number; readonly boltEnergyJ: number; readonly memberEnergyJ: number;
  readonly supportReactions: readonly { readonly number: number; readonly forceN: Vector3 }[];
}
export interface NativeBoltPreloadResult {
  readonly schema: 'pointercad-native-bolt-preload-result/1';
  readonly method: 'native-beam3d-plus-series-bolt-and-existing-lcp';
  readonly nativeContactSolver: false; readonly structuralCertification: false; readonly planSha256: string;
  readonly lockedShorteningM: number; readonly lockAfterState: 0;
  readonly boltComplianceMPerN: number; readonly memberComplianceMPerN: number;
  readonly contact: BeamContactNumericResult; readonly states: readonly NativeBoltPreloadState[];
}
const preparedRecords = new WeakSet<object>();
function fail(): never { throw new Error('native-preload-boundary'); }
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function fields(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(v) || Reflect.ownKeys(v).length !== keys.length
    || keys.some(k => !Object.hasOwn(v, k))) fail();
  return v;
}
function list(v: unknown, low: number, high = low): unknown[] {
  if (!Array.isArray(v) || v.length < low || v.length > high || Reflect.ownKeys(v).length !== v.length + 1
    || Array.from({ length: v.length }, (_, i) => !Object.hasOwn(v, i)).some(Boolean)) fail();
  return v;
}
function num(v: unknown, low = -1e30, high = 1e30): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high) fail(); return v;
}
function positive(v: unknown): number { const n = num(v, 0); if (!(n > 1e-30)) fail(); return n; }
function integer(v: unknown, low: number, high: number): number { const n = num(v, low, high); if (!Number.isSafeInteger(n)) fail(); return n; }
function text(v: unknown, limit: number): string {
  if (typeof v !== 'string' || !v.length || v.length > limit || v.trim() !== v || [...v].some(c => c.charCodeAt(0) < 32)) fail(); return v;
}
function vec(v: unknown, limit = 1e30): Vector3 { const a = list(v, 3); return [num(a[0], -limit, limit), num(a[1], -limit, limit), num(a[2], -limit, limit)]; }
function dot(a: readonly number[], b: readonly number[]): number { return a.reduce((s, x, i) => s + x * b[i], 0); }
function sub(a: Vector3, b: Vector3): Vector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function near(actual: unknown, expected: number, scale = Math.abs(expected)): number {
  const value = num(actual); if (Math.abs(value - expected) > 1e-9 * Math.abs(expected) + 64 * Number.EPSILON * Math.abs(scale)) fail(); return value;
}
function jsonTree(value: unknown, depth = 0): void {
  if (depth > 64) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { num(value, -Number.MAX_VALUE, Number.MAX_VALUE); return; }
  if (Array.isArray(value)) { for (const v of list(value, 0, 100000)) jsonTree(v, depth + 1); return; }
  if (typeof value !== 'object' || value === null) fail();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) fail();
  for (const key of Object.keys(value)) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d)) fail(); jsonTree(d.value, depth + 1); }
}
function freeze(value: object): void { const children: unknown[] = Object.values(value); for (const v of children) if (v !== null && typeof v === 'object') freeze(v); Object.freeze(value); }
function source(v: unknown): PropertySource {
  const r = fields(v, ['kind', 'reference', 'condition']);
  if (r.kind !== 'user-supplied' && r.kind !== 'measured' && r.kind !== 'published') fail();
  return { kind: r.kind, reference: text(r.reference, 2048), condition: text(r.condition, 1024) };
}
function sourced(v: unknown, strict = false) { const r = fields(v, ['value', 'source']); return { value: strict ? positive(r.value) : num(r.value, 0), source: source(r.source) }; }
function declaration(v: unknown): BoltPreloadDeclaration {
  const r = fields(v, ['boltId', 'model', 'modelSource', 'shankSource', 'shorteningSource', 'preloadN', 'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'externalLoadsN', 'loadSource']);
  if (r.model !== 'coaxial-outer-planes-series-bearing') fail();
  return { boltId: text(r.boltId, 64), model: r.model, modelSource: source(r.modelSource), shankSource: source(r.shankSource), shorteningSource: source(r.shorteningSource),
    preloadN: sourced(r.preloadN, true), threadCompliance: sourced(r.threadCompliance), headCompliance: sourced(r.headCompliance), bearingCompliance: sourced(r.bearingCompliance),
    memberCompliance: sourced(r.memberCompliance, true), externalLoadsN: list(r.externalLoadsN, 1, 31).map(x => num(x, 0, 1e6)), loadSource: source(r.loadSource) };
}
function readPlan(value: unknown): NativeBoltPreloadPlan {
  jsonTree(value);
  const r = fields(value, ['schema', 'boltPlan', 'shorteningM', 'declaration']); if (r.schema !== 'pointercad-native-bolt-preload-plan/1') fail();
  const b = fields(r.boltPlan, ['schema', 'contact', 'bolts']); if (b.schema !== 'pointercad-bolt-contact-plan/1') fail();
  const c = fields(b.contact, ['schema', 'nodes', 'materials', 'sections', 'members', 'originalNodeCount', 'contacts', 'loadFactors']);
  if (c.schema !== 'pointercad-oofem-contact-plan/1' || c.originalNodeCount !== 4) fail();
  const nodes: OofemContactPlan['nodes'] = list(c.nodes, 4).map((v, i) => {
    const n = fields(v, ['number', 'positionM', 'restrained', 'load']); if (n.number !== i + 1) fail();
    const fixed = list(n.restrained, 6); if (!fixed.every(x => typeof x === 'boolean')) fail();
    const loads = list(n.load, 6).map(x => num(x));
    return { number: i + 1, positionM: vec(n.positionM, 1e9), restrained: [fixed[0] === true, fixed[1] === true, fixed[2] === true, fixed[3] === true, fixed[4] === true, fixed[5] === true], load: [loads[0], loads[1], loads[2], loads[3], loads[4], loads[5]] };
  });
  const materials = list(c.materials, 1, 2).map((v, i) => { const m = fields(v, ['number', 'youngPa', 'poisson', 'densityKgM3']); if (m.number !== i + 1) fail(); const poisson = num(m.poisson); if (!(poisson > -1 && poisson < .5)) fail(); return { number: i + 1, youngPa: positive(m.youngPa), poisson, densityKgM3: positive(m.densityKgM3) }; });
  const sections = list(c.sections, 1, 2).map((v, i) => { const s = fields(v, ['number', 'areaM2', 'iyM4', 'izM4', 'torsionM4', 'shearFactor']); if (s.number !== i + 1) fail(); return { number: i + 1, areaM2: positive(s.areaM2), iyM4: positive(s.iyM4), izM4: positive(s.izM4), torsionM4: positive(s.torsionM4), shearFactor: positive(s.shearFactor) }; });
  const members: NativeContactPlan['members'] = list(c.members, 2).map((v, i) => {
    const m = fields(v, ['number', 'nodes', 'material', 'section', 'frame']); if (m.number !== i + 1) fail();
    const ends = list(m.nodes, 2).map(x => integer(x, 1, 4)); if (ends[0] === ends[1]) fail();
    const f = fields(m.frame, ['x', 'y', 'z', 'lengthM']); const x = vec(f.x), y = vec(f.y), z = vec(f.z), lengthM = positive(f.lengthM);
    const delta = sub(nodes[ends[1] - 1].positionM, nodes[ends[0] - 1].positionM), length = Math.hypot(...delta);
    if (length <= 1e-9 || Math.abs(lengthM - length) > 1e-12 * length || [x, y, z].some(a => Math.abs(dot(a, a) - 1) > 1e-10)
      || Math.max(Math.abs(dot(x, y)), Math.abs(dot(y, z)), Math.abs(dot(z, x))) > 1e-10 || x.some((a, j) => Math.abs(a - delta[j] / length) > 1e-10)) fail();
    const cross: Vector3 = [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
    if (cross.some((v, j) => Math.abs(v - z[j]) > 1e-10)) fail();
    return { number: i + 1, nodes: [ends[0], ends[1]], material: integer(m.material, 1, materials.length), section: integer(m.section, 1, sections.length), frame: { x, y, z, lengthM } };
  });
  const p = fields(list(c.contacts, 1)[0], ['id', 'kind', 'nodeA', 'nodeB', 'normal', 'gapM']);
  if (p.kind !== 'node-pair' || p.gapM !== 0) fail();
  const pair = { id: text(p.id, 64), kind: 'node-pair' as const, nodeA: integer(p.nodeA, 1, 4), nodeB: integer(p.nodeB, 1, 4), normal: vec(p.normal), gapM: 0 };
  const bolt = fields(list(b.bolts, 1)[0], ['id', 'nodeA', 'nodeB', 'youngPa', 'areaM2']);
  const bolts = [{ id: text(bolt.id, 64), nodeA: integer(bolt.nodeA, 1, 4), nodeB: integer(bolt.nodeB, 1, 4), youngPa: positive(bolt.youngPa), areaM2: positive(bolt.areaM2) }];
  return { schema: r.schema, shorteningM: positive(r.shorteningM), declaration: declaration(r.declaration), boltPlan: { schema: b.schema, bolts, contact: { schema: c.schema, nodes, materials, sections, members, originalNodeCount: 4, contacts: [pair], loadFactors: list(c.loadFactors, 2, 32).map(x => num(x, 0, 1e6)) } } };
}
export async function prepareNativeBoltPreload(value: unknown, exactJson?: string): Promise<PreparedNativeBoltPreload> {
  const plan = readPlan(value), c = plan.boltPlan.contact, bolt = plan.boltPlan.bolts[0], pair = c.contacts[0];
  if (pair.kind !== 'node-pair' || new Set([bolt.nodeA, bolt.nodeB, pair.nodeA, pair.nodeB]).size !== 4 || bolt.id !== plan.declaration.boltId) fail();
  const a = c.nodes[bolt.nodeA - 1].positionM, b = c.nodes[bolt.nodeB - 1].positionM, delta = sub(b, a), length = Math.hypot(...delta);
  if (length <= 1e-9) fail(); const normal: Vector3 = [delta[0]/length, delta[1]/length, delta[2]/length];
  const axis = normal.findIndex(v => Math.abs(v) > 1 - 1e-12);
  if (axis < 0 || normal.some((v, i) => i !== axis && Math.abs(v) > 1e-12) || pair.normal.some((v, i) => Math.abs(v - normal[i]) > 1e-10)) fail();
  for (const node of c.nodes) {
    if (node.restrained.some((fixed, i) => fixed !== (node.number === bolt.nodeA || i !== axis))) fail();
    const load = node.number === bolt.nodeB ? [...normal, 0, 0, 0] : [0, 0, 0, 0, 0, 0]; if (node.load.some((v, i) => v !== load[i])) fail();
    const d = sub(node.positionM, a), station = dot(d, normal); if (Math.hypot(...d.map((v, i) => v - station*normal[i])) > 1e-10*length) fail();
  }
  const left = dot(sub(c.nodes[pair.nodeA - 1].positionM, a), normal), right = dot(sub(c.nodes[pair.nodeB - 1].positionM, a), normal);
  if (!(left > 0 && left < length) || Math.abs(left - right) > 1e-10*length) fail();
  const key = (a: number, b: number): string => [a, b].sort((a, b) => a - b).join(':');
  const expected = new Set([key(bolt.nodeA, pair.nodeA), key(pair.nodeB, bolt.nodeB)]);
  if (new Set(c.members.map(m => key(...m.nodes))).size !== 2 || c.members.some(m => !expected.has(key(...m.nodes)))) fail();
  const cb = positive(length/(bolt.youngPa*bolt.areaM2) + plan.declaration.threadCompliance.value + plan.declaration.headCompliance.value + plan.declaration.bearingCompliance.value);
  const cm = positive(c.members.reduce((s, m) => s + m.frame.lengthM/(c.materials[m.material-1].youngPa*c.sections[m.section-1].areaM2), 0));
  near(plan.declaration.memberCompliance.value, cm);
  const required = positive(plan.declaration.preloadN.value*(cb+cm)); if (required >= length || plan.shorteningM >= length) fail(); near(plan.shorteningM, required);
  const factors = [0, ...plan.declaration.externalLoadsN]; if (c.loadFactors.length !== factors.length || c.loadFactors.some((v, i) => v !== factors[i])) fail();
  const encoded = exactJson ?? JSON.stringify(plan); if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > 4_000_000 || JSON.stringify(readPlan(JSON.parse(encoded))) !== JSON.stringify(plan)) fail();
  const inputSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), b => b.toString(16).padStart(2, '0')).join('');
  const prepared = { plan, encoded, inputSha256, cb, cm, normal, momentLengthM: Math.max(...c.members.map(m => m.frame.lengthM)) };
  freeze(prepared); preparedRecords.add(prepared); return prepared;
}

export function decodeNativeBoltPreload(raw: unknown, prepared: PreparedNativeBoltPreload): NativeBoltPreloadResult {
  if (!preparedRecords.has(prepared)) fail(); jsonTree(raw);
  const r = fields(raw, ['schema', 'method', 'nativeContactSolver', 'structuralCertification', 'lockedShorteningM', 'lockAfterState', 'boltComplianceMPerN', 'memberComplianceMPerN', 'contact', 'states', 'planSha256']);
  const { plan, cb, cm, normal } = prepared, c = plan.boltPlan.contact, bolt = plan.boltPlan.bolts[0], pair = c.contacts[0];
  if (pair.kind !== 'node-pair' || r.schema !== 'pointercad-native-bolt-preload-result/1' || r.method !== 'native-beam3d-plus-series-bolt-and-existing-lcp' || r.nativeContactSolver !== false || r.structuralCertification !== false || r.planSha256 !== prepared.inputSha256 || r.lockAfterState !== 0 || r.lockedShorteningM !== plan.shorteningM) fail();
  near(r.boltComplianceMPerN, cb); near(r.memberComplianceMPerN, cm);
  const contact = decodeContactNumericResult(r.contact, { contacts: c.contacts, loadFactors: c.loadFactors, nodeNumbers: c.nodes.map(n => n.number), meshNodes: 4, meshElements: 2, momentLengthM: prepared.momentLengthM });
  if (!contact || contact.freeDofs !== 3) fail();
  const states = list(r.states, contact.states.length).map((value, index): NativeBoltPreloadState => {
    const row = fields(value, ['stage', 'externalLoadN', 'boltId', 'extensionM', 'elasticExtensionM', 'boltTensionN', 'memberCompressionN', 'gapM', 'boltEnergyJ', 'memberEnergyJ', 'supportReactions']);
    const solved = contact.states[index], p = c.loadFactors[index], stage = index === 0 ? 'tightening' : 'external';
    if (row.stage !== stage || row.externalLoadN !== p || row.boltId !== bolt.id) fail();
    solved.nodes.forEach((n, i) => { if ([...n.displacementM, ...n.rotationRad].some((v, j) => c.nodes[i].restrained[j] && v !== 0)) fail(); });
    const u = solved.nodes.map(n => n.displacementM), extension = dot(sub(u[bolt.nodeB-1], u[bolt.nodeA-1]), normal), n = (extension+plan.shorteningM)/cb, q = solved.contacts[0].normalReactionN;
    if (n < 0) fail(); const forceScale = Math.max(n, p, plan.declaration.preloadN.value);
    const extensionM = near(row.extensionM, extension, plan.shorteningM), elasticExtensionM = near(row.elasticExtensionM, extension+plan.shorteningM, plan.shorteningM);
    const boltTensionN = near(row.boltTensionN, n, forceScale), memberCompressionN = near(row.memberCompressionN, q, forceScale), gapM = near(row.gapM, solved.contacts[0].gapM, plan.shorteningM);
    near(gapM, dot(sub(u[pair.nodeB-1], u[pair.nodeA-1]), pair.normal), plan.shorteningM); near(n-q, p, forceScale);
    const force: number[][] = Array.from({ length: 4 }, () => [0,0,0]); let memberEnergy = 0;
    for (const member of c.members) {
      const [a,b] = member.nodes, eaL = c.materials[member.material-1].youngPa*c.sections[member.section-1].areaM2/member.frame.lengthM;
      const du = dot(sub(u[b-1], u[a-1]), member.frame.x); memberEnergy += eaL*du*du/2;
      for (let j=0;j<3;j++) { const f = eaL*du*member.frame.x[j]; force[a-1][j] -= f; force[b-1][j] += f; }
    }
    for (let j=0;j<3;j++) { force[bolt.nodeA-1][j] -= n*normal[j]; force[bolt.nodeB-1][j] += n*normal[j]; force[pair.nodeA-1][j] += q*normal[j]; force[pair.nodeB-1][j] -= q*normal[j]; }
    const supportReactions = list(row.supportReactions,4).map((v,i) => { const reaction = fields(v,['number','forceN']); if (reaction.number !== i+1) fail(); const f=vec(reaction.forceN); for(let j=0;j<3;j++){ const residual=force[i][j]-p*c.nodes[i].load[j]; near(f[j],c.nodes[i].restrained[j]?residual:0,forceScale); if(!c.nodes[i].restrained[j])near(residual,0,forceScale); } return { number:i+1, forceN:f }; });
    return { stage, externalLoadN:p, boltId:bolt.id, extensionM, elasticExtensionM, boltTensionN, memberCompressionN, gapM, boltEnergyJ:near(row.boltEnergyJ,cb*n*n/2,forceScale*plan.shorteningM), memberEnergyJ:near(row.memberEnergyJ,memberEnergy,forceScale*plan.shorteningM), supportReactions };
  });
  near(states[0].boltTensionN,plan.declaration.preloadN.value);
  return { schema:'pointercad-native-bolt-preload-result/1',method:'native-beam3d-plus-series-bolt-and-existing-lcp',nativeContactSolver:false,structuralCertification:false,planSha256:prepared.inputSha256,lockedShorteningM:plan.shorteningM,lockAfterState:0,boltComplianceMPerN:cb,memberComplianceMPerN:cm,contact,states };
}
