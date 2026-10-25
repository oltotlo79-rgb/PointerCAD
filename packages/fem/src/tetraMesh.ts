/** Versioned planar PLC contracts, millimetres, one material domain.
 * This is a mesh, not a material assignment or a structural-analysis result. */
import { exactTetrahedronOrientation, validatePlcTopology, type PlcShell } from './plcTopology.js';

export const TETRA_MESH_SCHEMA = 'pointercad-convex-plc/1';
export const PLANAR_TETRA_MESH_SCHEMA = 'pointercad-plc/2';
export const NETGEN_WHEEL = 'netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl';
export const TETRA_LIMITS = { boundaryNodes: 1024, boundaryTriangles: 2048, nodes: 10000, tetrahedra: 50000 } as const;
export interface TetraMeshSource {
  readonly documentId: string;
  readonly revision: number;
  readonly featureId: string;
  readonly bodyKey: string;
}
export interface TetraMeshingControls {
  /** Native maxh sizing parameter in mm; fixed boundary edges are not subdivided. */
  readonly targetSizeMm: number;
  /** Positive local sizing-field grading, at most one. */
  readonly grading: number;
  /** Zero to three actual move/swap optimization passes, only while the target is unmet. */
  readonly maximumOptimizationPasses: number;
  readonly quality: {
    readonly minimumMeanRatio: number;
    readonly maximumEdgeRatio: number;
  };
}
interface TetraMeshInputFields {
  readonly source: TetraMeshSource;
  readonly units: 'mm';
  readonly coordinates: readonly number[];
  readonly triangles: readonly number[];
  /** Zero-based CAD face labels; a label never becomes a persistent identity. */
  readonly tags: readonly number[];
  readonly tagCount: number;
  /** Absent preserves the native default generation path exactly. */
  readonly meshing?: TetraMeshingControls;
}
export interface LegacyConvexTetraMeshInput extends TetraMeshInputFields {
  readonly schema: typeof TETRA_MESH_SCHEMA;
}
export interface PlanarTetraMeshInput extends TetraMeshInputFields {
  readonly schema: typeof PLANAR_TETRA_MESH_SCHEMA;
  readonly shells: readonly PlcShell[];
}
export type TetraMeshInput = LegacyConvexTetraMeshInput | PlanarTetraMeshInput;
export interface TetraMeshResult {
  readonly kind: 'netgen-convex-tetra-mesh' | 'netgen-tetra-mesh';
  readonly input: TetraMeshInput;
  readonly inputSha256: string;
  readonly coordinates: readonly number[];
  /** Zero-based, positively oriented four-node tetrahedra. */
  readonly tetrahedra: readonly number[];
  readonly boundaryTriangles: readonly number[];
  readonly boundaryTags: readonly number[];
  readonly volumeMm3: number;
  readonly minTetVolumeMm3: number;
}
type V3 = readonly [number, number, number];
interface Plane { readonly point: V3; readonly normal: V3 }
function requireMesh(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`tetra-mesh: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024; }
/** Validate and own every native control; arbitrary native keyword/strategy injection is refused. */
export function readTetraMeshingControls(value: unknown): TetraMeshingControls {
  requireMesh(record(value) && keys(value, ['targetSizeMm', 'grading', 'maximumOptimizationPasses', 'quality']),
    'meshing controls schema');
  const { targetSizeMm, grading, maximumOptimizationPasses, quality } = value;
  requireMesh(typeof targetSizeMm === 'number' && Number.isFinite(targetSizeMm) && targetSizeMm > 0 && targetSizeMm <= 1e9
    && typeof grading === 'number' && Number.isFinite(grading) && grading > 0 && grading <= 1
    && typeof maximumOptimizationPasses === 'number' && Number.isSafeInteger(maximumOptimizationPasses)
    && maximumOptimizationPasses >= 0 && maximumOptimizationPasses <= 3, 'bounded meshing controls required');
  requireMesh(record(quality) && keys(quality, ['minimumMeanRatio', 'maximumEdgeRatio']), 'meshing quality schema');
  const { minimumMeanRatio, maximumEdgeRatio } = quality;
  requireMesh(typeof minimumMeanRatio === 'number' && Number.isFinite(minimumMeanRatio)
    && minimumMeanRatio >= 0 && minimumMeanRatio <= 1
    && typeof maximumEdgeRatio === 'number' && Number.isFinite(maximumEdgeRatio) && maximumEdgeRatio >= 1,
  'meshing quality limits');
  return { targetSizeMm, grading, maximumOptimizationPasses, quality: { minimumMeanRatio, maximumEdgeRatio } };
}
function numbers(value: unknown, maximum: number, integer = false): number[] {
  requireMesh(Array.isArray(value) && value.length > 0 && value.length <= maximum, 'bounded dense array required');
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const n: unknown = value[index];
    requireMesh(Object.hasOwn(value, index) && typeof n === 'number' && Number.isFinite(n)
      && (!integer || Number.isSafeInteger(n)), 'nonfinite, sparse or noninteger array');
    result.push(n);
  }
  return result;
}
const point = (xyz: readonly number[], i: number): V3 => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const faceKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join(',');
const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((n, i) => n === b[i]);
function sum(values: readonly number[]): number {
  let total = 0, correction = 0;
  for (const value of values) {
    const next = total + value;
    correction += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }
  return total + correction;
}

/** Derive geometry from coordinates and incidence, never trust supplied metrics. */
function boundaryGeometry(input: TetraMeshInput): { volume: number; planes: readonly Plane[]; epsilon: number } {
  const { coordinates: xyz, triangles, tags, tagCount } = input;
  const count = xyz.length / 3;
  const anchor = point(xyz, 0);
  const scale = Math.max(...Array.from({ length: count }, (_, i) => Math.hypot(...sub(point(xyz, i), anchor))));
  requireMesh(scale > 0 && Number.isFinite(scale), 'zero or nonfinite extent');
  const epsilon = scale * 1e-10;
  const directed = new Map<string, number>();
  const faces = new Set<string>(), used = new Set<number>();
  const tagPlanes = new Map<number, Plane>();
  const volumes: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    requireMesh(a >= 0 && b >= 0 && c >= 0 && a < count && b < count && c < count
      && a !== b && b !== c && c !== a, 'invalid boundary triangle');
    const key = faceKey(a, b, c);
    requireMesh(!faces.has(key), 'duplicate boundary triangle'); faces.add(key);
    for (const n of [a, b, c]) used.add(n);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const edge = `${u},${v}`;
      requireMesh(!directed.has(edge), 'nonmanifold or inconsistent oriented edge'); directed.set(edge, i / 3);
    }
    const pa = point(xyz, a), pb = point(xyz, b), pc = point(xyz, c);
    const normal = cross(sub(pb, pa), sub(pc, pa));
    const length = Math.hypot(...normal);
    requireMesh(Number.isFinite(length) && length > 0, 'degenerate boundary triangle');
    const plane: Plane = { point: pa, normal: [normal[0] / length, normal[1] / length, normal[2] / length] };
    // The legacy contract retains its original convex half-space requirement.
    // PLC2 instead proves embeddedness, nesting and material orientation below.
    if (input.schema === TETRA_MESH_SCHEMA) {
      for (let n = 0; n < count; n += 1) requireMesh(dot(plane.normal, sub(point(xyz, n), pa)) <= epsilon,
        'unsupported nonconvex or inward boundary');
    }
    const tag = tags[i / 3];
    requireMesh(tag >= 0 && tag < tagCount, 'invalid boundary label');
    const existing = tagPlanes.get(tag);
    if (existing !== undefined) {
      requireMesh(dot(existing.normal, plane.normal) >= 1 - 1e-10
        && [pa, pb, pc].every(p => Math.abs(dot(existing.normal, sub(p, existing.point))) <= epsilon),
      'one CAD face label spans nonplanar triangles');
    } else tagPlanes.set(tag, plane);
    volumes.push(dot(sub(pa, anchor), cross(sub(pb, anchor), sub(pc, anchor))) / 6);
  }
  requireMesh(used.size === count && tagPlanes.size === tagCount, 'unused node or face label');
  for (const edge of directed.keys()) {
    const [a, b] = edge.split(',');
    requireMesh(directed.has(`${b},${a}`), 'open boundary');
  }
  // Connectedness by shared edges, never by a single coincident vertex.
  const adjacency = Array.from({ length: triangles.length / 3 }, () => new Set<number>());
  for (const [edge, triangle] of directed) {
    const [a, b] = edge.split(',');
    const other = directed.get(`${b},${a}`);
    requireMesh(other !== undefined, 'open boundary'); adjacency[triangle].add(other);
  }
  const reached = new Set([0]), queue = [0];
  for (let i = 0; i < queue.length; i += 1) for (const n of adjacency[queue[i]]) {
    if (!reached.has(n)) { reached.add(n); queue.push(n); }
  }
  if (input.schema === TETRA_MESH_SCHEMA) requireMesh(reached.size === adjacency.length, 'multiple boundary components');
  else validatePlcTopology(xyz, triangles, input.shells);
  const volume = sum(volumes);
  requireMesh(Number.isFinite(volume) && volume > 1e-15, 'nonpositive enclosed volume');
  return { volume, planes: [...tagPlanes.values()], epsilon };
}

/** Own a canonical copy before hashing/postMessage; no request field is executable code. */
export function readTetraMeshInput(value: unknown): TetraMeshInput {
  requireMesh(record(value), 'input schema');
  const planar = value.schema === PLANAR_TETRA_MESH_SCHEMA;
  const names = ['schema', 'source', 'units', 'coordinates', 'triangles', 'tags', 'tagCount'];
  if (planar) names.push('shells');
  const controlled = Object.hasOwn(value, 'meshing');
  if (controlled) names.push('meshing');
  requireMesh(keys(value, names) && (planar || value.schema === TETRA_MESH_SCHEMA) && value.units === 'mm', 'input schema');
  const source = value.source;
  requireMesh(record(source) && keys(source, ['documentId', 'revision', 'featureId', 'bodyKey'])
    && text(source.documentId) && text(source.featureId) && text(source.bodyKey)
    && typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 0, 'source identity');
  const coordinates = numbers(value.coordinates, TETRA_LIMITS.boundaryNodes * 3);
  const triangles = numbers(value.triangles, TETRA_LIMITS.boundaryTriangles * 3, true);
  const tags = numbers(value.tags, TETRA_LIMITS.boundaryTriangles, true);
  requireMesh(coordinates.length % 3 === 0 && coordinates.length >= 12 && coordinates.every(n => Math.abs(n) <= 1e9)
    && triangles.length % 3 === 0 && triangles.length >= 12 && tags.length === triangles.length / 3
    && typeof value.tagCount === 'number' && Number.isSafeInteger(value.tagCount)
    && value.tagCount >= (planar ? 1 : 4) && value.tagCount <= tags.length, 'dimensions or label count');
  const fields: TetraMeshInputFields = {
    source: { documentId: source.documentId, revision: source.revision, featureId: source.featureId, bodyKey: source.bodyKey },
    units: 'mm', coordinates, triangles, tags, tagCount: value.tagCount,
    ...(controlled ? { meshing: readTetraMeshingControls(value.meshing) } : {}) };
  let input: TetraMeshInput;
  if (planar) {
    requireMesh(Array.isArray(value.shells) && value.shells.length > 0 && value.shells.length <= triangles.length / 12,
      'bounded shell table required');
    const shells: PlcShell[] = [];
    for (let i = 0; i < value.shells.length; i += 1) {
      const shell: unknown = value.shells[i];
      requireMesh(Object.hasOwn(value.shells, i) && record(shell) && keys(shell, ['role', 'triangles'])
        && (shell.role === 'outer' || shell.role === 'cavity'), 'shell schema');
      const members = numbers(shell.triangles, TETRA_LIMITS.boundaryTriangles, true);
      requireMesh(members.length >= 4 && members.every((n, j) => n >= 0 && n < triangles.length / 3
        && (j === 0 || n > members[j - 1])), 'sorted unique shell membership required');
      shells.push({ role: shell.role, triangles: members });
    }
    input = { schema: PLANAR_TETRA_MESH_SCHEMA, ...fields, shells };
  } else input = { schema: TETRA_MESH_SCHEMA, ...fields };
  boundaryGeometry(input);
  return input;
}
export async function tetraMeshInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(readTetraMeshInput(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

/** Native output is a positive tetrahedral chain with exactly the supplied
 * embedded oriented boundary. The chain's degree is therefore the boundary's
 * degree: one in material, zero outside and in cavities. Positive tetrahedra
 * prohibit overlap cancellation; centroid containment would not prove this. */
export function decodeTetraMesh(value: unknown, expected: TetraMeshInput, hash: string): TetraMeshResult {
  const input = readTetraMeshInput(expected);
  requireMesh(/^[a-f0-9]{64}$/u.test(hash), 'input digest');
  requireMesh(record(value) && keys(value, ['coordinates', 'tetrahedra', 'boundaryTriangles', 'boundaryTags']), 'native output shape');
  const coordinates = numbers(value.coordinates, TETRA_LIMITS.nodes * 3);
  const tetrahedra = numbers(value.tetrahedra, TETRA_LIMITS.tetrahedra * 4, true);
  const boundaryTriangles = numbers(value.boundaryTriangles, TETRA_LIMITS.boundaryTriangles * 3, true);
  const boundaryTags = numbers(value.boundaryTags, TETRA_LIMITS.boundaryTriangles, true);
  requireMesh(coordinates.length % 3 === 0 && tetrahedra.length % 4 === 0, 'native dimensions');
  requireMesh(sameNumbers(coordinates.slice(0, input.coordinates.length), input.coordinates)
    && sameNumbers(boundaryTriangles, input.triangles) && sameNumbers(boundaryTags, input.tags), 'native boundary changed');
  const geometry = boundaryGeometry(input), nodeCount = coordinates.length / 3;
  if (input.schema === TETRA_MESH_SCHEMA) {
    for (let i = 0; i < nodeCount; i += 1) for (const plane of geometry.planes) {
      requireMesh(dot(plane.normal, sub(point(coordinates, i), plane.point)) <= geometry.epsilon, 'native node outside PLC');
    }
  }
  const exactOrientation = exactTetrahedronOrientation(coordinates);
  const incidence = new Map<string, { count: number; orientation: number }>();
  const volumes: number[] = [], used = new Set<number>();
  const orientation = (a: number, b: number, c: number): number => ((a - b) * (b - c) * (c - a) > 0 ? 1 : -1);
  for (let i = 0; i < tetrahedra.length; i += 4) {
    const [a, b, c, d] = tetrahedra.slice(i, i + 4);
    requireMesh(new Set([a, b, c, d]).size === 4 && [a, b, c, d].every(n => n >= 0 && n < nodeCount), 'tetrahedron indices');
    const pa = point(coordinates, a);
    const determinant = dot(sub(point(coordinates, b), pa), cross(sub(point(coordinates, c), pa), sub(point(coordinates, d), pa)));
    requireMesh(Number.isFinite(determinant) && determinant > 1e-15 && exactOrientation(a, b, c, d) > 0,
      'nonpositive or degenerate tetrahedron');
    volumes.push(determinant / 6);
    for (const n of [a, b, c, d]) used.add(n);
    for (const [u, v, w] of [[b, c, d], [a, d, c], [a, b, d], [a, c, b]]) {
      const key = faceKey(u, v, w), current = incidence.get(key) ?? { count: 0, orientation: 0 };
      current.count += 1; current.orientation += orientation(u, v, w);
      requireMesh(current.count <= 2, 'nonmanifold tetrahedral face'); incidence.set(key, current);
    }
  }
  requireMesh(used.size === nodeCount, 'unused native node');
  const surface = new Map<string, number>();
  for (let i = 0; i < boundaryTriangles.length; i += 3) {
    const [a, b, c] = boundaryTriangles.slice(i, i + 3); surface.set(faceKey(a, b, c), orientation(a, b, c));
  }
  for (const [key, face] of incidence) {
    requireMesh(face.count === 2 ? face.orientation === 0 && !surface.has(key)
      : face.orientation === surface.get(key), 'tetrahedra do not match oriented CAD boundary');
    if (face.count === 1) surface.delete(key);
  }
  requireMesh(surface.size === 0, 'missing CAD boundary facet');
  const volumeMm3 = sum(volumes);
  requireMesh(Math.abs(volumeMm3 - geometry.volume) <= geometry.volume * 1e-10, 'enclosed volume mismatch');
  return { kind: input.schema === TETRA_MESH_SCHEMA ? 'netgen-convex-tetra-mesh' : 'netgen-tetra-mesh',
    input, inputSha256: hash, coordinates, tetrahedra,
    boundaryTriangles, boundaryTags, volumeMm3, minTetVolumeMm3: volumes.reduce((minimum, volume) => Math.min(minimum, volume), Infinity) };
}
export function tetraMeshResultMatches(value: unknown, input: TetraMeshInput, hash: string): value is TetraMeshResult {
  try {
    if (!record(value) || !keys(value, ['kind', 'input', 'inputSha256', 'coordinates', 'tetrahedra',
      'boundaryTriangles', 'boundaryTags', 'volumeMm3', 'minTetVolumeMm3'])
      || value.kind !== (input.schema === TETRA_MESH_SCHEMA ? 'netgen-convex-tetra-mesh' : 'netgen-tetra-mesh')
      || value.inputSha256 !== hash
      || JSON.stringify(readTetraMeshInput(value.input)) !== JSON.stringify(readTetraMeshInput(input))) return false;
    const decoded = decodeTetraMesh({ coordinates: value.coordinates, tetrahedra: value.tetrahedra,
      boundaryTriangles: value.boundaryTriangles, boundaryTags: value.boundaryTags }, input, hash);
    return decoded.volumeMm3 === value.volumeMm3 && decoded.minTetVolumeMm3 === value.minTetVolumeMm3;
  } catch { return false; }
}
export function isTetraMeshResult(value: unknown): value is TetraMeshResult {
  if (!record(value) || typeof value.inputSha256 !== 'string') return false;
  try { return tetraMeshResultMatches(value, readTetraMeshInput(value.input), value.inputSha256); }
  catch { return false; }
}
