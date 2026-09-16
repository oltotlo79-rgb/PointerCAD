import { describe, expect, it } from 'vitest';
import type { MathEvaluation, MathNode } from '@pointercad/expression/math/contracts';
import { chooseMathResultComponent, mathResultAxes } from './mathResultComponent.js';

const n = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const list = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });
const vector: MathEvaluation = { status: 'value', kind: 'vector', expression: list([n(2),n(4),n(6)]) };
const matrix: MathEvaluation = { status: 'value', kind: 'matrix', expression: list([list([n(1),n(2)]),list([n(3),n(4)])]) };

describe('計算結果の成分選択は元の式を保ち、全ての添字を利用者に選ばせる', () => {
  it('ベクトル・行列・3次テンソルの軸と成分数を区別する', () => {
    expect(mathResultAxes(vector)).toEqual([3]); expect(mathResultAxes(matrix)).toEqual([2,2]);
    expect(mathResultAxes({ status: 'value', kind: 'tensor', expression: list([matrix.expression,matrix.expression]) })).toEqual([2,2,2]);
  });
  it.each([[],[0],[1.5],[4],[1,2]].map(indices => [indices] as const))('添字%sが未指定・不足・範囲外なら式を変更しない', indices => {
    expect(chooseMathResultComponent({ source: '[2,4,6]', notation: 'text' },vector,indices)).toBeNull();
  });
  it('表示用の計算結果を貼らずに、係数を含む原式へ成分指定を追加する', () => {
    const input = { source: 'tensorproduct([coef("X"),2],[3,4])', notation: 'text' as const };
    expect(chooseMathResultComponent(input,matrix,[2,1])).toBe('tensorelement(tensorproduct([coef("X"),2],[3,4]),[2,1])');
    expect(input.source).toBe('tensorproduct([coef("X"),2],[3,4])');
  });
  it('構造入力の係数と添字も元のLaTeXを維持する', () => {
    const source = String.raw`\operatorname{tensorproduct}\left([1,2],[3,4]\right)`;
    expect(chooseMathResultComponent({ source, notation: 'latex' },matrix,[2,1])).toBe(
      String.raw`\operatorname{tensorelement}\left(` + source + String.raw`,[2,1]\right)`);
  });
  it('空配列・形の違い・種類の不整合・非配列の結果は選択肢にしない', () => {
    for (const result of [
      { status: 'value', kind: 'vector', expression: list([]) },
      { status: 'value', kind: 'matrix', expression: list([list([n(1)]),list([n(2),n(3)])]) },
      { status: 'value', kind: 'tensor', expression: vector.expression },
      { status: 'value', kind: 'boolean', expression: { kind: 'constant', name: 'true' } },
      { status: 'stopped', reason: 'cancelled' },
    ] as const) expect(mathResultAxes(result)).toBeNull();
  });
  it('添字を足して入力上限を越える場合は元の式を維持する', () => {
    expect(chooseMathResultComponent({ source: ' '.repeat(16384), notation: 'text' },vector,[1])).toBeNull();
  });
});
