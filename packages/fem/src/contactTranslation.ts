import { translateBeamBuckling, type OofemBucklingPlan } from './bucklingTranslation.js';
import { contactPlanContacts, validateBeamContacts, type BeamContactDefinition, type BeamContactInput,
  type ContactPlanContact } from './contactModel.js';
import type { Vector3 } from './analysisModel.js';

/** Exactly the plan beamContact.validate_contact_plan accepts: no buckling node id/fixed, no modeCount or
 * normalizationLengthM (the Python entry refuses unknown fields). */
export interface OofemContactPlan {
  readonly schema: 'pointercad-oofem-contact-plan/1';
  readonly nodes: readonly { readonly number: number; readonly positionM: Vector3;
    readonly restrained: OofemBucklingPlan['nodes'][number]['restrained']; readonly load: OofemBucklingPlan['nodes'][number]['load'] }[];
  readonly materials: OofemBucklingPlan['materials'];
  readonly sections: OofemBucklingPlan['sections'];
  readonly members: OofemBucklingPlan['members'];
  readonly originalNodeCount: number;
  readonly contacts: readonly ContactPlanContact[];
  readonly loadFactors: readonly number[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !(name in value))) {
    throw new Error(`contact-shape: ${path}`);
  }
  return value;
}
/** Unknown runtime data: holes are refused (map/every skip them), like denseArray in transientResults.ts. */
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}
function vector(value: unknown, path: string): Vector3 {
  if (!dense(value) || value.length !== 3 || !value.every(item => typeof item === 'number')) {
    throw new Error(`contact-number: ${path}`);
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`contact-shape: ${path}`);
  return value;
}
function number(value: unknown, path: string): number {
  if (typeof value !== 'number') throw new Error(`contact-number: ${path}`);
  return value;
}

/** Strict shape reader; values are checked by validateBeamContacts afterwards (same order as the Python core). */
function readContacts(value: unknown): BeamContactDefinition[] {
  if (!dense(value)) throw new Error('contact-shape: contacts');
  return value.map((item: unknown, index): BeamContactDefinition => {
    const path = `contacts[${index}]`;
    if (record(item) && item.kind === 'node-plane') {
      const row = fields(item, ['kind', 'id', 'nodeId', 'normal', 'gapM'], path);
      return { kind: 'node-plane', id: text(row.id, path + '.id'), nodeId: text(row.nodeId, path + '.nodeId'),
        normal: vector(row.normal, path + '.normal'), gapM: number(row.gapM, path + '.gapM') };
    }
    const row = fields(item, ['kind', 'id', 'nodeIdA', 'nodeIdB', 'normal', 'gapM'], path);
    if (row.kind !== 'node-pair') throw new Error(`contact-shape: ${path}.kind`);
    return { kind: 'node-pair', id: text(row.id, path + '.id'), nodeIdA: text(row.nodeIdA, path + '.nodeIdA'),
      nodeIdB: text(row.nodeIdB, path + '.nodeIdB'), normal: vector(row.normal, path + '.normal'),
      gapM: number(row.gapM, path + '.gapM') };
  });
}

/** Geometry, supports, mesh refinement and reference loads use the buckling translation unchanged (as the transient
 * translation does); contacts name CAD nodes and are mapped to solver nodes of the original (unrefined) nodes. */
export function translateBeamContact(value: unknown): {
  readonly input: BeamContactInput; readonly plan: OofemContactPlan; readonly momentLengthM: number;
  /** CAD node id of each original solver node, in plan order (the plan itself carries no ids). */
  readonly nodeIds: readonly string[];
} {
  const row = fields(value, ['schema', 'geometry', 'supports', 'referenceLoads', 'contacts', 'loadFactors'], '$');
  if (row.schema !== 'pointercad-beam-contact/1') throw new Error('contact-schema: unsupported input');
  let prepared: ReturnType<typeof translateBeamBuckling>;
  try {
    prepared = translateBeamBuckling({ schema: 'pointercad-beam-buckling/1', geometry: row.geometry,
      supports: row.supports, referenceLoads: row.referenceLoads });
  } catch (error) {
    throw new Error(`contact-input: ${error instanceof Error ? error.message : 'invalid beam input'}`, { cause: error });
  }
  const contacts = readContacts(row.contacts);
  if (!dense(row.loadFactors)) throw new Error('contact-shape: loadFactors');
  const factors = row.loadFactors.map((item: unknown, index) => number(item, `loadFactors[${index}]`));
  const original = prepared.plan.nodes.slice(0, prepared.plan.originalNodeCount);
  const checked = validateBeamContacts(contacts, factors, new Map(original.map(node => [node.id, node.positionM])));
  if (!checked.ok) throw new Error(`${checked.code}: contacts[${checked.index}]`);
  const planContacts = contactPlanContacts(checked.contacts, new Map(original.map(node => [node.id, node.number])));
  if (planContacts === null) throw new Error('contact-translation: a contact node has no solver node');
  const momentLengthM = Math.max(...prepared.plan.members.map(member => member.frame.lengthM));
  if (!Number.isFinite(momentLengthM) || momentLengthM <= 0) throw new Error('contact-scale: no positive member length');
  const { geometry, supports, referenceLoads } = prepared.input;
  const input: BeamContactInput = { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads,
    contacts: checked.contacts, loadFactors: checked.loadFactors };
  const plan: OofemContactPlan = { schema: 'pointercad-oofem-contact-plan/1',
    nodes: prepared.plan.nodes.map(node => ({ number: node.number, positionM: node.positionM, restrained: node.restrained,
      load: node.load })),
    materials: prepared.plan.materials, sections: prepared.plan.sections, members: prepared.plan.members,
    originalNodeCount: prepared.plan.originalNodeCount, contacts: planContacts, loadFactors: checked.loadFactors };
  return { input, plan, momentLengthM, nodeIds: original.map(node => node.id) };
}

export async function contactInputSha256(value: unknown): Promise<string> {
  const input = translateBeamContact(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
