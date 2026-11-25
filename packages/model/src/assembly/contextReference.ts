/**
 * 組立の文脈の参照。置いた部品Aの基準点を、別に置いた部品Bの頂点・面の中心に合わせる。
 *
 * Bの今の形の点を、Bの配置で組立の座標へ写し、Aの配置の逆でAの部品の座標へ戻して、Aの部品文書の
 * 基準点(座標の式)へ書く。結び付けは組立に残し、「更新」で元から計算し直す。配置は文書の配置
 * (締結と同じ `rigidPlacementOf`)を使い、配置の計算は `placementMath.ts`・`rigidGroups.ts` の既存の関数だけを使う。
 *
 * 元の部品・元の参照・先の部品・先の基準点が無い、古い、または循環する時は、何も変えずに理由を返す。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import { findComponent } from './assemblyEdit.js';
import { rigidPlacementOf, validPlacement } from './fastening/frames.js';
import { partOf, type PartLibrary, replacePartDocument } from './partLibrary.js';
import { applyPlacementToPoint } from './placementMath.js';
import { inversePlacement } from './rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';
import { isSameSubShape, type SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import type { SubShapeReferenceResolution } from '../kernelBridge/referenceResolution.js';
import { findReference, replaceReference } from '../part/createPartDocument.js';
import type { PartDocument, ReferencePointFeature } from '../part/types.js';
import { SKETCH_TOLERANCE_MM, type Vec3 } from '../sketch/vec3.js';
import { resolvePlaneSpec } from '../geometry/planeSpec.js';
import { withinMagnitude } from '../numericTolerance.js';

/** 結び付け1つ。先(A)の基準点は、元(B)の頂点か面の中心から決まる。 */
export interface ContextReferenceLink {
  readonly id: string;
  /** 先の置いた部品(A)。抱き込んだ部品だけ。 */
  readonly targetComponentId: string;
  /** Aの部品文書の基準点のフィーチャー id。 */
  readonly targetReferenceId: string;
  /** 元の置いた部品(B)。 */
  readonly sourceComponentId: string;
  /** Bの今の形の頂点、または面(中心を使う)。 */
  readonly source: SubShapeRef;
  /** Absent on the existing single-point links. */
  readonly plane?: ContextPlaneBinding;
}

export interface ContextPlaneBinding {
  readonly targetPartRef: string;
  readonly targetPartId: string;
  readonly sourcePartRef: string;
  readonly sourcePartId: string;
  /** A deleted or replaced source cannot be resurrected by reissuing a serial feature ID. */
  readonly sourceInvalidated?: true;
  readonly pointIds: readonly [string, string, string];
}

export type ContextPlanePoints = readonly [Vec3, Vec3, Vec3];
type ContextPlaneResolver = (link: ContextReferenceLink) => ContextPlanePoints | null;

export function contextReferenceTargetIds(link: ContextReferenceLink): readonly string[] {
  return [link.targetReferenceId, ...(link.plane?.pointIds ?? [])];
}

function planeSourceExists(library: PartLibrary, source: AssemblyComponent, link: ContextReferenceLink): boolean {
  const binding = link.plane, origin = link.source.origin;
  if (binding === undefined || origin === undefined || partRefOf(source) !== binding.sourcePartRef) return false;
  const part = library.parts.get(binding.sourcePartRef);
  return part?.id === binding.sourcePartId && part.solids.some(feature => feature.id === link.source.bodyFeatureId)
    && part.solids.some(feature => feature.id === origin.identity.featureId);
}

function planePointIds(part: PartDocument, link: ContextReferenceLink): ContextPlaneBinding['pointIds'] | null {
  const binding = link.plane;
  if (binding === undefined || part.id !== binding.targetPartId) return null;
  const feature = findReference(part, link.targetReferenceId);
  if (feature?.kind !== 'referencePlane' || feature.plane.kind !== 'threePoints') return null;
  const { p1, p2, p3 } = feature.plane;
  const points = [p1, p2, p3];
  return points.every((point, index) => point.kind === 'point' && point.pointId === binding.pointIds[index]
    && findReference(part, point.pointId)?.kind === 'referencePoint') ? binding.pointIds : null;
}

/** Deleting an owner or a generated element removes the relation in the same parent edit. */
export function pruneContextPlaneLinks(document: AssemblyDocument, library: PartLibrary): AssemblyDocument {
  const links = document.contextReferences;
  if (links === undefined || !links.some(link => link.plane !== undefined)) return document;
  const components = new Map(document.components.map(component => [component.id, component]));
  const kept = links.flatMap((link): ContextReferenceLink[] => {
    if (link.plane === undefined) return [link];
    const target = components.get(link.targetComponentId), source = components.get(link.sourceComponentId);
    if (target?.source.kind !== 'part' || target.source.partRef !== link.plane.targetPartRef
      || source === undefined) return [];
    const part = library.parts.get(target.source.partRef);
    if (part === undefined || planePointIds(part, link) === null) return [];
    return link.plane.sourceInvalidated === true || planeSourceExists(library, source, link) ? [link]
      : [{ ...link, plane: { ...link.plane, sourceInvalidated: true } }];
  });
  return kept.length === links.length && kept.every((link, index) => link === links[index])
    ? document : { ...document, contextReferences: kept };
}

interface ContextReferenceContext {
  readonly document: AssemblyDocument;
  /** 置いた部品の今の部品文書。 */
  readonly partDocument: (component: AssemblyComponent) => PartDocument | null;
  /** 置いた部品の今の形で、参照の点を部品の座標で返す。選べない・曖昧なら `null`。 */
  readonly resolvePoint: (component: AssemblyComponent, reference: SubShapeRef) => Vec3 | null;
  /** 組立にある結び付け(循環の確かめに使う)。 */
  readonly links: readonly ContextReferenceLink[];
}

export type ContextReferenceRejectionCode =
  | 'targetComponentMissing' | 'sourceComponentMissing' | 'targetNotEmbeddedPart' | 'samePart'
  | 'targetReferenceMissing' | 'targetReferenceNotPoint' | 'sourceUnresolved' | 'invalidPlacement' | 'cyclicReference'
  | 'unsupportedSource' | 'targetPartShared' | 'duplicateTarget';

export interface ContextReferenceRejection {
  readonly code: ContextReferenceRejectionCode;
  readonly linkId: string;
}

/** 書いた結果。部品の版を変えるのは `partRef` の部品文書だけ。 */
export interface ContextReferenceUpdate {
  readonly partRef: string;
  readonly part: PartDocument;
  /** Aの部品の座標での点。 */
  readonly point: Vec3;
}

function reject(code: ContextReferenceRejectionCode, link: ContextReferenceLink): ContextReferenceRejection {
  return { code, linkId: link.id };
}

function activeComponent(document: AssemblyDocument, id: string): AssemblyComponent | undefined {
  const component = findComponent(document, id);
  return component === undefined || component.suppressed ? undefined : component;
}

function partRefOf(component: AssemblyComponent): string | null {
  return component.source.kind === 'part' ? component.source.partRef : null;
}

function partRefOfComponent(document: AssemblyDocument, componentId: string): string | null {
  const component = findComponent(document, componentId);
  return component === undefined ? null : partRefOf(component);
}

/** 結び付けの辺 1 本。先の部品の点は、元の部品の形から決まる(辺の向きは先 → 元)。 */
interface ContextPartEdge {
  readonly linkId: string;
  readonly sourcePart: string;
}

/**
 * 結び付けを部品の単位にまとめたグラフ。同じ部品の別の配置は同じ頂点になる。部品でない配置・無い配置を指す
 * 結び付けは辺にしない(どちらの確かめでも、たどれない)。配置から部品への対応は一度だけ作る。
 */
interface ContextPartGraph {
  readonly partOf: (componentId: string) => string | null;
  readonly edges: ReadonlyMap<string, readonly ContextPartEdge[]>;
}

function contextPartGraph(document: AssemblyDocument, links: readonly ContextReferenceLink[]): ContextPartGraph {
  // findComponent と同じく、同じ id が並べば前の配置を採る(抑制した配置も数える)。
  const parts = new Map<string, string | null>();
  for (const component of document.components) {
    if (!parts.has(component.id)) parts.set(component.id, partRefOf(component));
  }
  const partOf = (componentId: string): string | null => parts.get(componentId) ?? null;
  const edges = new Map<string, ContextPartEdge[]>();
  for (const link of links) {
    const targetPart = partOf(link.targetComponentId), sourcePart = partOf(link.sourceComponentId);
    if (targetPart === null || sourcePart === null || (link.plane !== undefined
      && (link.plane.sourceInvalidated === true || link.plane.targetPartRef !== targetPart
        || link.plane.sourcePartRef !== sourcePart))) continue;
    const list = edges.get(targetPart);
    if (list === undefined) edges.set(targetPart, [{ linkId: link.id, sourcePart }]);
    else list.push({ linkId: link.id, sourcePart });
  }
  return { partOf, edges };
}

/** `from` から辺をたどって `to` に着くか。`excludedLinkId` の結び付けの辺は使わない。再帰しない。 */
function reaches(graph: ContextPartGraph, from: string, to: string, excludedLinkId: string | null): boolean {
  const pending = [from];
  const seen = new Set<string>([from]);
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part === to) return true;
    for (const edge of graph.edges.get(part) ?? []) {
      if (edge.linkId === excludedLinkId || seen.has(edge.sourcePart)) continue;
      seen.add(edge.sourcePart);
      pending.push(edge.sourcePart);
    }
  }
  return false;
}

/**
 * 元の部品の点が、先の部品の点から(ほかの結び付けをたどって)決まるなら循環。元と先が同じ部品(別の配置を含む)も循環。
 * 同じ id の結び付けの辺は使わない(置き換えの前の自分自身を数えない)。
 */
function cyclic(document: AssemblyDocument, links: readonly ContextReferenceLink[], link: ContextReferenceLink): boolean {
  const graph = contextPartGraph(document, links);
  const targetPart = graph.partOf(link.targetComponentId), sourcePart = graph.partOf(link.sourceComponentId);
  return targetPart !== null && sourcePart !== null && reaches(graph, sourcePart, targetPart, link.id);
}

function contextPlaneWouldCycle(document: AssemblyDocument, library: PartLibrary, link: ContextReferenceLink): boolean {
  const root = contextPartGraph(document, (document.contextReferences ?? []).filter(other => other.id !== link.id));
  const target = root.partOf(link.targetComponentId), source = root.partOf(link.sourceComponentId);
  if (target === null || source === null) return true;
  const edges = new Map<string, ContextPartEdge[]>();
  const append = (graph: ContextPartGraph): void => {
    for (const [part, more] of graph.edges) {
      const list = edges.get(part);
      if (list === undefined) edges.set(part, [...more]);
      else for (const edge of more) list.push(edge);
    }
  };
  append(root);
  const scanned = new Set<string>(), pending = [document];
  while (pending.length > 0) {
    const assembly = pending.pop();
    if (assembly === undefined) break;
    for (const component of assembly.components) {
      if (component.source.kind !== 'subAssembly' || scanned.has(component.source.assemblyRef)) continue;
      const ref = component.source.assemblyRef, child = library.assemblies?.get(ref);
      if (child === undefined) return true;
      scanned.add(ref);
      append(contextPartGraph(child, child.contextReferences ?? []));
      pending.push(child);
    }
  }
  return reaches({ partOf: root.partOf, edges }, source, target, null);
}

/**
 * 結び付けの一覧が部品の単位で循環を含むか(保存を開く時の確かめ)。`cyclic` と同じグラフを 1 回だけ作り、
 * 3 色の深さ優先(今の道の上の頂点へ戻る辺が循環)を再帰せずにたどる。id が重ならない一覧では、どれか 1 本で
 * `cyclic` が真になることと同じ(開く時は id の重なりを先に断る)。形は計算しない。
 */
export function contextReferencesHaveCycle(document: AssemblyDocument, links: readonly ContextReferenceLink[]): boolean {
  const graph = contextPartGraph(document, links);
  const state = new Map<string, 'open' | 'done'>();
  for (const start of graph.edges.keys()) {
    if (state.has(start)) continue;
    state.set(start, 'open');
    const stack: { readonly part: string; next: number }[] = [{ part: start, next: 0 }];
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const edge = graph.edges.get(top.part)?.[top.next];
      if (edge === undefined) {
        state.set(top.part, 'done');
        stack.pop();
        continue;
      }
      top.next += 1;
      const seen = state.get(edge.sourcePart);
      if (seen === 'open') return true;
      if (seen === undefined) {
        state.set(edge.sourcePart, 'open');
        stack.push({ part: edge.sourcePart, next: 0 });
      }
    }
  }
  return false;
}

/**
 * 結び付けを元から計算し直し、Aの部品文書の基準点へ書く。断る時は文書を作らない(呼び出し側の文書は変えない)。
 */
export function applyContextReference(
  context: ContextReferenceContext, link: ContextReferenceLink,
): ContextReferenceUpdate | ContextReferenceRejection {
  if (link.plane !== undefined) return reject('unsupportedSource', link);
  const target = activeComponent(context.document, link.targetComponentId);
  if (target === undefined) return reject('targetComponentMissing', link);
  const source = activeComponent(context.document, link.sourceComponentId);
  if (source === undefined) return reject('sourceComponentMissing', link);
  const partRef = partRefOf(target);
  if (partRef === null) return reject('targetNotEmbeddedPart', link);
  // 同じ部品を元と先にすると、点を書くたびに元の形も動く。
  if (partRefOf(source) === partRef) return reject('samePart', link);
  // 先の部品文書を他の置いた部品も使っていれば、書くと選んでいない配置まで動く。選んだ配置を
  // 独立した部品にするまで断る(抑制した配置も同じ一式を指すので数える)。
  if (context.document.components.some((component) => component.id !== target.id && partRefOf(component) === partRef)) {
    return reject('targetPartShared', link);
  }
  // 別の結び付けが同じ基準点を決めていれば、どちらが正か決まらない。
  if (context.links.some((other) => other.id !== link.id && contextReferenceTargetIds(other).includes(link.targetReferenceId)
    && partRefOfComponent(context.document, other.targetComponentId) === partRef)) {
    return reject('duplicateTarget', link);
  }
  if (link.source.fingerprint.kind !== 'vertex' && link.source.fingerprint.kind !== 'face') {
    return reject('unsupportedSource', link);
  }
  if (cyclic(context.document, context.links, link)) return reject('cyclicReference', link);
  const part = context.partDocument(target);
  const feature = part === null ? undefined : findReference(part, link.targetReferenceId);
  if (part === null || feature === undefined) return reject('targetReferenceMissing', link);
  if (feature.kind !== 'referencePoint') return reject('targetReferenceNotPoint', link);
  if (!validPlacement(target.placement) || !validPlacement(source.placement)) return reject('invalidPlacement', link);
  const local = context.resolvePoint(source, link.source);
  if (local === null || !local.every(Number.isFinite)) return reject('sourceUnresolved', link);
  const world = applyPlacementToPoint(rigidPlacementOf(source.placement), local);
  const point = applyPlacementToPoint(inversePlacement(rigidPlacementOf(target.placement)), world);
  if (!point.every(Number.isFinite)) return reject('invalidPlacement', link);
  const next: ReferencePointFeature = { ...feature, definition: { kind: 'coordinate', at: {
    mode: 'absolute', x: expressionValueFromNumber(point[0]), y: expressionValueFromNumber(point[1]),
    z: expressionValueFromNumber(point[2]),
  } } };
  return { partRef, part: replaceReference(part, feature.id, next), point };
}

function samePlaneSource(previous: ContextReferenceLink, next: ContextReferenceLink): boolean {
  return previous.sourceComponentId === next.sourceComponentId
    && previous.plane?.sourceInvalidated === next.plane?.sourceInvalidated
    && previous.plane?.sourcePartRef === next.plane?.sourcePartRef
    && previous.plane?.sourcePartId === next.plane?.sourcePartId
    && isSameSubShape(previous.source, next.source);
}

/** Check the persisted identity and reservations before attaching or updating a plane. */
export function withContextPlaneLink(
  document: AssemblyDocument, library: PartLibrary, link: ContextReferenceLink,
): AssemblyDocument | ContextReferenceRejection {
  const binding = link.plane;
  if (binding === undefined || link.source.origin?.shapeKind !== 'face'
    || link.source.fingerprint.kind !== 'face' || link.source.fingerprint.surfaceKind !== 'plane') {
    return reject('unsupportedSource', link);
  }
  const target = activeComponent(document, link.targetComponentId);
  if (target === undefined) return reject('targetComponentMissing', link);
  const source = activeComponent(document, link.sourceComponentId);
  if (source === undefined) return reject('sourceComponentMissing', link);
  const part = library.parts.get(binding.targetPartRef);
  if (partRefOf(target) !== binding.targetPartRef || part === undefined || planePointIds(part, link) === null) {
    return reject('targetReferenceMissing', link);
  }
  if (binding.sourceInvalidated === true || !planeSourceExists(library, source, link)) {
    return reject('sourceUnresolved', link);
  }
  if (binding.sourcePartRef === binding.targetPartRef) return reject('samePart', link);
  if (document.components.some(component => component.id !== target.id && partRefOf(component) === binding.targetPartRef)) {
    return reject('targetPartShared', link);
  }
  const existing = document.contextReferences ?? [];
  const previous = existing.find(other => other.id === link.id);
  if (previous !== undefined && (previous.plane === undefined || previous.targetComponentId !== link.targetComponentId
    || previous.targetReferenceId !== link.targetReferenceId || previous.plane.targetPartRef !== binding.targetPartRef
    || previous.plane.targetPartId !== binding.targetPartId
    || previous.plane.pointIds.some((id, index) => id !== binding.pointIds[index]))) return reject('duplicateTarget', link);
  const targets = new Set(contextReferenceTargetIds(link));
  if (targets.size !== 4 || existing.some(other => other.id !== link.id
    && partRefOfComponent(document, other.targetComponentId) === binding.targetPartRef
    && contextReferenceTargetIds(other).some(id => targets.has(id)))) return reject('duplicateTarget', link);
  if (contextPlaneWouldCycle(document, library, link)) return reject('cyclicReference', link);
  if (previous !== undefined && samePlaneSource(previous, link)) return document;
  return { ...document, contextReferences: previous === undefined ? [...existing, link]
    : existing.map(other => other === previous ? link : other) };
}

function movePlanePoint(part: PartDocument, pointId: string, position: Vec3): PartDocument {
  const feature = findReference(part, pointId);
  if (feature?.kind !== 'referencePoint') return part;
  const current = feature.definition;
  if (current.kind === 'coordinate' && current.at.mode === 'absolute'
    && [current.at.x, current.at.y, current.at.z].every((coordinate, index) =>
      withinMagnitude(coordinate.value - position[index], SKETCH_TOLERANCE_MM))) return part;
  return replaceReference(part, pointId, { ...feature, definition: { kind: 'coordinate', at: {
    mode: 'absolute', x: expressionValueFromNumber(position[0]), y: expressionValueFromNumber(position[1]),
    z: expressionValueFromNumber(position[2]),
  } } });
}

async function commitContextPlane(
  document: AssemblyDocument, library: PartLibrary, link: ContextReferenceLink, resolvePlane?: ContextPlaneResolver,
): Promise<ContextReferenceCommit | ContextReferenceRejection> {
  const next = withContextPlaneLink(document, library, link);
  if ('code' in next) return next;
  const binding = link.plane, points = resolvePlane?.(link);
  if (binding === undefined || points == null || points.some(point => !point.every(Number.isFinite))) {
    return reject('sourceUnresolved', link);
  }
  const part = library.parts.get(binding.targetPartRef);
  const feature = part === undefined ? undefined : findReference(part, link.targetReferenceId);
  if (part === undefined || feature?.kind !== 'referencePlane') return reject('targetReferenceMissing', link);
  const byId = new Map(binding.pointIds.map((id, index) => [id, points[index]]));
  const check = resolvePlaneSpec(feature.plane, {
    point: reference => reference.kind === 'point' ? byId.get(reference.pointId) ?? null : null,
    axis: () => null, workPlane: () => null,
  });
  if (!check.ok) return reject('invalidPlacement', link);
  const moved = binding.pointIds.reduce((current, id, index) => movePlanePoint(current, id, points[index]), part);
  const provenance = library.partFiles.find(file => file.ref === binding.targetPartRef);
  return { document: next, point: points[0], library: moved === part ? library
    : await replacePartDocument(library, binding.targetPartRef, moved, provenance === undefined ? {}
      : { importedAt: provenance.importedAt }) };
}

/** 確定の結果。`applyAssembly(document, library)` へそのまま渡す(1回が Undo の1段)。 */
export interface ContextReferenceCommit {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly point: Vec3;
}

/**
 * 結び付けを作る・更新する確定。同じ id の結び付けは置き換え、無ければ足す。部品文書は
 * `replacePartDocument`(抱き込んだ部品の差し替えの正本)で書き換える。断る時は何も作らない。
 */
export async function commitContextReference(
  document: AssemblyDocument, library: PartLibrary, link: ContextReferenceLink,
  resolvePoint: ContextReferenceContext['resolvePoint'], resolvePlane?: ContextPlaneResolver,
): Promise<ContextReferenceCommit | ContextReferenceRejection> {
  if (link.plane !== undefined) return commitContextPlane(document, library, link, resolvePlane);
  const existing = document.contextReferences ?? [];
  if (existing.some(other => other.id === link.id && other.plane !== undefined)) return reject('duplicateTarget', link);
  const links = existing.some((other) => other.id === link.id)
    ? existing.map((other) => other.id === link.id ? link : other) : [...existing, link];
  const update = applyContextReference({ document, links, resolvePoint,
    partDocument: (component) => component.source.kind === 'part' ? partOf(library, component.source.partRef) ?? null : null,
  }, link);
  if ('code' in update) return update;
  return { document: { ...document, contextReferences: links },
    library: await replacePartDocument(library, update.partRef, update.part), point: update.point };
}

/**
 * 再計算済みのボディから点を引く既定の口。同じ id のボディがちょうど1つで、参照が今の形で
 * 一意に選べた時だけ、その頂点・面の中心(今の形の位置)を返す。
 *
 * 座標: 照合の幾何は `faces[].centroid`・`vertices[].position`(`subShapeMatching.ts`)で、kernel の
 * `buildSolidBodyMesh` は部分形状の一覧を枠なしで集める(`collectSubShapes` に枠を渡さない)。
 * `coordinateFrame`(local)は表示の配列 `positions`・`edgePositions` だけの原点なので、ここでは足さない。
 */
export function contextPointResolverFromBodies(
  bodiesOf: (component: AssemblyComponent) => readonly SolidBody[] | null,
  resolve: (body: SolidBody, reference: SubShapeRef) => SubShapeReferenceResolution,
): ContextReferenceContext['resolvePoint'] {
  return (component, reference) => {
    const matches = bodiesOf(component)?.filter((body) => body.featureId === reference.bodyFeatureId) ?? [];
    const body = matches.length === 1 ? matches[0] : undefined;
    if (body === undefined || !body.isValid) return null;
    const resolution = resolve(body, reference);
    if (resolution.status !== 'matched') return null;
    const geometry = resolution.match.geometry;
    return geometry.kind === reference.fingerprint.kind && geometry.position.every(Number.isFinite) ? geometry.position : null;
  };
}
