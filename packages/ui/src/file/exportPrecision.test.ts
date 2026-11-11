import { describe, expect, it } from 'vitest';

import {
  displayMeshDimensionsMm,
  formatDisplayMeshDimensions,
  parseExportDeviationMm,
} from './exportPrecision.js';

describe('詳細指定の出力偏差', () => {
  it('mm の正の有限な値を精度を失わず受け取る', () => {
    for (const value of ['0.005', '0.05', '0.5', '1e-7', '1e-300', '1e308']) {
      expect(parseExportDeviationMm(value)).toBe(Number(value));
    }
  });

  it('空欄・0・負・NaN・Infinity を拒否する', () => {
    for (const value of ['', ' ', '0', '-0.05', 'NaN', 'Infinity', '-Infinity', '1,2',
      '0x10', '0b11', '1e999', '1e-999']) {
      expect(parseExportDeviationMm(value)).toBeNull();
    }
  });
});

describe('出力前の表示メッシュ寸法', () => {
  it.each([0, 1e6, 1e9])('別々の局所原点を持つ10mmの箱2個の外形を保つ: %s mm', (x) => {
    const positions = new Float32Array([0, 0, 0, 10, 10, 10, 0, 10, 0]);
    const meshes = [x, x + 100].map(originX => ({ positions, coordinateFrame: {
      space: 'local' as const, origin: [originX, 0, 0] as const, maximumFloat32ErrorMm: 1e-4,
    } }));
    expect(displayMeshDimensionsMm(meshes)).toEqual([110, 10, 10]);
    expect(displayMeshDimensionsMm([meshes[1]])).toEqual([10, 10, 10]);
    expect([...positions]).toEqual([0, 0, 0, 10, 10, 10, 0, 10, 0]);
  });

  it('局所座標と従来の世界座標を混在させても全体の寸法を保つ', () => {
    const positions = new Float32Array([0, 0, 0, 10, 10, 10, 0, 10, 0]);
    expect(displayMeshDimensionsMm([{ positions }, { positions, coordinateFrame: {
      space: 'local', origin: [100, 0, 0], maximumFloat32ErrorMm: 1e-4,
    } }])).toEqual([110, 10, 10]);
  });

  it('不正な局所原点または精度を寸法へ採用しない', () => {
    const positions = new Float32Array([0, 0, 0, 10, 10, 10, 0, 10, 0]);
    for (const invalid of [Number.NaN, Infinity, -Infinity]) {
      expect(displayMeshDimensionsMm([{ positions, coordinateFrame: {
        space: 'local', origin: [invalid, 0, 0], maximumFloat32ErrorMm: 1e-4,
      } }])).toBeNull();
    }
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(displayMeshDimensionsMm([{ positions, coordinateFrame: {
        space: 'local', origin: [0, 0, 0], maximumFloat32ErrorMm: invalid,
      } }])).toBeNull();
    }
  });

  it('同じ座標を mm と inch で既存測定の丸め規則に合わせる', () => {
    const dimensions = displayMeshDimensionsMm([{ positions: new Float32Array([
      0, 0, 0, 25.4, 50.8, 76.2, 0, 50.8, 0,
    ]) }]);
    expect(dimensions).not.toBeNull();
    if (dimensions === null) return;
    expect(dimensions[0]).toBeCloseTo(25.4, 5);
    expect(dimensions[1]).toBeCloseTo(50.8, 5);
    expect(dimensions[2]).toBeCloseTo(76.2, 5);
    expect(formatDisplayMeshDimensions(dimensions, 'inch')).toBe('1.000 in × 2.000 in × 3.000 in');
    expect(formatDisplayMeshDimensions(dimensions, 'mm')).toBe('25.4 mm × 50.8 mm × 76.2 mm');
  });

  it('空・不正座標の寸法を推測しない', () => {
    expect(displayMeshDimensionsMm([])).toBeNull();
    expect(displayMeshDimensionsMm([{ positions: new Float32Array() }])).toBeNull();
    expect(displayMeshDimensionsMm([{ positions: new Float32Array([1, 2]) }])).toBeNull();
    expect(displayMeshDimensionsMm([{ positions: new Float32Array([0, 0, 0, 1, 1, 1]) }])).toBeNull();
    expect(displayMeshDimensionsMm([{ positions: new Float32Array([
      0, 0, 0, 1, 1, 1, 0, 1, Number.NaN,
    ]) }])).toBeNull();
  });

  it('複数の立体では全体の外寸を取り、各立体の寸法を足さない', () => {
    expect(displayMeshDimensionsMm([
      { positions: new Float32Array([-5, 0, 0, 0, 10, 10, -5, 10, 0]) },
      { positions: new Float32Array([10, -2, 3, 20, 8, 13, 10, 8, 3]) },
    ])).toEqual([25, 12, 13]);
  });
});
