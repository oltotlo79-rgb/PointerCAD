import { describe, expect, it } from 'vitest';
import { isSubShapeOrigin } from './subShapeOriginValidation.js';

describe('persistent origin validation', () => {
  const edge = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-front' } };
  it('accepts an existing semantic edge and rejects extra fields and invalid kind', () => {
    expect(isSubShapeOrigin(edge)).toBe(true);
    expect(isSubShapeOrigin({ ...edge, index: 1 })).toBe(false);
    expect(isSubShapeOrigin({ ...edge, shapeKind: 'vertex' })).toBe(false);
  });
  it('refuses sparse and excessively recursive merged origins', () => {
    const sparse = new Array<unknown>(2); sparse[0] = edge.identity;
    expect(isSubShapeOrigin({ version: 1, shapeKind: 'edge', identity: { kind: 'merged-edge', featureId: 'sheet', sources: sparse } })).toBe(false);
    let identity: unknown = edge.identity;
    for (let i = 0; i < 20; i += 1) identity = { kind: 'merged-edge', featureId: 'sheet', sources: [identity, edge.identity] };
    expect(isSubShapeOrigin({ version: 1, shapeKind: 'edge', identity })).toBe(false);
  });
});

describe('planar sheet origins (closed straight-line profile)', () => {
  const lines = ['line-a', 'line-b', 'line-c', 'line-d'];
  const face = { version: 1, shapeKind: 'face', identity: { kind: 'planar-surface-face', featureId: 'sheet',
    profile: { sketchId: 'sketch', lineFeatureIds: lines } } };
  const edge = { version: 1, shapeKind: 'edge', identity: { kind: 'planar-surface-edge', featureId: 'sheet',
    profile: { sketchId: 'sketch', lineFeatureId: 'line-b', role: 'whole-line' } } };
  const vertex = { version: 1, shapeKind: 'vertex', identity: { kind: 'planar-surface-vertex', featureId: 'sheet',
    profile: { sketchId: 'sketch', lineFeatureIds: ['line-a', 'line-d'] } } };
  const withProfile = (origin: typeof face | typeof edge | typeof vertex, profile: unknown): unknown =>
    ({ ...origin, identity: { ...origin.identity, profile } });

  it('accepts the canonical face, edge and vertex identities', () => {
    expect([face, edge, vertex].map(origin => isSubShapeOrigin(origin))).toEqual([true, true, true]);
  });
  it('refuses unsorted, duplicated, too short and too long source line sets', () => {
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', lineFeatureIds: ['line-b', 'line-a', 'line-c'] }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', lineFeatureIds: ['line-a', 'line-a', 'line-c'] }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', lineFeatureIds: ['line-a', 'line-b'] }))).toBe(false);
    const many = Array.from({ length: 33 }, (_, at) => `line-${String(at).padStart(2, '0')}`);
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', lineFeatureIds: many }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', lineFeatureIds: many.slice(0, 32) }))).toBe(true);
    expect(isSubShapeOrigin(withProfile(vertex, { sketchId: 'sketch', lineFeatureIds: ['line-d', 'line-a'] }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(vertex, { sketchId: 'sketch', lineFeatureIds: ['line-a', 'line-a'] }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(vertex, { sketchId: 'sketch', lineFeatureIds: ['line-a', 'line-b', 'line-c'] }))).toBe(false);
  });
  it('refuses an invented faceFeatureId, extra keys, other roles and swapped shape kinds', () => {
    expect(isSubShapeOrigin(withProfile(face, { sketchId: 'sketch', faceFeatureId: 'region', lineFeatureIds: lines }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(edge, { sketchId: 'sketch', faceFeatureId: 'region', lineFeatureId: 'line-b', role: 'whole-line' }))).toBe(false);
    expect(isSubShapeOrigin(withProfile(edge, { sketchId: 'sketch', lineFeatureId: 'line-b', role: 'whole-curve' }))).toBe(false);
    expect(isSubShapeOrigin({ ...face, identity: { ...face.identity, index: 0 } })).toBe(false);
    expect(isSubShapeOrigin({ ...face, shapeKind: 'edge' })).toBe(false);
    expect(isSubShapeOrigin({ ...edge, shapeKind: 'vertex' })).toBe(false);
    expect(isSubShapeOrigin({ ...vertex, shapeKind: 'face' })).toBe(false);
    expect(isSubShapeOrigin(withProfile(face, { sketchId: ' ', lineFeatureIds: lines }))).toBe(false);
  });
});


describe('saved open arc surface identities', () => {
  const profile = { sketchId: 'sketch', curveFeatureId: 'arc', role: 'whole-curve' };
  const face = { version: 1, shapeKind: 'face', identity: { kind: 'surface-curve-side', featureId: 'sheet', profile } };
  const edge = { version: 1, shapeKind: 'edge', identity: {
    kind: 'surface-curve-edge', featureId: 'sheet', profile, role: 'section-start' } };
  it('accepts exactly the new saved face and four boundary roles', () => {
    expect(isSubShapeOrigin(face)).toBe(true);
    for (const role of ['section-start', 'section-end', 'swept-start', 'swept-end']) {
      expect(isSubShapeOrigin({ ...edge, identity: { ...edge.identity, role } })).toBe(true);
    }
  });
  it('retains strict role, kind and saved-source validation without fabricated closed regions', () => {
    for (const identity of [
      { ...edge.identity, role: 'seam' }, { ...edge.identity, extra: true },
      { ...edge.identity, profile: { ...profile, faceFeatureId: 'invented' } },
      { ...edge.identity, profile: { ...profile, curveFeatureId: '' } },
      { ...edge.identity, profile: { ...profile, role: 'whole-line' } },
      { ...edge.identity, profile: { sketchId: 'sketch', lineFeatureId: 'arc', role: 'whole-line' } },
    ]) expect(isSubShapeOrigin({ ...edge, identity })).toBe(false);
    expect(isSubShapeOrigin({ ...edge, shapeKind: 'face' })).toBe(false);
    expect(isSubShapeOrigin({ ...face, shapeKind: 'edge' })).toBe(false);
    expect(isSubShapeOrigin({ ...face, identity: { ...face.identity, index: 0 } })).toBe(false);
  });
});
