import { describe, expect, it } from 'vitest';
import { decodeMathJson } from './decodeMathJson.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';

/**
 * MC-30b: totaldifferentialat(Function(f, x1, ..., xn), point, increments) declares the
 * Cartesian coordinates of a point, exactly like gradient-at. Structural (LaTeX) input can
 * express f's multiplications with the ambiguous "×"/"·" tokens, so decodeMathJson must treat
 * every variable that Function binds there as a scalar for product-type resolution — the same
 * treatment gradient-at/divergence-at/... already give their own Function operand. A Function
 * used outside such a calculus context still permits vector arguments and stays untyped.
 */
const names = { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] };
const options = { names, operations: CANDIDATE_MATH_OPERATIONS, allowRenderedProducts: true };

describe('全微分のFunctionが束縛する変数を積の型判定でスカラーとして扱う', () => {
  it('MC-30が報告した例（×トークン、変数順y,x、べき乗との積）を掛け算として読む', () => {
    const fn = ['Function', ['PcadTimesToken', ['Power', 'x', 2], 'y'], 'y', 'x'];
    const node = decodeMathJson(['TotalDifferentialAt', fn, ['List', 3, 2], ['List', 1, 1]], options);
    expect(node).toMatchObject({ kind: 'operation', operation: 'total-differential-at', operands: [
      { kind: 'binder', operation: 'lambda', body: { operation: 'multiply' } },
      { operation: 'list' }, { operation: 'list' },
    ] });
  });

  it('束縛した2変数どうしの·トークンも掛け算として読む', () => {
    const fn = ['Function', ['PcadDotToken', 'x', 'y'], 'x', 'y'];
    const node = decodeMathJson(['TotalDifferentialAt', fn, ['List', 1, 2], ['List', 1, 1]], options);
    if (node.kind !== 'operation') throw new Error('演算ではありません。');
    expect(node.operands[0]).toMatchObject({ body: { operation: 'multiply' } });
  });

  it('べき乗を含む3変数の入れ子の積も、全て束縛変数をスカラーとして解決する', () => {
    const fn = ['Function',
      ['PcadTimesToken', ['PcadTimesToken', ['Power', 'x', 3], ['Power', 'y', 2]], 'z'], 'x', 'y', 'z'];
    const node = decodeMathJson(['TotalDifferentialAt', fn, ['List', 1, 1, 1], ['List', 1, 1, 1]], options);
    if (node.kind !== 'operation') throw new Error('演算ではありません。');
    expect(node.operands[0]).toMatchObject({ body: { operation: 'multiply' } });
  });

  it('1変数の自乗（×トークン）も掛け算として読む', () => {
    const fn = ['Function', ['PcadTimesToken', 'x', 'x'], 'x'];
    const node = decodeMathJson(['TotalDifferentialAt', fn, ['List', 2], ['List', 1]], options);
    if (node.kind !== 'operation') throw new Error('演算ではありません。');
    expect(node.operands[0]).toMatchObject({ body: { operation: 'multiply' } });
  });

  it('全微分と無関係な一般のFunctionの引数は、従来どおりスカラーと推測しない', () => {
    // Same shape as the MC-30 example, but not wrapped by total-differential-at (or any other
    // calculus operation): the pre-existing "generic lambda permits vector arguments" default
    // must still reject an ambiguous ×/· without a declared or vector-typed operand.
    const fn = ['Function', ['PcadTimesToken', 'a', 'b'], 'a', 'b'];
    expect(() => decodeMathJson(fn, options)).toThrow('掛け算／外積');
  });

  it('全微分の兄弟演算（gradient-at）の束縛変数の積は従来どおり掛け算のまま', () => {
    // gradient-at already forced its Function's bound variables to scalar before this fix;
    // the new total-differential-at branch must not change that sibling's behaviour.
    const fn = ['Function', ['PcadDotToken', 'x', 'y'], 'x', 'y'];
    const node = decodeMathJson(['GradientAt', fn, ['List', 1, 2]], options);
    expect(node).toMatchObject({ operation: 'gradient-at', operands: [
      { body: { operation: 'multiply' } }, { operation: 'list' },
    ] });
  });
});
