import { describe, expect, it } from 'vitest';

import {
  describePosition,
  EXPRESSION_MAX_EXPONENT,
  EXPRESSION_MAX_LENGTH,
  expressionError,
  ExpressionFailure,
  wrongArgumentCountError,
} from './errors.js';

describe('式のエラー(FR-204)', () => {
  it('位置は 1 始まりで示す', () => {
    expect(describePosition(0)).toBe('(1 文字目)');
    expect(describePosition(-1)).toBe('');
  });

  it('使えない文字の文言に文字と位置が入る', () => {
    expect(expressionError('unexpectedCharacter', '@', 1).message).toBe(
      '使えない文字があります: 「@」(2 文字目)',
    );
  });

  it('引数の数違いの文言に関数名と個数が入る', () => {
    expect(wrongArgumentCountError('root', 2, 1, 0).message).toBe(
      '関数 root には引数が 2 個必要です(1 個でした)。',
    );
  });

  it('上限値が文言に反映される', () => {
    expect(expressionError('tooLong', '').message).toBe(
      `式が長すぎます(${String(EXPRESSION_MAX_LENGTH)} 文字まで)。`,
    );
    expect(expressionError('exponentTooLarge', '').message).toBe(
      `累乗の指数が大きすぎます(±${String(EXPRESSION_MAX_EXPONENT)} まで)。`,
    );
  });

  it('ExpressionFailure は理由を持ち回る', () => {
    const failure = new ExpressionFailure(expressionError('divisionByZero', '', 3));
    expect(failure.detail.code).toBe('divisionByZero');
    expect(failure.message).toBe('0 で割ることはできません。');
    expect(failure.detail.position).toBe(3);
  });

  it('outOfRange は呼び出し側が組み立てた文言をそのまま持つ(P3 §0.a-0.23 ①)', () => {
    const error = expressionError('outOfRange', '距離は 0 より大きい値を入れてください。');
    expect(error.code).toBe('outOfRange');
    expect(error.message).toBe('距離は 0 より大きい値を入れてください。');
    expect(error.position).toBe(-1);
  });
});
