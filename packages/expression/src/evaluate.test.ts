import { expectWithinBudget } from '@pointercad/test-utils';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { ExpressionFailure, type ExpressionError } from './errors.js';
import { E, evaluateNode, EXPRESSION_PRECISION, ExpressionDecimal, PI } from './evaluate.js';
import { evaluateExpression } from './evaluateExpression.js';
import { MM_PER_INCH_TEXT } from './lengthUnits.js';
import { parse } from './parse.js';

/**
 * 期待値の出どころ:
 * 数値の期待値は decimal.js の出力を写さず、既知の定数(√2・π・e の桁)か、
 * double 側で独立に組み立てた式から導く。導出はそれぞれの行にコメントで書く。
 * 計画書の参照値をそのまま信じないのは、docs/報告記録.md 2026-09-02 15:28
 * 「計画書の参照値2件が式と一致しなかった」の再発防止のため。
 */

const NO_VARIABLES: ReadonlyMap<string, number> = new Map();

function evaluate(source: string, variables: ReadonlyMap<string, number> = NO_VARIABLES): Decimal {
  return evaluateNode(parse(source), variables);
}

/** 失敗したときのエラー内容を取り出す。エラーにならなければテストを落とす。 */
function failureOf(source: string): ExpressionError {
  try {
    evaluate(source);
  } catch (error) {
    if (error instanceof ExpressionFailure) {
      return error.detail;
    }
    throw error;
  }
  throw new Error(`エラーになりませんでした: ${source}`);
}

/** エラーの種類と位置を1つの期待値で確かめる(parse.test.ts と同じ書き方)。 */
function codeAt(source: string): string {
  const detail = failureOf(source);
  return `${detail.code}@${String(detail.position)}`;
}

describe('任意精度の評価(FR-203、NFR-RE-4)', () => {
  it('内部は40桁・偶数丸めで、途中で double へ落とさない(§0.a-0.7)', () => {
    expect(EXPRESSION_PRECISION).toBe(40);
    expect(ExpressionDecimal.precision).toBe(40);
    // decimal.js の ROUND_HALF_EVEN は 6(decimal.d.ts の static readonly ROUND_HALF_EVEN: 6)。
    expect(ExpressionDecimal.rounding).toBe(6);
    // 1/3 = 0.333… なので、有効数字40桁は「0.」のうしろに 3 が40個。
    expect(evaluate('1/3').toString()).toBe(`0.${'3'.repeat(EXPRESSION_PRECISION)}`);
  });

  it('評価しても decimal.js の全体設定を汚さない(clone を使う理由)', () => {
    evaluate('1/3');
    evaluate('sqrt(2)');
    // decimal.js の既定は20桁。clone した専用インスタンスだけが40桁になる。
    expect(Decimal.precision).toBe(20);
    expect(ExpressionDecimal.precision).toBe(40);
  });

  it('π と e は計算で求める(リテラルで書かない)', () => {
    // π = 3.14159265358979323846264338327950288419716939937510…(既知の値)
    // 有効数字40桁 = 「3.」+ 小数39桁。小数40桁目が 1 なので切り捨てのまま。
    expect(PI.toString()).toBe('3.141592653589793238462643383279502884197');
    // e = 2.71828182845904523536028747135266249775724709369995…(既知の値)
    // 小数40桁目が 2 なので切り捨てのまま。
    expect(E.toString()).toBe('2.718281828459045235360287471352662497757');
    // 表示用は有効数字12桁(§0.a-0.7)。3.14159265358|979… の13桁目が 9 なので繰り上がる。
    expect(PI.toSignificantDigits(12).toString()).toBe('3.14159265359');
    // 2.71828182845|904… の13桁目が 9 なので繰り上がる。
    expect(E.toSignificantDigits(12).toString()).toBe('2.71828182846');
    // π は全角でも同じ定数を指す(§2.3)。
    expect(evaluate('pi').toString()).toBe(PI.toString());
    expect(evaluate('π').toString()).toBe(PI.toString());
    expect(evaluate('e').toString()).toBe(E.toString());
  });

  it('四則と括弧', () => {
    expect(evaluate('1+2*3').toNumber()).toBe(7); // 2×3=6、6+1=7
    expect(evaluate('(1+2)*3').toNumber()).toBe(9); // 3×3=9
    expect(evaluate('3/4').toNumber()).toBe(0.75); // 3÷4=0.75(2進でも厳密)
    expect(evaluate('1-2-3').toNumber()).toBe(-4); // 左結合なので (1-2)-3
    expect(evaluate('7/2').toNumber()).toBe(3.5);
    expect(evaluate('-(2+3)').toNumber()).toBe(-5);
  });

  it('単項の + と - (§2.2)', () => {
    expect(evaluate('+3').toNumber()).toBe(3);
    expect(evaluate('--3').toNumber()).toBe(3); // 負の負は正
    expect(evaluate('-3+5').toNumber()).toBe(2);
  });

  it('累乗は単項マイナスより強く、右結合(§2.1 の表)', () => {
    expect(evaluate('2^10').toNumber()).toBe(1024); // 2 を10回かける
    expect(evaluate('-2^2').toNumber()).toBe(-4); // -(2^2) であって (-2)^2 ではない
    expect(evaluate('(-2)^2').toNumber()).toBe(4); // 括弧をつければ 4
    expect(evaluate('2^-3').toNumber()).toBe(0.125); // 1÷8=0.125
    expect(evaluate('2^3^2').toNumber()).toBe(512); // 右結合なので 2^(3^2)=2^9
  });

  it('平方根・立方根・n乗根・絶対値(§2.3)', () => {
    expect(evaluate('√9').toNumber()).toBe(3); // 3×3=9
    expect(evaluate('sqrt(9)').toNumber()).toBe(3);
    expect(evaluate('cbrt(27)').toNumber()).toBe(3); // 3×3×3=27
    expect(evaluate('cbrt(-8)').toNumber()).toBe(-2); // (-2)^3=-8
    expect(evaluate('root(16,4)').toNumber()).toBe(2); // 2^4=16
    expect(evaluate('root(27,3)').toNumber()).toBe(3); // 3^3=27
    expect(evaluate('root(-32,5)').toNumber()).toBe(-2); // (-2)^5=-32
    expect(evaluate('abs(-3)').toNumber()).toBe(3);
    expect(evaluate('abs(3)').toNumber()).toBe(3);
  });

  it('負の数の n 乗根は n が奇数の整数のときだけ求まる', () => {
    expect(evaluate('root(-8,3)').toNumber()).toBe(-2); // (-2)^3=-8
    // 偶数乗根と非整数乗根には実数解が無い。
    expect(codeAt('root(-8,2)')).toBe('negativeRoot@0');
    expect(codeAt('root(-8,4)')).toBe('negativeRoot@0');
    expect(codeAt('root(-8,2.5)')).toBe('negativeRoot@0');
    expect(failureOf('root(-8,2)').message).toBe('負の数の平方根は求められません: -8');
  });

  it('√2 の2乗は double では 2 に戻らないが、40桁で計算すれば戻る', () => {
    // √2 = 1.41421356237309504880168872420969807856967187537694…(既知の値)
    // 有効数字40桁は小数40桁目の 6 で繰り上がり、末尾は …69807857(0)。末尾 0 は表示で落ちる。
    expect(evaluate('sqrt(2)').toString()).toBe('1.41421356237309504880168872420969807857');
    // 繰り上げの分だけ真の値より δ=3.3e-40 大きいので、2乗すると 2+2√2δ ≒ 2+9.3e-40。
    // 2 の近くでの40桁の刻みは 1e-39 なので、繰り上がって末尾に 1 が立つ。
    expect(evaluate('sqrt(2)^2').toString()).toBe('2.000000000000000000000000000000000000001');
    // double へ落とすのは最後の1回だけ。1e-39 の差は double の刻み(2 では 4.4e-16)より
    // はるかに小さいので、最も近い double は厳密に 2。
    expect(evaluate('sqrt(2)^2').toNumber()).toBe(2);
    // double だけで計算すると 2.0000000000000004 になり 2 に戻らない。
    expect(Math.sqrt(2) ** 2).not.toBe(2);
  });

  it('十進の足し算に誤差が出ない', () => {
    // 0.1 も 0.2 も2進では割り切れないが、十進のまま足すので厳密に 0.3。
    expect(evaluate('0.1+0.2').toString()).toBe('0.3');
    expect(evaluate('0.1+0.2').toNumber()).toBe(0.3);
    // double だけで計算すると 0.30000000000000004 になる。
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('分数の桁落ちが double の精度を侵さない', () => {
    // 1÷3×3 の内部値は 0.999…9(9 が40個)。40桁でちょうど表せるので丸めは起きない。
    expect(evaluate('1/3*3').toString()).toBe(`0.${'9'.repeat(EXPRESSION_PRECISION)}`);
    // それでも最も近い double は 1(差 1e-40 は 1 での double の刻み 2.2e-16 よりはるかに小さい)。
    expect(evaluate('1/3*3').toNumber()).toBe(1);
    // 1÷49 は40桁目までで打ち切ると真の値より 5/49×1e-41 小さく、×49 で 1−5e-41。
    // 41桁目がちょうど 5 なので偶数丸めで繰り上がり、内部値も double も 1 になる。
    expect(evaluate('1/49*49').toString()).toBe('1');
    expect((1 / 49) * 49).not.toBe(1); // double では 0.9999999999999999
    // 4.35×100 は十進では 435。double では 434.99999999999994。
    expect(evaluate('4.35*100').toNumber()).toBe(435);
    expect(4.35 * 100).not.toBe(435);
    // 0.3−0.1 は十進では 0.2。double では 0.19999999999999998。
    expect(evaluate('0.3-0.1').toNumber()).toBe(0.2);
    expect(0.3 - 0.1).not.toBe(0.2);
  });

  it('角度は度が既定で、rad() でラジアンを度へ直す(FR-205)', () => {
    // rad(x) = x×180÷π。rad(π) は π×180÷π = 180。
    expect(evaluate('rad(pi)').toNumber()).toBe(180);
    expect(evaluate('rad(pi/2)').toNumber()).toBe(90);
    // rad(180) = 180×180÷π = 32400÷π。double 側で独立に組み立てた式と合う。
    expect(evaluate('rad(180)').toNumber()).toBeCloseTo(32400 / Math.PI, 9);
    // rad(1) = 180÷π = 57.29577951308232…
    expect(evaluate('rad(1)').toNumber()).toBeCloseTo(180 / Math.PI, 9);
    // 度が既定なので、包まなければ数はそのまま度として通る。
    expect(evaluate('90').toNumber()).toBe(90);
  });

  it('式を通しで評価する', () => {
    expect(evaluate('sqrt(3^2+4^2)').toNumber()).toBe(5); // 3-4-5 の直角三角形
    expect(evaluate('(1+2)*(3+4)/2').toNumber()).toBe(10.5); // 3×7÷2
    expect(evaluate('2*pi*10').toNumber()).toBeCloseTo(2 * Math.PI * 10, 10); // 半径10の円周
    expect(evaluate('abs(0-3)+√16').toNumber()).toBe(7); // 3+4
    expect(evaluate('.5+1').toNumber()).toBe(1.5); // 先頭の 0 を省いた書き方
  });

  it('変数表から値を引ける(FR-206 の土台、§0.a-0.6)', () => {
    const variables: ReadonlyMap<string, number> = new Map([
      ['a', 2],
      ['b', 0.1],
    ]);
    expect(evaluate('a+1', variables).toNumber()).toBe(3);
    expect(evaluate('a*10', variables).toNumber()).toBe(20);
    // double で受け取った 0.1 は十進の 0.1 として扱うので、0.2 を足すと厳密に 0.3。
    expect(evaluate('b+0.2', variables).toString()).toBe('0.3');
  });

  it('変数表に無い名前は理由つきで断る(§2.5 #10)', () => {
    expect(codeAt('a+1')).toBe('unknownVariable@0');
    expect(failureOf('a+1').message).toBe('決まっていない名前です: 「a」(1 文字目)');
    expect(codeAt('1+width')).toBe('unknownVariable@2');
  });

  it('計算できない式は種類・位置・文言つきで断る(FR-204、§2.5)', () => {
    expect(codeAt('1/0')).toBe('divisionByZero@1');
    expect(failureOf('1/0').message).toBe('0 で割ることはできません。');

    expect(codeAt('sqrt(-4)')).toBe('negativeRoot@0');
    expect(failureOf('sqrt(-4)').message).toBe('負の数の平方根は求められません: -4');
    expect(codeAt('√-4')).toBe('negativeRoot@0');

    expect(codeAt('root(8,0)')).toBe('rootDegreeZero@0');
    expect(failureOf('root(8,0)').message).toBe('乗根の n に 0 は指定できません。');

    expect(codeAt('foo(1)')).toBe('unknownFunction@0');
    expect(failureOf('foo(1)').message).toBe('知らない関数です: 「foo」(1 文字目)');

    expect(codeAt('root(8)')).toBe('wrongArgumentCount@0');
    expect(failureOf('root(8)').message).toBe('関数 root には引数が 2 個必要です(1 個でした)。');
    expect(failureOf('sqrt(1,2)').message).toBe('関数 sqrt には引数が 1 個必要です(2 個でした)。');

    // 0^-1 は 1÷0 と同じで数として表せない。
    expect(codeAt('0^-1')).toBe('notFinite@1');
    expect(failureOf('0^-1').message).toBe('計算結果が数として表せません。');
    // 負の数の非整数乗も実数にならない(§2.5 #15)。
    expect(codeAt('(-4)^0.5')).toBe('notFinite@4');
  });

  it('累乗の指数には上限があり、大きすぎる式は素早く断る(§2.4)', () => {
    const startedAt = performance.now();
    expect(codeAt('2^100000')).toBe('exponentTooLarge@1');
    // 判定は比較1回なので、遅い計算機でも 50ms を超えない。
    const elapsedMs = performance.now() - startedAt;
    expectWithinBudget(elapsedMs, 50, '累乗の指数が大きすぎる式の判定');
    expect(failureOf('2^100000').message).toBe('累乗の指数が大きすぎます(±1000 まで)。');
    expect(codeAt('2^-100000')).toBe('exponentTooLarge@1');
    // 上限ちょうどは通る。2^1000 は2の冪なので double でも厳密に表せる。
    expect(evaluate('2^1000').toNumber()).toBe(2 ** 1000);
  });
});

/**
 * 単位つきの数の期待値の出どころ:
 * 1 inch = 25.4 mm(国際インチの定義値、厳密)。ほかの値はすべて 10 進の掛け算で導ける。
 *   1.5in  = 1.5 × 25.4 = 38.1
 *   3/8"   = 0.375 × 25.4 = 9.525
 *   1in+2mm = 25.4 + 2 = 27.4
 *   (10*2)in = 20 × 25.4 = 508
 * 割り切れない値(1/3in、π*1in)だけは、既知の定数から独立に組み立てた式と突き合わせる。
 */
describe('長さの単位の評価(FR-814、計画書 docs/plans/P6-入出力.md §2.9.1)', () => {
  it('単位つきの数は必ず mm の値になる', () => {
    expect(evaluate('1in').toString()).toBe('25.4');
    expect(evaluate('1.5in').toString()).toBe('38.1');
    expect(evaluate('2mm').toString()).toBe('2');
    // 空白を挟んでも、大文字でも、" でも同じ。
    expect(evaluate('1.5 in').toString()).toBe('38.1');
    expect(evaluate('1.5IN').toString()).toBe('38.1');
    expect(evaluate('1.5"').toString()).toBe('38.1');
  });

  it('分数のインチ(3/8")は 3÷8 インチとして読む', () => {
    expect(evaluate('3/8"').toString()).toBe('9.525');
    expect(evaluate('3/8in').toString()).toBe('9.525');
  });

  it('割り切れない値も丸めずに任意精度で持つ(NFR-RE-4)', () => {
    // 1/3in = 25.4/3。有効数字 30 桁で突き合わせる(40 桁の内部精度の最後の桁は、
    // (1÷3)×25.4 と 25.4÷3 で丸めの向きが変わりうるため)。
    const expected = new ExpressionDecimal(MM_PER_INCH_TEXT).dividedBy(3);
    expect(evaluate('1/3in').toSignificantDigits(30).toString()).toBe(
      expected.toSignificantDigits(30).toString(),
    );
  });

  it('括弧・関数・単項マイナスの後ろにも単位を付けられる', () => {
    expect(evaluate('(1+0.5)in').toString()).toBe('38.1');
    expect(evaluate('sqrt(4)in').toString()).toBe('50.8');
    expect(evaluate('-1in').toString()).toBe('-25.4');
    expect(evaluate('(10*2)in').toString()).toBe('508');
  });

  it('無次元との掛け算・割り算は通り、単位の付いた辺どうしの足し算も通る', () => {
    expect(evaluate('1in*2').toString()).toBe('50.8');
    expect(evaluate('1in/2').toString()).toBe('12.7');
    expect(evaluate('1in+2mm').toString()).toBe('27.4');
    // π は無次元。25.4π になる。
    const expected = PI.times(new ExpressionDecimal(MM_PER_INCH_TEXT));
    expect(evaluate('π*1in').toSignificantDigits(30).toString()).toBe(
      expected.toSignificantDigits(30).toString(),
    );
  });

  it('単位の空間の中ではパラメータも表示の単位の数として扱う(§0.a-0.63)', () => {
    // w は内部の値(mm)。単位の中では 25.4 で割ってから式へ入り、最後に 25.4 を掛け直す。
    const variables = new Map([['w', 25.4]]);
    expect(evaluate('(w*2)in', variables).toString()).toBe('50.8');
    expect(evaluate('(w)in', variables).toString()).toBe('25.4');
    expect(evaluate('(w/2)in', variables).toString()).toBe('12.7');
    // 線形でない式(リテラルが足される)は mm のときと値が変わる。これは意図した結果。
    expect(evaluate('(w+10)in', variables).toString()).toBe('279.4');
    expect(evaluate('w+10', variables).toString()).toBe('35.4');
    // mm は倍率 1 なので、割り算も掛け算も恒等になる。
    expect(evaluate('(w*2)mm', variables).toString()).toBe('50.8');
  });

  it('単位が合っていない式は unitMismatch で断る', () => {
    // 片方だけ単位(§2.9.1「単位は最後にだけ付けられる」)。
    expect(codeAt('1in+2')).toBe('unitMismatch@3');
    expect(failureOf('1in+2').message).toBe('単位をそろえてください。(4 文字目)');
    expect(codeAt('2+(1in)')).toBe('unitMismatch@1');
    // 単位どうしの掛け算(面積になる)と、割る側の単位。
    expect(codeAt('1in*(2mm)')).toBe('unitMismatch@3');
    expect(codeAt('2/(1in)')).toBe('unitMismatch@1');
    // 単位つきの累乗。
    expect(codeAt('1in^2')).toBe('unitMismatch@3');
    // 単位の入れ子。位置は内側の単位を指す。
    expect(codeAt('(1.5in*2)in')).toBe('unitMismatch@4');
    expect(codeAt('1in*2in')).toBe('unitMismatch@1');
    // 関数の引数に単位は書けない(`sqrt(4)in` と書く)。
    expect(codeAt('sqrt(4in)')).toBe('unitMismatch@6');
  });

  it('長さでないパラメータは単位の空間でも換算しない(手順5b)', () => {
    // 個数のパラメータ n = 5。長さとして扱うと (5/25.4+10)×25.4 = 5+254 = 259 になり、
    // 長さでないと伝えれば (5+10)×25.4 = 381 になる。
    const variables = new Map([['n', 5]]);
    expect(evaluate('(n+10)in', variables).toNumber()).toBe(259);
    const asCount = evaluateExpression('(n+10)in', {
      variables,
      nonLengthVariables: new Set(['n']),
    });
    expect(asCount.ok && asCount.value.value).toBe(381);
  });

  it('式は文字列のまま保存される(FR-202)', () => {
    expect(evaluateExpression('1.5in')).toEqual({
      ok: true,
      value: { source: '1.5in', value: 38.1, display: '38.1' },
    });
    expect(evaluateExpression('(10*2)in')).toEqual({
      ok: true,
      value: { source: '(10*2)in', value: 508, display: '508' },
    });
  });

  it('単位を書かない既存の式は 1 つも振る舞いが変わらない', () => {
    expect(evaluate('5*2').toString()).toBe('10');
    expect(evaluate('3/4').toString()).toBe('0.75');
    expect(evaluate('sqrt(2)').toString()).toBe(new ExpressionDecimal(2).sqrt().toString());
    expect(evaluate('pi').toString()).toBe(PI.toString());
    // 単位と同じ綴りのパラメータも、これまでどおり変数として使える。
    expect(evaluate('mm*2', new Map([['mm', 3]])).toString()).toBe('6');
    expect(evaluate('2*in', new Map([['in', 3]])).toString()).toBe('6');
  });
});
