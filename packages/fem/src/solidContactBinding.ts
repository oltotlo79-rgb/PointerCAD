import { subVec3 as subtract, dotVec3 as dot, crossVec3 as cross } from '@pointercad/model/vec3';
import type { Vector3 } from '@pointercad/model/beam-analysis';
import type { CadSolidContactBodySource, CadSolidContactPrepared } from './cadSolidContact.js';
import { projectContactPoint } from './solidContactSearch.js';
import { isTetraMeshResult, tetraMeshInputSha256, type TetraMeshResult } from './tetraMesh.js';
import { sha256Hex } from './sha256.js';
import { createPrefixedError, isRecord } from './valueGuards.js';

export const SOLID_CONTACT_WIRE_SCHEMA = 'pointercad-solid-contact/1';
 interface SolidContactMeshSource { readonly bodyFeatureId: string; readonly mesh: TetraMeshResult }
export interface SolidContactHistory {
  readonly node: number;
  readonly axis: 0 | 1 | 2;
  readonly values: readonly number[];
}
export interface SolidContactPatchChoice {
  readonly contactId: string;
  readonly masterTriangle: number;
  readonly slaveTriangle: number;
  readonly knNPerMm3: number;
  readonly ktNPerMm3: number;
  readonly referenceLengthMm: number;
  readonly referenceForceN: number;
  readonly source: string;
}
export interface SolidContactSolveSettings {
  readonly material: { readonly youngMPa: number; readonly poisson: number; readonly source: string };
  readonly prescribed: readonly SolidContactHistory[];
  readonly loads: readonly SolidContactHistory[];
  readonly steps: number;
  readonly maxIterations: number;
  readonly source: string;
  readonly patches: readonly SolidContactPatchChoice[];
}
 interface SolidContactPatch extends SolidContactPatchChoice {
  readonly id: string;
  readonly masterBody: string;
  readonly slaveBody: string;
  readonly masterFace: string;
  readonly slaveFace: string;
  readonly masterNodes: readonly [number, number, number];
  readonly slaveNodes: readonly [number, number, number];
  readonly normal: Vector3;
  readonly initialGapMm: number;
  readonly mu: number | null;
  readonly sourceId: string | null;
}
 interface SolidContactSource {
  readonly documentId: string;
  readonly revision: number;
  readonly bodies: readonly CadSolidContactBodySource[];
}
/** Owned JSON input. The preparation's exact JSON and each actual volume mesh
 * accompany their hashes; a digest label alone is never treated as evidence. */
export interface SolidContactInput {
  readonly schema: typeof SOLID_CONTACT_WIRE_SCHEMA;
  readonly units: 'N-mm-MPa';
  readonly source: SolidContactSource;
  readonly preparationJson: string;
  readonly preparationSha256: string;
  readonly meshes: readonly SolidContactMeshSource[];
  readonly nodes: readonly Vector3[];
  readonly elements: readonly (readonly [number, number, number, number])[];
  readonly bodies: readonly { readonly id: string; readonly nodes: readonly number[] }[];
  readonly material: SolidContactSolveSettings['material'];
  readonly prescribed: readonly SolidContactHistory[];
  readonly loads: readonly SolidContactHistory[];
  readonly steps: number;
  readonly maxIterations: number;
  readonly solveSource: string;
  readonly patches: readonly SolidContactPatch[];
}
 type SolidContactStatus = 'open' | 'stick' | 'slip' | 'frictionless';
 interface SolidContactPointResult {
  readonly point: number;
  readonly status: SolidContactStatus;
  readonly gapMm: number;
  readonly pressureMPa: number;
  readonly normalForceN: number;
  readonly tangentialForceN: Vector3;
  readonly elasticSlipMm: Vector3;
  readonly addedDissipationNmm: number;
  readonly accumulatedDissipationNmm: number;
  readonly elasticEnergyNmm: number;
  readonly releasedElasticEnergyNmm: number;
  readonly areaMm2: number;
  readonly pressureGapNPerMm: number;
  readonly forceGapNmm: number;
  readonly dimensionlessForceGap: number;
}
 interface SolidContactCallbacks { readonly tangent: number; readonly residual: number; readonly evaluations: number }
 interface SolidContactStepResult {
  readonly step: number;
  readonly displacementMm: readonly Vector3[];
  readonly internalForcesN: readonly Vector3[];
  readonly externalForcesN: readonly Vector3[];
  readonly freeResidual: number;
  readonly nativeEquationCount: number;
  readonly nativeCallbacks: SolidContactCallbacks;
  readonly patches: readonly { readonly id: string; readonly normalResultantN: number; readonly points: readonly SolidContactPointResult[] }[];
}
export interface SolidContactResult {
  readonly kind: 'solid-contact-analysis';
  readonly schema: typeof SOLID_CONTACT_WIRE_SCHEMA;
  readonly units: 'N-mm-MPa';
  readonly source: SolidContactSource;
  readonly inputSha256: string;
  readonly preparationSha256: string;
  readonly iterationLimit: number;
  readonly nativeIterationCount: null;
  readonly strictComplementarityQualified: false;
  readonly steps: readonly SolidContactStepResult[];
}
export interface SolidContactFailureDiagnostics {
  readonly schema: typeof SOLID_CONTACT_WIRE_SCHEMA;
  readonly inputSha256: string;
  readonly preparationSha256: string;
  readonly source: SolidContactSource;
  readonly step: number | null;
  readonly reason: string;
  readonly iterationLimit: number;
  readonly nativeIterationCount: null;
  readonly nativeCallbacks: SolidContactCallbacks | null;
  /** Bounded verbatim JSON of the native failure/last accepted record. */
  readonly rawBeforeFailure: string;
  readonly rawTruncated: boolean;
}

const fail: (message: string) => never = createPrefixedError('solid-contact');
function plainJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 64) fail('JSON data nesting exceeds the contact contract');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { number(value); return; }
  if (typeof value !== 'object' || ancestors.has(value)) fail('Only acyclic plain JSON data is accepted');
  const entries = Array.isArray(value) ? array(value, 0, 5_000_000) : Object.values(record(value));
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail('Array has additional properties');
  ancestors.add(value);
  for (const entry of entries) plainJson(entry, ancestors, depth + 1);
  ancestors.delete(value);
}
function record(value: unknown, names?: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail('Expected an object');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('Expected a plain JSON object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value'))) fail('Expected plain data fields');
  if (names !== undefined && (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name)))) {
    fail('Object fields differ from the contact contract');
  }
  return value;
}
function array(value: unknown, minimum = 0, maximum = 200_000): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail('Invalid array extent');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) fail('Expected dense data arrays');
  }
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('Expected a finite number');
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail('Integer outside contact range');
  return result;
}
function positive(value: unknown): number { const result = number(value); if (result <= 0) fail('Expected positive value'); return result; }
function nonnegative(value: unknown): number { const result = number(value); if (result < 0) fail('Expected nonnegative value'); return result; }
function text(value: unknown, maximum = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > maximum) fail('Explicit bounded identity/source required');
  return value;
}
function hash(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/u.test(result)) fail('Invalid SHA256'); return result; }
function vector(value: unknown): Vector3 {
  const result = array(value, 3, 3); return [number(result[0]), number(result[1]), number(result[2])];
}
function triple(value: unknown, count: number): [number, number, number] {
  const result = array(value, 3, 3).map(item => integer(item, 0, count - 1));
  if (new Set(result).size !== 3) fail('Repeated facet node');
  return [result[0], result[1], result[2]];
}
function equal(actual: unknown, expected: unknown, reason: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(reason);
}
function readSource(value: unknown): SolidContactSource {
  const row = record(value, ['documentId', 'revision', 'bodies']);
  const seen = new Set<string>();
  const bodies = array(row.bodies, 1, 1000).map(item => {
    const body = record(item, ['bodyFeatureId', 'bodyKey', 'inputSha256', 'meshSha256']);
    const bodyFeatureId = text(body.bodyFeatureId);
    if (seen.has(bodyFeatureId)) fail('Repeated source body');
    seen.add(bodyFeatureId);
    return { bodyFeatureId, bodyKey: text(body.bodyKey), inputSha256: hash(body.inputSha256), meshSha256: hash(body.meshSha256) };
  });
  return { documentId: text(row.documentId, 256), revision: integer(row.revision, 0, Number.MAX_SAFE_INTEGER), bodies };
}
function histories(value: unknown, nodeCount: number, steps: number, used: Set<string>): SolidContactHistory[] {
  return array(value, 0, nodeCount * 3).map(item => {
    const row = record(item, ['node', 'axis', 'values']), node = integer(row.node, 0, nodeCount - 1);
    if (row.axis !== 0 && row.axis !== 1 && row.axis !== 2) fail('Unknown history direction');
    const axis = row.axis, key = `${node}:${axis}`;
    if (used.has(key)) fail('Repeated or conflicting displacement/load DOF');
    used.add(key);
    return { node, axis, values: array(row.values, steps, steps).map(number) };
  });
}
function meshPayload(mesh: TetraMeshResult): object {
  return { coordinates: mesh.coordinates, tetrahedra: mesh.tetrahedra,
    boundaryTriangles: mesh.boundaryTriangles, boundaryTags: mesh.boundaryTags };
}
function readPatch(value: unknown, meshes: readonly SolidContactMeshSource[]): SolidContactPatch {
  const row = record(value, ['id', 'contactId', 'masterTriangle', 'slaveTriangle', 'masterBody', 'slaveBody',
    'masterFace', 'slaveFace', 'masterNodes', 'slaveNodes', 'normal', 'initialGapMm', 'knNPerMm3', 'ktNPerMm3',
    'referenceLengthMm', 'referenceForceN', 'source', 'mu', 'sourceId']);
  const masterBody = text(row.masterBody), slaveBody = text(row.slaveBody);
  const master = meshes.find(item => item.bodyFeatureId === masterBody)?.mesh;
  const slave = meshes.find(item => item.bodyFeatureId === slaveBody)?.mesh;
  if (master === undefined || slave === undefined) fail('Patch body absent from current meshes');
  const masterTriangle = integer(row.masterTriangle, 0, master.boundaryTriangles.length / 3 - 1);
  const slaveTriangle = integer(row.slaveTriangle, 0, slave.boundaryTriangles.length / 3 - 1);
  const masterNodes = triple(row.masterNodes, master.coordinates.length / 3), slaveNodes = triple(row.slaveNodes, slave.coordinates.length / 3);
  equal(masterNodes, master.boundaryTriangles.slice(3 * masterTriangle, 3 * masterTriangle + 3), 'Master facet order differs');
  equal(slaveNodes, slave.boundaryTriangles.slice(3 * slaveTriangle, 3 * slaveTriangle + 3), 'Slave facet order differs');
  const normal = vector(row.normal);
  if (Math.abs(Math.hypot(...normal) - 1) > 1e-12) fail('Expected a unit contact direction');
  const coordinates = (mesh: TetraMeshResult, ids: readonly number[]): Vector3[] => ids.map(id =>
    [mesh.coordinates[3 * id], mesh.coordinates[3 * id + 1], mesh.coordinates[3 * id + 2]]);
  const masterPoints = coordinates(master, masterNodes), slavePoints = coordinates(slave, slaveNodes);
  const faceNormal = (points: readonly Vector3[]): Vector3 => {
    const area = cross(subtract(points[1], points[0]), subtract(points[2], points[0])), length = Math.hypot(...area);
    if (!(Number.isFinite(length) && length > 0)) fail('Degenerate contact facet');
    return [area[0] / length, area[1] / length, area[2] / length];
  };
  if (Math.abs(Math.abs(dot(faceNormal(masterPoints), normal)) - 1) > 1e-12
    || Math.abs(Math.abs(dot(faceNormal(slavePoints), normal)) - 1) > 1e-12) fail('Only fixed parallel facets are supported');
  // Same-partition mapping: every projected slave vertex is a distinct master
  // vertex. This deliberately refuses partial intersections and mesh remeshing.
  const projectedVertices = new Set<number>();
  for (const point of slavePoints) {
    const distance = dot(subtract(point, masterPoints[0]), normal);
    const projected: Vector3 = [point[0] - distance * normal[0], point[1] - distance * normal[1], point[2] - distance * normal[2]];
    const projection = projectContactPoint(projected, masterPoints), weights = projection.barycentric;
    const scale = Math.max(...masterPoints.map(point => Math.hypot(...subtract(point, masterPoints[0]))));
    if (projection.distanceMm > 1e-10 * scale) fail('Projected slave vertex lies outside the master facet');
    const vertex = weights.findIndex(weight => Math.abs(weight - 1) <= 1e-10);
    if (vertex < 0 || weights.some((weight, index) => index !== vertex && Math.abs(weight) > 1e-10)
      || projectedVertices.has(vertex)) fail('Contact requires an explicit complete same-partition facet pair');
    projectedVertices.add(vertex);
  }
  const mu = row.mu === null ? null : nonnegative(row.mu), sourceId = row.sourceId === null ? null : text(row.sourceId);
  if ((mu === null) !== (sourceId === null)) fail('Friction coefficient and its source must be supplied together');
  if (masterBody === slaveBody && (row.masterFace === row.slaveFace || masterTriangle === slaveTriangle)) fail('A facet cannot contact itself');
  return { id: text(row.id), contactId: text(row.contactId), masterTriangle, slaveTriangle, masterBody, slaveBody,
    masterFace: text(row.masterFace), slaveFace: text(row.slaveFace), masterNodes, slaveNodes, normal,
    initialGapMm: number(row.initialGapMm), knNPerMm3: positive(row.knNPerMm3), ktNPerMm3: positive(row.ktNPerMm3),
    referenceLengthMm: positive(row.referenceLengthMm), referenceForceN: positive(row.referenceForceN), source: text(row.source), mu, sourceId };
}

/** Synchronous admission validates every numeric/coverage field. Hash evidence
 * is checked separately by verifySolidContactInput before execution/publication. */
export function readSolidContactAnalysisInput(value: unknown): SolidContactInput {
  plainJson(value);
  const row = record(value, ['schema', 'units', 'source', 'preparationJson', 'preparationSha256', 'meshes', 'nodes',
    'elements', 'bodies', 'material', 'prescribed', 'loads', 'steps', 'maxIterations', 'solveSource', 'patches']);
  if (row.schema !== SOLID_CONTACT_WIRE_SCHEMA || row.units !== 'N-mm-MPa') fail('Unsupported contact schema/units');
  const source = readSource(row.source), preparationSha256 = hash(row.preparationSha256);
  if (typeof row.preparationJson !== 'string' || row.preparationJson.length > 64_000_000) fail('Missing bounded preparation JSON');
  const preparationJson = row.preparationJson, parsed: unknown = JSON.parse(preparationJson), preparation = record(parsed);
  if (preparation.kind !== 'cad-solid-contact-prepared' || Object.hasOwn(preparation, 'preparationSha256')) fail('Invalid preparation payload');
  equal(preparation.source, source, 'Preparation source differs');
  const meshes = array(row.meshes, source.bodies.length, source.bodies.length).map((item, index) => {
    const entry = record(item, ['bodyFeatureId', 'mesh']), bodyFeatureId = text(entry.bodyFeatureId);
    if (bodyFeatureId !== source.bodies[index].bodyFeatureId || !isTetraMeshResult(entry.mesh)) fail('Invalid or unordered actual volume mesh');
    const mesh = structuredClone(entry.mesh), stamp = mesh.input.source, expected = source.bodies[index];
    if (stamp.documentId !== source.documentId || stamp.revision !== source.revision || stamp.featureId !== bodyFeatureId
      || stamp.bodyKey !== expected.bodyKey || mesh.inputSha256 !== expected.inputSha256) fail('Volume mesh source differs');
    return { bodyFeatureId, mesh };
  });
  const nodes = array(row.nodes, 4, 1_000_000).map(vector);
  const elements = array(row.elements, 1, 5_000_000).map(item => {
    const ids = array(item, 4, 4).map(id => integer(id, 0, nodes.length - 1));
    if (new Set(ids).size !== 4) fail('Repeated tetrahedron node');
    const volume6 = dot(subtract(nodes[ids[1]], nodes[ids[0]]), cross(subtract(nodes[ids[2]], nodes[ids[0]]), subtract(nodes[ids[3]], nodes[ids[0]])));
    if (!Number.isFinite(volume6) || volume6 <= 0) fail('Nonpositive tetrahedron volume');
    return [ids[0], ids[1], ids[2], ids[3]] as const;
  });
  equal(preparation.nodesMm, nodes, 'Preparation nodes differ');
  equal(preparation.tetrahedra, elements, 'Preparation tetrahedra differ');
  const maps = array(preparation.bodyMaps, meshes.length, meshes.length), searchMeshes = array(preparation.searchMeshes, meshes.length, meshes.length);
  let nodeOffset = 0, elementOffset = 0;
  const bodies = array(row.bodies, meshes.length, meshes.length).map((item, index) => {
    const body = record(item, ['id', 'nodes']), mesh = meshes[index].mesh, id = text(body.id);
    if (id !== meshes[index].bodyFeatureId) fail('Body map identity differs');
    const mapped = array(body.nodes, mesh.coordinates.length / 3, mesh.coordinates.length / 3).map((node, local) => {
      if (node !== nodeOffset + local) fail('Body nodes must match the owned preparation partition');
      equal(nodes[nodeOffset + local], mesh.coordinates.slice(3 * local, 3 * local + 3), 'Actual volume node differs');
      return nodeOffset + local;
    });
    for (let local = 0; local < mesh.tetrahedra.length; local += 4) {
      equal(elements[elementOffset + local / 4], mesh.tetrahedra.slice(local, local + 4).map(node => nodeOffset + node), 'Actual volume tetrahedron differs');
    }
    equal(maps[index], { bodyFeatureId: id, localToGlobalNodes: mapped, tetrahedronOffset: elementOffset,
      tetrahedronCount: mesh.tetrahedra.length / 4 }, 'Preparation body map differs');
    const search = record(searchMeshes[index]);
    equal(search.coordinates, mesh.coordinates, 'Search coordinates differ from the volume mesh');
    equal(search.triangles, mesh.boundaryTriangles, 'Search boundary differs from the volume mesh');
    nodeOffset += mapped.length; elementOffset += mesh.tetrahedra.length / 4;
    return { id, nodes: mapped };
  });
  if (nodeOffset !== nodes.length || elementOffset !== elements.length) fail('Body maps omit volume nodes/elements');
  const materialRow = record(row.material, ['youngMPa', 'poisson', 'source']);
  const poisson = number(materialRow.poisson);
  if (!(poisson > -1 && poisson < .5)) fail('Invalid Poisson ratio');
  const material = { youngMPa: positive(materialRow.youngMPa), poisson, source: text(materialRow.source) };
  const steps = integer(row.steps, 1, 200), maxIterations = integer(row.maxIterations, 1, Number.MAX_SAFE_INTEGER), used = new Set<string>();
  const prescribed = histories(row.prescribed, nodes.length, steps, used), loads = histories(row.loads, nodes.length, steps, used);
  const patches = array(row.patches, 1, 100_000).map(item => readPatch(item, meshes));
  const ids = new Set<string>(), covered = new Set<string>(), masterCovered = new Set<string>(), physicalSlaves = new Set<string>();
  const plan = record(preparation.plan), pairs = array(plan.contacts, 1, 1000);
  if (plan.documentId !== source.documentId) fail('Contact plan belongs to another document');
  for (const patch of patches) {
    if (ids.has(patch.id)) fail('Duplicate contact patch');
    ids.add(patch.id);
    const matches = pairs.map(item => record(item)).filter(pair => pair.id === patch.contactId);
    if (matches.length !== 1) fail('Patch must resolve one prepared contact');
    const pair = matches[0], master = record(pair.master), slave = record(pair.slave);
    const masterTriangles = array(master.triangleIndices), slaveTriangles = array(slave.triangleIndices);
    if (pair.method !== 'surface-to-surface' || master.bodyFeatureId !== patch.masterBody || slave.bodyFeatureId !== patch.slaveBody
      || master.faceKey !== patch.masterFace || slave.faceKey !== patch.slaveFace || !masterTriangles.includes(patch.masterTriangle)
      || !slaveTriangles.includes(patch.slaveTriangle) || pair.gapMm !== patch.initialGapMm
      || pair.frictionCoefficient !== patch.mu || pair.frictionSourceId !== patch.sourceId) fail('Patch differs from its prepared face/law');
    equal(array(pair.masterNormals)[masterTriangles.indexOf(patch.masterTriangle)], patch.normal, 'Prepared contact direction differs');
    const slaveKey = `${patch.contactId}:${patch.slaveTriangle}`, masterKey = `${patch.contactId}:${patch.masterTriangle}`;
    const physicalSlave = JSON.stringify([patch.slaveBody, patch.slaveTriangle]);
    if (covered.has(slaveKey) || masterCovered.has(masterKey) || physicalSlaves.has(physicalSlave)) fail('Repeated integration coverage');
    physicalSlaves.add(physicalSlave);
    covered.add(slaveKey); masterCovered.add(masterKey);
  }
  for (const item of pairs) {
    const pair = record(item), slave = record(pair.slave), master = record(pair.master);
    for (const triangle of array(slave.triangleIndices)) if (!covered.has(`${text(pair.id)}:${integer(triangle, 0, Number.MAX_SAFE_INTEGER)}`)) fail('Missing slave facet coverage');
    for (const triangle of array(master.triangleIndices)) if (!masterCovered.has(`${text(pair.id)}:${integer(triangle, 0, Number.MAX_SAFE_INTEGER)}`)) fail('Missing master facet coverage');
  }
  return { schema: SOLID_CONTACT_WIRE_SCHEMA, units: 'N-mm-MPa', source, preparationJson, preparationSha256, meshes,
    nodes, elements, bodies, material, prescribed, loads, steps, maxIterations, solveSource: text(row.solveSource), patches };
}
export function isSolidContactInput(value: unknown): value is SolidContactInput {
  try { readSolidContactAnalysisInput(value); return true; } catch { return false; }
}
export async function verifySolidContactInput(value: unknown): Promise<SolidContactInput> {
  const input = readSolidContactAnalysisInput(value);
  if (await sha256Hex(new TextEncoder().encode(input.preparationJson)) !== input.preparationSha256) fail('Preparation SHA differs from actual bytes');
  for (const [index, body] of input.meshes.entries()) {
    const expected = input.source.bodies[index];
    if (await tetraMeshInputSha256(body.mesh.input) !== expected.inputSha256
      || await sha256Hex(new TextEncoder().encode(JSON.stringify(meshPayload(body.mesh)))) !== expected.meshSha256) fail('Actual input or volume mesh SHA differs');
  }
  return input;
}
 async function solidContactInputSha256(input: SolidContactInput): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(readSolidContactAnalysisInput(input))));
}

export async function bindSolidContactInput(prepared: CadSolidContactPrepared,
  meshes: readonly SolidContactMeshSource[], settings: SolidContactSolveSettings): Promise<SolidContactInput> {
  const { preparationSha256, ...payload } = prepared;
  const ownedSettings = structuredClone(settings);
  const patches = ownedSettings.patches.map((choice): SolidContactPatch => {
    const pair = prepared.plan.contacts.find(item => item.id === choice.contactId);
    const geometry = prepared.candidates.find(item => item.geometry.contactId === choice.contactId
      && item.geometry.master.triangleIndex === choice.masterTriangle && item.geometry.slave.triangleIndex === choice.slaveTriangle)?.geometry;
    if (pair === undefined || geometry === undefined) fail('Explicit patch is not a prepared candidate');
    return { id: JSON.stringify([choice.contactId, choice.masterTriangle, choice.slaveTriangle]), ...choice,
      masterBody: pair.master.bodyFeatureId, slaveBody: pair.slave.bodyFeatureId,
      masterFace: pair.master.faceKey, slaveFace: pair.slave.faceKey,
      masterNodes: geometry.master.nodeIndices, slaveNodes: geometry.slave.nodeIndices,
      normal: geometry.masterNormal, initialGapMm: pair.gapMm, mu: pair.frictionCoefficient, sourceId: pair.frictionSourceId };
  });
  const orderedMeshes = prepared.source.bodies.map(body => {
    const matches = meshes.filter(item => item.bodyFeatureId === body.bodyFeatureId);
    if (matches.length !== 1) fail('Expected one actual volume mesh per prepared body');
    return matches[0];
  });
  if (orderedMeshes.length !== meshes.length) fail('Unexpected source mesh');
  return verifySolidContactInput({ schema: SOLID_CONTACT_WIRE_SCHEMA, units: 'N-mm-MPa', source: prepared.source,
    preparationJson: JSON.stringify(payload), preparationSha256, meshes: orderedMeshes, nodes: prepared.nodesMm,
    elements: prepared.tetrahedra, bodies: prepared.bodyMaps.map(body => ({ id: body.bodyFeatureId, nodes: body.localToGlobalNodes })),
    material: ownedSettings.material, prescribed: ownedSettings.prescribed, loads: ownedSettings.loads, steps: ownedSettings.steps,
    maxIterations: ownedSettings.maxIterations, solveSource: ownedSettings.source, patches });
}

function callbacks(value: unknown): SolidContactCallbacks {
  const row = record(value, ['tangent', 'residual', 'evaluations']);
  return { tangent: integer(row.tangent, 0, Number.MAX_SAFE_INTEGER), residual: integer(row.residual, 0, Number.MAX_SAFE_INTEGER),
    evaluations: integer(row.evaluations, 0, Number.MAX_SAFE_INTEGER) };
}
function readPoint(value: unknown): SolidContactPointResult {
  const row = record(value, ['point', 'status', 'gapMm', 'pressureMPa', 'normalForceN', 'tangentialForceN', 'elasticSlipMm',
    'addedDissipationNmm', 'accumulatedDissipationNmm', 'elasticEnergyNmm', 'releasedElasticEnergyNmm', 'areaMm2',
    'pressureGapNPerMm', 'forceGapNmm', 'dimensionlessForceGap']);
  const status = row.status;
  if (status !== 'open' && status !== 'stick' && status !== 'slip' && status !== 'frictionless') fail('Unknown contact state');
  const result: SolidContactPointResult = { point: integer(row.point, 0, 2), status, gapMm: number(row.gapMm),
    pressureMPa: nonnegative(row.pressureMPa), normalForceN: nonnegative(row.normalForceN),
    tangentialForceN: vector(row.tangentialForceN), elasticSlipMm: vector(row.elasticSlipMm),
    addedDissipationNmm: nonnegative(row.addedDissipationNmm), accumulatedDissipationNmm: nonnegative(row.accumulatedDissipationNmm),
    elasticEnergyNmm: nonnegative(row.elasticEnergyNmm), releasedElasticEnergyNmm: nonnegative(row.releasedElasticEnergyNmm),
    areaMm2: positive(row.areaMm2), pressureGapNPerMm: number(row.pressureGapNPerMm),
    forceGapNmm: number(row.forceGapNmm), dimensionlessForceGap: number(row.dimensionlessForceGap) };
  if (result.accumulatedDissipationNmm < result.addedDissipationNmm) fail('Accumulated dissipation is less than its increment');
  if (status === 'open' && (result.gapMm < 0 || result.pressureMPa !== 0 || result.normalForceN !== 0
    || result.tangentialForceN.some(value => value !== 0) || result.addedDissipationNmm !== 0)) fail('Open contact carries a contact force');
  if (status !== 'open' && result.gapMm >= 0) fail('Closed contact has no penetration');
  return result;
}
/** Strict structural decoder also used at the Worker protocol boundary. */
 function readSolidContactResult(value: unknown): SolidContactResult {
  const row = record(value, ['kind', 'schema', 'units', 'source', 'inputSha256', 'preparationSha256', 'iterationLimit',
    'nativeIterationCount', 'strictComplementarityQualified', 'steps']);
  if (row.kind !== 'solid-contact-analysis' || row.schema !== SOLID_CONTACT_WIRE_SCHEMA || row.units !== 'N-mm-MPa'
    || row.nativeIterationCount !== null || row.strictComplementarityQualified !== false) fail('Unsupported result or invented qualification');
  const steps = array(row.steps, 1, 200).map((item, index): SolidContactStepResult => {
    const step = record(item, ['step', 'displacementMm', 'internalForcesN', 'externalForcesN', 'freeResidual',
      'nativeEquationCount', 'nativeCallbacks', 'patches']);
    if (step.step !== index + 1) fail('Missing or unordered contact step');
    const displacementMm = array(step.displacementMm, 4, 1_000_000).map(vector), count = displacementMm.length;
    const internalForcesN = array(step.internalForcesN, count, count).map(vector), externalForcesN = array(step.externalForcesN, count, count).map(vector);
    const freeResidual = nonnegative(step.freeResidual);
    if (freeResidual > 1e-8) fail('Contact free force residual exceeds the acceptance bound');
    const seen = new Set<string>();
    const patches = array(step.patches, 1, 100_000).map(item => {
      const patch = record(item, ['id', 'normalResultantN', 'points']), id = text(patch.id);
      if (seen.has(id)) fail('Repeated result patch');
      seen.add(id);
      const points = array(patch.points, 3, 3).map(readPoint);
      if (points.some((point, index) => point.point !== index)) fail('Missing/duplicate integration point');
      return { id, normalResultantN: nonnegative(patch.normalResultantN), points };
    });
    return { step: index + 1, displacementMm, internalForcesN, externalForcesN, freeResidual,
      nativeEquationCount: integer(step.nativeEquationCount, 0, count * 3), nativeCallbacks: callbacks(step.nativeCallbacks), patches };
  });
  return { kind: 'solid-contact-analysis', schema: SOLID_CONTACT_WIRE_SCHEMA, units: 'N-mm-MPa', source: readSource(row.source),
    inputSha256: hash(row.inputSha256), preparationSha256: hash(row.preparationSha256),
    iterationLimit: integer(row.iterationLimit, 1, Number.MAX_SAFE_INTEGER), nativeIterationCount: null,
    strictComplementarityQualified: false, steps };
}
export function isSolidContactResult(value: unknown): value is SolidContactResult {
  try { readSolidContactResult(value); return true; } catch { return false; }
}
/** Result coverage and the exact input/preparation/mesh identities are checked
 * again after the asynchronous digest, before the client may publish it. */
export async function decodeSolidContactResult(value: unknown, input: SolidContactInput): Promise<SolidContactResult> {
  const owned = await verifySolidContactInput(input), result = readSolidContactResult(value);
  if (result.inputSha256 !== await solidContactInputSha256(owned)
    || result.preparationSha256 !== owned.preparationSha256 || result.iterationLimit !== owned.maxIterations) fail('Result belongs to different input/preparation/options');
  equal(result.source, owned.source, 'Result belongs to another CAD revision or actual volume mesh');
  if (result.steps.length !== owned.steps) fail('Incomplete contact history');
  const previousDissipation = new Map<string, number>();
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
  const bodyMaps = new Map(owned.bodies.map(body => [body.id, body.nodes]));
  const prescribed = new Map(owned.prescribed.map(history => [`${history.node}:${history.axis}`, history]));
  const loads = new Map(owned.loads.map(history => [`${history.node}:${history.axis}`, history]));
  const referenceForce = Math.max(...owned.patches.map(patch => patch.referenceForceN));
  for (const step of result.steps) {
    if (step.displacementMm.length !== owned.nodes.length || step.patches.length !== owned.patches.length) fail('Incomplete node/patch result');
    if (step.nativeEquationCount !== owned.nodes.length * 3 - prescribed.size) fail('Native free equation count differs');
    let actualResidual = 0;
    for (let node = 0; node < owned.nodes.length; node++) for (let axis = 0; axis < 3; axis++) {
      const key = `${node}:${axis}`, fixed = prescribed.get(key), force = loads.get(key)?.values[step.step - 1] ?? 0;
      if (fixed !== undefined && step.displacementMm[node][axis] !== fixed.values[step.step - 1]) fail('Prescribed displacement differs');
      if (!close(step.externalForcesN[node][axis], force)) fail('External force history differs');
      if (fixed === undefined) actualResidual = Math.max(actualResidual, Math.abs(step.internalForcesN[node][axis] - force) / referenceForce);
    }
    if (actualResidual > 1e-8 || !close(step.freeResidual, actualResidual)) fail('Reported free residual differs from actual nodal forces');
    for (const patch of owned.patches) {
      const found = step.patches.find(item => item.id === patch.id);
      if (found === undefined) fail('Missing prepared contact patch result');
      const masterMap = bodyMaps.get(patch.masterBody), slaveMap = bodyMaps.get(patch.slaveBody);
      if (masterMap === undefined || slaveMap === undefined) fail('Missing patch body map');
      const master = patch.masterNodes.map(node => owned.nodes[masterMap[node]]), slave = patch.slaveNodes.map(node => owned.nodes[slaveMap[node]]);
      const vertexWeights = slave.map(point => {
        const distance = dot(subtract(point, master[0]), patch.normal);
        return projectContactPoint([point[0] - distance * patch.normal[0], point[1] - distance * patch.normal[1],
          point[2] - distance * patch.normal[2]], master).barycentric;
      });
      const pointArea = Math.hypot(...cross(subtract(slave[1], slave[0]), subtract(slave[2], slave[0]))) / 6;
      for (const point of found.points) {
        const weights = [0, 1, 2].map(index => index === point.point ? 4 / 6 : 1 / 6);
        const masterWeights = [0, 1, 2].map(index => weights.reduce((sum, value, local) => sum + value * vertexWeights[local][index], 0));
        const relative: Vector3 = [0, 1, 2].map(axis => weights.reduce((sum, value, local) => sum
          + value * step.displacementMm[slaveMap[patch.slaveNodes[local]]][axis]
          - masterWeights[local] * step.displacementMm[masterMap[patch.masterNodes[local]]][axis], 0)) as [number, number, number];
        const expectedGap = patch.initialGapMm + dot(relative, patch.normal);
        if (!close(point.gapMm, expectedGap) || !close(point.areaMm2, pointArea)
          || !close(point.pressureMPa, patch.knNPerMm3 * Math.max(0, -expectedGap))
          || !point.tangentialForceN.every((force, axis) => close(force, patch.ktNPerMm3 * point.elasticSlipMm[axis] * pointArea))) fail('Material-point geometry or constitutive values differ');
        const key = `${patch.id}:${point.point}`, prior = previousDissipation.get(key) ?? 0;
        if (!close(point.accumulatedDissipationNmm, prior + point.addedDissipationNmm)) fail('Discontinuous dissipation history');
        previousDissipation.set(key, point.accumulatedDissipationNmm);
        if (Math.max(0, -point.gapMm) > 1e-6 * patch.referenceLengthMm
          || Math.hypot(...point.tangentialForceN) > (patch.mu ?? 0) * point.normalForceN + 1e-8 * patch.referenceForceN
          || !close(point.pressureMPa * point.areaMm2, point.normalForceN)
          || !close(point.pressureMPa * point.gapMm, point.pressureGapNPerMm)
          || !close(point.normalForceN * point.gapMm, point.forceGapNmm)
          || !close(point.forceGapNmm / (patch.referenceLengthMm * patch.referenceForceN), point.dimensionlessForceGap)) fail('Contact physical diagnostics differ from the declared law/units');
        if ((patch.mu === null || patch.mu === 0) && point.status !== 'open' && point.status !== 'frictionless') fail('Frictionless patch reports friction');
      }
      if (!close(found.points.reduce((sum, point) => sum + point.normalForceN, 0), found.normalResultantN)) fail('Patch integration resultant differs');
    }
  }
  return result;
}
export function readSolidContactFailureDiagnostics(value: unknown): SolidContactFailureDiagnostics {
  const row = record(value, ['schema', 'inputSha256', 'preparationSha256', 'source', 'step', 'reason', 'iterationLimit',
    'nativeIterationCount', 'nativeCallbacks', 'rawBeforeFailure', 'rawTruncated']);
  if (row.schema !== SOLID_CONTACT_WIRE_SCHEMA || row.nativeIterationCount !== null
    || typeof row.rawBeforeFailure !== 'string' || row.rawBeforeFailure.length > 32_768 || typeof row.rawTruncated !== 'boolean') fail('Invalid contact failure diagnostics');
  return { schema: SOLID_CONTACT_WIRE_SCHEMA, inputSha256: hash(row.inputSha256), preparationSha256: hash(row.preparationSha256),
    source: readSource(row.source), step: row.step === null ? null : integer(row.step, 1, 200), reason: text(row.reason, 4096),
    iterationLimit: integer(row.iterationLimit, 1, Number.MAX_SAFE_INTEGER), nativeIterationCount: null,
    nativeCallbacks: row.nativeCallbacks === null ? null : callbacks(row.nativeCallbacks),
    rawBeforeFailure: row.rawBeforeFailure, rawTruncated: row.rawTruncated };
}
export function isSolidContactFailureDiagnostics(value: unknown): value is SolidContactFailureDiagnostics {
  try { readSolidContactFailureDiagnostics(value); return true; } catch { return false; }
}
