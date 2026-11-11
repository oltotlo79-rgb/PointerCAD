import { describe, expect, it } from 'vitest';
import { SOLID_CONTACT_ID, SOLID_CONTACT_SCHEMA, solidCadFaceKey, type SolidContactNormal,
  type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import type { SubShapeRef } from '@pointercad/model';
import { InputIssue } from '@pointercad/model/beam-analysis';
import { buildSolidContactPlan, type SolidContactPlan } from './solidContactModel.js';
import { projectContactPoint, searchContactFacets, type SolidContactSearchMesh } from './solidContactSearch.js';

type Triangle = readonly [Vector3, Vector3, Vector3];
const PLANE: Triangle = [[0, 0, 0], [4, 0, 0], [0, 4, 0]];
function closeVector(actual: readonly number[], expected: readonly number[], tolerance = 1e-12): void {
  expect(actual.length).toBe(expected.length);
  expect(Math.hypot(...actual.map((value, index) => value - expected[index]))).toBeLessThanOrEqual(tolerance);
}
function outward(triangle: Triangle): Vector3 {
  const u = triangle[1].map((v, i) => v - triangle[0][i]), v = triangle[2].map((p, i) => p - triangle[0][i]);
  const cross: Vector3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...cross);
  return [cross[0] / length, cross[1] / length, cross[2] / length];
}
function mesh(body: string, triangles: readonly Triangle[], role: 'top' | 'bottom' = 'top'): SolidContactSearchMesh {
  const reference: SubShapeRef = { bodyFeatureId: body, index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: body, role } } };
  return { coordinates: triangles.flatMap(triangle => triangle.flat()),
    triangles: triangles.flatMap((_, index) => [3 * index, 3 * index + 1, 3 * index + 2]),
    boundaryIdentity: { documentId: 'part', bodyFeatureId: body, outward: true, faces: [{
      key: solidCadFaceKey(reference), faceIndex: 1, reference,
      samples: triangles.map((triangle, triangleIndex) => ({ triangleIndex,
        point: [(triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
          (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3, (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3],
        normal: outward(triangle) })) }] } };
}
function planFor(meshes: readonly SolidContactSearchMesh[], normal: SolidContactNormal = { kind: 'master-outward' }, gapMm = 7): SolidContactPlan {
  const last = meshes[meshes.length - 1].boundaryIdentity.faces;
  const input: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID, source: { documentId: 'part' },
    contacts: [{ id: 'pair', masterFace: meshes[0].boundaryIdentity.faces[0].key, slaveFace: last[last.length - 1].key,
      normal, gapMm, frictionCoefficient: null, frictionSourceId: null, method: 'surface-to-surface' }] };
  return buildSolidContactPlan(input, { documentId: 'part', boundaries: meshes.map(item => ({
    boundaryIdentity: item.boundaryIdentity, triangleCount: item.triangles.length / 3 })) });
}
function offset(triangle: Triangle, delta: Vector3): Triangle {
  const move = (v: Vector3): Vector3 => [v[0] + delta[0], v[1] + delta[1], v[2] + delta[2]];
  return [move(triangle[0]), move(triangle[1]), move(triangle[2])];
}
function fixture(master: readonly Triangle[] = [PLANE], slave: readonly Triangle[] = [offset(PLANE, [0, 0, 0.5])]) {
  const meshes = [mesh('master', master), mesh('slave', slave)];
  return { meshes, plan: planFor(meshes) };
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function reason(action: () => unknown, code: string): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InputIssue);
  if (!(failure instanceof InputIssue)) throw new Error('Expected InputIssue');
  expect(failure.code).toBe(code); expect(failure.path.length).toBeGreaterThan(0); expect(failure.message.length).toBeGreaterThan(0);
}
function evidence(value: Record<string, unknown>): void {
  process.stdout.write(`W17 evidence ${JSON.stringify(value)}${String.fromCharCode(10)}`);
}

describe('closed triangle projection with independent analytic values', () => {
  it.each([
    { name: 'face interior', point: [1, 1, 3], closest: [1, 1, 0], weights: [0.5, 0.25, 0.25], distance: 3 },
    { name: 'edge exterior', point: [3, 3, 2], closest: [2, 2, 0], weights: [0, 0.5, 0.5], distance: Math.sqrt(6) },
    { name: 'vertex exterior', point: [-2, -1, 2], closest: [0, 0, 0], weights: [1, 0, 0], distance: 3 },
    { name: 'edge boundary', point: [2, 2, 0], closest: [2, 2, 0], weights: [0, 0.5, 0.5], distance: 0 },
    { name: 'vertex boundary', point: [4, 0, 0], closest: [4, 0, 0], weights: [0, 1, 0], distance: 0 },
    { name: 'below plane', point: [1, 2, -4], closest: [1, 2, 0], weights: [0.25, 0.25, 0.5], distance: 4 },
  ])('$name', ({ point, closest, weights, distance }) => {
    const before = structuredClone({ point, triangle: PLANE }), result = projectContactPoint(point, PLANE);
    closeVector(result.pointMm, closest); closeVector(result.barycentric, weights);
    expect(Math.abs(result.distanceMm - distance)).toBeLessThanOrEqual(1e-12);
    expect({ point, triangle: PLANE }).toEqual(before);
  });

  it('projects onto an oblique facet using the plane x+z=1', () => {
    const triangle: Triangle = [[1, 0, 0], [1, 2, 0], [0, 0, 1]];
    const result = projectContactPoint([0.8, 0.5, 0.8], triangle);
    closeVector(result.pointMm, [0.5, 0.5, 0.5]); closeVector(result.barycentric, [0.25, 0.25, 0.5]);
    expect(Math.abs(result.distanceMm - 0.3 * Math.sqrt(2))).toBeLessThanOrEqual(1e-12);
  });

  it('keeps barycentric meaning when vertex order is reversed', () => {
    const result = projectContactPoint([1, 2, 3], [PLANE[2], PLANE[1], PLANE[0]]);
    closeVector(result.pointMm, [1, 2, 0]); closeVector(result.barycentric, [0.5, 0.25, 0.25]);
    expect(result.distanceMm).toBe(3);
  });

  it.each([1e-100, 1e100])('normalizes geometry scale without changing the analytic result: %s', scale => {
    const triangle: Triangle = [[0, 0, 0], [4 * scale, 0, 0], [0, 4 * scale, 0]];
    const result = projectContactPoint([scale, scale, 3 * scale], triangle);
    closeVector(result.barycentric, [0.5, 0.25, 0.25]);
    expect(Math.abs(result.distanceMm / scale - 3)).toBeLessThanOrEqual(1e-12);
  });

  it('owns output vectors and accepts frozen input', () => {
    const point = [1, 1, 3], triangle = structuredClone(PLANE), before = structuredClone({ point, triangle });
    freeze(point); freeze(triangle);
    const result = projectContactPoint(point, triangle);
    Reflect.set(result.pointMm, 0, 50); Reflect.set(result.barycentric, 0, 50);
    expect({ point, triangle }).toEqual(before);
  });

  const malformed: readonly { name: string; code: string; mutate: (point: number[], triangle: number[][]) => void }[] = [
    { name: 'short point', code: 'contact-shape', mutate: point => { point.pop(); } },
    { name: 'sparse point', code: 'contact-shape', mutate: point => { Reflect.deleteProperty(point, 1); } },
    { name: 'NaN point', code: 'contact-numeric', mutate: point => { point[0] = NaN; } },
    { name: 'infinite point', code: 'contact-numeric', mutate: point => { point[2] = Infinity; } },
    { name: 'short triangle', code: 'contact-shape', mutate: (_, triangle) => { triangle.pop(); } },
    { name: 'sparse triangle', code: 'contact-shape', mutate: (_, triangle) => { Reflect.deleteProperty(triangle, 1); } },
    { name: 'sparse vertex', code: 'contact-shape', mutate: (_, triangle) => { Reflect.deleteProperty(triangle[2], 1); } },
    { name: 'infinite vertex', code: 'contact-numeric', mutate: (_, triangle) => { triangle[2][2] = -Infinity; } },
    { name: 'repeated vertex', code: 'contact-degenerate', mutate: (_, triangle) => { triangle[2] = [...triangle[1]]; } },
    { name: 'collinear vertices', code: 'contact-degenerate', mutate: (_, triangle) => { triangle[2] = [8, 0, 0]; } },
    { name: 'overflowing edge', code: 'contact-numeric', mutate: (_, triangle) => { triangle[0][0] = -Number.MAX_VALUE; triangle[1][0] = Number.MAX_VALUE; } },
  ];
  it.each(malformed)('rejects $name without mutation', ({ code, mutate }) => {
    const point = [1, 1, 3], triangle = PLANE.map(vertex => [...vertex]);
    mutate(point, triangle); const before = structuredClone({ point, triangle });
    reason(() => projectContactPoint(point, triangle), code);
    expect({ point, triangle }).toEqual(before);
  });
});

describe('W16 body-local facet search', () => {
  it('returns both interpolation maps and preserves the declared gap independently', () => {
    const { plan, meshes } = fixture(), before = structuredClone({ plan, meshes });
    const hits = searchContactFacets(plan, meshes, 0.5);
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit.contactId).toBe('pair'); expect(hit.master.bodyFeatureId).toBe('master'); expect(hit.slave.bodyFeatureId).toBe('slave');
    expect(hit.master.triangleIndex).toBe(0); expect(hit.slave.triangleIndex).toBe(0);
    expect(hit.master.nodeIndices).toEqual([0, 1, 2]); expect(hit.slave.nodeIndices).toEqual([0, 1, 2]);
    closeVector(hit.master.pointMm, [0, 0, 0]); closeVector(hit.slave.pointMm, [0, 0, 0.5]);
    closeVector(hit.master.barycentric, [1, 0, 0]); closeVector(hit.slave.barycentric, [1, 0, 0]);
    expect(hit.distanceMm).toBe(0.5); expect(hit.signedSeparationMm).toBe(0.5); expect(hit.declaredInitialGapMm).toBe(7);
    expect(searchContactFacets(plan, meshes, 0.49)).toEqual([]);
    expect({ plan, meshes }).toEqual(before);
    evidence({ example: 'plane', expectedDistanceMm: 0.5, distanceMm: hit.distanceMm,
      masterBarycentric: hit.master.barycentric, slaveBarycentric: hit.slave.barycentric, initialGapMm: hit.declaredInitialGapMm });
  });

  it('keeps an explicit normal independent of the facet winding and Euclidean distance', () => {
    const { meshes } = fixture(), plan = planFor(meshes, { kind: 'explicit', vector: [1, 0, 0] }, 42);
    const hit = searchContactFacets(plan, meshes, 1)[0];
    expect(hit.normal).toEqual({ kind: 'explicit', vector: [1, 0, 0] });
    expect(hit.masterNormal).toEqual([1, 0, 0]); expect(hit.distanceMm).toBe(0.5);
    expect(hit.signedSeparationMm).toBe(0); expect(hit.declaredInitialGapMm).toBe(42);
  });

  it('finds an edge/edge minimum where no vertex projects into the opposite face', () => {
    const master: Triangle = [[-1, 0, 0], [1, 0, 0], [-1, -1, 0]];
    const slave: Triangle = [[0, -1, 1], [0, 1, 1], [1, 1, 1]];
    const { plan, meshes } = fixture([master], [slave]), hit = searchContactFacets(plan, meshes, 1)[0];
    expect(hit.distanceMm).toBe(1);
    closeVector(hit.master.pointMm, [0, 0, 0]); closeVector(hit.slave.pointMm, [0, 0, 1]);
    closeVector(hit.master.barycentric, [0.5, 0.5, 0]); closeVector(hit.slave.barycentric, [0.5, 0.5, 0]);
    evidence({ example: 'edge-edge', expectedDistanceMm: 1, distanceMm: hit.distanceMm,
      masterBarycentric: hit.master.barycentric, slaveBarycentric: hit.slave.barycentric });
  });

  it('finds an edge piercing the face interior even when every vertex is separated', () => {
    const master: Triangle = [[-2, -2, 0], [2, -2, 0], [0, 2, 0]];
    const slave: Triangle = [[0, 0, -1], [0, 0, 1], [0, 3, 1]];
    const { plan, meshes } = fixture([master], [slave]), hits = searchContactFacets(plan, meshes, 0);
    expect(hits.length).toBe(1); expect(hits[0].distanceMm).toBe(0);
    closeVector(hits[0].master.pointMm, hits[0].slave.pointMm);
    expect(hits[0].master.barycentric.every(value => value >= 0)).toBe(true);
    expect(hits[0].slave.barycentric.every(value => value >= 0)).toBe(true);
  });

  it('handles coplanar crossing edges and a shared vertex at zero search distance', () => {
    const triangles: readonly Triangle[] = [
      [[-1, 2, 0], [3, -1, 0], [5, 4, 0]],
      [[4, 0, 0], [5, 0, 0], [4, 1, 0]],
    ];
    for (const triangle of triangles) {
      const { plan, meshes } = fixture([PLANE], [triangle]);
      expect(searchContactFacets(plan, meshes, 0)[0].distanceMm).toBe(0);
    }
  });

  it('retains a coplanar crossing when the squared edge-cross length would underflow', () => {
    const epsilon = 1e-170;
    const master: Triangle = [[0, 0, 0], [4, 0, 0], [0, 4 * epsilon, 0]];
    const slave: Triangle = [[-1, 2 * epsilon, 0], [3, -epsilon, 0], [5, 4 * epsilon, 0]];
    const { plan, meshes } = fixture([master], [slave]), before = structuredClone({ plan, meshes });
    const hits = searchContactFacets(plan, meshes, 0);
    expect(hits.length).toBe(1); expect(hits[0].distanceMm).toBe(0);
    expect(hits[0].master.pointMm).toEqual(hits[0].slave.pointMm);
    expect({ plan, meshes }).toEqual(before);
    evidence({ example: 'thin-coplanar-crossing', epsilon, expectedCandidates: 1, actualCandidates: hits.length, distanceMm: hits[0].distanceMm });
  });

  it('searches two facets approximating a curved surface with separate outward directions', () => {
    const master: readonly Triangle[] = [
      [[1, 0, 0], [1, 2, 0], [0, 0, 1]],
      [[0, 0, 1], [0, 2, 1], [-1, 0, 0]],
    ];
    const interior: Triangle = [[0.75, 0.25, 0.25], [0.75, 0.75, 0.25], [0.5, 0.25, 0.5]];
    const slave = [offset(interior, [0.2, 0, 0.2])], { plan, meshes } = fixture(master, slave);
    const hits = searchContactFacets(plan, meshes, 0.3);
    expect(hits.length).toBe(1); expect(hits[0].master.triangleIndex).toBe(0);
    expect(Math.abs(hits[0].distanceMm - Math.sqrt(0.08))).toBeLessThanOrEqual(1e-12);
    closeVector(hits[0].masterNormal, [Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(plan.contacts[0].masterNormals[1][0]).toBeLessThan(0);
    evidence({ example: 'curved-facets', expectedDistanceMm: Math.sqrt(0.08), distanceMm: hits[0].distanceMm,
      selectedMaster: hits[0].master.triangleIndex, masterNormal: hits[0].masterNormal });
  });

  it('accepts distinct faces of the same body with non-overlapping boundary indices', () => {
    const a = mesh('same', [PLANE], 'top'), b = mesh('same', [offset(PLANE, [0, 0, 0.5])], 'bottom');
    const combined: SolidContactSearchMesh = { coordinates: [...a.coordinates, ...b.coordinates],
      triangles: [...a.triangles, ...b.triangles.map(node => node + 3)],
      boundaryIdentity: { ...a.boundaryIdentity, faces: [a.boundaryIdentity.faces[0],
        { ...b.boundaryIdentity.faces[0], samples: b.boundaryIdentity.faces[0].samples.map(sample => ({ ...sample, triangleIndex: 1 })) }] } };
    const plan = planFor([combined]), hits = searchContactFacets(plan, [combined], 1);
    expect(hits.length).toBe(1); expect(hits[0].master.triangleIndex).toBe(0); expect(hits[0].slave.triangleIndex).toBe(1);
    expect(hits[0].master.bodyFeatureId).toBe(hits[0].slave.bodyFeatureId);
  });

  it.each([0, 0.49, 0.5, 1.5, 20])('matches an exhaustive closed-form distance oracle at radius %s', radius => {
    const base: Triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]], masterX = [0, 4, 8], slaveX = [0, 5, 10];
    const { plan, meshes } = fixture(masterX.map(x => offset(base, [x, 0, 0])), slaveX.map(x => offset(base, [x, 0, 0.5])));
    const expected = masterX.flatMap((a, master) => slaveX.map((b, slave) => ({ master, slave,
      distance: Math.hypot(Math.max(0, Math.abs(a - b) - 1), 0.5) })))
      .filter(pair => pair.distance <= radius).sort((a, b) => a.distance - b.distance || a.master - b.master || a.slave - b.slave);
    const actual = searchContactFacets(plan, meshes, radius);
    expect(actual.map(hit => [hit.master.triangleIndex, hit.slave.triangleIndex])).toEqual(expected.map(hit => [hit.master, hit.slave]));
    actual.forEach((hit, index) => expect(Math.abs(hit.distanceMm - expected[index].distance)).toBeLessThanOrEqual(1e-12));
    // Reversing enumeration order cannot change equal-distance candidate order.
    const reversed = structuredClone(plan);
    Reflect.set(reversed.contacts[0].master, 'triangleIndices', [...reversed.contacts[0].master.triangleIndices].reverse());
    Reflect.set(reversed.contacts[0], 'masterNormals', [...reversed.contacts[0].masterNormals].reverse());
    Reflect.set(reversed.contacts[0].slave, 'triangleIndices', [...reversed.contacts[0].slave.triangleIndices].reverse());
    expect(searchContactFacets(reversed, [...meshes].reverse(), radius)).toEqual(actual);
    evidence({ example: 'exhaustive-oracle', radius, expectedCandidates: expected.length, actualCandidates: actual.length,
      pairs: actual.map(hit => [hit.master.triangleIndex, hit.slave.triangleIndex]) });
  });

  it('owns candidate maps and leaves frozen plan/geometry unchanged', () => {
    const { plan, meshes } = fixture(), before = structuredClone({ plan, meshes }); freeze(plan); freeze(meshes);
    const hit = searchContactFacets(plan, meshes, 1)[0];
    Reflect.set(hit.master.pointMm, 0, 99); Reflect.set(hit.master.nodeIndices, 0, 99); Reflect.set(hit.masterNormal, 0, 99);
    expect({ plan, meshes }).toEqual(before);
  });

  it('returns no physical contacts for an empty W16 plan', () => {
    expect(searchContactFacets({ documentId: 'part', contacts: [] }, [], 0)).toEqual([]);
  });
});

describe('rigid transformation invariance', () => {
  function transform(point: Vector3, angle: number, translation: Vector3): Vector3 {
    const axis = [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)], cosine = Math.cos(angle), sine = Math.sin(angle);
    const parallel = axis.reduce((sum, value, i) => sum + value * point[i], 0);
    const axialCross = [axis[1] * point[2] - axis[2] * point[1], axis[2] * point[0] - axis[0] * point[2], axis[0] * point[1] - axis[1] * point[0]];
    const component = (i: number): number => point[i] * cosine + axialCross[i] * sine + axis[i] * parallel * (1 - cosine) + translation[i];
    return [component(0), component(1), component(2)];
  }
  it.each([0, Math.PI / 2, Math.PI, 0.73])('preserves projection and facet distances after angle %s plus translation', angle => {
    const translation: Vector3 = [100, -200, 300], point: Vector3 = [1, 1, 3];
    const turn = (triangle: Triangle): Triangle => [transform(triangle[0], angle, translation),
      transform(triangle[1], angle, translation), transform(triangle[2], angle, translation)];
    const projected = projectContactPoint(transform(point, angle, translation), turn(PLANE));
    expect(Math.abs(projected.distanceMm - 3)).toBeLessThanOrEqual(4e-8);
    closeVector(projected.pointMm, transform([1, 1, 0], angle, translation), 4e-8);
    closeVector(projected.barycentric, [0.5, 0.25, 0.25], 1e-8);
    const { plan, meshes } = fixture([turn(PLANE)], [turn(offset(PLANE, [0, 0, 0.5]))]);
    const hit = searchContactFacets(plan, meshes, 1)[0];
    expect(Math.abs(hit.distanceMm - 0.5)).toBeLessThanOrEqual(4e-8);
    expect(Math.abs(hit.signedSeparationMm - 0.5)).toBeLessThanOrEqual(4e-8);
    expect(hit.declaredInitialGapMm).toBe(7);
    evidence({ example: 'rigid-transform', angle, representativeLengthMm: 4,
      projectionErrorMm: Math.abs(projected.distanceMm - 3), facetErrorMm: Math.abs(hit.distanceMm - 0.5), limitMm: 4e-8 });
  });
});

describe('invalid search data refuses with a reason and no mutation', () => {
  it.each([-1, NaN, Infinity])('refuses invalid explicit search radius %s', distance => {
    const { plan, meshes } = fixture(); reason(() => searchContactFacets(plan, meshes, distance), 'contact-distance');
  });
  const cases: readonly { name: string; code: string; mutate: (plan: SolidContactPlan, meshes: SolidContactSearchMesh[]) => void }[] = [
    { name: 'self face', code: 'contact-self', mutate: plan => { Reflect.set(plan.contacts[0], 'slave', structuredClone(plan.contacts[0].master)); } },
    { name: 'repeated id', code: 'contact-duplicate', mutate: plan => { Reflect.set(plan, 'contacts', [plan.contacts[0], structuredClone(plan.contacts[0])]); } },
    { name: 'reversed pair', code: 'contact-duplicate', mutate: plan => { const pair = plan.contacts[0]; Reflect.set(plan, 'contacts', [pair, { ...pair, id: 'reverse', master: pair.slave, slave: pair.master }]); } },
    { name: 'repeated body', code: 'contact-duplicate', mutate: (_, meshes) => { meshes.push(structuredClone(meshes[0])); } },
    { name: 'missing body', code: 'contact-face', mutate: plan => { Reflect.set(plan.contacts[0].master, 'bodyFeatureId', 'missing'); } },
    { name: 'other body index namespace', code: 'contact-face', mutate: plan => { Reflect.set(plan.contacts[0].master, 'bodyFeatureId', 'slave'); } },
    { name: 'missing boundary index', code: 'contact-triangle-index', mutate: plan => { Reflect.set(plan.contacts[0].master, 'triangleIndices', [99]); } },
    { name: 'repeated plan index', code: 'contact-triangle-index', mutate: plan => { Reflect.set(plan.contacts[0].master, 'triangleIndices', [0, 0]); } },
    { name: 'sparse plan indices', code: 'contact-shape', mutate: plan => { Reflect.deleteProperty(plan.contacts[0].master.triangleIndices, 0); } },
    { name: 'sparse contacts', code: 'contact-shape', mutate: plan => { Reflect.deleteProperty(plan.contacts, 0); } },
    { name: 'sparse mesh list', code: 'contact-shape', mutate: (_, meshes) => { Reflect.deleteProperty(meshes, 1); } },
    { name: 'sparse coordinates', code: 'contact-shape', mutate: (_, meshes) => { Reflect.deleteProperty(meshes[0].coordinates, 0); } },
    { name: 'sparse triangles', code: 'contact-shape', mutate: (_, meshes) => { Reflect.deleteProperty(meshes[0].triangles, 0); } },
    { name: 'NaN coordinate', code: 'contact-numeric', mutate: (_, meshes) => { Reflect.set(meshes[0].coordinates, 0, NaN); } },
    { name: 'infinite coordinate', code: 'contact-numeric', mutate: (_, meshes) => { Reflect.set(meshes[0].coordinates, 0, Infinity); } },
    { name: 'nonexistent vertex', code: 'contact-node-index', mutate: (_, meshes) => { Reflect.set(meshes[0].triangles, 0, 100); } },
    { name: 'noninteger vertex', code: 'contact-node-index', mutate: (_, meshes) => { Reflect.set(meshes[0].triangles, 0, 0.5); } },
    { name: 'degenerate triangle', code: 'contact-degenerate', mutate: (_, meshes) => { Reflect.set(meshes[0].triangles, 1, 0); } },
    { name: 'repeated connectivity', code: 'contact-duplicate', mutate: (_, meshes) => { Reflect.set(meshes[0], 'triangles', [0, 1, 2, 2, 1, 0]); } },
    { name: 'out-of-range identity index', code: 'contact-triangle-index', mutate: (_, meshes) => { Reflect.set(meshes[0].boundaryIdentity.faces[0].samples[0], 'triangleIndex', 1); } },
    { name: 'other document', code: 'contact-boundary', mutate: (_, meshes) => { Reflect.set(meshes[0].boundaryIdentity, 'documentId', 'other'); } },
    { name: 'reversed normal', code: 'contact-normal', mutate: plan => { Reflect.set(plan.contacts[0], 'masterNormals', [[0, 0, -1]]); } },
    { name: 'nonunit normal', code: 'contact-normal', mutate: plan => { Reflect.set(plan.contacts[0], 'masterNormals', [[0, 0, 2]]); } },
    { name: 'sparse normal', code: 'contact-shape', mutate: plan => { Reflect.deleteProperty(plan.contacts[0].masterNormals[0], 1); } },
    { name: 'missing normal', code: 'contact-normal', mutate: plan => { Reflect.set(plan.contacts[0], 'masterNormals', []); } },
    { name: 'negative declared gap', code: 'contact-plan', mutate: plan => { Reflect.set(plan.contacts[0], 'gapMm', -1); } },
  ];
  it.each(cases)('refuses $name', ({ code, mutate }) => {
    const { plan, meshes } = fixture(); mutate(plan, meshes); const before = structuredClone({ plan, meshes });
    reason(() => searchContactFacets(plan, meshes, 1), code); expect({ plan, meshes }).toEqual(before);
  });
});
