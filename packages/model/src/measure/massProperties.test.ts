/**
 * 質量特性の密度の掛け算と表示書式の検査(FR-1101、FR-1102、
 * 計画書 P5-高度なソリッド・外観と測定.md §2.10.3、タスク29)。
 *
 * 期待値は計画書 §2.10.3・タスク29 の検証表を担当が導出したもの。
 */

import { describe, expect, it } from 'vitest';

import { formatLength, formatMass, GRAM_PER_CM3_TO_GRAM_PER_MM3, inertiaWithDensity, massFromVolume } from './massProperties.js';

describe('massFromVolume', () => {
  it('100×100×10 の板(体積 100000mm³)を鋼(7.85 g/cm³)で量ると 785g', () => {
    // 100000 × 7.85e-3 = 785
    expect(massFromVolume(100000, 7.85)).toBeCloseTo(785, 9);
  });

  it('半径 10 の球(体積 4188.790204786391mm³)をアルミ(2.70 g/cm³)で量ると約 11.309733552923253g', () => {
    // 4188.790204786391 × 2.70e-3 = 11.309733552923253
    const mass = massFromVolume(4188.790204786391, 2.7);
    expect(mass).toBeCloseTo(11.309733552923253, 9);
  });

  it('10×20×30 の箱(体積 6000mm³)を鋼(7.85 g/cm³)で量ると 47.1g', () => {
    // 6000 × 7.85e-3 = 47.1
    expect(massFromVolume(6000, 7.85)).toBeCloseTo(47.1, 9);
  });

  it('体積 × 密度 × 1e-3 と一致する(換算係数を混ぜない)', () => {
    const volume = 12345.678;
    const density = 3.21;
    expect(massFromVolume(volume, density)).toBe(volume * density * GRAM_PER_CM3_TO_GRAM_PER_MM3);
  });

  it('体積 0 では質量も 0', () => {
    expect(massFromVolume(0, 7.85)).toBe(0);
  });
});

describe('inertiaWithDensity', () => {
  it('20³ の箱の主慣性モーメント(密度 1、mm⁵)を鋼(7.85)で量ると 20933.333333333332 g·mm²', () => {
    // 2666666.6666666665 × 7.85e-3 = 20933.333333333332
    const moment = inertiaWithDensity(2666666.6666666665, 7.85);
    expect(moment).toBeCloseTo(20933.333333333332, 6);
    expect(Math.abs(moment - 20933.333333333332) / 20933.333333333332).toBeLessThan(1e-9);
  });

  it('10×20×30 の箱の X 軸まわりの主慣性モーメント(密度 1)を鋼(7.85)で量ると 5102.5 g·mm²', () => {
    // V(b²+c²)/12 = 6000×(400+900)/12 = 650000 mm⁵(密度 1)
    // 650000 × 7.85e-3 = 5102.5
    const moment = inertiaWithDensity(650000, 7.85);
    expect(Math.abs(moment - 5102.5) / 5102.5).toBeLessThan(1e-6);
  });

  it('半径 10 の球の慣性モーメント(密度 1)をアルミ(2.70)で量ると約 452.38934211693 g·mm²', () => {
    // 2/5・V・r² = 0.4×4188.790204786391×100 = 167551.60819145563 mm⁵(密度 1、倍精度の丸め)
    // 167551.60819145563 × 2.70e-3 ≈ 452.389
    const moment = inertiaWithDensity(167551.60819145563, 2.7);
    expect(Math.abs(moment - 452.38934211693) / 452.38934211693).toBeLessThan(1e-6);
  });
});

describe('formatMass', () => {
  it('1000g 未満は g で表示する', () => {
    expect(formatMass(785)).toBe('785 g');
  });

  it('ちょうど 1000g は kg で表示する(1000g 以上、§0.a-0.32)', () => {
    expect(formatMass(1000)).toBe('1 kg');
  });

  it('1000g を超えると kg で表示する', () => {
    expect(formatMass(1500)).toBe('1.5 kg');
  });

  it('999g は g のまま', () => {
    expect(formatMass(999)).toBe('999 g');
  });

  it('小数を含む g も有効数字の書式のまま表示する', () => {
    expect(formatMass(11.309733552923253)).toBe('11.3097335529 g');
  });
});

describe('formatLength', () => {
  it('1000mm 未満は mm で表示する', () => {
    expect(formatLength(5)).toBe('5 mm');
  });

  it('ちょうど 1000mm は m で表示する', () => {
    expect(formatLength(1000)).toBe('1 m');
  });

  it('1000mm を超えると m で表示する', () => {
    expect(formatLength(1500)).toBe('1.5 m');
  });

  it('999mm は mm のまま', () => {
    expect(formatLength(999)).toBe('999 mm');
  });
});
