import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { exactEigenspace } from './exactEigenspace.js';
import { ExactQuadraticField } from './exactQuadraticField.js';
import { rationalOfExpression } from './exactRational.js';
import type { MathNode } from './mathInputContract.js';
import { displayMathJson } from './mathNotationConversion.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const n = (value: number | string): MathNode => ({ kind: 'number', decimal: String(value) });
const op = (operation: string, ...operands: MathNode[]): MathNode => ({ kind: 'operation', operation, operands });
const rows = (values: readonly (readonly number[])[]) => values.map(row => row.map(value => ({ numerator: BigInt(value), denominator: 1n })));
function plain(node: MathNode): unknown {
  const value = rationalOfExpression(node);
  if (value !== null) return Number(value.numerator) / Number(value.denominator);
  if (node.kind === 'operation' && node.operation === 'list') return node.operands.map(plain);
  return node;
}
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'eigenspace', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const result = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(result, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}

describe('固有値を明示した固有空間の基底を厳密に求める', () => {
  it.each([
    [[[2,1,0],[0,2,1],[0,0,2]], 2, [[1,0,0]]],
    [[[2,0,0],[0,2,0],[0,0,3]], 2, [[1,0,0],[0,1,0]]],
    [[[0,0],[0,0]], 0, [[1,0],[0,1]]],
    [[[2,1],[0,3]], 3, [[1,1]]],
    [[[2,1],[0,3]], 5, []],
  ] as const)('重複・欠損を持つ行列の自由な方向を全て返す: %j', (input, lambda, expected) => {
    const source = rows(input), before = source.map(row => [...row]);
    expect(plain(exactEigenspace(source, n(lambda)))).toEqual(expected);
    expect(source).toEqual(before);
  });
  it('小さな非零を0へ丸めず、固有値ではないことを空の基底として示す', () => {
    expect(plain(exactEigenspace(rows([[2,0],[0,2]]), n('2.000000000000000000000000000001')))).toEqual([]);
  });
  it.each([
    ['component(eigenspace([[2,1],[0,2]],2),1,1)', 1],
    ['Im(component(eigenspace([[0,-1],[1,0]],i),1,1))', 1],
    ['Re(component(eigenspace([[0,-1],[1,0]],i),1,1))', 0],
    ['component(eigenspace([[1,1],[1,0]],(1+sqrt(5))/2),1,1)', (1 + Math.sqrt(5)) / 2],
    ['component(eigenspace([[0,2],[1,0]],sqrt(8)/2),1,1)^2', 2],
    ['component(eigenspace([[0,0],[0,0]],sqrt(8)/2-sqrt(2)),2,2)', 1],
  ] as const)('%sを表示変換・返信検証してから座標へ利用する', (source, expected) => {
    const result = evaluate(source);
    if (result.evaluation.status !== 'value' && result.definition !== null && result.definition !== undefined) {
      const notation = backend.serializeLatex(displayMathJson(result.definition.expression, CANDIDATE_MATH_BY_ID));
      throw new Error(JSON.stringify({ evaluation: result.evaluation, notation, parsed: backend.parseLatex(notation) }));
    }
    expect(result.evaluation, JSON.stringify(result.evaluation)).toMatchObject({ status: 'value', kind: 'real' });
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error('実数の座標が必要です');
    expect(result.evaluation.coordinate).toBeCloseTo(expected, 12);
    expect(result.presentation).not.toBeNull();
  });
  it.each(['eigenspace([[1,2,3],[4,5,6]],1)', 'eigenspace([[1,2],[3,4]],1/0)',
    'eigenspace([[1,2],[3,4]],pi)', 'eigenspace([[1,2],[3,4]],sqrt(2)+sqrt(3))'])(
    '%sの形違い・未対応を0倍で隠さない', source => {
    expect(evaluate(source).evaluation.status).toBe('invalid');
    expect(evaluate(`0*component(${source},1,1)`).evaluation.status).toBe('invalid');
  });
  it('16次を超える入力は計算前に断る', () => {
    expect(() => exactEigenspace(rows(Array.from({ length: 17 }, (_,i) => Array.from({ length: 17 }, (_,j) => i === j ? 1 : 0))), n(1))).toThrow(/16/);
  });
});

describe('二次代数体での零と分母の判定', () => {
  it('複素数の主平方根を保ち、共役による除算の恒等式を満たす', () => {
    const field = new ExactQuadraticField(), a = field.read(op('add', n(3), op('sqrt', n(-4))));
    expect(plain(field.node(field.multiply(a, field.divide(field.one, a))))).toBe(1);
    expect(plain(field.node(field.multiply(field.read(op('sqrt', n(-4))), field.read(op('sqrt', n(-4))))))).toBe(-4);
  });
  it('異なる表記の同じ平方根が厳密に相殺し、0による除算を断る', () => {
    const field = new ExactQuadraticField();
    const zero = field.read(op('subtract', op('sqrt', n(8)), op('multiply', n(2), op('sqrt', n(2)))));
    expect(field.isZero(zero)).toBe(true);
    expect(() => field.divide(field.one, zero)).toThrow(/0/);
  });
});
