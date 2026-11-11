import { sha256Hex } from './sha256.js';
import type { Vector3, Vector6 } from './analysisModel.js';
import type { BeamContactInput } from './contactModel.js';
import { translateBeamContact, type OofemContactPlan } from './contactTranslation.js';
import { decodeBeamContact } from './contactResults.js';
import type { WeldLayerGeometry } from './beamWeldContact.js';
import { prepareWeldSpan, type WeldSpanPatch, type WeldSpanSide } from './beamWeldSpan.js';

export type BeamWeldSpanSide = { readonly kind: 'section-node'; readonly memberId: string; readonly nodeId: string }
  | { readonly kind: 'member-span'; readonly memberId: string };
export interface BeamWeldSpanPatch extends WeldLayerGeometry {
  readonly first: BeamWeldSpanSide;
  readonly second: BeamWeldSpanSide;
}
export interface BeamWeldSpanContactInput {
  readonly schema: 'pointercad-weld-span/1';
  readonly contact: BeamContactInput;
  readonly patches: readonly BeamWeldSpanPatch[];
}
export interface BeamWeldSpanContactPlan {
  readonly schema: 'pointercad-weld-span-plan/1';
  readonly contact: OofemContactPlan;
  readonly patches: readonly WeldSpanPatch[];
}
function fail(): never { throw new Error('weld-span-contact: invalid input, result or ownership'); }
/** Check descriptors before reading any value; neither sparse arrays nor executable accessors are data. */
function snapshot(value: unknown): unknown {
  // Covers all 32 factors x 64 patches x two 128-node six-DOF scatter arrays, including containers.
  let budget = 4_000_000;
  function check(v: unknown, depth: number): void {
    if (--budget < 0 || depth > 24) fail();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > 1e30) fail(); return; }
    if (typeof v !== 'object') fail();
    if (Array.isArray(v)) {
      if (v.length > 4096 || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length+1) fail();
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d === undefined || !('value' in d) || !d.enumerable) fail();
        check(d.value, depth+1);
      }
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail();
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (typeof key !== 'string' || d === undefined || !('value' in d) || !d.enumerable) fail();
        check(d.value, depth+1);
      }
    }
  }
  check(value, 0);
  return structuredClone(value);
}
function fields(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)
    || Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail();
  return v as Record<string, unknown>;
}
function list(v: unknown, count: number): unknown[] {
  if (!Array.isArray(v) || v.length !== count) return fail();
  return v;
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 256 || v.trim() !== v) return fail();
  return v;
}
function number(v: unknown): number { if (typeof v !== 'number' || !Number.isFinite(v)) return fail(); return v; }
function vector(v: unknown): Vector3 { const a = list(v, 3).map(number); return [a[0], a[1], a[2]]; }
function mesh(plan: OofemContactPlan) {
  const { nodes, members, materials, sections, originalNodeCount } = plan;
  return { nodes, members, materials, sections, originalNodeCount };
}
/** Separate span schema; the old endpoint input and its decoder are unchanged. */
export function translateBeamWeldSpanContact(value: unknown): {
  readonly input: BeamWeldSpanContactInput; readonly plan: BeamWeldSpanContactPlan;
} {
  const row = fields(snapshot(value), ['schema', 'contact', 'patches']);
  if (row.schema !== 'pointercad-weld-span/1' || !Array.isArray(row.patches)
    || !row.patches.length || row.patches.length > 64) fail();
  const contact = translateBeamContact(row.contact);
  function side(v: unknown): { input: BeamWeldSpanSide; plan: WeldSpanSide } {
    if (typeof v !== 'object' || v === null || !('kind' in v)) return fail();
    const s = fields(v, v.kind === 'section-node' ? ['kind', 'memberId', 'nodeId'] : ['kind', 'memberId']);
    const memberId = text(s.memberId), member = contact.input.geometry.members.find(m => m.id === memberId);
    if (member === undefined) return fail();
    if (s.kind === 'member-span') return { input: { kind: 'member-span', memberId }, plan: { kind: 'span', memberId } };
    if (s.kind !== 'section-node') return fail();
    const nodeId = text(s.nodeId), index = contact.nodeIds.indexOf(nodeId);
    if (index < 0 || (member.startNodeId !== nodeId && member.endNodeId !== nodeId)) return fail();
    return { input: { kind: 'section-node', memberId, nodeId }, plan: { kind: 'section', node: contact.plan.nodes[index].number } };
  }
  const patches: BeamWeldSpanPatch[] = [], translated: WeldSpanPatch[] = [];
  for (const v of row.patches) {
    const p = fields(v, ['id', 'centerM', 'normal', 'along', 'widthM', 'lengthM', 'thicknessM', 'youngPa', 'poisson', 'first', 'second']);
    const first = side(p.first), second = side(p.second);
    // Distinct endpoints of the same saved member are not two different physical sides.
    if (first.input.memberId === second.input.memberId) fail();
    const geometry: WeldLayerGeometry = { id: text(p.id), centerM: vector(p.centerM), normal: vector(p.normal), along: vector(p.along),
      widthM: number(p.widthM), lengthM: number(p.lengthM), thicknessM: number(p.thicknessM), youngPa: number(p.youngPa), poisson: number(p.poisson) };
    patches.push({ ...geometry, first: first.input, second: second.input });
    translated.push({ ...geometry, first: first.plan, second: second.plan });
  }
  prepareWeldSpan({ mesh: mesh(contact.plan), patches: translated });
  return { input: { schema: 'pointercad-weld-span/1', contact: contact.input, patches },
    plan: { schema: 'pointercad-weld-span-plan/1', contact: contact.plan, patches: translated } };
}
async function digest(input: BeamWeldSpanContactInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  return await sha256Hex(bytes);
}
export async function beamWeldSpanContactInputSha256(value: unknown): Promise<string> {
  return digest(translateBeamWeldSpanContact(value).input);
}
function close(actual: number, expected: number, scale: number): void {
  if (Math.abs(actual-expected) > 1e-8*Math.max(Math.abs(actual), Math.abs(expected), scale, 1e-300)) fail();
}
type WeldResult = ReturnType<ReturnType<typeof prepareWeldSpan>['evaluate']>[number];

/** Snapshots input and reply before awaiting SHA. All mesh DOFs are mandatory, including internal nodes.
 * This is a result consistency boundary, not an independent native equilibrium solve or certification. */
export async function decodeBeamWeldSpanContact(raw: unknown, value: unknown, inputSha256: string) {
  const { input, plan } = translateBeamWeldSpanContact(value);
  const row = fields(snapshot(raw), ['schema', 'contact', 'states']);
  if (row.schema !== 'pointercad-weld-span-result/1' || await digest(input) !== inputSha256) fail();
  const contact = decodeBeamContact(row.contact, input.contact, inputSha256);
  if (contact.freeDofs !== plan.contact.nodes.reduce((sum, n) => sum+n.restrained.filter(fixed => !fixed).length, 0)) fail();
  const kernel = prepareWeldSpan({ mesh: mesh(plan.contact), patches: plan.patches });
  const states = list(row.states, plan.contact.loadFactors.length).map((v, si) => {
    const state = fields(v, ['loadFactor', 'meshNodes', 'welds']);
    if (state.loadFactor !== plan.contact.loadFactors[si]) fail();
    const meshNodes = list(state.meshNodes, plan.contact.nodes.length).map((n, ni) => {
      const node = fields(n, ['number', 'displacementM', 'rotationRad']);
      if (node.number !== plan.contact.nodes[ni].number) fail();
      const displacementM = vector(node.displacementM), rotationRad = vector(node.rotationRad);
      const motion = [...displacementM, ...rotationRad];
      if (plan.contact.nodes[ni].restrained.some((fixed, axis) => fixed && motion[axis] !== 0)) fail();
      if (ni < plan.contact.originalNodeCount) {
        const original = contact.states[si].nodes[ni];
        if ([...original.displacementM, ...original.rotationRad].some((x, axis) => x !== motion[axis])) fail();
      }
      return { number: plan.contact.nodes[ni].number, displacementM, rotationRad };
    });
    const motions: Vector6[] = meshNodes.map(n => [...n.displacementM, ...n.rotationRad]);
    // The old numeric decoder checks residuals and contact status. Bind its gaps to the very same mesh solution too.
    for (const [ci, c] of plan.contact.contacts.entries()) {
      const a = meshNodes[(c.kind === 'node-plane' ? c.node : c.nodeA)-1].displacementM;
      const b: Vector3 = c.kind === 'node-plane' ? [0, 0, 0] : meshNodes[c.nodeB-1].displacementM;
      const gap = c.gapM+c.normal.reduce((sum, x, axis) => sum+x*(c.kind === 'node-plane' ? a[axis] : b[axis]-a[axis]), 0);
      close(contact.states[si].contacts[ci].gapM, gap, contact.states[si].gapScaleM);
    }
    const expected = kernel.evaluate(motions);
    const welds = list(state.welds, expected.length).map((w, wi): WeldResult => {
      const r = fields(w, ['id', 'first', 'second', 'forceOnFirstN', 'momentAtCenterNm', 'energyJ', 'structuralCertification']);
      const e = expected[wi];
      if (r.id !== e.id || r.structuralCertification !== false) fail();
      const forceScale = Math.max(Math.hypot(...e.forceOnFirstN), ...e.first.map(n => Math.hypot(...n.slice(0, 3))));
      const momentScale = Math.max(Math.hypot(...e.momentAtCenterNm), forceScale*Math.max(...plan.contact.members.map(m => m.frame.lengthM)));
      const nodal = (data: unknown, target: number[][]): number[][] => list(data, target.length).map((n, ni) =>
        list(n, 6).map((x, axis) => { const a = number(x); close(a, target[ni][axis], axis < 3 ? forceScale : momentScale); return a; }));
      const first = nodal(r.first, e.first), second = nodal(r.second, e.second);
      const forceOnFirstN = vector(r.forceOnFirstN), momentAtCenterNm = vector(r.momentAtCenterNm), energyJ = number(r.energyJ);
      forceOnFirstN.forEach((x, axis) => close(x, e.forceOnFirstN[axis], forceScale));
      momentAtCenterNm.forEach((x, axis) => close(x, e.momentAtCenterNm[axis], momentScale));
      if (energyJ < 0) fail();
      close(energyJ, e.energyJ, 0);
      return { id: e.id, first, second, forceOnFirstN, momentAtCenterNm, energyJ, structuralCertification: false };
    });
    return { loadFactor: plan.contact.loadFactors[si], meshNodes, welds };
  });
  return { kind: 'oofem-beam-weld-span-contact' as const, schema: 'pointercad-weld-span-result/1' as const,
    inputSha256, structuralCertification: false as const, contact, states };
}
