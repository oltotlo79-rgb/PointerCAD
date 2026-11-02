import { createSubShapeReference, type FaceSurfaceKind, type SolidBody, type SubShapeOrigin,
  type SubShapeRef } from '@pointercad/model';
import type { CadTetraContext, CadTetraRegion } from './cadTetraMesh.js';
import type { CadSolidPressureSettings } from './cadSolidAnalysis.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256, TETRA_MESH_SCHEMA, type TetraMeshResult } from './tetraMesh.js';

/** Independent W13 pressure oracle: synthetic convex boundaries, closed-form surface integrals and helpers.
 * Nothing here calls the pressure conversion under test; expected values never come from the product. */
export type Vec = readonly [number, number, number];
export type Mat = readonly [Vec, Vec, Vec];
export const ZERO_MAT: Mat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
export const IDENTITY: Mat = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (s: number, a: Vec): Vec => [s * a[0], s * a[1], s * a[2]];
export const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
export const matVec = (m: Mat, v: Vec): Vec => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const transpose = (m: Mat): Mat => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
const matMul = (a: Mat, b: Mat): Mat => {
  const bt = transpose(b);
  return [[dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])], [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
    [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])]];
};
const outer = (a: Vec, b: Vec): Mat => [scale(a[0], b), scale(a[1], b), scale(a[2], b)];
const matAdd = (a: Mat, b: Mat): Mat => [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2])];
const matScale = (s: number, a: Mat): Mat => [scale(s, a[0]), scale(s, a[1]), scale(s, a[2])];
export const skew = (w: Vec): Mat => [[0, -w[2], w[1]], [w[2], 0, -w[0]], [-w[1], w[0], 0]];

/** Rodrigues rotation about a (normalised) axis. */
export function rotationAbout(axis: Vec, degrees: number): Mat {
  const [x, y, z] = scale(1 / norm(axis), axis), t = degrees * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t), v = 1 - c;
  return [[c + x * x * v, x * y * v - z * s, x * z * v + y * s], [y * x * v + z * s, c + y * y * v, y * z * v - x * s],
    [z * x * v - y * s, z * y * v + x * s, c + z * z * v]];
}
export interface Placement { readonly name: string; readonly rotation: Mat; readonly translation: Vec }
/** Linear displacement field u(x) = gradient x + offset (rigid translation, rigid rotation or first-order stretch). */
export interface LinearField { readonly name: string; readonly gradient: Mat; readonly offset: Vec }
export const fieldAt = (field: LinearField, x: Vec): Vec => add(matVec(field.gradient, x), field.offset);

/** Strictly increasing, deliberately non-uniform angles; the first is 0 and an open span ends exactly at span. */
export function nonuniformAngles(count: number, span: number, amplitude: number, frequency: number,
  phase: number, closed: boolean): number[] {
  return Array.from({ length: closed ? count : count + 1 }, (_, k) => !closed && k === count ? span
    : span * k / count + (k === 0 ? 0 : amplitude * (span / count) * Math.sin(frequency * k + phase)));
}

/** Surface integrals of the loaded face in its own (unplaced) frame:
 * vectorArea S = integral n dA, fluxTensor T_ij = integral n_i x_j dA, area = integral dA (when closed form). */
export interface FaceIntegrals { readonly area: number | null; readonly vectorArea: Vec; readonly fluxTensor: Mat }
export interface PressureSolid {
  readonly name: string;
  readonly points: readonly Vec[];
  readonly triangles: readonly (readonly [number, number, number])[];
  /** CAD face index of every boundary triangle. Each triangle gets its own native label. */
  readonly faceOfTriangle: readonly number[];
  readonly faceKinds: readonly FaceSurfaceKind[];
  readonly interior: Vec;
  readonly loadedFace: number;
  readonly fixedFace: number;
  /** Circumferential steps of a curved face (empty for the plane). */
  readonly circumferentialSteps: readonly number[];
}
export interface PressureGeometry {
  readonly solid: PressureSolid;
  /** Exact integrals of the triangulated (flat-faceted) loaded face that the mesh actually carries. */
  readonly triangulated: FaceIntegrals;
  /** Integrals of the smooth CAD surface the triangles approximate; recorded separately, never the 1e-6 oracle. */
  readonly smooth: FaceIntegrals;
}
const faceIntegral = (area: number, normal: Vec, centroid: Vec): FaceIntegrals =>
  ({ area, vectorArea: scale(area, normal), fluxTensor: matScale(area, outer(normal, centroid)) });
const sumIntegrals = (rows: readonly FaceIntegrals[]): FaceIntegrals => rows.reduce((total, row) => ({
  area: (total.area ?? 0) + (row.area ?? 0), vectorArea: add(total.vectorArea, row.vectorArea),
  fluxTensor: matAdd(total.fluxTensor, row.fluxTensor) }), { area: 0, vectorArea: [0, 0, 0], fluxTensor: ZERO_MAT });
const steps = (angles: readonly number[], closed: boolean): number[] => angles.slice(0, closed ? angles.length : -1)
  .map((angle, k) => (closed && k === angles.length - 1 ? angles[0] + 2 * Math.PI : angles[k + 1]) - angle);

/** (a) 4 x 3 rectangle on z=0 with a non-uniform 6 x 4 grid and alternating diagonals, closed by a pyramid apex below. */
export function planarPressureGeometry(): PressureGeometry {
  const xs = [0, 0.3, 1.1, 1.7, 2.9, 3.2, 4], ys = [0, 0.45, 1.6, 2.5, 3];
  const id = (i: number, j: number): number => j * xs.length + i;
  const points: Vec[] = ys.flatMap(y => xs.map((x): Vec => [x, y, 0]));
  const apexPoint: Vec = [2.3, 1.2, -2.5], apex = points.push(apexPoint) - 1;
  const triangles: [number, number, number][] = [], faceOfTriangle: number[] = [];
  for (let j = 0; j + 1 < ys.length; j += 1) for (let i = 0; i + 1 < xs.length; i += 1) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    if ((i + j) % 2 === 0) triangles.push([a, b, c], [a, c, d]);
    else triangles.push([a, b, d], [b, c, d]);
    faceOfTriangle.push(0, 0);
  }
  const last = { i: xs.length - 1, j: ys.length - 1 }, loop: [number, number, number][] = [];
  for (let i = 0; i < last.i; i += 1) loop.push([id(i, 0), id(i + 1, 0), 1]);
  for (let j = 0; j < last.j; j += 1) loop.push([id(last.i, j), id(last.i, j + 1), 2]);
  for (let i = last.i; i > 0; i -= 1) loop.push([id(i, last.j), id(i - 1, last.j), 3]);
  for (let j = last.j; j > 0; j -= 1) loop.push([id(0, j), id(0, j - 1), 4]);
  // The rectangle boundary runs counter-clockwise seen from +z, so each side fan reverses it.
  for (const [a, b, face] of loop) { triangles.push([apex, b, a]); faceOfTriangle.push(face); }
  const exact = faceIntegral(4 * 3, [0, 0, 1], [2, 1.5, 0]);
  return { solid: { name: 'plane', points, triangles, faceOfTriangle, faceKinds: ['plane', 'plane', 'plane', 'plane', 'plane'],
    interior: add(scale(0.25, apexPoint), scale(0.75, [2, 1.5, 0])), loadedFace: 0, fixedFace: 1, circumferentialSteps: [] },
  triangulated: exact, smooth: exact };
}

/** (b) Side of a radius-3 cylinder, z in [-1, 5], as a non-uniform polygonal prism: full turn N=30 or half turn N=26 on
 * [0, pi]. Each polygon side is one flat rectangle; its exact integrals are written with the side's angles only. */
export function cylinderPressureGeometry(full: boolean): PressureGeometry {
  const R = 3, z0 = -1, z1 = 5, L = z1 - z0;
  const angles = full ? nonuniformAngles(30, 2 * Math.PI, 0.35, 2.3, 0, true) : nonuniformAngles(26, Math.PI, 0.3, 1.7, 0, false);
  const m = angles.length;
  const points: Vec[] = [...angles.map((t): Vec => [R * Math.cos(t), R * Math.sin(t), z0]),
    ...angles.map((t): Vec => [R * Math.cos(t), R * Math.sin(t), z1])];
  const bottom = (k: number): number => k, top = (k: number): number => m + k;
  const triangles: [number, number, number][] = [], faceOfTriangle: number[] = [];
  for (let k = 0; k < (full ? m : m - 1); k += 1) {
    const n = (k + 1) % m;
    if (k % 2 === 0) triangles.push([bottom(k), bottom(n), top(n)], [bottom(k), top(n), top(k)]);
    else triangles.push([bottom(k), bottom(n), top(k)], [bottom(n), top(n), top(k)]);
    faceOfTriangle.push(0, 0);
  }
  for (let k = 1; k + 1 < m; k += 1) {
    triangles.push([top(0), top(k), top(k + 1)], [bottom(0), bottom(k + 1), bottom(k)]);
    faceOfTriangle.push(2, 1);
  }
  if (!full) {
    triangles.push([bottom(0), top(0), top(m - 1)], [bottom(0), top(m - 1), bottom(m - 1)]);
    faceOfTriangle.push(3, 3);
  }
  const sides = steps(angles, full).map((delta, k) => {
    const phi = angles[k] + delta / 2, inset = R * Math.cos(delta / 2);
    return faceIntegral(2 * R * Math.sin(delta / 2) * L, [Math.cos(phi), Math.sin(phi), 0],
      [inset * Math.cos(phi), inset * Math.sin(phi), (z0 + z1) / 2]);
  });
  // Smooth side over [a, b]: n = (cos t, sin t, 0), x = (R cos t, R sin t, z), dA = R dt dz.
  const a = 0, b = full ? 2 * Math.PI : Math.PI, z2 = (z1 * z1 - z0 * z0) / 2;
  const cc = (b - a) / 2 + (Math.sin(2 * b) - Math.sin(2 * a)) / 4, ss = (b - a) / 2 - (Math.sin(2 * b) - Math.sin(2 * a)) / 4;
  const sc = (Math.sin(b) ** 2 - Math.sin(a) ** 2) / 2, c1 = Math.sin(b) - Math.sin(a), s1 = Math.cos(a) - Math.cos(b);
  const smooth: FaceIntegrals = { area: R * L * (b - a), vectorArea: [R * L * c1, R * L * s1, 0],
    fluxTensor: [[R * R * L * cc, R * R * L * sc, R * c1 * z2], [R * R * L * sc, R * R * L * ss, R * s1 * z2], [0, 0, 0]] };
  return { solid: { name: full ? 'cylinder-full' : 'cylinder-half', points, triangles, faceOfTriangle,
    faceKinds: full ? ['cylinder', 'plane', 'plane'] : ['cylinder', 'plane', 'plane', 'plane'],
    interior: [0, full ? 0 : 0.4 * R, (z0 + z1) / 2], loadedFace: 0, fixedFace: 1, circumferentialSteps: steps(angles, full) },
  triangulated: sumIntegrals(sides), smooth };
}

/** (c) Cap of a radius-5 sphere (polar angle <= 1 rad) as a lat-long polyhedron: pole fan, rings at 0.3/0.62/1.0 rad,
 * K=28 non-uniform longitudes, alternating diagonals; closed by the flat ring polygon. The faceted cap is exact through
 * the divergence theorem on the closed polyhedron: T_cap = V I - T_bottom, with V from the pyramid and prismatoid
 * (Simpson) formulas and the bottom polygon's area and centroid; both are closed forms in the ring angles. */
export function sphereCapPressureGeometry(): PressureGeometry {
  const rho = 5, polar = [0.3, 0.62, 1], longitudes = nonuniformAngles(28, 2 * Math.PI, 0.3, 2.9, 1, true), K = longitudes.length;
  const points: Vec[] = [[0, 0, rho], ...polar.flatMap(beta => longitudes.map((l): Vec =>
    [rho * Math.sin(beta) * Math.cos(l), rho * Math.sin(beta) * Math.sin(l), rho * Math.cos(beta)]))];
  const ring = (j: number, k: number): number => 1 + j * K + (k % K);
  const triangles: [number, number, number][] = [], faceOfTriangle: number[] = [];
  for (let k = 0; k < K; k += 1) { triangles.push([0, ring(0, k), ring(0, k + 1)]); faceOfTriangle.push(0); }
  for (let j = 0; j + 1 < polar.length; j += 1) for (let k = 0; k < K; k += 1) {
    const u0 = ring(j, k), u1 = ring(j, k + 1), l0 = ring(j + 1, k), l1 = ring(j + 1, k + 1);
    if ((j + k) % 2 === 0) triangles.push([u0, l0, l1], [u0, l1, u1]);
    else triangles.push([u0, l0, u1], [u1, l0, l1]);
    faceOfTriangle.push(0, 0);
  }
  const J = polar.length - 1;
  for (let k = 1; k + 1 < K; k += 1) { triangles.push([ring(J, 0), ring(J, k + 1), ring(J, k)]); faceOfTriangle.push(1); }
  const delta = steps(longitudes, true), s = delta.reduce((total, d) => total + Math.sin(d), 0);
  const r = polar.map(beta => rho * Math.sin(beta)), h = polar.map(beta => rho * Math.cos(beta));
  let volume = (rho - h[0]) * (r[0] ** 2 * s / 2) / 3;
  for (let j = 0; j < J; j += 1) volume += (h[j] - h[j + 1]) / 6 * (s / 2) * (r[j] ** 2 + r[j + 1] ** 2 + (r[j] + r[j + 1]) ** 2);
  const edge = r[J], bottomArea = edge * edge * s / 2;
  const fan = (f: (angle: number) => number): number => delta.reduce((total, d, k) =>
    total + 0.5 * edge * edge * Math.sin(d) * edge * (f(longitudes[k]) + f(longitudes[(k + 1) % K])) / 3, 0) / bottomArea;
  const bottom = faceIntegral(bottomArea, [0, 0, -1], [fan(l => Math.cos(l)), fan(l => Math.sin(l)), h[J]]);
  const alpha = polar[J], cosA = Math.cos(alpha);
  const t11 = Math.PI * rho ** 3 * (2 / 3 - cosA + cosA ** 3 / 3), t33 = 2 * Math.PI * rho ** 3 * (1 - cosA ** 3) / 3;
  return { solid: { name: 'sphere-cap', points, triangles, faceOfTriangle, faceKinds: ['sphere', 'plane'],
    interior: [0, 0, 3.5], loadedFace: 0, fixedFace: 1, circumferentialSteps: delta },
  triangulated: { area: null, vectorArea: scale(-1, bottom.vectorArea),
    fluxTensor: matAdd(matScale(volume, IDENTITY), matScale(-1, bottom.fluxTensor)) },
  smooth: { area: 2 * Math.PI * rho * rho * (1 - cosA), vectorArea: [0, 0, Math.PI * (rho * Math.sin(alpha)) ** 2],
    fluxTensor: [[t11, 0, 0], [0, t11, 0], [0, 0, t33]] } };
}

/** x' = R x + t, n' = R n: S' = R S, T' = R T R^T + S' (x) t. */
export function placeIntegrals(face: FaceIntegrals, placement: Placement): FaceIntegrals {
  const vectorArea = matVec(placement.rotation, face.vectorArea);
  return { area: face.area, vectorArea, fluxTensor: matAdd(matMul(matMul(placement.rotation, face.fluxTensor),
    transpose(placement.rotation)), outer(vectorArea, placement.translation)) };
}
export interface PressureResultants { readonly force: Vec; readonly moment: Vec; readonly work: readonly number[] }
/** Dead pressure p on outward n: force -p S, moment about the origin -p integral x cross n dA, work -p integral n.u dA. */
export function independentResultants(face: FaceIntegrals, pressureMPa: number, fields: readonly LinearField[]): PressureResultants {
  const T = face.fluxTensor;
  const moment: Vec = [T[2][1] - T[1][2], T[0][2] - T[2][0], T[1][0] - T[0][1]];
  return { force: scale(-pressureMPa, face.vectorArea), moment: scale(-pressureMPa, moment),
    work: fields.map(field => -pressureMPa * (dot(field.gradient[0], T[0]) + dot(field.gradient[1], T[1])
      + dot(field.gradient[2], T[2]) + dot(field.offset, face.vectorArea))) };
}
/** Resultants of the nodal loads the public translation assembles from the prepared surface loads. */
export function nodalResultants(input: SolidAnalysisInput, fields: readonly LinearField[]): PressureResultants {
  const { plan } = translateSolidAnalysis(input);
  let force: Vec = [0, 0, 0], moment: Vec = [0, 0, 0];
  const work = fields.map(() => 0);
  plan.forcesN.forEach((f, node) => {
    const x = input.nodes[node];
    force = add(force, f); moment = add(moment, cross(x, f));
    fields.forEach((field, index) => { work[index] += dot(f, fieldAt(field, x)); });
  });
  return { force, moment, work };
}
/** Relative error; a (near-)zero expectation is divided by the representative magnitude instead and says so. */
export function relativeError(actual: Vec | number, expected: Vec | number, representative: number):
  { readonly error: number; readonly denominator: 'expected' | 'representative' } {
  const a: Vec = typeof actual === 'number' ? [actual, 0, 0] : actual, e: Vec = typeof expected === 'number' ? [expected, 0, 0] : expected;
  const size = norm(e), zero = size < 1e-9 * representative;
  return { error: norm(sub(a, e)) / (zero ? representative : size), denominator: zero ? 'representative' : 'expected' };
}

const ROLES = ['top', 'bottom', 'front', 'right', 'back', 'left'] as const;
const faceOrigin = (role: typeof ROLES[number]): SubShapeOrigin =>
  ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'solid', role } });
export interface PressureCase {
  readonly context: CadTetraContext;
  readonly mesh: TetraMeshResult;
  readonly regions: readonly CadTetraRegion[];
  readonly labelFaces: readonly number[];
  readonly points: readonly Vec[];
  readonly interior: Vec;
  readonly reference: (face: number) => SubShapeRef;
}
/** Convex boundary + one interior node -> positive star tet4 chain through the actual mesh validators. */
export async function buildPressureCase(solid: PressureSolid, placement: Placement): Promise<PressureCase> {
  const points = solid.points.map(p => add(matVec(placement.rotation, p), placement.translation));
  const interior = add(matVec(placement.rotation, solid.interior), placement.translation);
  const triangles = solid.triangles.flat(), tags = solid.triangles.map((_, index) => index);
  const source = { documentId: 'pressure-work', revision: 3, featureId: 'solid', bodyKey: 'solid:3' };
  const input = readTetraMeshInput({ schema: TETRA_MESH_SCHEMA, source, units: 'mm', coordinates: points.flat(),
    triangles, tags, tagCount: tags.length });
  const hash = await tetraMeshInputSha256(input), center = points.length;
  const mesh = decodeTetraMesh({ coordinates: [...points.flat(), ...interior],
    tetrahedra: solid.triangles.flatMap(([a, b, c]) => [center, a, b, c]), boundaryTriangles: triangles, boundaryTags: tags },
  input, hash);
  const faceCount = solid.faceKinds.length;
  const body: SolidBody = { featureId: 'solid', bodyKind: 'solid', isValid: true, volume: mesh.volumeMm3,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: solid.faceKinds.map((surfaceKind, index): SolidBody['faces'][number] => ({ index, surfaceKind,
      area: 1, centroid: [0, 0, 0], axis: null, radius: null, triangleOffset: 0,
      triangleCount: solid.faceOfTriangle.filter(face => face === index).length })),
    origins: { version: 1, state: 'tracked', bindings: ROLES.slice(0, faceCount).map((role, index) => ({
      origin: faceOrigin(role), state: 'unique', current: { kind: 'face', index } })) } };
  const reference = (face: number): SubShapeRef => {
    const found = createSubShapeReference(body, 'face', face);
    if (found?.origin === undefined) throw new Error('Missing fixture origin');
    return found;
  };
  const regions = Array.from({ length: faceCount }, (_, face): CadTetraRegion => ({ tag: face, reference: reference(face),
    triangleIndices: solid.faceOfTriangle.flatMap((owner, index) => owner === face ? [index] : []) }));
  return { context: { documentId: source.documentId, revision: source.revision, body,
    steps: [{ featureId: 'solid', key: source.bodyKey }] }, mesh, regions, labelFaces: solid.faceOfTriangle, points, interior,
  reference };
}
export function pressureSettings(value: PressureCase, solid: PressureSolid, pressureMPa: number): CadSolidPressureSettings {
  return { material: { id: 'steel', youngMPa: 210000, poisson: 0.3 }, fixedFaces: [value.reference(solid.fixedFace)],
    loadedFaces: [value.reference(solid.loadedFace)], pressureMPa, numericBudgetBytes: 16 * 1024 * 1024,
    geometry: { kind: 'planar', boundary: { boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 } } };
}
