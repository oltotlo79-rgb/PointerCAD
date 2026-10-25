import { describe, expect, it } from 'vitest';
import { unfoldCylindricalPoint, type CylindricalBendFrame } from './cylinderUnfold.js';
const frame: CylindricalBendFrame = { center: [0, 0, 0], axis: [1, 0, 0], startRadius: [0, 1, 0], innerRadius: 3, thickness: 2, kFactor: 0.4, angleRadians: Math.PI / 2 };
describe('円筒曲げの中立面への写像', () => {
  it('内外面の同じ角位置が同じBAと軸距離になる', () => {
    for (const radius of [3, 3.8, 5]) {
      const result = unfoldCylindricalPoint([12, 0, radius], frame);
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.point[0]).toBe(12); expect(result.point[1]).toBeCloseTo(5.969026041821, 10); }
    }
  });
  it('負曲げでも展開長は一致し、中間点はBAの半分に来る', () => {
    for (const sign of [-1, 1]) {
      const result = unfoldCylindricalPoint([-4, 3 / Math.SQRT2, sign * 3 / Math.SQRT2], { ...frame, angleRadians: sign * Math.PI / 2 });
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.point[0]).toBe(-4); expect(result.point[1]).toBeCloseTo(2.9845130209105, 10); }
    }
  });
  it('曲げの外側、厚みの外側、非直交フレームを理由付きで断る', () => {
    expect(unfoldCylindricalPoint([0, -3, 0], frame)).toEqual({ ok: false, error: 'outsideBend' });
    expect(unfoldCylindricalPoint([0, 2, 0], frame)).toEqual({ ok: false, error: 'outsideThickness' });
    expect(unfoldCylindricalPoint([0, 3, 0], { ...frame, axis: [2, 0, 0] })).toEqual({ ok: false, error: 'frame' });
  });
  it('平行移動・軸を変えても曲げ終端の展開距離を維持する', () => {
    const result = unfoldCylindricalPoint([13, -5, 22], { ...frame, center: [10, -5, 20], axis: [0, 0, 1], startRadius: [0, -1, 0] });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.point[0]).toBe(2); expect(result.point[1]).toBeCloseTo(5.969026041821, 10); }
  });
  it('有限な入力から展開座標があふれる場合も拒否する', () => {
    expect(unfoldCylindricalPoint([0, 1e308, 0], { ...frame, innerRadius: 1e308, thickness: 1e308 }))
      .toEqual({ ok: false, error: 'frame' });
  });

  it.each([Math.PI / 3, -2 * Math.PI / 3].flatMap((angleRadians) => [0, 0.4, 0.5]
    .map((kFactor) => ({ angleRadians, kFactor }))))(
    '角度$angleRadians・K=$kFactorで両接線と中間点を独立BAへ1e-9mmで写す', ({ angleRadians, kFactor }) => {
      const input = { ...frame, angleRadians, kFactor }, before = JSON.stringify(input);
      for (const fraction of [0, 0.5, 1]) for (const radius of [3, 4, 5]) {
        const theta = angleRadians * fraction;
        const result = unfoldCylindricalPoint([12, radius * Math.cos(theta), radius * Math.sin(theta)], input);
        if (!result.ok) throw new Error(result.error);
        expect(Math.abs(result.point[0] - 12)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(result.point[1] - Math.abs(theta) * (3 + kFactor * 2))).toBeLessThanOrEqual(1e-9);
      }
      expect(JSON.stringify(input)).toBe(before);
  });
});
