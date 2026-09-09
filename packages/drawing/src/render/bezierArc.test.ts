import { describe, expect, it } from 'vitest';
import { bezierArc, cubicBezierPoint, measureBezierRadialError } from './bezierArc.js';

const quarter = { center: [0, 0] as const, radius: 10, startAngle: 0, endAngle: Math.PI / 2, toleranceMm: 0.003 };

describe('紙上の誤差から円弧を3次ベジェへ変換する(P8-42)', () => {
  it('90°の制御点は10×(4/3)tan(π/8)、両端は接線方向になる', () => {
    const result = bezierArc(quarter);
    expect(result?.segments).toHaveLength(1);
    const curve = result?.segments[0];
    expect(curve?.control1[0]).toBe(10);
    expect(curve?.control1[1]).toBeCloseTo(5.522847498307934, 13);
    expect(curve?.control2[0]).toBeCloseTo(5.522847498307934, 13);
    expect(curve?.control2[1]).toBe(10);
  });
  it('45°の伸びは(4/3)tan(π/16)', () => {
    const curve = bezierArc({ ...quarter, radius: 1, endAngle: Math.PI / 4 })?.segments[0];
    // tan(π/16)=√(2−√2)/(2+√(2+√2))。計画の旧値は掛け算の転記誤り。
    expect(curve?.control1[1]).toBeCloseTo(0.2652164898395440, 14);
  });
  it('半径1の円は4片で厳密に閉じる', () => {
    const result = bezierArc({ ...quarter, radius: 1, endAngle: Math.PI * 2 });
    expect(result?.segments).toHaveLength(4);
    expect(result?.segments.at(-1)?.to).toBe(result?.start);
  });
  it('100°は50°ずつに等分してつなぐ', () => {
    const result = bezierArc({ ...quarter, radius: 1, endAngle: 100 * Math.PI / 180 });
    expect(result?.segments).toHaveLength(2);
    expect(result?.segments[0].to[0]).toBeCloseTo(Math.cos(50 * Math.PI / 180), 14);
    expect(result?.segments[1].from).toBe(result?.segments[0].to);
  });
  it('中点の誤差は零、最大半径誤差は約0.0027253mmと区別する', () => {
    const curve = bezierArc(quarter)?.segments[0];
    if (curve === undefined) throw new Error('円弧がない');
    const middle = cubicBezierPoint(curve, 0.5);
    expect(Math.abs(Math.hypot(...middle) - 10)).toBeLessThan(1e-12);
    const error = measureBezierRadialError(curve, quarter.center, 10, 4096);
    expect(error).toBeGreaterThan(0.0027252);
    expect(error).toBeLessThan(0.0027254);
  });
  it.each([1, 10, 1_000, 1_000_000])('紙上半径%smmでも0.001mmの誤差以内へ細分する', (radius) => {
    const result = bezierArc({ ...quarter, radius, toleranceMm: 0.001 });
    expect(result).not.toBeNull();
    for (const curve of result?.segments ?? []) {
      expect(measureBezierRadialError(curve, quarter.center, radius)).toBeLessThan(0.001);
    }
  });
  it('逆回りでも同じ誤差、制御点の方向は反転する', () => {
    const forward = bezierArc(quarter)?.segments[0];
    const reverse = bezierArc({ ...quarter, endAngle: -Math.PI / 2 })?.segments[0];
    expect(reverse?.control1[1]).toBe(-(forward?.control1[1] ?? 0));
    expect(reverse?.to[1]).toBe(-10);
  });
  it('平行移動しても同じ曲線になる', () => {
    const first = bezierArc(quarter)?.segments[0];
    const moved = bezierArc({ ...quarter, center: [25, -50] })?.segments[0];
    expect(moved?.control1).toEqual([25 + (first?.control1[0] ?? 0), -50 + (first?.control1[1] ?? 0)]);
  });
  it('半径零と角度零は点だけを返す', () => {
    expect(bezierArc({ ...quarter, radius: 0 })).toEqual({ start: [0, 0], segments: [] });
    expect(bezierArc({ ...quarter, endAngle: 0 })).toEqual({ start: [10, 0], segments: [] });
  });
  it('不正な入力や現実的に分割できない精度を断る', () => {
    for (const patch of [{ radius: -1 }, { radius: Infinity }, { startAngle: NaN }, { toleranceMm: 0 },
      { toleranceMm: Number.MIN_VALUE }, { endAngle: 1e300 }, { center: [NaN, 0] as const }]) {
      expect(bezierArc({ ...quarter, ...patch })).toBeNull();
    }
  });
  it('同じ入力から同じ制御点を返し、入力を変更しない', () => {
    const input = Object.freeze({ ...quarter, center: Object.freeze([15, 20] as const) });
    expect(bezierArc(input)).toEqual(bezierArc(input));
    expect(input.center).toEqual([15, 20]);
  });
  it('誤差計測の不正な分割数を合格値にしない', () => {
    const curve = bezierArc(quarter)?.segments[0];
    if (curve === undefined) throw new Error('円弧がない');
    expect(measureBezierRadialError(curve, [0, 0], 10, 0)).toBe(Infinity);
  });
});
