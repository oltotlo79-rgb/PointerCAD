import { beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';

describe('edge JS memory admission', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  it('admits native-known segments before number[] and Float32 growth, then preserves edge order', () => {
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const observations: { segments: number; edges: number }[] = [];
      const admitted = extractEdges(oc, handle.shape, {}, undefined, (segments, edges) => {
        observations.push({ segments, edges });
      });
      const ordinary = extractEdges(oc, handle.shape);
      expect(observations[0]).toEqual({ segments: 0, edges: 0 });
      expect(observations.at(-1)).toEqual({ segments: admitted.positions.length / 6,
        edges: admitted.edgeCount });
      expect(admitted).toEqual(ordinary);
      expect(admitted.edgeCount).toBe(12);
    } finally {
      handle.delete();
    }
  });

  it('rejects before the first segment array growth and leaves the native shape reusable', () => {
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      expect(() => extractEdges(oc, handle.shape, {}, undefined, (segments) => {
        if (segments > 0) throw new RangeError('edge budget');
      })).toThrow('edge budget');
      const retry = extractEdges(oc, handle.shape);
      expect(retry.edgeCount).toBe(12);
      expect(retry.positions.length).toBeGreaterThan(0);
    } finally {
      handle.delete();
    }
  });
});
