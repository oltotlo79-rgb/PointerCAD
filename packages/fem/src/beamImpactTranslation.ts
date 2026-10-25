import type { Vector3 } from './analysisModel.js';
import type { BucklingRestraints } from './bucklingModel.js';
import { translateBeamModal, type OofemModalPlan } from './modalTranslation.js';
import {
  IMPACT_MAXIMUM_CONTACTS, IMPACT_MAXIMUM_OUTPUT_SAMPLES, IMPACT_MAXIMUM_STEPS,
  type BeamImpactContact, type BeamImpactHistory, type BeamImpactInitialVelocity, type BeamImpactInput, type BeamImpactSupport,
} from './beamImpactModel.js';

/** Plan for run_beam_impact (beamImpact.py validate_impact_plan). No load field exists: zero external load. */
export interface OofemImpactPlan extends Omit<OofemModalPlan, 'schema' | 'nodes' | 'modeCount'> {
  readonly schema: 'pointercad-oofem-impact-plan/1';
  readonly nodes: readonly (Omit<OofemModalPlan['nodes'][number], 'load'> & { readonly restrained: BucklingRestraints })[];
  readonly impact: {
    readonly timeStepS: number; readonly stepCount: number; readonly outputEvery: number;
    readonly contactStiffnessNPerM: number;
    readonly initialVelocity: readonly (readonly [number, number, number, number, number, number])[];
    readonly contacts: readonly { readonly node: number; readonly directionUnit: Vector3; readonly gapM: number }[];
  };
}

/** Solver-only refinement entry: plan node `number` lies at `fraction` from original node `start` to `end`. */
export interface ImpactRefinementEntry {
  readonly number: number; readonly start: number; readonly end: number; readonly fraction: number;
}

const unrestrained: BucklingRestraints = [false, false, false, false, false, false];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Exact own fields only: an inherited property never satisfies a required field. */
function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error(`impact-shape: ${path}`);
  }
  return value;
}
/** Dense arrays only: holes would be skipped by map/every and silently become defaults. */
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value
    || [...value].some(character => character.charCodeAt(0) < 32)) throw new Error(`impact-text: ${path}`);
  return value;
}
function list(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!dense(value) || value.length < minimum || value.length > maximum) throw new Error(`impact-size: ${path}`);
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`impact-number: ${path}`);
  return value === 0 ? 0 : value;
}
function vector(value: unknown, path: string): Vector3 {
  const items = list(value, path, 3, 3).map((item, index) => finite(item, `${path}[${index}]`));
  return [items[0], items[1], items[2]];
}
function count(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`impact-step: ${path}`);
  }
  return value;
}

function readHistory(value: unknown): BeamImpactHistory {
  const row = fields(value, ['timeStepS', 'stepCount', 'outputEvery'], 'history');
  const timeStepS = finite(row.timeStepS, 'history.timeStepS');
  if (timeStepS <= 0) throw new Error('impact-step: history.timeStepS must be positive');
  const stepCount = count(row.stepCount, 'history.stepCount', 1, IMPACT_MAXIMUM_STEPS);
  const outputEvery = count(row.outputEvery, 'history.outputEvery', 1, stepCount);
  if (Math.ceil(stepCount / outputEvery) + 1 > IMPACT_MAXIMUM_OUTPUT_SAMPLES) {
    throw new Error('impact-step: at most 101 output samples');
  }
  // The same derived step coefficients and total duration that beamImpact.py integrate admits.
  const derived = [timeStepS * timeStepS, 4 / (timeStepS * timeStepS), 4 / timeStepS, timeStepS / 2, timeStepS * stepCount];
  if (!derived.every(item => Number.isFinite(item) && item > 0)) {
    throw new Error('impact-step: time step coefficients or total duration are not representable');
  }
  return { timeStepS, stepCount, outputEvery };
}

/** Convex combination (1 - f) a + f b, which stays within [min(a, b), max(a, b)] without forming b - a. */
function interpolate(a: number, b: number, fraction: number): number {
  if (a === b) return a;
  const value = (1 - fraction) * a + fraction * b;
  if (!Number.isFinite(value)) throw new Error('impact-velocity: interpolated initial velocity is not representable');
  return value === 0 ? 0 : value;
}

/**
 * Derives, from the modal translation's own member order (each original member becomes segmentsPerMember
 * consecutive segments, interior nodes appended in order), where every interior node lies, and checks the
 * positions against the same interpolation. The modal plan and its schema are used unchanged.
 */
export function impactRefinementMap(plan: OofemModalPlan, originalMemberCount: number, segments: number): ImpactRefinementEntry[] {
  if (plan.members.length !== originalMemberCount * segments) throw new Error('impact-refinement: unexpected member count');
  const entries: ImpactRefinementEntry[] = [];
  for (let member = 0; member < originalMemberCount; member += 1) {
    const first = plan.members[member * segments];
    const last = plan.members[member * segments + segments - 1];
    const start = first.nodes[0];
    const end = last.nodes[1];
    if (start > plan.originalNodeCount || end > plan.originalNodeCount) throw new Error('impact-refinement: endpoint is not an original node');
    for (let segment = 1; segment < segments; segment += 1) {
      const number = plan.members[member * segments + segment - 1].nodes[1];
      const fraction = segment / segments;
      const node = plan.nodes[number - 1];
      const a = plan.nodes[start - 1].positionM;
      const b = plan.nodes[end - 1].positionM;
      if (number <= plan.originalNodeCount || node.number !== number
        || [0, 1, 2].some(axis => node.positionM[axis] !== a[axis] + fraction * (b[axis] - a[axis]))) {
        throw new Error('impact-refinement: interior node does not match the member interpolation');
      }
      entries.push({ number, start, end, fraction });
    }
  }
  if (entries.length !== plan.nodes.length - plan.originalNodeCount) throw new Error('impact-refinement: unmapped interior nodes');
  return entries;
}

/**
 * Explicit zero-load impact translation. Geometry goes through translateBeamModal unchanged; supports follow the
 * buckling rules (unrestrained geometry, explicit six-DOF masks on existing nodes); any geometry load is refused
 * because this analysis has zero external load. Buckling, transient and contact translations are not called or
 * changed, so their own rejections (including the nonzero reference load) are untouched. No dummy load is made.
 */
export function translateBeamImpact(value: unknown): { readonly input: BeamImpactInput; readonly plan: OofemImpactPlan } {
  const row = fields(value, ['schema', 'geometry', 'supports', 'initialVelocities', 'contacts', 'contactStiffnessNPerM', 'history'], '$');
  if (row.schema !== 'pointercad-beam-impact/1') throw new Error('impact-schema: unsupported input');
  let prepared: ReturnType<typeof translateBeamModal>;
  try {
    prepared = translateBeamModal(row.geometry);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('modal-load:')) {
      throw new Error('impact-load: external loads are not supported; the response starts from initial velocities only', { cause: error });
    }
    throw new Error(`impact-input: ${error instanceof Error ? error.message : 'invalid beam input'}`, { cause: error });
  }
  const document = prepared.document;
  const settings = document.modal;
  if (settings === undefined) throw new Error('impact-input: explicit modal refinement settings are required');
  if (document.constraints.length !== 0) throw new Error('impact-supports: geometry must be unrestrained; use explicit six-DOF supports');
  if (document.loads.length !== 0) throw new Error('impact-load: external loads are not supported; the response starts from initial velocities only');
  const originalIds = new Set(document.nodes.map(node => node.id));
  const supports: BeamImpactSupport[] = list(row.supports, 'supports', 1, 128).map((item, index) => {
    const support = fields(item, ['nodeId', 'restrained'], `supports[${index}]`);
    const nodeId = text(support.nodeId, `supports[${index}].nodeId`);
    const mask = support.restrained;
    if (!originalIds.has(nodeId) || !dense(mask) || mask.length !== 6
      || !mask.every((flag: unknown) => typeof flag === 'boolean') || !mask.some(Boolean)) {
      throw new Error('impact-supports: expected an existing node and six explicit boolean restraints');
    }
    return { nodeId, restrained: [mask[0] === true, mask[1] === true, mask[2] === true, mask[3] === true, mask[4] === true, mask[5] === true] };
  });
  const supportMap = new Map(supports.map(support => [support.nodeId, support.restrained]));
  if (supportMap.size !== supports.length) throw new Error('impact-supports: duplicate supports');
  const initialVelocities: BeamImpactInitialVelocity[] = list(row.initialVelocities, 'initialVelocities', 1, 128).map((item, index) => {
    const velocity = fields(item, ['nodeId', 'velocityMPerS'], `initialVelocities[${index}]`);
    return { nodeId: text(velocity.nodeId, `initialVelocities[${index}].nodeId`),
      velocityMPerS: vector(velocity.velocityMPerS, `initialVelocities[${index}].velocityMPerS`) };
  });
  const velocityMap = new Map(initialVelocities.map(item => [item.nodeId, item.velocityMPerS]));
  if (velocityMap.size !== initialVelocities.length) throw new Error('impact-velocity: duplicate node');
  for (const item of initialVelocities) {
    if (!originalIds.has(item.nodeId)) throw new Error('impact-velocity: unknown node');
    const restrained = supportMap.get(item.nodeId) ?? unrestrained;
    if ([0, 1, 2].some(axis => restrained[axis] && item.velocityMPerS[axis] !== 0)) {
      throw new Error('impact-velocity: a restrained translation has a nonzero initial velocity');
    }
  }
  if (!initialVelocities.some(item => item.velocityMPerS.some(component => component !== 0))) {
    throw new Error('impact-velocity: every initial velocity is zero');
  }
  const contacts: BeamImpactContact[] = list(row.contacts, 'contacts', 1, IMPACT_MAXIMUM_CONTACTS).map((item, index) => {
    const contact = fields(item, ['nodeId', 'directionUnit', 'gapM'], `contacts[${index}]`);
    const nodeId = text(contact.nodeId, `contacts[${index}].nodeId`);
    const directionUnit = vector(contact.directionUnit, `contacts[${index}].directionUnit`);
    const gapM = finite(contact.gapM, `contacts[${index}].gapM`);
    if (!originalIds.has(nodeId)) throw new Error('impact-contact: unknown node');
    if (Math.abs(Math.hypot(...directionUnit) - 1) > 1e-12) throw new Error('impact-contact: direction must be a unit vector');
    if (gapM < 0) throw new Error('impact-contact: the initial gap must be nonnegative');
    const restrained = supportMap.get(nodeId) ?? unrestrained;
    if ([0, 1, 2].every(axis => restrained[axis] || directionUnit[axis] === 0)) {
      throw new Error('impact-contact: the contact direction is fully restrained');
    }
    return { nodeId, directionUnit, gapM };
  });
  const contactStiffnessNPerM = finite(row.contactStiffnessNPerM, 'contactStiffnessNPerM');
  if (contactStiffnessNPerM <= 0) throw new Error('impact-stiffness: contact stiffness must be positive in N/m');
  const history = readHistory(row.history);
  const refinement = impactRefinementMap(prepared.plan, document.members.length, settings.segmentsPerMember);
  const byNumber = new Map(prepared.plan.nodes.map(node => [node.number, node]));
  const original = (number: number): Vector3 => {
    const node = byNumber.get(number);
    return (node === undefined ? undefined : velocityMap.get(node.id)) ?? [0, 0, 0];
  };
  const interior = new Map(refinement.map(entry => [entry.number, entry]));
  const translation = (number: number): Vector3 => {
    const entry = interior.get(number);
    if (entry === undefined) return original(number);
    const a = original(entry.start);
    const b = original(entry.end);
    return [interpolate(a[0], b[0], entry.fraction), interpolate(a[1], b[1], entry.fraction),
      interpolate(a[2], b[2], entry.fraction)];
  };
  const nodes = prepared.plan.nodes.map(node => ({ number: node.number, id: node.id, positionM: node.positionM,
    fixed: node.fixed, restrained: supportMap.get(node.id) ?? unrestrained }));
  const numberOf = new Map(nodes.map(node => [node.id, node.number]));
  const contactNode = (nodeId: string): number => {
    const number = numberOf.get(nodeId);
    if (number === undefined) throw new Error('impact-contact: unknown node');
    return number;
  };
  const velocityRow = (number: number): readonly [number, number, number, number, number, number] => {
    const v = translation(number);
    return [v[0], v[1], v[2], 0, 0, 0];
  };
  const plan: OofemImpactPlan = {
    schema: 'pointercad-oofem-impact-plan/1', nodes, materials: prepared.plan.materials, sections: prepared.plan.sections,
    members: prepared.plan.members, originalNodeCount: prepared.plan.originalNodeCount,
    normalizationLengthM: prepared.plan.normalizationLengthM,
    impact: {
      ...history, contactStiffnessNPerM,
      initialVelocity: nodes.map(node => velocityRow(node.number)),
      contacts: contacts.map(contact => ({ node: contactNode(contact.nodeId), directionUnit: contact.directionUnit, gapM: contact.gapM })),
    },
  };
  const input: BeamImpactInput = { schema: 'pointercad-beam-impact/1', geometry: document, supports, initialVelocities, contacts,
    contactStiffnessNPerM, history };
  return { input, plan };
}

export async function impactInputSha256(value: unknown): Promise<string> {
  const input = translateBeamImpact(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
