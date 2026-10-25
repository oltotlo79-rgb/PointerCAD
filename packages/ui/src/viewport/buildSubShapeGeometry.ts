/** Pure construction of face, edge and vertex overlays in each body's coordinate frame. */
import type { Vec3 } from '@pointercad/model';
import { parseSubShapeId, subShapeFrameOrigin } from '../solid/subShapeSelection.js';
import type { SolidEdgeEntry, SolidFaceEntry } from '../solid/subShapeSelection.js';
import { notifyAllocatedBacking, type SolidBodyWithSubShapes } from './buildSolidGeometry.js';

export type SubShapeEmphasis = 'hovered' | 'selected';

/** All arrays belong to exactly one body and one double-precision origin. */
export interface SubShapeHighlightBatch {
  readonly featureId: string;
  readonly origin: Vec3;
  readonly facePositions: Float32Array;
  readonly faceNormals: Float32Array;
  readonly faceIndices: Uint32Array;
  readonly edgePositions: Float32Array;
  readonly vertexPositions: Float32Array;
}
export interface SubShapeHighlight {
  readonly emphasis: SubShapeEmphasis;
  readonly batches: readonly SubShapeHighlightBatch[];
}
export interface SubShapeHighlightBundle {
  readonly hovered: SubShapeHighlight;
  readonly selected: SubShapeHighlight;
  readonly faceTriangleCount: number;
  readonly edgeCount: number;
  readonly vertexCount: number;
}

/**
 * A local display budget for the overlay copies. Hovered and selected copies are counted
 * together and refused before any typed array is allocated. `reservedBytes` already holds the
 * kernel baseline and every other live UI copy; this builder adds only its own new arrays.
 */
export interface SubShapeOverlayBudget {
  readonly limitBytes: number;
  readonly reservedBytes: number;
}

const EMPTY_HOVERED_HIGHLIGHT: SubShapeHighlight = { emphasis: 'hovered', batches: [] };
const EMPTY_SELECTED_HIGHLIGHT: SubShapeHighlight = { emphasis: 'selected', batches: [] };
export const EMPTY_SUB_SHAPE_HIGHLIGHT: SubShapeHighlightBundle = {
  hovered: EMPTY_HOVERED_HIGHLIGHT, selected: EMPTY_SELECTED_HIGHLIGHT,
  faceTriangleCount: 0, edgeCount: 0, vertexCount: 0,
};

const FLOAT32_MAX = 3.4028234663852886e38;
const OVERLAY_BUDGET_MESSAGE = 'Local sub-shape overlay exceeds the live-byte budget';

/**
 * One body's overlay plan. The count pass records which faces, edges and vertices contribute
 * and how many corners/segments they add; the fill pass re-applies exactly the same filters
 * to definite-length typed arrays. No intermediate number[] holds the copied coordinates.
 */
interface BatchPlan {
  readonly featureId: string;
  readonly origin: Vec3;
  readonly body: SolidBodyWithSubShapes;
  readonly faces: SolidFaceEntry[];
  readonly edges: SolidEdgeEntry[];
  readonly vertices: Vec3[];
  faceCorners: number;
  edgeSegments: number;
}
function createPlan(featureId: string, origin: Vec3, body: SolidBodyWithSubShapes): BatchPlan {
  return { featureId, origin, body, faces: [], edges: [], vertices: [], faceCorners: 0, edgeSegments: 0 };
}
function findByIndex<T extends { readonly index: number }>(entries: readonly T[], index: number): T | null {
  const direct = entries[index];
  return direct !== undefined && direct.index === index
    ? direct : entries.find((entry) => entry.index === index) ?? null;
}
function localVertex(plan: BatchPlan, world: Vec3): readonly [number, number, number] {
  return [world[0] - plan.origin[0], world[1] - plan.origin[1], world[2] - plan.origin[2]];
}
function planVertex(plan: BatchPlan, world: Vec3, keys: Set<string>): void {
  const key = `${world[0]},${world[1]},${world[2]}`;
  if (keys.has(key)) return;
  if (!localVertex(plan, world).every((value) => Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX)) return;
  keys.add(key);
  plan.vertices.push(world);
}
function faceRange(body: SolidBodyWithSubShapes, face: SolidFaceEntry): readonly [number, number] {
  const begin = Math.max(0, face.triangleOffset * 3);
  return [begin, Math.min(begin + Math.max(0, face.triangleCount) * 3, body.mesh.indices.length)];
}
/** The one corner predicate shared by the count and fill passes. */
function usableCorner(body: SolidBodyWithSubShapes, offset: number): boolean {
  const { positions, normals, indices } = body.mesh;
  const base = indices[offset] * 3;
  return base + 2 < positions.length && base + 2 < normals.length
    && [positions[base], positions[base + 1], positions[base + 2],
      normals[base], normals[base + 1], normals[base + 2]].every(Number.isFinite);
}
function edgeRange(body: SolidBodyWithSubShapes, edge: SolidEdgeEntry): readonly [number, number] {
  const begin = Math.max(0, edge.segmentOffset * 6);
  return [begin, Math.min(begin + Math.max(0, edge.segmentCount) * 6, body.mesh.edgePositions.length)];
}
/** The one segment predicate shared by the count and fill passes. */
function usableSegment(positions: Float32Array, offset: number): boolean {
  return [0, 1, 2, 3, 4, 5].every((component) => Number.isFinite(positions[offset + component]));
}
function planFace(plan: BatchPlan, face: SolidFaceEntry): void {
  const [begin, end] = faceRange(plan.body, face);
  let corners = 0;
  for (let offset = begin; offset < end; offset += 1) if (usableCorner(plan.body, offset)) corners += 1;
  plan.faces.push(face);
  plan.faceCorners += corners;
}
function planEdge(plan: BatchPlan, edge: SolidEdgeEntry, includeEndpoints: boolean, keys: Set<string>): void {
  const positions = plan.body.mesh.edgePositions;
  const [begin, end] = edgeRange(plan.body, edge);
  let segments = 0;
  for (let offset = begin; offset + 5 < end; offset += 6) if (usableSegment(positions, offset)) segments += 1;
  plan.edges.push(edge);
  plan.edgeSegments += segments;
  if (includeEndpoints) {
    planVertex(plan, edge.start, keys);
    planVertex(plan, edge.end, keys);
  }
}
function planElement(
  bodies: readonly SolidBodyWithSubShapes[], elementId: string,
  plans: Map<string, BatchPlan>, keys: Set<string>, includeEndpoints: boolean,
): void {
  const parsed = parseSubShapeId(elementId);
  if (parsed === null) return;
  const matches = bodies.filter((body) => body.featureId === parsed.bodyFeatureId);
  if (matches.length !== 1) return;
  const body = matches[0];
  const origin = subShapeFrameOrigin(body);
  if (origin === null || body.isValid === false) return;
  let plan = plans.get(body.featureId);
  if (plan === undefined) {
    plan = createPlan(body.featureId, origin, body);
    plans.set(body.featureId, plan);
  }
  switch (parsed.kind) {
    case 'face': {
      const face = findByIndex(body.faces ?? [], parsed.index);
      if (face !== null) planFace(plan, face);
      break;
    }
    case 'edge': {
      const edge = findByIndex(body.edges ?? [], parsed.index);
      if (edge !== null) planEdge(plan, edge, includeEndpoints, keys);
      break;
    }
    case 'vertex': {
      const vertex = findByIndex(body.vertices ?? [], parsed.index);
      if (vertex !== null) planVertex(plan, vertex.position, keys);
      break;
    }
  }
}
function contributes(plan: BatchPlan): boolean {
  return plan.faceCorners > 0 || plan.edgeSegments > 0 || plan.vertices.length > 0;
}
/** Exact typed bytes of one planned batch: positions/normals 12B and index 4B per corner, 24B per segment, 12B per vertex. */
function planBytes(plan: BatchPlan): number {
  return plan.faceCorners * 28 + plan.edgeSegments * 24 + plan.vertices.length * 12;
}
function fill(plan: BatchPlan, allocated?: (buffer: ArrayBufferLike) => void): SubShapeHighlightBatch {
  const { positions, normals, indices, edgePositions: edgeSource } = plan.body.mesh;
  const facePositions = new Float32Array(plan.faceCorners * 3);
  notifyAllocatedBacking(allocated, facePositions.buffer);
  const faceNormals = new Float32Array(plan.faceCorners * 3);
  notifyAllocatedBacking(allocated, faceNormals.buffer);
  const faceIndices = new Uint32Array(plan.faceCorners);
  notifyAllocatedBacking(allocated, faceIndices.buffer);
  let corner = 0;
  for (const face of plan.faces) {
    const [begin, end] = faceRange(plan.body, face);
    for (let offset = begin; offset < end; offset += 1) {
      if (!usableCorner(plan.body, offset)) continue;
      if (corner >= plan.faceCorners) throw new RangeError('Sub-shape overlay count changed while filling');
      const base = indices[offset] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        facePositions[corner * 3 + axis] = positions[base + axis];
        faceNormals[corner * 3 + axis] = normals[base + axis];
      }
      faceIndices[corner] = corner;
      corner += 1;
    }
  }
  const edgePositions = new Float32Array(plan.edgeSegments * 6);
  notifyAllocatedBacking(allocated, edgePositions.buffer);
  let segment = 0;
  for (const edge of plan.edges) {
    const [begin, end] = edgeRange(plan.body, edge);
    for (let offset = begin; offset + 5 < end; offset += 6) {
      if (!usableSegment(edgeSource, offset)) continue;
      if (segment >= plan.edgeSegments) throw new RangeError('Sub-shape overlay count changed while filling');
      edgePositions.set(edgeSource.subarray(offset, offset + 6), segment * 6);
      segment += 1;
    }
  }
  if (corner !== plan.faceCorners || segment !== plan.edgeSegments) {
    throw new RangeError('Sub-shape overlay count changed while filling');
  }
  const vertexPositions = new Float32Array(plan.vertices.length * 3);
  notifyAllocatedBacking(allocated, vertexPositions.buffer);
  plan.vertices.forEach((world, index) => {
    const local = localVertex(plan, world);
    for (let axis = 0; axis < 3; axis += 1) vertexPositions[index * 3 + axis] = local[axis];
  });
  return { featureId: plan.featureId, origin: plan.origin, facePositions, faceNormals, faceIndices,
    edgePositions, vertexPositions };
}
function finalize(emphasis: SubShapeEmphasis, plans: readonly BatchPlan[], allocated?: (buffer: ArrayBufferLike) => void): SubShapeHighlight {
  const batches = plans.map(plan => fill(plan, allocated));
  if (batches.length === 0) return emphasis === 'hovered' ? EMPTY_HOVERED_HIGHLIGHT : EMPTY_SELECTED_HIGHLIGHT;
  return { emphasis, batches };
}
/** Exact bytes of every typed array a highlight bundle owns (hovered and selected together). */
export function subShapeOverlayBytes(bundle: SubShapeHighlightBundle): number {
  let bytes = 0;
  for (const batch of [...bundle.hovered.batches, ...bundle.selected.batches]) {
    bytes += batch.facePositions.byteLength + batch.faceNormals.byteLength + batch.faceIndices.byteLength
      + batch.edgePositions.byteLength + batch.vertexPositions.byteLength;
  }
  return bytes;
}
export function buildSubShapeGeometry(
  bodies: readonly SolidBodyWithSubShapes[], hoveredElementId: string | null, selection: readonly string[],
  budget?: SubShapeOverlayBudget,
  allocated?: (buffer: ArrayBufferLike) => void,
): SubShapeHighlightBundle {
  const selectedPlans = new Map<string, BatchPlan>();
  const selectedKeys = new Set<string>();
  for (const elementId of selection) planElement(bodies, elementId, selectedPlans, selectedKeys, true);
  const hoveredPlans = new Map<string, BatchPlan>();
  if (hoveredElementId !== null && !selection.includes(hoveredElementId)) {
    planElement(bodies, hoveredElementId, hoveredPlans, new Set<string>(), false);
  }
  const hovered = [...hoveredPlans.values()].filter(contributes);
  const selected = [...selectedPlans.values()].filter(contributes);
  if (budget !== undefined) {
    const { limitBytes, reservedBytes } = budget;
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || !Number.isSafeInteger(reservedBytes)
      || reservedBytes < 0) throw new RangeError(OVERLAY_BUDGET_MESSAGE);
    let required = reservedBytes;
    for (const plan of [...hovered, ...selected]) {
      required += planBytes(plan);
      if (!Number.isSafeInteger(required) || required > limitBytes) throw new RangeError(OVERLAY_BUDGET_MESSAGE);
    }
  }
  const hoveredHighlight = finalize('hovered', hovered, allocated);
  const selectedHighlight = finalize('selected', selected, allocated);
  if (hoveredHighlight === EMPTY_HOVERED_HIGHLIGHT && selectedHighlight === EMPTY_SELECTED_HIGHLIGHT) {
    return EMPTY_SUB_SHAPE_HIGHLIGHT;
  }
  const batches = [...hoveredHighlight.batches, ...selectedHighlight.batches];
  return {
    hovered: hoveredHighlight, selected: selectedHighlight,
    faceTriangleCount: batches.reduce((count, batch) => count + batch.faceIndices.length / 3, 0),
    edgeCount: batches.reduce((count, batch) => count + batch.edgePositions.length / 6, 0),
    vertexCount: batches.reduce((count, batch) => count + batch.vertexPositions.length / 3, 0),
  };
}
