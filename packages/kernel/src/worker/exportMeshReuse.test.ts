import { describe, expect, it, vi } from 'vitest';
import type { ExportMesh } from '../occt/exportMesh.js';
import { TESSELLATION_ADMISSION_MESSAGE } from '../occt/tessellate.js';
import { writeStl } from '../occt/writeStl.js';
import { writeCafMesh } from '../occt/writeCafMesh.js';
import { buildRequestExportMeshes } from './exportMeshReuse.js';
import { EXPORT_JS_BYTE_LIMIT, ExportWorkBudget, ExportWorkLimitError } from './exportWorkLimits.js';

function triangle(x = 0): ExportMesh {
  return {
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    faceRanges: [{ triangleOffset: 0, triangleCount: 1 }],
  };
}

describe('request-local export mesh reuse', () => {
  it('builds one identical shape once but counts every occurrence', () => {
    const shape = {};
    const build = vi.fn(() => triangle());
    const work = new ExportWorkBudget(() => 0);
    const meshes = buildRequestExportMeshes(Array.from({ length: 1000 }, () => shape), work, build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(meshes).toHaveLength(1000);
    expect(work.triangleCount).toBe(1000);
    // Nine position floats, nine normal floats, three uint32 indices, one face reservation.
    expect(work.usedBytes).toBe(1000 * (36 + 36 + 12 + 64));
    expect(writeStl(meshes, { ascii: false }).triangleCount).toBe(1000);
  });

  it('keeps distinct shape identities and their placement coordinates in occurrence order', () => {
    const a = {}; const b = {};
    const build = vi.fn((shape: object) => triangle(shape === a ? 0 : 20));
    const meshes = buildRequestExportMeshes([a, b, a], new ExportWorkBudget(() => 0), build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(meshes.map((mesh) => mesh.positions[0])).toEqual([0, 20, 0]);
    expect(writeStl(meshes, { ascii: false }).bytes).toEqual(
      writeStl([triangle(), triangle(20), triangle()], { ascii: false }).bytes,
    );
  });

  it('returns independent mutable arrays and face records for repeated occurrences', () => {
    const shape = {}; const original = triangle();
    const meshes = buildRequestExportMeshes([shape, shape], new ExportWorkBudget(() => 0), () => original);
    const first = meshes[0]; const second = meshes[1];
    expect(first).toBe(original);
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(second.normals.buffer).not.toBe(first.normals.buffer);
    expect(second.indices.buffer).not.toBe(first.indices.buffer);
    expect(second.faceRanges).toEqual(first.faceRanges);
    expect(second.faceRanges?.[0]).not.toBe(first.faceRanges?.[0]);
    second.positions[0] = 99; second.normals[2] = -1; second.indices[0] = 2;
    expect(first).toEqual(triangle());
  });

  it('preserves independent names and colors through real OBJ and glTF writers without mutating meshes', () => {
    const shape = {};
    const meshes = buildRequestExportMeshes([shape, shape], new ExportWorkBudget(() => 0), () => triangle());
    for (const format of ['obj', 'gltf'] as const) {
      const actual = writeCafMesh([
        { mesh: meshes[0], name: 'first-red', color: [1, 0, 0] },
        { mesh: meshes[1], name: 'second-blue', color: [0, 0, 1] },
      ], { format });
      const independent = writeCafMesh([
        { mesh: triangle(), name: 'first-red', color: [1, 0, 0] },
        { mesh: triangle(), name: 'second-blue', color: [0, 0, 1] },
      ], { format });
      expect(actual).toEqual(independent);
      expect(actual.triangleCount).toBe(2);
      const text = actual.files.map((file) => new TextDecoder().decode(file.bytes)).join('\n');
      expect(text).toContain('first-red');
      expect(text).toContain('second-blue');
      expect(meshes).toEqual([triangle(), triangle()]);
    }
  });

  it('refuses a repeated occurrence before copying when cumulative triangle capacity is exhausted', () => {
    const shape = {}; const original = triangle();
    const copy = vi.spyOn(original.positions, 'slice');
    const build = vi.fn(() => original);
    const work = new ExportWorkBudget(() => 0, 1);
    expect(() => buildRequestExportMeshes([shape, shape], work, build)).toThrow(TESSELLATION_ADMISSION_MESSAGE);
    expect(build).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
    expect(work.triangleCount).toBe(1);
    expect(work.usedBytes).toBe(148);
  });

  it('refuses insufficient per-occurrence memory before copying and retains admitted totals', () => {
    const shape = {}; const original = triangle();
    const copy = vi.spyOn(original.positions, 'slice');
    const work = new ExportWorkBudget(() => 0);
    work.admitNativeOutput(EXPORT_JS_BYTE_LIMIT - 148 - 147);
    expect(() => buildRequestExportMeshes([shape, shape], work, () => original)).toThrow(TESSELLATION_ADMISSION_MESSAGE);
    expect(copy).not.toHaveBeenCalled();
    expect(work.usedBytes).toBe(EXPORT_JS_BYTE_LIMIT - 147);
    expect(work.triangleCount).toBe(1);
  });

  it('refuses a cached two-triangle mesh when only one triangle remains', () => {
    const shape = {};
    const mesh: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      triangleCount: 2,
      faceRanges: [{ triangleOffset: 0, triangleCount: 2 }],
    };
    const copy = vi.spyOn(mesh.positions, 'slice');
    const work = new ExportWorkBudget(() => 0, 3);
    expect(() => buildRequestExportMeshes([shape, shape], work, () => mesh)).toThrow(TESSELLATION_ADMISSION_MESSAGE);
    expect(copy).not.toHaveBeenCalled();
    expect(work.triangleCount).toBe(2);
  });

  it('checks the deadline on cache hits rather than letting reuse bypass time admission', () => {
    const shape = {}; let clock = 0; let reads = 0;
    const work = new ExportWorkBudget(() => { reads += 1; return reads >= 4 ? 25_000 : clock; });
    const build = vi.fn(() => { clock = 0; return triangle(); });
    expect(() => buildRequestExportMeshes([shape, shape], work, build)).toThrow(ExportWorkLimitError);
    expect(build).toHaveBeenCalledTimes(1);
    expect(work.triangleCount).toBe(1);
  });

  it('retains no mesh after successful or failed calls and accepts a fresh quality result', () => {
    const shape = {}; const failure = new Error('native build failed');
    const build = vi.fn(() => triangle());
    buildRequestExportMeshes([shape, shape], new ExportWorkBudget(() => 0), build);
    buildRequestExportMeshes([shape], new ExportWorkBudget(() => 0), build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(() => buildRequestExportMeshes([shape, {}], new ExportWorkBudget(() => 0), (item) => {
      if (item !== shape) throw failure;
      return triangle();
    })).toThrow(failure);
    const next = vi.fn(() => triangle(7));
    expect(buildRequestExportMeshes([shape], new ExportWorkBudget(() => 0), next)[0].positions[0]).toBe(7);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
