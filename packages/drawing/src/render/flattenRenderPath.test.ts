import { describe, expect, it } from 'vitest';
import { flattenRenderPath } from './flattenRenderPath.js';
import type { RenderSubpath } from './types.js';
import type { Point2 } from '../types.js';

const curve: RenderSubpath = { commands: [{ kind: 'M', to: [0, 0] },
  { kind: 'C', control1: [0, 10], control2: [10, 10], to: [10, 0] }] };
function distance(point: Point2, a: Point2, b: Point2): number {
  const x = b[0] - a[0], y = b[1] - a[1], square = x * x + y * y;
  const t = square === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * x + (point[1] - a[1]) * y) / square));
  return Math.hypot(point[0] - a[0] - t * x, point[1] - a[1] - t * y);
}
describe('共通パスを紙上誤差で適応分割する', () => {
  it('直線の始点と終点を維持する', () => {
    const result = flattenRenderPath({ commands: [{ kind: 'M', to: [1, 2] }, { kind: 'L', to: [3, 4] }] });
    expect(result).toEqual({ points: [[1, 2], [3, 4]], closed: false, curved: false });
  });
  it('Zで閉じた輪の頂点を重複させない', () => {
    const result = flattenRenderPath({ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [1, 0] },
      { kind: 'L', to: [1, 1] }, { kind: 'L', to: [0, 0] }, { kind: 'Z' }] });
    expect(result?.closed).toBe(true); expect(result?.points).toHaveLength(3);
  });
  it.each([0.1, 1, 20])('倍率%sでも紙面の誤差0.001mmを満たす', (scale) => {
    const result = flattenRenderPath(curve, 0.001, [scale, 0, 0, scale, 20, 30]);
    if (result === null) throw new Error('分割失敗');
    let maximum = 0;
    for (let index = 0; index <= 1000; index += 1) {
      const t = index / 1000;
      const p: Point2 = [20 + scale * (30 * (1 - t) * t * t + 10 * t ** 3), 30 + scale * 30 * t * (1 - t)];
      let minimum = Number.POSITIVE_INFINITY;
      for (let segment = 0; segment + 1 < result.points.length; segment += 1) minimum = Math.min(minimum, distance(p, result.points[segment], result.points[segment + 1]));
      maximum = Math.max(maximum, minimum);
    }
    expect(maximum).toBeLessThanOrEqual(0.001); expect(result.curved).toBe(true);
  });
  it('中点だけでは見落とすS字も直線へ潰さない', () => {
    const result = flattenRenderPath({ commands: [{ kind: 'M', to: [0, 0] },
      { kind: 'C', control1: [0, 10], control2: [10, -10], to: [10, 0] }] });
    expect(result?.points.some((point) => point[1] > 2)).toBe(true); expect(result?.points.some((point) => point[1] < -2)).toBe(true);
  });
  it('始点へ戻る閉じた3次曲線も細分する', () => {
    const result = flattenRenderPath({ commands: [{ kind: 'M', to: [0, 0] },
      { kind: 'C', control1: [10, 20], control2: [-10, 20], to: [0, 0] }, { kind: 'Z' }] });
    expect(result?.closed).toBe(true); expect(result?.points.length).toBeGreaterThan(10);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('不正な精度%sを拒否する', (tolerance) => { expect(flattenRenderPath(curve, tolerance)).toBeNull(); });
  it('Mから始まらないパスを拒否する', () => { expect(flattenRenderPath({ commands: [{ kind: 'L', to: [0, 0] }] })).toBeNull(); });
  it('非有限の制御点を拒否する', () => {
    expect(flattenRenderPath({ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'C', control1: [Number.NaN, 0], control2: [1, 2], to: [3, 4] }] })).toBeNull();
  });
  it('閉じた後の命令を黙って捨てない', () => {
    expect(flattenRenderPath({ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'Z' }, { kind: 'L', to: [1, 2] }] })).toBeNull();
  });
  it('決定的に同じ点列を作る', () => { expect(flattenRenderPath(curve)).toEqual(flattenRenderPath(curve)); });
});
