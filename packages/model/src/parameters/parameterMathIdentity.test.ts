import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { ensureParameterMathIds } from './parameterMathIdentity.js';
import { addParameter, renameParameter, reorderParameters, replaceParameter } from './parameterTable.js';
import type { Parameter } from './types.js';

function row(name: string, mathId?: string): Parameter {
  return { name, value: expressionValueFromNumber(3), unit: 'mm', description: '', ...(mathId === undefined ? {} : { mathId }) };
}
describe('数式の係数は改名や行移動で参照先が変わらない', () => {
  it('旧式だけの追加は既存の保存データを変更しない', () => {
    const first = row('sin'), second = row('log');
    expect(addParameter([first], second)).toEqual([first, second]);
    expect(first).not.toHaveProperty('mathId');
  });
  it('初回の数式適用用に決定的なIDを作り、元の表を変更しない', () => {
    const original = [row('sin'), row('log', 'coefficient:8'), row('X')];
    const assigned = ensureParameterMathIds(original);
    expect(assigned.map(value => value.mathId)).toEqual(['coefficient:9', 'coefficient:8', 'coefficient:10']);
    expect(ensureParameterMathIds(assigned)).toBe(assigned);
    expect(original[0]).not.toHaveProperty('mathId');
  });
  it('改名・並べ替え・値の編集で同じIDを維持する', () => {
    const original = ensureParameterMathIds([row('sin'), row('log')]);
    const renamed = renameParameter(original, 'sin', '新名');
    const moved = reorderParameters(renamed, 0, 1);
    const edited = replaceParameter(moved, '新名', row('新名', 'foreign-id'));
    expect(edited.find(value => value.name === '新名')?.mathId).toBe(original[0].mathId);
    expect(edited.find(value => value.name === 'log')?.mathId).toBe(original[1].mathId);
  });
  it('数式を使う表への新規追加にも重複しない参照を付ける', () => {
    const assigned = ensureParameterMathIds([row('A')]);
    expect(addParameter(assigned, row('B')).map(value => value.mathId)).toEqual(['coefficient:1', 'coefficient:2']);
  });
  it.each(['', 'a\nb', 'x'.repeat(129), 'coefficient:9007199254740992'])('不正なID %jを受け継がない', mathId => {
    expect(() => ensureParameterMathIds([row('A', mathId)])).toThrow();
  });
  it('名前が異なっても同じIDの2行を拒否する', () => {
    expect(() => ensureParameterMathIds([row('A', 'same'), row('B', 'same')])).toThrow();
  });
});
