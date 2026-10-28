import { describe, expect, it } from 'vitest';
import { planarBasisForReference, validPlanarHoleBasis, type PlanarHoleBasis } from './planarHoleInput.js';
import type { SubShapeRef } from '@pointercad/model';

const basis: PlanarHoleBasis = { origin: [11, -7, 5], xAxis: [0.6, 0.8, 0],
  normal: [-0.48, 0.36, 0.8], yAxis: [-0.64, 0.48, -0.6] };
const reference: SubShapeRef = { bodyFeatureId: 'stock', index: 2, fingerprint: {
  kind: 'face', surfaceKind: 'plane', area: 100, position: [11, -7, 5], axis: [-0.48, 0.36, 0.8], radius: null,
} };

describe('native planar basis input boundary', () => {
  it('keeps the independently specified rotated origin and axes without world-axis substitution', () => {
    const typedBody: Parameters<typeof planarBasisForReference>[0][number] = { featureId: 'stock', isValid: true,
      faces: [{ index: 2, surfaceKind: 'plane', planarBasis: basis }] };
    expect(validPlanarHoleBasis(basis)).toBe(true);
    expect(planarBasisForReference([typedBody], reference)).toBe(basis);
    expect(planarBasisForReference([typedBody, typedBody], reference)).toBeNull();
    expect(basis.origin).toEqual([11, -7, 5]);
    expect(basis.xAxis).toEqual([0.6, 0.8, 0]);
    expect(basis.yAxis).toEqual([-0.64, 0.48, -0.6]);
  });
  it('refuses missing/nonfinite/nonorthonormal/reversed-Y metadata and invalid or missing current bodies', () => {
    const invalid: readonly (PlanarHoleBasis | undefined)[] = [undefined,
      { ...basis, origin: [Infinity, -7, 5] }, { ...basis, xAxis: [1, 1, 0] },
      { ...basis, yAxis: [0.64, -0.48, 0.6] }, { ...basis, normal: [0.6, 0.8, 0] },
    ];
    for (const frame of invalid) expect(validPlanarHoleBasis(frame)).toBe(false);
    expect(planarBasisForReference([], reference)).toBeNull();
    expect(planarBasisForReference([{ featureId: 'stock', isValid: false,
      faces: [{ index: 2, surfaceKind: 'plane', planarBasis: basis }] }], reference)).toBeNull();
    expect(planarBasisForReference([{ featureId: 'stock', isValid: true,
      faces: [{ index: 2, surfaceKind: 'plane' }] }], reference)).toBeNull();
  });
});
