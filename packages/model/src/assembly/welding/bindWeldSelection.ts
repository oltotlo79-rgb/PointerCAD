/**
 * 利用者が画面で選んだ面・辺を、いまの形へ結び付けて溶接の選択を作る。
 *
 * 選んだ時の参照(指紋)は「どの面・辺か」を指すだけで、位置・向き・長さの正本にしない。重心・法線・辺の
 * 中点・向き・長さは、現在のボディで選び直した部分形状から読む(締結の `bindHoleSelection` と同じ考え)。
 * 選び直せない・平面でない・直線でない・辺が1つ目の部品のものでない選択は、理由を添えて断る。
 */

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry } from '../../kernelBridge.js';
import { findComponent } from '../assemblyEdit.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { componentSourceKey } from '../fastening/frames.js';
import type { FilletWeldRejection, WeldEdgeSelection, WeldFaceSelection } from './types.js';
import type { FilletWeldPlan, FilletWeldRequest } from './types.js';
import type { JointOccurrencePath } from '../jointOccurrence.js';
import { appendJointOccurrenceComponents, jointOccurrenceStamp, occurrenceForGeometryComponent,
  prepareJointOccurrencePair, sameJointOccurrencePreview, type CommitJointOccurrenceResult,
  type JointOccurrenceCommandContext, type JointOccurrenceCommandFailure,
  type JointOccurrencePreviewStamp } from '../jointOccurrenceSelection.js';
import { nextWeldId, planFilletWeld, planFilletWeldEdit, weldSegmentsOf, type FilletWeldEditRequest } from './planFilletWeld.js';
import { applyFilletWeld, removeFilletWeld } from './applyFilletWeld.js';
import { buildFilletWeldPart, createFilletWeldSource, filletWeldLegs, filletWeldSegmentOptions } from './filletWeldPart.js';

/** 画面で選んだ部分形状(部品と参照)。 */
export interface FilletWeldPick {
  readonly componentId: string;
  readonly ref: SubShapeRef;
}

/** 置いた部品のいまの形で参照を選び直す口。見つからない・曖昧なら `null`。 */
export type WeldGeometryResolver = (component: AssemblyComponent, reference: SubShapeRef) => MateSubShapeGeometry | null;

export interface FilletWeldPicks {
  readonly first: FilletWeldPick;
  readonly edge: FilletWeldPick;
  readonly second: FilletWeldPick;
}

export type BoundFilletWeldSelection =
  | { readonly ok: true; readonly first: WeldFaceSelection; readonly edge: WeldEdgeSelection; readonly second: WeldFaceSelection }
  | { readonly ok: false; readonly rejections: readonly FilletWeldRejection[] };

function current(
  document: AssemblyDocument, pick: FilletWeldPick, resolve: WeldGeometryResolver,
): { readonly component: AssemblyComponent; readonly geometry: MateSubShapeGeometry } | FilletWeldRejection {
  const component = findComponent(document, pick.componentId);
  if (component === undefined) return { code: 'componentMissing', detail: { componentId: pick.componentId } };
  const geometry = resolve(component, pick.ref);
  return geometry === null ? { code: 'selectionNotFound', detail: { componentId: pick.componentId } } : { component, geometry };
}

function face(
  document: AssemblyDocument, pick: FilletWeldPick, resolve: WeldGeometryResolver, partRevisions: ReadonlyMap<string, string>,
  allowCylinder = false,
): WeldFaceSelection | FilletWeldRejection {
  const found = current(document, pick, resolve);
  if ('code' in found) return found;
  const { component, geometry } = found;
  if (allowCylinder && geometry.kind === 'face' && geometry.surfaceKind === 'cylinder' && geometry.axis !== null
    && geometry.axisOrigin != null && geometry.cylinderSpan != null && typeof geometry.cylinderExterior === 'boolean'
    && geometry.radius !== null && Number.isFinite(geometry.radius) && geometry.radius > 0) {
    return {
      componentId: component.id, sourceKey: componentSourceKey(component, partRevisions) ?? '',
      face: { ...pick.ref, fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: geometry.area,
        position: geometry.position, axis: geometry.axis, radius: geometry.radius } },
      centroid: geometry.position, normal: null,
    };
  }
  if (geometry.kind !== 'face' || geometry.surfaceKind !== 'plane' || geometry.axis === null) {
    return { code: 'faceNotPlanar', detail: { componentId: component.id } };
  }
  return {
    componentId: component.id, sourceKey: componentSourceKey(component, partRevisions) ?? '',
    face: { ...pick.ref, fingerprint: { kind: 'face', surfaceKind: 'plane', area: geometry.area, position: geometry.position,
      axis: geometry.axis, radius: null } },
    centroid: geometry.position, normal: geometry.axis,
  };
}

/** 選んだ3つ(1つ目の面・その部品の辺・2つ目の面)を、いまの形の値で溶接の選択にする。 */
export function bindFilletWeldSelection(
  document: AssemblyDocument, picks: FilletWeldPicks, resolve: WeldGeometryResolver,
  partRevisions: ReadonlyMap<string, string>,
): BoundFilletWeldSelection {
  const rejections: FilletWeldRejection[] = [];
  const first = face(document, picks.first, resolve, partRevisions);
  const second = face(document, picks.second, resolve, partRevisions, true);
  if ('code' in first) rejections.push(first);
  if ('code' in second) rejections.push(second);
  let edge: WeldEdgeSelection | null = null;
  // 辺が1つ目の部品のものかは、1つ目の部品が今もある時だけ比べる(無い部品との比較は理由にならない。
  // その時は componentMissing だけを返し、辺そのものは別の理由が無いかを確かめる)。
  const firstExists = findComponent(document, picks.first.componentId) !== undefined;
  if (firstExists && picks.edge.componentId !== picks.first.componentId) {
    rejections.push({ code: 'edgeNotOnFirstComponent', detail: { componentId: picks.edge.componentId } });
  } else {
    const found = current(document, picks.edge, resolve);
    // 同じ束縛を確かめてから使う(別名へ写すと向きの null が絞り込まれない)。
    const geometry = 'code' in found ? null : found.geometry;
    if ('code' in found) rejections.push(found);
    else if (geometry === null || geometry.kind !== 'edge' || geometry.curveKind !== 'line' || geometry.axis === null) {
      rejections.push({ code: 'edgeNotStraight', detail: { componentId: picks.edge.componentId } });
    } else {
      edge = {
        edge: { ...picks.edge.ref, fingerprint: { kind: 'edge', curveKind: 'line', length: geometry.length,
          position: geometry.position, axis: geometry.axis, radius: null } },
        midpoint: geometry.position, direction: geometry.axis, length: geometry.length,
      };
    }
  }
  if (rejections.length > 0 || 'code' in first || 'code' in second || edge === null) return { ok: false, rejections };
  return { ok: true, first, edge, second };
}

export interface OccurrenceWeldPick { readonly path: JointOccurrencePath; readonly ref: SubShapeRef }
export interface OccurrenceWeldPicks {
  readonly first: OccurrenceWeldPick;
  readonly edge: OccurrenceWeldPick;
  readonly second: OccurrenceWeldPick;
}
export type OccurrenceWeldChoices = Omit<FilletWeldRequest, 'first' | 'second' | 'edge'>;
export type OccurrenceWeldPreview =
  | { readonly ok: true; readonly plan: FilletWeldPlan; readonly stamp: JointOccurrencePreviewStamp }
  | { readonly ok: false; readonly reason: JointOccurrenceCommandFailure | 'invalid-pick' | 'geometry-rejected';
      readonly rejections: readonly FilletWeldRejection[] };

export function previewOccurrenceFilletWeld(context: JointOccurrenceCommandContext,
  picks: OccurrenceWeldPicks, choices: OccurrenceWeldChoices): OccurrenceWeldPreview {
  if (JSON.stringify(picks.edge.path) !== JSON.stringify(picks.first.path)) {
    return { ok: false, reason: 'invalid-pick', rejections: [] };
  }
  const prepared = prepareJointOccurrencePair(context, picks.first.path, picks.second.path);
  if (!prepared.ok) return { ...prepared, rejections: [] };
  const pair = prepared.pair;
  const bound = bindFilletWeldSelection(pair.geometryDocument, {
    first: { componentId: pair.first.occurrenceKey, ref: picks.first.ref },
    edge: { componentId: pair.first.occurrenceKey, ref: picks.edge.ref },
    second: { componentId: pair.second.occurrenceKey, ref: picks.second.ref },
  }, (component, ref) => {
    const occurrence = occurrenceForGeometryComponent(pair, component);
    return occurrence === null ? null : context.resolveWeldGeometry(occurrence, ref);
  }, pair.revisions);
  if (!bound.ok) return { ok: false, reason: 'geometry-rejected', rejections: bound.rejections };
  const planned = planFilletWeld(pair.geometryDocument, { ...choices, first: bound.first,
    second: bound.second, edge: bound.edge }, pair.revisions, component => {
    const occurrence = occurrenceForGeometryComponent(pair, component);
    return occurrence === null ? null : context.bodiesOf(occurrence);
  });
  if (!planned.ok) return { ok: false, reason: 'geometry-rejected', rejections: planned.rejections };
  const plan = { ...planned.plan, weldId: nextWeldId(context.inputs.document) };
  return { ok: true, plan, stamp: jointOccurrenceStamp(context, pair, plan) };
}

export function commitOccurrenceFilletWeld(context: JointOccurrenceCommandContext,
  picks: OccurrenceWeldPicks, choices: OccurrenceWeldChoices,
  previewed: Extract<OccurrenceWeldPreview, { readonly ok: true }>): CommitJointOccurrenceResult {
  const current = previewOccurrenceFilletWeld(context, picks, choices);
  const document = context.inputs.document;
  if (!current.ok || !sameJointOccurrencePreview(current.stamp, previewed.stamp)) {
    return { ok: false, document, reason: 'preview-changed' };
  }
  const prepared = prepareJointOccurrencePair(context, picks.first.path, picks.second.path);
  if (!prepared.ok) return { ok: false, document, reason: prepared.reason };
  const pair = prepared.pair;
  // Source checks refer to the geometry scene, but saved weldParts must name the
  // actual root owners. No transient occurrence key enters generated options.
  const staged = applyFilletWeld(pair.geometryDocument, { ...current.plan,
    firstComponentId: pair.first.motionOwnerId, secondComponentId: pair.second.motionOwnerId }, pair.revisions);
  return staged.ok ? appendJointOccurrenceComponents(context, pair, staged.document, staged.componentIds, 'weld')
    : { ok: false, document, reason: 'invalid-generated-components' };
}

export type OccurrenceWeldEditFailure = JointOccurrenceCommandFailure
  | 'weld-association-missing' | 'weld-association-ambiguous' | 'weld-association-damaged' | 'geometry-rejected';
export type OccurrenceWeldEditPreview =
  | { readonly ok: true; readonly plan: FilletWeldPlan; readonly stamp: JointOccurrencePreviewStamp }
  | { readonly ok: false; readonly reason: OccurrenceWeldEditFailure; readonly rejections: readonly FilletWeldRejection[] };
export type CommitOccurrenceWeldEditResult = Extract<CommitJointOccurrenceResult, { readonly ok: true }>
  | (Extract<OccurrenceWeldEditPreview, { readonly ok: false }> & { readonly document: AssemblyDocument });

function editFailure(reason: OccurrenceWeldEditFailure,
  rejections: readonly FilletWeldRejection[] = []): Extract<OccurrenceWeldEditPreview, { readonly ok: false }> {
  return { ok: false, reason, rejections };
}

/** Restore the existing edit scene from actual leaves and the entire saved bead
 * association. Root aggregate bodies never substitute for child geometry.
 */
function occurrenceWeldEditScene(context: JointOccurrenceCommandContext, request: FilletWeldEditRequest) {
  const document = context.inputs.document;
  const beads = weldSegmentsOf(document).get(request.weldId);
  if (beads === undefined || beads.length === 0) return editFailure('weld-association-missing');
  const ids = new Set(beads.map(component => component.id));
  const connections = document.jointOccurrenceConnections ?? [];
  const matching = connections.flatMap((connection, index) => connection.componentIds.some(id => ids.has(id)) ? [index] : []);
  const index = matching[0];
  if (index === undefined) return editFailure('weld-association-missing');
  if (matching.length !== 1) return editFailure('weld-association-ambiguous');
  const connection = connections[index];
  if (connection === undefined || connection.kind !== 'weld' || ids.size !== beads.length
      || connection.componentIds.length !== ids.size || new Set(connection.componentIds).size !== ids.size
      || !connection.componentIds.every(id => ids.has(id))) return editFailure('weld-association-damaged');
  // Replacing a bead used as another connection's source would require explicit
  // path reassociation; this edit must not cascade into that other connection.
  if (connections.some(entry => ids.has(entry.firstPath[0]) || ids.has(entry.secondPath[0]))) {
    return editFailure('weld-association-damaged');
  }
  const prepared = prepareJointOccurrencePair(context, connection.firstPath, connection.secondPath);
  if (!prepared.ok) return editFailure(prepared.reason);
  const pair = prepared.pair;
  const firstOwner = findComponent(document, pair.first.motionOwnerId);
  const secondOwner = findComponent(document, pair.second.motionOwnerId);
  const group = firstOwner?.rigidGroupId;
  if (group === undefined || group === '' || secondOwner?.rigidGroupId !== group) return editFailure('weld-association-damaged');
  const stagedBeads: AssemblyComponent[] = [];
  const segmentIndices = new Set<number>();
  for (const bead of beads) {
    if (bead.suppressed || bead.rigidGroupId !== group || bead.source.kind !== 'standardPart'
        || bead.source.catalog !== 'filletWeld' || buildFilletWeldPart(bead.source) === null
        || document.components.filter(component => component.id === bead.id).length !== 1
        || bead.id === pair.first.occurrenceKey || bead.id === pair.second.occurrenceKey) return editFailure('weld-association-damaged');
    const options = filletWeldSegmentOptions(bead.source.options), legs = filletWeldLegs(bead.source.size);
    if (options === null || legs === null || options.parts[0] !== pair.first.motionOwnerId
        || options.parts[1] !== pair.second.motionOwnerId || options.segment >= beads.length
        || segmentIndices.has(options.segment)) return editFailure('weld-association-damaged');
    segmentIndices.add(options.segment);
    stagedBeads.push({ ...bead, source: createFilletWeldSource(legs.legOnSecond, legs.legOnFirst,
      { ...options, parts: [pair.first.occurrenceKey, pair.second.occurrenceKey] }) });
  }
  const scene: AssemblyDocument = { ...pair.geometryDocument, components: [
    ...pair.geometryDocument.components.map(component => ({ ...component, rigidGroupId: group })), ...stagedBeads,
  ] };
  return { ok: true as const, pair, scene, connection, connectionIndex: index, beads };
}

/** Edit legs, intervals and material on the same saved pair of occurrences. */
export function previewOccurrenceFilletWeldEdit(context: JointOccurrenceCommandContext,
  request: FilletWeldEditRequest): OccurrenceWeldEditPreview {
  const prepared = occurrenceWeldEditScene(context, request);
  if (!prepared.ok) return prepared;
  const planned = planFilletWeldEdit(prepared.scene, request, prepared.pair.revisions, component => {
    const occurrence = occurrenceForGeometryComponent(prepared.pair, component);
    return occurrence === null ? null : context.bodiesOf(occurrence);
  });
  if (!planned.ok) return editFailure('geometry-rejected', planned.rejections);
  return { ok: true, plan: planned.plan, stamp: jointOccurrenceStamp(context, prepared.pair,
    { plan: planned.plan, connection: prepared.connection, beads: prepared.beads }) };
}

export function commitOccurrenceFilletWeldEdit(context: JointOccurrenceCommandContext,
  request: FilletWeldEditRequest,
  previewed: Extract<OccurrenceWeldEditPreview, { readonly ok: true }>): CommitOccurrenceWeldEditResult {
  const document = context.inputs.document;
  const current = previewOccurrenceFilletWeldEdit(context, request);
  if (!current.ok) return { ...current, document };
  if (!sameJointOccurrencePreview(current.stamp, previewed.stamp)) return { ...editFailure('preview-changed'), document };
  const prepared = occurrenceWeldEditScene(context, request);
  if (!prepared.ok) return { ...prepared, document };
  // Keep the validated scene identities for apply's stale checks, but generate
  // durable source options using real root owners, never transient leaf IDs.
  const staged = applyFilletWeld(prepared.scene, { ...current.plan,
    firstComponentId: prepared.pair.first.motionOwnerId, secondComponentId: prepared.pair.second.motionOwnerId }, prepared.pair.revisions);
  if (!staged.ok) return { ...editFailure('geometry-rejected', staged.rejections), document };
  // Allocate fresh real IDs while old beads still exist. Only then remove the
  // old ownership group, so no old ID can alias its replacement in this commit.
  const appended = appendJointOccurrenceComponents(context, prepared.pair, staged.document, staged.componentIds, 'weld');
  if (!appended.ok) return { ...editFailure(appended.reason), document };
  const replaced = removeFilletWeld(appended.document, prepared.connection.componentIds);
  // Both owners and every bead were already in the same validated group. The
  // append helper's group join needs no change to surviving original members.
  const originals = new Map(document.components.map(component => [component.id, component]));
  return { ...appended, document: { ...replaced,
    components: replaced.components.map(component => originals.get(component.id) ?? component),
    jointOccurrenceConnections: (document.jointOccurrenceConnections ?? []).map((connection, index) =>
      index === prepared.connectionIndex ? appended.connection : connection),
  } };
}
