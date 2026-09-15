import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { normalizeTensorOperation } from './tensorOperations.js';
import { coordinateFromMath, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'tensor', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  return decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}
const number = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const list = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });
const operation = (name: string, ...operands: readonly MathNode[]): Extract<MathNode, { kind: 'operation' }> =>
  ({ kind: 'operation', operation: name, operands });
const vector = (...values: readonly number[]): MathNode => list(values.map(number));
function plain(node: MathNode): unknown {
  const rational = rationalOfExpression(node);
  if (rational !== null) return Number(rational.numerator) / Number(rational.denominator);
  if (node.kind === 'operation' && node.operation === 'list') return node.operands.map(plain);
  return node;
}

describe('テンソルの軸・縮約・成分を明示し、数値1つだけを座標へ渡す', () => {
  it('2×3と2の外積を2×3×2で保持し、入力の配列を書き換えない', () => {
    const input = operation('tensor-product', list([vector(1,2,3), vector(4,5,6)]), vector(2,-1));
    const before = JSON.stringify(input), result = normalizeTensorOperation(input);
    expect(plain(result)).toEqual([[[2,-1],[4,-2],[6,-3]],[[8,-4],[10,-5],[12,-6]]]);
    expect(JSON.stringify(input)).toBe(before);
    expect(plain(normalizeTensorOperation(operation('tensor-shape', result)))).toEqual([2,3,2]);
  });
  it('第1・第3軸の対角和を取り、第2軸の3成分を残す', () => {
    const data = list([list([vector(1,2), vector(3,4), vector(5,6)]),
      list([vector(7,8), vector(9,10), vector(11,12)])]);
    expect(plain(normalizeTensorOperation(operation('tensor-contract', data, number(1), number(3))))).toEqual([9,13,17]);
    expect(plain(normalizeTensorOperation(operation('tensor-contract', data, number(3), number(1))))).toEqual([9,13,17]);
    const reordered = normalizeTensorOperation(operation('tensor-permute', data, vector(3,1,2)));
    expect(plain(reordered)).toEqual([[[1,3,5],[7,9,11]],[[2,4,6],[8,10,12]]]);
    expect(plain(normalizeTensorOperation(operation('tensor-permute', reordered, vector(2,3,1))))).toEqual(plain(data));
  });
  it.each([
    ['tensorelement(tensorproduct([1,2],[3,4]),[2,1])', 6],
    ['tensorelement([1,2] ⊗ [3,4],[2,1])', 6],
    ['tensorelement([1,2] ⊙ [3,4],[2])', 8],
    ['tensorelement(hadamardproduct([[1,2],[3,4]],[[2,3],[4,5]]),[2,2])', 20],
    ['tensorcontract([[1,2],[3,4]],1,2)', 5],
    ['2*tensorcontract([[1,2],[3,4]],1,2)', 10],
    ['2*tensorelement([1/3,2/3],[2])', 4/3],
    ['2*component(tensorshape([[[1,2],[3,4]]]),2)', 4],
    ['tensorelement(tensorpermute([[[1,2],[3,4]],[[5,6],[7,8]]],[3,1,2]),[2,1,2])', 4],
    ['kroneckerdelta(2,2)+levicivita([2,3,1])', 2],
    ['levicivita([1,3,2])', -1],
    ['levicivita([1,1,2])', 0],
    ['kroneckerdelta(2,3)', 0],
  ] as const)('%sの成分を実計算・表示変換・返信検証から座標へつなぐ', (source, expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
    expect(coordinateFromMath(result.evaluation)).toBeCloseTo(expected, 12);
    expect(result.presentation).not.toBeNull();
  });
  it('πの成分は分数へ丸めず、複素成分は実数として黙って採用しない', () => {
    expect(coordinateFromMath(evaluate('tensorelement([pi,2*pi],[2])').evaluation)).toBeCloseTo(2*Math.PI, 12);
    const complex = evaluate('tensorelement([1+i,2],[1])').evaluation;
    expect(complex).toMatchObject({ status: 'value', kind: 'complex' });
    expect(() => coordinateFromMath(complex)).toThrow();
  });
  it.each([
    ['tensorproduct([[1,2],[3,4]],[5,6])', 'tensor'],
    ['tensorproduct([1,2],[3,4])', 'matrix'],
    ['tensorshape([[[1,2,3]],[[4,5,6]]])', 'vector'],
  ])('%sの結果の種類を保持して、配列を座標1つとして採用しない', (source, kind) => {
    const result = evaluate(source).evaluation;
    expect(result).toMatchObject({ status: 'value', kind });
    expect(() => coordinateFromMath(result)).toThrow();
  });
  it.each([
    'tensorcontract([[1,2],[3,4]],1,1)', 'tensorcontract([[1,2,3],[4,5,6]],1,2)',
    'tensorpermute([[1,2],[3,4]],[1,1])', 'tensorpermute([[1,2],[3,4]],[2,3])',
    'hadamardproduct([[1,2],[3,4]],[1,2])', 'tensorproduct([[1],[2,3]],[1,2])',
    'tensorelement([[1,2],[3,4]],[1])', 'tensorelement([1,2],[0])',
    'tensorelement([1,2],[3])', 'tensorelement([1,2],[1.00000000000000001])',
    'tensorelement([true],[1])', 'tensorelement([1<2],[1])',
    'tensorelement([1/0],[1])', 'tensorelement([∞],[1])',
    'levicivita([0,1,2])', 'kroneckerdelta(1.5,1.5)',
  ])('%sの不正な形・添字・成分を拒否する', source => {
    const result = evaluate(source).evaluation;
    expect(result.status).toBe('invalid');
    expect(() => coordinateFromMath(result)).toThrow();
  });
  it.each(['tensorelement([1<2],[1])', 'tensorelement([true],[1])', 'tensorelement([1,2],[3])']) (
    '0*%sでも元入力の誤りを消さない', source => {
      expect(evaluate(`0*${source}`).evaluation.status).toBe('invalid');
    });
  it('小さい入力から上限を超える外積を確保せずに拒否する', () => {
    const input = operation('tensor-product', vector(...Array.from({ length: 64 }, (_, i) => i)),
      vector(...Array.from({ length: 64 }, (_, i) => i)));
    expect(() => normalizeTensorOperation(input)).toThrow(expect.objectContaining({ code: 'budget' }));
  });
  it('成分の式の深さも加え、出力の深さ上限を越える積を拒否する', () => {
    let scalar: MathNode = number(1);
    for (let i = 0; i < 62; i += 1) scalar = operation('negate', scalar);
    const input = operation('tensor-product', list([scalar]), vector(1));
    expect(() => normalizeTensorOperation(input)).toThrow(expect.objectContaining({ code: 'budget' }));
  });
});
