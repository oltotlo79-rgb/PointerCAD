import { describe, expect, it } from 'vitest';
import { InputIssue, SOLID_CONTACT_ID, SOLID_CONTACT_SCHEMA, solidCadFaceKey,
  type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import type { SubShapeRef } from '@pointercad/model';
import type { Matrix3 } from './finiteKinematics.js';
import { buildSolidContactPlan, type SolidContactPlan } from './solidContactModel.js';
import type { ContactFacetLocation, SolidContactSearchMesh } from './solidContactSearch.js';
import { contactPointVirtualWork, updateContactGeometry,
  type ContactGeometryUpdateOptions, type ContactMaterialPoint } from './solidContactUpdate.js';

type Triangle = readonly [Vector3, Vector3, Vector3];
const IDENTITY: Matrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const QUARTER_Y: Matrix3 = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
const MASTER: readonly Triangle[] = [[[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[2, 0, 0], [2, 2, 0], [0, 2, 0]]];
const ZERO_DISPLACEMENTS: Triangle = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

function close(actual: number, expected: number, tolerance = 1e-12): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}
function closeVector(actual: readonly number[], expected: readonly number[], tolerance = 1e-12): void {
  expect(actual.length).toBe(expected.length);
  expect(Math.hypot(...actual.map((value, index) => value - expected[index]))).toBeLessThanOrEqual(tolerance);
}
function outward(triangle: Triangle): Vector3 {
  const a = triangle[1].map((entry, i) => entry - triangle[0][i]), b = triangle[2].map((entry, i) => entry - triangle[0][i]);
  const area: Vector3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...area);
  return [area[0] / length, area[1] / length, area[2] / length];
}
function mesh(body: string, triangles: readonly Triangle[]): SolidContactSearchMesh {
  const reference: SubShapeRef = { bodyFeatureId: body, index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: body, role: 'top' } } };
  return { coordinates: triangles.flatMap(triangle => triangle.flat()),
    triangles: triangles.flatMap((_, index) => [3 * index, 3 * index + 1, 3 * index + 2]),
    boundaryIdentity: { documentId: 'part', bodyFeatureId: body, outward: true, faces: [{
      key: solidCadFaceKey(reference), faceIndex: 1, reference,
      samples: triangles.map((triangle, triangleIndex) => ({ triangleIndex,
        point: [(triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
          (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3, (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3],
        normal: outward(triangle) })) }] } };
}
function slaveAt(point: Vector3): Triangle {
  return [[point[0] - 0.1, point[1] - 0.1, point[2]],
    [point[0] + 0.2, point[1] - 0.1, point[2]], [point[0] - 0.1, point[1] + 0.2, point[2]]];
}
function planFor(meshes: readonly SolidContactSearchMesh[]): SolidContactPlan {
  const master = meshes.find(item => item.boundaryIdentity.bodyFeatureId === 'master');
  const slave = meshes.find(item => item.boundaryIdentity.bodyFeatureId === 'slave');
  if (master === undefined || slave === undefined) throw new Error('Fixture needs both bodies');
  const input: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID, source: { documentId: 'part' },
    contacts: [{ id: 'pair', masterFace: master.boundaryIdentity.faces[0].key, slaveFace: slave.boundaryIdentity.faces[0].key,
      normal: { kind: 'master-outward' }, gapMm: 7, frictionCoefficient: 0.3, frictionSourceId: 'independent-oracle', method: 'surface-to-surface' }] };
  return buildSolidContactPlan(input, { documentId: 'part', boundaries: meshes.map(item => ({
    boundaryIdentity: item.boundaryIdentity, triangleCount: item.triangles.length / 3 })) });
}
function location(item: SolidContactSearchMesh, triangleIndex: number, barycentric: Vector3, pointMm: Vector3): ContactFacetLocation {
  return { bodyFeatureId: item.boundaryIdentity.bodyFeatureId, faceKey: item.boundaryIdentity.faces[0].key,
    triangleIndex, nodeIndices: [3 * triangleIndex, 3 * triangleIndex + 1, 3 * triangleIndex + 2], barycentric, pointMm };
}
function fixture(point: Vector3 = [1.5, 1.5, 0]) {
  const meshes = [mesh('master', MASTER), mesh('slave', [slaveAt(point)])];
  const previous: ContactMaterialPoint = { materialPointId: 'material-1', contactId: 'pair', conditionKey: 'fixed-law-area-2',
    master: location(meshes[0], 0, [0.5, 0.25, 0.25], [0.5, 0.5, 0]),
    slave: location(meshes[1], 0, [1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0]),
    normal: [0, 0, 1], elasticSlipMm: [0.03, 0.04, 0], tangentialTractionMPa: [1.8, 2.4, 0],
    areaMm2: 2, accumulatedDissipationNmm: 0.12 };
  const options: ContactGeometryUpdateOptions = { searchDistanceMm: 0.1, representativeLengthMm: 2,
    incrementalRotation: IDENTITY, conditionKey: previous.conditionKey };
  return { meshes, previous, options, plan: planFor(meshes) };
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function reason(action: () => unknown, code: string): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InputIssue);
  if (!(failure instanceof InputIssue)) throw new Error('Expected InputIssue');
  expect(failure.code).toBe(code); expect(failure.path.length).toBeGreaterThan(0);
}
function movedMeshes(meshes: readonly SolidContactSearchMesh[], transform: (point: Vector3) => Vector3): SolidContactSearchMesh[] {
  return meshes.map(item => {
    const triangles: Triangle[] = [];
    const point = (node: number): Vector3 => transform([item.coordinates[3 * node], item.coordinates[3 * node + 1], item.coordinates[3 * node + 2]]);
    for (let i = 0; i < item.triangles.length; i += 3) triangles.push([point(item.triangles[i]), point(item.triangles[i + 1]), point(item.triangles[i + 2])]);
    return mesh(item.boundaryIdentity.bodyFeatureId, triangles);
  });
}
function evidence(value: Record<string, unknown>): void {
  process.stdout.write(`W21-A evidence ${JSON.stringify(value)}${String.fromCharCode(10)}`);
}

describe('material-point remapping across two facets of one explicit face', () => {
  it('crosses A to B with independent barycentrics and nonzero planar sliding', () => {
    const input = fixture(), result = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    expect(result.point.materialPointId).toBe('material-1'); expect(result.point.master.triangleIndex).toBe(1);
    expect(result.point.master.nodeIndices).toEqual([3, 4, 5]);
    closeVector(result.point.master.barycentric, [0.25, 0.5, 0.25]);
    closeVector(result.point.master.pointMm, [1.5, 1.5, 0]); closeVector(result.point.slave.pointMm, [1.5, 1.5, 0]);
    closeVector(result.relativeIncrementMm, [1, 1, 0]); close(result.geometricDistanceMm, 0);
    close(result.signedSeparationMm, 0); expect(result.declaredInitialGapMm).toBe(7);
    expect(result.point.accumulatedDissipationNmm).toBe(0.12);
    evidence({ example: 'facet-crossing', expectedIncrementMm: [1, 1, 0], incrementMm: result.relativeIncrementMm,
      masterBarycentric: result.point.master.barycentric, dissipationNmm: result.point.accumulatedDissipationNmm });
  });

  it('returns B to A with the same material identity and opposite sliding', () => {
    const input = fixture(), forward = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    const back = fixture([0.5, 0.5, 0]), result = updateContactGeometry(forward.point, back.plan, back.meshes, back.options);
    expect(result.point.master.triangleIndex).toBe(0); expect(result.point.materialPointId).toBe(input.previous.materialPointId);
    closeVector(result.point.master.barycentric, [0.5, 0.25, 0.25]); closeVector(result.relativeIncrementMm, [-1, -1, 0]);
    expect(result.point.accumulatedDissipationNmm).toBe(0.12); closeVector(result.point.elasticSlipMm, [0.03, 0.04, 0]);
  });

  it('keeps semantic mapping when mesh and plan facet arrays are reordered', () => {
    const input = fixture(), pair = input.plan.contacts[0];
    const plan: SolidContactPlan = { ...input.plan, contacts: [{ ...pair,
      master: { ...pair.master, triangleIndices: [...pair.master.triangleIndices].reverse() }, masterNormals: [...pair.masterNormals].reverse() }] };
    expect(updateContactGeometry(input.previous, plan, [...input.meshes].reverse(), input.options))
      .toEqual(updateContactGeometry(input.previous, input.plan, input.meshes, input.options));
  });

  it('selects a coplanar shared-edge projection deterministically', () => {
    const input = fixture([1, 1, 0]), result = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    expect(result.point.master.triangleIndex).toBe(0); closeVector(result.point.master.barycentric, [0, 0.5, 0.5]);
    closeVector(result.relativeIncrementMm, [0.5, 0.5, 0]);
  });

  it('keeps initial gap separate from geometric separation and tangential increment', () => {
    const input = fixture([1.5, 1.5, 0.05]), result = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    close(result.geometricDistanceMm, 0.05); close(result.signedSeparationMm, 0.05);
    expect(result.declaredInitialGapMm).toBe(7); closeVector(result.relativeIncrementMm, [1, 1, 0]);
  });

  it('advects the old master material point instead of attributing common translation to slip', () => {
    const input = fixture([0.5, 0.5, 0]);
    const meshes = movedMeshes(input.meshes, p => [p[0] + 4, p[1] - 7, p[2] + 2]);
    const result = updateContactGeometry(input.previous, planFor(meshes), meshes, input.options);
    closeVector(result.relativeIncrementMm, [0, 0, 0]); closeVector(result.point.slave.pointMm, [4.5, -6.5, 2]);
  });

  it('owns output vectors and never mutates frozen inputs', () => {
    const input = fixture(), before = structuredClone(input); freeze(input);
    const result = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    Reflect.set(result.point.master.pointMm, 0, 99); Reflect.set(result.point.slave.barycentric, 0, 99);
    Reflect.set(result.point.normal, 0, 99); Reflect.set(result.point.elasticSlipMm, 0, 99);
    expect(input).toEqual(before);
  });
});

describe('explicit objective frame transport', () => {
  it('preserves independent work, elastic energy and dissipation after a 90 degree normal rotation', () => {
    const input = fixture([0.5, 0.5, 0]);
    const meshes = movedMeshes(input.meshes, p => [p[2] + 3, p[1] - 4, -p[0] + 2]);
    const result = updateContactGeometry(input.previous, planFor(meshes), meshes, { ...input.options, incrementalRotation: QUARTER_Y });
    closeVector(result.point.normal, [1, 0, 0]); closeVector(result.point.elasticSlipMm, [0, 0.04, -0.03]);
    closeVector(result.point.tangentialTractionMPa, [0, 2.4, -1.8]); closeVector(result.relativeIncrementMm, [0, 0, 0]);
    close(Math.hypot(...result.point.elasticSlipMm), 0.05);
    const elasticEnergy = 0.5 * 100 * 2 * result.point.elasticSlipMm.reduce((sum, v) => sum + v * v, 0);
    close(elasticEnergy, 0.25); expect(result.point.accumulatedDissipationNmm).toBe(0.12);
    const before = contactPointVirtualWork(input.previous.slave, [3.6, 4.8, 0], [[0.01, 0.02, 0], [0.01, 0.02, 0], [0.01, 0.02, 0]]);
    const after = contactPointVirtualWork(result.point.slave, [0, 4.8, -3.6], [[0, 0.02, -0.01], [0, 0.02, -0.01], [0, 0.02, -0.01]]);
    close(before.pointWorkNmm, 0.132); close(after.pointWorkNmm, 0.132);
    expect(Math.abs(after.nodalWorkNmm - before.nodalWorkNmm) / 0.132).toBeLessThanOrEqual(1e-6);
    evidence({ example: 'normal-quarter-turn', elasticLengthMm: Math.hypot(...result.point.elasticSlipMm),
      elasticEnergyNmm: elasticEnergy, workBeforeNmm: before.nodalWorkNmm, workAfterNmm: after.nodalWorkNmm,
      dissipationNmm: result.point.accumulatedDissipationNmm, objectiveIncrementMm: result.relativeIncrementMm });
  });

  it('retains in-plane rigid spin that cannot be inferred from an unchanged normal', () => {
    const input = fixture([0.5, 0.5, 0]), rotation: Matrix3 = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
    const meshes = movedMeshes(input.meshes, p => [-p[1], p[0], p[2]]);
    const result = updateContactGeometry(input.previous, planFor(meshes), meshes, { ...input.options, incrementalRotation: rotation });
    closeVector(result.point.normal, [0, 0, 1]); closeVector(result.point.elasticSlipMm, [-0.04, 0.03, 0]);
    closeVector(result.point.tangentialTractionMPa, [-2.4, 1.8, 0]); closeVector(result.relativeIncrementMm, [0, 0, 0]);
  });

  it('subtracts a rotated nonzero old separation before projecting objective sliding', () => {
    const input = fixture([0.5, 0.5, 0.05]);
    const previous = { ...input.previous, slave: { ...input.previous.slave, pointMm: [0.5, 0.5, 0.05] satisfies Vector3 } };
    const meshes = movedMeshes(input.meshes, p => [p[2], p[1], -p[0]]);
    const result = updateContactGeometry(previous, planFor(meshes), meshes, { ...input.options, incrementalRotation: QUARTER_Y });
    closeVector(result.relativeIncrementMm, [0, 0, 0]); close(result.signedSeparationMm, 0.05);
  });
});

describe('P1 action/reaction and virtual work', () => {
  it.each([1, -1])('matches independent 5 Nmm work in traversal direction %s', direction => {
    const input = fixture(), forward = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    const state = direction === 1 ? forward.point : input.previous;
    const slaveForce: Vector3 = [2 * direction, 3 * direction, 0], masterForce: Vector3 = [-2 * direction, -3 * direction, 0];
    const displacement: Vector3 = [direction, direction, 0];
    const slave = contactPointVirtualWork(state.slave, slaveForce, [displacement, displacement, displacement]);
    const master = contactPointVirtualWork(state.master, masterForce, ZERO_DISPLACEMENTS);
    close(slave.pointWorkNmm, 5); close(slave.nodalWorkNmm, 5); close(master.nodalWorkNmm, 0);
    expect(Math.abs(slave.pointWorkNmm - slave.nodalWorkNmm) / 5).toBeLessThanOrEqual(1e-6);
    closeVector(slave.resultantForceN.map((entry, axis) => entry + master.resultantForceN[axis]), [0, 0, 0], 1e-8);
    expect(state.accumulatedDissipationNmm).toBe(0.12);
  });

  it('uses barycentric node order for nonuniform virtual displacement and force', () => {
    const input = fixture(), forward = updateContactGeometry(input.previous, input.plan, input.meshes, input.options);
    const work = contactPointVirtualWork(forward.point.master, [2, 3, 0], [[1, 0, 0], [0, 2, 0], [-1, 0, 0]]);
    closeVector(work.pointDisplacementMm, [0, 1, 0]); close(work.pointWorkNmm, 3); close(work.nodalWorkNmm, 3);
    closeVector(work.nodalForcesN[0], [0.5, 0.75, 0]); closeVector(work.nodalForcesN[1], [1, 1.5, 0]);
    closeVector(work.nodalForcesN[2], [0.5, 0.75, 0]);
  });
});

describe('unsupported history transfers are refused without mutation', () => {
  const cases: readonly { name: string; code: string; mutate: (input: ReturnType<typeof fixture>) => void }[] = [
    { name: 'changed conditions', code: 'contact-history-condition', mutate: input => { Reflect.set(input.options, 'conditionKey', 'different-law'); } },
    { name: 'reflection instead of rotation', code: 'contact-history-rotation', mutate: input => { Reflect.set(input.options, 'incrementalRotation', [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]); } },
    { name: 'non-orthogonal frame', code: 'contact-history-rotation', mutate: input => { Reflect.set(input.options, 'incrementalRotation', [[2, 0, 0], [0, 1, 0], [0, 0, 1]]); } },
    { name: 'normal-inconsistent rotation', code: 'contact-history-rotation', mutate: input => { Reflect.set(input.options, 'incrementalRotation', QUARTER_Y); } },
    { name: 'nonfinite rotation', code: 'contact-history-numeric', mutate: input => { Reflect.set(input.options, 'incrementalRotation', [[NaN, 0, 0], [0, 1, 0], [0, 0, 1]]); } },
    { name: 'sparse frame', code: 'contact-history-shape', mutate: input => { const frame = [...IDENTITY]; Reflect.deleteProperty(frame, 1); Reflect.set(input.options, 'incrementalRotation', frame); } },
    { name: 'missing master triangle', code: 'contact-history-topology', mutate: input => { Reflect.set(input.previous.master, 'triangleIndex', 99); } },
    { name: 'changed slave connectivity', code: 'contact-history-topology', mutate: input => { Reflect.set(input.previous.slave, 'nodeIndices', [1, 0, 2]); } },
    { name: 'different master body', code: 'contact-history-topology', mutate: input => { Reflect.set(input.previous.master, 'bodyFeatureId', 'unrelated'); } },
    { name: 'different slave CAD face', code: 'contact-history-topology', mutate: input => { Reflect.set(input.previous.slave, 'faceKey', 'other-face'); } },
    { name: 'missing contact', code: 'contact-history-identity', mutate: input => { Reflect.set(input.previous, 'contactId', 'absent'); } },
    { name: 'empty material identity', code: 'contact-history-identity', mutate: input => { Reflect.set(input.previous, 'materialPointId', ''); } },
    { name: 'negative dissipation', code: 'contact-history-state', mutate: input => { Reflect.set(input.previous, 'accumulatedDissipationNmm', -0.01); } },
    { name: 'zero area', code: 'contact-history-state', mutate: input => { Reflect.set(input.previous, 'areaMm2', 0); } },
    { name: 'nonfinite dissipation', code: 'contact-history-numeric', mutate: input => { Reflect.set(input.previous, 'accumulatedDissipationNmm', Infinity); } },
    { name: 'normal elastic slip', code: 'contact-history-tangent', mutate: input => { Reflect.set(input.previous, 'elasticSlipMm', [0.03, 0.04, 0.01]); } },
    { name: 'normal traction', code: 'contact-history-tangent', mutate: input => { Reflect.set(input.previous, 'tangentialTractionMPa', [1.8, 2.4, 1]); } },
    { name: 'nonunit old normal', code: 'contact-history-normal', mutate: input => { Reflect.set(input.previous, 'normal', [0, 0, 2]); } },
    { name: 'negative barycentric weight', code: 'contact-history-barycentric', mutate: input => { Reflect.set(input.previous.slave, 'barycentric', [-0.1, 0.5, 0.6]); } },
    { name: 'weights that do not sum to one', code: 'contact-history-barycentric', mutate: input => { Reflect.set(input.previous.master, 'barycentric', [0.5, 0.5, 0.5]); } },
    { name: 'duplicate material nodes', code: 'contact-history-topology', mutate: input => { Reflect.set(input.previous.slave, 'nodeIndices', [0, 0, 1]); } },
    { name: 'invalid representative length', code: 'contact-history-scale', mutate: input => { Reflect.set(input.options, 'representativeLengthMm', 0); } },
  ];
  it.each(cases)('refuses $name and preserves all input state', ({ code, mutate }) => {
    const input = fixture(); mutate(input); const before = structuredClone(input);
    reason(() => updateContactGeometry(input.previous, input.plan, input.meshes, input.options), code);
    expect(input).toEqual(before);
  });

  it('refuses a material point outside the search distance even when its triangle has a nearby corner', () => {
    const input = fixture([0.5, 0.5, 0]);
    const meshes = [input.meshes[0], mesh('slave', [[[0.5, 0.5, 0], [8, 0.5, 0], [0.5, 8, 0]]])];
    const previous = { ...input.previous, slave: { ...input.previous.slave, barycentric: [0, 0.5, 0.5] satisfies Vector3 } };
    const before = structuredClone(previous);
    reason(() => updateContactGeometry(previous, planFor(meshes), meshes, input.options), 'contact-history-search');
    expect(previous).toEqual(before);
  });

  it('refuses an equally close sharp corner with different normals', () => {
    const input = fixture([0.5, 0, 0]);
    const crease: readonly Triangle[] = [[[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 0, 0], [0, 0, 2], [2, 0, 0]]];
    const meshes = [mesh('master', crease), input.meshes[1]], before = structuredClone(input.previous);
    reason(() => updateContactGeometry(input.previous, planFor(meshes), meshes, input.options), 'contact-history-ambiguous');
    expect(input.previous).toEqual(before);
  });

  it('refuses equally distant parallel surfaces with different projection points', () => {
    const input = fixture([0.5, 0.5, 1]);
    const parallel: readonly Triangle[] = [MASTER[0], [[0, 0, 2], [2, 0, 2], [0, 2, 2]]];
    const meshes = [mesh('master', parallel), input.meshes[1]];
    reason(() => updateContactGeometry(input.previous, planFor(meshes), meshes,
      { ...input.options, searchDistanceMm: 1 }), 'contact-history-ambiguous');
  });

  it('refuses overlapping facet interiors rather than choosing an arbitrary material side', () => {
    const input = fixture([0.5, 0.5, 0]), meshes = [mesh('master', [MASTER[0], MASTER[0]]), input.meshes[1]];
    reason(() => updateContactGeometry(input.previous, planFor(meshes), meshes, input.options), 'contact-history-ambiguous');
  });

  it('refuses malformed virtual displacements rather than returning nonfinite work', () => {
    const input = fixture();
    reason(() => contactPointVirtualWork(input.previous.master, [2, 3, 0], [[0, 0, 0], [Infinity, 0, 0], [0, 0, 0]]), 'contact-history-numeric');
  });
});
