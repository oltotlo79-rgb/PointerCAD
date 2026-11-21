import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as blendModule from '../occt/makeBlendSurface.js';
import { writeBrepBytes } from '../occt/brepBytes.js';
import { makeCompound } from '../occt/transformShape.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { FunctionSurfaceGeometrySpec } from '../occt/functionSurfaceGeometrySpec.js';
import type { SolidStepRequest, SolidStepSpec, Vec3Tuple } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

const corners: Vec3Tuple[] = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
const mesh: FunctionSurfaceGeometrySpec = { vertices: corners, triangles: [[0, 1, 2], [0, 2, 3]],
  bounds: { minimum: [-1, -1, -1], maximum: [101, 101, 1] } };
const ordinary: SolidStepSpec = { kind: 'surface', targetKey: null, shape: { kind: 'planar',
  profile: corners.map((from, index) => ({ kind: 'segment', from, to: corners[(index + 1) % corners.length] })) } };

// A bicubic Bezier patch with four equally spaced poles on each axis represents (100u,100v,0) exactly.
const coordinates = [0, 100 / 3, 200 / 3, 100];
const smooth: SolidStepSpec = { kind: 'functionSurface', geometry: { ...mesh, spline: {
  uKnots: [0, 1], vKnots: [0, 1], errorBound: 0,
  poles: coordinates.flatMap(x => coordinates.map((y): Vec3Tuple => [x, y, 0])),
} } };

function request(key: string, step: SolidStepSpec, visible = true): SolidStepRequest {
  return { id: key, key, label: key, visible, step };
}

describe('面だけのボディを使う再計算の段', () => {
  it.each([{ name: 'FR-428', source: ordinary }, { name: '平面スプライン', source: smooth }])(
    '$name の 100 mm 角を 3 mm 離し、厚み 5 mm の体積を測る', async ({ source }) => {
      const cache = createShapeCache<CachedSolid>();
      try {
        const sheet = request('sheet', source);
        const offset = request('offset', { kind: 'offsetBody', targetKey: sheet.key, distance: -3 });
        const first = await recomputeSolids({ oc, cache }, { generation: 1, steps: [sheet, offset], measureAreas: true });
        expect(first.failures).toEqual([]);
        expect(first.bodies.map(body => body.bodyKind)).toEqual(['shell', 'shell']);
        for (const body of first.bodies) {
          expect(body.faces).toHaveLength(1);
          expect(body.area).toBeCloseTo(10_000, 6);
        }
        const sourceZ = first.bodies[0].faces[0].centroid[2], offsetZ = first.bodies[1].faces[0].centroid[2];
        expect(Math.abs(offsetZ - sourceZ)).toBeCloseTo(3, 8);
        const wall = request('wall', { kind: 'thicken', targetKey: offset.key, thickness: 5, side: 'both' });
        const next = await recomputeSolids({ oc, cache }, { generation: 2, steps: [sheet, { ...offset, visible: false }, wall] });
        expect(next.failures).toEqual([]);
        expect(next.cacheHits).toBe(2);
        expect(next.bodies.map(body => [body.id, body.bodyKind])).toEqual([['sheet', 'shell'], ['wall', 'solid']]);
        expect(Math.abs(next.bodies[1].volume / 50_000 - 1)).toBeLessThanOrEqual(1e-9);
      } finally { cache.clear(); }
    });

  it('平面の三角形を一面に統合してもキャッシュから両操作を拒否し、元の面を表示する', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const sheet = request('facets', { kind: 'functionSurface', geometry: mesh }, false);
      const mirror = request('mirror', { kind: 'mirror', targetKey: sheet.key, origin: [0, 0, 0], normal: [1, 0, 0] }, false);
      const first = await recomputeSolids({ oc, cache }, { generation: 1, steps: [sheet, mirror] });
      expect(first.failures).toEqual([]);
      const next = await recomputeSolids({ oc, cache }, { generation: 2, steps: [sheet, mirror,
        request('offset', { kind: 'offsetBody', targetKey: mirror.key, distance: 1 }),
        request('wall', { kind: 'thicken', targetKey: sheet.key, thickness: 5, side: 'normal' }),
      ] });
      expect(next.cacheHits).toBe(2);
      expect(next.failures.map(({ id, code }) => [id, code])).toEqual([
        ['offset', 'faceted-function-surface'], ['wall', 'faceted-function-surface'],
      ]);
      expect(next.bodies.map(body => body.id)).toEqual([sheet.id]);
    } finally { cache.clear(); }
  });

  it('読み込んだ面ボディの離れた二成分をどちらも厚み付けする', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const sheet = request('sheet', ordinary);
      const second = request('second', { kind: 'offsetBody', targetKey: sheet.key, distance: 20 });
      const initial = await recomputeSolids({ oc, cache }, { generation: 1, steps: [sheet, second] });
      expect(initial.failures).toEqual([]);
      const firstShape = cache.get(sheet.key), secondShape = cache.get(second.key);
      if (!firstShape || !secondShape) throw new Error('面を再計算できませんでした。');
      const pair = makeCompound(oc, [firstShape.shape, secondShape.shape]);
      try {
        const input = request('import', { kind: 'importedSolid', bytes: writeBrepBytes(oc, pair.shape) }, false);
        const wall = request('wall', { kind: 'thicken', targetKey: input.key, thickness: 5, side: 'normal' });
        const result = await recomputeSolids({ oc, cache }, { generation: 2, steps: [input, wall] });
        expect(result.failures).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        expect(result.bodies[0].bodyKind).toBe('solid');
        expect(Math.abs(result.bodies[0].volume / 100_000 - 1)).toBeLessThanOrEqual(1e-9);
      } finally { pair.delete(); }
    } finally { cache.clear(); }
  });

  it('つなぎの許容超過を計算部の理由と文のまま返し、借りた面だけを残す', async () => {
    const cache = createShapeCache<CachedSolid>();
    const fit = vi.spyOn(blendModule, 'makeBlendSurface');
    try {
      const sheet = request('sheet', ordinary);
      const initial = await recomputeSolids({ oc, cache }, { generation: 1, steps: [sheet] });
      expect(initial.failures).toEqual([]);
      const boundary = (y: number) => {
        const matches = initial.bodies[0].edges.filter(edge => edge.axis !== null && Math.abs(edge.axis[0]) > 0.99
          && Math.abs(edge.midpoint[1] - y) < 1e-6);
        expect(matches).toHaveLength(1);
        const [edge] = matches;
        return { sourceKey: sheet.key, query: { kind: 'edge' as const, index: edge.index, curveKind: edge.curveKind,
          length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
      };
      fit.mockResolvedValue({ status: 'outside-tolerance', exceeded: ['angle'],
        measurement: { withinTolerance: false, maxDistanceMm: 0, maxAngleDeg: 1 } });
      const join = request('blend', { kind: 'blend', a: boundary(0), b: boundary(100), weightA: 5, weightB: 6, flipB: false });
      const result = await recomputeSolids({ oc, cache }, { generation: 2, steps: [sheet, join] }, {}, undefined, () => false);
      expect(fit).toHaveBeenCalledTimes(1);
      expect(result.failures).toEqual([{ id: join.id, code: 'outside-tolerance', message: 'outside-tolerance' }]);
      expect(result.cancelled).toBe(false);
      expect(result.bodies.map(value => value.id)).toEqual([sheet.id]);
      expect(cache.has(join.key)).toBe(false);
    } finally { fit.mockRestore(); cache.clear(); }
  });

  it('立体を対象にした場合は面ボディが必要だと知らせ、元の立体を保持する', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const sheet = request('sheet', ordinary, false);
      const solid = request('solid', { kind: 'thicken', targetKey: sheet.key, thickness: 5, side: 'reverse' }, false);
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps: [sheet, solid,
        request('invalid', { kind: 'thicken', targetKey: solid.key, thickness: 1, side: 'normal' })] });
      expect(result.failures).toMatchObject([{ id: 'invalid', code: 'invalid-surface-body' }]);
      expect(result.bodies.map(body => body.id)).toEqual(['solid']);
      expect(cache.has('invalid')).toBe(false);
    } finally { cache.clear(); }
  });
});
