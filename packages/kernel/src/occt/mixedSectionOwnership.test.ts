import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import * as cuts from './makeCut.js';
import * as booleans from './booleanOp.js';
import { makeSectionShape } from './makeSectionShape.js';
import { measureVolume } from './solidMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

describe('section replacement keeps the new native result owned before releasing the old', () => {
  it.each([false, true])('old-cut cleanup failure=%s neither leaks replacement nor retries native delete', failCleanup => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const nativeCut = cuts.makeCut;
    const nativeBoolean = booleans.booleanOp;
    const observed: { deletes: number; dispose: () => void }[] = [];
    try {
      vi.spyOn(booleans, 'booleanOp').mockImplementation((...args) => {
        const result = nativeBoolean(...args);
        if (args[1] === 'subtract') {
          const entry = { deletes: 0, dispose: result.delete.bind(result) };
          observed.push(entry);
          result.delete = () => { entry.deletes++; entry.dispose(); };
        }
        return result;
      });
      vi.spyOn(cuts, 'makeCut').mockImplementation((...args) => {
        const handle = nativeCut(...args);
        const entry = { deletes: 0, dispose: handle.delete.bind(handle) };
        observed.push(entry);
        const shouldFail = failCleanup && observed.length === 1;
        handle.delete = () => {
          entry.deletes++; entry.dispose();
          if (shouldFail) throw new Error('injected old section cleanup');
        };
        return handle;
      });
      const result = makeSectionShape(oc, { target: box.shape,
        plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 1] },
        keepSide: 'positive', kind: 'half', boundary: [[10, 0], [10, 20]],
      });
      expect(result.ok).toBe(!failCleanup);
      if (result.ok) {
        try { expect(result.volume).toBeCloseTo(6000, 6); }
        finally { result.delete(); result.delete(); }
      }
      expect(observed.length).toBeGreaterThanOrEqual(3);
      expect(observed.map(entry => entry.deletes)).toEqual(observed.map(() => 1));
      expect(measureVolume(oc, box.shape)).toBeCloseTo(8000, 6);
    } finally {
      vi.restoreAllMocks();
      for (const entry of observed) if (entry.deletes === 0) entry.dispose();
      box.delete();
    }
  });
});
