import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadOcctForNode } from './loadOcct.node.js';
import { writeBrepBytes } from './brepBytes.js';
import { createKernelApi } from '../worker/kernelApi.js';
import { createShapeCache } from '../worker/shapeCache.js';
import { solidMeshBuffers, type CachedSolid } from '../worker/recomputeSolids.js';
import type { SolidStepRequest, SubShapeQuery } from '../types.js';

const TIMEOUT = 180_000;
beforeAll(loadOcctForNode, TIMEOUT);
const box: SolidStepRequest = { id: 'box', key: 'box-key', label: 'box', visible: true,
  step: { kind: 'extrude', profile: [
    { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
    { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
    { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
    { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
  ], direction: [0, 0, 1], distance: 8 } };

describe('direct edit worker ownership and refusal routing', () => {
  it.each([false, true])('retains refused input display ownership and native SHA; local=%s', async local => {
    const oc = await loadOcctForNode();
    const cache = createShapeCache<CachedSolid>(64, undefined, entry => solidMeshBuffers(entry.mesh));
    const api = createKernelApi(loadOcctForNode, cache);
    const localMesh = local ? { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 128 * 1024 * 1024 } : undefined;
    try {
      const first = await api.recomputeSolids({ partId: 'routes', steps: [box], generation: 1, localMesh });
      expect(first.failures).toEqual([]);
      const input = cache.get(box.key);
      if (input === undefined) throw new Error('missing borrowed input');
      const release = vi.spyOn(input, 'delete');
      const sha = () => createHash('sha256').update(writeBrepBytes(oc, input.shape)).digest('hex');
      const before = sha();
      const wrong: SubShapeQuery = { kind: 'vertex', index: 0, position: [0, 0, 0] };
      for (const kind of ['holeTranslate', 'faceRotate'] as const) {
        const bad: SolidStepRequest = { id: 'bad', key: `bad-${kind}`, label: 'bad', visible: true,
          step: kind === 'holeTranslate' ? { kind, targetKey: box.key, face: wrong, translation: [2, 0, 0] }
            : { kind, targetKey: box.key, face: wrong, hinge: wrong, angle: Math.PI / 36 } };
        const result = await api.recomputeSolids({ partId: 'routes', generation: 2,
          steps: [{ ...box, visible: false }, bad], localMesh });
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].id).toBe('bad');
        expect(result.bodies.map(body => body.id)).toEqual(['box']);
        expect(result.bodies[0].volume).toBeCloseTo(9600, 8);
        expect(cache.has(bad.key)).toBe(false);
        expect(cache.get(box.key)).toBe(input);
        expect(sha()).toBe(before);
        expect(release).not.toHaveBeenCalled();
        // Export through the actual current display-owner table, after refusal.
        const exported = await api.exportShapes({ partId: 'routes', format: 'stl', deviationMm: 0.1,
          bodies: [{ bodyKey: box.key, name: null, color: null }] });
        expect(exported.format).toBe('stl');
      }
      const next = await api.recomputeSolids({ partId: 'routes', generation: 3, steps: [box], localMesh });
      expect(next.failures).toEqual([]);
      expect(next.cacheHits).toBe(1);
      expect(release).not.toHaveBeenCalled();
      await api.releasePart('routes');
      cache.clear();
      expect(release).toHaveBeenCalledTimes(1);
      release.mockRestore();
    } finally { await api.releasePart('routes'); cache.clear(); }
  }, TIMEOUT);
});
