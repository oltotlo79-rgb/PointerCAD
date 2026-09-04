import { describe, expect, it } from 'vitest';

import {
  checkVariableName,
  collectVariableNames,
  isNumericLiteral,
  renameVariable,
} from './variableNames.js';

describe('collectVariableNames(FR-207): 式が参照する変数名の一覧', () => {
  it('式の中の変数名を最初に出た順に集める', () => {
    expect(collectVariableNames('板厚 * 2 + 穴径')).toEqual(['板厚', '穴径']);
  });

  it('関数名・定数は含めない', () => {
    expect(collectVariableNames('sqrt(板厚) + pi')).toEqual(['板厚']);
  });

  it('数だけの式は空の配列', () => {
    expect(collectVariableNames('root(8, 3)')).toEqual([]);
  });

  it('同じ変数が複数回出ても1回だけ数える', () => {
    expect(collectVariableNames('板厚 + 板厚 * 2')).toEqual(['板厚']);
  });

  it('読めない式は例外を投げず空の配列を返す', () => {
    expect(collectVariableNames('板厚 +')).toEqual([]);
  });
});

describe('renameVariable(FR-207): 式の中の変数名の書き換え', () => {
  it('変数名を書き換える', () => {
    expect(renameVariable('板厚 * 2', '板厚', '板の厚み')).toBe('板の厚み * 2');
  });

  it('字句単位で判定するので部分一致では書き換わらない', () => {
    expect(renameVariable('板厚さ + 板厚', '板厚', '厚み')).toBe('板厚さ + 厚み');
  });

  it('直後が開き括弧の識別子(関数名)は書き換えない', () => {
    expect(renameVariable('sqrt(4)', 'sqrt', 'x')).toBe('sqrt(4)');
  });

  it('定数 pi は書き換えない', () => {
    expect(renameVariable('pi * r', 'pi', 'x')).toBe('pi * r');
  });

  it('該当する変数が無ければ元の文字列のまま', () => {
    expect(renameVariable('板厚 * 2', '穴径', 'x')).toBe('板厚 * 2');
  });

  it('複数回出てくる変数はすべて書き換える', () => {
    expect(renameVariable('板厚 + 板厚 * 2', '板厚', '厚み')).toBe('厚み + 厚み * 2');
  });

  it('字句解析できない式は例外を投げず元の文字列のまま返す(tokenize が unexpectedCharacter で断る例)', () => {
    expect(renameVariable('板厚 @ 2', '板厚', '厚み')).toBe('板厚 @ 2');
  });
});

describe('isNumericLiteral(P4b §0.2): 数値リテラル1つの式か', () => {
  it('数値リテラルは true', () => {
    expect(isNumericLiteral('10')).toBe(true);
    expect(isNumericLiteral('-2.5')).toBe(true);
    expect(isNumericLiteral('.5')).toBe(true);
  });

  it('前置の + が付いた数値リテラルも true', () => {
    expect(isNumericLiteral('+3')).toBe(true);
  });

  it('数値リテラル1つでない式は false(式は定数として扱う)', () => {
    expect(isNumericLiteral('10 + 0')).toBe(false);
    expect(isNumericLiteral('板厚')).toBe(false);
    expect(isNumericLiteral('sqrt(4)')).toBe(false);
    expect(isNumericLiteral('10/2')).toBe(false);
  });

  it('読めない式は false', () => {
    expect(isNumericLiteral('板厚 +')).toBe(false);
  });
});

describe('checkVariableName(§2.6): パラメータ名として使えるか', () => {
  it('日本語の名前は使える', () => {
    expect(checkVariableName('板厚')).toBeNull();
    expect(checkVariableName('穴径2')).toBeNull();
  });

  it('数字で始まる名前は使えない', () => {
    expect(checkVariableName('2倍')).toBe('startsWithDigit');
  });

  it('関数名・定数名は予約語として断る', () => {
    expect(checkVariableName('sqrt')).toBe('reserved');
    expect(checkVariableName('cbrt')).toBe('reserved');
    expect(checkVariableName('abs')).toBe('reserved');
    expect(checkVariableName('rad')).toBe('reserved');
    expect(checkVariableName('root')).toBe('reserved');
    expect(checkVariableName('pi')).toBe('reserved');
    expect(checkVariableName('π')).toBe('reserved');
    expect(checkVariableName('e')).toBe('reserved');
  });

  it('式の文法に使う文字を含む名前・空白を含む名前は使えない', () => {
    expect(checkVariableName('板 厚')).toBe('invalidCharacter');
    expect(checkVariableName('a+b')).toBe('invalidCharacter');
  });

  it('空の名前は使えない', () => {
    expect(checkVariableName('')).toBe('empty');
  });
});
