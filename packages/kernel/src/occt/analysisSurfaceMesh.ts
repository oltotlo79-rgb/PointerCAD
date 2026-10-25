/**
 * Analysis boundary: one topology-connected, double-precision triangulated boundary for a CAD body.
 *
 * The display tessellation (`tessellate.ts`) is face-separated Float32: every face owns its own nodes, so two faces
 * that share a B-rep edge are not connected in the mesh. An analysis (volume mesher, shell solver) needs the
 * opposite: a node on a shared edge must be one node. This module builds that boundary from OCCT topology only.
 *
 * ## Rules (each one is checked, never assumed)
 *
 * - Nodes are connected only through actual shared topology. One node per topological vertex
 *   (`TopTools_IndexedMapOfShape`, `IsSame` identity), one node chain per topological edge. Face triangulation nodes
 *   are attached to those chains through `BRep_Tool.PolygonOnTriangulation_1`, never by distance. Two bodies or two
 *   faces that merely touch stay separate.
 * - Every face that uses an edge must have subdivided it identically (same node count and the same curve
 *   parameters, compared exactly). Anything else is a T-junction or an inconsistent subdivision and is refused.
 * - Periodic seams: an edge that is closed on a face (`BRep_Tool.IsClosed_2`) has two polygon representations on
 *   that face's triangulation. In the installed OCCT, `PolygonOnTriangulation_2/_3` are setters; the only getter is
 *   `_1(E, T, L)`, which returns the second representation when the edge is REVERSED. Both are read and both are
 *   bound to the same edge chain, which closes the seam.
 * - Degenerated edges (poles): every polygon node maps to the single vertex. Triangles that collapse onto that one
 *   node are dropped and counted; any other collapse is refused.
 * - Coordinates are double. Vertex nodes come from `BRep_Tool.Pnt`, edge nodes from `BRepAdaptor_Curve.Value` at the
 *   polygon parameter, interior face nodes from the triangulation node moved by the face location. OCCT applies
 *   each placement exactly once on these three paths; nothing is placed twice. Units are mm (NFR-RE-3).
 * - Face orientation: triangles of a REVERSED face are flipped, as in the display path. INTERNAL/EXTERNAL faces are
 *   refused. In closed mode every mesh edge must be used exactly twice in opposite directions, and the enclosed
 *   signed volume must be positive (outward normals).
 * - Nonfinite coordinates, zero-area triangles, duplicate triangles and invalid indices are refused.
 *
 * The cached body is never touched: a `BRepBuilderAPI_Copy` is meshed and discarded (the `exportMesh.ts` decision),
 * so a refusal leaves the last good shape and its display mesh unchanged.
 *
 * ## What this does not claim
 *
 * The triangles come from `BRepMesh_IncrementalMesh` at the requested deflections. The result reports observed
 * quality metrics only. It is not quality-controlled, not a converged FEM mesh and not a remeshed curved shell.
 * Volume meshing and solver integration are outside this module.
 */
import type {
  BRepBuilderAPI_Copy,
  Handle_Poly_Triangulation,
  OpenCascadeInstance,
  TopLoc_Location,
  TopTools_IndexedMapOfShape,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations, type Allocations } from './allocations.js';
import { admitNativeMaterialDomain, maximumOccurrencesForTriangleCap } from './nativeMaterialDomain.js';
import { bindAnalyticNativeChain, type AnalyticNativeChainBinding,
  type AnalyticPlcFaceBinding } from './analysisSurfaceCertificate.js';
import { readNativeFreeformBound, freeformTriangleDistance, partitionedFreeformTriangleDistance,
  reduceAffineFreeformFans, type FreeformFaceDistance } from './analysisFreeformBound.js';
import { borrowHandle } from './borrowHandle.js';
import { measureVolume } from './solidMesh.js';

export type AnalysisBoundaryMode = 'closed' | 'open';

/** One owned request may refine actual native freeform tessellation within its existing deadline. */
export interface AnalysisFreeformRefinement {
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
  readonly maximumNodes: number;
  readonly maximumTriangles: number;
}

export interface AnalysisSurfaceMeshOptions {
  /** Chord deviation in mm; a positive finite number. */
  readonly linearDeflection: number;
  /** Angular deviation in radians; a positive finite number. */
  readonly angularDeflection: number;
  /** 'closed' refuses any free, non-manifold or inconsistently oriented mesh edge. */
  readonly boundary: AnalysisBoundaryMode;
  /** Refuse before allocating output arrays when the triangle count exceeds this positive safe integer. */
  readonly maximumTriangles: number;
  /**
   * Explicit FEM request only: native numerical solid-material validation of the meshed copy (never a certificate).
   * Requires boundary 'closed' and a real in-worker checkpoint; absent means the generic mesh, unchanged.
   */
  readonly materialValidation?: 'native-solid';
  readonly freeformRefinement?: AnalysisFreeformRefinement;
}

/** Topological origin of a node. */
export const ANALYSIS_NODE_VERTEX = 0;
export const ANALYSIS_NODE_EDGE = 1;
export const ANALYSIS_NODE_FACE = 2;

export interface AnalysisFaceSummary {
  /** 0-based face address, in the `TopExp.MapShapes_2(shape, map, true, true)` face order of `subShapeOrigins.ts`. */
  readonly index: number;
  readonly triangleCount: number;
  readonly reversed: boolean;
  readonly seamEdges: number;
  readonly degeneratedEdges: number;
  /** Triangles dropped because they collapsed onto a degenerated edge's single vertex node. */
  readonly collapsedPoleTriangles: number;
}

export interface AnalysisEdgeChain {
  /** 0-based edge address in the same `MapShapes_2` edge order as `subShapeOrigins.ts`. */
  readonly index: number;
  readonly degenerated: boolean;
  /** Number of face-side polygon representations bound to this chain (a seam on one face counts twice). */
  readonly uses: number;
  /** Node indices along increasing curve parameter, first and last are vertex nodes. */
  readonly nodes: readonly number[];
}

export interface AnalysisMeshMetrics {
  readonly totalAreaMm2: number;
  /** Sum of the component signed volumes; meaningful only for a closed boundary. */
  readonly signedVolumeMm3: number;
  /**
   * Signed volume of each triangle-connected component, each about its own first node (local reference, so a far
   * placement does not cancel digits). Closed mode requires > 0 for an outer shell and < 0 for a void shell.
   */
  readonly componentVolumesMm3: readonly number[];
  readonly minTriangleAreaMm2: number;
  readonly maxTriangleAreaMm2: number;
  /** Smallest and largest interior angle in degrees, observed only. */
  readonly minAngleDeg: number;
  readonly maxAngleDeg: number;
  /** Largest distance between a face triangulation node and the topological vertex/edge node it was bound to. */
  readonly maxBoundNodeOffsetMm: number;
  /** Mesh edges used by one triangle only (0 for a closed boundary). */
  readonly freeEdges: number;
  /** Triangle-adjacency connected components. */
  readonly components: number;
}

export interface AnalysisSurfaceMesh {
  readonly units: 'mm';
  readonly boundary: AnalysisBoundaryMode;
  /** x, y, z per node, double precision, world coordinates of the body. */
  readonly coordinates: Float64Array;
  /** Node kind per node: ANALYSIS_NODE_VERTEX / _EDGE / _FACE. */
  readonly nodeKinds: Uint8Array;
  /** Three node indices per triangle, counter-clockwise seen from outside for outward faces. */
  readonly triangles: Uint32Array;
  /** 0-based face address per triangle. */
  readonly triangleFaces: Uint32Array;
  readonly nodeCount: number;
  readonly triangleCount: number;
  readonly faces: readonly AnalysisFaceSummary[];
  /** Edge-connected triangle components, classified by the original OCCT solid's outer/void shells. */
  readonly shells?: readonly { readonly role: 'outer' | 'cavity'; readonly triangles: readonly number[] }[];
  readonly edges: readonly AnalysisEdgeChain[];
  readonly metrics: AnalysisMeshMetrics;
  readonly mesher: { readonly done: boolean; readonly status: number };
  readonly deflection: { readonly linear: number; readonly angular: number };
  /** Same-copy native chart evidence, emitted only by the material-validation path; not display deflection. */
  readonly freeform?: { readonly schema: 'pointercad-freeform-distance/1'; readonly faces: readonly FreeformFaceDistance[] };
}

export type AnalysisBoundaryErrorCode =
  | 'invalid-options' | 'copy-failed' | 'copy-history' | 'mesher-failed' | 'missing-triangulation' | 'unsupported-orientation'
  | 'missing-edge-polygon' | 'missing-edge-parameters' | 'unknown-subshape' | 'inconsistent-subdivision'
  | 'node-conflict' | 'collapsed-triangle' | 'nonfinite' | 'zero-area' | 'duplicate-triangle'
  | 'orientation-conflict' | 'nonmanifold' | 'open-boundary' | 'inward-orientation' | 'limit' | 'empty'
  | 'material-invalid';

/** Worker request: the cached body is named by its shape-cache key, like measure/export (`ResolvedSolidStep.key`). */
export interface AnalysisSurfaceMeshRequest {
  readonly bodyKey: string;
  readonly boundary: AnalysisBoundaryMode;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  /** Clonable FEM opt-in; the worker supplies the checkpoint itself (functions never cross the request). */
  readonly materialValidation?: 'native-solid';
  readonly freeformRefinement?: AnalysisFreeformRefinement;
}

export type AnalysisSurfaceMeshResult =
  | { readonly kind: 'mesh'; readonly bodyKey: string; readonly mesh: AnalysisSurfaceMesh }
  | { readonly kind: 'failed'; readonly bodyKey: string;
      readonly code: AnalysisBoundaryErrorCode | 'missing-body' | 'face-table-mismatch';
      readonly message: string; readonly faceIndex: number | null };

/**
 * The four reply buffers, for `Comlink.transfer`. Refuses unless every array exactly covers its own ArrayBuffer, the
 * buffers are distinct, and none is in `retained` (cached display/hidden/pending mesh backings): transferring must
 * never detach an array anything else still uses.
 */
export function analysisMeshBuffers(mesh: AnalysisSurfaceMesh, retained: Iterable<ArrayBufferLike>): ArrayBuffer[] {
  const forbidden = new Set<ArrayBufferLike>(retained);
  const buffers: ArrayBuffer[] = [];
  for (const view of [mesh.coordinates, mesh.nodeKinds, mesh.triangles, mesh.triangleFaces]) {
    const buffer = view.buffer;
    if (!(buffer instanceof ArrayBuffer) || view.byteOffset !== 0 || view.byteLength !== buffer.byteLength
      || forbidden.has(buffer) || buffers.includes(buffer)) {
      throw new Error('解析用の境界の配列が専用の領域ではないため、渡せません。');
    }
    buffers.push(buffer);
  }
  return buffers;
}

/** Refusal with a stable code for callers and a Japanese message that can be shown as is (FR-504). */
export class AnalysisBoundaryError extends Error {
  constructor(readonly code: AnalysisBoundaryErrorCode, message: string, readonly faceIndex: number | null = null) {
    super(message);
    this.name = 'AnalysisBoundaryError';
  }
}

function refuse(code: AnalysisBoundaryErrorCode, message: string, faceIndex: number | null = null): never {
  throw new AnalysisBoundaryError(code, message, faceIndex);
}

/**
 * The one conversion for everything thrown while building. An Error keeps its identity (a refusal, or a cancellation
 * or deadline thrown by the caller's checkpoint); any other value (a native exception, a checkpoint that throws a
 * plain object) becomes an Error that keeps the original value as `cause`.
 */
function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

const NATIVE_CONSTRUCTION_FAILED = 'analysis-mesh: native construction failed';

/** The caller's checkpoint with the same conversion, for the calls made outside `buildAnalysisSurfaceMeshInternal`. */
function convertedCheckpoint(checkpoint: () => void): () => void {
  return () => {
    try { checkpoint(); } catch (error) { throw asError(error, NATIVE_CONSTRUCTION_FAILED); }
  };
}

/** Half-edge keys are `from * nodeCount + to`; they stay exact integers below this node count. */
const MAXIMUM_AUDIT_NODES = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));

const faceLabel = (index: number): string => `面 ${String(index + 1)}`;

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function checkedOptions(options: AnalysisSurfaceMeshOptions): void {
  if (!positiveFinite(options.linearDeflection) || !positiveFinite(options.angularDeflection)) {
    refuse('invalid-options', '解析用の境界の細かさ(偏差)は 0 より大きい有限の数にしてください。');
  }
  if (options.boundary !== 'closed' && options.boundary !== 'open') {
    refuse('invalid-options', '解析用の境界は閉じた境界か開いた境界のどちらかを指定してください。');
  }
  if (!Number.isSafeInteger(options.maximumTriangles) || options.maximumTriangles <= 0) {
    refuse('invalid-options', '解析用の境界の三角形の上限は正の整数にしてください。');
  }
  const refinement = options.freeformRefinement;
  if (refinement !== undefined && (options.materialValidation !== 'native-solid' || options.boundary !== 'closed'
    || refinement === null || typeof refinement !== 'object'
    || Object.keys(refinement).length !== 4
    || !Object.keys(refinement).every(key => ['maximumChordDeviationMm', 'maximumVolumeDeviationMm3', 'maximumNodes', 'maximumTriangles'].includes(key))
    || !Number.isFinite(refinement.maximumChordDeviationMm) || refinement.maximumChordDeviationMm < 0
    || !Number.isFinite(refinement.maximumVolumeDeviationMm3) || refinement.maximumVolumeDeviationMm3 < 0
    || !Number.isSafeInteger(refinement.maximumNodes) || refinement.maximumNodes <= 0
    || !Number.isSafeInteger(refinement.maximumTriangles) || refinement.maximumTriangles <= 0
    || refinement.maximumTriangles > options.maximumTriangles)) {
    refuse('invalid-options', '自由曲面の再分割には閉じた材料領域と有限の誤差・容量の指定が必要です。');
  }
}

/** Members of one kind, in `MapShapes_2(shape, all, true, true)` order (the `subShapeOrigins.ts` address order). */
function mapKind(oc: OpenCascadeInstance, shape: TopoDS_Shape, kind: 'face' | 'edge' | 'vertex',
  owned: Allocations): TopTools_IndexedMapOfShape {
  const wanted = kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE
    : kind === 'edge' ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  const result = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, all, true, true);
  for (let index = 1; index <= all.Size(); index += 1) {
    const member = owned.keep(all.FindKey(index));
    if (member.ShapeType() === wanted) result.Add(member);
  }
  return result;
}

/** Growable double node table with a kind per node. */
class NodeTable {
  private xyz = new Float64Array(3 * 1024);
  private kinds = new Uint8Array(1024);
  count = 0;
  constructor(private readonly maximumNodes = MAXIMUM_AUDIT_NODES) {}
  add(x: number, y: number, z: number, kind: number): number {
    if (this.count >= this.maximumNodes) refuse('limit', '解析用の境界の節点が指定された上限を超えました。');
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      refuse('nonfinite', '解析用の境界に有限でない座標が現れました。形を確かめてください。');
    }
    if (this.count === this.kinds.length) {
      const xyz = new Float64Array(this.xyz.length * 2);
      xyz.set(this.xyz);
      this.xyz = xyz;
      const kinds = new Uint8Array(this.kinds.length * 2);
      kinds.set(this.kinds);
      this.kinds = kinds;
    }
    const index = this.count;
    this.xyz[3 * index] = x;
    this.xyz[3 * index + 1] = y;
    this.xyz[3 * index + 2] = z;
    this.kinds[index] = kind;
    this.count += 1;
    return index;
  }
  x(index: number): number { return this.xyz[3 * index]; }
  y(index: number): number { return this.xyz[3 * index + 1]; }
  z(index: number): number { return this.xyz[3 * index + 2]; }
  /** Exact-length copies owned by the caller (never views of the growable buffers). */
  coordinates(): Float64Array { return this.xyz.slice(0, 3 * this.count); }
  nodeKinds(): Uint8Array { return this.kinds.slice(0, this.count); }
}

interface EdgeRecord {
  readonly degenerated: boolean;
  readonly parameters: readonly number[];
  readonly nodes: readonly number[];
  uses: number;
}

interface PolygonRead {
  readonly locals: readonly number[];
  readonly parameters: readonly number[];
}

/** Read one polygon representation; `edge` orientation selects the seam side. */
function readPolygon(oc: OpenCascadeInstance, edge: TopoDS_Edge, triangulation: Handle_Poly_Triangulation,
  location: TopLoc_Location, faceIndex: number, owned: Allocations): PolygonRead {
  const handle = owned.keep(oc.BRep_Tool.PolygonOnTriangulation_1(edge, triangulation, location));
  if (handle.IsNull()) {
    return refuse('missing-edge-polygon',
      `${faceLabel(faceIndex)} の辺に三角形分割の上の折れ線がありません。細かさを変えるか、形を確かめてください。`, faceIndex);
  }
  const polygon = handle.get();
  if (!polygon.HasParameters()) {
    return refuse('missing-edge-parameters',
      `${faceLabel(faceIndex)} の辺の折れ線に曲線の媒介変数がありません。形を確かめてください。`, faceIndex);
  }
  const count = Number(polygon.NbNodes());
  if (!Number.isSafeInteger(count) || count < 2) {
    return refuse('missing-edge-polygon', `${faceLabel(faceIndex)} の辺の折れ線の節点が足りません。`, faceIndex);
  }
  const locals: number[] = [];
  const parameters: number[] = [];
  for (let k = 1; k <= count; k += 1) {
    locals.push(Number(polygon.Node(k)));
    parameters.push(polygon.Parameter(k));
  }
  for (let k = 1; k < count; k += 1) {
    if (!(parameters[k] > parameters[k - 1])) {
      return refuse('inconsistent-subdivision',
        `${faceLabel(faceIndex)} の辺の分割点が曲線の向きに並んでいません。細かさを変えるか、形を確かめてください。`, faceIndex);
    }
  }
  return { locals, parameters };
}

function vertexNode(oc: OpenCascadeInstance, edge: TopoDS_Edge, first: boolean, vertices: TopTools_IndexedMapOfShape,
  vertexNodes: Map<number, number>, nodes: NodeTable, owned: Allocations, faceIndex: number): number {
  const vertex = owned.keep(first ? oc.TopExp.FirstVertex(edge, false) : oc.TopExp.LastVertex(edge, false));
  const index = vertex.IsNull() ? 0 : vertices.FindIndex(vertex);
  if (index <= 0) {
    return refuse('unknown-subshape', `${faceLabel(faceIndex)} の辺の端の頂点がボディの頂点に見つかりません。`, faceIndex);
  }
  const known = vertexNodes.get(index);
  if (known !== undefined) return known;
  const point = owned.keep(oc.BRep_Tool.Pnt(vertex));
  const node = nodes.add(point.X(), point.Y(), point.Z(), ANALYSIS_NODE_VERTEX);
  vertexNodes.set(index, node);
  return node;
}

/** Create the shared node chain of one edge from its first polygon representation. */
function createEdgeRecord(oc: OpenCascadeInstance, edge: TopoDS_Edge, degenerated: boolean, polygon: PolygonRead,
  vertices: TopTools_IndexedMapOfShape, vertexNodes: Map<number, number>, nodes: NodeTable, faceIndex: number): EdgeRecord {
  const owned = createAllocations();
  try {
    const first = vertexNode(oc, edge, true, vertices, vertexNodes, nodes, owned, faceIndex);
    const last = vertexNode(oc, edge, false, vertices, vertexNodes, nodes, owned, faceIndex);
    const count = polygon.parameters.length;
    const chain: number[] = [first];
    if (degenerated) {
      if (first !== last) {
        refuse('inconsistent-subdivision', `${faceLabel(faceIndex)} の退化した辺の両端が別の頂点です。形を確かめてください。`, faceIndex);
      }
      for (let k = 1; k < count; k += 1) chain.push(first);
    } else {
      const curve = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
      for (let k = 1; k < count - 1; k += 1) {
        const point = curve.Value(polygon.parameters[k]);
        try {
          chain.push(nodes.add(point.X(), point.Y(), point.Z(), ANALYSIS_NODE_EDGE));
        } finally {
          point.delete();
        }
      }
      chain.push(last);
    }
    return { degenerated, parameters: polygon.parameters, nodes: chain, uses: 0 };
  } finally {
    owned.release();
  }
}

function sameParameters(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface FaceTriangulation {
  readonly local: readonly [number, number, number][];
  readonly localPoints: Float64Array;
}

/** Read the face triangulation; node coordinates are moved by the face location exactly once (OCCT `Transformed`). */
function readFaceTriangulation(triangulationHandle: Handle_Poly_Triangulation,
  location: TopLoc_Location, owned: Allocations): FaceTriangulation {
  const triangulation = triangulationHandle.get();
  const nodeCount = Number(triangulation.NbNodes());
  const triangleCount = Number(triangulation.NbTriangles());
  const localPoints = new Float64Array(3 * (nodeCount + 1));
  const transformation = location.IsIdentity() ? null : owned.keep(location.Transformation());
  for (let i = 1; i <= nodeCount; i += 1) {
    const node = triangulation.Node(i);
    try {
      if (transformation === null) {
        localPoints[3 * i] = node.X();
        localPoints[3 * i + 1] = node.Y();
        localPoints[3 * i + 2] = node.Z();
      } else {
        const moved = node.Transformed(transformation);
        localPoints[3 * i] = moved.X();
        localPoints[3 * i + 1] = moved.Y();
        localPoints[3 * i + 2] = moved.Z();
        moved.delete();
      }
    } finally {
      node.delete();
    }
  }
  const local: [number, number, number][] = [];
  const triangles = owned.keep(triangulation.Triangles());
  for (let i = 1; i <= triangleCount; i += 1) {
    const triangle = triangles.Value(i);
    try {
      local.push([Number(triangle.Value(1)), Number(triangle.Value(2)), Number(triangle.Value(3))]);
    } finally {
      triangle.delete();
    }
  }
  return { local, localPoints };
}

interface HistoryImage {
  /** The copied sub-shape as keyed in the copy's own map (same TShape, location and orientation as the image). */
  readonly shape: TopoDS_Shape;
  /** 1-based index in the copy's map of the same kind. */
  readonly copyIndex: number;
}

/**
 * Original address (array position, 0-based) -> copied sub-shape, from the copier's history only.
 *
 * Each original must have exactly one image (`Modified` has one member and it `IsSame` `ModifiedShape`), the image
 * must be a member of the copy's map (`FindIndex`, i.e. `IsSame` membership), no two originals may claim one image,
 * and the copy-map member's accumulated orientation must equal the original's. Anything else is refused; there is
 * no positional fallback.
 */
function historyImages(copier: BRepBuilderAPI_Copy, originals: TopTools_IndexedMapOfShape,
  copies: TopTools_IndexedMapOfShape, kind: 'face' | 'edge', owned: Allocations): HistoryImage[] {
  const label = kind === 'face' ? '面' : '辺';
  if (originals.Size() !== copies.Size()) {
    refuse('copy-history', `解析用の形の${label}の数が元の形と一致しません。形を確かめてください。`);
  }
  const images: HistoryImage[] = [];
  const claimed = new Set<number>();
  for (let index = 1; index <= originals.Size(); index += 1) {
    const original = owned.keep(originals.FindKey(index));
    let modifiedCount = 0;
    let image: TopoDS_Shape | null;
    let sameAsListed = false;
    try {
      const modified = owned.keep(copier.Modified(original));
      modifiedCount = modified.Size();
      image = owned.keep(copier.ModifiedShape(original));
      sameAsListed = modifiedCount === 1 && owned.keep(modified.First_1()).IsSame(image);
    } catch {
      image = null;
    }
    const where = kind === 'face' ? index - 1 : null;
    if (image === null || image.IsNull()) {
      refuse('copy-history', `元の${label} ${String(index)} の複製の履歴が見つかりません。形を確かめてください。`, where);
    }
    if (modifiedCount !== 1 || !sameAsListed) {
      refuse('copy-history', `元の${label} ${String(index)} の複製先が 1 つに決まりません。形を確かめてください。`, where);
    }
    const copyIndex = copies.FindIndex(image);
    if (copyIndex <= 0 || claimed.has(copyIndex)) {
      refuse('copy-history', `元の${label} ${String(index)} の複製先が複製の形に 1 対 1 で見つかりません。`, where);
    }
    const keyed = owned.keep(copies.FindKey(copyIndex));
    // Compare like with like: both map members carry the orientation accumulated from their own root
    // (MapShapes_2 cumOri = true). The history image keeps the stored, non-accumulated orientation
    // (BRepTools_Modifier binds its keys through TopoDS_Iterator with cumOri = false), so it is used only for
    // identity (IsSame membership above), not for the orientation check.
    if (keyed.Orientation_1() !== original.Orientation_1()) {
      refuse('copy-history', `元の${label} ${String(index)} と複製の向きが一致しません。形を確かめてください。`, where);
    }
    claimed.add(copyIndex);
    images.push({ shape: keyed, copyIndex });
  }
  return images;
}

/** Original face addresses classified by each solid's `BRepClass3d.OuterShell`, never by signed volume alone. */
function voidFaceAddresses(oc: OpenCascadeInstance, shape: TopoDS_Shape, originalFaces: TopTools_IndexedMapOfShape,
  owned: Allocations, boundary: AnalysisBoundaryMode): Set<number> {
  const voids = new Set<number>();
  const classified = new Map<number, boolean>();
  const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, all, true, true);
  for (let index = 1; index <= all.Size(); index += 1) {
    const member = owned.keep(all.FindKey(index));
    if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) continue;
    const solid = owned.keep(oc.TopoDS.Solid_1(member));
    const orientation = solid.Orientation_1();
    if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
      refuse('unsupported-orientation', 'ソリッドが内部または外部の向きで、外側と空洞の殻を分類できません。');
    }
    // OCCT 7.6.2 OuterShell classifies multi-shell solids by the infinite point. Reversing the material can make
    // a cavity the returned outer shell. Normalize ONLY this classification view; IsSame ignores orientation.
    // Keep the accumulated material orientation below and in the copied faces, so the signed audit rejects it.
    const classificationSolid = orientation === oc.TopAbs_Orientation.TopAbs_REVERSED
      ? owned.keep(oc.TopoDS.Solid_1(owned.keep(solid.Reversed()))) : solid;
    const outer = owned.keep(oc.BRepClass3d.OuterShell(classificationSolid));
    if (outer.IsNull()) refuse('unsupported-orientation', 'ソリッドの外側の殻が見つかりません。形を確かめてください。');
    const parts = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(solid, parts, true, true);
    for (let part = 1; part <= parts.Size(); part += 1) {
      const shell = owned.keep(parts.FindKey(part));
      if (shell.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) continue;
      const cavity = !shell.IsSame(outer);
      const shellParts = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(shell, shellParts, true, true);
      for (let item = 1; item <= shellParts.Size(); item += 1) {
        const face = owned.keep(shellParts.FindKey(item));
        if (face.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const address = originalFaces.FindIndex(face);
        if (address <= 0) refuse('unknown-subshape', '殻の面が元のボディの面に見つかりません。');
        const previous = classified.get(address - 1);
        if (previous !== undefined && previous !== cavity) {
          refuse('orientation-conflict', '同じ面が外側と空洞の両方の殻に含まれています。形を確かめてください。');
        }
        classified.set(address - 1, cavity);
        if (cavity) voids.add(address - 1);
      }
    }
  }
  if (boundary === 'closed' && classified.size !== originalFaces.Size()) {
    refuse('unsupported-orientation', '閉じた境界の全ての面がソリッドの外側か空洞の殻に属することを確認できません。');
  }
  return voids;
}

/**
 * Build the analysis boundary of `shape` (a cached body; it is only read and copied, never meshed in place).
 * Throws `AnalysisBoundaryError` with an actionable message on every refusal. A throw from `materialCheckpoint` is not
 * a refusal: an Error propagates with its identity, any other value as an Error whose `cause` is that value.
 */
export function buildAnalysisSurfaceMesh(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  options: AnalysisSurfaceMeshOptions, materialCheckpoint?: () => void): AnalysisSurfaceMesh {
  checkedOptions(options);
  const refinement = options.freeformRefinement;
  if (refinement === undefined) return buildAnalysisSurfaceMeshInternal(oc, shape, options, undefined, materialCheckpoint);
  if (materialCheckpoint === undefined) refuse('invalid-options', '再分割には同じ要求の時間と取消しの確認が必要です。');
  // The checks in this loop run outside buildAnalysisSurfaceMeshInternal's conversion, so they get the same one here.
  const checkpoint = convertedCheckpoint(materialCheckpoint);
  let linear = options.linearDeflection, angular = options.angularDeflection;
  // No catch/retry: only a complete, valid mesh with unmet numerical budgets reaches the next pass.
  for (let pass = 0; pass < 8; pass += 1) {
    checkpoint();
    let nativeVolume = Number.NaN;
    const mesh = buildAnalysisSurfaceMeshInternal(oc, shape, { ...options,
      linearDeflection: linear, angularDeflection: angular, maximumTriangles: refinement.maximumTriangles },
    undefined, materialCheckpoint, volume => { nativeVolume = volume; });
    // Internal cleanup has already completed, including on the last or a refused pass.
    checkpoint();
    if (mesh.nodeCount > refinement.maximumNodes || mesh.triangleCount > refinement.maximumTriangles) {
      refuse('limit', '自由曲面の解析境界が指定された容量を超えました。');
    }
    if (!positiveFinite(nativeVolume)) refuse('material-invalid', '同じ材料領域の体積を有限の正数として確認できませんでした。');
    const faces = mesh.freeform?.faces;
    if (faces === undefined || faces.length === 0) {
      refuse('invalid-options', '自由曲面の再分割には実曲面の距離検査が必要です。');
    }
    let maximumDistance = 0;
    for (const face of faces) for (const triangle of face.triangles) {
      checkpoint();
      if (!Number.isFinite(triangle.maxChordDeviationMm) || triangle.maxChordDeviationMm < 0) {
        refuse('nonfinite', '自由曲面の距離検査が有限ではありません。');
      }
      maximumDistance = Math.max(maximumDistance, triangle.maxChordDeviationMm);
    }
    const volumeDifference = Math.abs(nativeVolume - mesh.metrics.signedVolumeMm3);
    if (!Number.isFinite(volumeDifference)) refuse('nonfinite', '自由曲面の境界の体積差が有限ではありません。');
    if (maximumDistance <= refinement.maximumChordDeviationMm
      && volumeDifference <= refinement.maximumVolumeDeviationMm3) return mesh;
    linear /= 2;
    angular /= 2;
    if (!positiveFinite(linear) || !positiveFinite(angular)) break;
  }
  refuse('limit', '同じ要求の再分割回数内に自由曲面の距離・体積の許容値を満たせませんでした。');
}

/**
 * Internal proof preparation through the SAME mesher and live copier. This is not a certified mesh API:
 * binding.geometricallyClosed is false, and neither the mesh nor this result contains a certificate.
 * The caller supplies its existing owned deadline/abort checkpoint; no new time allowance is created.
 */
export function buildAnalysisSurfaceMeshBinding(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  options: AnalysisSurfaceMeshOptions, checkpoint: () => void): {
    readonly mesh: AnalysisSurfaceMesh; readonly binding: AnalyticNativeChainBinding;
  } {
  if (options.boundary !== 'closed') refuse('invalid-options', '証明用の対応付けには閉じた境界が必要です。');
  if (options.freeformRefinement !== undefined) {
    refuse('invalid-options', '証明用の対応付けは一つの実コピーに対する処理です。再分割は解析境界の通常の窓口で指定してください。');
  }
  let binding: AnalyticNativeChainBinding | undefined;
  const mesh = buildAnalysisSurfaceMeshInternal(oc, shape, options, {
    checkpoint, accept: value => { binding = value; },
  });
  if (binding === undefined || binding.interior === undefined) throw new Error('analytic-certificate: missing producer binding');
  return { mesh, binding };
}

function buildAnalysisSurfaceMeshInternal(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  options: AnalysisSurfaceMeshOptions, analytic?: {
    readonly checkpoint: () => void; readonly accept: (binding: AnalyticNativeChainBinding) => void;
  }, materialCheckpoint?: () => void, acceptNativeVolume?: (volume: number) => void): AnalysisSurfaceMesh {
  checkedOptions(options);
  const owned = createAllocations();
  let result: AnalysisSurfaceMesh | undefined;
  let primary: Error | undefined;
  try {
    // The caller's checkpoints are external callbacks. These first calls run inside the conversion below, like every
    // later one: a checkpoint that throws a non-Error value must not leave this function unconverted.
    analytic?.checkpoint();
    materialCheckpoint?.();
    const originalFaces = mapKind(oc, shape, 'face', owned);
    if (originalFaces.Size() === 0) refuse('empty', '解析用の境界を作る面がありません。');

    // copyGeom = false shares geometry; copyMesh = false leaves the display triangulation behind (exportMesh.ts).
    const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, false, false));
    if (!copier.IsDone()) refuse('copy-failed', '解析用の形を用意できませんでした。');
    const copy = owned.keep(copier.Shape());
    materialCheckpoint?.();
    const mesher = owned.keep(new oc.BRepMesh_IncrementalMesh_2(copy, options.linearDeflection, false,
      options.angularDeflection, false));
    materialCheckpoint?.();
    const done = mesher.IsDone();
    const status = Number(mesher.GetStatusFlags());
    if (!done || status !== 0) {
      refuse('mesher-failed', `三角形分割を完了できませんでした(状態 ${String(status)})。細かさを変えるか、形を確かめてください。`);
    }
    if (options.materialValidation !== undefined) {
      if (options.materialValidation !== 'native-solid' || options.boundary !== 'closed') {
        refuse('invalid-options', '材料領域の確認には閉じた境界が必要です。');
      }
      const checkpoint = materialCheckpoint ?? analytic?.checkpoint;
      if (checkpoint === undefined) refuse('invalid-options', '材料領域の確認には要求の時間と取消しの確認が必要です。');
      // Same copy, same owner. Checkpoint/capacity/native throws propagate with their identity (no catch here).
      const material = admitNativeMaterialDomain(oc, copy, owned,
        maximumOccurrencesForTriangleCap(options.maximumTriangles), checkpoint);
      if (!material.nativeChecksPass) {
        refuse('material-invalid', '形の材料領域を確認できませんでした(向きの反転・重なり・重複・閉じていない殻のいずれか)。形を修正してください。');
      }
    }

    const copyFaces = mapKind(oc, copy, 'face', owned);
    const copyEdges = mapKind(oc, copy, 'edge', owned);
    const vertices = mapKind(oc, copy, 'vertex', owned);
    const originalEdges = mapKind(oc, shape, 'edge', owned);
    // Addresses are the ORIGINAL body's addresses (the ones its origin table refers to). The copied face/edge of each
    // original address comes from the copier's own history, never from positions in the copy.
    const faceImages = historyImages(copier, originalFaces, copyFaces, 'face', owned);
    const edgeImages = historyImages(copier, originalEdges, copyEdges, 'edge', owned);
    const originalEdgeOf = new Map<number, number>();
    edgeImages.forEach((image, address) => { originalEdgeOf.set(image.copyIndex, address); });
    const voidFaces = voidFaceAddresses(oc, shape, originalFaces, owned, options.boundary);

    const nodes = new NodeTable(options.freeformRefinement?.maximumNodes);
    const vertexNodes = new Map<number, number>();
    const edgeRecords = new Map<number, EdgeRecord>();
    const triangles: number[] = [];
    const triangleFaces: number[] = [];
    const summaries: AnalysisFaceSummary[] = [];
    const plcFaces: AnalyticPlcFaceBinding[] = [];
    const freeformFaces: FreeformFaceDistance[] = [];
    let maxBoundNodeOffset = 0;

    for (let faceIndex = 0; faceIndex < faceImages.length; faceIndex += 1) {
      analytic?.checkpoint();
      materialCheckpoint?.();
      const perFace = createAllocations();
      try {
        const face: TopoDS_Face = perFace.keep(oc.TopoDS.Face_1(faceImages[faceIndex].shape));
        const orientation = face.Orientation_1();
        const forward = orientation === oc.TopAbs_Orientation.TopAbs_FORWARD;
        if (!forward && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
          refuse('unsupported-orientation', `${faceLabel(faceIndex)} は内部または外部の向きの面で、境界に使えません。`, faceIndex);
        }
        const location = perFace.keep(new oc.TopLoc_Location_1());
        const triangulationHandle = perFace.keep(oc.BRep_Tool.Triangulation(face, location, 0));
        if (triangulationHandle.IsNull()) {
          refuse('missing-triangulation', `${faceLabel(faceIndex)} を三角形分割できませんでした。細かさを変えるか、形を確かめてください。`, faceIndex);
        }
        const read = readFaceTriangulation(triangulationHandle, location, perFace);
        const freeformCheckpoint = materialCheckpoint ?? analytic?.checkpoint;
        const freeform = options.materialValidation === undefined ? null
          : freeformCheckpoint === undefined ? null : readNativeFreeformBound(oc, face, perFace, freeformCheckpoint);
        const distanceRows: { triangleIndex: number; maxNodeOffsetMm: number; maxChordDeviationMm: number }[] = [];
        const nativeTriangles = borrowHandle(triangulationHandle);
        if (freeform !== null && !nativeTriangles.HasUVNodes()) throw new Error('freeform-bound: missing native UV nodes');
        const localNodeCount = read.localPoints.length / 3 - 1;
        const localToGlobal = new Int32Array(localNodeCount + 1).fill(-1);
        const poleNodes = new Set<number>();
        let seamEdges = 0;
        let degeneratedEdges = 0;

        const bind = (local: number, global: number): void => {
          if (!Number.isSafeInteger(local) || local < 1 || local > localNodeCount) {
            refuse('node-conflict', `${faceLabel(faceIndex)} の辺の折れ線が三角形分割にない節点を指しています。`, faceIndex);
          }
          const previous = localToGlobal[local];
          if (previous !== -1 && previous !== global) {
            refuse('node-conflict', `${faceLabel(faceIndex)} の節点が 2 つの別の辺の点に結び付きました。細かさを変えるか、形を確かめてください。`, faceIndex);
          }
          localToGlobal[local] = global;
          const dx = read.localPoints[3 * local] - nodes.x(global);
          const dy = read.localPoints[3 * local + 1] - nodes.y(global);
          const dz = read.localPoints[3 * local + 2] - nodes.z(global);
          maxBoundNodeOffset = Math.max(maxBoundNodeOffset, Math.sqrt(dx * dx + dy * dy + dz * dz));
        };

        const faceEdges = perFace.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(face, faceEdges, true, true);
        for (let member = 1; member <= faceEdges.Size(); member += 1) {
          const item = perFace.keep(faceEdges.FindKey(member));
          if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
          const edge = perFace.keep(oc.TopoDS.Edge_1(item));
          const edgeNumber = originalEdgeOf.get(copyEdges.FindIndex(edge));
          if (edgeNumber === undefined) {
            refuse('unknown-subshape', `${faceLabel(faceIndex)} の辺が元のボディの辺に対応付けられません。`, faceIndex);
          }
          const degenerated = oc.BRep_Tool.Degenerated(edge);
          const seam = oc.BRep_Tool.IsClosed_2(edge, face);
          if (seam) seamEdges += 1;
          if (degenerated) degeneratedEdges += 1;
          // The indexed map keeps one orientation per edge; a seam needs both sides explicitly.
          let sides: TopoDS_Edge[] = [edge];
          if (seam) {
            // Read typed native orientation values from the already-checked face and its reverse.
            // The generated enum namespace types its constants as {}, unlike Orientation_1().
            const opposite = perFace.keep(face.Reversed()).Orientation_1();
            const forwardOrientation = forward ? orientation : opposite;
            const reversedOrientation = forward ? opposite : orientation;
            sides = [perFace.keep(oc.TopoDS.Edge_1(perFace.keep(edge.Oriented(forwardOrientation)))),
              perFace.keep(oc.TopoDS.Edge_1(perFace.keep(edge.Oriented(reversedOrientation))))];
          }
          const polygons = sides.map(side => readPolygon(oc, side, triangulationHandle, location, faceIndex, perFace));
          const known = edgeRecords.get(edgeNumber);
          const record = known ?? createEdgeRecord(oc, edge, degenerated, polygons[0], vertices, vertexNodes, nodes, faceIndex);
          if (known === undefined) edgeRecords.set(edgeNumber, record);
          for (const polygon of polygons) {
            if (record.degenerated !== degenerated || !sameParameters(record.parameters, polygon.parameters)) {
              refuse('inconsistent-subdivision',
                `${faceLabel(faceIndex)} と隣の面で共有する辺の分割が一致しません(T 字の継ぎ目)。細かさを変えるか、形を確かめてください。`, faceIndex);
            }
            polygon.locals.forEach((local, k) => { bind(local, record.nodes[k]); });
            record.uses += 1;
          }
          if (degenerated) poleNodes.add(record.nodes[0]);
        }

        let localTriangles: readonly (readonly [number, number, number])[] = read.local;
        if (analytic === undefined && freeform?.grid !== undefined
          && read.local.length <= options.maximumTriangles && localNodeCount <= 3 * options.maximumTriangles) {
          const parameters: (readonly [number, number])[] = [[0, 0]];
          const protectedNodes = new Set<number>();
          for (let local = 1; local <= localNodeCount; local += 1) {
            freeformCheckpoint?.();
            const uv = nativeTriangles.UVNode(local);
            try { parameters.push([uv.X(), uv.Y()]); } finally { uv.delete(); }
            if (localToGlobal[local] !== -1) protectedNodes.add(local);
          }
          localTriangles = reduceAffineFreeformFans(freeform.grid, read.local, parameters, local => {
            const global = localToGlobal[local];
            return global === -1
              ? [read.localPoints[3 * local], read.localPoints[3 * local + 1], read.localPoints[3 * local + 2]]
              : [nodes.x(global), nodes.y(global), nodes.z(global)];
          }, protectedNodes, options.maximumTriangles, options.linearDeflection, options.angularDeflection,
          () => { freeformCheckpoint?.(); });
        }
        const usedLocals = localTriangles === read.local ? undefined : new Set(localTriangles.flat());
        for (let local = 1; local <= localNodeCount; local += 1) {
          if (localToGlobal[local] === -1 && (usedLocals === undefined || usedLocals.has(local))) {
            localToGlobal[local] = nodes.add(read.localPoints[3 * local], read.localPoints[3 * local + 1],
              read.localPoints[3 * local + 2], ANALYSIS_NODE_FACE);
          }
        }

        let faceTriangles = 0;
        let collapsed = 0;
        const plcTriangles: (number | null)[] = [];
        for (const [a, b, c] of localTriangles) {
          analytic?.checkpoint();
          materialCheckpoint?.();
          if (a < 1 || b < 1 || c < 1 || a > localNodeCount || b > localNodeCount || c > localNodeCount) {
            refuse('node-conflict', `${faceLabel(faceIndex)} の三角形が存在しない節点を指しています。`, faceIndex);
          }
          const ga = localToGlobal[a], gb = localToGlobal[b], gc = localToGlobal[c];
          if (ga === gb || gb === gc || ga === gc) {
            const repeated = ga === gb || ga === gc ? ga : gb;
            if (poleNodes.has(repeated)) {
              collapsed += 1;
              if (analytic !== undefined) plcTriangles.push(null);
              continue;
            }
            refuse('collapsed-triangle', `${faceLabel(faceIndex)} の三角形が 1 点に潰れました。細かさを変えるか、形を確かめてください。`, faceIndex);
          }
          if (analytic !== undefined) plcTriangles.push(triangleFaces.length);
          if (freeform !== null) {
            freeformCheckpoint?.();
            const uv: [readonly [number, number], readonly [number, number], readonly [number, number]] = [[0, 0], [0, 0], [0, 0]];
            let offset = 0;
            const locals = [a, b, c], globals = [ga, gb, gc];
            for (let corner = 0; corner < 3; corner += 1) {
              const parameter = nativeTriangles.UVNode(locals[corner]);
              try { uv[corner] = [parameter.X(), parameter.Y()]; } finally { parameter.delete(); }
              const actual = freeform.point(uv[corner]), node = globals[corner];
              offset = Math.max(offset, Math.hypot(nodes.x(node) - actual[0], nodes.y(node) - actual[1], nodes.z(node) - actual[2]));
            }
            if (freeform.grid === undefined) {
              distanceRows.push({ triangleIndex: triangleFaces.length, maxNodeOffsetMm: offset,
                maxChordDeviationMm: freeformTriangleDistance(freeform.derivatives, uv, offset) });
            } else {
              const point = (node: number): readonly [number, number, number] => [nodes.x(node), nodes.y(node), nodes.z(node)];
              const bound = partitionedFreeformTriangleDistance(freeform.grid, uv, [point(ga), point(gb), point(gc)],
                () => { freeformCheckpoint?.(); });
              distanceRows.push({ triangleIndex: triangleFaces.length, ...bound });
            }
          }
          if (forward) triangles.push(ga, gb, gc); else triangles.push(gb, ga, gc);
          triangleFaces.push(faceIndex);
          faceTriangles += 1;
          if (triangleFaces.length > options.maximumTriangles) {
            refuse('limit', '解析用の境界の三角形が上限を超えました。細かさを粗くしてください。');
          }
        }
        summaries.push({ index: faceIndex, triangleCount: faceTriangles, reversed: !forward, seamEdges,
          degeneratedEdges, collapsedPoleTriangles: collapsed });
        if (freeform !== null) freeformFaces.push({ faceIndex, surfaceKind: freeform.kind, triangles: distanceRows });
        if (analytic !== undefined) plcFaces.push({ faceIndex, localToGlobal: Array.from(localToGlobal.subarray(1)), plcTriangles });
      } finally {
        perFace.release();
      }
    }

    const coordinates = nodes.coordinates();
    const triangleArray = Uint32Array.from(triangles);
    const faceArray = Uint32Array.from(triangleFaces);
    const { metrics, shells } = auditBoundaryWithShells(coordinates, triangleArray, options.boundary,
      faceArray.map(face => (voidFaces.has(face) ? 1 : 0)));
    const edgeChains: AnalysisEdgeChain[] = [...edgeRecords].sort(([left], [right]) => left - right)
      .map(([address, record]) => ({ index: address, degenerated: record.degenerated, uses: record.uses,
        nodes: record.nodes }));
    const mesh: AnalysisSurfaceMesh = {
      units: 'mm', boundary: options.boundary, coordinates, nodeKinds: nodes.nodeKinds(),
      triangles: triangleArray, triangleFaces: faceArray,
      nodeCount: nodes.count, triangleCount: triangleFaces.length, faces: summaries, edges: edgeChains,
      ...(options.boundary === 'closed' ? { shells } : {}),
      metrics: { ...metrics, maxBoundNodeOffsetMm: maxBoundNodeOffset },
      mesher: { done, status }, deflection: { linear: options.linearDeflection, angular: options.angularDeflection },
      ...(options.materialValidation === undefined ? {} : { freeform: { schema: 'pointercad-freeform-distance/1' as const, faces: freeformFaces } }),
    };
    // The actual meshed copier and its history remain owned here. Re-meshing a second copy would not establish
    // the correspondence of the buffers above. No optional caller-supplied face/triangle subset is accepted.
    if (analytic !== undefined) {
      analytic.checkpoint();
      analytic.accept(bindAnalyticNativeChain(oc, shape, copier, mesh, 1, owned, analytic.checkpoint, plcFaces));
    }
    if (acceptNativeVolume !== undefined) {
      materialCheckpoint?.();
      // This is the material-validated meshed copy; never use an unchecked caller volume premise.
      acceptNativeVolume(measureVolume(oc, copy));
      materialCheckpoint?.();
    }
    result = mesh;
  } catch (error) {
    primary = asError(error, NATIVE_CONSTRUCTION_FAILED);
  }
  let cleanup: Error | undefined;
  try { owned.release(); } catch (error) {
    cleanup = asError(error, 'analysis-mesh: native cleanup failed');
  }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], primary.message);
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
  if (result === undefined) throw new Error('analysis-mesh: missing native result');
  return result;
}

/**
 * Check the assembled boundary and measure it. Pure JavaScript over the output arrays, so it is also the
 * independent check used by the tests on hand-made inconsistent triangulations.
 *
 * `voidTriangles` (optional, one flag per triangle) marks triangles of cavity shells (non-outer shells of a solid).
 * In closed mode every triangle-connected component must be uniformly outer or void, and its own signed volume
 * (about its own first node) must be positive for an outer shell and negative for a cavity. A positive total can
 * therefore no longer hide an inward component.
 */
export function auditBoundary(coordinates: Float64Array, triangles: Uint32Array, boundary: AnalysisBoundaryMode,
  voidTriangles?: ArrayLike<number>): AnalysisMeshMetrics {
  return auditBoundaryWithShells(coordinates, triangles, boundary, voidTriangles).metrics;
}

/** Reuse the same edge components and classification as the audit; no second geometric traversal. */
function auditBoundaryWithShells(coordinates: Float64Array, triangles: Uint32Array, boundary: AnalysisBoundaryMode,
  voidTriangles?: ArrayLike<number>): { readonly metrics: AnalysisMeshMetrics;
    readonly shells: NonNullable<AnalysisSurfaceMesh['shells']> } {
  const nodeCount = coordinates.length / 3;
  const triangleCount = triangles.length / 3;
  if (!Number.isInteger(nodeCount) || !Number.isInteger(triangleCount)) {
    refuse('node-conflict', '解析用の境界の配列の長さが 3 の倍数ではありません。');
  }
  if (triangleCount === 0) refuse('empty', '解析用の境界に三角形がありません。');
  if (nodeCount > MAXIMUM_AUDIT_NODES) refuse('limit', '解析用の境界の節点が多過ぎます。細かさを粗くしてください。');
  if (voidTriangles !== undefined && voidTriangles.length !== triangleCount) {
    refuse('node-conflict', '解析用の境界の空洞の印の数が三角形の数と一致しません。');
  }
  for (const value of coordinates) {
    if (!Number.isFinite(value)) refuse('nonfinite', '解析用の境界に有限でない座標があります。');
  }
  const directed = new Map<number, number>();
  const seen = new Set<string>();
  let totalArea = 0;
  let minArea = Infinity, maxArea = 0, minAngle = 180, maxAngle = 0;
  // A shared vertex alone does not connect two shells. Components are triangle
  // components joined across a complete shared edge, including periodic seams.
  const parent = new Int32Array(triangleCount).map((_, index) => index);
  const triangleForEdge = new Map<number, number>();
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) { const next = parent[index]; parent[index] = root; index = next; }
    return root;
  };
  for (let t = 0; t < triangleCount; t += 1) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    if (a >= nodeCount || b >= nodeCount || c >= nodeCount) refuse('node-conflict', '解析用の境界の三角形が存在しない節点を指しています。');
    if (a === b || b === c || a === c) refuse('collapsed-triangle', '解析用の境界に 1 点へ潰れた三角形があります。');
    const key = [a, b, c].sort((left, right) => left - right).join(',');
    if (seen.has(key)) refuse('duplicate-triangle', '解析用の境界に同じ三角形が 2 枚あります。形を確かめてください。');
    seen.add(key);
    // Edge vectors straight from the stored coordinates: a far placement does not cancel their digits.
    const ux = coordinates[3 * b] - coordinates[3 * a], uy = coordinates[3 * b + 1] - coordinates[3 * a + 1];
    const uz = coordinates[3 * b + 2] - coordinates[3 * a + 2];
    const vx = coordinates[3 * c] - coordinates[3 * a], vy = coordinates[3 * c + 1] - coordinates[3 * a + 1];
    const vz = coordinates[3 * c + 2] - coordinates[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    if (!Number.isFinite(area)) refuse('nonfinite', '解析用の境界の三角形の面積が有限ではありません。');
    if (area === 0) refuse('zero-area', '解析用の境界に面積 0 の三角形があります。細かさを変えるか、形を確かめてください。');
    totalArea += area;
    minArea = Math.min(minArea, area);
    maxArea = Math.max(maxArea, area);
    const lab = Math.hypot(ux, uy, uz), lac = Math.hypot(vx, vy, vz), lbc = Math.hypot(vx - ux, vy - uy, vz - uz);
    for (const [opposite, side1, side2] of [[lbc, lab, lac], [lac, lab, lbc], [lab, lac, lbc]]) {
      const cosine = Math.min(1, Math.max(-1, (side1 * side1 + side2 * side2 - opposite * opposite) / (2 * side1 * side2)));
      const angle = Math.acos(cosine) * 180 / Math.PI;
      minAngle = Math.min(minAngle, angle);
      maxAngle = Math.max(maxAngle, angle);
    }
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const halfEdge = from * nodeCount + to;
      directed.set(halfEdge, (directed.get(halfEdge) ?? 0) + 1);
      const edge = Math.min(from, to) * nodeCount + Math.max(from, to);
      const adjacent = triangleForEdge.get(edge);
      if (adjacent === undefined) triangleForEdge.set(edge, t);
      else parent[find(t)] = find(adjacent);
    }
  }
  // Classify after counting: three or more triangles on one edge always repeat a half-edge too, so the
  // non-manifold check must come first to report the actual cause.
  const undirected = new Map<number, number>();
  for (const [halfEdge, uses] of directed) {
    const from = Math.floor(halfEdge / nodeCount), to = halfEdge % nodeCount;
    const key = Math.min(from, to) * nodeCount + Math.max(from, to);
    undirected.set(key, (undirected.get(key) ?? 0) + uses);
  }
  let freeEdges = 0;
  for (const uses of undirected.values()) {
    if (uses > 2) refuse('nonmanifold', '1 本の辺を 3 枚以上の三角形が共有しています(多様体ではありません)。');
    if (uses === 1) freeEdges += 1;
  }
  for (const uses of directed.values()) {
    if (uses > 1) {
      refuse('orientation-conflict', '隣り合う三角形の向きが食い違っています(同じ向きで辺を共有しています)。形を確かめてください。');
    }
  }
  // Components in order of first appearance; each one's signed volume about its own first node.
  const componentOf = new Map<number, number>();
  const references: number[] = [];
  const volumes: number[] = [];
  const voidFlags: number[] = [];
  const shellTriangles: number[][] = [];
  let mixedComponent = false;
  for (let t = 0; t < triangleCount; t += 1) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    const root = find(t);
    let component = componentOf.get(root);
    const flag = voidTriangles === undefined ? 0 : (voidTriangles[t] === 0 ? 0 : 1);
    if (component === undefined) {
      component = references.length;
      componentOf.set(root, component);
      references.push(a);
      volumes.push(0);
      voidFlags.push(flag);
      if (boundary === 'closed') shellTriangles.push([]);
    } else if (voidFlags[component] !== flag) {
      mixedComponent = true;
    }
    if (boundary === 'closed') shellTriangles[component].push(t);
    const r = references[component];
    const rx = coordinates[3 * r], ry = coordinates[3 * r + 1], rz = coordinates[3 * r + 2];
    const ax = coordinates[3 * a] - rx, ay = coordinates[3 * a + 1] - ry, az = coordinates[3 * a + 2] - rz;
    const bx = coordinates[3 * b] - rx, by = coordinates[3 * b + 1] - ry, bz = coordinates[3 * b + 2] - rz;
    const cx = coordinates[3 * c] - rx, cy = coordinates[3 * c + 1] - ry, cz = coordinates[3 * c + 2] - rz;
    volumes[component] += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  if (boundary === 'closed') {
    if (freeEdges > 0) {
      refuse('open-boundary', `閉じた境界を求めましたが、開いた辺が ${String(freeEdges)} 本あります。形が閉じた立体か確かめてください。`);
    }
    if (mixedComponent) {
      refuse('orientation-conflict', '1 つの閉じた殻に外側の面と空洞の面が混在しています。形を確かめてください。');
    }
    volumes.forEach((volume, component) => {
      const correct = voidFlags[component] === 1 ? volume < 0 : volume > 0;
      if (!correct) {
        refuse('inward-orientation', `閉じた殻 ${String(component + 1)} の向きが${voidFlags[component] === 1 ? '空洞として外向き' : '内向き'}です。形の向きを確かめてください。`);
      }
    });
  }
  const metrics = { totalAreaMm2: totalArea, signedVolumeMm3: volumes.reduce((sum, volume) => sum + volume, 0),
    componentVolumesMm3: volumes, minTriangleAreaMm2: minArea, maxTriangleAreaMm2: maxArea, minAngleDeg: minAngle,
    maxAngleDeg: maxAngle, maxBoundNodeOffsetMm: 0, freeEdges, components: volumes.length };
  const shells: NonNullable<AnalysisSurfaceMesh['shells']> = shellTriangles.map((members, component) => ({
    role: voidFlags[component] === 1 ? 'cavity' : 'outer', triangles: members,
  }));
  return { metrics, shells };
}
