import { describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../types.js';
import {
  certifyCubicSurfaceInterior,
  type CubicKnotDirection,
  type CubicSurfaceCoefficients,
  type SurfaceParameterCell,
} from './functionSurfaceBounds.js';

const direction = (knots: readonly number[]): CubicKnotDirection => ({
  knots, multiplicities: knots.map((_, index) => index === 0 || index === knots.length - 1 ? 4 : 2),
});
const limits = (minimumZ: number, maximumZ: number) => ({
  minimum: [-10, -10, minimumZ] as Vec3Tuple,
  maximum: [10, 10, maximumZ] as Vec3Tuple,
});
const nowhereOutside = () => false;

/** Exact degree-elevation of x and 1-x² on [-1,1]; no production evaluator is used. */
function bulge(): CubicSurfaceCoefficients {
  const coordinate = [-1, -1 / 3, 1 / 3, 1], quadratic = [0, 4 / 3, 4 / 3, 0];
  return {
    u: direction([-1, 1]), v: direction([-1, 1]),
    poles: coordinate.flatMap((x, u) => coordinate.map((y, v): Vec3Tuple => [x, y, quadratic[u] * quadratic[v]])),
  };
}

/**
 * Independent Hermite construction: each interior node's two poles are its
 * value minus/plus one third of the adjacent span times its first derivative.
 * This represents an exact quadratic on arbitrarily nonuniform C1 cubic knots.
 */
function polynomialSurface(u: readonly number[], v: readonly number[],
  value: (x: number, y: number) => number, dx: (x: number, y: number) => number,
  dy: (x: number, y: number) => number, dxy: (x: number, y: number) => number): CubicSurfaceCoefficients {
  const sample = (knots: readonly number[], index: number): readonly [number, number] => {
    if (index === 0) return [knots[0], 0];
    if (index === 2 * knots.length - 1) return [knots[knots.length - 1], 0];
    const span = Math.floor((index - 1) / 2), third = (knots[span + 1] - knots[span]) / 3;
    return index % 2 === 1 ? [knots[span], third] : [knots[span + 1], -third];
  };
  const poles: Vec3Tuple[] = [];
  for (let row = 0; row < 2 * u.length; row++) {
    const [x, a] = sample(u, row);
    for (let column = 0; column < 2 * v.length; column++) {
      const [y, b] = sample(v, column);
      poles.push([x + a, y + b, value(x, y) + a * dx(x, y) + b * dy(x, y) + a * b * dxy(x, y)]);
    }
  }
  return { u: direction(u), v: direction(v), poles };
}

describe('C1双3次曲面の内部極値を制御点の包含と導関数で検査する', () => {
  it('全制御点の外包が箱を超える鞍面でも、内部極値だけは原点の値で保証する', () => {
    const knots = [-2, -0.5, 1, 2];
    const saddle = polynomialSurface(knots, knots, (x, y) => x * y, (_, y) => y, x => x, () => 1);
    const proof = certifyCubicSurfaceInterior(saddle, limits(-1.5, 1.5), 1e-6, nowhereOutside);
    expect(proof.certified).toBe(true);
    // This deliberately proves only the interior. The unclipped boundary is
    // outside the box and is rejected by the separate real-native regression.
    expect(saddle.poles.some(pole => Math.abs(pole[2]) > 1.5)).toBe(true);
  });

  it('非一様ノットの放物面は内部最小値0を含む範囲で通り、最小値を除く範囲で拒否する', () => {
    const paraboloid = polynomialSurface([-2, -0.125, 0.25, 2], [-3, -0.5, 1, 3],
      (x, y) => x * x + y * y, x => 2 * x, (_, y) => 2 * y, () => 0);
    expect(certifyCubicSurfaceInterior(paraboloid, limits(-0.1, 2), 1e-6, nowhereOutside).certified).toBe(true);
    expect(certifyCubicSurfaceInterior(paraboloid, limits(0.1, 2), 1e-6, nowhereOutside).certified).toBe(false);
  });

  it('全境界z=0でも内部最大値z=1を持つ曲面をz<=0.5として認めない', () => {
    const surface = bulge();
    expect(surface.poles.filter((_, index) => Math.floor(index / 4) % 3 === 0 || index % 4 % 3 === 0)
      .every(pole => pole[2] === 0)).toBe(true);
    expect(certifyCubicSurfaceInterior(surface, limits(-1, 0.5), 1e-6, nowhereOutside).certified).toBe(false);
    expect(certifyCubicSurfaceInterior(surface, limits(-1, 1), 1e-6, nowhereOutside).certified).toBe(true);
  });

  it('内部最大値を含む穴を全セル単位で除外できる場合だけ同じ曲面を認める', () => {
    const hole = (cell: SurfaceParameterCell) => cell.u0 > -0.75 && cell.u1 < 0.75
      && cell.v0 > -0.75 && cell.v1 < 0.75;
    // Outside this hole, either |x|>=0.75 or |y|>=0.75, hence z<=7/16<0.5.
    expect(certifyCubicSurfaceInterior(bulge(), limits(-1, 0.5), 1e-6, hole).certified).toBe(true);
    // An unrelated hole cannot excuse the retained center maximum.
    const wrongHole = (cell: SurfaceParameterCell) => cell.u0 > 0.75 && cell.v0 > 0.75;
    expect(certifyCubicSurfaceInterior(bulge(), limits(-1, 0.5), 1e-6, wrongHole).certified).toBe(false);
  });

  it('人工的なノット境界にある極大もC1条件により見逃さない', () => {
    const cap = polynomialSurface([-1, 0, 0.125, 1], [-1, -0.25, 0, 1],
      (x, y) => 1 - x * x - y * y, x => -2 * x, (_, y) => -2 * y, () => 0);
    expect(certifyCubicSurfaceInterior(cap, limits(-2, 0.9), 1e-6, nowhereOutside).certified).toBe(false);
    expect(certifyCubicSurfaceInterior(cap, limits(-2, 1), 1e-6, nowhereOutside).certified).toBe(true);
  });

  it('独立した二つの内部極大は両方の穴がある場合だけ除外する', () => {
    const knots = [-2, -1, 0, 1, 2], values = [0, 1, 0, 1, 0];
    const x = [-2, -5 / 3, -4 / 3, -2 / 3, -1 / 3, 1 / 3, 2 / 3, 4 / 3, 5 / 3, 2];
    const heights = [values[0], values[0], values[1], values[1], values[2], values[2], values[3], values[3], values[4], values[4]];
    const y = [-1, -1 / 3, 1 / 3, 1], quadratic = [0, 4 / 3, 4 / 3, 0];
    const surface: CubicSurfaceCoefficients = {
      u: direction(knots), v: direction([-1, 1]),
      poles: x.flatMap((coordinate, row) => y.map((value, column): Vec3Tuple => [coordinate, value, heights[row] * quadratic[column]])),
    };
    const left = (cell: SurfaceParameterCell) => cell.u0 > -1.75 && cell.u1 < -0.25 && cell.v0 > -0.9 && cell.v1 < 0.9;
    const right = (cell: SurfaceParameterCell) => cell.u0 > 0.25 && cell.u1 < 1.75 && cell.v0 > -0.9 && cell.v1 < 0.9;
    expect(certifyCubicSurfaceInterior(surface, limits(-1, 0.9), 1e-6, cell => left(cell) || right(cell)).certified).toBe(true);
    expect(certifyCubicSurfaceInterior(surface, limits(-1, 0.9), 1e-6, left).certified).toBe(false);
  });

  it('許容差の外側の定数面を丸め込みで受け入れず、明確に内側なら通す', () => {
    const constant = (height: number): CubicSurfaceCoefficients => ({
      ...bulge(), poles: bulge().poles.map(([x, y]): Vec3Tuple => [x, y, height]),
    });
    expect(certifyCubicSurfaceInterior(constant(1 + 2e-6), limits(-1, 1), 1e-6, nowhereOutside).certified).toBe(false);
    expect(certifyCubicSurfaceInterior(constant(1 + 0.5e-6), limits(-1, 1), 1e-6, nowhereOutside).certified).toBe(true);
    expect(certifyCubicSurfaceInterior(constant(1 + 1e-6 + 4 * Number.EPSILON), limits(-1, 1), 1e-6, nowhereOutside).certified).toBe(false);
  });

  it('単調でない候補を予算切れや深さ切れで合格にしない', () => {
    const budget = certifyCubicSurfaceInterior(bulge(), limits(-1, 0.5), 1e-6, nowhereOutside, { maxCells: 1, maxDepth: 48 });
    expect(budget).toMatchObject({ certified: false, reason: 'budget' });
    const depth = certifyCubicSurfaceInterior(bulge(), limits(-1, 0.5), 1e-6, nowhereOutside, { maxCells: 100, maxDepth: 0 });
    expect(depth).toMatchObject({ certified: false, reason: 'unresolved' });
  });

  it('無効な係数・ノット・C0境界・不足した制御点は計算を始めず断る', () => {
    const good = bulge();
    const bad: CubicSurfaceCoefficients[] = [
      { ...good, poles: good.poles.slice(1) },
      { ...good, poles: good.poles.map((pole, index): Vec3Tuple => index === 5 ? [pole[0], pole[1], Number.NaN] : pole) },
      { ...good, u: { knots: [0, 0], multiplicities: [4, 4] } },
      { ...good, u: { knots: [-1, 0, 1], multiplicities: [4, 3, 4] } },
      { ...good, v: { knots: [-1, 1], multiplicities: [3, 4] } },
    ];
    for (const surface of bad) {
      expect(certifyCubicSurfaceInterior(surface, limits(-1, 2), 1e-6, nowhereOutside))
        .toMatchObject({ certified: false, reason: 'invalid' });
    }
  });

  it('トリム判定の例外を成功に変えず、係数演算のoverflowも断る', () => {
    expect(certifyCubicSurfaceInterior(bulge(), limits(-1, 0.5), 1e-6,
      () => { throw new Error('native trim failed'); })).toMatchObject({ certified: false, reason: 'invalid' });
    const large: CubicSurfaceCoefficients = {
      ...bulge(), poles: bulge().poles.map(([x, y], index): Vec3Tuple => [x, y, index % 2 ? 1e308 : -1e308]),
    };
    expect(certifyCubicSurfaceInterior(large, limits(-1, 1), 1e-6, nowhereOutside))
      .toMatchObject({ certified: false, reason: 'invalid' });
  });

  it('丸めたUV中点でセルを縮めず、真の2進浮動小数点中点を包含する', () => {
    const cells: SurfaceParameterCell[] = [];
    const surface = { ...bulge(), u: direction([0.1, 0.3]), v: direction([0.1, 0.3]) };
    const proof = certifyCubicSurfaceInterior(surface, limits(-1, 0.5), 1e-6,
      cell => { cells.push(cell); return false; }, { maxCells: 100, maxDepth: 1 });
    expect(proof.certified).toBe(false);
    expect(cells).toHaveLength(2);
    // The exact average of the stored doubles0.1 and0.3 is below the stored
    // double0.2. A right cell starting at rounded0.2 would omit that boundary.
    expect(cells[1].u0).toBeLessThan(0.2);
    expect(cells[1].u1).toBe(0.3);
  });

  it('符号付きゼロとsubnormal値も有限区間として扱い、不正な許容差は断る', () => {
    const surface: CubicSurfaceCoefficients = {
      ...bulge(), poles: bulge().poles.map(([x, y], index): Vec3Tuple => [x, y, index % 2 ? Number.MIN_VALUE : -0]),
    };
    expect(certifyCubicSurfaceInterior(surface, limits(-1e-300, 1e-300), 0, nowhereOutside).certified).toBe(true);
    for (const tolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(certifyCubicSurfaceInterior(surface, limits(-1, 1), tolerance, nowhereOutside))
        .toMatchObject({ certified: false, reason: 'invalid' });
    }
  });
});
