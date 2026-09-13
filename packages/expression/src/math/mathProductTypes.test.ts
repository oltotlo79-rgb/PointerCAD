import { describe, expect, it } from 'vitest';
import { decodeMathJson } from './decodeMathJson.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
const names = { axes: new Set<never>(), parameters: new Set<never>(), declared: [],
  coefficients: [{ role: 'coefficient' as const, id: 'scalar', label: 'X' }] };
const options = { names, operations: CANDIDATE_MATH_OPERATIONS, allowRenderedProducts: true };
describe('×と·は演算前の型と形から意味を決める', () => {
  it.each(['PcadDotToken', 'PcadTimesToken'])('%sの数同士は掛け算になる', token => {
    expect(decodeMathJson([token, 3, 4], options)).toMatchObject({ kind: 'operation', operation: 'multiply' });
  });
  it('係数名Xを座標軸として推測せず、宣言された実数型だけを使う', () => {
    const raw = ['PcadTimesToken', ['PcadCoefficient', { str: 'X' }], 4];
    expect(() => decodeMathJson(raw, options)).toThrow('掛け算／外積');
    expect(decodeMathJson(raw, { ...options, scalarCoefficientIds: new Set(['scalar']) }))
      .toMatchObject({ operation: 'multiply' });
  });
  it('同じ3成分のベクトルでも記号に応じて内積・外積を区別する', () => {
    const left = ['List', 1, 0, 0], right = ['List', 0, 1, 0];
    expect(decodeMathJson(['PcadDotToken', left, right], options)).toMatchObject({ operation: 'dot' });
    expect(decodeMathJson(['PcadTimesToken', left, right], options)).toMatchObject({ operation: 'cross' });
  });
  it('2次元外積・次元違い・行列・集合をスカラー積へ誤変換しない', () => {
    for (const raw of [
      ['PcadTimesToken', ['List', 1, 2], ['List', 3, 4]],
      ['PcadDotToken', ['List', 1, 2], ['List', 3, 4, 5]],
      ['PcadTimesToken', ['Matrix', ['List', ['List', 1, 2], ['List', 3, 4]]], 2],
      ['PcadTimesToken', ['Set', 1, 2], 2],
    ]) expect(() => decodeMathJson(raw, options)).toThrow();
  });
  it('統計量の実数と最頻値の一覧を、入力データの型から取り違えない',()=>{
    const values=['List',1,2,3];
    expect(decodeMathJson(['PcadTimesToken',['Mean',values],2],options)).toMatchObject({operation:'multiply'});
    expect(()=>decodeMathJson(['PcadTimesToken',['Modes',values],2],options)).toThrow();
  });
  it('利用者が選択を保留したnullを自動推定で上書きしない', () => {
    expect(() => decodeMathJson(['PcadTimesToken', 3, 4], { ...options, resolveProduct: () => null })).toThrow();
  });
  it('逆双曲線関数と成分から数を求める計算にも同じ掛け算の記号を使える', () => {
    const matrix = ['List', ['List', 1, 2], ['List', 3, 4]];
    const values = [
      ['Arsinh', 1], ['Arcosh', 2], ['Artanh', 0], ['Arccot', 1], ['Arcsec', 2], ['Arccsc', 2],
      ['Arcoth', 2], ['Arsech', 0.5], ['Arcsch', 1], ['Arctan2', 1, 1], ['Cis', 0],
      ['Reciprocal', 2], ['Clamp', 2, 0, 3], ['Permutations', 5, 2], ['Complex', 1, 2],
      ['Rank', matrix], ['Trace', matrix], ['Determinant', matrix], ['Norm', ['List', 3, 4]],
      ['Dot', ['List', 1, 2], ['List', 3, 4]],
    ];
    for (const token of ['PcadTimesToken', 'PcadDotToken']) for (const value of values) {
      expect(decodeMathJson([token, value, 2], options)).toMatchObject({ operation: 'multiply' });
    }
    expect(() => decodeMathJson(['PcadTimesToken', ['Arsinh', ['List', 1, 2]], 2], options)).toThrow();
  });
  it('行列の1添字は行、2添字は数として扱い、係数を掛ける時にも区別する', () => {
    const input = ['List', ['List', 1, 2], ['List', 3, 4]];
    for (const head of ['QrQ', 'QrR', 'LuP', 'LuL', 'LuU', 'RowReduce', 'NullSpace', 'ColumnSpace', 'RowSpace']) {
      expect(decodeMathJson(['PcadTimesToken', ['Component', [head, input], 1, 2], 10], options))
        .toMatchObject({ operation: 'multiply' });
      expect(() => decodeMathJson(['PcadTimesToken', ['Component', [head, input], 1], 10], options)).toThrow();
    }
    expect(decodeMathJson(['PcadDotToken', ['Component', input, 1], ['List', 1, 2]], options)).toMatchObject({ operation: 'dot' });
    expect(decodeMathJson(['PcadTimesToken', ['Component', ['LinearSolve', input, ['List', 1, 2]], 1], 10], options))
      .toMatchObject({ operation: 'multiply' });
  });
});
