import { describe, expect, it } from 'vitest';
import { solidCadFaceKey, SOLID_CONTACT_ID, SOLID_CONTACT_SCHEMA,
  type SolidContactPair, type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import type { SubShapeRef } from '@pointercad/model';
import { InputIssue } from '@pointercad/model/beam-analysis';
import { buildSolidContactPlan, type SolidContactMeshBoundary, type SolidContactMeshContext } from './solidContactModel.js';
import type { CadBoundaryFaceIdentity, CadBoundaryNormal } from './cadTetraMesh.js';

function face(body: string, normals: readonly Vector3[]): CadBoundaryFaceIdentity {
  const reference: SubShapeRef = { bodyFeatureId: body, index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: body, role: 'top' } } };
  return { key: solidCadFaceKey(reference), faceIndex: 1, reference,
    samples: normals.map((normal, triangleIndex) => ({ triangleIndex, point: [triangleIndex, 0, 0], normal })) };
}
function boundary(body: string, normals: readonly Vector3[]): SolidContactMeshBoundary {
  return { triangleCount: normals.length,
    boundaryIdentity: { documentId: 'part', bodyFeatureId: body, outward: true, faces: [face(body, normals)] } };
}
function fixture(patch: Partial<SolidContactPair> = {}) {
  const master = boundary('master-body', [[0, 0, 1], [0, 1, 0]]);
  const slave = boundary('slave-body', [[0, 0, -1], [0, -1, 0]]);
  const context: SolidContactMeshContext = { documentId: 'part', boundaries: [master, slave] };
  const contact: SolidContactPair = { id: 'contact-1', masterFace: master.boundaryIdentity.faces[0].key,
    slaveFace: slave.boundaryIdentity.faces[0].key, normal: { kind: 'master-outward' },
    gapMm: 2.5, frictionCoefficient: 0.25, frictionSourceId: 'test-report:interface:dry', method: 'surface-to-surface', ...patch };
  const saved: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID,
    source: { documentId: 'part' }, contacts: [contact] };
  return { saved, context, master, slave };
}
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
function reject(saved: SolidContactSavedInput, context: SolidContactMeshContext, code: string, path: string): void {
  const savedBefore = bytes(saved), contextBefore = bytes(context);
  let failure: unknown;
  try { buildSolidContactPlan(saved, context, 'request'); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InputIssue);
  if (!(failure instanceof InputIssue)) throw new Error('Expected InputIssue');
  expect(failure.code).toBe(code); expect(failure.path).toBe(path);
  expect(failure.message.length).toBeGreaterThan(0);
  expect(bytes(saved)).toEqual(savedBefore); expect(bytes(context)).toEqual(contextBefore);
}

describe('pure solid contact planning from W05 boundary identity', () => {
  it('binds face pairs, body-local triangle indices, per-triangle normals, gap, friction and source', () => {
    const { saved, context } = fixture(), before = bytes({ saved, context });
    const plan = buildSolidContactPlan(saved, context);
    expect(plan).toEqual({ documentId: 'part', contacts: [{ id: 'contact-1',
      master: { bodyFeatureId: 'master-body', faceKey: saved.contacts[0].masterFace, triangleIndices: [0, 1] },
      slave: { bodyFeatureId: 'slave-body', faceKey: saved.contacts[0].slaveFace, triangleIndices: [0, 1] },
      normal: { kind: 'master-outward' }, masterNormals: [[0, 0, 1], [0, 1, 0]], gapMm: 2.5,
      frictionCoefficient: 0.25, frictionSourceId: 'test-report:interface:dry', method: 'surface-to-surface' }] });
    expect(bytes({ saved, context })).toEqual(before);
    expect(bytes(buildSolidContactPlan(saved, context))).toEqual(bytes(plan));
  });

  it('keeps opposing curved-face normals instead of replacing them with their zero mean', () => {
    const { saved, context, master } = fixture();
    const curved = { ...master, boundaryIdentity: { ...master.boundaryIdentity,
      faces: [face('master-body', [[1, 0, 0], [-1, 0, 0]])] } };
    expect(buildSolidContactPlan(saved, { ...context, boundaries: [curved, context.boundaries[1]] })
      .contacts[0].masterNormals).toEqual([[1, 0, 0], [-1, 0, 0]]);
  });

  it('uses explicit directions unchanged, retains zero gap and declares frictionless values', () => {
    const { saved, context } = fixture({ normal: { kind: 'explicit', vector: [0.6, 0.8, 0] }, gapMm: 0,
      frictionCoefficient: null, frictionSourceId: null });
    const plan = buildSolidContactPlan(saved, context).contacts[0];
    expect(plan.masterNormals).toEqual([[0.6, 0.8, 0], [0.6, 0.8, 0]]);
    expect(plan.normal).toEqual({ kind: 'explicit', vector: [0.6, 0.8, 0] });
    expect(plan.gapMm).toBe(0); expect(plan.frictionCoefficient).toBeNull(); expect(plan.frictionSourceId).toBeNull();
    expect(plan.masterNormals[0]).not.toBe(plan.masterNormals[1]);
  });

  it('owns returned arrays and vectors and leaves frozen input unchanged', () => {
    const { saved, context } = fixture({ normal: { kind: 'explicit', vector: [0, 1, 0] } });
    Object.freeze(saved.contacts); Object.freeze(saved.source); Object.freeze(saved);
    const before = bytes({ saved, context }), plan = buildSolidContactPlan(saved, context);
    Reflect.set(plan.contacts[0].master.triangleIndices, 0, 99);
    Reflect.set(plan.contacts[0].masterNormals[0], 1, 0);
    if (plan.contacts[0].normal.kind === 'explicit') Reflect.set(plan.contacts[0].normal.vector, 1, 0);
    expect(bytes({ saved, context })).toEqual(before);
  });

  it('takes triangle membership from W05 samples even when their order differs from mesh order', () => {
    const { saved, context, master, slave } = fixture();
    const masterFace = master.boundaryIdentity.faces[0];
    const reordered = { ...master, boundaryIdentity: { ...master.boundaryIdentity,
      faces: [{ ...masterFace, samples: [...masterFace.samples].reverse() }] } };
    const pair = buildSolidContactPlan(saved, { ...context, boundaries: [slave, reordered] }).contacts[0];
    expect(pair.master.triangleIndices).toEqual([1, 0]); expect(pair.masterNormals).toEqual([[0, 1, 0], [0, 0, 1]]);
  });

  it('creates zero contacts from CAD mates alone and never reads mate properties', () => {
    let reads = 0;
    const context: SolidContactMeshContext = { documentId: 'part', boundaries: [],
      get mates(): never { reads++; throw new Error('CAD mates must remain independent'); } };
    expect(buildSolidContactPlan(undefined, context)).toEqual({ documentId: 'part', contacts: [] });
    const empty: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID,
      source: { documentId: 'part' }, contacts: [] };
    expect(buildSolidContactPlan(empty, context).contacts).toEqual([]);
    expect(reads).toBe(0);
    const withMates = { documentId: 'part', boundaries: [], mates: [{ kind: 'coincident', masterFace: 'a', slaveFace: 'b' }] };
    expect(buildSolidContactPlan(undefined, withMates).contacts).toEqual([]);
  });

  it('does not add, remove or change explicit contacts when CAD mates are present', () => {
    const { saved, context } = fixture();
    const withMates = { ...context, mates: [{ kind: 'coincident', masterFace: 'unrelated', slaveFace: 'other' }] };
    expect(buildSolidContactPlan(saved, withMates)).toEqual(buildSolidContactPlan(saved, context));
  });

  it.each(['masterFace', 'slaveFace'] as const)('refuses absent %s', side => {
    const { saved, context } = fixture({ [side]: 'missing-semantic-key' });
    reject(saved, context, 'contact-face-missing', `request.contacts[0].${side}`);
  });

  it('refuses a different saved document or a foreign mesh document', () => {
    const { saved, context, master, slave } = fixture();
    reject({ ...saved, source: { documentId: 'other' } }, context, 'contact-document', 'request.source.documentId');
    const foreign = { ...master, boundaryIdentity: { ...master.boundaryIdentity, documentId: 'other' } };
    reject(saved, { ...context, boundaries: [foreign, slave] }, 'contact-document', 'request.boundaries[0]');
  });

  it('refuses duplicate face identities, including repeated body occurrences', () => {
    const { saved, context, master } = fixture();
    reject(saved, { ...context, boundaries: [...context.boundaries, structuredClone(master)] }, 'contact-face-ambiguous', 'request.boundaries[2]');
  });

  it('refuses a face key unrelated to its reference and a wrong owning body', () => {
    for (const mutation of ['key', 'body'] as const) {
      const { saved, context, master } = fixture(), reference = master.boundaryIdentity.faces[0].reference;
      if (mutation === 'key') Reflect.set(reference, 'origin', undefined);
      else Reflect.set(master.boundaryIdentity, 'bodyFeatureId', 'wrong-body');
      reject(saved, context, 'contact-face-identity', 'request.contacts[0].masterFace');
    }
  });

  it('requires W05 outward evidence even with an explicit normal', () => {
    const { saved, context, master } = fixture({ normal: { kind: 'explicit', vector: [1, 0, 0] } });
    Reflect.set(master.boundaryIdentity, 'outward', false);
    reject(saved, context, 'contact-boundary', 'request.contacts[0].masterFace');
  });

  it.each([
    ['negative', -1], ['fractional', 0.5], ['out of range', 2], ['nonfinite', Infinity], ['duplicate', 1],
  ] as const)('refuses %s triangle indices', (_name, triangleIndex) => {
    const { saved, context, master } = fixture();
    Reflect.set(master.boundaryIdentity.faces[0].samples[0], 'triangleIndex', triangleIndex);
    reject(saved, context, 'contact-triangles', `request.contacts[0].masterFace.samples[${triangleIndex === 1 ? 1 : 0}]`);
  });

  it.each([0, -1, 1.5, Infinity])('refuses invalid triangle count %s', triangleCount => {
    const { saved, context, master } = fixture(); Reflect.set(master, 'triangleCount', triangleCount);
    reject(saved, context, 'contact-triangles', 'request.contacts[0].masterFace');
  });

  it.each([
    { normal: [0, 0, 0] }, { normal: [0, 0, 2] }, { normal: [NaN, 0, 1] },
    { point: [Infinity, 0, 0] }, { normal: new Array<number>(3) },
  ])('refuses invalid boundary sample %j', patch => {
    const { saved, context, master } = fixture(); Object.assign(master.boundaryIdentity.faces[0].samples[0], patch);
    reject(saved, context, 'contact-boundary-normal', 'request.contacts[0].masterFace.samples[0]');
  });

  it('refuses empty samples, sparse samples and a triangle assigned to two different faces', () => {
    for (const sparse of [false, true]) {
      const { saved, context, master } = fixture();
      Reflect.set(master.boundaryIdentity.faces[0], 'samples', sparse ? new Array<CadBoundaryNormal>(1) : []);
      reject(saved, context, 'contact-triangles', sparse ? 'request.boundaries[0]' : 'request.contacts[0].masterFace');
    }
    const { saved, context, master } = fixture();
    const otherFace = face('other-face', [[0, 0, 1]]);
    Reflect.set(master.boundaryIdentity, 'faces', [...master.boundaryIdentity.faces, otherFace]);
    reject(saved, context, 'contact-triangles', 'request.boundaries[0]');
  });

  it('revalidates saved inputs at the planning boundary', () => {
    const { saved, context } = fixture({ frictionCoefficient: 0.4, frictionSourceId: null });
    reject(saved, context, 'contact-friction-source', 'request.contacts[0].frictionSourceId');
  });
});
