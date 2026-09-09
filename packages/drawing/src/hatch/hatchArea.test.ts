import { describe, expect, it } from 'vitest';
import type { Point2 } from '../types.js';
import { hatchArea } from './hatchArea.js';

const square: readonly Point2[] = [[0, 0], [30, 0], [30, 30], [0, 30]];
const totalLength = (segments: ReturnType<typeof hatchArea>): number => segments.reduce(
  (sum, segment) => sum + Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]), 0,
);

describe('ハッチング', () => {
  it('30角・45度・3mmは独立検算で15本になる', () => {
    expect(hatchArea({ loops: [square], angleRad: Math.PI / 4, pitchMm: 3 })).toHaveLength(15);
  });
  it('長さの合計は面積/間隔の5%以内', () => {
    expect(totalLength(hatchArea({ loops: [square], angleRad: Math.PI / 4, pitchMm: 3 }))).toBeCloseTo(300, -1);
  });
  it('穴は偶奇で抜く', () => {
    const hole: readonly Point2[] = [[10, 10], [20, 10], [20, 20], [10, 20]];
    const length = totalLength(hatchArea({ loops: [square, hole], angleRad: Math.PI / 4, pitchMm: 3 }));
    expect(length).toBeGreaterThan(250);
    expect(length).toBeLessThan(285);
  });
  it('頂点に当たる線でもNaNや長さ0を作らない', () => {
    const diamond: readonly Point2[] = [[0, 15], [15, 30], [30, 15], [15, 0]];
    const lines = hatchArea({ loops: [diamond], angleRad: Math.PI / 4, pitchMm: 3 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => Number.isFinite(line.from[0]) && totalLength([line]) > 0)).toBe(true);
  });
  it('135度は対称で同じ本数', () => {
    expect(hatchArea({ loops: [square], angleRad: 3 * Math.PI / 4, pitchMm: 3 })).toHaveLength(15);
  });
  it('同じ入力は完全に同じ結果', () => {
    const input = { loops: [square], angleRad: Math.PI / 4, pitchMm: 3 } as const;
    expect(hatchArea(input)).toEqual(hatchArea(input));
  });
  it('不正な間隔は空', () => expect(hatchArea({ loops: [square], angleRad: 0, pitchMm: 0 })).toEqual([]));
  it('直径10の丸穴を除いた線長が面積/3の5%以内になる', () => {
    const hole: Point2[] = Array.from({ length: 180 }, (_, index) => {
      const angle = index * 2 * Math.PI / 180;
      return [15 + 5 * Math.cos(angle), 15 + 5 * Math.sin(angle)];
    });
    const lines = hatchArea({ loops: [square, hole], angleRad: Math.PI / 4, pitchMm: 3 });
    const expected = (900 - 25 * Math.PI) / 3;
    expect(Math.abs(totalLength(lines) - expected) / expected).toBeLessThan(0.05);
    for (const line of lines) {
      const middle = [(line.from[0] + line.to[0]) / 2, (line.from[1] + line.to[1]) / 2];
      expect(Math.hypot(middle[0] - 15, middle[1] - 15)).toBeGreaterThanOrEqual(4.999);
    }
  });
  it('穴の輪郭を逆順にしても穴を埋めない', () => {
    const hole: Point2[] = [[10, 10], [20, 10], [20, 20], [10, 20]];
    const input = { angleRad: 0, pitchMm: 3 };
    expect(hatchArea({ ...input, loops: [square, hole] })).toEqual(hatchArea({ ...input, loops: [square, [...hole].reverse()] }));
  });
  it('離れた2部品の間にハッチ線を作らない', () => {
    const second: Point2[] = square.map(([x, y]) => [x + 40, y]);
    const lines = hatchArea({ loops: [square, second], angleRad: 0, pitchMm: 3 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.to[0] <= 30 || line.from[0] >= 40)).toBe(true);
  });
});
