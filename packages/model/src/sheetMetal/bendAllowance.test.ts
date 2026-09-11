import { describe, expect, it } from 'vitest';
import { sheetBendMetrics, sheetDevelopedLength, type SheetBendInput } from './bendAllowance.js';

const input: SheetBendInput = { thickness: 2, radius: 3, kFactor: 0.4, angle: 90 };

describe('板金の曲げ長と寸法の基準（P10-2）', () => {
  it.each([90, -90])('曲げ%d°の接線長と外寸を区別し、独立導出値に1e-9mm以内で一致する', (angle) => {
    const tangent = sheetDevelopedLength({ ...input, angle }, 50, 30, 'tangent');
    const outer = sheetDevelopedLength({ ...input, angle }, 50, 30, 'outer');
    if (!tangent.ok || !outer.ok) throw new Error('正常な板金寸法が拒否された');
    expect(Math.abs(tangent.length - 85.969026041821)).toBeLessThan(1e-9);
    expect(Math.abs(outer.length - 75.969026041821)).toBeLessThan(1e-9);
    expect(Math.abs(tangent.metrics.bendAllowance - 5.969026041821)).toBeLessThan(1e-9);
    expect(Math.abs(tangent.metrics.bendDeduction - 4.030973958179)).toBeLessThan(1e-9);
    expect(outer.straightLengths[0]).toBeCloseTo(45, 12);
    expect(outer.straightLengths[1]).toBeCloseTo(25, 12);
  });

  it('U板の両曲げは曲げ長を2回加え、固定パネルの長さを重複加算しない', () => {
    const result = sheetBendMetrics(input);
    if (!result.ok) throw new Error(result.error);
    const developed = 30 + 50 + 30 + 2 * result.metrics.bendAllowance;
    expect(Math.abs(developed - 121.938052083642)).toBeLessThan(1e-9);
  });

  it('内寸からは内半径の接線控えだけを引く', () => {
    const result = sheetDevelopedLength(input, 50, 30, 'inner');
    if (!result.ok) throw new Error(result.error);
    expect(result.straightLengths[0]).toBeCloseTo(47, 12);
    expect(result.straightLengths[1]).toBeCloseTo(27, 12);
    expect(Math.abs(result.length - 79.969026041821)).toBeLessThan(1e-9);
  });

  it('0°は未曲げとして扱い、Kの端点も有限な中立面を返す', () => {
    const flat = sheetDevelopedLength({ ...input, angle: 0 }, 50, 30, 'outer');
    expect(flat).toMatchObject({ ok: true, length: 80, straightLengths: [50, 30], metrics: { bendAllowance: 0, bendDeduction: 0 } });
    expect(sheetBendMetrics({ ...input, kFactor: 0 })).toMatchObject({ ok: true, metrics: { neutralRadius: 3 } });
    expect(sheetBendMetrics({ ...input, kFactor: 0.5 })).toMatchObject({ ok: true, metrics: { neutralRadius: 4 } });
  });

  it('成立しない半径・板厚・K・角度・短い脚と計算中のあふれを断る', () => {
    for (const change of [{ thickness: 0 }, { radius: -1 }, { kFactor: -0.01 }, { kFactor: 0.51 },
      { angle: 180 }, { angle: -180 }, { angle: NaN }, { radius: Infinity }, { radius: 1e308, thickness: 1e308 }]) {
      expect(sheetBendMetrics({ ...input, ...change }).ok).toBe(false);
    }
    expect(sheetDevelopedLength(input, 4, 30, 'outer')).toEqual({ ok: false, error: 'legTooShort' });
    expect(sheetDevelopedLength(input, Infinity, 30, 'tangent')).toEqual({ ok: false, error: 'legTooShort' });
  });
});
