import { describe, expect, it } from 'vitest';
import { decodeMathBackendNode } from './mathBackendResult.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { rationalOfExpression } from './exactRational.js';

const decode = (numerator: unknown, denominator: unknown) => decodeMathBackendNode(
  ['Rational', numerator, denominator], CANDIDATE_MATH_OPERATIONS);

describe('計算部の指数表記も厳密な整数の分子・分母として確認する', () => {
  it.each([
    ['1', '1e+40', 1n, 10n ** 40n],
    ['-1', '1.0e40', -1n, 10n ** 40n],
    ['1e3', '2e0', 500n, 1n],
    ['9007199254740993e0', '1', 9007199254740993n, 1n],
    ['1', '-1e40', -1n, 10n ** 40n],
  ] as const)('%s / %sを整数の内容を変えず保持する', (a, b, numerator, denominator) => {
    const result = decode({ num: a }, { num: b });
    expect(rationalOfExpression(result)).toEqual({ numerator, denominator });
  });
  it.each([
    [{ num: '1.5' }, 2], [1, { num: '1e-40' }],
    [1, { num: '0e99' }], [{ num: '1.0000000000000000000000000000000000000001' }, 2],
  ])('整数へ丸めれば通ってしまう成分やゼロの分母を拒否する', (a, b) => {
    expect(() => decode(a, b)).toThrow('有理数の分子・分母を確認できません。');
  });
  it('指数の展開が予算を超える場合に巨大な整数を構築しない', () => {
    expect(() => decode(1, { num: '1e2401' })).toThrow('有理数の分子・分母が計算範囲を超えています。');
  });
});
