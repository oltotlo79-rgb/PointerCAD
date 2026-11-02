import { InputIssue, SOLID_CONTACT_LIMITS, solidCadFaceKey, type SolidContactNormal, type Vector3 } from '@pointercad/model/beam-analysis';
import type { CadAnalysisBoundaryIdentity } from './cadTetraMesh.js';
import type { SolidContactPlan, SolidContactPlanFace, SolidContactPlanPair } from './solidContactModel.js';

export interface ContactPointProjection {
  readonly pointMm: Vector3;
  readonly barycentric: Vector3;
  readonly distanceMm: number;
}
/** Current boundary geometry in the same mm coordinate frame as the W16 plan.
 * Indices address this body's boundary triangles, never tetrahedra or another body's nodes. */
export interface SolidContactSearchMesh {
  readonly boundaryIdentity: CadAnalysisBoundaryIdentity;
  readonly coordinates: readonly number[];
  readonly triangles: readonly number[];
}
export interface ContactFacetLocation {
  readonly bodyFeatureId: string;
  readonly faceKey: string;
  readonly triangleIndex: number;
  readonly nodeIndices: readonly [number, number, number];
  readonly barycentric: Vector3;
  readonly pointMm: Vector3;
}
export interface SolidContactFacetCandidate {
  readonly contactId: string;
  readonly master: ContactFacetLocation;
  readonly slave: ContactFacetLocation;
  readonly distanceMm: number;
  readonly normal: SolidContactNormal;
  readonly masterNormal: Vector3;
  /** Geometric signed separation along the declared master direction, not a solved physical gap. */
  readonly signedSeparationMm: number;
  /** Preserved independently; never added to or subtracted from the closest-point distance. */
  readonly declaredInitialGapMm: number;
}

type Triangle = readonly [Vector3, Vector3, Vector3];
interface PreparedTriangle {
  readonly vertices: Triangle;
  readonly u: Vector3;
  readonly v: Vector3;
  readonly scale: number;
  readonly normal: Vector3;
  readonly areaScale: number;
}
interface TrianglePairProjection {
  readonly master: ContactPointProjection;
  readonly slave: ContactPointProjection;
  readonly distanceMm: number;
}

const copy = (v: Vector3): Vector3 => [v[0], v[1], v[2]];
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const divide = (v: Vector3, scale: number): Vector3 => [v[0] / scale, v[1] / scale, v[2] / scale];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 0]];

function refuse(code: string, path: string, reason: string): never { throw new InputIssue(code, path, reason); }
function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) refuse('contact-numeric', path, 'Contact geometry exceeds finite numeric range');
  return value;
}
function dense(value: readonly unknown[], path: string): void {
  if (!Array.isArray(value)) refuse('contact-shape', path, 'Expected a dense array');
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) refuse('contact-shape', `${path}[${index}]`, 'Sparse contact geometry is not supported');
  }
}
function vector(value: readonly number[], path: string): Vector3 {
  dense(value, path);
  if (value.length !== 3) refuse('contact-shape', path, 'Expected three finite coordinates');
  return [finite(value[0], `${path}[0]`), finite(value[1], `${path}[1]`), finite(value[2], `${path}[2]`)];
}
function prepareTriangle(value: readonly (readonly number[])[], path: string): PreparedTriangle {
  dense(value, path);
  if (value.length !== 3) refuse('contact-shape', path, 'Expected three triangle vertices');
  const vertices: Triangle = [vector(value[0], `${path}[0]`), vector(value[1], `${path}[1]`), vector(value[2], `${path}[2]`)];
  const rawU = subtract(vertices[1], vertices[0]), rawV = subtract(vertices[2], vertices[0]);
  const scale = finite(Math.max(...rawU.map(Math.abs), ...rawV.map(Math.abs)), path);
  if (!(scale > 0)) refuse('contact-degenerate', path, 'Triangle vertices must span a nonzero area');
  const u = divide(rawU, scale), v = divide(rawV, scale), area = cross(u, v);
  const areaScale = finite(Math.hypot(...area), path);
  if (!(areaScale > 0)) refuse('contact-degenerate', path, 'Triangle vertices are collinear or numerically degenerate');
  const normal = vector(divide(area, areaScale), path);
  return { vertices, u, v, scale, normal, areaScale };
}
function planeBarycentric(point: Vector3, triangle: PreparedTriangle, path: string): Vector3 {
  const relative = vector(divide(subtract(point, triangle.vertices[0]), triangle.scale), path);
  const beta = finite(dot(cross(relative, triangle.v), triangle.normal) / triangle.areaScale, path);
  const gamma = finite(dot(cross(triangle.u, relative), triangle.normal) / triangle.areaScale, path);
  return [finite(1 - beta - gamma, path), beta, gamma];
}
function position(triangle: Triangle, weights: Vector3, path: string): Vector3 {
  return vector(triangle[0].map((value, axis) => value
    + weights[1] * (triangle[1][axis] - value) + weights[2] * (triangle[2][axis] - value)), path);
}
function result(point: Vector3, triangle: Triangle, weights: Vector3, path: string): ContactPointProjection {
  const closest = position(triangle, weights, path);
  return { pointMm: closest, barycentric: copy(weights), distanceMm: finite(Math.hypot(...subtract(point, closest)), path) };
}
function edgeWeights(edge: readonly [number, number], fraction: number): Vector3 {
  const weights: [number, number, number] = [0, 0, 0];
  weights[edge[0]] = 1 - fraction; weights[edge[1]] = fraction;
  return weights;
}
function pointOnEdge(point: Vector3, a: Vector3, b: Vector3, path: string): number {
  const direction = subtract(b, a), scale = finite(Math.max(...direction.map(Math.abs)), path);
  if (!(scale > 0)) refuse('contact-degenerate', path, 'Triangle edges must have distinct endpoints');
  const unit = divide(direction, scale), offset = vector(divide(subtract(point, a), scale), path);
  return clamp(finite(dot(offset, unit) / dot(unit, unit), path));
}
function projectPrepared(point: Vector3, triangle: PreparedTriangle, path: string): ContactPointProjection {
  const weights = planeBarycentric(point, triangle, path);
  if (weights.every(value => value >= 0)) return result(point, triangle.vertices, weights, path);
  let closest: ContactPointProjection | undefined;
  for (const edge of EDGES) {
    const fraction = pointOnEdge(point, triangle.vertices[edge[0]], triangle.vertices[edge[1]], path);
    const candidate = result(point, triangle.vertices, edgeWeights(edge, fraction), path);
    if (closest === undefined || candidate.distanceMm < closest.distanceMm) closest = candidate;
  }
  if (closest === undefined) return refuse('contact-degenerate', path, 'No triangle feature is available');
  return closest;
}

/** Euclidean closest point on the closed triangle, including its edges and vertices.
 * Barycentric coordinates follow the supplied vertex order. No input is modified. */
export function projectContactPoint(pointMm: readonly number[], triangleMm: readonly (readonly number[])[],
  path = 'contact-projection'): ContactPointProjection {
  return projectPrepared(vector(pointMm, `${path}.point`), prepareTriangle(triangleMm, `${path}.triangle`), path);
}

function pairResult(master: PreparedTriangle, slave: PreparedTriangle,
  masterWeights: Vector3, slaveWeights: Vector3, path: string): TrianglePairProjection {
  const masterPoint = position(master.vertices, masterWeights, path), slavePoint = position(slave.vertices, slaveWeights, path);
  const distanceMm = finite(Math.hypot(...subtract(slavePoint, masterPoint)), path);
  return { master: { pointMm: masterPoint, barycentric: copy(masterWeights), distanceMm },
    slave: { pointMm: slavePoint, barycentric: copy(slaveWeights), distanceMm }, distanceMm };
}
function edgePairFractions(a: Vector3, b: Vector3, c: Vector3, d: Vector3, path: string): {
  readonly master: number; readonly slave: number; readonly intersects: boolean;
} {
  const rawU = subtract(b, a), rawV = subtract(d, c), rawR = subtract(a, c);
  const lengthU = finite(Math.hypot(...rawU), path), lengthV = finite(Math.hypot(...rawV), path);
  if (!(lengthU > 0 && lengthV > 0)) return refuse('contact-degenerate', path, 'Expected two nonzero segment lengths');
  // Normalize each direction separately: a short but nonzero edge must not
  // disappear when its squared length is compared with a much longer edge.
  const scale = finite(Math.max(lengthU, lengthV, ...rawR.map(Math.abs)), path);
  const u = divide(rawU, lengthU), v = divide(rawV, lengthV), r = vector(divide(rawR, scale), path);
  const scaledU = lengthU / scale, scaledV = lengthV / scale;
  if (!(scaledU > 0 && scaledV > 0)) return refuse('contact-numeric', path, 'Segment length ratio exceeds finite numeric range');
  const bb = dot(u, v), cc = dot(u, r), ff = dot(v, r);
  const uv = cross(u, v), crossLength = Math.hypot(...uv);
  // Unit-normal scalar triple products retain the unsquared geometric scale.
  const normal = crossLength > 0 ? divide(uv, crossLength) : undefined;
  const rawS = normal === undefined ? 0 : finite(dot(cross(v, r), normal) / crossLength / scaledU, path);
  const rawT = normal === undefined ? finite(ff / scaledV, path) : finite(dot(cross(u, r), normal) / crossLength / scaledV, path);
  const intersects = normal !== undefined && dot(r, normal) === 0 && rawS >= 0 && rawS <= 1 && rawT >= 0 && rawT <= 1;
  let s = clamp(rawS), t = finite((bb * s * scaledU + ff) / scaledV, path);
  if (t < 0) { t = 0; s = clamp(finite(-cc / scaledU, path)); }
  else if (t > 1) { t = 1; s = clamp(finite((bb * scaledV - cc) / scaledU, path)); }
  return { master: s, slave: t, intersects };
}
function edgeFaceIntersection(edgeTriangle: PreparedTriangle, edge: readonly [number, number],
  face: PreparedTriangle, path: string): { readonly point: Vector3; readonly edgeWeights: Vector3; readonly faceWeights: Vector3 } | undefined {
  const a = edgeTriangle.vertices[edge[0]], b = edgeTriangle.vertices[edge[1]];
  const da = finite(dot(divide(subtract(a, face.vertices[0]), face.scale), face.normal), path);
  const db = finite(dot(divide(subtract(b, face.vertices[0]), face.scale), face.normal), path);
  if ((da > 0 && db > 0) || (da < 0 && db < 0) || da === db) return undefined;
  const fraction = finite(da / (da - db), path);
  if (fraction < 0 || fraction > 1) return undefined;
  const weights = edgeWeights(edge, fraction), point = position(edgeTriangle.vertices, weights, path);
  const faceWeights = planeBarycentric(point, face, path);
  if (faceWeights.some(value => value < 0)) return undefined;
  return { point, edgeWeights: weights, faceWeights };
}
function closestTriangles(master: PreparedTriangle, slave: PreparedTriangle, path: string): TrianglePairProjection {
  let closest: TrianglePairProjection | undefined;
  const consider = (candidate: TrianglePairProjection): void => {
    if (closest === undefined || candidate.distanceMm < closest.distanceMm) closest = candidate;
  };
  // A disjoint triangle pair has a closest vertex/face or edge/edge feature pair.
  // Non-coplanar intersections additionally need edge/face tests; vertices alone miss them.
  for (let index = 0; index < 3; index++) {
    const vertex: [number, number, number] = [0, 0, 0]; vertex[index] = 1;
    const onMaster = projectPrepared(slave.vertices[index], master, path);
    consider(pairResult(master, slave, onMaster.barycentric, vertex, path));
    const onSlave = projectPrepared(master.vertices[index], slave, path);
    consider(pairResult(master, slave, vertex, onSlave.barycentric, path));
  }
  for (const masterEdge of EDGES) for (const slaveEdge of EDGES) {
    const fractions = edgePairFractions(master.vertices[masterEdge[0]], master.vertices[masterEdge[1]],
      slave.vertices[slaveEdge[0]], slave.vertices[slaveEdge[1]], path);
    const masterWeights = edgeWeights(masterEdge, fractions.master), slaveWeights = edgeWeights(slaveEdge, fractions.slave);
    if (fractions.intersects) {
      // Exact coplanarity and unconstrained segment parameters prove intersection;
      // use one shared point so independent interpolation rounding is not a false gap.
      const point = position(master.vertices, masterWeights, path);
      consider({ distanceMm: 0, master: { pointMm: copy(point), barycentric: masterWeights, distanceMm: 0 },
        slave: { pointMm: copy(point), barycentric: slaveWeights, distanceMm: 0 } });
    } else consider(pairResult(master, slave, masterWeights, slaveWeights, path));
  }
  for (const edge of EDGES) {
    const fromSlave = edgeFaceIntersection(slave, edge, master, path);
    if (fromSlave !== undefined) consider({ distanceMm: 0,
      master: { pointMm: copy(fromSlave.point), barycentric: copy(fromSlave.faceWeights), distanceMm: 0 },
      slave: { pointMm: copy(fromSlave.point), barycentric: copy(fromSlave.edgeWeights), distanceMm: 0 } });
    const fromMaster = edgeFaceIntersection(master, edge, slave, path);
    if (fromMaster !== undefined) consider({ distanceMm: 0,
      master: { pointMm: copy(fromMaster.point), barycentric: copy(fromMaster.edgeWeights), distanceMm: 0 },
      slave: { pointMm: copy(fromMaster.point), barycentric: copy(fromMaster.faceWeights), distanceMm: 0 } });
  }
  if (closest === undefined) return refuse('contact-degenerate', path, 'No triangle features are available');
  return closest;
}

interface BoundMesh {
  readonly source: SolidContactSearchMesh;
  readonly owners: ReadonlyMap<number, string>;
  readonly faceTriangles: ReadonlyMap<string, readonly number[]>;
  readonly triangles: ReadonlyMap<number, PreparedTriangle>;
}
function boundMeshes(plan: SolidContactPlan, meshes: readonly SolidContactSearchMesh[], path: string): ReadonlyMap<string, BoundMesh> {
  dense(meshes, `${path}.meshes`);
  const byBody = new Map<string, BoundMesh>();
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const mesh = meshes[meshIndex], itemPath = `${path}.meshes[${meshIndex}]`, identity = mesh?.boundaryIdentity;
    if (identity === undefined || identity.documentId !== plan.documentId || identity.outward !== true
      || typeof identity.bodyFeatureId !== 'string' || identity.bodyFeatureId.length === 0) {
      refuse('contact-boundary', itemPath, 'Expected a current outward W05 boundary in the contact document');
    }
    if (byBody.has(identity.bodyFeatureId)) refuse('contact-duplicate', itemPath, 'A body must identify one boundary mesh');
    dense(mesh.coordinates, `${itemPath}.coordinates`); dense(mesh.triangles, `${itemPath}.triangles`);
    if (mesh.coordinates.length % 3 !== 0 || mesh.triangles.length % 3 !== 0) {
      refuse('contact-shape', itemPath, 'Coordinates and triangle indices must contain complete triples');
    }
    mesh.coordinates.forEach((value, index) => finite(value, `${itemPath}.coordinates[${index}]`));
    const nodeCount = mesh.coordinates.length / 3, triangleCount = mesh.triangles.length / 3;
    for (let index = 0; index < mesh.triangles.length; index++) {
      const node = mesh.triangles[index];
      if (!Number.isSafeInteger(node) || node < 0 || node >= nodeCount) {
        refuse('contact-node-index', `${itemPath}.triangles[${index}]`, 'Triangle node does not exist in this body');
      }
    }
    dense(identity.faces, `${itemPath}.faces`);
    const owners = new Map<number, string>(), faceTriangles = new Map<string, readonly number[]>();
    for (const face of identity.faces) {
      if (face === undefined || face.reference.bodyFeatureId !== identity.bodyFeatureId
        || face.key !== solidCadFaceKey(face.reference) || faceTriangles.has(face.key)) {
        refuse('contact-face', `${itemPath}.faces`, 'Expected unique semantic faces belonging to this body');
      }
      dense(face.samples, `${itemPath}.samples`);
      const indices: number[] = [];
      for (const sample of face.samples) {
        if (sample === undefined || !Number.isSafeInteger(sample.triangleIndex) || sample.triangleIndex < 0
          || sample.triangleIndex >= triangleCount || owners.has(sample.triangleIndex)) {
          refuse('contact-triangle-index', `${itemPath}.samples`, 'Expected a unique existing boundary triangle');
        }
        owners.set(sample.triangleIndex, face.key); indices.push(sample.triangleIndex);
      }
      if (indices.length === 0) refuse('contact-face', `${itemPath}.samples`, 'A contact face needs boundary triangles');
      faceTriangles.set(face.key, indices);
    }
    const prepared = new Map<number, PreparedTriangle>(), connectivity = new Set<string>();
    for (let index = 0; index < triangleCount; index++) {
      const nodes = mesh.triangles.slice(index * 3, index * 3 + 3);
      const key = JSON.stringify([...nodes].sort((a, b) => a - b));
      if (connectivity.has(key)) refuse('contact-duplicate', `${itemPath}.triangles[${index}]`, 'Repeated boundary connectivity is ambiguous');
      connectivity.add(key);
      prepared.set(index, prepareTriangle(nodes.map(node => mesh.coordinates.slice(node * 3, node * 3 + 3)), `${itemPath}.triangles[${index}]`));
    }
    byBody.set(identity.bodyFeatureId, { source: mesh, owners, faceTriangles, triangles: prepared });
  }
  return byBody;
}
function bindFace(face: SolidContactPlanFace, meshes: ReadonlyMap<string, BoundMesh>, path: string): BoundMesh {
  const mesh = meshes.get(face.bodyFeatureId), actual = mesh?.faceTriangles.get(face.faceKey);
  if (mesh === undefined || actual === undefined) return refuse('contact-face', path, 'The face is absent from its own body boundary');
  dense(face.triangleIndices, `${path}.triangleIndices`);
  const seen = new Set<number>();
  for (const index of face.triangleIndices) {
    if (!Number.isSafeInteger(index) || mesh.owners.get(index) !== face.faceKey || seen.has(index)) {
      refuse('contact-triangle-index', path, 'Plan indices must uniquely address this face in this body');
    }
    seen.add(index);
  }
  if (seen.size !== actual.length) refuse('contact-triangle-index', path, 'The plan and current face must contain the same boundary triangles');
  return mesh;
}
function masterNormal(pair: SolidContactPlanPair, offset: number, triangle: PreparedTriangle, path: string): Vector3 {
  const normal = vector(pair.masterNormals[offset], `${path}.masterNormals[${offset}]`);
  if (Math.abs(Math.hypot(...normal) - 1) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
    refuse('contact-normal', path, 'The W16 direction must remain a unit normal without normalization');
  }
  const expected = pair.normal.kind === 'explicit' ? vector(pair.normal.vector, `${path}.normal`) : triangle.normal;
  if (pair.normal.kind !== 'explicit' && pair.normal.kind !== 'master-outward') refuse('contact-normal', path, 'Unknown W16 normal convention');
  if (Math.hypot(...subtract(normal, expected)) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
    refuse('contact-normal', path, 'The declared normal is inconsistent with the current master geometry or explicit direction');
  }
  return normal;
}
function location(face: SolidContactPlanFace, mesh: BoundMesh, index: number, projection: ContactPointProjection): ContactFacetLocation {
  const nodes = mesh.source.triangles;
  return { bodyFeatureId: face.bodyFeatureId, faceKey: face.faceKey, triangleIndex: index,
    nodeIndices: [nodes[3 * index], nodes[3 * index + 1], nodes[3 * index + 2]],
    barycentric: copy(projection.barycentric), pointMm: copy(projection.pointMm) };
}
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Enumerates every facet pair within the explicit distance; no spatial pruning can discard a nearer pair.
 * A candidate represents geometric proximity, not pressure, friction, a solved gap or a quadrature rule.
 * W18 can use both barycentric/node mappings. Finite deformation requires caller-supplied current geometry,
 * current W16 normals and renewed search; this function does not update material/contact history. */
export function searchContactFacets(plan: SolidContactPlan, meshes: readonly SolidContactSearchMesh[], searchDistanceMm: number,
  path = 'contact-search'): readonly SolidContactFacetCandidate[] {
  if (!Number.isFinite(searchDistanceMm) || searchDistanceMm < 0) refuse('contact-distance', path, 'Search distance must be finite and nonnegative in mm');
  dense(plan.contacts, `${path}.contacts`);
  const byBody = boundMeshes(plan, meshes, path), ids = new Set<string>(), pairs = new Set<string>();
  const candidates: SolidContactFacetCandidate[] = [];
  for (let pairIndex = 0; pairIndex < plan.contacts.length; pairIndex++) {
    const pair = plan.contacts[pairIndex], pairPath = `${path}.contacts[${pairIndex}]`;
    if (pair === undefined || typeof pair.id !== 'string' || pair.id.length === 0 || ids.has(pair.id)) {
      refuse('contact-duplicate', pairPath, 'Expected a unique contact id');
    }
    ids.add(pair.id);
    if (pair.master.faceKey === pair.slave.faceKey) refuse('contact-self', pairPath, 'A face cannot contact itself');
    const key = JSON.stringify([JSON.stringify([pair.master.bodyFeatureId, pair.master.faceKey]),
      JSON.stringify([pair.slave.bodyFeatureId, pair.slave.faceKey])].sort());
    if (pairs.has(key)) refuse('contact-duplicate', pairPath, 'A face pair cannot be repeated or reversed');
    pairs.add(key);
    if (pair.method !== 'surface-to-surface' || !Number.isFinite(pair.gapMm) || pair.gapMm < 0 || pair.gapMm > SOLID_CONTACT_LIMITS.gapMm) {
      refuse('contact-plan', pairPath, 'Expected the unchanged W16 method and declared initial gap');
    }
    const master = bindFace(pair.master, byBody, `${pairPath}.master`), slave = bindFace(pair.slave, byBody, `${pairPath}.slave`);
    dense(pair.masterNormals, `${pairPath}.masterNormals`);
    if (pair.masterNormals.length !== pair.master.triangleIndices.length) refuse('contact-normal', pairPath, 'Each master triangle needs its own W16 normal');
    for (let masterOffset = 0; masterOffset < pair.master.triangleIndices.length; masterOffset++) {
      const masterIndex = pair.master.triangleIndices[masterOffset], masterTriangle = master.triangles.get(masterIndex);
      if (masterTriangle === undefined) return refuse('contact-triangle-index', pairPath, 'Missing master triangle');
      const normal = masterNormal(pair, masterOffset, masterTriangle, pairPath);
      for (const slaveIndex of pair.slave.triangleIndices) {
        if (pair.master.bodyFeatureId === pair.slave.bodyFeatureId && masterIndex === slaveIndex) {
          refuse('contact-self', pairPath, 'A boundary triangle cannot contact itself');
        }
        const slaveTriangle = slave.triangles.get(slaveIndex);
        if (slaveTriangle === undefined) return refuse('contact-triangle-index', pairPath, 'Missing slave triangle');
        const closest = closestTriangles(masterTriangle, slaveTriangle, pairPath);
        if (closest.distanceMm > searchDistanceMm) continue;
        candidates.push({ contactId: pair.id, master: location(pair.master, master, masterIndex, closest.master),
          slave: location(pair.slave, slave, slaveIndex, closest.slave), distanceMm: closest.distanceMm,
          normal: pair.normal.kind === 'explicit' ? { kind: 'explicit', vector: copy(pair.normal.vector) } : { kind: 'master-outward' },
          masterNormal: copy(normal), signedSeparationMm: finite(dot(subtract(closest.slave.pointMm, closest.master.pointMm), normal), pairPath),
          declaredInitialGapMm: pair.gapMm });
      }
    }
  }
  return candidates.sort((a, b) => a.distanceMm - b.distanceMm || compareText(a.contactId, b.contactId)
    || compareText(a.master.bodyFeatureId, b.master.bodyFeatureId) || compareText(a.master.faceKey, b.master.faceKey)
    || a.master.triangleIndex - b.master.triangleIndex || compareText(a.slave.bodyFeatureId, b.slave.bodyFeatureId)
    || compareText(a.slave.faceKey, b.slave.faceKey) || a.slave.triangleIndex - b.slave.triangleIndex);
}
