import { describe, expect, it } from 'vitest';
import type { ShapeAddress, SubShapeOrigin } from '../geometry/subShapeOrigin.js';
import type { SolidBody } from './solidContracts.js';
import { createSubShapeReference, resolveCurrentOrigin } from './createSubShapeReference.js';
import { resolveSubShapeReference } from './referenceResolution.js';

const origin = (featureId: string): SubShapeOrigin => ({ version: 1, shapeKind: 'face', identity: {
  kind: 'box-face', featureId, role: 'top',
} });
const face = { index: 7, surfaceKind: 'plane' as const, area: 1200, centroid: [20, 15, 10] as const,
  axis: [0, 0, 1] as const, radius: null, triangleOffset: 0, triangleCount: 2 };
function body(featureId: string, semanticId = featureId): SolidBody {
  return { featureId, isValid: true, volume: 12000,
    mesh: { positions: new Float32Array([0, 0, 0, 40, 30, 10]), normals: new Float32Array(),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    faces: [face], edges: [], vertices: [], threadMarks: [],
    origins: { version: 1, state: 'tracked', bindings: [{ origin: origin(semanticId),
      state: 'unique', current: { kind: 'face', index: 7 } }] },
  };
}
type UniqueBinding = { readonly origin: SubShapeOrigin; readonly state: 'unique'; readonly current: ShapeAddress };
const cylinderClaims: readonly UniqueBinding[] = [
  ...(['side', 'start', 'end'] as const).map((role, index): UniqueBinding => ({
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'cylinder-1', role } },
    state: 'unique', current: { kind: 'face', index },
  })),
  ...(['start-ring', 'end-ring', 'seam'] as const).map((role, index): UniqueBinding => ({
    origin: { version: 1, shapeKind: 'edge', identity: { kind: 'cylinder-edge', featureId: 'cylinder-1', role } },
    state: 'unique', current: { kind: 'edge', index },
  })),
  ...(['seam-start', 'seam-end'] as const).map((role, index): UniqueBinding => ({
    origin: { version: 1, shapeKind: 'vertex', identity: { kind: 'cylinder-vertex', featureId: 'cylinder-1', role } },
    state: 'unique', current: { kind: 'vertex', index },
  })),
];
const cylinderBody: SolidBody = {
  ...body('cylinder-1'),
  faces: [0, 1, 2].map((index): SolidBody['faces'][number] => ({ ...face, index,
    surfaceKind: index === 0 ? 'cylinder' : 'plane' })),
  edges: [0, 1, 2].map((index): SolidBody['edges'][number] => ({ index, curveKind: index === 2 ? 'line' : 'circle',
    length: index === 2 ? 20 : 10 * Math.PI, midpoint: [5, 0, index === 1 ? 20 : 0],
    start: [5, 0, 0], end: [5, 0, 20], axis: [0, 0, 1], radius: index === 2 ? null : 5,
    segmentOffset: 0, segmentCount: 1 })),
  vertices: [0, 1].map((index): SolidBody['vertices'][number] => ({ index, position: [5, 0, index * 20] })),
  origins: { version: 1, state: 'tracked', bindings: cylinderClaims },
};

describe('current body semantic reference capture', () => {
  it('円筒8 unique claimの面・辺・頂点をそれぞれ保存参照に捕捉する', () => {
    expect(cylinderClaims).toHaveLength(8);
    for (const claim of cylinderClaims) {
      const saved = createSubShapeReference(cylinderBody, claim.current.kind, claim.current.index);
      expect(saved).toMatchObject({ bodyFeatureId: 'cylinder-1', index: claim.current.index,
        origin: claim.origin, fingerprint: { kind: claim.current.kind } });
      if (saved === null) continue;
      expect(resolveCurrentOrigin(cylinderBody, saved)).toEqual({ status: 'matched',
        address: claim.current, basis: 'semantic' });
    }
  });
  it('円筒の各addressでclaim欠落・重複を拒否する', () => {
    for (const claim of cylinderClaims) {
      const missing: SolidBody = { ...cylinderBody, origins: { version: 1, state: 'tracked',
        bindings: cylinderClaims.filter(candidate => candidate !== claim) } };
      const duplicated: SolidBody = { ...cylinderBody, origins: { version: 1, state: 'tracked',
        bindings: [...cylinderClaims, claim] } };
      expect(createSubShapeReference(missing, claim.current.kind, claim.current.index)).toBeNull();
      expect(createSubShapeReference(duplicated, claim.current.kind, claim.current.index)).toBeNull();
    }
  });
  it('同じ意味の識別子が別の address に2つある body では保存参照を作らない(鏡像と元の和)', () => {
    // Union of a cylinder and its mirror: each side face has one claim, but both claims carry cylinder-1/side.
    const side = cylinderClaims[0];
    const joined: SolidBody = { ...cylinderBody, faces: [...cylinderBody.faces, { ...cylinderBody.faces[0], index: 3 }],
      origins: { version: 1, state: 'tracked', bindings: [...cylinderClaims, { ...side, current: { kind: 'face', index: 3 } }] } };
    for (const index of [0, 3]) expect(createSubShapeReference(joined, 'face', index)).toBeNull();
    // Unrelated identities of the same body stay referable.
    expect(createSubShapeReference(joined, 'face', 1)?.origin).toEqual(cylinderClaims[1].origin);
    // The refusal matches resolution: such an identity never resolves on this body.
    const saved = createSubShapeReference(cylinderBody, 'face', 0);
    if (saved === null) throw new Error('fixture side reference');
    expect(resolveCurrentOrigin(joined, saved)).toEqual({ status: 'missing', reason: 'history-missing' });
  });
  it('同じ形の別 feature ID を取り違えず、現在 body の意味表と指紋を一緒に捕捉する', () => {
    const first = body('box-a'), second = body('box-b');
    const saved = createSubShapeReference(first, 'face', 7);
    expect(saved).toMatchObject({ bodyFeatureId: 'box-a', index: 7, origin: origin('box-a'),
      fingerprint: { kind: 'face', area: 1200 } });
    if (saved === null) return;
    expect(createSubShapeReference(second, 'face', 7)?.origin).toEqual(origin('box-b'));
    expect(resolveSubShapeReference(second, saved).status).toBe('missing');
  });
  it('split/merged/重複claim/失効した表から単独 origin を発明しない', () => {
    const current = body('box-a');
    const tracked = current.origins;
    if (tracked?.state !== 'tracked') return;
    const binding = tracked.bindings[0];
    const altered: readonly SolidBody[] = [
      { ...current, origins: { version: 1 as const, state: 'tracked' as const, bindings: [{
        origin: origin('box-a'), state: 'split' as const,
        candidates: [{ kind: 'face' as const, index: 7 }, { kind: 'face' as const, index: 8 }],
      }] } },
      { ...current, origins: { version: 1 as const, state: 'tracked' as const, bindings: [{
        origin: origin('box-a'), state: 'merged' as const, current: { kind: 'face' as const, index: 7 },
        coOrigins: [origin('box-a'), origin('box-b')],
      }] } },
      { ...current, origins: { version: 1 as const, state: 'tracked' as const, bindings: [binding, binding] } },
      { ...current, origins: { version: 1 as const, state: 'untracked' as const,
        reason: 'unsupported-operation' as const } },
    ];
    for (const candidate of altered) expect(createSubShapeReference(candidate, 'face', 7)).toBeNull();
    expect(createSubShapeReference(current, 'face', 8)).toBeNull();
    expect(createSubShapeReference(current, 'edge', 7)).toBeNull();
  });
});
