import { describe, expect, it } from 'vitest';

import { checkedExportAdd, checkedExportMultiply, ExportWorkBudget, ExportWorkLimitError,
  EXPORT_JS_BYTE_LIMIT, EXPORT_TRIANGLE_LIMIT, exportSerializationReserve } from './exportWorkLimits.js';

describe('export request admission', () => {
  it('accepts exactly one million triangles, but rejects one more across bodies without mutating totals', () => {
    expect(() => new ExportWorkBudget(() => 0, EXPORT_TRIANGLE_LIMIT + 1))
      .toThrow(ExportWorkLimitError);
    const work = new ExportWorkBudget(() => 0);
    work.admitMesh(400_000, 0, 0, 0, 0);
    work.admitMesh(600_000, 0, 0, 0, 0);
    expect(work.triangleCount).toBe(EXPORT_TRIANGLE_LIMIT);
    expect(work.remainingTriangles).toBe(0);
    expect(() => work.admitMesh(1, 0, 0, 0, 0)).toThrow(ExportWorkLimitError);
    expect(work.triangleCount).toBe(EXPORT_TRIANGLE_LIMIT);
  });

  it('checks integer arithmetic and all mesh/output bytes before output reservation', () => {
    expect(() => checkedExportAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(ExportWorkLimitError);
    expect(() => checkedExportMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(ExportWorkLimitError);
    expect(() => checkedExportMultiply(1.5, 4)).toThrow(ExportWorkLimitError);
    const work = new ExportWorkBudget(() => 0);
    work.admitMesh(1, EXPORT_JS_BYTE_LIMIT - 100, 0, 0, 0);
    expect(() => work.reserveOutput(101)).toThrow(ExportWorkLimitError);
    expect(work.usedBytes).toBe(EXPORT_JS_BYTE_LIMIT - 100);
    work.reserveOutput(100);
    expect(work.usedBytes).toBe(EXPORT_JS_BYTE_LIMIT);
    expect(() => work.verifySerializedOutput(101)).toThrow(ExportWorkLimitError);
  });

  it('checks deadline at 25 seconds between bodies and before serialization', () => {
    let clock = 1_000;
    const work = new ExportWorkBudget(() => clock);
    clock = 25_999;
    expect(() => work.admitMesh(1, 0, 0, 0, 0)).not.toThrow();
    clock = 26_000;
    expect(() => work.reserveOutput(1)).toThrow(ExportWorkLimitError);
    expect(work.usedBytes).toBe(0);
    expect(work.triangleCount).toBe(1);
  });

  it('reserves deterministic binary STL bytes and bounds other serializers before writing', () => {
    expect(exportSerializationReserve('stl-binary', 1_000_000, 2, 0)).toBe(50_012_288);
    expect(exportSerializationReserve('stl-ascii', 1_000_000, 2, 0)).toBeGreaterThan(EXPORT_JS_BYTE_LIMIT);
    expect(exportSerializationReserve('obj', 1_000_000, 2, 0)).toBeGreaterThan(EXPORT_JS_BYTE_LIMIT);
    expect(() => exportSerializationReserve('gltf', Number.MAX_SAFE_INTEGER, 1, 0))
      .toThrow(ExportWorkLimitError);
  });

  it('admits native file bytes cumulatively but never treats post-call size as pre-admission', () => {
    const work = new ExportWorkBudget(() => 0);
    work.admitNativeOutput(EXPORT_JS_BYTE_LIMIT - 1);
    expect(() => work.admitNativeOutput(2)).toThrow(ExportWorkLimitError);
    expect(work.usedBytes).toBe(EXPORT_JS_BYTE_LIMIT - 1);
  });
});
