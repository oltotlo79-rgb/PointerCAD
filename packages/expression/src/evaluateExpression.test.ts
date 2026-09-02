import { describe, expect, it } from 'vitest';

import type { ExpressionErrorCode } from './errors.js';
import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from './evaluateExpression.js';

/** 絵文字(U+1F600)。UTF-16 では 2 単位を占める。エスケープで書く理由は tokenize.test.ts と同じ。 */
const GRINNING_FACE = '\u{1F600}';

/** 成功を前提に値を取り出す。失敗したらテストを落とす。 */
function valueOf(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`評価に失敗しました: ${source} / ${result.error.message}`);
  }
  return result.value;
}

/** 失敗を前提にエラーを取り出す。成功したらテストを落とす。 */
function errorOf(source: string): {
  code: ExpressionErrorCode;
  message: string;
  position: number;
} {
  const result = evaluateExpression(source);
  if (result.ok) {
    throw new Error(`エラーになりませんでした: ${source}`);
  }
  return {
    code: result.error.code,
    message: result.error.message,
    position: result.error.position,
  };
}

describe('式の公開 API(FR-202、FR-203、FR-204、FR-206)', () => {
  it('式そのものを持ち回る(評価結果だけを返さない)', () => {
    const value = valueOf('10*2');
    expect(value.source).toBe('10*2');
    expect(value.value).toBe(20);
    expect(value.display).toBe('20');
  });

  it('式は入力されたまま返す(全角も直さない)', () => {
    // FR-202。再編集のときに利用者が打った字をそのまま出すため、正規化した式を source にしない。
    expect(valueOf('  １＋２  ').source).toBe('  １＋２  ');
    expect(valueOf('  １＋２  ').value).toBe(3);
  });

  it('double へ落とすのは最後の1回だけ(NFR-RE-4)', () => {
    // 十進で 1/3 は 0.333…(40 桁)。3 を掛けると 0.999…9 になり、最も近い double は 1。
    // double で先に丸めると 0.3333333333333333 * 3 = 1 にはなるが 1/49*49 は 1 にならない。
    expect(valueOf('1/3*3').value).toBe(1);
    expect(valueOf('1/49*49').value).toBe(1);
    // 独立検算: double だけで計算すると 1 にならないことを確かめる。
    expect((1 / 49) * 49).not.toBe(1);
    // 40 桁の 1.414…^2 = 1.999…9 に最も近い double は厳密に 2。
    expect(valueOf('√2^2').value).toBe(2);
    expect(valueOf('sqrt(2)^2').value).toBe(2);
    // 十進では 0.1+0.2 が厳密に 0.3。0.3 に最も近い double はリテラル 0.3 と同じ。
    expect(valueOf('0.1+0.2').value).toBe(0.3);
  });

  it('表示は有効数字 12 桁へ丸める', () => {
    expect(valueOf('1/3').display).toBe('0.333333333333');
    expect(valueOf('sqrt(2)').display).toBe('1.41421356237');
    expect(valueOf('pi').display).toBe('3.14159265359');
    expect(valueOf('e').display).toBe('2.71828182846');
    // 12 桁に満たない値は余分な 0 を付けない。
    expect(valueOf('1.5').display).toBe('1.5');
    expect(valueOf('-0').display).toBe('0');
  });

  it('表示用の丸めは値へ影響しない', () => {
    // display は 12 桁だが value は 40 桁の計算から double へ落とした値。
    const third = valueOf('1/3');
    expect(third.display).toBe('0.333333333333');
    expect(third.value).toBe(1 / 3);
    expect(third.value).not.toBe(0.333333333333);
  });

  it('分数・累乗・n乗根・√ が使える(FR-201)', () => {
    expect(valueOf('3/4').value).toBe(0.75);
    expect(valueOf('2^10').value).toBe(1024);
    expect(valueOf('root(27,3)').value).toBe(3);
    expect(valueOf('√9').value).toBe(3);
    expect(valueOf('cbrt(-8)').value).toBe(-2);
  });

  it('全角のまま打っても通る(NFR-UX-5)', () => {
    expect(valueOf('１＋２').value).toBe(3);
    expect(valueOf('（２＋３）×４').value).toBe(20);
  });

  it('角度は度が既定、rad() でラジアンを書ける(FR-205)', () => {
    expect(valueOf('90').value).toBe(90);
    expect(valueOf('rad(pi/2)').value).toBe(90);
  });

  it('変数表から引ける(FR-206)', () => {
    const result = evaluateExpression('w*2', { variables: new Map([['w', 10]]) });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.value : 0).toBe(20);
    expect(result.ok ? result.value.source : '').toBe('w*2');
  });

  it('変数の値も十進で計算する', () => {
    const result = evaluateExpression('w*3', { variables: new Map([['w', 0.1]]) });
    expect(result.ok ? result.value.value : 0).toBe(0.3);
    expect(result.ok ? result.value.display : '').toBe('0.3');
    // 独立検算: double のまま掛けると 0.3 にならない。変数の経路も十進で計算している証拠。
    expect(0.1 * 3).not.toBe(0.3);
  });

  it('変数表を渡さなければ空として扱い、理由つきで断る(P1 の UI)', () => {
    expect(errorOf('a*2')).toEqual({
      code: 'unknownVariable',
      message: '決まっていない名前です: 「a」(1 文字目)',
      position: 0,
    });
    expect(errorOf('2*abc')).toEqual({
      code: 'unknownVariable',
      message: '決まっていない名前です: 「abc」(3 文字目)',
      position: 2,
    });
  });

  it('エラーの種類・文言・位置が §2.5 の表どおり(FR-204)', () => {
    expect(errorOf('')).toEqual({ code: 'empty', message: '式が空です。', position: -1 });
    expect(errorOf('   ')).toEqual({ code: 'empty', message: '式が空です。', position: -1 });
    expect(errorOf('1'.repeat(1001))).toEqual({
      code: 'tooLong',
      message: '式が長すぎます(1000 文字まで)。',
      position: -1,
    });
    expect(errorOf('1@2')).toEqual({
      code: 'unexpectedCharacter',
      message: '使えない文字があります: 「@」(2 文字目)',
      position: 1,
    });
    expect(errorOf('1+)')).toEqual({
      code: 'unexpectedToken',
      message: 'ここには数値か ( が必要です: 「)」(3 文字目)',
      position: 2,
    });
    expect(errorOf('1+')).toEqual({
      code: 'unexpectedEnd',
      message: '式が途中で終わっています。',
      position: -1,
    });
    expect(errorOf('1+2)')).toEqual({
      code: 'unexpectedTrailing',
      message: '式の後ろに余分なものがあります: 「)」(4 文字目)',
      position: 3,
    });
    expect(errorOf('foo(1)')).toEqual({
      code: 'unknownFunction',
      message: '知らない関数です: 「foo」(1 文字目)',
      position: 0,
    });
    expect(errorOf('root(8)')).toEqual({
      code: 'wrongArgumentCount',
      message: '関数 root には引数が 2 個必要です(1 個でした)。',
      position: 0,
    });
    expect(errorOf('1/0')).toEqual({
      code: 'divisionByZero',
      message: '0 で割ることはできません。',
      position: 1,
    });
    expect(errorOf('sqrt(-4)')).toEqual({
      code: 'negativeRoot',
      message: '負の数の平方根は求められません: -4',
      position: 0,
    });
    expect(errorOf('root(8,0)')).toEqual({
      code: 'rootDegreeZero',
      message: '乗根の n に 0 は指定できません。',
      position: 0,
    });
    expect(errorOf('2^100000')).toEqual({
      code: 'exponentTooLarge',
      message: '累乗の指数が大きすぎます(±1000 まで)。',
      position: 1,
    });
    expect(errorOf('0^-1')).toEqual({
      code: 'notFinite',
      message: '計算結果が数として表せません。',
      position: 1,
    });
  });

  it('閉じ括弧が足りない位置は、括弧でも関数でも開き括弧を指す', () => {
    expect(errorOf('(1+2')).toEqual({
      code: 'unclosedParenthesis',
      message: '閉じ括弧 ) が足りません。',
      position: 0,
    });
    expect(errorOf('root(1,2').position).toBe(4);
    expect(errorOf('root(1,2').code).toBe('unclosedParenthesis');
    expect(errorOf('sqrt(1').position).toBe(4);
  });

  it('絵文字を打っても文言が半端な文字にならない', () => {
    expect(errorOf(`1+${GRINNING_FACE}`)).toEqual({
      code: 'unexpectedCharacter',
      message: `使えない文字があります: 「${GRINNING_FACE}」(3 文字目)`,
      position: 2,
    });
  });

  it('例外を外へ出さず、必ず ok の付いた結果を返す', () => {
    // 入力欄は1文字打つごとにこれを呼ぶので、途中の壊れた式でも投げてはいけない(NFR-UX-5)。
    const sources = ['', ' ', '(', ')', '+', '1+', '*', '√', 'root(', ',', '1..2', '.', '@'];
    for (const source of sources) {
      const detail = errorOf(source);
      expect(detail.message.length).toBeGreaterThan(0);
    }
  });

  it('数値から作った式は、評価し直しても同じ値になる', () => {
    // 極端に小さい値まで含めるのは、指数表記(1e-9)を source にすると
    // この式の文法(§2.1 に指数表記は無い)で読み戻せなくなるため。
    const numbers = [0, 10, -3.5, 7.0710678118654755, 1 / 3, 123456789012345, 1e-9, 1e-12, 1e22];
    for (const number of numbers) {
      const made = expressionValueFromNumber(number);
      expect(made.display).toBe(made.source);
      expect(valueOf(made.source).value).toBe(made.value);
    }
  });

  it('数値から作った式は指数表記にならない', () => {
    // 入力欄へそのまま戻す文字列なので、読み戻せる書き方だけを使う(FR-202)。
    expect(expressionValueFromNumber(1e-9).source).toBe('0.000000001');
    expect(expressionValueFromNumber(1e22).source).toBe('10000000000000000000000');
  });

  it('数値から作った式は 12 桁へ丸めた値を持つ', () => {
    // 値と表示が食い違うと、欄に出ている数と実際の寸法がずれる(NFR-UX-4)。
    expect(expressionValueFromNumber(1 / 3)).toEqual({
      source: '0.333333333333',
      value: 0.333333333333,
      display: '0.333333333333',
    });
    expect(expressionValueFromNumber(20)).toEqual({ source: '20', value: 20, display: '20' });
  });
});
