import { describe, expect, it } from 'vitest';

import { formatDimension } from './format.js';

describe('寸法値の書式', () => {
  it.each([
    [50, '50'],
    [50.5, '50.5'],
    [50.456, '50.46'],
    [0, '0'],
    [-0, '0'],
  ])('%sを小数2桁以内で%sにする', (value, expected) => {
    expect(formatDimension({ value, kind: 'length', decimals: 2 })).toBe(expected);
  });

  it('最小表示単位未満の0でない値を明示する', () => {
    expect(formatDimension({ value: 0.004, kind: 'length', decimals: 2 })).toBe('0.01 未満');
  });

  it.each([
    ['diameter', 16, 'φ16'],
    ['radius', 8, 'R8'],
    ['angle', 45, '45°'],
    ['sphereDiameter', 20, 'Sφ20'],
    ['sphereRadius', 20, 'SR20'],
    ['thickness', 3, 't3'],
    ['arcLength', 10, '⌒10'],
  ] as const)('%sの記号を付ける', (kind, value, expected) => {
    expect(formatDimension({ value, kind })).toBe(expected);
  });

  it('参考寸法を括弧で囲む', () => {
    expect(formatDimension({ value: 50, kind: 'length', reference: true })).toBe('(50)');
  });

  it('接頭文字を寸法記号より前に付ける', () => {
    expect(formatDimension({ value: 8, kind: 'diameter', prefix: '4×' })).toBe('4×φ8');
  });
  it('補足文字は公差の後ろ、はめあいは寸法値の直後に置く', () => {
    expect(formatDimension({ value: 20, kind: 'length', prefix: '4×', suffix: ' 通し', reference: true,
      tolerance: { kind: 'symmetric', value: 0.2 } })).toBe('(4×20±0.2 通し)');
    expect(formatDimension({ value: 20, kind: 'length', fitSymbol: 'H7', suffix: ' 通し',
      tolerance: { kind: 'deviation', upper: 0.021, lower: 0 }, decimals: 4 })).toBe('20H7 +0.021 / 0 通し');
  });

  it('対称公差を付ける', () => {
    expect(formatDimension({
      value: 50, kind: 'length', tolerance: { kind: 'symmetric', value: 0.1 },
    })).toBe('50±0.1');
  });

  it('上下の偏差へ符号を付ける', () => {
    expect(formatDimension({
      value: 50, kind: 'length',
      tolerance: { kind: 'deviation', upper: 0.1, lower: -0.05 },
    })).toBe('50 +0.1 / −0.05');
  });

  it('公差の式は評価値で表示し、逆転した上下限は数値に見せない', () => {
    expect(formatDimension({ value: 50, kind: 'length', tolerance: {
      kind: 'symmetric', value: { source: '板厚/20', value: 0.15, display: '0.15' },
    } })).toBe('50±0.15');
    expect(formatDimension({ value: 50, kind: 'length', tolerance: {
      kind: 'deviation', upper: -0.1, lower: 0.1,
    } })).toBe('？');
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('未解決の%sは疑問符にする', (value) => {
    expect(formatDimension({ value, kind: 'length' })).toBe('？');
  });
});
