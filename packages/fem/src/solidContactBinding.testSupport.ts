import { createHash } from 'node:crypto';
import { createSubShapeReference, type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import { SOLID_CONTACT_ID, SOLID_CONTACT_SCHEMA, solidCadFaceKey, type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import { prepareCadSolidContact, type CadSolidContactBody } from './cadSolidContact.js';
import { bindSolidContactInput, SOLID_CONTACT_WIRE_SCHEMA, type SolidContactHistory, type SolidContactInput,
  type SolidContactResult, type SolidContactSolveSettings } from './solidContactBinding.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256 } from './tetraMesh.js';

// Independent analytic geometry shared by the three W23-B tests only. These are
// the same two bricks and six-tet partition as W20's native shear-bar oracle.
const TETS = [[0, 4, 6, 7], [0, 6, 2, 7], [0, 2, 3, 7], [0, 3, 1, 7], [0, 1, 5, 7], [0, 5, 4, 7]];
const ROLES = ['left', 'right', 'front', 'back', 'bottom', 'top'] as const;
const NORMALS: readonly Vector3[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
export function independentHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

async function brick(id: string, left: number, right: number): Promise<CadSolidContactBody> {
  const nodes: Vector3[] = [];
  for (const x of [left, right]) for (const y of [0, 10]) for (const z of [0, 20]) nodes.push([x, y, z]);
  const faces = new Map<string, { nodes: number[]; count: number }>();
  for (const [a, b, c, d] of TETS) for (const triangle of [[b, c, d], [a, d, c], [a, b, d], [a, c, b]]) {
    const key = [...triangle].sort((a, b) => a - b).join(':');
    const previous = faces.get(key);
    if (previous === undefined) faces.set(key, { nodes: triangle, count: 1 });
    else previous.count++;
  }
  const boundary = [...faces.values()].filter(face => face.count === 1).map(face => {
    const points = face.nodes.map(node => nodes[node]);
    const tag = points.every(p => p[0] === left) ? 0 : points.every(p => p[0] === right) ? 1
      : points.every(p => p[1] === 0) ? 2 : points.every(p => p[1] === 10) ? 3 : points.every(p => p[2] === 0) ? 4 : 5;
    return { nodes: face.nodes, tag };
  }).sort((a, b) => a.tag - b.tag || a.nodes.join(':').localeCompare(b.nodes.join(':')));
  const triangles = boundary.flatMap(face => face.nodes), tags = boundary.map(face => face.tag);
  const centers: readonly Vector3[] = [[left, 5, 10], [right, 5, 10], [(left + right) / 2, 0, 10],
    [(left + right) / 2, 10, 10], [(left + right) / 2, 5, 0], [(left + right) / 2, 5, 20]];
  const origins: readonly SubShapeOrigin[] = ROLES.map(role => ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: id, role } }));
  const body: SolidBody = { featureId: id, bodyKind: 'solid', isValid: true, volume: (right - left) * 200,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    edges: [], vertices: [], threadMarks: [],
    faces: ROLES.map((_, index) => ({ index, surfaceKind: 'plane', area: index < 2 ? 200 : (right - left) * (index < 4 ? 20 : 10),
      centroid: centers[index], axis: NORMALS[index], radius: null, triangleOffset: 2 * index, triangleCount: 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique', current: { kind: 'face', index } })) } };
  const context = { documentId: 'contact-shear-oracle', revision: 1, body, steps: [{ featureId: id, key: `${id}:1` }] };
  const input = readTetraMeshInput({ schema: 'pointercad-convex-plc/1', units: 'mm',
    source: { documentId: context.documentId, revision: 1, featureId: id, bodyKey: `${id}:1` },
    coordinates: nodes.flat(), triangles, tags, tagCount: 6 });
  const mesh = decodeTetraMesh({ coordinates: nodes.flat(), tetrahedra: TETS.flat(), boundaryTriangles: triangles, boundaryTags: tags },
    input, await tetraMeshInputSha256(input));
  const regions = ROLES.map((_, tag) => {
    const reference = createSubShapeReference(body, 'face', tag);
    if (reference === null) throw new Error('Missing independent brick origin');
    return { tag, reference, triangleIndices: [2 * tag, 2 * tag + 1] };
  });
  return { context, mesh, regions, labelFaces: [0, 1, 2, 3, 4, 5] };
}

export async function contactFixture(zeroLoad = true) {
  const bodies = [await brick('bar', 0, 100), await brick('stop', 100, 101)];
  const saved: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID,
    source: { documentId: 'contact-shear-oracle' }, contacts: [{ id: 'bar-stop',
      masterFace: solidCadFaceKey(bodies[1].regions[0].reference), slaveFace: solidCadFaceKey(bodies[0].regions[1].reference),
      normal: { kind: 'master-outward' }, gapMm: 0, frictionCoefficient: .3,
      frictionSourceId: 'independent-native-shear-oracle', method: 'surface-to-surface' }] };
  const prepared = await prepareCadSolidContact(saved, () => bodies, { searchDistanceMm: .01 });
  const loadsY = zeroLoad ? [0] : [.1, 1, 1, 1, 2], closingX = zeroLoad ? [0] : [5e-7, 5e-7, -5e-7, 5e-7, 5e-7];
  const prescribed: SolidContactHistory[] = [];
  for (let node = 0; node < 16; node++) for (const axis of [0, 1, 2] as const) {
    if (node >= 4 && node < 8 && axis === 1) continue;
    prescribed.push({ node, axis, values: node >= 4 && node < 8 && axis === 0 ? closingX : loadsY.map(() => 0) });
  }
  const shape = (body: CadSolidContactBody, triangle: number): string => body.mesh.boundaryTriangles.slice(3 * triangle, 3 * triangle + 3)
    .map(node => `${body.mesh.coordinates[3 * node + 1]}:${body.mesh.coordinates[3 * node + 2]}`).sort().join('|');
  const settings: SolidContactSolveSettings = { material: { youngMPa: 210000, poisson: 0, source: 'independent isotropic shear bar E=210000, nu=0' },
    prescribed, loads: [1 / 3, 1 / 6, 1 / 6, 1 / 3].map((weight, local) => ({ node: local + 4, axis: 1, values: loadsY.map(value => value * weight) })),
    steps: loadsY.length, maxIterations: 50, source: 'W20 independent full shear history',
    patches: [2, 3].map(slaveTriangle => {
      const masterTriangle = [0, 1].find(triangle => shape(bodies[0], slaveTriangle) === shape(bodies[1], triangle));
      if (masterTriangle === undefined) throw new Error('Independent brick triangulations differ');
      return { contactId: 'bar-stop', masterTriangle, slaveTriangle, knNPerMm3: 10000, ktNPerMm3: 10000,
        referenceLengthMm: 10, referenceForceN: 1, source: 'independent reference penalties in N/mm3' };
    }) };
  const input = await bindSolidContactInput(prepared, bodies.map(body => ({ bodyFeatureId: body.context.body.featureId, mesh: body.mesh })), settings);
  return { input, bodies, saved, prepared, settings };
}

/** Synthetic zero-load reply for transport-contract tests only. No decoder or
 * native solver creates its expected values, and it is not native evidence. */
export function zeroContactReply(input: SolidContactInput): SolidContactResult {
  return { kind: 'solid-contact-analysis', schema: SOLID_CONTACT_WIRE_SCHEMA, units: 'N-mm-MPa', source: structuredClone(input.source),
    inputSha256: independentHash(input), preparationSha256: input.preparationSha256, iterationLimit: 50,
    nativeIterationCount: null, strictComplementarityQualified: false,
    steps: [{ step: 1, displacementMm: input.nodes.map(() => [0, 0, 0]), internalForcesN: input.nodes.map(() => [0, 0, 0]),
      externalForcesN: input.nodes.map(() => [0, 0, 0]), freeResidual: 0, nativeEquationCount: 4,
      nativeCallbacks: { tangent: 1, residual: 1, evaluations: 1 },
      patches: input.patches.map(patch => ({ id: patch.id, normalResultantN: 0,
        points: [0, 1, 2].map(point => ({ point, status: 'open', gapMm: 0, pressureMPa: 0, normalForceN: 0,
          tangentialForceN: [0, 0, 0], elasticSlipMm: [0, 0, 0], addedDissipationNmm: 0, accumulatedDissipationNmm: 0,
          elasticEnergyNmm: 0, releasedElasticEnergyNmm: 0, areaMm2: 100 / 3,
          pressureGapNPerMm: 0, forceGapNmm: 0, dimensionlessForceGap: 0 })) })) }] };
}
