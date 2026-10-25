import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeSweep } from '../occt/makeSweep.js';
import { makeCut } from '../occt/makeCut.js';
import { measureVolume } from '../occt/solidMesh.js';
import { tessellate } from '../occt/tessellate.js';
import type { CurveSpec, SolidStepRequest, SweepStepSpec } from '../types.js';
import { recomputeSolids, solidMeshBuffers, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

// Independent geometry from steelBendStockFlow's public inputs: 50 x 6 flat, R30 inside,
// 90 degrees, tangent legs 200/100. The centroid radius is 30 + 50/2 = 55.
const radius = 55;
const developed = 200 + 100 + radius * Math.PI / 2;
const area = 50 * 6;
const profile: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [50, 0, 0] },
  { kind: 'segment', from: [50, 0, 0], to: [50, 6, 0] },
  { kind: 'segment', from: [50, 6, 0], to: [0, 6, 0] },
  { kind: 'segment', from: [0, 6, 0], to: [0, 0, 0] },
];
const sweep: SweepStepSpec = { kind: 'sweep', frenet: true, profile, path: [
  { kind: 'segment', from: [0, 0, 0], to: [0, 0, 200] },
  { kind: 'arc', center: [radius, 0, 200], radius, normal: [0, -1, 0], xAxis: [1, 0, 0],
    startAngle: Math.PI, endAngle: Math.PI / 2 },
  { kind: 'segment', from: [radius, 0, 200 + radius], to: [radius + 100, 0, 200 + radius] },
] };

describe('saved editable steel bend returns to the original assembly after cutting', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  it('re-tessellates the real swept shape with finite admission after a transverse cut', () => {
    const original = makeSweep(oc, sweep);
    try {
      // Existing sweep display settings differ from a cut's ordinary 0.1/0.5 settings.
      const sweepOptions = { linearDeflection: 0.15, angularDeflection: 0.7 };
      const first = tessellate(oc, original.shape, sweepOptions);
      expect(first.triangleCount).toBeGreaterThan(0);
      const cut = makeCut(oc, original.shape, { origin: [0, 0, 100], normal: [0, 0, 1], keepPositive: true });
      try {
        expect(tessellate(oc, cut.shape).triangleCount).toBeGreaterThan(0);
        expect(measureVolume(oc, cut.shape)).toBeCloseTo(area * (developed - 100), 5);
        expect(measureVolume(oc, original.shape)).toBeCloseTo(area * developed, 5);
        const refined = tessellate(oc, original.shape);
        expect(refined.triangleCount).toBeGreaterThan(first.triangleCount);
        const again = tessellate(oc, original.shape, { ...sweepOptions, admission: {
          remainingTriangles: first.triangleCount,
          remainingJsBytes: first.positions.byteLength + first.normals.byteLength + first.indices.byteLength
            + first.faceRanges.length * 64,
          checkDeadline: () => {},
        } }, undefined, { origin: [0, 0, 0], maximumFloat32ErrorMm: 1e-4 });
        expect(again.positions).toEqual(first.positions);
        expect(again.indices).toEqual(first.indices);
        expect(again.normals).toEqual(first.normals);
        expect(again.faceRanges).toEqual(first.faceRanges);
        // The local reply must not reset the borrowed shape's refined mesh as a side effect.
        const retained = tessellate(oc, original.shape);
        expect(retained.positions).toEqual(refined.positions);
        expect(retained.normals).toEqual(refined.normals);
        expect(retained.indices).toEqual(refined.indices);
        expect(retained.faceRanges).toEqual(refined.faceRanges);
      } finally { cut.delete(); }
    } finally { original.delete(); }
  });

  it('recomputes sweep, cut, original sweep and machined sweep through one measured cache', async () => {
    const cache = createShapeCache<CachedSolid>(20, undefined, entry => solidMeshBuffers(entry.mesh));
    const stock: SolidStepRequest = { id: 'steel-bend-sweep-0', key: 'saved-bend', label: 'Steel sweep 0', visible: true, step: sweep };
    const cut: SolidStepRequest = { id: 'cut-1', key: 'saved-bend-cut', label: 'Cut 1', visible: true,
      step: { kind: 'cut', targetKey: stock.key, origin: [0, 0, 100], normal: [0, 0, 1], keepPositive: true } };
    const localMesh = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 };
    const cases = [
      { steps: [stock], volume: area * developed, id: stock.id },
      { steps: [{ ...stock, visible: false }, cut], volume: area * (developed - 100), id: cut.id },
      { steps: [stock], volume: area * developed, id: stock.id },
      { steps: [{ ...stock, visible: false }, cut], volume: area * (developed - 100), id: cut.id },
    ];
    try {
      for (const [index, item] of cases.entries()) {
        const result = await recomputeSolids({ oc, cache }, { steps: item.steps, generation: index + 1, localMesh });
        expect(result.cancelled).toBe(false);
        expect(result.failures, `generation ${index + 1}`).toEqual([]);
        expect(result.bodies.map(body => body.id)).toEqual([item.id]);
        expect(result.bodies[0].volume).toBeCloseTo(item.volume, 5);
        expect(result.bodies[0].triangleCount).toBeGreaterThan(0);
        expect(result.bodies[0].positions.length).toBeGreaterThan(0);
      }
    } finally { cache.clear(); }
  });
});
