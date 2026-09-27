import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { INFINITE_CARDINALITY_MESSAGE, interpretAbsoluteValues, NON_SQUARE_ABSOLUTE_MESSAGE, planMathCandidates } from './absoluteValueCandidates.js';
import { createMathBackend } from './createMathBackend.js';
import { rationalOfExpression } from './exactRational.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { formatMathText } from './formatMathText.js';
import type { MathDeclaration } from './mathDeclarations.js';
import { coordinateFromMath, MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { mathScalarExpression } from './mathScalarExpression.js';
import { parseMathText } from './mathTextSyntax.js';
import { executeMathWorkRequest, type MathExecutionReply } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

const names = { axes: new Set<never>(), parameters: new Set<never>(), coefficients: [],
  declared: [{ role: 'declared' as const, id: 'a', label: 'a' }] };
const text = (source: string): MathNode => parseMathText(source, { names, operations: CANDIDATE_MATH_OPERATIONS });
const shown = (node: MathNode): string => formatMathText(node, CANDIDATE_MATH_BY_ID);
const readings = (source: string): readonly string[] | null => interpretAbsoluteValues(text(source), 'radian')?.map(shown) ?? null;
/** Expected formulas are written as a user types them and compared in the saved structure. */
const formulas = (...sources: readonly string[]): readonly string[] => sources.map(source => shown(text(source)));
function problem(action: () => unknown): MathInputProblem {
  try { action(); } catch (error) {
    if (error instanceof MathInputProblem) return error;
    throw error;
  }
  throw new Error('例外が発生しませんでした。');
}

describe('|x| の読み方を被演算子の型から決める（計算部なし）', () => {
  it.each(['|-3|', 'abs(3+4*i)', '|2/3|', '|a|', '|sin(1)|', '|sum(k,k,1,3)|', '|2*3|', '|[[1,2],[3]]|', '|true|'])(
    '%s は型が値の配列・行列・集合に決まらないため、従来の絶対値のまま同じ式を計算する', source => {
      const expression = text(source);
      expect(interpretAbsoluteValues(expression, 'radian')).toBeNull();
      const plan = planMathCandidates(expression, 'radian', true);
      expect(plan.expression).toBe(expression);
      expect(plan).toMatchObject({ candidates: null, rewritten: false });
    });
  it.each([
    ['|[3,4]|', 'norm([3,4])'], ['abs([1,2,2])', 'norm([1,2,2])'], ['|cross([1,0,0],[0,1,0])|', 'norm(cross([1,0,0],[0,1,0]))'],
    ['|{1,2}|', 'cardinality({1,2})'], ['|union({1},{2})|', 'cardinality(union({1},{2}))'],
    ['|[3,4]|+|{5}|', 'norm([3,4])+cardinality({5})'], ['sum(|[k,1]|,k,1,2)', 'sum(norm([k,1]),k,1,2)'],
  ])('%s はベクトルなら長さ、集合なら要素数の1通りに読み、候補にしない', (source, expected) => {
    expect(readings(source)).toEqual(formulas(expected));
    expect(planMathCandidates(text(source), 'radian', true)).toMatchObject({ candidates: null, rewritten: true });
  });
  it.each(['|ℕ|', '|interval(0,1)|', '|interval(open(0),∞)|', 'cardinality(union({1},interval(0,1)))', '0*|ℝ|'])(
    '%s は無限集合なので、要素数を計算する前に理由と書き方を示して断る', source => {
      expect(readings(source)?.length ?? 0).toBeLessThanOrEqual(1);
      const rejected = problem(() => planMathCandidates(text(source), 'radian', true));
      expect([rejected.code, rejected.message]).toEqual(['domain', INFINITE_CARDINALITY_MESSAGE]);
    });
  it.each(['|interval(0,0)|', '|interval(1,0)|', '|intersection(ℤ,interval(0,3))|', '|setminus(ℝ,ℤ)|'])(
    '%s は有限か、有限かどうかを計算部が確かめる集合なので、計算前には断らない', source => {
      expect(planMathCandidates(text(source), 'radian', true)).toMatchObject({ candidates: null, rewritten: true });
    });
  it.each([
    ['|[[1,2],[3,4]]|', ['det([[1,2],[3,4]])', 'norm([1,2,3,4])']],
    ['|[[1,2],[3,4]]|+|[[5]]|', ['det([[1,2],[3,4]])+det([[5]])', 'norm([1,2,3,4])+norm([5])']],
    ['|identitymatrix(2)|', ['det(identitymatrix(2))',
      'norm([component(identitymatrix(2),1,1),component(identitymatrix(2),1,2),component(identitymatrix(2),2,1),component(identitymatrix(2),2,2)])']],
    ['|transpose([[1,2],[3,4]])|', ['det(transpose([[1,2],[3,4]]))',
      'norm([component(transpose([[1,2],[3,4]]),1,1),component(transpose([[1,2],[3,4]]),1,2),component(transpose([[1,2],[3,4]]),2,1),component(transpose([[1,2],[3,4]]),2,2)])']],
  ] as const)('%s は正方行列なので、式の中の全ての行列を同じ読み方にした行列式とノルムの2候補にする', (source, expected) => {
    expect(readings(source)).toEqual(formulas(...expected));
    const plan = planMathCandidates(text(source), 'radian', true);
    expect(plan.candidates?.map(shown)).toEqual(formulas(...expected));
  });
  it.each(['|[[1,2,3],[4,5,6]]|', '|[[1,2],[3,4]]|+|[[1,2]]|', '|zeromatrix(2,3)|', '|transpose([[1,2,3]])|'])(
    '%s は正方でない行列を含むため、行列式にできない理由と明示の書き方を示して断る', source => {
      const rejected = problem(() => interpretAbsoluteValues(text(source), 'radian'));
      expect([rejected.code, rejected.message]).toEqual(['domain', NON_SQUARE_ABSOLUTE_MESSAGE]);
    });
  it('選ばれない場合分けの枝の行列は候補にも拒否にもせず、未確定の条件は従来の計算に任せる', () => {
    expect(readings('which(1<2,5,true,|[[1,2],[3,4]]|)')).toEqual(formulas('5'));
    expect(readings('which(1<2,5,true,|[[1,2,3]]|)')).toEqual(formulas('5'));
    expect(readings('which(a>0,|[[1,2],[3,4]]|,true,0)')).toBeNull();
    expect(readings('which(a>0,|[[1,2],[3,4]]|,true,|[3,4]|)')).toEqual(formulas('which(a>0,|[[1,2],[3,4]]|,true,norm([3,4]))'));
  });
  it('行列の読み方と±・∓の符号は、読み方ごとに符号の候補を並べ、合計32候補までにする', () => {
    expect(planMathCandidates(text('|[[1,2],[3,4]]|±1'), 'radian', true).candidates?.map(shown))
      .toEqual(formulas('det([[1,2],[3,4]])+1', 'det([[1,2],[3,4]])-1', 'norm([1,2,3,4])+1', 'norm([1,2,3,4])-1'));
    expect(planMathCandidates(text('|[[1,2],[3,4]]|+(±1)+(±1)+(±1)+(±1)'), 'radian', true).candidates).toHaveLength(32);
    const tooMany = problem(() => planMathCandidates(text('|[[1,2],[3,4]]|+(±1)+(±1)+(±1)+(±1)+(±1)'), 'radian', true));
    expect(tooMany.code).toBe('budget');
  });
  it('関数の式では |x| を書いたとおりの絶対値に保つ', () => {
    const expression = text('|[3,4]|+|[[1,2],[3,4]]|');
    const plan = planMathCandidates(expression, 'radian', false);
    expect(plan.expression).toBe(expression);
    expect(plan).toMatchObject({ candidates: null, rewritten: false });
  });
});

type Expected = { readonly value: number } | { readonly candidates: readonly number[] } | { readonly detail: string };
type Example = { readonly source: string; readonly notation?: 'latex'; readonly declaration?: MathDeclaration } & Expected;
const declared = (type: MathDeclaration['type'], valueSource: string): MathDeclaration =>
  ({ id: 'a', label: 'a', meaning: '確認用の値', type, valueSource });
const MATRIX = [-2, Math.sqrt(30)] as const;
const examples: readonly Example[] = [
  { source: '|-3|', value: 3 }, { source: 'abs(-3)', value: 3 }, { source: '|3+4*i|', value: 5 },
  { source: '|a|', declaration: declared('complex', '3+4*i'), value: 5 },
  { source: '|[3,4]|', value: 5 }, { source: 'abs([1,2,2])', value: 3 }, { source: '2*|[3,4]|', value: 10 },
  { source: '|[3,4]|+|{1,2}|', value: 7 }, { source: '|a|', declaration: declared('vector', '[3,4]'), value: 5 },
  { source: String.raw`\left|\left[3,4\right]\right|`, notation: 'latex', value: 5 },
  { source: '|[[1,2],[3,4]]|', candidates: MATRIX }, { source: 'abs([[1,2],[3,4]])', candidates: MATRIX },
  { source: String.raw`\left|\begin{pmatrix}1&2\\3&4\end{pmatrix}\right|`, notation: 'latex', candidates: MATRIX },
  { source: '|a|', declaration: declared('matrix', '[[1,2],[3,4]]'), candidates: MATRIX },
  { source: '|[[1,2],[3,4]]|+1', candidates: [-1, Math.sqrt(30) + 1] },
  { source: '0*|[[1,2],[3,4]]|', candidates: [0, 0] },
  { source: 'component([|[[1,2],[3,4]]|,7],2)', candidates: [7, 7] },
  { source: '|[[2]]|', candidates: [2, 2] },
  { source: '|[[1,2],[3,4]]|±1', candidates: [-1, -3, Math.sqrt(30) + 1, Math.sqrt(30) - 1] },
  { source: '|[[1,2,3],[4,5,6]]|', detail: NON_SQUARE_ABSOLUTE_MESSAGE },
  { source: 'which(1<2,5,true,|[[1,2,3]]|)', value: 5 },
  { source: 'det([[1,2],[3,4]])', value: -2 }, { source: 'norm([1,2,3,4])', value: Math.sqrt(30) },
];

const script = fileURLToPath(new URL('./exactRuntime/cas_cardinality_test.py', import.meta.url));
const backend = createMathBackend();
const engine = sharedExactEngine(exactRuntimeBatch(script, 60_000));
const options = { backend, engine, shouldStop: () => undefined };
function request(example: Example): MathWorkRequest {
  return { identity: { documentId: 'absolute-value', documentVersion: 1, editorId: 'value', inputRevision: 1 },
    source: example.source, notation: example.notation ?? 'text', angleUnit: 'radian', coefficients: [],
    ...(example.declaration === undefined ? {} : { declarations: [example.declaration] }) };
}
const context = (input: MathWorkRequest) => ({ operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(),
  declaredIds: new Set(input.declarations?.map(value => value.id)) });
/** Each candidate is a value on its own: evaluate its formula independently in the scalar calculation. */
function numbers(evaluation: MathEvaluation): readonly number[] {
  if (evaluation.status !== 'multiple') throw new Error(JSON.stringify(evaluation));
  return evaluation.candidates.map(candidate => {
    const exact = rationalOfExpression(candidate);
    if (exact !== null) return Number(exact.numerator) / Number(exact.denominator);
    const input: MathWorkRequest = { ...request({ source: formatMathText(candidate, CANDIDATE_MATH_BY_ID), value: 0 }) };
    return coordinateFromMath(decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(9, input), backend), input,
      context(input)).result.evaluation);
  });
}
let replies: readonly MathExecutionReply[];
let restored: readonly MathExecutionReply[];

beforeAll(async () => {
  replies = await Promise.all(examples.map(example => executeExactMathWorkRequest(createMathWorkEnvelope(1, request(example)), options)));
  restored = await Promise.all(replies.map((reply, index) => {
    const input = request(examples[index]);
    const { definition } = decodeMathWorkReply(reply, input, context(input)).result;
    if (definition === null) return Promise.resolve(reply);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...input, definition })));
    return executeExactMathWorkRequest(saved, options);
  }));
}, 180_000);

describe('|x| を実計算し、行列の候補は選ぶまで座標・成分・係数に使わない', () => {
  it.each(examples)('$source', example => {
    const index = examples.indexOf(example), input = request(example);
    const result = decodeMathWorkReply(replies[index], input, context(input)).result;
    // The saved formula keeps |x| as written; its reading follows the operand again when reopened.
    expect(result.definition?.source).toBe(example.source);
    expect(decodeMathWorkReply(restored[index], input, context(input)).result).toEqual(result);
    if ('value' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      expect(coordinateFromMath(result.evaluation)).toBeCloseTo(example.value, 12);
      return;
    }
    expect(() => coordinateFromMath(result.evaluation)).toThrow();
    expect(mathScalarExpression(result).ok).toBe(false);
    if ('detail' in example) {
      expect(result.evaluation).toEqual({ status: 'invalid', reason: 'domain', detail: example.detail });
      return;
    }
    expect(result.evaluation).toMatchObject({ status: 'multiple', exhaustive: true });
    const values = numbers(result.evaluation);
    expect(values).toHaveLength(example.candidates.length);
    values.forEach((value, at) => { expect(value).toBeCloseTo(example.candidates[at], 12); });
  });
});
