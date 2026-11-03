/** Internal root-occurrence circular planning. Consumers: applyCircularFilletWeld and these two tests.
 * Saved reconstruction is never contact admission; no public/Worker/save union is extended.
 */
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import { prepareJointOccurrencePair, type JointOccurrenceCommandContext, type JointOccurrenceCommandFailure, type JointOccurrencePair } from '../jointOccurrenceSelection.js';
import { canonicalTextOf } from '../partLibrary.js';
import { jointOccurrencePath, resolveJointOccurrence, type JointOccurrenceInputs, type JointOccurrenceView } from '../jointOccurrence.js';
import type { AssemblyComponent, JointOccurrenceConnection, Placement } from '../types.js';
import { applyPlacementToDirection, composePlacement, multiplyQuaternion, quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import { scaleVec3, subVec3 } from '../../sketch/vec3.js';
import { WELD_DIRECTION_TOLERANCE, WELD_LENGTH_TOLERANCE_MM } from './types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { buildCircularFilletWeldGeometry } from './circularFilletWeldGeometry.js';
import { createCircularFilletWeldSource, readCircularFilletWeldSource, type CircularWeldSavedParent } from './circularFilletWeldSource.js';
import { resolveCircularWeldContact, type CircularWeldContactRequest } from './circularWeldContact.js';
import { resolveCircularWeldSelection } from './circularWeldSelection.js';
import { createCircularWeldPath, readCircularWeldPathSnapshot, type CircularWeldPathEvidence } from './curvedWeldPath.js';

export interface CircularFilletWeldRequest {
  readonly operation: 'create' | 'replace';
  readonly weldId: string;
  /** Independent author-input epoch, never the generated source's partKey. */
  readonly draftEpoch: string;
  readonly edge: CircularWeldContactRequest['edge'];
  readonly plane: CircularWeldContactRequest['plane'];
  readonly cylinder: CircularWeldContactRequest['cylinder'];
  readonly intervals: readonly { readonly beadId: string; readonly fromParameter: number; readonly toParameter: number }[];
  readonly section: CircularWeldContactRequest['section'];
  readonly materialId: string;
}
export type CircularFilletWeldFailure = JointOccurrenceCommandFailure | 'invalid-request' | 'material-unavailable'
  | 'contact-rejected' | 'weld-exists' | 'association-damaged';
export interface PlannedCircularBead { readonly source: StandardPartSource; readonly placement: Placement; readonly materialId: string }
export interface CircularFilletWeldPlan {
  readonly request: CircularFilletWeldRequest;
  readonly beads: readonly PlannedCircularBead[];
  readonly replacedComponentIds: readonly string[];
  readonly connectionIndex: number | null;
  readonly contacts: ReturnType<typeof resolveCircularWeldContact>['contacts'];
  readonly identity: string;
  readonly state: string;
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly resolved: JointOccurrenceView['resolved'];
}
export type CircularFilletWeldPreview = { readonly ok: true; readonly plan: CircularFilletWeldPlan }
  | { readonly ok: false; readonly reason: CircularFilletWeldFailure };

function owned<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(owned); Object.freeze(value); }
  return value;
}
/** Include map contents and typed mesh bytes; JSON's default empty Map is not an identity. */
function stamp(value: unknown): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => {
    if (row instanceof Map) { const entries: unknown[] = [...row.entries()]; return entries; }
    if (ArrayBuffer.isView(row)) return [...new Uint8Array(row.buffer, row.byteOffset, row.byteLength)];
    return row;
  });
}
function inputStamp(context: JointOccurrenceCommandContext): string { return stamp([context.inputs, context.view]); }

/** Only selected bodies are requested. Used by planner and apply's final guard. */
export function circularFilletWeldState(context: JointOccurrenceCommandContext, pair: JointOccurrencePair): string {
  const first = context.bodiesOf(pair.first), second = context.bodiesOf(pair.second);
  return stamp([context.inputs, context.view, first, second]);
}
function parent(context: JointOccurrenceCommandContext, pair: JointOccurrencePair,
  pick: CircularWeldContactRequest['plane'], role: 'plane' | 'cylinder'): CircularWeldSavedParent | null {
  const occurrence = role === 'plane' ? pair.first : pair.second;
  const bodies = context.bodiesOf(occurrence)?.filter(body => body.featureId === pick.reference.bodyFeatureId);
  if (bodies?.length !== 1) return null;
  const resolved = resolveSubShapeReference(bodies[0], pick.reference);
  if (resolved.status !== 'matched' || resolved.match.geometry.kind !== 'face' || resolved.match.geometry.surfaceKind !== role) return null;
  return { role, documentId: context.inputs.document.id, ownerId: occurrence.leafComponent.id,
    occurrencePath: [...occurrence.path], sourceKey: occurrence.sourceKey,
    placementKey: JSON.stringify([occurrence.worldPlacement.position, occurrence.worldPlacement.rotation]),
    bodyFeatureId: pick.reference.bodyFeatureId, bodyKey: pick.bodyKey, reference: structuredClone(resolved.match.reference) };
}

function savedWeldId(component: AssemblyComponent): string | null {
  if (component.source.kind !== 'standardPart' || component.source.catalog !== 'filletWeld') return null;
  const raw = component.source.options.weldCircular;
  if (raw === undefined) return component.source.options.weldId ?? null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && 'weldId' in value && typeof value.weldId === 'string' ? value.weldId : null;
  } catch { return null; }
}

/** All old beads and their single occurrence connection are an indivisible edit. */
function association(context: JointOccurrenceCommandContext, pair: JointOccurrencePair, request: CircularFilletWeldRequest):
  { readonly beads: readonly AssemblyComponent[]; readonly connectionIndex: number | null } | null {
  const document = context.inputs.document;
  // An unreadable circular group cannot safely be excluded as somebody else's group.
  if (document.components.some(c => c.source.kind === 'standardPart' && Object.hasOwn(c.source.options, 'weldCircular')
    && readCircularFilletWeldSource(c.source) === null)) return null;
  const beads = document.components.filter(c => savedWeldId(c) === request.weldId);
  if (request.operation === 'create') return beads.length === 0 ? { beads, connectionIndex: null } : null;
  if (beads.length === 0 || beads.length > 64) return null;
  const ids = new Set(beads.map(c => c.id));
  if (ids.size !== beads.length || beads.some(c => document.components.filter(other => other.id === c.id).length !== 1)) return null;
  const connections = document.jointOccurrenceConnections ?? [];
  const matches = connections.flatMap((connection, i) => connection.componentIds.some(id => ids.has(id)) ? [i] : []);
  const index = matches[0], connection: JointOccurrenceConnection | undefined = index === undefined ? undefined : connections[index];
  if (matches.length !== 1 || connection === undefined || connection.kind !== 'weld'
    || connection.componentIds.length !== beads.length || new Set(connection.componentIds).size !== beads.length
    || !connection.componentIds.every(id => ids.has(id)) || canonicalTextOf(connection.firstPath) !== canonicalTextOf(pair.first.path)
    || canonicalTextOf(connection.secondPath) !== canonicalTextOf(pair.second.path)) return null;
  if (connections.some(c => ids.has(c.firstPath[0]) || ids.has(c.secondPath[0]))
    || [...document.mates, ...document.joints].some(c => ids.has(c.a.componentId) || ids.has(c.b.componentId))) return null;
  const owners = [pair.first.motionOwnerId, pair.second.motionOwnerId].map(id => document.components.find(c => c.id === id));
  const group = owners[0]?.rigidGroupId;
  if (!group || owners[1]?.rigidGroupId !== group) return null;
  const first = beads[0];
  if (first.source.kind !== 'standardPart' || first.materialId === undefined || findDensityMaterial(first.materialId) === undefined) return null;
  const baseline = readCircularFilletWeldSource(first.source);
  if (baseline === null || baseline.options.path.intervals.length !== beads.length) return null;
  const expected = new Set(baseline.options.path.intervals.map(row => row.beadId)), found = new Set<string>();
  for (const c of beads) {
    if (c.suppressed || c.fixed || c.rigidGroupId !== group || c.source.kind !== 'standardPart' || c.materialId !== first.materialId) return null;
    const saved = readCircularFilletWeldSource(c.source);
    if (saved === null || !expected.has(saved.options.beadId) || found.has(saved.options.beadId)
      || c.source.size !== first.source.size || saved.options.radialDirection !== baseline.options.radialDirection
      || saved.options.normalDirection !== baseline.options.normalDirection
      || canonicalTextOf(saved.options.path) !== canonicalTextOf(baseline.options.path)
      || canonicalTextOf(saved.options.parents) !== canonicalTextOf(baseline.options.parents)) return null;
    if (canonicalTextOf(saved.options.parents[0].occurrencePath) !== canonicalTextOf(pair.first.path)
      || canonicalTextOf(saved.options.parents[1].occurrencePath) !== canonicalTextOf(pair.second.path)) return null;
    for (const [i, pick] of [request.plane, request.cylinder].entries()) {
      const p = saved.options.parents[i];
      const occurrence = i === 0 ? pair.first : pair.second;
      if (p.documentId !== document.id || p.ownerId !== occurrence.leafComponent.id
        || p.bodyFeatureId !== pick.reference.bodyFeatureId || p.sourceKey !== pick.sourceKey || p.bodyKey !== pick.bodyKey
        || canonicalTextOf(p.reference) !== canonicalTextOf(pick.reference)) return null;
    }
    found.add(saved.options.beadId);
  }
  return { beads, connectionIndex: index ?? null };
}

/** Saved pose is historical data, never a fallback current pose. Reject before
 * using placementMath, whose general quaternion helpers may repair bad inputs.
 */
function savedPose(key: string): RigidPlacement | null {
  let value: unknown;
  try { value = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const p: unknown = value[0], q: unknown = value[1];
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!Array.isArray(p) || p.length !== 3 || !Array.isArray(q) || q.length !== 4
    || !p.every(finite) || !q.every(finite)
    || Math.abs(Math.hypot(...q) - 1) > WELD_DIRECTION_TOLERANCE) return null;
  return { position: [p[0], p[1], p[2]], rotation: [q[0], q[1], q[2], q[3]] };
}
function samePose(a: RigidPlacement, b: RigidPlacement): boolean {
  return a.position.every((v, axis) => Math.abs(v - b.position[axis]) <= WELD_LENGTH_TOLERANCE_MM)
    && [1, -1].some(sign => a.rotation.every((v, axis) => Math.abs(v - sign * b.rotation[axis]) <= WELD_DIRECTION_TOLERANCE));
}
/** One common rigid transform of the original parameterized circle. Source,
 * radius, raw range and traversal must still be the exact original geometry.
 */
function commonMotion(old: CircularWeldPathEvidence, current: CircularWeldPathEvidence): RigidPlacement | null {
  if (canonicalTextOf({ ...old.source, placementKey: current.source.placementKey }) !== canonicalTextOf(current.source)
    || old.radiusMm !== current.radiusMm || old.orientation !== current.orientation
    || canonicalTextOf(old.parameterRange) !== canonicalTextOf(current.parameterRange)) return null;
  const a = quaternionFromBasis(old.xAxis, old.yAxis, old.normal, WELD_DIRECTION_TOLERANCE);
  const b = quaternionFromBasis(current.xAxis, current.yAxis, current.normal, WELD_DIRECTION_TOLERANCE);
  if (a === null || b === null) return null;
  const rotation = multiplyQuaternion(b, [-a[0], -a[1], -a[2], a[3]]);
  const position = subVec3(current.centerMm, applyPlacementToDirection({ position: [0, 0, 0], rotation }, old.centerMm));
  return position.every(Number.isFinite) ? { position, rotation } : null;
}
/** Historical reconstruction of the old bead pose only. This never passes saved
 * values as currentEvidence/currentBeads, nor certifies current contact.
 */
function historicalBeadPose(saved: NonNullable<ReturnType<typeof readCircularFilletWeldSource>>): RigidPlacement | null {
  const path = readCircularWeldPathSnapshot(saved.options.path);
  const interval = path?.definition.intervals.find(row => row.beadId === saved.options.beadId);
  if (path === null || interval === undefined) return null;
  const frame = path.beadFrameAt(interval.beadId, interval.fromParameter), e = path.definition.evidence;
  if (frame === null) return null;
  const rotation = quaternionFromBasis(frame.radial, scaleVec3(frame.tangent, e.orientation), e.normal, WELD_DIRECTION_TOLERANCE);
  return rotation === null ? null : { position: e.centerMm, rotation };
}

export function planCircularFilletWeld(context: JointOccurrenceCommandContext, request: CircularFilletWeldRequest): CircularFilletWeldPreview {
  const refuse = (reason: CircularFilletWeldFailure): CircularFilletWeldPreview => ({ ok: false, reason });
  const inputs = context.inputs, view = context.view, before = inputStamp(context), requestBefore = canonicalTextOf(request);
  const source = Object.freeze({ document: inputs.document, library: inputs.library, subAssemblies: inputs.subAssemblies });
  const resolved = view.resolved;
  if ((request.operation !== 'create' && request.operation !== 'replace') || typeof request.weldId !== 'string' || !request.weldId.trim()
    || typeof request.draftEpoch !== 'string' || !request.draftEpoch.trim()
    || !Array.isArray(request.intervals) || request.intervals.length === 0 || request.intervals.length > 64) return refuse('invalid-request');
  if (findDensityMaterial(request.materialId) === undefined) return refuse('material-unavailable');
  // Captured author values remain distinct from independently resolved current geometry.
  const captured = owned(structuredClone(request));
  const firstPath = jointOccurrencePath(captured.plane.path), secondPath = jointOccurrencePath(captured.cylinder.path);
  if (firstPath === null || secondPath === null) return refuse('invalid-request');
  const prepared = prepareJointOccurrencePair(context, firstPath, secondPath);
  if (!prepared.ok) return refuse(prepared.reason);
  const pair = prepared.pair, old = association(context, pair, captured);
  if (old === null) return refuse(captured.operation === 'create' ? 'weld-exists' : 'association-damaged');
  const state = circularFilletWeldState(context, pair);
  const evidence = resolveCircularWeldSelection(context, captured.edge.path, captured.edge.reference);
  if (evidence === null) return refuse('contact-rejected');
  const oldInputs = old.beads.map(bead => bead.source.kind === 'standardPart' ? readCircularFilletWeldSource(bead.source) : null);
  if (old.beads.length > 0) {
    const baseline = oldInputs[0];
    const motion = baseline == null ? null : commonMotion(baseline.options.path.evidence, evidence);
    if (baseline == null || motion === null) return refuse('association-damaged');
    for (const [i, occurrence] of [pair.first, pair.second].entries()) {
      const pose = savedPose(baseline.options.parents[i].placementKey);
      if (pose === null || !samePose(composePlacement(motion, pose), occurrence.worldPlacement)) return refuse('association-damaged');
    }
    for (const [i, bead] of old.beads.entries()) {
      const saved = oldInputs[i], historical = saved == null ? null : historicalBeadPose(saved);
      // Resolve the actual current bead occurrence/source, not its raw root placement.
      const current = resolveJointOccurrence(context.inputs, [bead.id], view);
      if (historical === null || !current.ok || current.occurrence.leafComponent !== bead
        || !samePose(composePlacement(motion, historical), current.occurrence.worldPlacement)) return refuse('association-damaged');
    }
  }
  const draftIdentity = canonicalTextOf({ draftEpoch: captured.draftEpoch, intervals: captured.intervals,
    section: captured.section, materialId: captured.materialId });
  const currentBeads = captured.intervals.map(row => ({ ...row, beadSourceKey: `draft:${draftIdentity}:${row.beadId}` }));
  const definition = { kind: 'circular-weld-path', evidence, intervals: currentBeads };
  const path = createCircularWeldPath(definition, evidence, currentBeads);
  if (path === null) return refuse('invalid-request');
  const contact = resolveCircularWeldContact(context, { edge: captured.edge, plane: captured.plane, cylinder: captured.cylinder,
    definition, currentBeads, section: captured.section });
  if (contact.reason !== null || contact.contacts.length !== currentBeads.length) return refuse('contact-rejected');
  const plane = parent(context, pair, captured.plane, 'plane'), cylinder = parent(context, pair, captured.cylinder, 'cylinder');
  if (plane === null || cylinder === null) return refuse('contact-rejected');
  const beads: PlannedCircularBead[] = [];
  for (const interval of path.definition.intervals) {
    const section = { ...captured.section, beadId: interval.beadId };
    const geometry = buildCircularFilletWeldGeometry(definition, evidence, currentBeads, section);
    const source = createCircularFilletWeldSource(section.radialLegMm, section.normalLegMm, {
      weldId: captured.weldId, beadId: interval.beadId, path: path.definition, radialDirection: section.radialDirection,
      normalDirection: section.normalDirection, parents: [plane, cylinder],
    });
    if (geometry === null || source === null) return refuse('invalid-request');
    const p = geometry.placement;
    const placement: Placement = { position: [exactExpressionValueFromNumber(p.position[0]), exactExpressionValueFromNumber(p.position[1]),
      exactExpressionValueFromNumber(p.position[2])], rotation: [...p.rotation] };
    beads.push({ source, placement, materialId: captured.materialId });
  }
  // Every synchronous geometry lookup has completed before this final input check.
  const after = circularFilletWeldState(context, pair);
  if (after !== state || context.inputs !== inputs || context.view !== view || inputStamp(context) !== before
    || inputs.document !== source.document || inputs.library !== source.library || inputs.subAssemblies !== source.subAssemblies || view.resolved !== resolved
    || canonicalTextOf(request) !== requestBefore) return refuse('preview-changed');
  const replacedComponentIds = old.beads.map(c => c.id), connectionIndex = old.connectionIndex;
  const identity = canonicalTextOf({ request: captured, beads, contacts: contact.contacts, replacedComponentIds, connectionIndex, state });
  return { ok: true, plan: Object.freeze({ request: captured, beads: owned(beads), replacedComponentIds: owned(replacedComponentIds),
    connectionIndex, contacts: contact.contacts, identity, state, inputs: source, view, resolved }) };
}
