import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionError } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import { completionKey, completionWord, expressionCandidates, insertCompletion } from './expressionCompletion.js';
import { expressionErrorText } from './expressionErrorText.js';

function parameter(name: string, unit: Parameter['unit'] = 'none'): Parameter {
  return { name, value: expressionValueFromNumber(2), unit, description: '' };
}

function complete(source: string, caret = source.length, parameters: readonly Parameter[] = []) {
  const word = completionWord(source, caret);
  if (word === null) throw new Error('completion word missing');
  return { word, candidates: expressionCandidates(word, parameters, new Map(parameters.map(p => [p.name, 3]))) };
}

describe('式の入力候補', () => {
  it('元の UTF-16 位置のまま、括弧内の語を末尾まで置き換える', () => {
    const source = '２＋（ｓｑ古い）*3';
    const { word, candidates } = complete(source, 5);
    expect(word).toMatchObject({ start: 3, end: 7, prefix: 'sq' });
    expect(insertCompletion(source, word, candidates[0])).toEqual({ source: '２＋（sqrt(）*3', caret: 8 });
    const existing = complete('ｓｑ（３）', 2);
    expect(insertCompletion('ｓｑ（３）', existing.word, existing.candidates[0])).toEqual({ source: 'sqrt（３）', caret: 5 });
  });

  it('名前の数字と日本語、単位の後の演算子を区切り、空と数字だけには出さない', () => {
    expect(complete('3mm＋板厚２').word).toMatchObject({ start: 4, end: 7, prefix: '板厚2', unitSuffix: false });
    for (const source of ['', '123', '2mm+', 'sqrt(']) expect(completionWord(source, source.length)).toBeNull();
    expect(completionWord('abc', -1)).toBeNull();
    expect(completionWord('abc', 4)).toBeNull();
  });

  it('数と閉じ括弧の後は長さの単位を補い、同じ綴りの係数と区別する', () => {
    for (const source of ['25.4M', '（２＋３） m']) {
      const { candidates } = complete(source, source.length, [parameter('mm')]);
      expect(candidates).toEqual([{ name: 'mm', detail: '', call: false }]);
    }
    expect(complete('2I').candidates[0].name).toBe('in');
    expect(complete('2"').candidates[0].name).toBe('"');
    expect(complete('p2 m').word.unitSuffix).toBe(false);
    expect(complete('m', 1, [parameter('mm')]).candidates[0].detail).toBe('3');
    expect(complete('pi').candidates[0]).toEqual({ name: 'pi', detail: '', call: false });
    expect(complete('π').candidates[0].name).toBe('π');
  });

  it('評価できた係数を文書順に出した後に関数を出し、最大8件にする', () => {
    const params = [parameter('ax', 'degree'), parameter('a', 'mm')];
    expect(complete('a', 1, params).candidates).toEqual([
      { name: 'ax', detail: '3°', call: false }, { name: 'a', detail: '3 mm', call: false },
      { name: 'abs', detail: '', call: true },
    ]);
    const names = Array.from({ length: 10 }, (_, i) => 'a' + String(i));
    expect(complete('a', 1, names.map(name => parameter(name))).candidates.map(c => c.name)).toEqual(names.slice(0, 8));
    const { word, candidates } = complete('1+a+4', 3, params);
    expect(insertCompletion('1+a+4', word, candidates[0])).toEqual({ source: '1+ax+4', caret: 4 });
    expect(expressionCandidates(word, params, new Map()).map(c => c.name)).toEqual(['abs']);
  });

  it('閉じた一覧と未選択の Enter は親へ通し、選択・巡回・受け入れ・閉じるを区別する', () => {
    for (const key of ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'x']) {
      expect(completionKey(key, 0, -1)).toEqual({ kind: 'pass' });
    }
    expect(completionKey('Enter', 2, -1)).toEqual({ kind: 'pass' });
    for (const [key, from, index] of [
      ['ArrowDown', -1, 0], ['ArrowDown', 0, 1], ['ArrowDown', 1, 0],
      ['ArrowUp', -1, 1], ['ArrowUp', 1, 0], ['ArrowUp', 0, 1],
    ] as const) expect(completionKey(key, 2, from)).toEqual({ kind: 'select', index });
    expect(completionKey('Enter', 2, 1)).toEqual({ kind: 'accept', index: 1 });
    for (const index of [-1, 1]) {
      expect(completionKey('Escape', 2, index)).toEqual({ kind: 'close' });
      for (const key of ['Tab', 'ArrowLeft', 'x']) expect(completionKey(key, 2, index)).toEqual({ kind: 'pass' });
    }
  });
});

describe('式の理由とヒント', () => {
  const error: ExpressionError = { code: 'unexpectedTrailing', message: '理由。', position: 1 };
  it('理由をそのまま先頭に残し、各鍵の値と候補を表示する', () => {
    expect(expressionErrorText(error)).toBe('理由。');
    expect(expressionErrorText({ ...error, suggestions: [] })).toBe('理由。');
    expect(expressionErrorText({ ...error, suggestions: ['a', 'ab'] })).toBe('理由。 もしかして: a、ab');
    expect(expressionErrorText({ ...error, hint: { key: 'explicitMultiplication', numberText: '2', name: '板厚' } }))
      .toBe('理由。 掛け算は * で書きます(2*板厚)');
    expect(expressionErrorText({ ...error, hint: { key: 'supportedFunctions', names: ['sqrt', 'root'] }, suggestions: ['sqrt'] }))
      .toBe('理由。 この欄で使える関数は sqrt・root もしかして: sqrt');
  });
});
