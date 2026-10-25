/**
 * Analytic surface bounds used by the CAD approximation certificate.
 *
 * These bounds cover an entire UV triangle, including a pole on its boundary. They do not certify that
 * those triangles cover the trimmed CAD face. A caller must separately prove the complete trim chain,
 * native-tolerance tube and orientation before emitting AnalysisSurfaceCertificate.
 */
import type {
  BRepBuilderAPI_Copy,
  gp_Ax2,
  gp_Ax3,
  gp_Trsf,
  Handle_Poly_Triangulation,
  OpenCascadeInstance,
  TopLoc_Location,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopTools_IndexedMapOfShape,
} from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations, type Allocations } from './allocations.js';
import { analyticChartAdmission } from './analyticChartAdmissionR2.js';
import type { AnalysisSurfaceMesh } from './analysisSurfaceMesh.js';

export type AnalyticSurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus';

export interface AnalysisSurfaceCertificate {
  readonly schema: 'pointercad-analytic-cad-certificate/1';
  readonly requestedDistanceMm: number;
  readonly maximumDistanceMm: number;
  readonly nativeToleranceMm: number;
  readonly plcSignedVolumeMm3: number;
  readonly cadSignedVolumeIntervalMm3: readonly [number, number];
  readonly faces: readonly {
    readonly faceIndex: number;
    readonly kind: AnalyticSurfaceKind;
    readonly triangles: readonly number[];
    readonly maximumDistanceMm: number;
    readonly sweptVolumeBoundMm3: number;
    readonly nativeToleranceMm: number;
  }[];
  readonly refinementPasses: number;
}

export type AnalyticSurfaceParameters =
  | { readonly kind: 'plane'; readonly scale: number }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly scale: number }
  | { readonly kind: 'cone'; readonly referenceRadius: number; readonly scale: number }
  | { readonly kind: 'sphere'; readonly radius: number; readonly scale: number }
  | { readonly kind: 'torus'; readonly majorRadius: number; readonly minorRadius: number; readonly scale: number };

export interface AnalyticDerivativeBounds {
  readonly u: number;
  readonly v: number;
  readonly uu: number;
  readonly uv: number;
  readonly vv: number;
}

export type UvPoint = readonly [number, number];
export type UvTriangle = readonly [UvPoint, UvPoint, UvPoint];
export type CertificatePoint3 = readonly [number, number, number];

export type AnalyticInterval = readonly [number, number];
export type AnalyticIntervalPoint3 = readonly [AnalyticInterval, AnalyticInterval, AnalyticInterval];
export interface AnalyticFrame {
  readonly origin: CertificatePoint3;
  readonly x: CertificatePoint3;
  readonly y: CertificatePoint3;
  readonly z: CertificatePoint3;
}
export type AnalyticAffine = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];
export type AnalyticCurveGeometry = (
  | { readonly kind: 'line'; readonly origin: CertificatePoint3; readonly direction: CertificatePoint3 }
  | { readonly kind: 'conic'; readonly origin: CertificatePoint3; readonly x: CertificatePoint3;
    readonly y: CertificatePoint3; readonly major: number; readonly minor: number }
) & { readonly transform?: AnalyticAffine };
export interface AnalyticSurfaceGeometry {
  /** LOCAL primitive parameters and frame; location acts on the resulting interval exactly once. */
  readonly surface: AnalyticSurfaceParameters;
  readonly frame: AnalyticFrame;
  readonly coneSemiAngle: number | null;
  readonly transform?: AnalyticAffine;
}

export interface AnalyticFaceChart {
  readonly faceIndex: number;
  readonly surface: AnalyticSurfaceParameters;
  readonly geometry: AnalyticSurfaceGeometry;
  readonly nativeFaceToleranceMm: number;
  /** Native UV lifts, one per LOCAL node. Never merge at a welded seam or pole. */
  readonly uvNodes: readonly UvPoint[];
  /** All native parameter triangles, including patches whose 3D pole edge later collapses. Zero-based LOCAL indices. */
  readonly localTriangles: readonly (readonly [number, number, number])[];
  readonly uPeriod: number | null;
  readonly vPeriod: number | null;
}

export interface AnalyticTrimChain {
  readonly edgeIndex: number;
  readonly kind: 'line' | 'circle' | 'ellipse';
  readonly parameters: readonly number[];
  /** Observed endpoints retained for correspondence checks; not a certified evaluator. */
  readonly uvNodes: readonly UvPoint[];
  readonly secondDerivativeBoundUv: number;
  readonly nativeEdgeToleranceMm: number;
  readonly nativeVertexToleranceMm: number;
}

export interface AnalyticWireChain {
  /** Complete wire in native traversal order, including the repeated closing LOCAL node. */
  readonly localNodes: readonly number[];
  readonly segments: readonly {
    readonly localNodes: readonly number[];
    readonly forward: boolean;
    readonly trim: AnalyticTrimChain;
    readonly pair: AnalyticNativeCurvePair;
    readonly identity?: AnalyticBoundaryOccurrence;
  }[];
}

export interface AnalyticBoundaryOccurrence {
  readonly faceIndex: number;
  readonly wireIndex: number;
  readonly segmentIndex: number;
  readonly edgeIndex: number;
  readonly firstVertex: number;
  readonly lastVertex: number;
  readonly first: number;
  readonly last: number;
  /** Relative to the FORWARD face's UV wire traversal. */
  readonly forward: boolean;
  /** Original accumulated material-boundary face orientation. */
  readonly faceForward: boolean;
}

export interface AnalyticNativeIdentityMaps {
  readonly faces: TopTools_IndexedMapOfShape;
  readonly edges: TopTools_IndexedMapOfShape;
  readonly vertices: TopTools_IndexedMapOfShape;
}

/** Actual IsSame-native identities in the same accumulated MapShapes order as analysisSurfaceMesh. */
export function readAnalyticIdentityMaps(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  owned: Allocations, checkpoint: () => void): AnalyticNativeIdentityMaps {
  const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, all, true, true);
  const faces = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  const edges = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  const vertices = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  if (all.Size() > 16384) throw new Error('analytic-certificate: native identity budget');
  for (let index = 1; index <= all.Size(); index += 1) {
    checkpoint();
    const member = owned.keep(all.FindKey(index));
    const kind = member.ShapeType();
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE) faces.Add(member);
    else if (kind === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges.Add(member);
    else if (kind === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) vertices.Add(member);
  }
  if (faces.Size() < 1 || faces.Size() > 2048 || edges.Size() < 1 || edges.Size() > 6144
    || vertices.Size() < 1 || vertices.Size() > 1024) throw new Error('analytic-certificate: native identity count');
  return { faces, edges, vertices };
}

function readBoundaryOccurrence(oc: OpenCascadeInstance, maps: AnalyticNativeIdentityMaps,
  face: TopoDS_Face, edge: TopoDS_Edge, wireIndex: number, segmentIndex: number,
  pair: AnalyticNativeCurvePair, forward: boolean, owned: Allocations): AnalyticBoundaryOccurrence {
  const faceIndex = maps.faces.FindIndex(face) - 1, edgeIndex = maps.edges.FindIndex(edge) - 1;
  const first = owned.keep(oc.TopExp.FirstVertex(edge, false)), last = owned.keep(oc.TopExp.LastVertex(edge, false));
  const firstVertex = first.IsNull() ? -1 : maps.vertices.FindIndex(first) - 1;
  const lastVertex = last.IsNull() ? -1 : maps.vertices.FindIndex(last) - 1;
  const orientation = face.Orientation_1();
  if (faceIndex < 0 || edgeIndex < 0 || firstVertex < 0 || lastVertex < 0
    || (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED)) {
    throw new Error('analytic-certificate: unknown native occurrence identity or orientation');
  }
  if (!owned.keep(maps.faces.FindKey(faceIndex + 1)).IsEqual(face)) {
    throw new Error('analytic-certificate: changed original material face orientation');
  }
  return { faceIndex, edgeIndex, wireIndex, segmentIndex, firstVertex, lastVertex, first: pair.first, last: pair.last,
    forward, faceForward: orientation === oc.TopAbs_Orientation.TopAbs_FORWARD };
}

export interface AnalyticNativeClosureLedger {
  readonly topologicallyClosed: true;
  /** Native-tolerance gaps and endpoint patch geometry are not proved by ID cancellation. */
  readonly geometricallyClosed: false;
  readonly edgePairs: readonly (readonly [AnalyticBoundaryOccurrence, AnalyticBoundaryOccurrence])[];
}

export interface AnalyticNativeAnchor {
  readonly vertexIndex: number;
  readonly plcNode: number;
  readonly point: CertificatePoint3;
}

/**
 * Bind ORIGINAL native topology to the PLC's original-edge addresses. The mesher obtains these vertex
 * coordinates from BRep_Tool.Pnt too; exact agreement is required, not proximity within native tolerance.
 * No copied-map ordinal is used as an original address, and all vertices/edge records must participate.
 */
export function readAnalyticPlcAnchors(oc: OpenCascadeInstance, identities: AnalyticNativeIdentityMaps,
  mesh: Pick<AnalysisSurfaceMesh, 'coordinates' | 'nodeKinds' | 'nodeCount' | 'edges'>,
  owned: Allocations, checkpoint: () => void): readonly AnalyticNativeAnchor[] {
  if (!Number.isSafeInteger(mesh.nodeCount) || mesh.nodeCount < 1 || mesh.nodeCount > 1024
    || mesh.coordinates.length !== mesh.nodeCount * 3 || mesh.nodeKinds.length !== mesh.nodeCount
    || mesh.edges.length !== identities.edges.Size()) throw new Error('analytic-certificate: incomplete PLC anchor inventory');
  const records = new Map<number, (typeof mesh.edges)[number]>();
  for (let index = 0; index < mesh.edges.length; index += 1) {
    checkpoint();
    if (!Object.hasOwn(mesh.edges, index)) throw new Error('analytic-certificate: sparse PLC edge inventory');
    const record = mesh.edges[index];
    if (!Number.isSafeInteger(record.index) || record.index < 0 || record.index >= identities.edges.Size()
      || records.has(record.index) || record.nodes.length < 2 || record.nodes.length > 1025 || record.uses !== 2) {
      throw new Error('analytic-certificate: duplicate or invalid PLC edge inventory');
    }
    records.set(record.index, record);
  }
  const anchors = new Map<number, AnalyticNativeAnchor>(), nodeOwners = new Map<number, number>();
  const bind = (edge: TopoDS_Edge, first: boolean, node: number): void => {
    const vertex = owned.keep(first ? oc.TopExp.FirstVertex(edge, false) : oc.TopExp.LastVertex(edge, false));
    const vertexIndex = vertex.IsNull() ? -1 : identities.vertices.FindIndex(vertex) - 1;
    // ANALYSIS_NODE_VERTEX is exactly 0 in the existing public analysisSurfaceMesh contract.
    if (vertexIndex < 0 || !Number.isSafeInteger(node) || node < 0 || node >= mesh.nodeCount || mesh.nodeKinds[node] !== 0) {
      throw new Error('analytic-certificate: unknown native vertex or PLC vertex node');
    }
    const point = nativePoint3(owned.keep(oc.BRep_Tool.Pnt(vertex)));
    if (point.some((coordinate, axis) => coordinate !== mesh.coordinates[3 * node + axis])) {
      throw new Error('analytic-certificate: PLC anchor differs from actual native vertex');
    }
    const previous = anchors.get(vertexIndex), owner = nodeOwners.get(node);
    if ((previous !== undefined && previous.plcNode !== node) || (owner !== undefined && owner !== vertexIndex)) {
      throw new Error('analytic-certificate: nonbijective native vertex to PLC anchor');
    }
    anchors.set(vertexIndex, { vertexIndex, plcNode: node, point });
    nodeOwners.set(node, vertexIndex);
  };
  for (let edgeIndex = 0; edgeIndex < identities.edges.Size(); edgeIndex += 1) {
    checkpoint();
    const record = records.get(edgeIndex);
    if (record === undefined) throw new Error('analytic-certificate: missing original PLC edge');
    const edge = owned.keep(oc.TopoDS.Edge_1(owned.keep(identities.edges.FindKey(edgeIndex + 1))));
    if (record.degenerated !== oc.BRep_Tool.Degenerated(edge)) throw new Error('analytic-certificate: changed native PLC edge kind');
    bind(edge, true, record.nodes[0]);
    bind(edge, false, record.nodes[record.nodes.length - 1]);
  }
  let vertexNodes = 0;
  for (const kind of mesh.nodeKinds) if (kind === 0) vertexNodes += 1;
  if (anchors.size !== identities.vertices.Size() || vertexNodes !== anchors.size) {
    throw new Error('analytic-certificate: incomplete native vertex to PLC anchor coverage');
  }
  checkpoint();
  return [...anchors.values()].sort((a, b) => a.vertexIndex - b.vertexIndex);
}

function copiedAnalyticIdentities(oc: OpenCascadeInstance, originals: AnalyticNativeIdentityMaps,
  copier: BRepBuilderAPI_Copy, owned: Allocations, checkpoint: () => void): AnalyticNativeIdentityMaps {
  const copies = readAnalyticIdentityMaps(oc, owned.keep(copier.Shape()), owned, checkpoint);
  const reorder = (source: TopTools_IndexedMapOfShape, target: TopTools_IndexedMapOfShape): TopTools_IndexedMapOfShape => {
    if (source.Size() !== target.Size()) throw new Error('analytic-certificate: changed copy identity count');
    const ordered = owned.keep(new oc.TopTools_IndexedMapOfShape_1()), seen = new Set<number>();
    for (let index = 1; index <= source.Size(); index += 1) {
      checkpoint();
      const original = owned.keep(source.FindKey(index)), modified = owned.keep(copier.Modified(original));
      const image = owned.keep(copier.ModifiedShape(original));
      if (modified.Size() !== 1 || image.IsNull() || !owned.keep(modified.First_1()).IsSame(image)) {
        throw new Error('analytic-certificate: ambiguous native copy history');
      }
      const address = target.FindIndex(image);
      if (address <= 0 || seen.has(address)) throw new Error('analytic-certificate: nonbijective native copy history');
      const keyed = owned.keep(target.FindKey(address));
      if (keyed.Orientation_1() !== original.Orientation_1()) throw new Error('analytic-certificate: changed copied material orientation');
      seen.add(address);
      if (ordered.Add(keyed) !== index) throw new Error('analytic-certificate: repeated original copy image');
    }
    return ordered;
  };
  return { faces: reorder(originals.faces, copies.faces), edges: reorder(originals.edges, copies.edges),
    vertices: reorder(originals.vertices, copies.vertices) };
}

export interface AnalyticNativeChainBinding {
  readonly geometricallyClosed: false;
  readonly anchors: readonly AnalyticNativeAnchor[];
  readonly faces: readonly { readonly chart: AnalyticFaceChart; readonly wires: readonly AnalyticWireChain[] }[];
  readonly nativeLedger: AnalyticNativeClosureLedger;
  readonly connectorLedger: ReturnType<typeof auditAnalyticConnectorCancellation>;
  readonly ribbonCount: number;
  readonly bridgeCount: number;
  readonly endpointPatchCount: number;
  readonly maximumRibbonDistanceMm: number;
  readonly maximumNativeGapMm: number;
  readonly maximumEndpointAnchorRadiusMm: number;
  readonly fluxIntervalMm3: AnalyticInterval;
  readonly cellsUsed: number;
  /** Present only when every actual producer UV cell was bound before its meshed copy was released. */
  readonly interior?: AnalyticInteriorBinding;
}

/** Producer-local correspondence, never accepted as a geometric certificate. LOCAL indices are zero based. */
export interface AnalyticPlcFaceBinding {
  readonly faceIndex: number;
  readonly localToGlobal: readonly number[];
  /** One entry per native UV triangle, including every collapsed pole patch (null). */
  readonly plcTriangles: readonly (number | null)[];
}

export interface AnalyticInteriorBinding {
  readonly geometricallyClosed: false;
  readonly cells: readonly {
    readonly faceIndex: number;
    readonly localTriangle: number;
    readonly plcTriangle: number | null;
    readonly materialForward: boolean;
    readonly uv: UvTriangle;
    readonly nodes: readonly [number, number, number];
    readonly maximumDistanceMm: number;
    readonly sweptVolumeBoundMm3: number;
  }[];
  readonly maximumDistanceMm: number;
  readonly sweptVolumeBoundMm3: number;
}

/** Complete cell/triangle bijection and continuous local bounds; global trim/degree remains unproved. */
export function bindAnalyticInteriorCells(
  faces: readonly { readonly chart: AnalyticFaceChart; readonly materialForward: boolean;
    readonly poleNodes: ReadonlySet<number> }[],
  mesh: Pick<AnalysisSurfaceMesh, 'nodeCount' | 'coordinates' | 'nodeKinds' | 'triangleCount' | 'triangles' | 'triangleFaces'>,
  bindings: readonly AnalyticPlcFaceBinding[], budget: AnalyticCellBudget, checkpoint: () => void,
): AnalyticInteriorBinding {
  if (bindings.length !== faces.length || faces.length < 1 || faces.length > 2048
    || !Number.isSafeInteger(mesh.nodeCount) || mesh.nodeCount < 1 || mesh.nodeCount > 1024
    || !Number.isSafeInteger(mesh.triangleCount) || mesh.triangleCount < 0 || mesh.triangleCount > 2048
    || mesh.coordinates.length !== 3 * mesh.nodeCount
    || mesh.nodeKinds.length !== mesh.nodeCount || mesh.triangles.length !== 3 * mesh.triangleCount
    || mesh.triangleFaces.length !== mesh.triangleCount) throw new Error('analytic-certificate: incomplete interior inventory');
  const seenFaces = new Set<number>(), seenTriangles = new Set<number>();
  const cells: AnalyticInteriorBinding['cells'][number][] = [];
  let maximumDistanceMm = 0, sweptVolumeBoundMm3 = 0;
  for (let slot = 0; slot < faces.length; slot += 1) {
    checkpoint();
    if (!Object.hasOwn(faces, slot) || !Object.hasOwn(bindings, slot)) throw new Error('analytic-certificate: sparse interior inventory');
    const { chart, materialForward, poleNodes } = faces[slot], binding = bindings[slot];
    if (!Number.isSafeInteger(chart.faceIndex) || chart.faceIndex < 0 || chart.faceIndex >= 2048
      || typeof materialForward !== 'boolean' || chart.uvNodes.length < 3 || chart.uvNodes.length > 1024
      || chart.localTriangles.length < 1 || chart.localTriangles.length > 2048
      || chart.faceIndex !== binding.faceIndex || seenFaces.has(chart.faceIndex)
      || binding.localToGlobal.length !== chart.uvNodes.length || binding.plcTriangles.length !== chart.localTriangles.length) {
      throw new Error('analytic-certificate: changed interior face or cell inventory');
    }
    seenFaces.add(chart.faceIndex);
    for (let local = 0; local < chart.uvNodes.length; local += 1) {
      const node = binding.localToGlobal[local];
      if (!Object.hasOwn(binding.localToGlobal, local) || !Number.isSafeInteger(node) || node < 0 || node >= mesh.nodeCount) {
        throw new Error('analytic-certificate: unknown interior PLC node');
      }
    }
    // Bound the actual floating frame and affine coefficients, not idealized unit axes or location scale alone.
    const geometry = chart.geometry;
    let locationFactor = 1;
    if (geometry.transform !== undefined) {
      const matrix = geometry.transform;
      locationFactor = Math.max(...[0, 1, 2].map(column => addUpper(addUpper(
        Math.abs(matrix[0][column]), Math.abs(matrix[1][column])), Math.abs(matrix[2][column]))));
    }
    const scale = multiplyUpper(locationFactor, addUpper(addUpper(l1Upper(geometry.frame.x),
      l1Upper(geometry.frame.y)), l1Upper(geometry.frame.z)));
    const parameters = { ...geometry.surface, scale: multiplyUpper(geometry.surface.scale, scale) };
    for (let localTriangle = 0; localTriangle < chart.localTriangles.length; localTriangle += 1) {
      budget.consume();
      if (cells.length >= 2048 || !Object.hasOwn(chart.localTriangles, localTriangle)
        || !Object.hasOwn(binding.plcTriangles, localTriangle)) throw new Error('analytic-certificate: missing interior cell');
      const local = chart.localTriangles[localTriangle];
      for (const index of local) if (!Number.isSafeInteger(index) || index < 0 || index >= chart.uvNodes.length) {
        throw new Error('analytic-certificate: invalid interior UV index');
      }
      const nodes: [number, number, number] = [binding.localToGlobal[local[0]], binding.localToGlobal[local[1]], binding.localToGlobal[local[2]]];
      const uv: UvTriangle = [chart.uvNodes[local[0]], chart.uvNodes[local[1]], chart.uvNodes[local[2]]];
      const triangle = binding.plcTriangles[localTriangle];
      const repeated = nodes[0] === nodes[1] || nodes[0] === nodes[2] ? nodes[0] : nodes[1] === nodes[2] ? nodes[1] : null;
      if (repeated !== null) {
        if (triangle !== null || !poleNodes.has(repeated) || mesh.nodeKinds[repeated] !== 0) {
          throw new Error('analytic-certificate: unaccounted collapsed interior cell');
        }
      } else {
        if (triangle === null || !Number.isSafeInteger(triangle) || triangle < 0 || triangle >= mesh.triangleCount
          || seenTriangles.has(triangle) || mesh.triangleFaces[triangle] !== chart.faceIndex) {
          throw new Error('analytic-certificate: omitted repeated or wrong-face PLC triangle');
        }
        const order = materialForward ? nodes : [nodes[1], nodes[0], nodes[2]];
        if (order.some((node, corner) => node !== mesh.triangles[3 * triangle + corner])) {
          throw new Error('analytic-certificate: changed PLC triangle orientation or correspondence');
        }
        seenTriangles.add(triangle);
      }
      const plc = nodes.map(node => [mesh.coordinates[3 * node], mesh.coordinates[3 * node + 1],
        mesh.coordinates[3 * node + 2]] as const);
      let endpoint = 0;
      for (let corner = 0; corner < 3; corner += 1) {
        const point = analyticSurfaceInterval(geometry, [uv[corner][0], uv[corner][0]], [uv[corner][1], uv[corner][1]]);
        let distance = 0;
        for (let axis = 0; axis < 3; axis += 1) {
          if (!Number.isFinite(plc[corner][axis])) throw new Error('analytic-certificate: nonfinite interior position');
          const delta = intervalAdd(point[axis], [-plc[corner][axis], -plc[corner][axis]]);
          distance = addUpper(distance, Math.max(Math.abs(delta[0]), Math.abs(delta[1])));
        }
        endpoint = Math.max(endpoint, distance);
      }
      const distance = analyticTriangleDistanceBound(parameters, uv, endpoint, 0);
      const swept = analyticTriangleSweptVolumeBound(parameters, uv, [plc[0], plc[1], plc[2]], endpoint);
      cells.push({ faceIndex: chart.faceIndex, localTriangle, plcTriangle: triangle, materialForward, uv, nodes,
        maximumDistanceMm: distance, sweptVolumeBoundMm3: swept });
      maximumDistanceMm = Math.max(maximumDistanceMm, distance);
      sweptVolumeBoundMm3 = addUpper(sweptVolumeBoundMm3, swept);
    }
  }
  if (seenTriangles.size !== mesh.triangleCount) throw new Error('analytic-certificate: incomplete PLC triangle coverage');
  return { geometricallyClosed: false, cells, maximumDistanceMm, sweptVolumeBoundMm3 };
}

/**
 * One synchronous native inventory drives ALL boundary patches. Call with the producer's actual meshed copy
 * and original-address PLC, before releasing its allocations. No caller-supplied subset of chart/edge records
 * can enter this path. This binds the boundary chain only; it deliberately emits no geometric certificate.
 */
export function bindAnalyticNativeChain(oc: OpenCascadeInstance, original: TopoDS_Shape, copier: BRepBuilderAPI_Copy,
  mesh: AnalysisSurfaceMesh, subdivisions: number, owned: Allocations, checkpoint: () => void,
  plcFaces?: readonly AnalyticPlcFaceBinding[]): AnalyticNativeChainBinding {
  if (!copier.IsDone() || mesh.boundary !== 'closed' || !Number.isSafeInteger(subdivisions)
    || subdivisions < 1 || subdivisions > 32) throw new Error('analytic-certificate: invalid native binding input');
  const originals = readAnalyticIdentityMaps(oc, original, owned, checkpoint);
  const identities = copiedAnalyticIdentities(oc, originals, copier, owned, checkpoint);
  const anchors = readAnalyticPlcAnchors(oc, originals, mesh, owned, checkpoint);
  if (mesh.faces.length !== originals.faces.Size() || !Number.isSafeInteger(mesh.triangleCount)
    || mesh.triangleCount < 1 || mesh.triangleCount > 2048 || mesh.triangles.length !== mesh.triangleCount * 3
    || mesh.triangleFaces.length !== mesh.triangleCount) throw new Error('analytic-certificate: incomplete PLC face inventory');
  const triangleCounts = new Map<number, number>();
  for (const face of mesh.triangleFaces) {
    if (!Number.isSafeInteger(face) || face < 0 || face >= originals.faces.Size()) throw new Error('analytic-certificate: unknown PLC triangle face');
    triangleCounts.set(face, (triangleCounts.get(face) ?? 0) + 1);
  }
  const summaries = new Map<number, (typeof mesh.faces)[number]>();
  for (let index = 0; index < mesh.faces.length; index += 1) {
    if (!Object.hasOwn(mesh.faces, index)) throw new Error('analytic-certificate: sparse PLC face inventory');
    const face = mesh.faces[index];
    if (!Number.isSafeInteger(face.index) || face.index < 0 || face.index >= originals.faces.Size() || summaries.has(face.index)
      || face.triangleCount !== triangleCounts.get(face.index) || !Number.isSafeInteger(face.collapsedPoleTriangles)
      || face.collapsedPoleTriangles < 0 || typeof face.reversed !== 'boolean') {
      throw new Error('analytic-certificate: duplicate PLC face inventory');
    }
    summaries.set(face.index, face);
  }
  const records = new Map(mesh.edges.map(edge => [edge.index, edge]));
  const faces: { chart: AnalyticFaceChart; wires: readonly AnalyticWireChain[] }[] = [];
  const edgeParameters = new Map<number, readonly number[]>();
  const interiorFaces: { chart: AnalyticFaceChart; materialForward: boolean; poleNodes: Set<number> }[] = [];
  const interiorNodes = new Set<number>();
  const coveredPlcNodes = new Set<number>();
  if (plcFaces !== undefined && plcFaces.length !== identities.faces.Size()) throw new Error('analytic-certificate: incomplete producer face bindings');
  let triangleCount = 0;
  for (let faceIndex = 0; faceIndex < identities.faces.Size(); faceIndex += 1) {
    checkpoint();
    const face = owned.keep(oc.TopoDS.Face_1(owned.keep(identities.faces.FindKey(faceIndex + 1))));
    const location = owned.keep(new oc.TopLoc_Location_1());
    const triangulation = owned.keep(oc.BRep_Tool.Triangulation(face, location, 0));
    if (triangulation.IsNull()) throw new Error('analytic-certificate: missing bound native triangulation');
    const chart = readAnalyticFaceChart(oc, face, triangulation, faceIndex, 1024, 2048);
    triangleCount += chart.localTriangles.length;
    if (triangleCount > 2048) throw new Error('analytic-certificate: native binding triangle budget');
    const wires = readAnalyticWireChains(oc, face, triangulation, location, chart.uvNodes.length, owned, checkpoint, identities);
    const summary = summaries.get(faceIndex);
    if (summary === undefined || summary.reversed !== (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED)
      || summary.triangleCount + summary.collapsedPoleTriangles !== chart.localTriangles.length) {
      throw new Error('analytic-certificate: changed PLC face orientation or triangulation inventory');
    }
    const plcFace = plcFaces?.[faceIndex], poleNodes = new Set<number>(), boundaryLocals = new Set<number>();
    if (plcFaces !== undefined && (plcFace === undefined || plcFace.faceIndex !== faceIndex
      || plcFace.localToGlobal.length !== chart.uvNodes.length)) throw new Error('analytic-certificate: wrong producer face binding');
    for (const wire of wires) for (const segment of wire.segments) {
      const identity = segment.identity;
      if (identity === undefined) throw new Error('analytic-certificate: missing bound occurrence identity');
      const record = records.get(identity.edgeIndex), parameters = segment.trim.parameters;
      if (record === undefined || record.nodes.length !== parameters.length || segment.localNodes.length !== parameters.length) {
        throw new Error('analytic-certificate: incomplete bound edge subdivision');
      }
      if (record.degenerated) poleNodes.add(record.nodes[0]);
      if (plcFace !== undefined && segment.localNodes.some((local, index) => plcFace.localToGlobal[local] !== record.nodes[index])) {
        throw new Error('analytic-certificate: producer boundary correspondence differs from actual native chain');
      }
      for (const local of segment.localNodes) boundaryLocals.add(local);
      const previous = edgeParameters.get(identity.edgeIndex);
      if (previous !== undefined && (previous.length !== parameters.length || previous.some((value, index) => value !== parameters[index]))) {
        throw new Error('analytic-certificate: changed shared edge parameterization');
      }
      edgeParameters.set(identity.edgeIndex, parameters);
      const nativeEdge = owned.keep(oc.TopoDS.Edge_1(owned.keep(originals.edges.FindKey(identity.edgeIndex + 1))));
      const curve = owned.keep(new oc.BRepAdaptor_Curve_2(nativeEdge));
      for (let index = 1; index < parameters.length - 1; index += 1) {
        checkpoint();
        const node = record.nodes[index];
        if (!Number.isSafeInteger(node) || node < 0 || node >= mesh.nodeCount || mesh.nodeKinds[node] !== 1) {
          throw new Error('analytic-certificate: unknown PLC edge node');
        }
        const point = curve.Value(parameters[index]);
        try {
          if (nativePoint3(point).some((coordinate, axis) => coordinate !== mesh.coordinates[3 * node + axis])) {
            throw new Error('analytic-certificate: PLC edge node differs from native parameter');
          }
        } finally { point.delete(); }
      }
    }
    if (plcFace !== undefined) {
      const nativeTriangulation = triangulation.get(), transform = owned.keep(location.Transformation());
      for (let local = 0; local < chart.uvNodes.length; local += 1) {
        checkpoint();
        const node = plcFace.localToGlobal[local];
        if (!Number.isSafeInteger(node) || node < 0 || node >= mesh.nodeCount) throw new Error('analytic-certificate: unknown producer node');
        coveredPlcNodes.add(node);
        if (boundaryLocals.has(local)) continue;
        if (mesh.nodeKinds[node] !== 2 || interiorNodes.has(node)) throw new Error('analytic-certificate: aliased interior native node');
        interiorNodes.add(node);
        const point = nativeTriangulation.Node(local + 1);
        try {
          const world = point.Transformed(transform);
          try {
            if (nativePoint3(world).some((value, axis) => value !== mesh.coordinates[3 * node + axis])) {
              throw new Error('analytic-certificate: interior native location or position mismatch');
            }
          } finally { world.delete(); }
        } finally { point.delete(); }
      }
      interiorFaces.push({ chart, materialForward: !summary.reversed, poleNodes });
    }
    faces.push({ chart, wires });
  }
  if (plcFaces !== undefined && coveredPlcNodes.size !== mesh.nodeCount) throw new Error('analytic-certificate: omitted PLC node inventory');
  const nativeLedger = auditAnalyticNativeClosure(faces.map(({ chart, wires }) => ({ faceIndex: chart.faceIndex, wires })),
    { faces: originals.faces.Size(), edges: originals.edges.Size(), vertices: originals.vertices.Size() }, checkpoint);
  const budget = createAnalyticCellBudget(triangleCount, checkpoint);
  const interior = plcFaces === undefined ? undefined : bindAnalyticInteriorCells(interiorFaces, mesh, plcFaces, budget, checkpoint);
  const uses: { occurrence: number; trace: AnalyticConnectorTrace; forward: boolean }[] = [];
  const addTrace = (trace: AnalyticConnectorTrace, forward: boolean): void => {
    if (uses.length >= 12288) throw new Error('analytic-certificate: connector ledger budget');
    uses.push({ occurrence: uses.length, trace, forward });
  };
  let flux: AnalyticInterval = [0, 0], ribbonCount = 0, bridgeCount = 0, endpointPatchCount = 0;
  let maximumRibbonDistanceMm = 0, maximumNativeGapMm = 0, maximumEndpointAnchorRadiusMm = 0;
  for (const { chart, wires } of faces) {
    const ribbons = boundAnalyticWireRibbons(chart, wires, subdivisions, budget, checkpoint);
    const summary = summaries.get(chart.faceIndex);
    if (summary === undefined) throw new Error('analytic-certificate: missing bound material face');
    const materialForward = !summary.reversed;
    // go-13: fail-closed local admission on the same live chart/wires/records/producer mapping and the ONE budget.
    if (plcFaces !== undefined) {
      const plcFace = plcFaces[chart.faceIndex];
      if (plcFace === undefined) throw new Error('analytic-certificate: missing producer face binding for admission');
      analyticChartAdmission(chart, wires, records, plcFace, budget, checkpoint);
    }
    flux = intervalAdd(flux, materialForward ? ribbons.fluxIntervalMm3 : intervalNegate(ribbons.fluxIntervalMm3));
    ribbonCount += ribbons.ribbons.length;
    maximumRibbonDistanceMm = Math.max(maximumRibbonDistanceMm, ribbons.maximumDistanceMm);
    for (const wire of wires) for (const segment of wire.segments) {
      const identity = segment.identity;
      if (identity === undefined) throw new Error('analytic-certificate: missing patch identity');
      const record = records.get(identity.edgeIndex);
      if (record === undefined) throw new Error('analytic-certificate: missing patch PLC edge');
      const forward = segment.forward === materialForward, parameters = segment.trim.parameters;
      for (let index = 0; index < parameters.length - 1; index += 1) {
        const bridge = boundAnalyticNativeBridge(segment.pair, chart.geometry, parameters[index], parameters[index + 1], forward, subdivisions, budget);
        flux = intervalAdd(flux, bridge.fluxIntervalMm3); bridgeCount += 1;
        maximumNativeGapMm = Math.max(maximumNativeGapMm, bridge.maximumDistanceMm);
        for (const endpoint of [index, index + 1]) {
          const parameter = parameters[endpoint], atStart = endpoint === index;
          const polygonUv = chart.uvNodes[segment.localNodes[endpoint]];
          const q: AnalyticUvEndpoint = { kind: 'uv', value: polygonUv };
          const p: AnalyticUvEndpoint = { kind: 'pcurve', curve: segment.pair.pcurve, parameter };
          const surfacePoint: AnalyticEndpoint = { kind: 'surface', geometry: chart.geometry, uv: p };
          const edgePoint: AnalyticEndpoint = { kind: 'curve', curve: segment.pair.curve, parameter };
          const direction = atStart ? forward : !forward;
          addTrace({ kind: 'surface', geometry: chart.geometry, start: q, end: p }, direction);
          addTrace({ kind: 'straight', start: surfacePoint, end: edgePoint }, direction);
          // Adjacent parameter cells cancel directly. Only native edge ends need anchor patches.
          if (endpoint !== 0 && endpoint !== parameters.length - 1) continue;
          const vertexIndex = endpoint === 0 ? identity.firstVertex : identity.lastVertex;
          const anchor = anchors[vertexIndex];
          if (anchor === undefined || anchor.vertexIndex !== vertexIndex || anchor.plcNode !== record.nodes[endpoint]) {
            throw new Error('analytic-certificate: endpoint patch lost its owning native vertex');
          }
          const cone = boundAnalyticEndpointPatch(chart.geometry, segment.pair.pcurve, parameter, polygonUv,
            anchor.point, !direction, subdivisions, budget);
          const triangle = boundAnalyticEndpointTriangle(anchor.point, surfacePoint, edgePoint, !direction, budget);
          for (const patch of [cone, triangle]) {
            flux = intervalAdd(flux, patch.fluxIntervalMm3); endpointPatchCount += 1;
            maximumEndpointAnchorRadiusMm = Math.max(maximumEndpointAnchorRadiusMm, patch.anchorRadiusMm);
            for (const boundary of patch.boundary) addTrace(boundary.trace, boundary.forward);
          }
        }
      }
    }
  }
  const connectorLedger = auditAnalyticConnectorCancellation(uses, checkpoint);
  return { geometricallyClosed: false, anchors, faces, nativeLedger, connectorLedger,
    ribbonCount, bridgeCount, endpointPatchCount, maximumRibbonDistanceMm, maximumNativeGapMm,
    maximumEndpointAnchorRadiusMm, fluxIntervalMm3: flux, cellsUsed: budget.used(),
    ...(interior === undefined ? {} : { interior }) };
}

/** A finite identity/orientation ledger, not a geometric closure certificate or a volume acceptance test. */
export function auditAnalyticNativeClosure(faces: readonly { readonly faceIndex: number; readonly wires: readonly AnalyticWireChain[] }[],
  expected: { readonly faces: number; readonly edges: number; readonly vertices: number },
  checkpoint: () => void): AnalyticNativeClosureLedger {
  for (const [count, limit] of [[expected.faces, 2048], [expected.edges, 6144], [expected.vertices, 1024]]) {
    if (!Number.isSafeInteger(count) || count < 1 || count > limit) throw new Error('analytic-certificate: closure identity count');
  }
  if (faces.length !== expected.faces) throw new Error('analytic-certificate: incomplete closure face set');
  const faceSet = new Set<number>(), vertices = new Set<number>();
  const uses = new Map<number, AnalyticBoundaryOccurrence[]>();
  let occurrenceCount = 0;
  for (let faceSlot = 0; faceSlot < faces.length; faceSlot += 1) {
    checkpoint();
    if (!Object.hasOwn(faces, faceSlot)) throw new Error('analytic-certificate: sparse closure face');
    const face = faces[faceSlot];
    if (!Number.isSafeInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex >= expected.faces
      || faceSet.has(face.faceIndex) || face.wires.length === 0) throw new Error('analytic-certificate: duplicate or missing closure face');
    faceSet.add(face.faceIndex);
    let faceForward: boolean | undefined;
    for (let wireIndex = 0; wireIndex < face.wires.length; wireIndex += 1) {
      if (!Object.hasOwn(face.wires, wireIndex)) throw new Error('analytic-certificate: sparse closure wire');
      const wire = face.wires[wireIndex];
      if (wire.segments.length === 0) throw new Error('analytic-certificate: empty closure wire');
      let firstVertex: number | undefined, lastVertex: number | undefined;
      for (let segmentIndex = 0; segmentIndex < wire.segments.length; segmentIndex += 1) {
        if (++occurrenceCount > 12288 || !Object.hasOwn(wire.segments, segmentIndex)) {
          throw new Error('analytic-certificate: closure occurrence budget or sparse segment');
        }
        checkpoint();
        const segment = wire.segments[segmentIndex], identity = segment.identity;
        if (identity === undefined || identity.faceIndex !== face.faceIndex || identity.wireIndex !== wireIndex
          || identity.segmentIndex !== segmentIndex || identity.forward !== segment.forward
          || typeof identity.forward !== 'boolean' || typeof identity.faceForward !== 'boolean'
          || identity.first !== segment.pair.first || identity.last !== segment.pair.last
          || !Number.isFinite(identity.first) || !Number.isFinite(identity.last) || !(identity.first < identity.last)
          || !Number.isSafeInteger(identity.edgeIndex) || identity.edgeIndex < 0 || identity.edgeIndex >= expected.edges) {
          throw new Error('analytic-certificate: mismatched native closure occurrence');
        }
        for (const vertex of [identity.firstVertex, identity.lastVertex]) {
          if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= expected.vertices) {
            throw new Error('analytic-certificate: unknown closure vertex');
          }
          vertices.add(vertex);
        }
        faceForward ??= identity.faceForward;
        if (faceForward !== identity.faceForward) throw new Error('analytic-certificate: inconsistent material face orientation');
        const from = identity.forward ? identity.firstVertex : identity.lastVertex;
        const to = identity.forward ? identity.lastVertex : identity.firstVertex;
        firstVertex ??= from;
        if (lastVertex !== undefined && lastVertex !== from) throw new Error('analytic-certificate: disconnected native vertex chain');
        lastVertex = to;
        const previous = uses.get(identity.edgeIndex) ?? [];
        previous.push(identity);
        if (previous.length > 2) throw new Error('analytic-certificate: nonmanifold native edge');
        uses.set(identity.edgeIndex, previous);
      }
      if (firstVertex !== lastVertex) throw new Error('analytic-certificate: open native vertex chain');
    }
  }
  if (uses.size !== expected.edges || vertices.size !== expected.vertices) throw new Error('analytic-certificate: incomplete native identity set');
  const edgePairs: (readonly [AnalyticBoundaryOccurrence, AnalyticBoundaryOccurrence])[] = [];
  for (let edge = 0; edge < expected.edges; edge += 1) {
    const pair = uses.get(edge);
    if (pair?.length !== 2) throw new Error('analytic-certificate: unmatched native edge');
    const [a, b] = pair;
    if (a.firstVertex !== b.firstVertex || a.lastVertex !== b.lastVertex || a.first !== b.first || a.last !== b.last
      || (a.forward === a.faceForward) === (b.forward === b.faceForward)) {
      throw new Error('analytic-certificate: inconsistent shared native edge or material orientation');
    }
    edgePairs.push([a, b]);
  }
  checkpoint();
  return { topologicallyClosed: true, geometricallyClosed: false, edgePairs };
}

type ExactUv = readonly [bigint, bigint];
type LocalTriangle = readonly [number, number, number];

/** Preserve every binary64 coordinate exactly, including subnormal UV lifts. */
function exactUvNodes(nodes: readonly UvPoint[]): readonly ExactUv[] {
  const view = new DataView(new ArrayBuffer(8));
  const parts: { mantissa: bigint; exponent: number }[] = [];
  let minimumExponent = 0;
  for (const node of nodes) for (const coordinate of node) {
    if (!Number.isFinite(coordinate)) throw new Error('analytic-certificate: nonfinite UV complex');
    view.setFloat64(0, coordinate, false);
    const word = view.getBigUint64(0, false);
    const exponentBits = Number((word >> 52n) & 2047n);
    let mantissa = word & ((1n << 52n) - 1n);
    const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    if (exponentBits !== 0) mantissa += 1n << 52n;
    if ((word >> 63n) !== 0n) mantissa = -mantissa;
    if (mantissa !== 0n) minimumExponent = Math.min(minimumExponent, exponent);
    parts.push({ mantissa, exponent });
  }
  const integers = parts.map(({ mantissa, exponent }) => mantissa === 0n ? 0n
    : mantissa << BigInt(exponent - minimumExponent));
  return nodes.map((_, index): ExactUv => [integers[2 * index], integers[2 * index + 1]]);
}

function orientUv(a: ExactUv, b: ExactUv, c: ExactUv): bigint {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onUvSegment(p: ExactUv, a: ExactUv, b: ExactUv): boolean {
  const between = (value: bigint, first: bigint, last: bigint): boolean => first <= last
    ? first <= value && value <= last : last <= value && value <= first;
  return orientUv(a, b, p) === 0n && between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);
}

function uvContactAllowed(points: readonly ExactUv[], a: LocalTriangle, b: LocalTriangle): boolean {
  const common = a.filter(index => b.includes(index));
  if (common.length === 3) return false;
  const allowed = (point: ExactUv): boolean => common.length === 1
    ? point[0] === points[common[0]][0] && point[1] === points[common[0]][1]
    : common.length === 2 && onUvSegment(point, points[common[0]], points[common[1]]);
  const inside = (point: ExactUv, triangle: LocalTriangle): boolean => {
    const signs = triangle.map((index, side) => orientUv(points[index], points[triangle[(side + 1) % 3]], point));
    return signs.every(value => value >= 0n) || signs.every(value => value <= 0n);
  };
  for (const index of a) if (inside(points[index], b) && !allowed(points[index])) return false;
  for (const index of b) if (inside(points[index], a) && !allowed(points[index])) return false;
  const opposite = (first: bigint, last: bigint): boolean => (first < 0n && last > 0n) || (first > 0n && last < 0n);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const p = points[a[i]], q = points[a[(i + 1) % 3]];
    const r = points[b[j]], s = points[b[(j + 1) % 3]];
    if (opposite(orientUv(p, q, r), orientUv(p, q, s))
      && opposite(orientUv(r, s, p), orientUv(r, s, q))) return false;
    for (const point of [p, q]) if (onUvSegment(point, r, s) && !allowed(point)) return false;
    for (const point of [r, s]) if (onUvSegment(point, p, q) && !allowed(point)) return false;
  }
  return true;
}

/**
 * Prove an embedded, connected, oriented POLYGONAL UV complex with precisely the supplied boundary.
 * Loops repeat their first local node at the end and follow the triangle orientation. Internal edges
 * cancel exactly; every boundary occurrence must appear once, including both distinct seam lifts.
 * This proves neither correspondence to the analytic trim curves nor the native-tolerance gap tube.
 * A complete curved-face certificate still requires both independent obligations.
 */
export function validateAnalyticUvComplex(nodes: readonly UvPoint[], triangles: readonly LocalTriangle[],
  boundaryLoops: readonly (readonly number[])[], checkpoint: () => void): void {
  checkpoint();
  if (nodes.length < 3 || nodes.length > 1024 || triangles.length === 0 || triangles.length > 2048
    || boundaryLoops.length === 0 || boundaryLoops.length > triangles.length * 3) {
    throw new Error('analytic-certificate: UV complex budget');
  }
  for (let index = 0; index < nodes.length; index += 1) {
    if (!Object.hasOwn(nodes, index) || nodes[index].length !== 2
      || !Object.hasOwn(nodes[index], 0) || !Object.hasOwn(nodes[index], 1)) {
      throw new Error('analytic-certificate: sparse UV node');
    }
  }
  const points = exactUvNodes(nodes);
  const edges = new Map<string, { from: number; to: number; triangles: number[] }>();
  const neighbours: number[][] = Array.from({ length: triangles.length }, () => []);
  const used = new Set<number>();
  const validNode = (index: number): boolean => Number.isSafeInteger(index) && index >= 0 && index < nodes.length;
  let orientation: bigint | undefined;
  const boxes = triangles.map((triangle, triangleIndex) => {
    if (triangle.length !== 3) throw new Error('analytic-certificate: invalid UV triangle');
    for (let side = 0; side < 3; side += 1) {
      if (!Object.hasOwn(triangle, side) || !validNode(triangle[side])) {
        throw new Error('analytic-certificate: invalid UV triangle index');
      }
      used.add(triangle[side]);
    }
    const signedArea = orientUv(points[triangle[0]], points[triangle[1]], points[triangle[2]]);
    if (signedArea === 0n) throw new Error('analytic-certificate: degenerate UV triangle');
    const sign = signedArea > 0n ? 1n : -1n;
    orientation ??= sign;
    if (sign !== orientation) throw new Error('analytic-certificate: inconsistent UV orientation');
    for (let side = 0; side < 3; side += 1) {
      const from = triangle[side], to = triangle[(side + 1) % 3];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const previous = edges.get(key);
      if (previous === undefined) edges.set(key, { from, to, triangles: [triangleIndex] });
      else {
        if (previous.triangles.length !== 1 || previous.from !== to || previous.to !== from) {
          throw new Error('analytic-certificate: nonmanifold UV edge');
        }
        neighbours[triangleIndex].push(previous.triangles[0]);
        neighbours[previous.triangles[0]].push(triangleIndex);
        previous.triangles.push(triangleIndex);
      }
    }
    return { index: triangleIndex, minU: Math.min(...triangle.map(index => nodes[index][0])),
      maxU: Math.max(...triangle.map(index => nodes[index][0])), minV: Math.min(...triangle.map(index => nodes[index][1])),
      maxV: Math.max(...triangle.map(index => nodes[index][1])) };
  });
  if (Object.keys(triangles).length !== triangles.length || used.size !== nodes.length) {
    throw new Error('analytic-certificate: sparse triangle or unused UV node');
  }
  const pending = [0], reached = new Set<number>();
  while (pending.length > 0) {
    const index = pending.pop();
    if (index === undefined) break;
    if (reached.has(index)) continue;
    reached.add(index);
    pending.push(...neighbours[index]);
  }
  if (reached.size !== triangles.length) throw new Error('analytic-certificate: disconnected UV complex');
  const expected = new Set<string>(), boundaryNodes = new Set<number>();
  for (let loopIndex = 0; loopIndex < boundaryLoops.length; loopIndex += 1) {
    if (!Object.hasOwn(boundaryLoops, loopIndex)) throw new Error('analytic-certificate: sparse UV boundary');
    const loop = boundaryLoops[loopIndex];
    if (loop.length < 4 || loop.length > nodes.length + 1 || loop[0] !== loop[loop.length - 1]) {
      throw new Error('analytic-certificate: incomplete UV boundary loop');
    }
    for (let index = 0; index < loop.length - 1; index += 1) {
      const from = loop[index], to = loop[index + 1];
      if (!Object.hasOwn(loop, index) || !Object.hasOwn(loop, index + 1) || !validNode(from) || !validNode(to)
        || boundaryNodes.has(from)) throw new Error('analytic-certificate: pinched or invalid UV boundary');
      boundaryNodes.add(from);
      expected.add(`${from}:${to}`);
    }
  }
  for (const edge of edges.values()) if (edge.triangles.length === 1) {
    if (!expected.delete(`${edge.from}:${edge.to}`)) throw new Error('analytic-certificate: unmatched UV boundary edge');
  }
  if (expected.size !== 0) throw new Error('analytic-certificate: missing UV boundary edge');
  boxes.sort((a, b) => a.minU - b.minU);
  let comparisons = 0;
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j];
    if (b.minU > a.maxU) break;
    if ((comparisons++ & 127) === 0) checkpoint();
    if (a.maxV < b.minV || b.maxV < a.minV) continue;
    if (!uvContactAllowed(points, triangles[a.index], triangles[b.index])) {
      throw new Error('analytic-certificate: overlapping UV triangles');
    }
  }
  checkpoint();
}

const bits = new DataView(new ArrayBuffer(8));

/** Next representable value toward +infinity, including subnormal and signed-zero inputs. */
export function nextUpper(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  const word = bits.getBigUint64(0, false);
  bits.setBigUint64(0, value > 0 ? word + 1n : word - 1n, false);
  return bits.getFloat64(0, false);
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`analytic-certificate: invalid ${name}`);
  return value;
}

function positive(value: number, name: string): number {
  nonnegative(value, name);
  if (value === 0) throw new Error(`analytic-certificate: zero ${name}`);
  return value;
}

function finiteUpper(value: number): number {
  if (!Number.isFinite(value)) throw new Error('analytic-certificate: bound overflow');
  return value;
}

/** Inputs are nonnegative bounds. Preserve exact zero to avoid inventing error on affine surfaces. */
function addUpper(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return finiteUpper(nextUpper(a + b));
}

function multiplyUpper(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return finiteUpper(nextUpper(a * b));
}

function spanUpper(values: readonly number[]): number {
  for (const value of values) if (!Number.isFinite(value)) throw new Error('analytic-certificate: nonfinite UV');
  const low = Math.min(...values), high = Math.max(...values);
  return low === high ? 0 : finiteUpper(nextUpper(high - low));
}

function intervalPoint(value: number): AnalyticInterval {
  if (!Number.isFinite(value)) throw new Error('analytic-certificate: nonfinite interval point');
  return [value, value];
}

function checkedInterval(value: AnalyticInterval): AnalyticInterval {
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] > value[1]) {
    throw new Error('analytic-certificate: invalid or overflowing interval');
  }
  return value;
}

function intervalAdd(a: AnalyticInterval, b: AnalyticInterval): AnalyticInterval {
  if (a[0] === 0 && a[1] === 0) return b;
  if (b[0] === 0 && b[1] === 0) return a;
  return checkedInterval([-nextUpper(-(a[0] + b[0])), nextUpper(a[1] + b[1])]);
}

function intervalNegate(a: AnalyticInterval): AnalyticInterval { return [-a[1], -a[0]]; }

function intervalMultiply(a: AnalyticInterval, b: AnalyticInterval): AnalyticInterval {
  if ((a[0] === 0 && a[1] === 0) || (b[0] === 0 && b[1] === 0)) return [0, 0];
  const products = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return checkedInterval([-nextUpper(-Math.min(...products)), nextUpper(Math.max(...products))]);
}

function intervalDividePositive(a: AnalyticInterval, denominator: number): AnalyticInterval {
  positive(denominator, 'interval divisor');
  return checkedInterval([-nextUpper(-(a[0] / denominator)), nextUpper(a[1] / denominator)]);
}

/**
 * Taylor degree 65 with the full Lagrange remainder |x|^66/66!. Only ordinary rounded arithmetic is used;
 * each operation is enclosed outward. There is no dependency on the accuracy of Math.sin/Math.cos.
 * The bounded chart [-8,8] includes the ordinary single-period lifts of the admitted primitives. Other
 * lifts are explicitly refused until a proved range-reduction step exists; they are not silently wrapped.
 */
export function analyticSinCos(parameter: AnalyticInterval): { sin: AnalyticInterval; cos: AnalyticInterval } {
  checkedInterval(parameter);
  if (parameter[0] < -8 || parameter[1] > 8) throw new Error('analytic-certificate: unsupported angular lift');
  if (parameter[0] === 0 && parameter[1] === 0) return { sin: [0, 0], cos: [1, 1] };
  // Any representable midpoint is legitimate: the independently rounded radius encloses the complete input.
  const centre = parameter[0] / 2 + parameter[1] / 2;
  const point = intervalPoint(centre);
  const negativeSquare = intervalNegate(intervalMultiply(point, point));
  let sinTerm = point, sin = point;
  let cosTerm: AnalyticInterval = [1, 1], cos: AnalyticInterval = [1, 1];
  for (let order = 1; order <= 32; order += 1) {
    sinTerm = intervalDividePositive(intervalMultiply(sinTerm, negativeSquare), (2 * order) * (2 * order + 1));
    cosTerm = intervalDividePositive(intervalMultiply(cosTerm, negativeSquare), (2 * order - 1) * (2 * order));
    sin = intervalAdd(sin, sinTerm);
    cos = intervalAdd(cos, cosTerm);
  }
  let remainder = 1;
  for (let order = 1; order <= 66; order += 1) {
    remainder = finiteUpper(nextUpper(multiplyUpper(remainder, Math.abs(centre)) / order));
  }
  const radius = Math.max(spanUpper([parameter[0], centre]), spanUpper([parameter[1], centre]));
  const error = addUpper(remainder, radius); // Both derivatives are globally bounded by 1.
  const expand = (value: AnalyticInterval): AnalyticInterval => {
    const expanded = intervalAdd(value, [-error, error]);
    return checkedInterval([Math.max(-1, expanded[0]), Math.min(1, expanded[1])]);
  };
  return { sin: expand(sin), cos: expand(cos) };
}

function intervalVector(origin: CertificatePoint3,
  terms: readonly { factor: AnalyticInterval; direction: CertificatePoint3 }[]): AnalyticIntervalPoint3 {
  const component = (axis: number): AnalyticInterval => {
    let value = intervalPoint(origin[axis]);
    for (const term of terms) value = intervalAdd(value, intervalMultiply(term.factor, intervalPoint(term.direction[axis])));
    return value;
  };
  return [component(0), component(1), component(2)];
}

function transformInterval(point: AnalyticIntervalPoint3, transform: AnalyticAffine | undefined): AnalyticIntervalPoint3 {
  if (transform === undefined) return point;
  const component = (row: number): AnalyticInterval => {
    let value = intervalPoint(transform[row][3]);
    for (let column = 0; column < 3; column += 1) {
      value = intervalAdd(value, intervalMultiply(intervalPoint(transform[row][column]), point[column]));
    }
    return value;
  };
  return [component(0), component(1), component(2)];
}

export function analyticCurveInterval(curve: AnalyticCurveGeometry, parameter: AnalyticInterval): AnalyticIntervalPoint3 {
  checkedInterval(parameter);
  if (curve.kind === 'line') return transformInterval(intervalVector(curve.origin,
    [{ factor: parameter, direction: curve.direction }]), curve.transform);
  const trigonometry = analyticSinCos(parameter);
  return transformInterval(intervalVector(curve.origin, [
    { factor: intervalMultiply(intervalPoint(positive(curve.major, 'curve major radius')), trigonometry.cos), direction: curve.x },
    { factor: intervalMultiply(intervalPoint(positive(curve.minor, 'curve minor radius')), trigonometry.sin), direction: curve.y },
  ]), curve.transform);
}

export function analyticSurfaceInterval(geometry: AnalyticSurfaceGeometry,
  u: AnalyticInterval, v: AnalyticInterval): AnalyticIntervalPoint3 {
  checkedInterval(u); checkedInterval(v);
  const { surface, frame } = geometry;
  if (surface.scale !== 1) throw new Error('analytic-certificate: surface interval requires unscaled local primitive');
  if (surface.kind === 'plane') return transformInterval(intervalVector(frame.origin,
    [{ factor: u, direction: frame.x }, { factor: v, direction: frame.y }]), geometry.transform);
  const around = analyticSinCos(u);
  let radius: AnalyticInterval, axial: AnalyticInterval;
  switch (surface.kind) {
    case 'cylinder': radius = intervalPoint(positive(surface.radius, 'cylinder radius')); axial = v; break;
    case 'cone': {
      if (geometry.coneSemiAngle === null) throw new Error('analytic-certificate: missing cone angle');
      const angle = analyticSinCos(intervalPoint(geometry.coneSemiAngle));
      radius = intervalAdd(intervalPoint(nonnegative(surface.referenceRadius, 'cone radius')), intervalMultiply(v, angle.sin));
      axial = intervalMultiply(v, angle.cos);
      break;
    }
    case 'sphere': {
      const latitude = analyticSinCos(v), r = intervalPoint(positive(surface.radius, 'sphere radius'));
      radius = intervalMultiply(r, latitude.cos); axial = intervalMultiply(r, latitude.sin);
      break;
    }
    case 'torus': {
      const minorAngle = analyticSinCos(v);
      const major = positive(surface.majorRadius, 'torus major radius'), minor = positive(surface.minorRadius, 'torus minor radius');
      if (!(major > minor)) throw new Error('analytic-certificate: nonregular torus');
      radius = intervalAdd(intervalPoint(major), intervalMultiply(intervalPoint(minor), minorAngle.cos));
      axial = intervalMultiply(intervalPoint(minor), minorAngle.sin);
      break;
    }
  }
  return transformInterval(intervalVector(frame.origin, [{ factor: intervalMultiply(radius, around.cos), direction: frame.x },
    { factor: intervalMultiply(radius, around.sin), direction: frame.y }, { factor: axial, direction: frame.z }]), geometry.transform);
}

function l1Upper(vector: CertificatePoint3): number {
  return addUpper(addUpper(nonnegative(Math.abs(vector[0]), 'axis component'),
    nonnegative(Math.abs(vector[1]), 'axis component')), nonnegative(Math.abs(vector[2]), 'axis component'));
}

function intervalHull(a: AnalyticInterval, b: AnalyticInterval): AnalyticInterval {
  return checkedInterval([Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
}

function intervalDivide(a: AnalyticInterval, positiveDenominator: AnalyticInterval): AnalyticInterval {
  checkedInterval(positiveDenominator);
  if (!(positiveDenominator[0] > 0)) throw new Error('analytic-certificate: unresolved positive denominator');
  return intervalMultiply(a, checkedInterval([-nextUpper(-1 / positiveDenominator[1]),
    nextUpper(1 / positiveDenominator[0])]));
}

function transformVectorInterval(vector: AnalyticIntervalPoint3, transform: AnalyticAffine | undefined): AnalyticIntervalPoint3 {
  if (transform === undefined) return vector;
  return transformInterval(vector, [
    [transform[0][0], transform[0][1], transform[0][2], 0],
    [transform[1][0], transform[1][1], transform[1][2], 0],
    [transform[2][0], transform[2][1], transform[2][2], 0],
  ]);
}

function curveDerivativeInterval(curve: AnalyticCurveGeometry, parameter: AnalyticInterval): AnalyticIntervalPoint3 {
  if (curve.kind === 'line') return transformVectorInterval([
    intervalPoint(curve.direction[0]), intervalPoint(curve.direction[1]), intervalPoint(curve.direction[2]),
  ], curve.transform);
  const angle = analyticSinCos(parameter);
  return transformVectorInterval(intervalVector([0, 0, 0], [
    { factor: intervalMultiply(intervalPoint(positive(curve.major, 'curve major radius')), intervalNegate(angle.sin)), direction: curve.x },
    { factor: intervalMultiply(intervalPoint(positive(curve.minor, 'curve minor radius')), angle.cos), direction: curve.y },
  ]), curve.transform);
}

/** First partials of the same LOCAL parameterization as analyticSurfaceInterval, with location applied once. */
function surfacePartialIntervals(geometry: AnalyticSurfaceGeometry, u: AnalyticInterval,
  v: AnalyticInterval): { u: AnalyticIntervalPoint3; v: AnalyticIntervalPoint3 } {
  const { surface, frame } = geometry;
  if (surface.scale !== 1) throw new Error('analytic-certificate: local derivative scale');
  const zero: AnalyticInterval = [0, 0], one: AnalyticInterval = [1, 1];
  let around = { sin: zero, cos: one }, radial = zero, radialV = zero, axialV = one;
  if (surface.kind !== 'plane') around = analyticSinCos(u);
  switch (surface.kind) {
    case 'plane': break;
    case 'cylinder': radial = intervalPoint(positive(surface.radius, 'cylinder radius')); break;
    case 'cone': {
      if (geometry.coneSemiAngle === null) throw new Error('analytic-certificate: missing cone angle');
      const angle = analyticSinCos(intervalPoint(geometry.coneSemiAngle));
      radial = intervalAdd(intervalPoint(nonnegative(surface.referenceRadius, 'cone radius')), intervalMultiply(v, angle.sin));
      radialV = angle.sin; axialV = angle.cos;
      break;
    }
    case 'sphere': {
      const angle = analyticSinCos(v), radius = intervalPoint(positive(surface.radius, 'sphere radius'));
      radial = intervalMultiply(radius, angle.cos);
      radialV = intervalMultiply(radius, intervalNegate(angle.sin)); axialV = radial;
      break;
    }
    case 'torus': {
      const angle = analyticSinCos(v), minor = intervalPoint(positive(surface.minorRadius, 'torus minor radius'));
      if (!(surface.majorRadius > surface.minorRadius)) throw new Error('analytic-certificate: nonregular torus');
      radial = intervalAdd(intervalPoint(positive(surface.majorRadius, 'torus major radius')), intervalMultiply(minor, angle.cos));
      radialV = intervalMultiply(minor, intervalNegate(angle.sin)); axialV = intervalMultiply(minor, angle.cos);
      break;
    }
  }
  const first = surface.kind === 'plane' ? intervalVector([0, 0, 0], [{ factor: one, direction: frame.x }])
    : intervalVector([0, 0, 0], [
      { factor: intervalMultiply(radial, intervalNegate(around.sin)), direction: frame.x },
      { factor: intervalMultiply(radial, around.cos), direction: frame.y },
    ]);
  const second = surface.kind === 'plane' ? intervalVector([0, 0, 0], [{ factor: one, direction: frame.y }])
    : intervalVector([0, 0, 0], [
      { factor: intervalMultiply(radialV, around.cos), direction: frame.x },
      { factor: intervalMultiply(radialV, around.sin), direction: frame.y },
      { factor: axialV, direction: frame.z },
    ]);
  return { u: transformVectorInterval(first, geometry.transform), v: transformVectorInterval(second, geometry.transform) };
}

function combinePartials(partials: { u: AnalyticIntervalPoint3; v: AnalyticIntervalPoint3 },
  u: AnalyticInterval, v: AnalyticInterval): AnalyticIntervalPoint3 {
  const component = (axis: number): AnalyticInterval => intervalAdd(intervalMultiply(partials.u[axis], u),
    intervalMultiply(partials.v[axis], v));
  return [component(0), component(1), component(2)];
}

function intervalDeterminant(a: AnalyticIntervalPoint3, b: AnalyticIntervalPoint3,
  c: AnalyticIntervalPoint3): AnalyticInterval {
  let value: AnalyticInterval = [0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const j = (axis + 1) % 3, k = (axis + 2) % 3;
    const cross = intervalAdd(intervalMultiply(b[j], c[k]), intervalNegate(intervalMultiply(b[k], c[j])));
    value = intervalAdd(value, intervalMultiply(a[axis], cross));
  }
  return value;
}

export interface AnalyticTrimRibbonBound {
  readonly first: number;
  readonly last: number;
  readonly forward: boolean;
  readonly maximumDistanceMm: number;
  /** Signed divergence flux, NOT a standalone enclosed volume. Adjacent/end connectors still must cancel. */
  readonly fluxIntervalMm3: AnalyticInterval;
  readonly startConnector: { readonly polygonUv: UvPoint; readonly curveUv: readonly [AnalyticInterval, AnalyticInterval] };
  readonly endConnector: { readonly polygonUv: UvPoint; readonly curveUv: readonly [AnalyticInterval, AnalyticInterval] };
}

/**
 * The whole ribbon R(t,s)=S((1-s)L(t)+s*p(t)), including its two end connectors.
 * Orientation is ds wedge dt, so its boundary replaces the polygon side by the pcurve side.
 * Flux is integral R dot (R_s cross R_t)/3; callers may sum it as a volume correction ONLY after proving
 * the COMPLETE oriented chain is closed. No area-times-distance or sampled trim substitution is used.
 */
export function boundAnalyticTrimRibbon(geometry: AnalyticSurfaceGeometry, pcurve: AnalyticCurveGeometry,
  polygonStart: UvPoint, polygonEnd: UvPoint, first: number, last: number, forward: boolean,
  subdivisions: number, budget: AnalyticCellBudget): AnalyticTrimRibbonBound {
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)
    || !Number.isSafeInteger(subdivisions) || subdivisions < 1 || subdivisions > 32) {
    throw new Error('analytic-certificate: invalid trim ribbon range or subdivisions');
  }
  const width = intervalAdd(intervalPoint(last), intervalNegate(intervalPoint(first)));
  const slope = (axis: number): AnalyticInterval => intervalDivide(
    intervalAdd(intervalPoint(polygonEnd[axis]), intervalNegate(intervalPoint(polygonStart[axis]))), width);
  const slopes = [slope(0), slope(1)] as const;
  const line = (parameter: AnalyticInterval, axis: number): AnalyticInterval => intervalAdd(intervalPoint(polygonStart[axis]),
    intervalMultiply(intervalAdd(parameter, intervalNegate(intervalPoint(first))), slopes[axis]));
  const pBounds = curveDerivativeBounds(pcurve);
  let flux: AnalyticInterval = [0, 0], maximumDistanceMm = 0, start = first;
  for (let cell = 1; cell <= subdivisions; cell += 1) {
    const end = cell === subdivisions ? last : first + (last - first) * (cell / subdivisions);
    if (!(start < end) || end > last) throw new Error('analytic-certificate: unresolved ribbon interval');
    budget.consume();
    const parameter: AnalyticInterval = [start, end];
    const p = analyticCurveInterval(pcurve, parameter), derivative = curveDerivativeInterval(pcurve, parameter);
    if (p[2][0] !== 0 || p[2][1] !== 0 || derivative[2][0] !== 0 || derivative[2][1] !== 0) {
      throw new Error('analytic-certificate: ribbon pcurve is not two dimensional');
    }
    const uv = [intervalHull(line(parameter, 0), p[0]), intervalHull(line(parameter, 1), p[1])] as const;
    const partials = surfacePartialIntervals(geometry, uv[0], uv[1]);
    const delta = (axis: number): AnalyticInterval => {
      const endpoint = (at: number): AnalyticInterval => intervalAdd(
        analyticCurveInterval(pcurve, [at, at])[axis], intervalNegate(line([at, at], axis)));
      const endpoints = intervalHull(endpoint(start), endpoint(end));
      const remainder = trimChordDeviationBound(pBounds.second[axis], start, end);
      return intervalAdd(endpoints, [-remainder, remainder]);
    };
    const du = delta(0), dv = delta(1);
    const along = combinePartials(partials, intervalHull(slopes[0], derivative[0]), intervalHull(slopes[1], derivative[1]));
    const across = combinePartials(partials, du, dv);
    const point = analyticSurfaceInterval(geometry, uv[0], uv[1]);
    const integrand = intervalDividePositive(intervalDeterminant(point, across, along), 3);
    const cellWidth = intervalAdd(intervalPoint(end), intervalNegate(intervalPoint(start)));
    flux = intervalAdd(flux, intervalMultiply(integrand, cellWidth));
    // For fixed t, integrate ||R_s|| from s=0 to any s in [0,1]. L1 bounds Euclidean displacement.
    let displacement = 0;
    for (const component of across) displacement = addUpper(displacement, Math.max(Math.abs(component[0]), Math.abs(component[1])));
    maximumDistanceMm = Math.max(maximumDistanceMm, displacement);
    start = end;
  }
  const connector = (polygonUv: UvPoint, parameter: number): AnalyticTrimRibbonBound['startConnector'] => {
    const point = analyticCurveInterval(pcurve, [parameter, parameter]);
    return { polygonUv, curveUv: [point[0], point[1]] };
  };
  return { first, last, forward, maximumDistanceMm, fluxIntervalMm3: forward ? flux : intervalNegate(flux),
    startConnector: connector(polygonStart, first), endConnector: connector(polygonEnd, last) };
}

export interface AnalyticFaceRibbons {
  /** Native curve and vertex bridges have NOT been discharged by a trim-ribbon bound. */
  readonly closed: false;
  readonly maximumDistanceMm: number;
  readonly fluxIntervalMm3: AnalyticInterval;
  readonly ribbons: readonly {
    readonly wireIndex: number;
    readonly segmentIndex: number;
    readonly polygonIntervalIndex: number;
    readonly fromLocalNode: number;
    readonly toLocalNode: number;
    readonly bound: AnalyticTrimRibbonBound;
  }[];
}

/** Every admitted polygon boundary interval must contribute exactly once, with native wire orientation. */
export function boundAnalyticWireRibbons(chart: AnalyticFaceChart, wires: readonly AnalyticWireChain[],
  subdivisions: number, budget: AnalyticCellBudget, checkpoint: () => void): AnalyticFaceRibbons {
  validateAnalyticUvComplex(chart.uvNodes, chart.localTriangles, wires.map(wire => wire.localNodes), checkpoint);
  const ribbons: AnalyticFaceRibbons['ribbons'][number][] = [];
  let flux: AnalyticInterval = [0, 0], maximumDistanceMm = 0;
  for (let wireIndex = 0; wireIndex < wires.length; wireIndex += 1) {
    const wire = wires[wireIndex], traversal: number[] = [];
    if (wire.segments.length === 0 || wire.segments.length > 6144) throw new Error('analytic-certificate: incomplete ribbon wire');
    for (let segmentIndex = 0; segmentIndex < wire.segments.length; segmentIndex += 1) {
      checkpoint();
      if (!Object.hasOwn(wire.segments, segmentIndex)) throw new Error('analytic-certificate: sparse ribbon segment');
      const segment = wire.segments[segmentIndex], parameters = segment.trim.parameters, nodes = segment.localNodes;
      if (parameters.length !== nodes.length || nodes.length < 2 || nodes.length > 1025
        || parameters[0] !== segment.pair.first || parameters[parameters.length - 1] !== segment.pair.last) {
        throw new Error('analytic-certificate: incomplete ribbon parameter coverage');
      }
      for (let index = 0; index < nodes.length; index += 1) {
        if (!Object.hasOwn(nodes, index) || !Object.hasOwn(parameters, index) || !Number.isSafeInteger(nodes[index])
          || nodes[index] < 0 || nodes[index] >= chart.uvNodes.length || !Number.isFinite(parameters[index])
          || (index > 0 && !(parameters[index - 1] < parameters[index]))) {
          throw new Error('analytic-certificate: invalid ribbon node or parameter');
        }
      }
      const ordered = segment.forward ? nodes : [...nodes].reverse();
      if (traversal.length > 0 && traversal[traversal.length - 1] !== ordered[0]) {
        throw new Error('analytic-certificate: disconnected ribbon traversal');
      }
      traversal.push(...(traversal.length === 0 ? ordered : ordered.slice(1)));
      for (let index = 0; index < parameters.length - 1; index += 1) {
        const bound = boundAnalyticTrimRibbon(chart.geometry, segment.pair.pcurve,
          chart.uvNodes[nodes[index]], chart.uvNodes[nodes[index + 1]], parameters[index], parameters[index + 1],
          segment.forward, subdivisions, budget);
        ribbons.push({ wireIndex, segmentIndex, polygonIntervalIndex: index,
          fromLocalNode: segment.forward ? nodes[index] : nodes[index + 1],
          toLocalNode: segment.forward ? nodes[index + 1] : nodes[index], bound });
        maximumDistanceMm = Math.max(maximumDistanceMm, bound.maximumDistanceMm);
        flux = intervalAdd(flux, bound.fluxIntervalMm3);
      }
    }
    if (traversal.length !== wire.localNodes.length || traversal.some((node, index) => node !== wire.localNodes[index])) {
      throw new Error('analytic-certificate: unmatched complete ribbon traversal');
    }
  }
  checkpoint();
  return { closed: false, maximumDistanceMm, fluxIntervalMm3: flux, ribbons };
}

export interface AnalyticNativeBridgeBound {
  readonly closed: false;
  readonly first: number;
  readonly last: number;
  readonly forward: boolean;
  readonly maximumDistanceMm: number;
  readonly fluxIntervalMm3: AnalyticInterval;
  readonly startConnector: { readonly surface: AnalyticIntervalPoint3; readonly edge: AnalyticIntervalPoint3 };
  readonly endConnector: { readonly surface: AnalyticIntervalPoint3; readonly edge: AnalyticIntervalPoint3 };
}

/**
 * Full edge-to-face gap bridge H(t,s)=(1-s)S(p(t))+s*C(t). The orientation replaces the pcurve boundary
 * by the independently represented shared edge. No stored OCCT tolerance is used as a gap assertion.
 * Actual native edge/vertex identity, endpoint caps and global degree are still separate obligations.
 */
export function boundAnalyticNativeBridge(pair: AnalyticNativeCurvePair, geometry: AnalyticSurfaceGeometry,
  first: number, last: number, forward: boolean, subdivisions: number,
  budget: AnalyticCellBudget): AnalyticNativeBridgeBound {
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)
    || first < pair.first || last > pair.last || !Number.isSafeInteger(subdivisions)
    || subdivisions < 1 || subdivisions > 32) throw new Error('analytic-certificate: invalid native bridge interval');
  const surfacePoint = (parameter: AnalyticInterval): AnalyticIntervalPoint3 => {
    const uv = analyticCurveInterval(pair.pcurve, parameter);
    if (uv[2][0] !== 0 || uv[2][1] !== 0) throw new Error('analytic-certificate: bridge pcurve is not two dimensional');
    return analyticSurfaceInterval(geometry, uv[0], uv[1]);
  };
  let maximumDistanceMm = 0, flux: AnalyticInterval = [0, 0], start = first;
  for (let cell = 1; cell <= subdivisions; cell += 1) {
    const end = cell === subdivisions ? last : first + (last - first) * (cell / subdivisions);
    if (!(start < end) || end > last) throw new Error('analytic-certificate: unresolved native bridge interval');
    budget.consume();
    const parameter: AnalyticInterval = [start, end];
    const uv = analyticCurveInterval(pair.pcurve, parameter), uvDerivative = curveDerivativeInterval(pair.pcurve, parameter);
    const surface = surfacePoint(parameter), edge = analyticCurveInterval(pair.curve, parameter);
    const surfaceDerivative = combinePartials(surfacePartialIntervals(geometry, uv[0], uv[1]), uvDerivative[0], uvDerivative[1]);
    const edgeDerivative = curveDerivativeInterval(pair.curve, parameter);
    const gap = analyticPairedCurveGapBound(pair.curve, pair.pcurve, geometry, start, end);
    const component = (axis: number): AnalyticInterval => {
      const raw = intervalAdd(edge[axis], intervalNegate(surface[axis]));
      // Intersection of two independent complete enclosures, not a measured discrepancy.
      return checkedInterval([Math.max(raw[0], -gap), Math.min(raw[1], gap)]);
    };
    const across: AnalyticIntervalPoint3 = [component(0), component(1), component(2)];
    const point: AnalyticIntervalPoint3 = [intervalHull(surface[0], edge[0]), intervalHull(surface[1], edge[1]), intervalHull(surface[2], edge[2])];
    const along: AnalyticIntervalPoint3 = [intervalHull(surfaceDerivative[0], edgeDerivative[0]),
      intervalHull(surfaceDerivative[1], edgeDerivative[1]), intervalHull(surfaceDerivative[2], edgeDerivative[2])];
    const integrand = intervalDividePositive(intervalDeterminant(point, across, along), 3);
    const width = intervalAdd(intervalPoint(end), intervalNegate(intervalPoint(start)));
    flux = intervalAdd(flux, intervalMultiply(integrand, width));
    maximumDistanceMm = Math.max(maximumDistanceMm, gap);
    start = end;
  }
  const connector = (parameter: number): AnalyticNativeBridgeBound['startConnector'] => ({
    surface: surfacePoint([parameter, parameter]), edge: analyticCurveInterval(pair.curve, [parameter, parameter]),
  });
  return { closed: false, first, last, forward, maximumDistanceMm,
    fluxIntervalMm3: forward ? flux : intervalNegate(flux), startConnector: connector(first), endConnector: connector(last) };
}

export interface AnalyticEndpointPatchBound {
  readonly closed: false;
  readonly fluxIntervalMm3: AnalyticInterval;
  /** Distance of every cone point from the independently bound anchor; not distance from the whole PLC. */
  readonly anchorRadiusMm: number;
  readonly anchor: CertificatePoint3;
  readonly start: AnalyticIntervalPoint3;
  readonly end: AnalyticIntervalPoint3;
  readonly boundary: readonly { readonly trace: AnalyticConnectorTrace; readonly forward: boolean }[];
}

/**
 * Cone patch from a fixed native vertex to the complete analytic UV connector S((1-s)q+s*p(t0)).
 * Its boundary is the connector start->end, end->anchor, anchor->start. Exact integration in the cone
 * radius gives flux = integral anchor dot ((R-anchor) cross R') / 6. It is not an enclosed volume.
 */
export function boundAnalyticEndpointPatch(geometry: AnalyticSurfaceGeometry, pcurve: AnalyticCurveGeometry,
  parameter: number, polygonUv: UvPoint, anchor: CertificatePoint3, forward: boolean,
  subdivisions: number, budget: AnalyticCellBudget): AnalyticEndpointPatchBound {
  if (!Number.isFinite(parameter) || !Number.isSafeInteger(subdivisions) || subdivisions < 1 || subdivisions > 32) {
    throw new Error('analytic-certificate: invalid endpoint patch interval');
  }
  const endpoint = analyticCurveInterval(pcurve, [parameter, parameter]);
  if (endpoint[2][0] !== 0 || endpoint[2][1] !== 0) throw new Error('analytic-certificate: endpoint pcurve is not two dimensional');
  const a: AnalyticIntervalPoint3 = [intervalPoint(anchor[0]), intervalPoint(anchor[1]), intervalPoint(anchor[2])];
  const q = [intervalPoint(polygonUv[0]), intervalPoint(polygonUv[1])] as const;
  const du = intervalAdd(endpoint[0], intervalNegate(q[0])), dv = intervalAdd(endpoint[1], intervalNegate(q[1]));
  const at = (s: AnalyticInterval): readonly [AnalyticInterval, AnalyticInterval] => [
    intervalAdd(q[0], intervalMultiply(s, du)), intervalAdd(q[1], intervalMultiply(s, dv)),
  ];
  let flux: AnalyticInterval = [0, 0], anchorRadiusMm = 0, first = 0;
  for (let cell = 1; cell <= subdivisions; cell += 1) {
    const last = cell === subdivisions ? 1 : cell / subdivisions;
    if (!(first < last) || last > 1) throw new Error('analytic-certificate: unresolved endpoint patch interval');
    budget.consume();
    const uv = at([first, last]), r = analyticSurfaceInterval(geometry, uv[0], uv[1]);
    const derivative = combinePartials(surfacePartialIntervals(geometry, uv[0], uv[1]), du, dv);
    const offset: AnalyticIntervalPoint3 = [intervalAdd(r[0], intervalNegate(a[0])),
      intervalAdd(r[1], intervalNegate(a[1])), intervalAdd(r[2], intervalNegate(a[2]))];
    const integrand = intervalDividePositive(intervalDeterminant(a, offset, derivative), 6);
    const width = intervalAdd(intervalPoint(last), intervalNegate(intervalPoint(first)));
    flux = intervalAdd(flux, intervalMultiply(integrand, width));
    let radius = 0;
    for (const component of offset) radius = addUpper(radius, Math.max(Math.abs(component[0]), Math.abs(component[1])));
    anchorRadiusMm = Math.max(anchorRadiusMm, radius);
    first = last;
  }
  const startUv: AnalyticUvEndpoint = { kind: 'uv', value: polygonUv };
  const endUv: AnalyticUvEndpoint = { kind: 'pcurve', curve: pcurve, parameter };
  const startPoint: AnalyticEndpoint = { kind: 'surface', geometry, uv: startUv };
  const endPoint: AnalyticEndpoint = { kind: 'surface', geometry, uv: endUv };
  const anchorPoint: AnalyticEndpoint = { kind: 'point', value: anchor };
  return { closed: false, fluxIntervalMm3: forward ? flux : intervalNegate(flux), anchorRadiusMm, anchor,
    start: analyticSurfaceInterval(geometry, q[0], q[1]), end: analyticSurfaceInterval(geometry, endpoint[0], endpoint[1]),
    boundary: [
      { trace: { kind: 'surface', geometry, start: startUv, end: endUv }, forward },
      { trace: { kind: 'straight', start: endPoint, end: anchorPoint }, forward },
      { trace: { kind: 'straight', start: anchorPoint, end: startPoint }, forward },
    ] };
}

/** Exact planar endpoint triangle; the same formulas determine both bounds and cancellable traces. */
export function boundAnalyticEndpointTriangle(anchor: CertificatePoint3, startPoint: AnalyticEndpoint,
  endPoint: AnalyticEndpoint, forward: boolean, budget: AnalyticCellBudget): AnalyticEndpointPatchBound {
  budget.consume();
  const start = analyticEndpointInterval(startPoint), end = analyticEndpointInterval(endPoint);
  const a: AnalyticIntervalPoint3 = [intervalPoint(anchor[0]), intervalPoint(anchor[1]), intervalPoint(anchor[2])];
  const flux = intervalDividePositive(intervalDeterminant(a, start, end), 6);
  let anchorRadiusMm = 0;
  for (const point of [start, end]) {
    let radius = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const offset = intervalAdd(point[axis], intervalNegate(a[axis]));
      radius = addUpper(radius, Math.max(Math.abs(offset[0]), Math.abs(offset[1])));
    }
    anchorRadiusMm = Math.max(anchorRadiusMm, radius);
  }
  const anchorPoint: AnalyticEndpoint = { kind: 'point', value: anchor };
  return { closed: false, fluxIntervalMm3: forward ? flux : intervalNegate(flux), anchorRadiusMm, anchor, start, end,
    boundary: [
      { trace: { kind: 'straight', start: startPoint, end: endPoint }, forward },
      { trace: { kind: 'straight', start: endPoint, end: anchorPoint }, forward },
      { trace: { kind: 'straight', start: anchorPoint, end: startPoint }, forward },
    ] };
}

/** Exact formula descriptors. Interval overlap and native IDs alone are deliberately not identities. */
export type AnalyticUvEndpoint =
  | { readonly kind: 'uv'; readonly value: UvPoint }
  | { readonly kind: 'pcurve'; readonly curve: AnalyticCurveGeometry; readonly parameter: number };

export type AnalyticEndpoint =
  | { readonly kind: 'point'; readonly value: CertificatePoint3 }
  | { readonly kind: 'curve'; readonly curve: AnalyticCurveGeometry; readonly parameter: number }
  | { readonly kind: 'surface'; readonly geometry: AnalyticSurfaceGeometry; readonly uv: AnalyticUvEndpoint };

export type AnalyticConnectorTrace =
  | { readonly kind: 'straight'; readonly start: AnalyticEndpoint; readonly end: AnalyticEndpoint }
  | { readonly kind: 'surface'; readonly geometry: AnalyticSurfaceGeometry;
    readonly start: AnalyticUvEndpoint; readonly end: AnalyticUvEndpoint };

function analyticEndpointInterval(point: AnalyticEndpoint): AnalyticIntervalPoint3 {
  if (point.kind === 'point') return [intervalPoint(point.value[0]), intervalPoint(point.value[1]), intervalPoint(point.value[2])];
  if (point.kind === 'curve') return analyticCurveInterval(point.curve, intervalPoint(point.parameter));
  const uv = point.uv.kind === 'uv'
    ? [intervalPoint(point.uv.value[0]), intervalPoint(point.uv.value[1]), [0, 0] as const] as const
    : analyticCurveInterval(point.uv.curve, intervalPoint(point.uv.parameter));
  if (uv[2][0] !== 0 || uv[2][1] !== 0) throw new Error('analytic-certificate: endpoint pcurve is not two dimensional');
  return analyticSurfaceInterval(point.geometry, uv[0], uv[1]);
}

function connectorNumbers(values: readonly number[], length: number): readonly number[] {
  if (values.length !== length) throw new Error('analytic-certificate: invalid connector coefficient count');
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(values, index) || !Number.isFinite(values[index])) {
      throw new Error('analytic-certificate: nonfinite or sparse connector coefficient');
    }
  }
  return values;
}

function connectorTransform(transform: AnalyticAffine | undefined): readonly (readonly number[])[] | null {
  if (transform === undefined) return null;
  if (transform.length !== 3) throw new Error('analytic-certificate: invalid connector transform');
  return [connectorNumbers(transform[0], 4), connectorNumbers(transform[1], 4), connectorNumbers(transform[2], 4)];
}

function connectorCurveKey(curve: AnalyticCurveGeometry): string {
  const origin = connectorNumbers(curve.origin, 3), transform = connectorTransform(curve.transform);
  if (curve.kind === 'line') return JSON.stringify(['line', origin, connectorNumbers(curve.direction, 3), transform]);
  if (curve.kind !== 'conic') throw new Error('analytic-certificate: unsupported connector curve');
  return JSON.stringify(['conic', origin, connectorNumbers(curve.x, 3), connectorNumbers(curve.y, 3),
    positive(curve.major, 'connector major radius'), positive(curve.minor, 'connector minor radius'), transform]);
}

function connectorSurfaceKey(geometry: AnalyticSurfaceGeometry): string {
  const { surface, frame } = geometry;
  if (surface.scale !== 1) throw new Error('analytic-certificate: connector requires local unscaled surface');
  let shape: readonly (number | string)[];
  switch (surface.kind) {
    case 'plane': shape = ['plane']; break;
    case 'cylinder': shape = ['cylinder', positive(surface.radius, 'connector cylinder radius')]; break;
    case 'sphere': shape = ['sphere', positive(surface.radius, 'connector sphere radius')]; break;
    case 'cone': {
      const angle = geometry.coneSemiAngle;
      if (angle === null || !Number.isFinite(angle) || angle === 0 || Math.abs(angle) >= Math.PI / 2) {
        throw new Error('analytic-certificate: invalid connector cone angle');
      }
      shape = ['cone', nonnegative(surface.referenceRadius, 'connector cone radius'), angle]; break;
    }
    case 'torus': {
      const major = positive(surface.majorRadius, 'connector torus major'), minor = positive(surface.minorRadius, 'connector torus minor');
      if (!(major > minor)) throw new Error('analytic-certificate: nonregular connector torus');
      shape = ['torus', major, minor]; break;
    }
    default: throw new Error('analytic-certificate: unsupported connector surface');
  }
  return JSON.stringify([shape, connectorNumbers(frame.origin, 3), connectorNumbers(frame.x, 3),
    connectorNumbers(frame.y, 3), connectorNumbers(frame.z, 3), connectorTransform(geometry.transform)]);
}

function connectorUvKey(point: AnalyticUvEndpoint): string {
  if (point.kind === 'uv') return JSON.stringify(['uv', connectorNumbers(point.value, 2)]);
  if (point.kind !== 'pcurve' || !Number.isFinite(point.parameter)) throw new Error('analytic-certificate: invalid connector UV endpoint');
  return JSON.stringify(['pcurve', connectorCurveKey(point.curve), point.parameter]);
}

function connectorPointKey(point: AnalyticEndpoint): string {
  if (point.kind === 'point') return JSON.stringify(['point', connectorNumbers(point.value, 3)]);
  if (point.kind === 'surface') return JSON.stringify(['surface', connectorSurfaceKey(point.geometry), connectorUvKey(point.uv)]);
  if (point.kind !== 'curve' || !Number.isFinite(point.parameter)) throw new Error('analytic-certificate: invalid connector endpoint');
  return JSON.stringify(['curve', connectorCurveKey(point.curve), point.parameter]);
}

/**
 * Cancel a supplied connector chain by EXACT formula identity and opposite parameterization. Field insertion
 * order is irrelevant; coefficients, location and parameters are not. Equivalent but differently represented
 * formulas are conservatively unresolved. The caller still must prove completeness and bind every descriptor
 * to its actual patch/native source: this ledger is not a global closed-surface certificate.
 */
export function auditAnalyticConnectorCancellation(uses: readonly {
  readonly occurrence: number; readonly trace: AnalyticConnectorTrace; readonly forward: boolean;
}[], checkpoint: () => void): {
  readonly algebraicallyCancelled: true; readonly geometricallyClosed: false;
  readonly pairs: readonly (readonly [number, number])[]; readonly constantOccurrences: readonly number[];
} {
  checkpoint();
  if (uses.length === 0 || uses.length > 12288) throw new Error('analytic-certificate: connector ledger budget');
  const groups = new Map<string, { occurrence: number; positive: boolean }[]>();
  const occurrences = new Set<number>(), constantOccurrences: number[] = [];
  for (let index = 0; index < uses.length; index += 1) {
    checkpoint();
    if (!Object.hasOwn(uses, index)) throw new Error('analytic-certificate: sparse connector ledger');
    const { occurrence, trace, forward } = uses[index];
    if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrences.has(occurrence) || typeof forward !== 'boolean') {
      throw new Error('analytic-certificate: repeated or invalid connector occurrence');
    }
    occurrences.add(occurrence);
    let from: string, to: string, kind: string;
    if (trace.kind === 'straight') {
      from = connectorPointKey(trace.start); to = connectorPointKey(trace.end); kind = 'straight';
    } else if (trace.kind === 'surface') {
      from = connectorUvKey(trace.start); to = connectorUvKey(trace.end);
      kind = connectorSurfaceKey(trace.geometry);
    } else throw new Error('analytic-certificate: unsupported connector trace');
    // Only identical endpoint FORMULAS make either admitted connector constant for every parameter.
    if (from === to) { constantOccurrences.push(occurrence); continue; }
    const increasing = from < to;
    const key = JSON.stringify([trace.kind, kind, increasing ? from : to, increasing ? to : from]);
    const group = groups.get(key) ?? [];
    group.push({ occurrence, positive: increasing === forward });
    if (group.length > 2) throw new Error('analytic-certificate: repeated connector trace');
    groups.set(key, group);
  }
  const pairs: [number, number][] = [];
  for (const group of groups.values()) {
    if (group.length !== 2 || group[0].positive === group[1].positive) {
      throw new Error('analytic-certificate: uncancelled connector trace');
    }
    pairs.push([group[0].occurrence, group[1].occurrence]);
  }
  checkpoint();
  return { algebraicallyCancelled: true, geometricallyClosed: false, pairs, constantOccurrences };
}

function curveDerivativeBounds(curve: AnalyticCurveGeometry): { first: CertificatePoint3; second: CertificatePoint3 } {
  const first: [number, number, number] = [0, 0, 0], second: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    if (curve.kind === 'line') first[axis] = nonnegative(Math.abs(curve.direction[axis]), 'curve direction');
    else {
      const bound = addUpper(multiplyUpper(positive(curve.major, 'curve major'), Math.abs(curve.x[axis])),
        multiplyUpper(positive(curve.minor, 'curve minor'), Math.abs(curve.y[axis])));
      first[axis] = second[axis] = nonnegative(bound, 'conic derivative');
    }
  }
  if (curve.transform === undefined) return { first, second };
  const transform = curve.transform;
  const bound = (vector: CertificatePoint3): CertificatePoint3 => {
    const row = (index: number): number => addUpper(addUpper(
      multiplyUpper(Math.abs(transform[index][0]), vector[0]),
      multiplyUpper(Math.abs(transform[index][1]), vector[1])),
    multiplyUpper(Math.abs(transform[index][2]), vector[2]));
    return [row(0), row(1), row(2)];
  };
  return { first: bound(first), second: bound(second) };
}

function nativePoint3(point: { X(): number; Y(): number; Z(): number }): CertificatePoint3 {
  const value: CertificatePoint3 = [point.X(), point.Y(), point.Z()];
  for (const coordinate of value) if (!Number.isFinite(coordinate)) {
    throw new Error('analytic-certificate: nonfinite primitive coordinate');
  }
  return value;
}

function nativePoint2(point: { X(): number; Y(): number }): CertificatePoint3 {
  const value: CertificatePoint3 = [point.X(), point.Y(), 0];
  for (const coordinate of value) if (!Number.isFinite(coordinate)) {
    throw new Error('analytic-certificate: nonfinite pcurve coordinate');
  }
  return value;
}

function nativeFrame(axis: gp_Ax2 | gp_Ax3, owned: Allocations): AnalyticFrame {
  return { origin: nativePoint3(owned.keep(axis.Location())), x: nativePoint3(owned.keep(axis.XDirection())),
    y: nativePoint3(owned.keep(axis.YDirection())), z: nativePoint3(owned.keep(axis.Direction())) };
}

function nativeAffine(transform: gp_Trsf): AnalyticAffine {
  const row = (index: number): readonly [number, number, number, number] => {
    const values: [number, number, number, number] = [transform.Value(index, 1), transform.Value(index, 2),
      transform.Value(index, 3), transform.Value(index, 4)];
    for (const value of values) if (!Number.isFinite(value)) throw new Error('analytic-certificate: nonfinite location');
    return values;
  };
  return [row(1), row(2), row(3)];
}

/** Match native Value(U,V): evaluate the LOCAL primitive, then apply the complete location once. */
export function readAnalyticSurfaceGeometry(oc: OpenCascadeInstance, face: TopoDS_Face,
  owned: Allocations): AnalyticSurfaceGeometry {
  const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(face, true));
  const local = owned.keep(adaptor.Surface());
  const transform = nativeAffine(owned.keep(adaptor.Trsf()));
  const type = adaptor.GetType();
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    const primitive = owned.keep(local.Plane());
    return { surface: { kind: 'plane', scale: 1 }, frame: nativeFrame(owned.keep(primitive.Position()), owned), coneSemiAngle: null, transform };
  }
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const primitive = owned.keep(local.Cylinder());
    return { surface: { kind: 'cylinder', radius: positive(primitive.Radius(), 'cylinder radius'), scale: 1 },
      frame: nativeFrame(owned.keep(primitive.Position()), owned), coneSemiAngle: null, transform };
  }
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
    const primitive = owned.keep(local.Cone());
    const angle = primitive.SemiAngle();
    if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) >= Math.PI / 2) {
      throw new Error('analytic-certificate: invalid cone angle');
    }
    return { surface: { kind: 'cone', referenceRadius: nonnegative(primitive.RefRadius(), 'cone radius'), scale: 1 },
      frame: nativeFrame(owned.keep(primitive.Position()), owned), coneSemiAngle: angle, transform };
  }
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
    const primitive = owned.keep(local.Sphere());
    return { surface: { kind: 'sphere', radius: positive(primitive.Radius(), 'sphere radius'), scale: 1 },
      frame: nativeFrame(owned.keep(primitive.Position()), owned), coneSemiAngle: null, transform };
  }
  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
    const primitive = owned.keep(local.Torus());
    const majorRadius = positive(primitive.MajorRadius(), 'torus major radius');
    const minorRadius = positive(primitive.MinorRadius(), 'torus minor radius');
    if (!(majorRadius > minorRadius)) throw new Error('analytic-certificate: nonregular torus');
    return { surface: { kind: 'torus', majorRadius, minorRadius, scale: 1 },
      frame: nativeFrame(owned.keep(primitive.Position()), owned), coneSemiAngle: null, transform };
  }
  throw new Error('analytic-certificate: unsupported surface type');
}

export interface AnalyticNativeCurvePair {
  readonly curve: AnalyticCurveGeometry;
  readonly pcurve: AnalyticCurveGeometry;
  readonly first: number;
  readonly last: number;
}

export interface AnalyticCellBudget {
  consume(): void;
  used(): number;
}

/** One shared budget for the complete certificate attempt, not a new allowance for each edge or face. */
export function createAnalyticCellBudget(triangleCount: number, checkpoint: () => void): AnalyticCellBudget {
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || triangleCount > 2048) {
    throw new Error('analytic-certificate: invalid cell budget');
  }
  let used = 0;
  return {
    consume(): void {
      checkpoint();
      if (used >= 32 * triangleCount) throw new Error('analytic-certificate: certificate-limit');
      used += 1;
    },
    used: () => used,
  };
}

/** Complete native parameter coverage, with a fixed finite subdivision charged to the shared budget. */
export function boundAnalyticNativeCurvePair(pair: AnalyticNativeCurvePair, geometry: AnalyticSurfaceGeometry,
  parameters: readonly number[], subdivisions: number, budget: AnalyticCellBudget): number {
  if (!Number.isSafeInteger(subdivisions) || subdivisions < 1 || subdivisions > 32
    || parameters.length < 2 || parameters.length > 1025
    || parameters[0] !== pair.first || parameters[parameters.length - 1] !== pair.last) {
    throw new Error('analytic-certificate: incomplete paired curve coverage or subdivision limit');
  }
  let maximum = 0;
  for (let index = 0; index < parameters.length - 1; index += 1) {
    if (!Object.hasOwn(parameters, index) || !Object.hasOwn(parameters, index + 1)) {
      throw new Error('analytic-certificate: sparse paired parameters');
    }
    const first = parameters[index], last = parameters[index + 1];
    if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)) {
      throw new Error('analytic-certificate: invalid paired parameters');
    }
    let start = first;
    for (let cell = 1; cell <= subdivisions; cell += 1) {
      const end = cell === subdivisions ? last : first + (last - first) * (cell / subdivisions);
      if (!(start < end) || end > last) throw new Error('analytic-certificate: unresolved paired interval');
      budget.consume();
      maximum = Math.max(maximum, analyticPairedCurveGapBound(pair.curve, pair.pcurve, geometry, start, end));
      start = end;
    }
  }
  return maximum;
}

/** Native coefficients of an actual shared 3D edge and one oriented face-side pcurve. */
export function readAnalyticNativeCurvePair(oc: OpenCascadeInstance, edge: TopoDS_Edge, face: TopoDS_Face,
  owned: Allocations): AnalyticNativeCurvePair {
  const curve = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
  const pcurve = owned.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
  if (!curve.Is3DCurve()) throw new Error('analytic-certificate: missing analytic 3D edge representation');
  const local = owned.keep(curve.Curve());
  const transform = nativeAffine(owned.keep(curve.Trsf()));
  const first = curve.FirstParameter(), last = curve.LastParameter();
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)
    || pcurve.FirstParameter() !== first || pcurve.LastParameter() !== last) {
    throw new Error('analytic-certificate: mismatched edge and pcurve parameter ranges');
  }
  let curveGeometry: AnalyticCurveGeometry, pcurveGeometry: AnalyticCurveGeometry;
  const type = curve.GetType();
  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
    const primitive = owned.keep(local.Line());
    curveGeometry = { kind: 'line', origin: nativePoint3(owned.keep(primitive.Location())),
      direction: nativePoint3(owned.keep(primitive.Direction())), transform };
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle || type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
    const primitive = owned.keep(type === oc.GeomAbs_CurveType.GeomAbs_Circle ? local.Circle() : local.Ellipse());
    const frame = nativeFrame(owned.keep(primitive.Position()), owned);
    const major = 'Radius' in primitive ? primitive.Radius() : primitive.MajorRadius();
    const minor = 'Radius' in primitive ? primitive.Radius() : primitive.MinorRadius();
    curveGeometry = { kind: 'conic', origin: frame.origin, x: frame.x, y: frame.y,
      major: positive(major, 'edge major radius'), minor: positive(minor, 'edge minor radius'), transform };
  } else throw new Error('analytic-certificate: unsupported 3D edge curve');
  const ptype = pcurve.GetType();
  if (ptype === oc.GeomAbs_CurveType.GeomAbs_Line) {
    const primitive = owned.keep(pcurve.Line());
    pcurveGeometry = { kind: 'line', origin: nativePoint2(owned.keep(primitive.Location())),
      direction: nativePoint2(owned.keep(primitive.Direction())) };
  } else if (ptype === oc.GeomAbs_CurveType.GeomAbs_Circle || ptype === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
    const primitive = owned.keep(ptype === oc.GeomAbs_CurveType.GeomAbs_Circle ? pcurve.Circle() : pcurve.Ellipse());
    const major = 'Radius' in primitive ? primitive.Radius() : primitive.MajorRadius();
    const minor = 'Radius' in primitive ? primitive.Radius() : primitive.MinorRadius();
    pcurveGeometry = { kind: 'conic', origin: nativePoint2(owned.keep(primitive.Location())),
      x: nativePoint2(owned.keep(owned.keep(primitive.XAxis()).Direction())),
      y: nativePoint2(owned.keep(owned.keep(primitive.YAxis()).Direction())),
      major: positive(major, 'pcurve major radius'), minor: positive(minor, 'pcurve minor radius') };
  } else throw new Error('analytic-certificate: unsupported pcurve');
  return { curve: curveGeometry, pcurve: pcurveGeometry, first, last };
}

/** Entire same-parameter curve discrepancy: endpoint enclosure + ||difference''|| * h^2/8. */
export function analyticPairedCurveGapBound(curve: AnalyticCurveGeometry, pcurve: AnalyticCurveGeometry,
  geometry: AnalyticSurfaceGeometry, first: number, last: number): number {
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)) {
    throw new Error('analytic-certificate: invalid paired curve range');
  }
  const uv = analyticCurveInterval(pcurve, [first, last]);
  if (uv[2][0] !== 0 || uv[2][1] !== 0) throw new Error('analytic-certificate: pcurve is not two dimensional');
  const base = analyticDerivativeBounds(geometry.surface, uv[1][0], uv[1][1]);
  // Explicit component axes avoid silently treating stored floating directions as perfectly orthonormal.
  let locationFactor = 1;
  if (geometry.transform !== undefined) {
    const matrix = geometry.transform;
    locationFactor = Math.max(...[0, 1, 2].map(column => addUpper(addUpper(
      Math.abs(matrix[0][column]), Math.abs(matrix[1][column])), Math.abs(matrix[2][column]))));
  }
  const frameFactor = multiplyUpper(locationFactor,
    addUpper(addUpper(l1Upper(geometry.frame.x), l1Upper(geometry.frame.y)), l1Upper(geometry.frame.z)));
  const p = curveDerivativeBounds(pcurve), c = curveDerivativeBounds(curve);
  const surfaceSecond = multiplyUpper(frameFactor, addUpper(addUpper(
    multiplyUpper(base.uu, multiplyUpper(p.first[0], p.first[0])),
    multiplyUpper(2, multiplyUpper(base.uv, multiplyUpper(p.first[0], p.first[1])))), addUpper(
    multiplyUpper(base.vv, multiplyUpper(p.first[1], p.first[1])), addUpper(
      multiplyUpper(base.u, p.second[0]), multiplyUpper(base.v, p.second[1])))));
  const second = addUpper(l1Upper(c.second), surfaceSecond);
  const endpoint = (parameter: number): number => {
    const a = analyticCurveInterval(curve, [parameter, parameter]);
    const p = analyticCurveInterval(pcurve, [parameter, parameter]);
    const b = analyticSurfaceInterval(geometry, p[0], p[1]);
    let distance = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const difference = intervalAdd(a[axis], intervalNegate(b[axis]));
      distance = addUpper(distance, Math.max(Math.abs(difference[0]), Math.abs(difference[1])));
    }
    return distance;
  };
  return addUpper(Math.max(endpoint(first), endpoint(last)), trimChordDeviationBound(second, first, last));
}

/**
 * OCCT analytic parameterizations have orthonormal axes. Radius values here are LOCAL to GeomAdaptor_Surface;
 * the separate absolute location scale multiplies all derivatives exactly once. Cone V is slant length.
 * Using |sin(angle)| <= 1 avoids an unjustified floating transcendental enclosure.
 */
export function analyticDerivativeBounds(surface: AnalyticSurfaceParameters,
  minimumV: number, maximumV: number): AnalyticDerivativeBounds {
  const scale = positive(surface.scale, 'location scale');
  if (!Number.isFinite(minimumV) || !Number.isFinite(maximumV) || minimumV > maximumV) {
    throw new Error('analytic-certificate: invalid V interval');
  }
  let bounds: AnalyticDerivativeBounds;
  switch (surface.kind) {
    case 'plane': bounds = { u: 1, v: 1, uu: 0, uv: 0, vv: 0 }; break;
    case 'cylinder': {
      const radius = positive(surface.radius, 'cylinder radius');
      bounds = { u: radius, v: 1, uu: radius, uv: 0, vv: 0 };
      break;
    }
    case 'cone': {
      const radius = nonnegative(surface.referenceRadius, 'cone reference radius');
      const radialBound = addUpper(radius, Math.max(Math.abs(minimumV), Math.abs(maximumV)));
      bounds = { u: radialBound, v: 1, uu: radialBound, uv: 1, vv: 0 };
      break;
    }
    case 'sphere': {
      const radius = positive(surface.radius, 'sphere radius');
      bounds = { u: radius, v: radius, uu: radius, uv: radius, vv: radius };
      break;
    }
    case 'torus': {
      const major = positive(surface.majorRadius, 'torus major radius');
      const minor = positive(surface.minorRadius, 'torus minor radius');
      if (!(major > minor)) throw new Error('analytic-certificate: nonregular torus');
      const radialBound = addUpper(major, minor);
      bounds = { u: radialBound, v: minor, uu: radialBound, uv: minor, vv: minor };
      break;
    }
  }
  return {
    u: multiplyUpper(bounds.u, scale), v: multiplyUpper(bounds.v, scale),
    uu: multiplyUpper(bounds.uu, scale), uv: multiplyUpper(bounds.uv, scale), vv: multiplyUpper(bounds.vv, scale),
  };
}

/**
 * Taylor integral remainder on the convex UV triangle: each vertex displacement is bounded by its UV spans.
 * Linear terms cancel under barycentric interpolation. This is deliberately conservative, continuous, and
 * independent of a sample grid. endpointErrorMm must itself be a proved bound, not observed native roundoff.
 */
export function analyticTriangleDistanceBound(surface: AnalyticSurfaceParameters, triangle: UvTriangle,
  endpointErrorMm: number, nativeToleranceMm: number): number {
  nonnegative(endpointErrorMm, 'endpoint error');
  nonnegative(nativeToleranceMm, 'native tolerance');
  const us = triangle.map(point => point[0]), vs = triangle.map(point => point[1]);
  const du = spanUpper(us), dv = spanUpper(vs);
  const hessian = analyticDerivativeBounds(surface, Math.min(...vs), Math.max(...vs));
  const uu = multiplyUpper(hessian.uu, multiplyUpper(du, du));
  const uv = multiplyUpper(2, multiplyUpper(hessian.uv, multiplyUpper(du, dv)));
  const vv = multiplyUpper(hessian.vv, multiplyUpper(dv, dv));
  const remainder = multiplyUpper(0.5, addUpper(addUpper(uu, uv), vv));
  return addUpper(addUpper(remainder, endpointErrorMm), nativeToleranceMm);
}

/**
 * Swept volume of ONE complete parameter triangle under H=(1-t)L+t*S. Reparameterize D onto the unit
 * simplex (area 1/2). Bound det(H_t,H_xi,H_eta) by the product of norms and integrate over t in [0,1].
 * This is a chain integral bound even if the homotopy folds. It does not prove trimming, global degree,
 * absence of nearby-sheet crossings, or native edge gap closure. Those are separate admission conditions.
 */
export function analyticTriangleSweptVolumeBound(surface: AnalyticSurfaceParameters, uv: UvTriangle,
  plc: readonly [CertificatePoint3, CertificatePoint3, CertificatePoint3], endpointErrorMm: number): number {
  const distance = analyticTriangleDistanceBound(surface, uv, endpointErrorMm, 0);
  const bounds = analyticDerivativeBounds(surface, Math.min(...uv.map(point => point[1])),
    Math.max(...uv.map(point => point[1])));
  const delta = (a: number, b: number): number => spanUpper([a, b]);
  const surfaceXi = addUpper(multiplyUpper(bounds.u, delta(uv[1][0], uv[0][0])),
    multiplyUpper(bounds.v, delta(uv[1][1], uv[0][1])));
  const surfaceEta = addUpper(multiplyUpper(bounds.u, delta(uv[2][0], uv[0][0])),
    multiplyUpper(bounds.v, delta(uv[2][1], uv[0][1])));
  const l1Edge = (end: CertificatePoint3): number => addUpper(addUpper(delta(end[0], plc[0][0]),
    delta(end[1], plc[0][1])), delta(end[2], plc[0][2]));
  const xi = Math.max(surfaceXi, l1Edge(plc[1]));
  const eta = Math.max(surfaceEta, l1Edge(plc[2]));
  return multiplyUpper(0.5, multiplyUpper(distance, multiplyUpper(xi, eta)));
}

/** Peano kernel bound for a complete parameter interval, not just its midpoint: M*(last-first)^2/8. */
export function trimChordDeviationBound(secondDerivativeBound: number, first: number, last: number): number {
  nonnegative(secondDerivativeBound, 'trim second derivative');
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)) {
    throw new Error('analytic-certificate: invalid trim interval');
  }
  const span = finiteUpper(nextUpper(last - first));
  return multiplyUpper(0.125, multiplyUpper(secondDerivativeBound, multiplyUpper(span, span)));
}

interface AnalyticPolygonRepresentation {
  readonly localNodes: readonly number[];
  readonly parameters: readonly number[];
  readonly uvNodes: readonly UvPoint[];
}

/** Associate stored seam polygons with the unchanged native occurrence pcurve, never by proximity or slot. */
export function selectAnalyticSeamPolygon(candidates: readonly AnalyticPolygonRepresentation[],
  trim: Pick<AnalyticTrimChain, 'parameters' | 'uvNodes'>): AnalyticPolygonRepresentation {
  if (candidates.length !== 2 || trim.parameters.length < 2 || trim.uvNodes.length !== trim.parameters.length) {
    throw new Error('analytic-certificate: invalid seam representation inventory');
  }
  const matches: AnalyticPolygonRepresentation[] = [];
  for (const candidate of candidates) {
    if (candidate.localNodes.length !== trim.parameters.length || candidate.parameters.length !== trim.parameters.length
      || candidate.uvNodes.length !== trim.parameters.length) continue;
    let matchesTrim = true;
    for (let index = 0; index < trim.parameters.length; index += 1) {
      const parameter = trim.parameters[index], expected = trim.uvNodes[index], actual = candidate.uvNodes[index];
      if (!Number.isFinite(parameter) || (index > 0 && !(trim.parameters[index - 1] < parameter))
        || expected === undefined || actual === undefined || expected.length !== 2 || actual.length !== 2
        || !Number.isFinite(expected[0]) || !Number.isFinite(expected[1])
        || !Number.isSafeInteger(candidate.localNodes[index]) || candidate.localNodes[index] < 0
        || candidate.parameters[index] !== parameter || actual[0] !== expected[0] || actual[1] !== expected[1]) {
        matchesTrim = false;
        break;
      }
    }
    if (matchesTrim) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error('analytic-certificate: ambiguous or unmatched seam representation');
  return matches[0];
}

/**
 * Read every oriented wire occurrence, not an unordered map of unique edges. A seam appears twice with
 * different pcurves; stored polygon slots are independently matched to that actual UV side. The wire explorer
 * can stop at malformed branching, so its occurrences must bijectively match the independent direct-child
 * enumeration. No skipped occurrence, coordinate welding, or nearest-period choice is accepted.
 * Native allocations remain in the caller's bounded face scope, including failure paths.
 */
export function readAnalyticWireChains(oc: OpenCascadeInstance, face: TopoDS_Face,
  triangulation: Handle_Poly_Triangulation, location: TopLoc_Location, nodeCount: number,
  owned: Allocations, checkpoint: () => void, identities?: AnalyticNativeIdentityMaps): readonly AnalyticWireChain[] {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 3 || nodeCount > 1024) {
    throw new Error('analytic-certificate: wire node budget');
  }
  const materialOrientation = face.Orientation_1();
  if (materialOrientation !== oc.TopAbs_Orientation.TopAbs_FORWARD
    && materialOrientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
    throw new Error('analytic-certificate: unsupported material face orientation');
  }
  // Generated enum constants are typed as {}; preserve the checked native orientation without a cast.
  const forwardShape = materialOrientation === oc.TopAbs_Orientation.TopAbs_FORWARD ? face : owned.keep(face.Reversed());
  const forwardFace = owned.keep(oc.TopoDS.Face_1(forwardShape));
  const wires = owned.keep(new oc.TopoDS_Iterator_2(forwardFace, true, true));
  const result: AnalyticWireChain[] = [];
  let occurrenceCount = 0, polygonNodeCount = 0;
  while (wires.More()) {
    checkpoint();
    const member = owned.keep(wires.Value());
    if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_WIRE) {
      throw new Error('analytic-certificate: non-wire face member');
    }
    const wire = owned.keep(oc.TopoDS.Wire_1(member));
    const direct = owned.keep(new oc.TopoDS_Iterator_2(wire, true, true));
    const occurrences: TopoDS_Edge[] = [];
    while (direct.More()) {
      if (++occurrenceCount > 6144) throw new Error('analytic-certificate: wire occurrence budget');
      const child = owned.keep(direct.Value());
      if (child.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
        throw new Error('analytic-certificate: non-edge wire member');
      }
      occurrences.push(owned.keep(oc.TopoDS.Edge_1(child)));
      direct.Next();
    }
    const visited = new Set<number>();
    const explorer = owned.keep(new oc.BRepTools_WireExplorer_3(wire, forwardFace));
    const localNodes: number[] = [];
    const segments: AnalyticWireChain['segments'][number][] = [];
    while (explorer.More()) {
      checkpoint();
      const edge = owned.keep(explorer.Current());
      const matches = occurrences.flatMap((item, index) => item.IsEqual(edge) ? [index] : []);
      if (matches.length !== 1 || visited.has(matches[0])) {
        throw new Error('analytic-certificate: ambiguous or repeated wire occurrence');
      }
      visited.add(matches[0]);
      const orientation = edge.Orientation_1();
      const forward = orientation === oc.TopAbs_Orientation.TopAbs_FORWARD;
      if (!forward && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
        throw new Error('analytic-certificate: unsupported wire orientation');
      }
      const handle = owned.keep(oc.BRep_Tool.PolygonOnTriangulation_1(edge, triangulation, location));
      if (handle.IsNull()) throw new Error('analytic-certificate: missing native trim polygon');
      const polygon = handle.get();
      const count = Number(polygon.NbNodes());
      if (!polygon.HasParameters() || !Number.isSafeInteger(count) || count < 2 || count > nodeCount + 1) {
        throw new Error('analytic-certificate: invalid native trim polygon');
      }
      polygonNodeCount += count;
      if (polygonNodeCount > 12288) throw new Error('analytic-certificate: trim polygon budget');
      let indices: number[] = [];
      const parameters: number[] = [];
      for (let index = 1; index <= count; index += 1) {
        const local = Number(polygon.Node(index)) - 1;
        if (!Number.isSafeInteger(local) || local < 0 || local >= nodeCount) {
          throw new Error('analytic-certificate: native trim index');
        }
        indices.push(local);
        parameters.push(polygon.Parameter(index));
      }
      const trim = readAnalyticTrimChain(oc, edge, forwardFace, segments.length, parameters, nodeCount + 1, owned);
      if (oc.BRep_Tool.IsClosed_2(edge, forwardFace)) {
        const opposite = owned.keep(oc.TopoDS.Edge_1(owned.keep(edge.Reversed())));
        const otherHandle = owned.keep(oc.BRep_Tool.PolygonOnTriangulation_1(opposite, triangulation, location));
        if (otherHandle.IsNull()) throw new Error('analytic-certificate: missing opposite seam polygon');
        const other = otherHandle.get(), otherCount = Number(other.NbNodes());
        if (!other.HasParameters() || !Number.isSafeInteger(otherCount) || otherCount < 2 || otherCount > nodeCount + 1) {
          throw new Error('analytic-certificate: invalid opposite seam polygon');
        }
        polygonNodeCount += otherCount;
        if (polygonNodeCount > 12288) throw new Error('analytic-certificate: trim polygon budget');
        const otherIndices: number[] = [], otherParameters: number[] = [];
        for (let index = 1; index <= otherCount; index += 1) {
          checkpoint();
          const local = Number(other.Node(index)) - 1;
          if (!Number.isSafeInteger(local) || local < 0 || local >= nodeCount) {
            throw new Error('analytic-certificate: native trim index');
          }
          otherIndices.push(local);
          otherParameters.push(other.Parameter(index));
        }
        const readUv = (nodes: readonly number[]): UvPoint[] => nodes.map(local => {
          checkpoint();
          const point = triangulation.get().UVNode(local + 1);
          try { return [point.X(), point.Y()] as const; } finally { point.delete(); }
        });
        indices = [...selectAnalyticSeamPolygon([
          { localNodes: indices, parameters, uvNodes: readUv(indices) },
          { localNodes: otherIndices, parameters: otherParameters, uvNodes: readUv(otherIndices) },
        ], trim).localNodes];
      }
      const ordered = forward ? indices : [...indices].reverse();
      if (localNodes.length > 0 && localNodes[localNodes.length - 1] !== ordered[0]) {
        // Root-only diagnosis of the retained native failure. Do not weld nodes, switch sides or retry.
        // A diagnostic native failure is recorded separately and cannot replace this primary refusal.
        try {
          const uv = (local: number): readonly [number, number] => {
            const point = owned.keep(triangulation.get().UVNode(local + 1));
            return [point.X(), point.Y()];
          };
          const opposite = owned.keep(oc.TopoDS.Edge_1(owned.keep(edge.Reversed())));
          const otherHandle = owned.keep(oc.BRep_Tool.PolygonOnTriangulation_1(opposite, triangulation, location));
          const otherNodes: number[] = [], otherParameters: number[] = [];
          if (!otherHandle.IsNull()) {
            const other = otherHandle.get(), otherCount = Number(other.NbNodes());
            if (!Number.isSafeInteger(otherCount) || otherCount < 2 || otherCount > nodeCount + 1) {
              throw new Error('diagnostic polygon count outside original bound');
            }
            for (let i = 1; i <= otherCount; i += 1) {
              otherNodes.push(Number(other.Node(i)) - 1);
              if (other.HasParameters()) otherParameters.push(other.Parameter(i));
            }
          }
          console.error('[analytic-wire-disconnection]', JSON.stringify({
            faceIndex: identities === undefined ? null : identities.faces.FindIndex(face) - 1,
            wireIndex: result.length, segmentIndex: segments.length, forward,
            originalFaceForward: materialOrientation === oc.TopAbs_Orientation.TopAbs_FORWARD,
            nativeSeam: oc.BRep_Tool.IsClosed_2(edge, forwardFace),
            previous: segments.map(segment => ({ forward: segment.forward,
              nodes: segment.localNodes, parameters: segment.trim.parameters })),
            orderedWire: localNodes, indices, parameters, otherNodes, otherParameters,
            trimFirstUv: trim.uvNodes[0], trimLastUv: trim.uvNodes[trim.uvNodes.length - 1],
            previousEnd: localNodes[localNodes.length - 1], currentStart: ordered[0],
            previousEndUv: uv(localNodes[localNodes.length - 1]), currentStartUv: uv(ordered[0]),
          }));
        } catch (diagnosticError) {
          console.error('[analytic-wire-disconnection-diagnostic-error]', diagnosticError instanceof Error
            ? { name: diagnosticError.name, message: diagnosticError.message } : { name: 'NonErrorNativeThrow' });
        }
        throw new Error('analytic-certificate: disconnected native trim polygon');
      }
      localNodes.push(...(localNodes.length === 0 ? ordered : ordered.slice(1)));
      const pair = readAnalyticNativeCurvePair(oc, edge, forwardFace, owned);
      const identity = identities === undefined ? undefined
        : readBoundaryOccurrence(oc, identities, face, edge, result.length, segments.length, pair, forward, owned);
      segments.push({ localNodes: indices, forward, trim, pair, ...(identity === undefined ? {} : { identity }) });
      explorer.Next();
    }
    if (occurrences.length === 0 || visited.size !== occurrences.length) {
      throw new Error('analytic-certificate: incomplete native wire traversal');
    }
    if (localNodes.length < 4 || localNodes[0] !== localNodes[localNodes.length - 1]) {
      throw new Error('analytic-certificate: native wire does not close in its UV lift');
    }
    result.push({ localNodes, segments });
    wires.Next();
  }
  if (result.length === 0) throw new Error('analytic-certificate: missing face wires');
  return result;
}

/**
 * Read the oriented face-side pcurve, retaining the exact SAME parameters as the 3D shared edge chain.
 * The caller owns native objects through its existing per-face allocation scope. A seam is called twice with
 * the two native edge orientations. BRepAdaptor_Curve2d selects the actual pcurve; no UV nearest-neighbour fit.
 */
export function readAnalyticTrimChain(oc: OpenCascadeInstance, edge: TopoDS_Edge, face: TopoDS_Face,
  edgeIndex: number, parameters: readonly number[], maximumNodes: number, owned: Allocations): AnalyticTrimChain {
  if (!Number.isSafeInteger(edgeIndex) || edgeIndex < 0 || !Number.isSafeInteger(maximumNodes)
    || maximumNodes < 2 || parameters.length < 2 || parameters.length > maximumNodes) {
    throw new Error('analytic-certificate: invalid trim identity or node limit');
  }
  const curve = owned.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
  const first = curve.FirstParameter(), last = curve.LastParameter();
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)) {
    throw new Error('analytic-certificate: invalid native trim range');
  }
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    if (!Number.isFinite(parameter) || parameter < first || parameter > last
      || (index > 0 && !(parameters[index - 1] < parameter))) {
      throw new Error('analytic-certificate: trim parameters do not match native range');
    }
  }
  // A truncated chain cannot be called the complete topological edge. Do not silently extend it.
  if (parameters[0] !== first || parameters[parameters.length - 1] !== last) {
    throw new Error('analytic-certificate: incomplete trim parameter coverage');
  }
  const type = curve.GetType();
  let kind: AnalyticTrimChain['kind'];
  let secondDerivativeBoundUv: number;
  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
    kind = 'line';
    secondDerivativeBoundUv = 0;
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle || type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
    const primitive = owned.keep(type === oc.GeomAbs_CurveType.GeomAbs_Circle ? curve.Circle() : curve.Ellipse());
    const x = owned.keep(owned.keep(primitive.XAxis()).Direction());
    const y = owned.keep(owned.keep(primitive.YAxis()).Direction());
    const xNorm = addUpper(Math.abs(x.X()), Math.abs(x.Y()));
    const yNorm = addUpper(Math.abs(y.X()), Math.abs(y.Y()));
    let a: number, b: number;
    if ('Radius' in primitive) {
      kind = 'circle';
      a = positive(primitive.Radius(), 'trim circle radius');
      b = a;
    } else {
      kind = 'ellipse';
      a = positive(primitive.MajorRadius(), 'trim major radius');
      b = positive(primitive.MinorRadius(), 'trim minor radius');
      if (a < b) throw new Error('analytic-certificate: invalid trim ellipse radii');
    }
    // C'' = -a*cos(t)*X - b*sin(t)*Y. L1 bounds avoid assuming computed axes are exactly unit length.
    secondDerivativeBoundUv = addUpper(multiplyUpper(a, nonnegative(xNorm, 'trim X axis')),
      multiplyUpper(b, nonnegative(yNorm, 'trim Y axis')));
  } else throw new Error('analytic-certificate: unsupported trim curve type');
  const uvNodes: UvPoint[] = [];
  for (const parameter of parameters) {
    const point = curve.Value(parameter);
    try {
      const u = point.X(), v = point.Y();
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('analytic-certificate: nonfinite trim UV');
      uvNodes.push([u, v]);
    } finally { point.delete(); }
  }
  const start = owned.keep(oc.TopExp.FirstVertex(edge, false));
  const end = owned.keep(oc.TopExp.LastVertex(edge, false));
  if (start.IsNull() || end.IsNull()) throw new Error('analytic-certificate: missing trim vertex');
  const vertexTolerance = Math.max(nonnegative(oc.BRep_Tool.Tolerance_3(start), 'start vertex tolerance'),
    nonnegative(oc.BRep_Tool.Tolerance_3(end), 'end vertex tolerance'));
  return { edgeIndex, kind, parameters: [...parameters], uvNodes, secondDerivativeBoundUv,
    nativeEdgeToleranceMm: nonnegative(oc.BRep_Tool.Tolerance_2(edge), 'edge tolerance'),
    nativeVertexToleranceMm: vertexTolerance };
}

/** Native extraction only. This does NOT return a certificate or infer trim coverage from UV bounds. */
export function readAnalyticFaceChart(oc: OpenCascadeInstance, face: TopoDS_Face,
  triangulationHandle: Handle_Poly_Triangulation, faceIndex: number, maximumNodes: number,
  maximumTriangles: number): AnalyticFaceChart {
  if (!Number.isSafeInteger(faceIndex) || faceIndex < 0
    || !Number.isSafeInteger(maximumNodes) || maximumNodes <= 0
    || !Number.isSafeInteger(maximumTriangles) || maximumTriangles <= 0) {
    throw new Error('analytic-certificate: invalid extraction budget or face identity');
  }
  const owned = createAllocations();
  let result: AnalyticFaceChart | undefined;
  let primary: Error | undefined;
  try {
    const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(face, true));
    const local = owned.keep(adaptor.Surface());
    const transformation = owned.keep(adaptor.Trsf());
    const scale = positive(Math.abs(transformation.ScaleFactor()), 'location scale');
    const type = adaptor.GetType();
    let surface: AnalyticSurfaceParameters;
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) surface = { kind: 'plane', scale };
    else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      const primitive = owned.keep(local.Cylinder());
      surface = { kind: 'cylinder', radius: primitive.Radius(), scale };
    } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
      const primitive = owned.keep(local.Cone());
      surface = { kind: 'cone', referenceRadius: primitive.RefRadius(), scale };
    } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
      const primitive = owned.keep(local.Sphere());
      surface = { kind: 'sphere', radius: primitive.Radius(), scale };
    } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
      const primitive = owned.keep(local.Torus());
      surface = { kind: 'torus', majorRadius: primitive.MajorRadius(), minorRadius: primitive.MinorRadius(), scale };
    } else throw new Error('analytic-certificate: unsupported surface type');
    const triangulation = triangulationHandle.get();
    if (!triangulation.HasUVNodes()) throw new Error('analytic-certificate: missing UV nodes');
    const count = Number(triangulation.NbNodes());
    if (!Number.isSafeInteger(count) || count <= 0 || count > maximumNodes) {
      throw new Error('analytic-certificate: UV node limit');
    }
    const triangleCount = Number(triangulation.NbTriangles());
    if (!Number.isSafeInteger(triangleCount) || triangleCount <= 0 || triangleCount > maximumTriangles) {
      throw new Error('analytic-certificate: UV triangle limit');
    }
    const uvNodes: UvPoint[] = [];
    let minimumV = Infinity, maximumV = -Infinity;
    for (let index = 1; index <= count; index += 1) {
      const point = triangulation.UVNode(index);
      try {
        const u = point.X(), v = point.Y();
        if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('analytic-certificate: nonfinite native UV');
        uvNodes.push([u, v]);
        minimumV = Math.min(minimumV, v);
        maximumV = Math.max(maximumV, v);
      } finally { point.delete(); }
    }
    const uPeriod = adaptor.IsUPeriodic() ? positive(adaptor.UPeriod(), 'U period') : null;
    const vPeriod = adaptor.IsVPeriodic() ? positive(adaptor.VPeriod(), 'V period') : null;
    const localTriangles: [number, number, number][] = [];
    const nativeTriangles = owned.keep(triangulation.Triangles());
    for (let index = 1; index <= triangleCount; index += 1) {
      const triangle = nativeTriangles.Value(index);
      try {
        const a = Number(triangle.Value(1)) - 1;
        const b = Number(triangle.Value(2)) - 1;
        const c = Number(triangle.Value(3)) - 1;
        for (const node of [a, b, c]) {
          if (!Number.isSafeInteger(node) || node < 0 || node >= count) {
            throw new Error('analytic-certificate: invalid UV triangle index');
          }
        }
        localTriangles.push([a, b, c]);
      } finally { triangle.delete(); }
    }
    analyticDerivativeBounds(surface, minimumV, maximumV);
    result = { faceIndex, surface, geometry: readAnalyticSurfaceGeometry(oc, face, owned),
      nativeFaceToleranceMm: nonnegative(adaptor.Tolerance(), 'face tolerance'),
      uvNodes, localTriangles, uPeriod, vPeriod };
  } catch (error) {
    primary = error instanceof Error ? error : new Error('analytic-certificate: native extraction failed', { cause: error });
  }
  let cleanup: Error | undefined;
  try { owned.release(); } catch (error) {
    cleanup = error instanceof Error ? error : new Error('analytic-certificate: native cleanup failed', { cause: error });
  }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], primary.message);
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
  if (result === undefined) throw new Error('analytic-certificate: missing extraction result');
  return result;
}
