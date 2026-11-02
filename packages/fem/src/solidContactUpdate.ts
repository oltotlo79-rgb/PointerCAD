import { InputIssue, SOLID_CONTACT_LIMITS, type Vector3 } from '@pointercad/model/beam-analysis';
import { determinant3, multiply3, transpose3, type Matrix3 } from './finiteKinematics.js';
import type { SolidContactPlan, SolidContactPlanFace } from './solidContactModel.js';
import { projectContactPoint, searchContactFacets, type ContactFacetLocation,
  type SolidContactFacetCandidate, type SolidContactSearchMesh } from './solidContactSearch.js';

/** Internal material-point state, not a saved document or a solved native result.
 * conditionKey belongs to the caller and pins the law, quadrature area and other
 * non-geometric conditions. Changing them requires a separate history transfer. */
export interface ContactMaterialPoint {
  readonly materialPointId: string;
  readonly contactId: string;
  readonly conditionKey: string;
  readonly master: ContactFacetLocation;
  readonly slave: ContactFacetLocation;
  readonly normal: Vector3;
  readonly elasticSlipMm: Vector3;
  readonly tangentialTractionMPa: Vector3;
  readonly areaMm2: number;
  readonly accumulatedDissipationNmm: number;
}
export interface ContactGeometryUpdateOptions {
  readonly searchDistanceMm: number;
  readonly representativeLengthMm: number;
  /** Actual incremental frame rotation, including in-plane spin. Normals alone do not determine it. */
  readonly incrementalRotation: Matrix3;
  readonly conditionKey: string;
}
export interface ContactMaterialPointUpdate {
  readonly point: ContactMaterialPoint;
  /** Objective tangential displacement relative to the advected OLD master material point. */
  readonly relativeIncrementMm: Vector3;
  readonly geometricDistanceMm: number;
  readonly signedSeparationMm: number;
  readonly declaredInitialGapMm: number;
}
export interface ContactVirtualWork {
  readonly nodalForcesN: readonly [Vector3, Vector3, Vector3];
  readonly pointDisplacementMm: Vector3;
  readonly resultantForceN: Vector3;
  readonly pointWorkNmm: number;
  readonly nodalWorkNmm: number;
}

type Triangle = readonly [Vector3, Vector3, Vector3];
const FRAME_TOLERANCE = 1e-12;
const GEOMETRY_RELATIVE_TOLERANCE = 1e-12;
const copy = (value: Vector3): Vector3 => [value[0], value[1], value[2]];
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function refuse(code: string, path: string, reason: string): never { throw new InputIssue(code, path, reason); }
function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) refuse('contact-history-numeric', path, 'Expected a finite contact-history value');
  return value;
}
function dense(value: readonly unknown[], length: number, path: string): void {
  if (!Array.isArray(value) || value.length !== length) refuse('contact-history-shape', path, 'Expected a dense array of the stated length');
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) refuse('contact-history-shape', path, 'Sparse history arrays are not supported');
  }
}
function vector(value: readonly number[], path: string): Vector3 {
  dense(value, 3, path);
  return [finite(value[0], path), finite(value[1], path), finite(value[2], path)];
}
function key(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) refuse('contact-history-identity', path, 'Expected a nonempty material/contact/condition identity');
  return value;
}
function rotation(value: Matrix3, path: string): Matrix3 {
  dense(value, 3, path);
  const matrix: Matrix3 = [vector(value[0], path), vector(value[1], path), vector(value[2], path)];
  const metric = multiply3(transpose3(matrix), matrix), determinant = finite(determinant3(matrix), path);
  if (metric.some((row, i) => row.some((entry, j) => !Number.isFinite(entry)
    || Math.abs(entry - (i === j ? 1 : 0)) > FRAME_TOLERANCE)) || Math.abs(determinant - 1) > FRAME_TOLERANCE) {
    refuse('contact-history-rotation', path, 'An explicit proper orthogonal rotation is required');
  }
  return matrix;
}
function rotate(matrix: Matrix3, value: Vector3, path: string): Vector3 {
  return vector([dot(matrix[0], value), dot(matrix[1], value), dot(matrix[2], value)], path);
}
function unitNormal(value: Vector3, path: string): Vector3 {
  const normal = vector(value, path);
  if (Math.abs(Math.hypot(...normal) - 1) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
    refuse('contact-history-normal', path, 'History requires the unchanged unit normal, not normalization');
  }
  return normal;
}
function tangent(value: Vector3, normal: Vector3, path: string): Vector3 {
  const result = vector(value, path), length = finite(Math.hypot(...result), path);
  if (Math.abs(finite(dot(result, normal), path)) > FRAME_TOLERANCE * length) {
    refuse('contact-history-tangent', path, 'Stored tangential history must lie in its previous tangent plane');
  }
  return result;
}
function readLocation(value: ContactFacetLocation, path: string): ContactFacetLocation {
  if (value === null || typeof value !== 'object') return refuse('contact-history-shape', path, 'Expected a material-point location');
  const bodyFeatureId = key(value.bodyFeatureId, `${path}.body`), faceKey = key(value.faceKey, `${path}.face`);
  if (!Number.isSafeInteger(value.triangleIndex) || value.triangleIndex < 0) {
    refuse('contact-history-topology', path, 'Expected an existing body-local triangle index');
  }
  dense(value.nodeIndices, 3, `${path}.nodes`);
  if (value.nodeIndices.some(node => !Number.isSafeInteger(node) || node < 0) || new Set(value.nodeIndices).size !== 3) {
    refuse('contact-history-topology', path, 'Expected three distinct body-local nodes');
  }
  const barycentric = vector(value.barycentric, `${path}.barycentric`);
  if (barycentric.some(weight => weight < 0 || weight > 1) || Math.abs(barycentric[0] + barycentric[1] + barycentric[2] - 1) > FRAME_TOLERANCE) {
    refuse('contact-history-barycentric', path, 'Material-point weights must form a convex partition of unity');
  }
  return { bodyFeatureId, faceKey, triangleIndex: value.triangleIndex,
    nodeIndices: [value.nodeIndices[0], value.nodeIndices[1], value.nodeIndices[2]],
    barycentric, pointMm: vector(value.pointMm, `${path}.point`) };
}
function currentTriangle(location: ContactFacetLocation, face: SolidContactPlanFace,
  meshes: readonly SolidContactSearchMesh[], path: string): Triangle {
  if (location.bodyFeatureId !== face.bodyFeatureId || location.faceKey !== face.faceKey
    || !face.triangleIndices.includes(location.triangleIndex)) {
    return refuse('contact-history-topology', path, 'The same material face and triangle must remain in the explicit contact');
  }
  const mesh = meshes.find(item => item.boundaryIdentity.bodyFeatureId === location.bodyFeatureId);
  if (mesh === undefined) return refuse('contact-history-topology', path, 'The original body boundary is missing');
  const start = 3 * location.triangleIndex;
  if (location.nodeIndices.some((node, index) => mesh.triangles[start + index] !== node)) {
    refuse('contact-history-topology', path, 'The original ordered triangle connectivity changed; remeshing needs a separate transfer');
  }
  const vertex = (node: number): Vector3 => vector(mesh.coordinates.slice(3 * node, 3 * node + 3), path);
  return [vertex(location.nodeIndices[0]), vertex(location.nodeIndices[1]), vertex(location.nodeIndices[2])];
}
function interpolate(triangle: Triangle, weights: Vector3, path: string): Vector3 {
  return vector(triangle[0].map((entry, axis) => entry + weights[1] * (triangle[1][axis] - entry)
    + weights[2] * (triangle[2][axis] - entry)), path);
}
function movedLocation(location: ContactFacetLocation, triangle: Triangle, path: string): ContactFacetLocation {
  return { ...readLocation(location, path), pointMm: interpolate(triangle, location.barycentric, path) };
}
interface PointCandidate {
  readonly candidate: SolidContactFacetCandidate;
  readonly master: ContactFacetLocation;
  readonly distanceMm: number;
}
function chooseProjection(candidates: readonly SolidContactFacetCandidate[], slave: ContactFacetLocation,
  face: SolidContactPlanFace, meshes: readonly SolidContactSearchMesh[], options: ContactGeometryUpdateOptions,
  contactId: string, path: string): PointCandidate {
  const projected: PointCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.contactId !== contactId || candidate.slave.bodyFeatureId !== slave.bodyFeatureId
      || candidate.slave.faceKey !== slave.faceKey || candidate.slave.triangleIndex !== slave.triangleIndex) continue;
    const triangle = currentTriangle(candidate.master, face, meshes, path);
    // The facet-pair closest point is NOT this fixed slave material point.
    const projection = projectContactPoint(slave.pointMm, triangle, path);
    if (projection.distanceMm <= options.searchDistanceMm) {
      projected.push({ candidate, master: { ...readLocation(candidate.master, path),
        barycentric: copy(projection.barycentric), pointMm: copy(projection.pointMm) }, distanceMm: projection.distanceMm });
    }
  }
  projected.sort((a, b) => a.distanceMm - b.distanceMm || a.master.triangleIndex - b.master.triangleIndex);
  const closest = projected[0];
  if (closest === undefined) return refuse('contact-history-search', path, 'The fixed slave material point has no master within the search distance');
  const distanceTolerance = GEOMETRY_RELATIVE_TOLERANCE * options.representativeLengthMm;
  for (const alternative of projected.slice(1)) {
    if (alternative.distanceMm - closest.distanceMm > distanceTolerance) break;
    const commonPoint = Math.hypot(...subtract(alternative.master.pointMm, closest.master.pointMm)) <= distanceTolerance;
    const commonBoundary = alternative.master.barycentric.some(weight => weight <= FRAME_TOLERANCE)
      && closest.master.barycentric.some(weight => weight <= FRAME_TOLERANCE);
    if (!commonPoint || !commonBoundary
      || Math.hypot(...subtract(alternative.candidate.masterNormal, closest.candidate.masterNormal)) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
      refuse('contact-history-ambiguous', path, 'Only a common coplanar facet boundary has an unambiguous equal-distance history mapping');
    }
  }
  return closest;
}

/** W21-A geometry-only transport in N-mm-MPa. Explicit frame rotation preserves
 * tangential length/work, and geometry alone never adds friction dissipation.
 * Same-face facet crossings are supported; remeshing, area/law changes, native
 * commit/rollback and the global geometric tangent remain separate work. */
export function updateContactGeometry(previous: ContactMaterialPoint, plan: SolidContactPlan,
  meshes: readonly SolidContactSearchMesh[], options: ContactGeometryUpdateOptions): ContactMaterialPointUpdate {
  const path = 'contact-history-update';
  const materialPointId = key(previous.materialPointId, `${path}.materialPointId`), contactId = key(previous.contactId, `${path}.contactId`);
  const conditionKey = key(previous.conditionKey, `${path}.conditionKey`);
  if (conditionKey !== key(options.conditionKey, `${path}.currentConditionKey`)) {
    refuse('contact-history-condition', path, 'Conditions changed; the previous history cannot be silently reused');
  }
  const representativeLengthMm = finite(options.representativeLengthMm, `${path}.representativeLengthMm`);
  if (!(representativeLengthMm > 0)) refuse('contact-history-scale', path, 'A positive representative length in mm is required');
  const matrix = rotation(options.incrementalRotation, `${path}.rotation`), previousNormal = unitNormal(previous.normal, `${path}.normal`);
  const oldElasticSlip = tangent(previous.elasticSlipMm, previousNormal, `${path}.elasticSlipMm`);
  const oldTraction = tangent(previous.tangentialTractionMPa, previousNormal, `${path}.tractionMPa`);
  const areaMm2 = finite(previous.areaMm2, `${path}.areaMm2`), accumulatedDissipationNmm = finite(previous.accumulatedDissipationNmm, `${path}.dissipation`);
  if (!(areaMm2 > 0) || accumulatedDissipationNmm < 0) refuse('contact-history-state', path, 'Area must be positive and accumulated dissipation nonnegative');
  const masterBefore = readLocation(previous.master, `${path}.master`), slaveBefore = readLocation(previous.slave, `${path}.slave`);
  // W17 validates current body/face ownership, outward geometry and declared normals.
  const candidates = searchContactFacets(plan, meshes, options.searchDistanceMm, `${path}.search`);
  const pair = plan.contacts.find(item => item.id === contactId);
  if (pair === undefined) return refuse('contact-history-identity', path, 'The previous explicit contact is absent');
  const masterAdvected = movedLocation(masterBefore, currentTriangle(masterBefore, pair.master, meshes, path), path);
  const slave = movedLocation(slaveBefore, currentTriangle(slaveBefore, pair.slave, meshes, path), path);
  const chosen = chooseProjection(candidates, slave, pair.master, meshes, options, contactId, path);
  const normal = unitNormal(chosen.candidate.masterNormal, `${path}.currentNormal`), rotatedNormal = rotate(matrix, previousNormal, path);
  if (Math.hypot(...subtract(rotatedNormal, normal)) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
    refuse('contact-history-rotation', path, 'The supplied frame rotation does not map the old normal to the current normal');
  }
  // Compare with the OLD master material point, advected with its body. Using
  // only the new projection would incorrectly erase sliding along a flat face.
  const oldSeparation = vector(subtract(slaveBefore.pointMm, masterBefore.pointMm), path);
  const currentRelative = vector(subtract(slave.pointMm, masterAdvected.pointMm), path);
  const objective = vector(subtract(currentRelative, rotate(matrix, oldSeparation, path)), path);
  const normalIncrement = finite(dot(objective, normal), path);
  const relativeIncrementMm = vector(objective.map((entry, axis) => entry - normalIncrement * normal[axis]), path);
  const elasticSlipMm = tangent(rotate(matrix, oldElasticSlip, path), normal, path);
  const tangentialTractionMPa = tangent(rotate(matrix, oldTraction, path), normal, path);
  const signedSeparationMm = finite(dot(subtract(slave.pointMm, chosen.master.pointMm), normal), path);
  return { point: { materialPointId, contactId, conditionKey, master: chosen.master, slave,
    normal: copy(normal), elasticSlipMm, tangentialTractionMPa, areaMm2, accumulatedDissipationNmm },
  relativeIncrementMm, geometricDistanceMm: chosen.distanceMm, signedSeparationMm,
  declaredInitialGapMm: chosen.candidate.declaredInitialGapMm };
}

/** P1 point-to-node force transfer and its exact discrete virtual-work dual.
 * Values are a geometry check, not computed support reactions. Apply +F/-F on
 * the two sides to compare action/reaction; no history or energy is modified. */
export function contactPointVirtualWork(location: ContactFacetLocation, pointForceN: Vector3,
  nodalVirtualDisplacementsMm: readonly [Vector3, Vector3, Vector3]): ContactVirtualWork {
  const path = 'contact-history-work', bound = readLocation(location, path), force = vector(pointForceN, path);
  dense(nodalVirtualDisplacementsMm, 3, path);
  const displacements: Triangle = [vector(nodalVirtualDisplacementsMm[0], path),
    vector(nodalVirtualDisplacementsMm[1], path), vector(nodalVirtualDisplacementsMm[2], path)];
  const at = (index: number): Vector3 => vector(force.map(entry => entry * bound.barycentric[index]), path);
  const nodalForcesN: Triangle = [at(0), at(1), at(2)];
  const pointDisplacementMm = vector([0, 1, 2].map(axis => displacements.reduce((sum, value, index) =>
    sum + bound.barycentric[index] * value[axis], 0)), path);
  const resultantForceN = vector([0, 1, 2].map(axis => nodalForcesN.reduce((sum, value) => sum + value[axis], 0)), path);
  const pointWorkNmm = finite(dot(force, pointDisplacementMm), path);
  const nodalWorkNmm = finite(nodalForcesN.reduce((sum, value, index) => sum + dot(value, displacements[index]), 0), path);
  return { nodalForcesN, pointDisplacementMm, resultantForceN, pointWorkNmm, nodalWorkNmm };
}
