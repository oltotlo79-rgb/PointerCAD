import { analysisRegionTriangles, requestAnalysisBoundary, type AnalysisBoundary,
  type AnalysisBoundarySource } from '@pointercad/model';
import type { CadTetraContext, CadTetraRegion } from './cadTetraMesh.js';

export const CAD_SHELL_SURFACE_SCHEMA = 'pointercad-cad-shell-surface/1';

/** Geometry preparation only: no thickness/material, DOFs, loads or strength result. */
export interface CadShellSurfaceOptions {
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  readonly maximumNodes: number;
  readonly maximumTriangles: number;
  readonly minimumTriangleAreaMm2: number;
  readonly minimumAngleDeg: number;
  readonly maximumAspectRatio: number;
}

export interface CadShellSurfaceMesh {
  readonly schema: typeof CAD_SHELL_SURFACE_SCHEMA;
  readonly source: { readonly documentId: string; readonly revision: number;
    readonly featureId: string; readonly bodyKey: string };
  readonly units: 'mm';
  readonly deflection: { readonly linear: number; readonly angular: number };
  readonly coordinates: Float64Array;
  readonly triangles: Uint32Array;
  readonly triangleFaces: Uint32Array;
  /** One unit normal and area per triangle, preserving native winding without repair. */
  readonly normals: Float64Array;
  readonly areasMm2: Float64Array;
  /** Neighbour across each directed triangle edge; -1 means a free edge. */
  readonly neighbours: Int32Array;
  readonly components: readonly (readonly number[])[];
  readonly freeEdges: readonly { readonly from: number; readonly to: number; readonly triangle: number;
    readonly faceIndex: number }[];
  /** Only these origin references are persistent; all node/triangle/face indexes are revision-local. */
  readonly regions: readonly CadTetraRegion[];
  readonly quality: { readonly areaMm2: number; readonly minimumAreaMm2: number;
    readonly maximumAreaMm2: number; readonly minimumAngleDeg: number; readonly maximumAspectRatio: number };
  readonly orientation: 'native-winding';
  readonly physicsValidated: false;
  readonly selfIntersectionChecked: false;
}

export type CadShellSurfaceOutcome =
  | { readonly kind: 'ready'; readonly mesh: CadShellSurfaceMesh }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled' };

export class CadShellSurfaceRefusal extends Error {
  override readonly name = 'CadShellSurfaceRefusal';
  constructor(readonly code: string, message: string) { super(message); }
}

function refuse(code: string, message: string): never { throw new CadShellSurfaceRefusal(code, message); }
function checkedOptions(options: CadShellSurfaceOptions): void {
  if (!Number.isFinite(options.linearDeflection) || options.linearDeflection <= 0
    || !Number.isFinite(options.angularDeflection) || options.angularDeflection <= 0
    || !Number.isSafeInteger(options.maximumNodes) || options.maximumNodes < 3
    || !Number.isSafeInteger(options.maximumTriangles) || options.maximumTriangles < 1
    || !Number.isFinite(options.minimumTriangleAreaMm2) || options.minimumTriangleAreaMm2 < 0
    || !Number.isFinite(options.minimumAngleDeg) || options.minimumAngleDeg < 0 || options.minimumAngleDeg > 60
    || !Number.isFinite(options.maximumAspectRatio) || options.maximumAspectRatio < 1) {
    refuse('invalid-options', 'Finite positive meshing/capacity controls and explicit geometric quality limits are required');
  }
}

interface EdgeUse { readonly from: number; readonly to: number; readonly triangle: number; readonly side: number }

/** Rechecks actual analysis buffers and current persistent face identities; never consumes display geometry. */
export function prepareCadShellSurfaceMesh(boundary: AnalysisBoundary, context: CadTetraContext,
  options: CadShellSurfaceOptions): CadShellSurfaceMesh {
  checkedOptions(options);
  const { mesh } = boundary;
  if (!context.body.isValid || context.body.bodyKind !== 'shell' || context.documentId.length === 0
    || !Number.isSafeInteger(context.revision) || context.revision < 0) {
    refuse('unsupported-body', 'An explicit current CAD shell is required; a solid is not silently replaced by a midsurface');
  }
  if (mesh.units !== 'mm' || mesh.boundary !== 'open' || !mesh.mesher.done || mesh.mesher.status !== 0) {
    refuse('invalid-boundary', 'A successful native open-mode analysis surface is required');
  }
  if (!Number.isFinite(mesh.deflection.linear) || mesh.deflection.linear <= 0 || mesh.deflection.linear > options.linearDeflection
    || !Number.isFinite(mesh.deflection.angular) || mesh.deflection.angular <= 0 || mesh.deflection.angular > options.angularDeflection) {
    refuse('invalid-boundary', 'Native tessellation controls do not satisfy this request');
  }
  if (!Number.isSafeInteger(mesh.nodeCount) || mesh.nodeCount < 3 || mesh.nodeCount > options.maximumNodes
    || !Number.isSafeInteger(mesh.triangleCount) || mesh.triangleCount < 1 || mesh.triangleCount > options.maximumTriangles
    || !(mesh.coordinates instanceof Float64Array) || mesh.coordinates.length !== 3 * mesh.nodeCount
    || !(mesh.triangles instanceof Uint32Array) || mesh.triangles.length !== 3 * mesh.triangleCount
    || !(mesh.triangleFaces instanceof Uint32Array) || mesh.triangleFaces.length !== mesh.triangleCount
    || mesh.faces.length !== context.body.faces.length || boundary.regions.length !== mesh.faces.length) {
    refuse('capacity-or-layout', 'Analysis surface dimensions disagree or exceed the explicit request caps');
  }
  for (const coordinate of mesh.coordinates) if (!Number.isFinite(coordinate)) refuse('nonfinite', 'Nonfinite shell coordinate');
  const ownership = new Int32Array(mesh.triangleCount).fill(-1), faceIds = new Set<number>();
  const regions = boundary.regions.map((region): CadTetraRegion => {
    const reference = region.reference;
    if (reference === null || reference.origin === undefined) refuse('missing-origin', 'Every shell face requires a unique persistent origin');
    const found = analysisRegionTriangles(boundary, context.body, context.steps, reference);
    if (found.status !== 'matched' || found.faceIndex !== region.faceIndex || found.triangles.length === 0
      || found.triangles.length !== region.triangleCount || faceIds.has(region.faceIndex)
      || mesh.faces[region.faceIndex]?.index !== region.faceIndex
      || mesh.faces[region.faceIndex].triangleCount !== region.triangleCount) {
      refuse('stale-region', `Shell face origin does not uniquely cover the current face (${found.status})`);
    }
    faceIds.add(region.faceIndex);
    for (const triangle of found.triangles) {
      if (triangle >= mesh.triangleCount || ownership[triangle] !== -1 || mesh.triangleFaces[triangle] !== region.faceIndex) {
        refuse('stale-region', 'Shell face regions overlap or refer to another triangle');
      }
      ownership[triangle] = region.faceIndex;
    }
    return { tag: region.faceIndex, reference: structuredClone(reference), triangleIndices: Array.from(found.triangles) };
  });
  if (ownership.includes(-1)) refuse('stale-region', 'Shell face regions do not cover every triangle');

  const normals = new Float64Array(mesh.triangles.length), areasMm2 = new Float64Array(mesh.triangleCount);
  const neighbours = new Int32Array(mesh.triangles.length).fill(-1);
  const edges = new Map<string, EdgeUse[]>(), triangles = new Set<string>();
  const incident: number[][] = Array.from({ length: mesh.nodeCount }, () => []);
  let areaMm2 = 0, minimumAreaMm2 = Infinity, maximumAreaMm2 = 0, minimumAngleDeg = 180, maximumAspectRatio = 0;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const ids = Array.from(mesh.triangles.subarray(3 * t, 3 * t + 3));
    if (ids.some(id => id >= mesh.nodeCount) || new Set(ids).size !== 3) refuse('degenerate', `Invalid nodes in triangle ${t}`);
    const key = [...ids].sort((a, b) => a - b).join(':');
    if (triangles.has(key)) refuse('duplicate-triangle', `Repeated shell triangle ${t}`);
    triangles.add(key);
    const vector = (from: number, to: number): readonly [number, number, number] => [
      mesh.coordinates[3 * to] - mesh.coordinates[3 * from],
      mesh.coordinates[3 * to + 1] - mesh.coordinates[3 * from + 1],
      mesh.coordinates[3 * to + 2] - mesh.coordinates[3 * from + 2],
    ];
    const ab = vector(ids[0], ids[1]), ac = vector(ids[0], ids[2]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const twiceArea = Math.hypot(...cross), area = twiceArea / 2;
    if (!Number.isFinite(area) || area <= options.minimumTriangleAreaMm2 || twiceArea === 0) {
      refuse('degenerate-or-area', `Triangle ${t} does not meet the minimum area`);
    }
    let longest = 0, smallestAngle = 180;
    for (let side = 0; side < 3; side += 1) {
      const from = ids[side], to = ids[(side + 1) % 3], other = ids[(side + 2) % 3];
      const u = vector(from, to), v = vector(from, other);
      const angle = Math.atan2(twiceArea, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * 180 / Math.PI;
      longest = Math.max(longest, Math.hypot(...u));
      smallestAngle = Math.min(smallestAngle, angle);
      const edgeKey = `${Math.min(from, to)}:${Math.max(from, to)}`;
      const uses = edges.get(edgeKey) ?? [];
      uses.push({ from, to, triangle: t, side }); edges.set(edgeKey, uses);
      if (uses.length > 2) refuse('nonmanifold-edge', `More than two triangles share edge ${edgeKey}`);
      incident[from].push(t);
    }
    const aspect = longest * longest / twiceArea;
    if (!Number.isFinite(aspect) || !Number.isFinite(smallestAngle) || smallestAngle <= 0
      || smallestAngle < options.minimumAngleDeg || aspect > options.maximumAspectRatio) {
      refuse('poor-quality', `Triangle ${t} violates the angle/aspect limits`);
    }
    normals.set(cross.map(value => value / twiceArea), 3 * t); areasMm2[t] = area;
    areaMm2 += area; minimumAreaMm2 = Math.min(minimumAreaMm2, area); maximumAreaMm2 = Math.max(maximumAreaMm2, area);
    minimumAngleDeg = Math.min(minimumAngleDeg, smallestAngle); maximumAspectRatio = Math.max(maximumAspectRatio, aspect);
  }
  if (!Number.isFinite(areaMm2)) refuse('nonfinite', 'Shell area overflow');
  const freeEdges: { from: number; to: number; triangle: number; faceIndex: number }[] = [];
  const boundaryDegree = new Uint32Array(mesh.nodeCount);
  for (const uses of edges.values()) {
    const first = uses[0];
    if (uses.length === 1) {
      freeEdges.push({ from: first.from, to: first.to, triangle: first.triangle, faceIndex: ownership[first.triangle] });
      boundaryDegree[first.from] += 1; boundaryDegree[first.to] += 1;
    } else {
      const second = uses[1];
      if (first.from !== second.to || first.to !== second.from) refuse('inconsistent-orientation', 'Shared edge has equal triangle directions');
      neighbours[3 * first.triangle + first.side] = second.triangle;
      neighbours[3 * second.triangle + second.side] = first.triangle;
    }
  }
  // A manifold vertex has one connected triangle fan and either zero or two incident free edges.
  for (let node = 0; node < incident.length; node += 1) {
    const fan = incident[node];
    if (fan.length === 0) refuse('unused-node', `Shell node ${node} has no triangle`);
    if (boundaryDegree[node] !== 0 && boundaryDegree[node] !== 2) refuse('nonmanifold-vertex', `Branched shell boundary at node ${node}`);
    const reached = new Set<number>([fan[0]]), queue = [fan[0]];
    for (let i = 0; i < queue.length; i += 1) {
      const triangle = queue[i];
      for (const neighbour of neighbours.subarray(3 * triangle, 3 * triangle + 3)) {
        if (neighbour < 0 || reached.has(neighbour)
          || !mesh.triangles.subarray(3 * neighbour, 3 * neighbour + 3).includes(node)) continue;
        reached.add(neighbour); queue.push(neighbour);
      }
    }
    if (reached.size !== fan.length) refuse('nonmanifold-vertex', `Disconnected triangle fans at node ${node}`);
  }
  const components: number[][] = [], visited = new Uint8Array(mesh.triangleCount);
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    if (visited[t] !== 0) continue;
    const component = [t]; visited[t] = 1;
    for (let i = 0; i < component.length; i += 1) for (const neighbour of neighbours.subarray(3 * component[i], 3 * component[i] + 3)) {
      if (neighbour >= 0 && visited[neighbour] === 0) { visited[neighbour] = 1; component.push(neighbour); }
    }
    components.push(component);
  }
  return { schema: CAD_SHELL_SURFACE_SCHEMA, source: { documentId: context.documentId, revision: context.revision,
    featureId: boundary.revision.featureId, bodyKey: boundary.revision.bodyKey }, units: 'mm', deflection: { ...mesh.deflection },
  coordinates: mesh.coordinates.slice(), triangles: mesh.triangles.slice(), triangleFaces: mesh.triangleFaces.slice(),
  normals, areasMm2, neighbours, components, freeEdges, regions,
  quality: { areaMm2, minimumAreaMm2, maximumAreaMm2, minimumAngleDeg, maximumAspectRatio },
  orientation: 'native-winding', physicsValidated: false, selfIntersectionChecked: false };
}

/** Uses the real extractor, then rechecks current CAD identity; never publishes or mutates a document. */
export async function requestCadShellSurfaceMesh(kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext,
  options: CadShellSurfaceOptions, signal?: AbortSignal): Promise<CadShellSurfaceOutcome> {
  try {
    const limits = { ...options };
    checkedOptions(limits);
    if (signal?.aborted) return { kind: 'cancelled' };
    const initial = readCurrent();
    const documentId = initial.documentId, revision = initial.revision;
    if (!initial.body.isValid || initial.body.bodyKind !== 'shell') refuse('unsupported-body', 'An explicit CAD shell is required');
    const outcome = await requestAnalysisBoundary(kernel, initial.steps, initial.body,
      { boundary: 'open', linearDeflection: limits.linearDeflection, angularDeflection: limits.angularDeflection });
    if (signal?.aborted) return { kind: 'cancelled' };
    if (outcome.kind === 'failed') return outcome;
    const current = readCurrent();
    if (current.documentId !== documentId || current.revision !== revision) refuse('stale', 'CAD changed while obtaining the shell boundary');
    return { kind: 'ready', mesh: prepareCadShellSurfaceMesh(outcome.boundary, current, limits) };
  } catch (error) {
    return { kind: 'failed', code: error instanceof CadShellSurfaceRefusal ? error.code : 'shell-preparation',
      message: error instanceof Error ? error.message : 'Shell surface preparation failed' };
  }
}
