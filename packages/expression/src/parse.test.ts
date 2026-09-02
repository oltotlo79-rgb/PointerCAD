import { describe, expect, it } from 'vitest';

import type { Node } from './ast.js';
import { ExpressionFailure, type ExpressionError } from './errors.js';
import { parse } from './parse.js';

/** 構文木を括弧つきの文字列にして、形を目で確かめられるようにする。 */
function show(node: Node): string {
  switch (node.kind) {
    case 'number':
      return node.text;
    case 'constant':
      return node.name;
    case 'variable':
      return node.name;
    case 'unary':
      return `(${node.operator} ${show(node.operand)})`;
    case 'binary':
      return `(${node.operator} ${show(node.left)} ${show(node.right)})`;
    case 'call':
      return `(${[node.name, ...node.args.map((argument) => show(argument))].join(' ')})`;
  }
}

/** show と同じ形に、各節の位置(0 始まり)を「@位置」として添える。 */
function showWithPosition(node: Node): string {
  const at = `@${String(node.position)}`;
  switch (node.kind) {
    case 'number':
    case 'constant':
    case 'variable':
      return `${show(node)}${at}`;
    case 'unary':
      return `(${node.operator}${at} ${showWithPosition(node.operand)})`;
    case 'binary':
      return `(${node.operator}${at} ${showWithPosition(node.left)} ${showWithPosition(node.right)})`;
    case 'call': {
      const args = node.args.map((argument) => ` ${showWithPosition(argument)}`).join('');
      return `(${node.name}${at}${args})`;
    }
  }
}

/** 失敗したときのエラー内容を取り出す。エラーにならなければテストを落とす。 */
function failureOf(source: string): ExpressionError {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ExpressionFailure) {
      return error.detail;
    }
    throw error;
  }
  throw new Error(`エラーになりませんでした: ${source}`);
}

/** エラーの種類と位置を1つの期待値で確かめる(位置が定まらないときは -1)。 */
function codeAt(source: string): string {
  const detail = failureOf(source);
  return `${detail.code}@${String(detail.position)}`;
}

describe('構文解析(FR-201)', () => {
  it('掛け算は足し算より強い', () => {
    expect(show(parse('1+2*3'))).toBe('(+ 1 (* 2 3))');
    expect(show(parse('1*2+3'))).toBe('(+ (* 1 2) 3)');
  });

  it('引き算は左結合', () => {
    expect(show(parse('1-2-3'))).toBe('(- (- 1 2) 3)');
  });

  it('割り算も左結合で、掛け算と同じ強さ', () => {
    expect(show(parse('1/2/3'))).toBe('(/ (/ 1 2) 3)');
    expect(show(parse('1/2*3'))).toBe('(* (/ 1 2) 3)');
  });

  it('単項マイナスは累乗より外側', () => {
    expect(show(parse('-2^2'))).toBe('(- (^ 2 2))');
  });

  it('単項の + と - は右結合で重ねられる', () => {
    expect(show(parse('--3'))).toBe('(- (- 3))');
    expect(show(parse('+-3'))).toBe('(+ (- 3))');
    expect(show(parse('1--2'))).toBe('(- 1 (- 2))');
  });

  it('累乗の指数に単項マイナスを書ける', () => {
    expect(show(parse('2^-3'))).toBe('(^ 2 (- 3))');
  });

  it('累乗は右結合', () => {
    expect(show(parse('2^3^2'))).toBe('(^ 2 (^ 3 2))');
  });

  it('累乗は掛け算より強い', () => {
    expect(show(parse('2*3^2'))).toBe('(* 2 (^ 3 2))');
  });

  it('√ は直後の単項式1つに掛かる', () => {
    expect(show(parse('√9+1'))).toBe('(+ (sqrt 9) 1)');
    expect(show(parse('√4*3'))).toBe('(* (sqrt 4) 3)');
    expect(show(parse('√(9+1)'))).toBe('(sqrt (+ 9 1))');
    expect(show(parse('-√4'))).toBe('(- (sqrt 4))');
    // BNF の「√ unaryExpr」により、指数まで含めた単項式1つを食う(§2.1、§2.2 の備考)。
    expect(show(parse('√9^2'))).toBe('(sqrt (^ 9 2))');
  });

  it('括弧が優先順位を上書きする', () => {
    expect(show(parse('(1+2)*3'))).toBe('(* (+ 1 2) 3)');
    expect(show(parse('2^(3^2)'))).toBe('(^ 2 (^ 3 2))');
    expect(show(parse('(2^3)^2'))).toBe('(^ (^ 2 3) 2)');
  });

  it('関数と引数を読む', () => {
    expect(show(parse('root(27,3)'))).toBe('(root 27 3)');
    expect(show(parse('rad(pi)'))).toBe('(rad pi)');
    expect(show(parse('sqrt(1+2*3)'))).toBe('(sqrt (+ 1 (* 2 3)))');
    expect(show(parse('abs(-3)*2'))).toBe('(* (abs (- 3)) 2)');
  });

  it('小数と空白を含む式も読める', () => {
    expect(show(parse('12.5 + .5'))).toBe('(+ 12.5 .5)');
  });

  it('π は pi と同じ定数、e も定数、その他の名前は変数', () => {
    const piBySymbol = parse('π');
    const piByName = parse('pi');
    const napier = parse('e');
    const other = parse('a1');
    expect(piBySymbol.kind).toBe('constant');
    expect(show(piBySymbol)).toBe('pi');
    expect(piByName.kind).toBe('constant');
    expect(show(piByName)).toBe('pi');
    expect(napier.kind).toBe('constant');
    expect(show(napier)).toBe('e');
    expect(other.kind).toBe('variable');
    expect(show(other)).toBe('a1');
  });

  it('節の位置は元の式の文字位置を指す', () => {
    expect(showWithPosition(parse('1+2*3'))).toBe('(+@1 1@0 (*@3 2@2 3@4))');
    expect(showWithPosition(parse('-2^2'))).toBe('(-@0 (^@2 2@1 2@3))');
    expect(showWithPosition(parse('√9'))).toBe('(sqrt@0 9@1)');
    expect(showWithPosition(parse('root(27,3)'))).toBe('(root@0 27@5 3@8)');
    // 括弧は節を作らないので、位置は括弧の中の演算子を指す。
    expect(showWithPosition(parse('(1+2)*3'))).toBe('(*@5 (+@2 1@1 2@3) 3@6)');
    expect(showWithPosition(parse('π+a1'))).toBe('(+@1 pi@0 a1@2)');
  });

  it('閉じ括弧が足りないと unclosedParenthesis', () => {
    // 位置は括弧の式でも関数呼び出しでも「開き括弧」を指す。同じ意味の失敗が同じ場所を
    // 指すよう統一した(docs/報告記録.md 2026-09-02 18:23 の判断③)。
    expect(codeAt('(1+2')).toBe('unclosedParenthesis@0');
    expect(codeAt('root(1,2')).toBe('unclosedParenthesis@4');
    expect(codeAt('sqrt(1')).toBe('unclosedParenthesis@4');
    expect(codeAt('1+((2)')).toBe('unclosedParenthesis@2');
    expect(failureOf('(1+2').message).toBe('閉じ括弧 ) が足りません。');
  });

  it('余分な閉じ括弧は unexpectedTrailing', () => {
    expect(codeAt('1+2)')).toBe('unexpectedTrailing@3');
    expect(failureOf('1+2)').message).toBe('式の後ろに余分なものがあります: 「)」(4 文字目)');
  });

  it('式が途中で終わったら unexpectedEnd(位置は定まらないので -1)', () => {
    expect(codeAt('1+')).toBe('unexpectedEnd@-1');
    expect(codeAt('2^')).toBe('unexpectedEnd@-1');
    expect(codeAt('√')).toBe('unexpectedEnd@-1');
    expect(codeAt('root(')).toBe('unexpectedEnd@-1');
    expect(failureOf('1+').message).toBe('式が途中で終わっています。');
  });

  it('数値か ( が来るべき所の別の字句は unexpectedToken', () => {
    expect(codeAt('1+)')).toBe('unexpectedToken@2');
    expect(codeAt('*3')).toBe('unexpectedToken@0');
    expect(codeAt('()')).toBe('unexpectedToken@1');
    expect(codeAt('(1+2,')).toBe('unexpectedToken@4');
    expect(codeAt('root(1 2)')).toBe('unexpectedToken@7');
    expect(failureOf('1+)').message).toBe('ここには数値か ( が必要です: 「)」(3 文字目)');
  });

  it('字句解析のエラーはそのまま呼び出し元へ伝わる', () => {
    expect(codeAt('')).toBe('empty@-1');
    expect(codeAt('   ')).toBe('empty@-1');
    expect(codeAt('1@2')).toBe('unexpectedCharacter@1');
    expect(codeAt('1'.repeat(1001))).toBe('tooLong@-1');
  });
});
