import { describe, expect, it } from 'vitest';
import type { ClipCurve } from '../layout/clipRegion.js';
import { sectionBoundaryLoops, sectionHatch } from './sectionHatch.js';

const square: readonly ClipCurve[] = [
  { kind: 'segment', from: [0, 0], to: [20, 0] }, { kind: 'segment', from: [20, 0], to: [20, 20] },
  { kind: 'segment', from: [20, 20], to: [0, 20] }, { kind: 'segment', from: [0, 20], to: [0, 0] },
];
describe('切り口の輪郭から紙面のハッチを作る', () => {
  it('巨大な円の分割数・多重周回・過大な入力点を配列確保前に断る', () => {
    const circle: ClipCurve = { kind: 'arc', center: [0, 0], radius: 1e20, startAngle: 0, endAngle: 2 * Math.PI };
    expect(sectionBoundaryLoops([circle])).toBeNull();
    expect(sectionBoundaryLoops([{ ...circle, radius: 20, endAngle: 1e30 }])).toBeNull();
    expect(sectionBoundaryLoops([{ kind: 'polyline', closed: true,
      points: Array.from({ length: 65_537 }, (): readonly [number, number] => [0, 0]) }])).toBeNull();
  });
  it('順不同で逆向きの辺もつなぎ、同じ面積の輪郭とハッチを返す', () => {
    const shuffled: readonly ClipCurve[] = [square[2], { kind: 'segment', from: [20, 0], to: [0, 0] }, square[3], square[1]];
    expect(sectionBoundaryLoops(shuffled)).toHaveLength(1);
    expect(sectionHatch(shuffled)).toEqual(sectionHatch(square));
  });
  it('閉じた円弧の穴の中にハッチを入れない', () => {
    const hole: ClipCurve = { kind: 'arc', center: [10, 10], radius: 5, startAngle: 0, endAngle: Math.PI * 2 };
    const hatch = sectionHatch([...square, hole]); expect(hatch?.length).toBeGreaterThan(0);
    for (const line of hatch ?? []) {
      const dx = line.to[0] - line.from[0], dy = line.to[1] - line.from[1];
      const t = Math.max(0, Math.min(1, ((10 - line.from[0]) * dx + (10 - line.from[1]) * dy) / (dx * dx + dy * dy)));
      expect(Math.hypot(line.from[0] + t * dx - 10, line.from[1] + t * dy - 10)).toBeGreaterThanOrEqual(5 - 0.011);
    }
  });
  it('開いた境界を勝手に閉じず失敗を返す', () => expect(sectionHatch(square.slice(0, 3))).toBeNull());
  it('離れた2つの閉輪郭を別々に扱い、間の空白を埋めない', () => {
    const second: ClipCurve = { kind: 'polyline', points: [[40, 0], [60, 0], [60, 20], [40, 20]], closed: true };
    const hatch = sectionHatch([...square, second]);
    expect(hatch).not.toBeNull();
    for (const line of hatch ?? []) expect(line.to[0] <= 20 + 1e-9 || line.from[0] >= 40 - 1e-9).toBe(true);
  });
  it('隣の配置は45度と135度で区別し、線間隔は紙面の3mm', () => {
    const first = sectionHatch(square, 0) ?? [], second = sectionHatch(square, 1) ?? [];
    expect(first.length).toBeGreaterThan(2); expect(second.length).toBe(first.length);
    expect((first[0].to[1] - first[0].from[1]) / (first[0].to[0] - first[0].from[0])).toBeCloseTo(1);
    expect((second[0].to[1] - second[0].from[1]) / (second[0].to[0] - second[0].from[0])).toBeCloseTo(-1);
    const offset = (index: number) => (first[index].from[1] - first[index].from[0]) / Math.SQRT2;
    expect(Math.abs(offset(1) - offset(0))).toBeCloseTo(3);
  });
});
