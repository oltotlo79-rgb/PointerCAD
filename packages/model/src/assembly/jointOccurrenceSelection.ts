import { expressionValueFromNumber } from '@pointercad/expression';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { MateSubShapeGeometry, SolidBody } from '../kernelBridge.js';
import type { PartDocument } from '../part/types.js';
import { addComponent, createComponentFor } from './assemblyEdit.js';
import { ASSEMBLY_SCHEMA_VERSION, createAssemblyDocument } from './createAssemblyDocument.js';
import type { FaceResolution, ModeledThreadGroupPick, ModeledThreadResolution } from './fastening/bindHoleSelection.js';
import { PLACEMENT_QUATERNION_TOLERANCE, rigidPlacementOf, validPlacement } from './fastening/frames.js';
import { FASTENING_LENGTH_TOLERANCE_MM } from './fastening/types.js';
import { resolveJointOccurrence, type JointOccurrenceInputs, type JointOccurrencePath,
  type JointOccurrenceView, type ResolvedJointOccurrence } from './jointOccurrence.js';
import { canonicalTextOf } from './partLibrary.js';
import { joinRigidGroup, rigidGroupMemberIds } from './rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument, JointOccurrenceConnection, Placement } from './types.js';

/** All geometry callbacks use the actual leaf, never the transient planner ID. */
export interface JointOccurrenceCommandContext {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly partDocument: (occurrence: ResolvedJointOccurrence) => PartDocument | null;
  readonly resolveFace: (occurrence: ResolvedJointOccurrence, ref: SubShapeRef) => FaceResolution;
  readonly resolveWeldGeometry: (occurrence: ResolvedJointOccurrence, ref: SubShapeRef) => MateSubShapeGeometry | null;
  readonly bodiesOf: (occurrence: ResolvedJointOccurrence) => readonly SolidBody[] | null;
  readonly resolveModeledThread?: (occurrence: ResolvedJointOccurrence, group: ModeledThreadGroupPick) => ModeledThreadResolution;
}

export interface JointOccurrencePair {
  readonly first: ResolvedJointOccurrence;
  readonly second: ResolvedJointOccurrence;
  /** Ephemeral planner inputs only. Never install this document into the store. */
  readonly geometryDocument: AssemblyDocument;
  readonly revisions: ReadonlyMap<string, string>;
}

export type JointOccurrenceCommandFailure =
  | 'occurrence-unavailable' | 'same-occurrence' | 'same-owner-unsupported'
  | 'owner-unavailable' | 'owner-pose-not-stored' | 'owner-constrained'
  | 'preview-changed' | 'invalid-generated-components';

export type JointOccurrencePairResult = { readonly ok: true; readonly pair: JointOccurrencePair }
  | { readonly ok: false; readonly reason: JointOccurrenceCommandFailure };

export interface JointOccurrencePreviewStamp {
  readonly source: JointOccurrenceInputs;
  readonly identity: string;
}

function storedWorld(occurrence: ResolvedJointOccurrence): Placement {
  const { position, rotation } = occurrence.worldPlacement;
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

function geometryComponent(occurrence: ResolvedJointOccurrence): AssemblyComponent {
  return { id: occurrence.occurrenceKey, name: occurrence.leafComponent.name,
    source: occurrence.leafComponent.source, placement: storedWorld(occurrence),
    fixed: true, visible: true, suppressed: false };
}

/** Zero-motion insertion only. Existing flat commands retain their alignment route. */
export function prepareJointOccurrencePair(context: JointOccurrenceCommandContext,
  firstPath: JointOccurrencePath, secondPath: JointOccurrencePath): JointOccurrencePairResult {
  const first = resolveJointOccurrence(context.inputs, firstPath, context.view);
  const second = resolveJointOccurrence(context.inputs, secondPath, context.view);
  if (!first.ok || !second.ok) return { ok: false, reason: 'occurrence-unavailable' };
  const a = first.occurrence, b = second.occurrence;
  if (a.occurrenceKey === b.occurrenceKey) return { ok: false, reason: 'same-occurrence' };
  if (a.motionOwnerId === b.motionOwnerId) return { ok: false, reason: 'same-owner-unsupported' };
  const document = context.inputs.document;
  const owners = new Set([a.motionOwnerId, b.motionOwnerId]
    .flatMap(id => rigidGroupMemberIds(document, id)));
  for (const id of owners) {
    const matches = document.components.filter(component => component.id === id);
    const component = matches[0], solved = context.view.resolved.placements.get(id);
    if (matches.length !== 1 || component === undefined || component.suppressed || solved === undefined
        || !validPlacement(component.placement)) {
      return { ok: false, reason: 'owner-unavailable' };
    }
    // Rigid-group offsets are derived from saved root placements. Inserting at a
    // different solved root pose would jump on the next solve; do not materialize it silently.
    const stored = rigidPlacementOf(component.placement);
    const rotationDifference = Math.min(...[1, -1].map(sign => Math.max(...stored.rotation
      .map((value, index) => Math.abs(value - sign * (solved.rotation[index] ?? NaN))))));
    if (!stored.position.every((value, index) => Math.abs(value - (solved.position[index] ?? NaN)) <= FASTENING_LENGTH_TOLERANCE_MM)
        || !Number.isFinite(rotationDifference) || rotationDifference > PLACEMENT_QUATERNION_TOLERANCE) {
      return { ok: false, reason: 'owner-pose-not-stored' };
    }
  }
  // A new rigid union can remove a mechanism degree of freedom even without movement.
  // This bounded route refuses affected constraints instead of dropping them.
  if ([...document.mates, ...document.joints].some(entry => !entry.suppressed
      && (owners.has(entry.a.componentId) || owners.has(entry.b.componentId)))) {
    return { ok: false, reason: 'owner-constrained' };
  }
  const revisions = new Map(context.inputs.library.partFiles.map(file => [file.ref,
    `${file.contentHash}:${file.attachmentsDigest}`]));
  const geometryDocument = { ...createAssemblyDocument('joint geometry evaluation'),
    components: [geometryComponent(a), geometryComponent(b)] };
  return { ok: true, pair: { first: a, second: b, geometryDocument, revisions } };
}

export function occurrenceForGeometryComponent(pair: JointOccurrencePair, component: AssemblyComponent): ResolvedJointOccurrence | null {
  return component.id === pair.first.occurrenceKey ? pair.first
    : component.id === pair.second.occurrenceKey ? pair.second : null;
}

export function jointOccurrenceStamp(context: JointOccurrenceCommandContext,
  pair: JointOccurrencePair, plan: unknown): JointOccurrencePreviewStamp {
  return { source: context.inputs, identity: canonicalTextOf({ paths: [pair.first.path, pair.second.path],
    sources: [pair.first.sourceKey, pair.second.sourceKey],
    placements: [pair.first.worldPlacement, pair.second.worldPlacement], plan }) };
}

export function sameJointOccurrencePreview(a: JointOccurrencePreviewStamp, b: JointOccurrencePreviewStamp): boolean {
  return a.source.document === b.source.document && a.source.library === b.source.library
    && a.source.subAssemblies === b.source.subAssemblies && a.identity === b.identity;
}

export type CommitJointOccurrenceResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[];
      readonly connection: JointOccurrenceConnection }
  | { readonly ok: false; readonly document: AssemblyDocument; readonly reason: JointOccurrenceCommandFailure };

/** Copy only validated generated components into the real owner; transient IDs
 * and the evaluation document never become assembly ownership or endpoint IDs.
 */
export function appendJointOccurrenceComponents(context: JointOccurrenceCommandContext, pair: JointOccurrencePair,
  staged: AssemblyDocument, generatedIds: readonly string[], kind: 'bolt' | 'weld'): CommitJointOccurrenceResult {
  const document = context.inputs.document;
  const checked = prepareJointOccurrencePair(context, pair.first.path, pair.second.path);
  if (!checked.ok) return { ok: false, document, reason: checked.reason };
  if (!sameJointOccurrencePreview(jointOccurrenceStamp(context, pair, null),
    jointOccurrenceStamp(context, checked.pair, null))) return { ok: false, document, reason: 'preview-changed' };
  if (generatedIds.length === 0 || new Set(generatedIds).size !== generatedIds.length) {
    return { ok: false, document, reason: 'invalid-generated-components' };
  }
  let next = document;
  const componentIds: string[] = [];
  for (const id of generatedIds) {
    const matches = staged.components.filter(component => component.id === id);
    const component = matches[0];
    if (matches.length !== 1 || component === undefined || component.source.kind !== 'standardPart'
        || id === pair.first.occurrenceKey || id === pair.second.occurrenceKey) {
      return { ok: false, document, reason: 'invalid-generated-components' };
    }
    const created = createComponentFor(next, component.source,
      { partName: component.name, placement: component.placement });
    const actual = component.materialId === undefined ? created : { ...created, materialId: component.materialId };
    next = addComponent(next, actual);
    componentIds.push(actual.id);
  }
  const connection: JointOccurrenceConnection = { kind, firstPath: [...pair.first.path],
    secondPath: [...pair.second.path], componentIds };
  next = joinRigidGroup(next, [pair.first.motionOwnerId, pair.second.motionOwnerId, ...componentIds]);
  return { ok: true, document: { ...next,
    schemaVersion: Math.max(document.schemaVersion, ASSEMBLY_SCHEMA_VERSION),
    jointOccurrenceConnections: [...(document.jointOccurrenceConnections ?? []), connection] }, componentIds, connection };
}
