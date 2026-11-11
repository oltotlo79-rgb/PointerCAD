import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveStepSpec, Vec3Tuple } from '../types.js';
import { createKernelApi } from '../worker/kernelApi.js';
import type { CachedSolid } from '../worker/recomputeSolids.js';
import { createShapeCache } from '../worker/shapeCache.js';
import { buildExportMesh } from './exportMesh.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { readStl, STL_NO_FACE_MESSAGE, STL_READ_FAILED_MESSAGE } from './readStl.js';
import { buildSolidBodyMesh, isValidShape, measureArea, measureVolume } from './solidMesh.js';
import { writeStl } from './writeStl.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });

// Same ordinary box as pg5aSolidPixelsFlow, with independently derived expectations.
// Every input and corner is dyadic, exactly representable in binary64 at all three offsets.
const OFFSETS = [0, 1e6, 1e9] as const;
const VOLUME = 3 / 64; // (1/2)(3/8)(1/4) mm^3.
const AREA = 13 / 16; // 2(3/16 + 1/8 + 3/32) mm^2.
const HALF = [1 / 4, 3 / 16, 1 / 8] as const;

function box(offset: number): PrimitiveStepSpec {
  return { kind: 'primitive', origin: [offset + 3 / 128, offset + 5 / 128, offset + 7 / 128],
    axis: [0, 0, 1], originQuery: null, targetKey: null,
    shape: { kind: 'box', sizeX: 0.5, sizeY: 0.375, sizeZ: 0.25 } };
}

function closePoint(actual: Vec3Tuple, expected: Vec3Tuple): boolean {
  return actual.every((value, axis) => Math.abs(value - expected[axis]) <= 1e-7);
}

describe('PG5A ordinary Part: pixel-independent native geometry', () => {
  it.each(OFFSETS)('absolute box at %s mm retains volume, corners and outward faces', offset => {
    const input = box(offset), handle = makePrimitive(oc, input);
    try {
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(Math.abs(measureVolume(oc, handle.shape) - VOLUME) / VOLUME).toBeLessThan(1e-6);
      expect(Math.abs(measureArea(oc, handle.shape) - AREA) / AREA).toBeLessThan(1e-6);
      // Positions/centroids below are read from native topology, never Float32 display vertices.
      const native = buildSolidBodyMesh(oc, 'pg5a', handle.shape);
      expect([native.faceCount, native.edgeCount, native.vertices.length]).toEqual([6, 12, 8]);
      const low = [offset - 29 / 128, offset - 19 / 128, offset - 9 / 128];
      const high = [offset + 35 / 128, offset + 29 / 128, offset + 23 / 128];
      for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
        expect(native.vertices.filter(vertex => closePoint(vertex.position, [x, y, z]))).toHaveLength(1);
      }
      // Six analytic face centers, areas and normals; no expected result comes from the SUT.
      for (let axis = 0; axis < 3; axis += 1) for (const sign of [-1, 1]) {
        const normal: Vec3Tuple = [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];
        const center: Vec3Tuple = [input.origin[0] + normal[0] * HALF[0],
          input.origin[1] + normal[1] * HALF[1], input.origin[2] + normal[2] * HALF[2]];
        const faces = native.faces.filter(face => face.axis !== null && closePoint(face.axis, normal));
        expect(faces).toHaveLength(1);
        expect(faces[0].surfaceKind).toBe('plane');
        expect(closePoint(faces[0].centroid, center)).toBe(true);
        expect(Math.abs(faces[0].area - [3 / 32, 1 / 8, 3 / 16][axis])).toBeLessThanOrEqual(1e-7);
      }
    } finally { handle.delete(); }
  });
});

describe('PG5A STL representation controls', () => {
  it.each([0, 1e6] as const)('writes actual binary vertices and outward normals at %s mm', offset => {
    const handle = makePrimitive(oc, box(offset));
    try {
      const written = writeStl([buildExportMesh(oc, handle.shape, 0.02)], { ascii: false });
      expect(written.triangleCount).toBe(12);
      expect(written.droppedTriangleCount).toBe(0);
      expect(written.bytes.length).toBe(684);
      // At 1e6, binary32 spacing is 2^(19-23)=1/16 mm. Rounding the analytic corners
      // gives these exact bounds and a center shift [-3/128, 3/128, 1/128] mm.
      const low = offset === 0 ? [-29 / 128, -19 / 128, -9 / 128] : [offset - 1 / 4, offset - 1 / 8, offset - 1 / 16];
      const high = offset === 0 ? [35 / 128, 29 / 128, 23 / 128] : [offset + 1 / 4, offset + 1 / 4, offset + 3 / 16];
      const encoded = new DataView(written.bytes.buffer, written.bytes.byteOffset, written.bytes.byteLength);
      const minima = [Infinity, Infinity, Infinity], maxima = [-Infinity, -Infinity, -Infinity];
      const normals = new Map<string, number>();
      for (let triangle = 0; triangle < 12; triangle += 1) {
        const base = 84 + 50 * triangle;
        const normal = [0, 4, 8].map(byte => encoded.getFloat32(base + byte, true));
        const nonzero = normal.filter(value => value !== 0);
        expect(nonzero).toHaveLength(1);
        expect(Math.abs(nonzero[0])).toBe(1);
        normals.set(normal.join(','), (normals.get(normal.join(',')) ?? 0) + 1);
        for (let corner = 0; corner < 3; corner += 1) for (let axis = 0; axis < 3; axis += 1) {
          const value = encoded.getFloat32(base + 12 + corner * 12 + axis * 4, true);
          expect([low[axis], high[axis]]).toContain(value);
          minima[axis] = Math.min(minima[axis], value); maxima[axis] = Math.max(maxima[axis], value);
          // On the positive/negative face, all three vertices lie on its analytic plane.
          if (normal[axis] !== 0) expect(value).toBe(normal[axis] > 0 ? high[axis] : low[axis]);
        }
      }
      expect(minima).toEqual(low); expect(maxima).toEqual(high);
      expect(normals.size).toBe(6);
      expect([...normals.values()]).toEqual([2, 2, 2, 2, 2, 2]);
      if (offset === 0) expect(Math.abs(readStl(oc, written.bytes).volume - VOLUME)).toBeLessThanOrEqual(1e-7);
      // Exporting must not move or degrade the native B-rep.
      expect(Math.abs(measureVolume(oc, handle.shape) - VOLUME) / VOLUME).toBeLessThan(1e-6);
    } finally { handle.delete(); }
  });

  it('demonstrates that 1e9 absolute binary32 coordinates collapse all twelve native-box triangles', () => {
    const handle = makePrimitive(oc, box(1e9));
    try {
      // IEEE-754 binary32 spacing is 2^(29-23)=64 mm; each designed corner rounds to 1e9.
      // This is a negative format control, not acceptance of a successful empty export.
      const mesh = buildExportMesh(oc, handle.shape, 0.02);
      expect(new Set(mesh.positions)).toEqual(new Set([1e9]));
      for (const ascii of [false, true]) {
        const written = writeStl([mesh], { ascii });
        expect(written.triangleCount).toBe(0);
        expect(written.droppedTriangleCount).toBe(12);
        // Empty ASCII is shorter than readStl's 84-byte preflight minimum; binary has its zero-count header.
        expect(() => readStl(oc, written.bytes)).toThrow(ascii ? STL_READ_FAILED_MESSAGE : STL_NO_FACE_MESSAGE);
      }
      expect(Math.abs(measureVolume(oc, handle.shape) - VOLUME) / VOLUME).toBeLessThan(1e-6);
    } finally { handle.delete(); }
  });

  it.each([false, true])('refuses an empty STL at the public native export boundary (ascii=%s)', async ascii => {
    const cache = createShapeCache<CachedSolid>();
    const api = createKernelApi(() => Promise.resolve(oc), cache);
    try {
      const built = await api.recomputeSolids({ generation: 1, steps: [{ id: 'pg5a', key: 'pg5a-billion',
        label: 'pg5a', visible: true, step: box(1e9) }] });
      expect(built.failures).toEqual([]);
      expect(built.bodies).toHaveLength(1);
      expect(Math.abs(built.bodies[0].volume - VOLUME) / VOLUME).toBeLessThan(1e-6);
      await expect(api.exportShapes({ format: 'stl', bodies: [{ bodyKey: 'pg5a-billion', name: 'pg5a', color: null }],
        deviationMm: 0.02, ascii })).rejects.toThrow(
        'STL に書き出せる面がありません。原点に近い位置へ移動するか、STEP を使ってください。');
    } finally { cache.clear(); }
  });
});
