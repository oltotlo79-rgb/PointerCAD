import { describe, expect, it } from 'vitest';
import { applyBreak } from './breakOut.js';

const line = { kind: 'segment' as const, from: [0, 0] as const, to: [300, 0] as const };
describe('破断図', () => {
  it('300を150詰めて10残すと全長160', () => {
    const result = applyBreak([line], { axis: 'u', from: 100, to: 250, keepGap: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Math.max(...result.curves.flatMap((curve) => curve.kind === 'segment' ? [curve.from[0], curve.to[0]] : []))).toBe(160);
  });
  it('手前は動かず奥は140ずれる', () => {
    const result = applyBreak([line], { axis: 'u', from: 100, to: 250, keepGap: 10 });
    if (result.ok) expect(result.curves).toEqual([
      { kind: 'segment', from: [0, 0], to: [100, 0] }, { kind: 'segment', from: [110, 0], to: [160, 0] },
    ]);
  });
  it('破断線は2本', () => { const result = applyBreak([line], { axis: 'u', from: 100, to: 250, keepGap: 10 }); if (result.ok) expect(result.breakLines).toHaveLength(2); });
  it('山は2mm・間隔4mm', () => { const result = applyBreak([line], { axis: 'u', from: 100, to: 250, keepGap: 10 }); if (result.ok) expect(result.breakLines[0]).toMatchObject({ amplitudeMm: 2, spacingMm: 4 }); });
  it('図の外なら曲線を変えない', () => {
    const curves = [line]; const result = applyBreak(curves, { axis: 'u', from: 400, to: 500, keepGap: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.curves).toBe(curves);
  });
  it('区間2つは断る', () => expect(applyBreak([line], [
    { axis: 'u', from: 10, to: 20, keepGap: 2 }, { axis: 'u', from: 30, to: 40, keepGap: 2 },
  ])).toEqual({ ok: false, message: '破断区間は1つだけ指定してください。' }));
  it('縦方向も全長300から160へ詰める', () => {
    const result = applyBreak([{ kind: 'segment', from: [0, 0], to: [0, 300] }], { axis: 'v', from: 100, to: 250, keepGap: 10 });
    expect(result.ok && result.curves).toEqual([
      { kind: 'segment', from: [0, 0], to: [0, 100] }, { kind: 'segment', from: [0, 110], to: [0, 160] },
    ]);
  });
  it('円を横切る破断では円弧の両側を残す', () => {
    const arc = { kind: 'arc' as const, center: [0, 0] as const, radius: 10, startAngle: 0, endAngle: 2 * Math.PI };
    const result = applyBreak([arc], { axis: 'u', from: -2, to: 2, keepGap: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.curves.length).toBeGreaterThanOrEqual(2);
      expect(result.curves.every((curve) => curve.kind === 'arc' && curve.radius === 10)).toBe(true);
      expect(result.curves.some((curve) => curve.kind === 'arc' && curve.center[0] === -3)).toBe(true);
    }
    expect(arc.center).toEqual([0, 0]);
  });
  it('描画だけを詰め、寸法の元の端点300を変えない', () => {
    const before = structuredClone(line);
    expect(applyBreak([line], { axis: 'u', from: 100, to: 250, keepGap: 10 }).ok).toBe(true);
    expect(line).toEqual(before);
  });
  it('非数の区間は処理を始めずに断る', () => {
    expect(applyBreak([line], { axis: 'u', from: 0, to: Infinity, keepGap: 10 }).ok).toBe(false);
  });
});
