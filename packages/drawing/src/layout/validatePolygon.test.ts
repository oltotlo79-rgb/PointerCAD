import { describe, expect, it } from 'vitest';
import type { Point2 } from '../types.js';
import { validateDrawingPolygon } from './validatePolygon.js';

describe('図の境界をカーネルへ渡す前の検査', () => {
  it('凹形、逆順、平行移動でも同じ有効な境界になる', () => {
    const points: readonly Point2[] = [[0, 0], [20, 0], [20, 10], [10, 5], [0, 10]];
    expect(validateDrawingPolygon(points)).toBeNull();
    expect(validateDrawingPolygon([...points].reverse())).toBeNull();
    expect(validateDrawingPolygon(points.map(([x, y]): Point2 => [x + 1e8, y - 1e8]))).toBeNull();
  });
  it('交差・接触・折り返し・退化・重複始点・非有限を断る', () => {
    const boundaries: readonly (readonly Point2[])[] = [
    [[0, 0], [20, 20], [0, 20], [20, 0]],
    [[0, 0], [20, 0], [20, 20], [10, 0], [0, 20]],
    [[0, 0], [20, 0], [10, 0], [10, 20], [0, 20]],
    [[0, 0], [20, 0], [40, 0]],
    [[0, 0], [20, 0], [0, 20], [0, 0]],
    [[0, 0], [Infinity, 0], [0, 20]],
    ];
    for (const points of boundaries) expect(validateDrawingPolygon(points)).not.toBeNull();
  });
  it('過大な境界は交差の全組検査に入る前に断る', () => {
    expect(validateDrawingPolygon(Array.from({ length: 257 }, (_, i): Point2 => [Math.cos(i), Math.sin(i)]))).not.toBeNull();
  });
});
