import { describe, expect, it } from 'vitest';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { compareMathGeometryCongruence, type MathGeometryComparisonShape } from './mathGeometryCongruence.js';
import type { MathGeometryTolerance } from './mathGeometryTypes.js';

const tolerance: MathGeometryTolerance = { linearMm: 1e-6, angularRadians: 1e-6 };
const segment = (length: number): MathGeometryComparisonShape => ({ kind: 'segment', length });
const circular = (radius: number, sweep: number): MathGeometryComparisonShape => ({ kind: 'circular', radius, sweep });
function polygon(points: readonly Vec3[]): Extract<MathGeometryComparisonShape, { readonly kind: 'polygon' }> {
  return { kind: 'polygon', curves: points.map((from, index) => ({ kind: 'segment', featureId: 'polygon',
    from, to: points[(index + 1) % points.length] })) };
}
const triangle: readonly Vec3[] = [[0, 0, 0], [4, 0, 0], [1, 2, 0]];
const rectangle: readonly Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 2, 0]];
const concave: readonly Vec3[] = [[0, 0, 0], [5, 0, 0], [5, 4, 0], [2, 1, 0], [0, 4, 0]];
function compare(kind: 'congruent' | 'similar', a: MathGeometryComparisonShape, b: MathGeometryComparisonShape,
  expected: boolean, width = tolerance): void {
  expect(compareMathGeometryCongruence(kind, a, b, width)).toEqual({ ok: true, value: expected });
  expect(compareMathGeometryCongruence(kind, b, a, width)).toEqual({ ok: true, value: expected });
}

describe('GR-11 限定の合同・相似の判定', () => {
  it('等しい長さの線分は合同である', () => compare('congruent', segment(5), segment(5), true));
  it('長さが違う線分は合同でなく相似である', () => {
    compare('congruent', segment(5), segment(10), false);
    compare('similar', segment(5), segment(10), true);
  });
  it.each([{ delta: 0.125, expected: true }, { delta: 0.125 - 1e-10, expected: true }, { delta: 0.125 + 1e-10, expected: false }])(
    '線分の長さの幅の内外と境界 $delta', ({ delta, expected }) => {
      compare('congruent', segment(4), segment(4 + delta), expected, { ...tolerance, linearMm: 0.125 });
    });
  it('半径が同じでも中心角が違う円弧は合同でも相似でもない', () => {
    compare('congruent', circular(10, Math.PI / 2), circular(10, Math.PI), false);
    compare('similar', circular(10, Math.PI / 2), circular(10, Math.PI), false);
  });
  it('円弧は中心角が同じなら半径が違っても相似である', () => {
    compare('congruent', circular(10, Math.PI / 2), circular(20, Math.PI / 2), false);
    compare('similar', circular(10, Math.PI / 2), circular(20, Math.PI / 2), true);
  });
  it('円どうしは等半径で合同、異半径で相似、半円と全円は相似でない', () => {
    compare('congruent', circular(10, 2 * Math.PI), circular(10, 2 * Math.PI), true);
    compare('similar', circular(10, 2 * Math.PI), circular(20, 2 * Math.PI), true);
    compare('similar', circular(10, Math.PI), circular(10, 2 * Math.PI), false);
  });
  it.each([{ delta: 0.125, expected: true }, { delta: 0.125 - 1e-10, expected: true }, { delta: 0.125 + 1e-10, expected: false }])(
    '円弧の半径と中心角の幅の内外と境界 $delta', ({ delta, expected }) => {
      const width = { linearMm: 0.125, angularRadians: 0.125 };
      compare('congruent', circular(4, 1), circular(4 + delta, 1), expected, width);
      compare('congruent', circular(4, 1), circular(4, 1 + delta), expected, width);
      compare('similar', circular(4, 1), circular(8, 1 + delta), expected, width);
    });
  it.each([0, 1, 2])('不等辺三角形の開始頂点を%i個ずらしても合同である', shift => {
    const rotated = [...triangle.slice(shift), ...triangle.slice(0, shift)];
    compare('congruent', polygon(triangle), polygon(rotated), true);
  });
  it.each([0, 1, 2])('不等辺三角形の頂点%iから逆順にたどっても合同である', shift => {
    const reversed = [...triangle.slice(shift), ...triangle.slice(0, shift)].reverse();
    compare('congruent', polygon(triangle), polygon(reversed), true);
  });
  it('平行移動・空間の回転・鏡映をした多角形も合同である', () => {
    const moved = triangle.map(([x, y, z]): Vec3 => [20 - y, 10 + z, 30 - x]);
    compare('congruent', polygon(triangle), polygon(moved), true);
  });
  it('比2倍の四角形は相似で合同ではない', () => {
    const doubled = rectangle.map(([x, y, z]): Vec3 => [2 * x + 10, 2 * y - 5, z]);
    compare('similar', polygon(rectangle), polygon(doubled), true);
    compare('congruent', polygon(rectangle), polygon(doubled), false);
  });
  it('辺長だけが同じ正方形と菱形を角度の差で拒否する', () => {
    const square = polygon([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
    const rhombus = polygon([[0, 0, 0], [2, 0, 0], [3, Math.sqrt(3), 0], [1, Math.sqrt(3), 0]]);
    compare('congruent', square, rhombus, false);
    compare('similar', square, rhombus, false);
  });
  it('角度だけが同じでも各辺の比が揃わない四角形は相似でない', () => {
    compare('similar', polygon(rectangle), polygon([[0, 0, 0], [8, 0, 0], [8, 3, 0], [0, 3, 0]]), false);
  });
  it('凹多角形の回転・反転・拡大の対応も角と辺を同じ頂点に結び付ける', () => {
    const reversed = [...concave.slice(2), ...concave.slice(0, 2)].reverse();
    compare('congruent', polygon(concave), polygon(reversed.map(([x, y, z]): Vec3 => [-x, y, z])), true);
    compare('similar', polygon(concave), polygon(reversed.map(([x, y, z]): Vec3 => [2 * x, 2 * y, z])), true);
  });
  it('同じ周長でも辺の並びが異なる多角形は合同でも相似でもない', () => {
    const a = polygon([[0, 0, 0], [4, 0, 0], [4, 3, 0], [3, 3, 0], [3, 1, 0], [0, 1, 0]]);
    const b = polygon([[0, 0, 0], [4, 0, 0], [4, 3, 0], [1, 3, 0], [1, 1, 0], [0, 1, 0]]);
    compare('congruent', a, b, false);
    compare('similar', a, b, false);
  });
  it.each([{ delta: 0.125, expected: true }, { delta: 0.125 - 1e-10, expected: true }, { delta: 0.125 + 1e-10, expected: false }])(
    '多角形の合同は辺長の幅の内外と境界を使う $delta', ({ delta, expected }) => {
      compare('congruent', polygon(rectangle), polygon([[0, 0, 0], [4 + delta, 0, 0], [4 + delta, 2, 0], [0, 2, 0]]),
        expected, { ...tolerance, linearMm: 0.125 });
    });
  it.each([{ delta: 1e-6 - 1e-10, expected: true }, { delta: 1e-6 + 1e-10, expected: false }])(
    '多角形の角度の幅ぎりぎりを調べる $delta', ({ delta, expected }) => {
      const tilted = polygon([[0, 0, 0], [4, 0, 0], [4 + 2 * Math.sin(delta), 2 * Math.cos(delta), 0],
        [2 * Math.sin(delta), 2 * Math.cos(delta), 0]]);
      compare('congruent', polygon(rectangle), tilted, expected);
      compare('similar', polygon(rectangle), tilted, expected);
    });
  it.each([{ delta: 0.003 - 1e-9, expected: true }, { delta: 0.003 + 1e-9, expected: false }])(
    '相似の辺長差は大きい多角形のmmで対称に判定する $delta', ({ delta, expected }) => {
      // Both large rectangles have perimeter 24: the scaled original is 8 by 4.
      const changed = polygon([[0, 0, 0], [8 + delta, 0, 0], [8 + delta, 4 - delta, 0], [0, 4 - delta, 0]]);
      compare('similar', polygon(rectangle), changed, expected, { ...tolerance, linearMm: 0.003 });
    });
  it('保存時の辺の順番や各辺の向きが違っても1つの閉じた輪郭なら比較する', () => {
    const source = polygon(concave);
    const curves = [source.curves[2], source.curves[0], source.curves[4], source.curves[1], source.curves[3]]
      .map(curve => curve.kind === 'segment' ? { ...curve, from: curve.to, to: curve.from } : curve);
    compare('congruent', source, { kind: 'polygon', curves }, true);
  });
  it.each(['congruent', 'similar'] as const)('辺数の違う多角形は%sの偽ではなく比較できない', kind => {
    expect(compareMathGeometryCongruence(kind, polygon(triangle), polygon(rectangle), tolerance))
      .toMatchObject({ ok: false, reason: 'unsupported', message: '辺の数が違う多角形どうしは比べられません。' });
  });
  it.each([circular(4, 1), polygon(triangle)])('種類の異なる組は比較できない #%#', other => {
    for (const kind of ['congruent', 'similar'] as const) {
      expect(compareMathGeometryCongruence(kind, segment(4), other, tolerance)).toMatchObject({ ok: false, reason: 'unsupported' });
    }
  });
  it.each(([
    [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    [[0, 0, 0], [4, 0, 0], [4, 2, 1], [0, 2, 0]],
    [[0, 0, 0], [4, 4, 0], [0, 4, 0], [4, 0, 0]],
    [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, -1, 0]],
    [[0, 0, 0], [4, 0, 0], [4, 0, 0], [0, 2, 0]],
  ] satisfies readonly (readonly Vec3[])[]).map(points => ({ points })))('退化・非平面・自己交差・重複頂点は比較できない #%#', ({ points }) => {
    const shape = polygon(points);
    expect(compareMathGeometryCongruence('congruent', shape, shape, tolerance)).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it('開いた輪郭、別の輪の混在、円弧を含む輪郭、同じ辺の重複を拒否する', () => {
    const closed = polygon(rectangle), first = closed.curves[0];
    const arc: ResolvedCurve = { kind: 'arc', featureId: 'arc', center: [0, 0, 0], normal: [0, 0, 1],
      xAxis: [1, 0, 0], radius: 2, startAngle: 0, endAngle: Math.PI };
    for (const curves of [closed.curves.slice(0, 3), [...closed.curves, ...polygon(triangle.map(([x, y, z]): Vec3 => [x + 20, y, z])).curves],
      [...closed.curves, arc], [...closed.curves, first]]) {
      expect(compareMathGeometryCongruence('similar', { kind: 'polygon', curves }, closed, tolerance))
        .toMatchObject({ ok: false, reason: 'unsupported' });
    }
  });
  it.each([segment(0), segment(1e-6), circular(1e-6, 1), circular(4, 0)])('幅以下の長さや退化した円弧を比較しない #%#', shape => {
    expect(compareMathGeometryCongruence('similar', shape, shape, tolerance)).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it.each([segment(Number.NaN), segment(-1), circular(4, Number.POSITIVE_INFINITY), circular(-1, 1),
    polygon([[0, 0, 0], [Number.NaN, 0, 0], [1, 1, 0]])])('不正な現在形状を真偽へ変えない #%#', shape => {
    expect(compareMathGeometryCongruence('congruent', shape, shape, tolerance)).toMatchObject({ ok: false, reason: 'failed-geometry' });
  });
  it('比の中間値が溢れるサイズ差でも有限な相似図形を比べる', () => {
    const square: readonly Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const small = polygon(square.map(([x, y, z]): Vec3 => [x * 2 ** -540, y * 2 ** -540, z]));
    const large = polygon(square.map(([x, y, z]): Vec3 => [x * 2 ** 540, y * 2 ** 540, z]));
    compare('similar', small, large, true, { ...tolerance, linearMm: 2 ** -550 });
  });
  it('不正な幅は定義の誤りであり偽ではない', () => {
    expect(compareMathGeometryCongruence('congruent', segment(4), segment(4), { ...tolerance, angularRadians: 0 }))
      .toMatchObject({ ok: false, reason: 'invalid-request' });
  });
});
