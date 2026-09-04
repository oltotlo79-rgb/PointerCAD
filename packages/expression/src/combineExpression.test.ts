import { describe, expect, it } from 'vitest';

import {
  addExpression,
  divideExpression,
  multiplyExpression,
  subtractExpression,
} from './combineExpression.js';
import { evaluateExpression, type ExpressionValue } from './evaluateExpression.js';

/** 式を評価して値の組にする。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`評価に失敗しました: ${source} / ${result.error.message}`);
  }
  return result.value;
}

/** 変数を含む式の欄(UI が変数表つきで評価したもの)を手で作る。 */
function withVariable(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

describe('式どうしの差(FR-331 原点の再設定、タスク35 ①)', () => {
  it('π を含む式は簡約せず、括弧で囲って連結する', () => {
    const shifted = subtractExpression(expr('3'), expr('10 + π/2'));
    expect(shifted.source).toBe('3 - (10 + π/2)');
    // 10 + π/2 = 11.5707963267948966…、3 との差は −8.5707963267948966…
    expect(shifted.value).toBeCloseTo(-8.5707963267949, 12);
  });

  it('同じ式どうしの差は厳密に 0 になる(原点にした点自身)', () => {
    const origin = expr('10 + π/2');
    const shifted = subtractExpression(origin, origin);
    expect(shifted.source).toBe('0');
    expect(shifted.value).toBe(0);
  });

  it('整数どうしは整数の差へ簡約する', () => {
    expect(subtractExpression(expr('3'), expr('10')).source).toBe('-7');
    expect(subtractExpression(expr('3'), expr('10')).value).toBe(-7);
    expect(subtractExpression(expr('10'), expr('4')).source).toBe('6');
  });

  it('小数どうしは 10 進の桁を保った厳密な差にする(倍精度の誤差を持ち込まない)', () => {
    const shifted = subtractExpression(expr('0.1'), expr('0.3'));
    expect(shifted.source).toBe('-0.2');
    // 倍精度の 0.1 − 0.3 は −0.19999999999999998 になるが、式は 10 進で厳密に扱う。
    expect(shifted.value).toBe(-0.2);
    expect(subtractExpression(expr('1.5'), expr('0.25')).source).toBe('1.25');
  });

  it('分数が混じるときは既約分数のまま返す', () => {
    expect(subtractExpression(expr('3/4'), expr('1/4')).source).toBe('1/2');
    expect(subtractExpression(expr('2/3'), expr('1/3')).source).toBe('1/3');
    // 割り切れるときは整数にする。
    expect(subtractExpression(expr('3/2'), expr('1/2')).source).toBe('1');
    // 10 進で書けない分母は分数のまま(小数へ丸めない)。
    const third = subtractExpression(expr('1/3'), expr('1/6'));
    expect(third.source).toBe('1/6');
  });

  it('0 を引くときは式を変えない', () => {
    const value = withVariable('a + 1', 5);
    expect(subtractExpression(value, expr('0'))).toBe(value);
    expect(subtractExpression(expr('7'), expr('0')).source).toBe('7');
  });

  it('0 から引くときは簡約しない(符号を落とさない)', () => {
    expect(subtractExpression(expr('0'), expr('10 + π/2')).source).toBe('0 - (10 + π/2)');
  });

  it('単項の式は括弧を省き、二項の式は必ず括弧で囲む', () => {
    // 数・π・関数呼び出しは括弧を省く。
    expect(subtractExpression(expr('sqrt(2)'), expr('1')).source).toBe('sqrt(2) - 1');
    expect(subtractExpression(expr('π'), expr('2')).source).toBe('π - 2');
    // 引く側が引き算を含むときに括弧を落とすと符号が変わる(タスク35 の落とし穴)。
    const nested = subtractExpression(expr('10'), expr('4 - 1'));
    expect(nested.source).toBe('10 - (4 - 1)');
    expect(nested.value).toBe(7);
    // 単項のマイナスも囲む。
    expect(subtractExpression(expr('π'), expr('-5')).source).toBe('π - (-5)');
  });

  it('安全な整数の範囲を超える桁は簡約せず式のまま残す', () => {
    const huge = expr('9007199254740993');
    const shifted = subtractExpression(huge, expr('1'));
    expect(shifted.source).toBe('9007199254740993 - 1');
  });

  it('変数を含む式でも式を組み立て、変数表を渡せば値も求まる', () => {
    const shifted = subtractExpression(withVariable('w', 5), expr('2'));
    expect(shifted.source).toBe('w - 2');
    // 変数表が無いと評価できないので、値は元の2つの値から作る(式は失わない)。
    expect(shifted.value).toBe(3);
    const evaluated = subtractExpression(withVariable('w', 5), expr('2'), {
      variables: new Map([['w', 5]]),
    });
    expect(evaluated.source).toBe('w - 2');
    expect(evaluated.value).toBe(3);
  });

  it('原点を戻すと元の値に戻る(往復)', () => {
    const shift = expr('10 + π/2');
    const movedThree = subtractExpression(expr('3'), shift);
    const movedZero = subtractExpression(expr('0'), shift);
    expect(movedThree.source).toBe('3 - (10 + π/2)');
    expect(movedZero.source).toBe('0 - (10 + π/2)');
    // 2 回目は「元の原点だった点」を選び直す。式は入れ子のまま残り、値は元へ戻る。
    const back = subtractExpression(movedThree, movedZero);
    expect(back.source).toBe('(3 - (10 + π/2)) - (0 - (10 + π/2))');
    expect(back.value).toBeCloseTo(3, 12);
    expect(subtractExpression(movedZero, movedZero).source).toBe('0');
  });
});

describe('式どうしの和(FR-331 の補助)', () => {
  it('有理数どうしは厳密に足す', () => {
    expect(addExpression(expr('0.1'), expr('0.2')).source).toBe('0.3');
    expect(addExpression(expr('0.1'), expr('0.2')).value).toBe(0.3);
    expect(addExpression(expr('1/2'), expr('1/4')).source).toBe('3/4');
    expect(addExpression(expr('3'), expr('-10')).source).toBe('-7');
  });

  it('0 を足すときは式を変えない', () => {
    const value = withVariable('a + 1', 5);
    expect(addExpression(value, expr('0'))).toBe(value);
    expect(addExpression(expr('0'), value)).toBe(value);
  });

  it('簡約できない式は括弧で囲って連結する', () => {
    const combined = addExpression(expr('10 + π/2'), expr('2'));
    expect(combined.source).toBe('(10 + π/2) + 2');
    expect(combined.value).toBeCloseTo(13.5707963267949, 12);
  });
});

describe('式どうしの積(FR-331 の補助、タスク35 ②矩形の中心・幅・高さの換算)', () => {
  it('有理数どうしは厳密に掛ける(整数どうしは整数)', () => {
    expect(multiplyExpression(expr('6'), expr('7')).source).toBe('42');
    expect(multiplyExpression(expr('-3'), expr('4')).source).toBe('-12');
  });

  it('割り切れないときは既約分数のまま返す(小数へ丸めない)', () => {
    const result = multiplyExpression(expr('2/3'), expr('3/5'));
    expect(result.source).toBe('2/5');
    expect(result.value).toBeCloseTo(0.4, 12);
  });

  it('小数どうしも 10 進で厳密に掛ける', () => {
    expect(multiplyExpression(expr('0.1'), expr('0.2')).source).toBe('0.02');
  });

  it('0 を掛けた結果は順序を問わず 0', () => {
    expect(multiplyExpression(expr('0'), expr('10 + π/2')).source).toBe('0');
    expect(multiplyExpression(expr('10 + π/2'), expr('0')).source).toBe('0');
  });

  it('1 を掛けても式は変わらない(順序を問わない)', () => {
    const value = withVariable('a + 1', 5);
    expect(multiplyExpression(value, expr('1'))).toBe(value);
    expect(multiplyExpression(expr('1'), value)).toBe(value);
  });

  it('簡約できない式は括弧で囲って連結し、単項だけ括弧を省く', () => {
    const combined = multiplyExpression(expr('10 + π/2'), expr('2'));
    expect(combined.source).toBe('(10 + π/2) * 2');
    const atomic = multiplyExpression(expr('π'), expr('2'));
    expect(atomic.source).toBe('π * 2');
  });
});

describe('式どうしの商(FR-331 の補助、タスク35 ②矩形の中心・幅・高さの換算)', () => {
  it('有理数どうしは厳密に割る(割り切れれば整数)', () => {
    expect(divideExpression(expr('40'), expr('2')).source).toBe('20');
    expect(divideExpression(expr('-12'), expr('4')).source).toBe('-3');
  });

  it('割り切れないときは既約分数のまま返す(小数へ丸めない)', () => {
    const result = divideExpression(expr('10'), expr('4'));
    expect(result.source).toBe('5/2');
    expect(result.value).toBeCloseTo(2.5, 12);
  });

  it('1 で割っても式は変わらない', () => {
    const value = withVariable('a + 1', 5);
    expect(divideExpression(value, expr('1'))).toBe(value);
    expect(divideExpression(expr('7'), expr('1')).source).toBe('7');
  });

  it('0 で割ることになる式は簡約せず括弧つきで連結する', () => {
    expect(divideExpression(expr('7'), expr('0')).source).toBe('7 / 0');
  });

  it('簡約できない式は括弧で囲って連結し、単項だけ括弧を省く', () => {
    const combined = divideExpression(expr('10 + π/2'), expr('2'));
    expect(combined.source).toBe('(10 + π/2) / 2');
    const atomic = divideExpression(expr('π'), expr('2'));
    expect(atomic.source).toBe('π / 2');
  });
});
