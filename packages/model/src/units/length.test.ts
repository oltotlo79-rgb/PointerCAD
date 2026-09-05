/**
 * 表示と入力の長さの単位の検査(FR-811、FR-814、NFR-RE-3、
 * 計画書 docs/plans/P6-入出力.md §2.9・§2.9.1・タスク1)。
 *
 * 期待値は計画書の検証表を担当が独立に導出したもの(導出は各検査の注釈に書く)。
 * 単位つきの式の評価そのものは `packages/expression` の検査が固定しているので、ここでは
 * 「欄に打った文字列が、どの式の文字列になり、いくつになるか」までを通しで確かめる。
 */

import { evaluateExpression, expressionValueFromNumber, MM_PER_INCH_TEXT } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { formatLength } from '../measure/massProperties.js';
import type { Parameter } from '../parameters/types.js';

import {
  DEFAULT_INCH_DENOMINATOR,
  formatDisplayLength,
  fromDisplayLength,
  INCH_DISPLAY_DIGITS,
  LENGTH_UNITS,
  MM_PER_INCH,
  nonLengthVariables,
  normalizeInchQuotes,
  parseDisplayInput,
  toDisplayLength,
  toFractionalInch,
} from './length.js';

/** 検査用のパラメータ 1 つ。式は文字列のまま持つ(FR-202)。 */
function param(name: string, source: string, unit: Parameter['unit']): Parameter {
  const evaluated = evaluateExpression(source);
  return {
    name,
    value: evaluated.ok ? evaluated.value : expressionValueFromNumber(0),
    unit,
    description: '',
  };
}

describe('MM_PER_INCH(国際インチの定義値)', () => {
  it('25.4 である', () => {
    expect(MM_PER_INCH).toBe(25.4);
  });

  it('expression の倍率(10 進の文字列)と同じ値である(2 か所に別の値を置かない)', () => {
    // expression は model に依存できないので倍率をそれぞれが持つ。値の一致はここで固定する。
    expect(MM_PER_INCH_TEXT).toBe('25.4');
    expect(Number(MM_PER_INCH_TEXT)).toBe(MM_PER_INCH);
  });

  it('表示の単位の一覧は mm と inch の 2 つ', () => {
    expect(LENGTH_UNITS).toEqual(['mm', 'inch']);
  });
});

describe('toDisplayLength / fromDisplayLength(表示と内部の境目だけで換算する)', () => {
  it('100mm は 3.937007874015748 inch(100/25.4)', () => {
    expect(toDisplayLength(100, 'inch')).toBe(100 / 25.4);
    expect(toDisplayLength(100, 'inch')).toBeCloseTo(3.937007874015748, 12);
  });

  it('mm の表示は恒等(同じ数がそのまま返る)', () => {
    expect(toDisplayLength(12345.6789, 'mm')).toBe(12345.6789);
    expect(fromDisplayLength(12345.6789, 'mm')).toBe(12345.6789);
  });

  it('1 inch は 25.4mm(定義)', () => {
    expect(fromDisplayLength(1, 'inch')).toBe(25.4);
  });

  it('1 → 25.4 → 1 の往復で元へ戻る', () => {
    const millimeters = fromDisplayLength(1, 'inch');
    expect(millimeters).toBe(25.4);
    expect(toDisplayLength(millimeters, 'inch')).toBe(1);
  });

  it('mm → inch → mm の往復が 1e-9 以内で戻る(丸め誤差の上限)', () => {
    for (const millimeters of [0.1, 1, 100, 12345.6789]) {
      expect(fromDisplayLength(toDisplayLength(millimeters, 'inch'), 'inch')).toBeCloseTo(
        millimeters,
        9,
      );
    }
  });

  it('0 と負の値も換算できる(向きのある寸法に使う)', () => {
    expect(toDisplayLength(0, 'inch')).toBe(0);
    expect(fromDisplayLength(-2, 'inch')).toBe(-50.8);
  });
});

describe('formatDisplayLength(書式)', () => {
  it('inch は小数 3 桁 + in(10mm = 10/25.4 = 0.3937… → 0.394)', () => {
    expect(INCH_DISPLAY_DIGITS).toBe(3);
    expect(formatDisplayLength(10, 'inch')).toBe('0.394 in');
  });

  it('9.525mm は 0.375 in(9.525/25.4 = 0.375。3/8 inch)', () => {
    expect(formatDisplayLength(9.525, 'inch')).toBe('0.375 in');
  });

  it('25.4mm は 1.000 in(桁は落とさない)', () => {
    expect(formatDisplayLength(25.4, 'inch')).toBe('1.000 in');
  });

  it('桁数は指定できる(10mm を 6 桁で 0.393701 in)', () => {
    // 10/25.4 = 0.3937007874015748 → 小数 6 桁で 0.393701
    expect(formatDisplayLength(10, 'inch', 6)).toBe('0.393701 in');
  });

  it('mm は既存の書式そのまま(1000mm 以上は m)', () => {
    expect(formatDisplayLength(1500, 'mm')).toBe('1.5 m');
    expect(formatDisplayLength(9.525, 'mm')).toBe('9.525 mm');
  });

  it('mm の書式は measure/massProperties.ts の formatLength を呼ぶ(規則を 2 か所に書かない)', () => {
    for (const millimeters of [0, 5, 999, 1000, 1500, -2500]) {
      expect(formatDisplayLength(millimeters, 'mm')).toBe(formatLength(millimeters));
    }
  });
});

describe('toFractionalInch(分数インチの表記。FR-814)', () => {
  it('既定の分母は 64(1/64 刻み)', () => {
    expect(DEFAULT_INCH_DENOMINATOR).toBe(64);
  });

  it('9.525mm は 3/8"(0.375×64 = 24、gcd(24,64) = 8 → 3/8)', () => {
    expect(toFractionalInch(9.525)).toBe('3/8"');
  });

  it('12.7mm は 1/2"(0.5×64 = 32、gcd(32,64) = 32 → 1/2)', () => {
    expect(toFractionalInch(12.7)).toBe('1/2"');
  });

  it('25.4mm は 1"(整数になったら分数を出さない)', () => {
    expect(toFractionalInch(25.4)).toBe('1"');
  });

  it('38.1mm は 1 1/2"(1.5 inch。帯分数で書く)', () => {
    expect(toFractionalInch(38.1)).toBe('1 1/2"');
  });

  it('10mm は 25/64"(10/25.4 = 0.3937…、×64 = 25.196… → 25。gcd(25,64) = 1)', () => {
    // 刻みへ丸めるので元へは戻らない。25/64 inch = 9.921875mm(差 0.078125mm)。
    expect(toFractionalInch(10)).toBe('25/64"');
    expect((25 / 64) * 25.4).toBeCloseTo(9.921875, 12);
  });

  it('25.5mm は 1"(25.5/25.4 = 1.00393…、×64 = 64.25… → 64 = 64/64)', () => {
    // 指示書の候補「1 1/64"」ではなく最近の刻みは 64/64 = 1。値を書き換えず実測を残す。
    expect(toFractionalInch(25.5)).toBe('1"');
  });

  it('25.796875mm は 1 1/64"(1 + 1/64 inch。刻み 1 つぶんの端数)', () => {
    expect(toFractionalInch(25.796875)).toBe('1 1/64"');
  });

  it('0mm は 0"(符号を付けない)', () => {
    expect(toFractionalInch(0)).toBe('0"');
    expect(toFractionalInch(-0)).toBe('0"');
  });

  it('刻みより小さい値も 0"(-0" と書かない)', () => {
    // 0.1mm = 0.00394 inch、×64 = 0.252 → 0。
    expect(toFractionalInch(0.1)).toBe('0"');
    expect(toFractionalInch(-0.1)).toBe('0"');
  });

  it('負の値は先頭に - を付ける(大きさで丸めるので正負の刻みが同じ)', () => {
    expect(toFractionalInch(-12.7)).toBe('-1/2"');
    expect(toFractionalInch(-38.1)).toBe('-1 1/2"');
    expect(toFractionalInch(-25.4)).toBe('-1"');
  });

  it('分母は指定できる(10mm を 1/8 刻みにすると 3/8")', () => {
    // 0.3937…×8 = 3.1496 → 3。gcd(3,8) = 1。
    expect(toFractionalInch(10, 8)).toBe('3/8"');
    expect(toFractionalInch(10, 2)).toBe('1/2"');
  });
});

describe('normalizeInchQuotes(入力欄の引用符)', () => {
  it('全角の閉じ引用符 ” を半角の " へ直す', () => {
    expect(normalizeInchQuotes('3/8”')).toBe('3/8"');
  });

  it('開き引用符・ダブルプライム・全角の二重引用符も半角へ直す', () => {
    expect(normalizeInchQuotes('1“')).toBe('1"');
    expect(normalizeInchQuotes('1″')).toBe('1"');
    expect(normalizeInchQuotes('1＂')).toBe('1"');
  });

  it('文字数は変わらない(欄のカーソル位置がずれない)', () => {
    const source = '3/8”';
    expect(normalizeInchQuotes(source).length).toBe(source.length);
  });

  it('引用符が無ければ何も変わらない', () => {
    expect(normalizeInchQuotes('10*2')).toBe('10*2');
  });
});

describe('parseDisplayInput(打った文字列 → 保存する式の文字列)', () => {
  it('表示が inch で単位を書かない数は (…)in で包む', () => {
    expect(parseDisplayInput('10', 'inch')).toBe('(10)in');
  });

  it('表示が inch では式も同じ扱い(一部だけを包まない)', () => {
    expect(parseDisplayInput('10*2', 'inch')).toBe('(10*2)in');
    expect(parseDisplayInput('w*2', 'inch')).toBe('(w*2)in');
    expect(parseDisplayInput('w+10', 'inch')).toBe('(w+10)in');
  });

  it('単位が 1 つでも書かれていれば包まない', () => {
    expect(parseDisplayInput('2mm', 'inch')).toBe('2mm');
    expect(parseDisplayInput('1.5in', 'inch')).toBe('1.5in');
    expect(parseDisplayInput('2*1.5in', 'inch')).toBe('2*1.5in');
  });

  it('全角の引用符は半角へ直したうえで「単位あり」と見なす(二重に包まない)', () => {
    expect(parseDisplayInput('3/8”', 'inch')).toBe('3/8"');
  });

  it('表示が mm のときは何も包まない(既存の式と 1 バイトも変えない)', () => {
    expect(parseDisplayInput('10', 'mm')).toBe('10');
    expect(parseDisplayInput('10*2', 'mm')).toBe('10*2');
    expect(parseDisplayInput('1.5in', 'mm')).toBe('1.5in');
  });

  it('表示が mm でも引用符だけは直す(mm の欄でも 3/8" と打てる)', () => {
    expect(parseDisplayInput('3/8”', 'mm')).toBe('3/8"');
  });

  it('空の入力は包まない(()in という読めない式を作らない)', () => {
    expect(parseDisplayInput('', 'inch')).toBe('');
    expect(parseDisplayInput('   ', 'inch')).toBe('   ');
  });
});

describe('parseDisplayInput の結果を評価する(§0.a-0.63 の通し)', () => {
  /** 打った文字列を式へ直してから評価し、内部の値(mm)を返す。 */
  function millimetersOf(
    source: string,
    unit: 'mm' | 'inch',
    variables?: ReadonlyMap<string, number>,
  ): number {
    const result = evaluateExpression(parseDisplayInput(source, unit), { variables });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value.value;
  }

  it('表示が inch で 10 と打つと 254mm(10×25.4)', () => {
    expect(millimetersOf('10', 'inch')).toBeCloseTo(254, 9);
  });

  it('表示が inch で 10*2 と打つと 508mm(20×25.4)', () => {
    expect(millimetersOf('10*2', 'inch')).toBeCloseTo(508, 9);
  });

  it('10 と 10*1 が同じ値になる(数と式で振る舞いが分かれない)', () => {
    expect(millimetersOf('10', 'inch')).toBe(millimetersOf('10*1', 'inch'));
  });

  it('表示が inch で w*2(w = 25.4mm)は 50.8mm(1in × 2)', () => {
    const variables = new Map([['w', 25.4]]);
    expect(millimetersOf('w*2', 'inch', variables)).toBeCloseTo(50.8, 9);
  });

  it('表示が inch で 3/8” は 9.525mm(全角の引用符のまま打っても通る)', () => {
    expect(millimetersOf('3/8”', 'inch')).toBeCloseTo(9.525, 9);
  });

  it('表示が mm では包まないので 10 は 10mm のまま', () => {
    expect(millimetersOf('10', 'mm')).toBe(10);
  });

  it('表示が mm でも単位を書けば換算される(1.5in = 38.1mm)', () => {
    expect(millimetersOf('1.5in', 'mm')).toBeCloseTo(38.1, 9);
  });
});

describe('nonLengthVariables(長さでないパラメータの名前)', () => {
  it('degree と none の名前だけを集める', () => {
    const parameters = [
      param('板厚', '10', 'mm'),
      param('角度', '30', 'degree'),
      param('個数', '5', 'none'),
    ];
    const names = nonLengthVariables(parameters);
    expect([...names].sort()).toEqual(['個数', '角度']);
    expect(names.has('板厚')).toBe(false);
  });

  it('パラメータが無ければ空の集合', () => {
    expect(nonLengthVariables([]).size).toBe(0);
  });

  it('長さだけの表なら空の集合(渡しても評価は変わらない)', () => {
    expect(nonLengthVariables([param('板厚', '10', 'mm')]).size).toBe(0);
  });

  it('渡すと単位の空間の中でも換算されない(個数 5 の n で (n+10)in = 381mm)', () => {
    // 長さとして扱うと (5/25.4 + 10)×25.4 = 259.4mm。個数なので割らず (5+10)×25.4 = 381mm。
    const parameters = [param('n', '5', 'none')];
    const variables = new Map([['n', 5]]);
    const source = parseDisplayInput('n+10', 'inch');
    expect(source).toBe('(n+10)in');
    const withUnit = evaluateExpression(source, {
      variables,
      nonLengthVariables: nonLengthVariables(parameters),
    });
    expect(withUnit.ok).toBe(true);
    expect(withUnit.ok ? withUnit.value.value : Number.NaN).toBeCloseTo(381, 9);
  });

  it('長さのパラメータは単位の空間で換算される((w+10)in、w = 25.4mm で 279.4mm)', () => {
    // 25.4 × (25.4/25.4 + 10) = 25.4 × 11 = 279.4
    const parameters = [param('w', '25.4', 'mm')];
    const variables = new Map([['w', 25.4]]);
    const result = evaluateExpression(parseDisplayInput('w+10', 'inch'), {
      variables,
      nonLengthVariables: nonLengthVariables(parameters),
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.value : Number.NaN).toBeCloseTo(279.4, 9);
  });
});
