import type { AnalysisSource, BeamAnalysisDocument, BeamNodalLoad, Vector3 } from './analysisModel.js';
import type { BucklingRestraints } from './bucklingModel.js';

/**
 * First contact slice of FEM-PLASTIC-CONTACT-JOINT (not all contact): static, linear elastic, small-displacement
 * Beam3d frames with frictionless one-sided contact on node translations, either a node against a fixed rigid plane
 * or two explicitly paired nodes. Gap g = g0 + n . u (plane) or g0 + n . (u_B - u_A) (pair), in m; reactions
 * lambda >= 0 in N; g >= 0; lambda g = 0. For a pair whose nodes are apart (> 1 nm) n must point from A towards B;
 * for coincident pair nodes the declared orientation is used as given. gapM is the declared surface gap and is not
 * derived from the centerline distance. Friction, surfaces, two-sided stops, large rotation, impact and plasticity are
 * refused. The solve is an explicit NumPy complementarity procedure on the native Beam3d stiffness (beamContact.py),
 * not an OOFEM contact engine.
 */
export type BeamContactDefinition =
  | { readonly kind: 'node-plane'; readonly id: string; readonly nodeId: string; readonly normal: Vector3; readonly gapM: number }
  | { readonly kind: 'node-pair'; readonly id: string; readonly nodeIdA: string; readonly nodeIdB: string;
      readonly normal: Vector3; readonly gapM: number };

/** Independent core input, shaped like BeamTransientInput (geometry, supports, reference loads) plus contacts. */
export interface BeamContactInput {
  readonly schema: 'pointercad-beam-contact/1';
  readonly geometry: BeamAnalysisDocument;
  readonly supports: readonly { readonly nodeId: string; readonly restrained: BucklingRestraints }[];
  readonly referenceLoads: readonly BeamNodalLoad[];
  readonly contacts: readonly BeamContactDefinition[];
  /** Each factor multiplies the reference loads and is solved independently from the unloaded state. */
  readonly loadFactors: readonly number[];
}

export const MAX_BEAM_CONTACTS = 64;
export const MAX_CONTACT_LOAD_FACTORS = 32;
export const MAX_CONTACT_GAP_M = 1e3;
const MAX_LOAD_FACTOR = 1e6;
/** Same constants as beamContact.py: unit-normal / duplicate / two-sided comparison and coincident pair nodes. */
const NORMAL_TOLERANCE = 1e-9;
const COINCIDENT_LENGTH_M = 1e-9;

export type ContactValidationCode = 'contact-count' | 'contact-id' | 'contact-number' | 'contact-normal' | 'contact-gap'
  | 'contact-node' | 'contact-self' | 'contact-orientation' | 'contact-duplicate' | 'contact-two-sided' | 'contact-factors';
export type ContactValidation =
  | { readonly ok: true; readonly contacts: readonly BeamContactDefinition[]; readonly loadFactors: readonly number[] }
  | { readonly ok: false; readonly code: ContactValidationCode; readonly index: number };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Normalizes each normal (a nonzero finite vector) and refuses everything beamContact.py validate_contacts refuses,
 * in the same order. positionsM gives every CAD node position in m (the translated plan positions).
 */
export function validateBeamContacts(contacts: readonly BeamContactDefinition[], loadFactors: readonly number[],
  positionsM: ReadonlyMap<string, Vector3>): ContactValidation {
  const fail = (code: ContactValidationCode, index: number): ContactValidation => ({ ok: false, code, index });
  if (contacts.length < 1 || contacts.length > MAX_BEAM_CONTACTS) return fail('contact-count', -1);
  const ids = new Set<string>();
  const normalized: BeamContactDefinition[] = [];
  const keys: { readonly nodes: string; readonly normal: Vector3 }[] = [];
  for (const [index, contact] of contacts.entries()) {
    if (contact.id.length < 1 || contact.id.length > 64 || ids.has(contact.id)) return fail('contact-id', index);
    ids.add(contact.id);
    if (!contact.normal.every(finite)) return fail('contact-number', index);
    const length = Math.hypot(...contact.normal);
    if (!Number.isFinite(length) || length <= 1e-12) return fail('contact-normal', index);
    const normal: Vector3 = [contact.normal[0] / length, contact.normal[1] / length, contact.normal[2] / length];
    if (!finite(contact.gapM) || contact.gapM < 0 || contact.gapM > MAX_CONTACT_GAP_M) return fail('contact-gap', index);
    const members = contact.kind === 'node-plane' ? [contact.nodeId] : [contact.nodeIdA, contact.nodeIdB];
    if (!members.every((id) => positionsM.has(id))) return fail('contact-node', index);
    if (contact.kind === 'node-pair') {
      if (contact.nodeIdA === contact.nodeIdB) return fail('contact-self', index);
      const a = positionsM.get(contact.nodeIdA), b = positionsM.get(contact.nodeIdB);
      if (a === undefined || b === undefined) return fail('contact-node', index);
      const d: Vector3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      if (Math.hypot(...d) > COINCIDENT_LENGTH_M && normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] <= 0) {
        return fail('contact-orientation', index);
      }
    }
    // (A, B, n) and (B, A, -n) are one constraint; a plane is identified by its node and normal (not its gap).
    const key = contact.kind === 'node-plane' ? { nodes: `plane:${contact.nodeId}`, normal }
      : contact.nodeIdA < contact.nodeIdB ? { nodes: `pair:${contact.nodeIdA}:${contact.nodeIdB}`, normal }
        : { nodes: `pair:${contact.nodeIdB}:${contact.nodeIdA}`, normal: [-normal[0], -normal[1], -normal[2]] as const };
    for (const other of keys) {
      if (other.nodes !== key.nodes) continue;
      if (Math.max(...other.normal.map((value, axis) => Math.abs(value - key.normal[axis]))) <= NORMAL_TOLERANCE) {
        return fail('contact-duplicate', index);
      }
      if (Math.max(...other.normal.map((value, axis) => Math.abs(value + key.normal[axis]))) <= NORMAL_TOLERANCE) {
        return fail('contact-two-sided', index);
      }
    }
    keys.push(key);
    normalized.push({ ...contact, normal });
  }
  if (loadFactors.length < 1 || loadFactors.length > MAX_CONTACT_LOAD_FACTORS) return fail('contact-factors', -1);
  for (const [index, factor] of loadFactors.entries()) {
    if (!finite(factor) || Math.abs(factor) > MAX_LOAD_FACTOR) return fail('contact-factors', index);
  }
  return { ok: true, contacts: normalized, loadFactors: [...loadFactors] };
}

/** The contact rows of the numeric plan read by beamContact.py (solver node numbers, unit normals). */
export type ContactPlanContact =
  | { readonly id: string; readonly kind: 'node-plane'; readonly node: number; readonly normal: Vector3; readonly gapM: number }
  | { readonly id: string; readonly kind: 'node-pair'; readonly nodeA: number; readonly nodeB: number;
      readonly normal: Vector3; readonly gapM: number };

/** Maps validated contacts to solver nodes; null if a CAD node has no solver node (translation defect). */
export function contactPlanContacts(contacts: readonly BeamContactDefinition[],
  solverNodeOf: ReadonlyMap<string, number>): readonly ContactPlanContact[] | null {
  const rows: ContactPlanContact[] = [];
  for (const contact of contacts) {
    if (contact.kind === 'node-plane') {
      const node = solverNodeOf.get(contact.nodeId);
      if (node === undefined) return null;
      rows.push({ id: contact.id, kind: 'node-plane', node, normal: contact.normal, gapM: contact.gapM });
    } else {
      const nodeA = solverNodeOf.get(contact.nodeIdA), nodeB = solverNodeOf.get(contact.nodeIdB);
      if (nodeA === undefined || nodeB === undefined) return null;
      rows.push({ id: contact.id, kind: 'node-pair', nodeA, nodeB, normal: contact.normal, gapM: contact.gapM });
    }
  }
  return rows;
}

export interface ContactStateOfPair {
  readonly id: string;
  readonly state: 'open' | 'closed';
  /** lambda in N (pushes the node off the plane / the pair apart); open contacts carry exactly 0. A closed contact
   * may carry a value down to -1e-9 of the force scale (the declared tension tolerance). */
  readonly normalReactionN: number;
  readonly gapM: number;
}
export interface ContactNodeDisplacement {
  readonly number: number;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
}
export interface ContactLoadState {
  readonly loadFactor: number;
  readonly pivots: number;
  readonly nodes: readonly ContactNodeDisplacement[];
  readonly contacts: readonly ContactStateOfPair[];
  readonly forceScaleN: number;
  readonly gapScaleM: number;
  /** Self-reported by the worker (needs K); the decoder recomputes penetration, tension and complementarity. */
  readonly equilibriumResidual: number;
  readonly penetration: number;
  readonly tension: number;
  readonly complementarity: number;
}
/** The worker result of beamContact.py, before binding to an analysis id/revision/source by the future client. */
export interface BeamContactNumericResult {
  readonly schema: 'pointercad-oofem-contact-result/1';
  readonly method: 'murty-least-index-lcp-on-native-beam3d-stiffness';
  readonly freeDofs: number;
  readonly meshNodes: number;
  readonly meshElements: number;
  readonly momentLengthM: number;
  readonly pivotLimit: number;
  readonly states: readonly ContactLoadState[];
}
/** Bound result as the future client would expose it (same binding fields as BeamTransientResult). */
export interface BeamContactResult extends BeamContactNumericResult {
  readonly kind: 'oofem-beam-contact-3d';
  readonly nativeContactSolver: false;
  readonly scope: 'frictionless-unilateral-node-plane-node-pair-small-displacement-static';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly structuralCertification: false;
}

/** Fixed before execution; equal to the thresholds asserted by beamContact.py (unchanged from contact-r1). */
export const CONTACT_RESULT_TOLERANCE = 1e-9;

/** What the request fixed, so the decoder never trusts the worker for identities or counts. */
export interface ContactResultExpectation {
  readonly contacts: readonly ContactPlanContact[];
  readonly loadFactors: readonly number[];
  /** Solver node numbers of the original (CAD) nodes in plan order: the returned node rows must be exactly these. */
  readonly nodeNumbers: readonly number[];
  readonly meshNodes: number;
  readonly meshElements: number;
  /** Largest member length of the plan (m), as beamContact.validate_native_rows returns it. */
  readonly momentLengthM: number;
}

/** beamContact.pivot_limit: a practical bound, not a proof that no solution exists. */
export const contactPivotLimit = (contactCount: number): number => 4 * contactCount * contactCount + 16;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && !Array.isArray(value);
/** All three own indices must hold finite numbers: `every` skips holes, so a sparse array must be refused here. */
const vector = (value: unknown): value is Vector3 => Array.isArray(value) && value.length === 3
  && [0, 1, 2].every(index => Object.hasOwn(value, index) && finite(value[index]));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const integerIn = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;

/**
 * Strict decoder of the worker JSON. Identities, counts and factors come from the expectation; penetration, tension
 * and complementarity are recomputed here from the returned reactions, gaps and (strictly positive) scales and must
 * hold at the declared 1e-9; open/closed labels must agree with the returned numbers.
 */
export function decodeContactNumericResult(raw: unknown, expected: ContactResultExpectation): BeamContactNumericResult | null {
  const tolerance = CONTACT_RESULT_TOLERANCE;
  const limit = contactPivotLimit(expected.contacts.length);
  if (!isRecord(raw) || !exactKeys(raw, ['schema', 'method', 'freeDofs', 'meshNodes', 'meshElements', 'momentLengthM',
    'pivotLimit', 'states'])
    || raw.schema !== 'pointercad-oofem-contact-result/1' || raw.method !== 'murty-least-index-lcp-on-native-beam3d-stiffness'
    || raw.meshNodes !== expected.meshNodes || raw.meshElements !== expected.meshElements
    || !integerIn(raw.freeDofs, 1, 6 * expected.meshNodes) || raw.pivotLimit !== limit
    || raw.momentLengthM !== expected.momentLengthM || !(expected.momentLengthM > 0)
    || !Array.isArray(raw.states) || raw.states.length !== expected.loadFactors.length) return null;
  const states: ContactLoadState[] = [];
  for (const [index, state] of raw.states.entries()) {
    if (!isRecord(state) || !exactKeys(state, ['loadFactor', 'pivots', 'nodes', 'contacts', 'forceScaleN', 'gapScaleM',
      'equilibriumResidual', 'penetration', 'tension', 'complementarity'])) return null;
    const forceScale = state.forceScaleN, gapScale = state.gapScaleM;
    if (state.loadFactor !== expected.loadFactors[index] || !integerIn(state.pivots, 0, limit)
      || !finite(forceScale) || forceScale <= 0 || !finite(gapScale) || gapScale <= 0) return null;
    const reported: number[] = [];
    for (const name of ['equilibriumResidual', 'penetration', 'tension', 'complementarity'] as const) {
      const value = state[name];
      if (!finite(value) || value < 0 || value > tolerance) return null;
      reported.push(value);
    }
    if (!Array.isArray(state.nodes) || state.nodes.length !== expected.nodeNumbers.length) return null;
    const nodes: ContactNodeDisplacement[] = [];
    for (const [position, node] of state.nodes.entries()) {
      if (!isRecord(node) || !exactKeys(node, ['number', 'displacementM', 'rotationRad'])
        || node.number !== expected.nodeNumbers[position] || !vector(node.displacementM) || !vector(node.rotationRad)) return null;
      nodes.push({ number: expected.nodeNumbers[position], displacementM: node.displacementM, rotationRad: node.rotationRad });
    }
    if (!Array.isArray(state.contacts) || state.contacts.length !== expected.contacts.length) return null;
    const pairs: ContactStateOfPair[] = [];
    let penetration = 0, tension = 0, complementarity = 0;
    for (const [position, contact] of state.contacts.entries()) {
      if (!isRecord(contact) || !exactKeys(contact, ['id', 'state', 'normalReactionN', 'gapM'])
        || contact.id !== expected.contacts[position].id) return null;
      const reaction = contact.normalReactionN, gap = contact.gapM;
      if (!finite(reaction) || !finite(gap)) return null;
      const status = contact.state === 'open' ? 'open' : contact.state === 'closed' ? 'closed' : null;
      if (status === null) return null;
      // Labels must agree with the numbers: an open contact has exactly zero reaction (no adhesion) and a closed
      // contact has a gap within the tolerance of zero.
      if (status === 'open' && reaction !== 0) return null;
      if (status === 'closed' && Math.abs(gap) > tolerance * gapScale) return null;
      penetration = Math.max(penetration, Math.max(0, -gap) / gapScale);
      tension = Math.max(tension, Math.max(0, -reaction) / forceScale);
      complementarity = Math.max(complementarity, Math.abs(reaction * gap) / (forceScale * gapScale));
      pairs.push({ id: expected.contacts[position].id, state: status, normalReactionN: reaction, gapM: gap });
    }
    if (!(penetration <= tolerance && tension <= tolerance && complementarity <= tolerance)) return null;
    states.push({ loadFactor: expected.loadFactors[index], pivots: Number(state.pivots), nodes, contacts: pairs,
      forceScaleN: forceScale, gapScaleM: gapScale, equilibriumResidual: reported[0], penetration, tension, complementarity });
  }
  return { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
    freeDofs: Number(raw.freeDofs), meshNodes: expected.meshNodes, meshElements: expected.meshElements,
    momentLengthM: expected.momentLengthM, pivotLimit: limit, states };
}
