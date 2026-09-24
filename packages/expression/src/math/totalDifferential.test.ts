import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { evaluateExactMathResult } from './evaluateExactMathResult.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { executeMathWorkRequest, type MathExecutionReply } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { parseMathText } from './mathTextSyntax.js';
import { prepareExactMathCalculation } from './prepareMathCalculation.js';
import { LOWERINGS } from './totalDifferential.js';

const names = { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] };
const parse = (source: string): MathNode => parseMathText(source, { names, operations: CANDIDATE_MATH_OPERATIONS });
function lower(source: string): MathNode {
  const node = parse(source);
  if (node.kind !== 'operation') throw new Error('全微分の演算がありません。');
  return LOWERINGS['total-differential-at'](node, 'radian');
}
const engine = sharedExactEngine(exactRuntimeBatch(
  fileURLToPath(new URL('./exactRuntime/cas_vector_calculus_test.py', import.meta.url)), 60_000));
const backend = createMathBackend();

const examples = [
  ['totaldifferentialat(Function(x^2+y^2,x,y),[1,2],[1/10,1/5])', 1],
  ['totaldifferentialat(Function(x^2*y,x,y),[2,3],[1/10,1/5])', 2],
  ['totaldifferentialat(Function(x^2*y,y,x),[3,2],[1/5,1/10])', 2],
  ['totaldifferentialat(Function(x^2*y,y,x),[3,2],[1/10,1/5])', 2.8],
  ['totaldifferentialat(Function(x^3,x),[2],[-1/4])', -3],
  ['totaldifferentialat(Function(x*y+z^2,x,y,z),[2,3,4],[1,-2,1/2])', 3],
  ['totaldifferentialat(Function(7,x,y),[2,3],[10,-20])', 0],
  ['totaldifferentialat(Function(x^2+y^2,x,y),[1,2],[0,0])', 0],
  ['totaldifferentialat(Function(ln(x),x),[2],[1/2])', 0.25],
  ['totaldifferentialat(Function(x^2,x),[2],[1])', 4],
] as const;
let evaluations: readonly MathEvaluation[];
beforeAll(async () => {
  evaluations = await Promise.all(examples.map(async ([source]) => {
    const expression = lower(source);
    const prepared = prepareExactMathCalculation(expression, { resolve: () => null, angleUnit: 'radian' });
    if (prepared.status !== 'ready') throw new Error(JSON.stringify(prepared));
    const raw = await engine.evaluate(prepared.expression, 'radian');
    return evaluateExactMathResult(raw, expression, { backend, angleUnit: 'radian', shouldStop: () => undefined,
      references: { coefficientIds: new Set(), declaredIds: new Set() }, resolve: () => null });
  }));
}, 90_000);

describe('全微分を、宣言順に指定位置の勾配と増分の積和へ置き換える', () => {
  it.each(examples)('%s の微分の値は %s（有限差分とは区別する）', (source, expected) => {
    const result = evaluations[examples.findIndex(example => example[0] === source)];
    expect(result).toMatchObject({ status: 'value', kind: 'real' });
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.coordinate).toBeCloseTo(expected, 12);
    expect(result.exact).not.toBeNull();
  });

  it.each([
    ['totaldifferentialat(1,[1],[1])', 'Function'],
    ['totaldifferentialat(Function(x,x),[1,2],[1])', '同じ順序・個数'],
    ['totaldifferentialat(Function(x+y,x,y),[1,2],[1])', '同じ順序・個数'],
    ['totaldifferentialat(Function(x,x),[1],[1,2])', '同じ順序・個数'],
    ['totaldifferentialat(Function(x,x),1,[1])', '一覧'],
    ['totaldifferentialat(Function(x,x),[1],1)', '一覧'],
    ['totaldifferentialat(Function(x,x),[],[])', '同じ順序・個数'],
    ['totaldifferentialat(Function(x,x,y,z,t),[1,2,3,4],[1,1,1,1])', '1〜3個'],
    ['totaldifferentialat(Function(x,x),[[1]],[1])', '各成分'],
    ['totaldifferentialat(Function(x,x),[1],[[1]])', '各成分'],
    ['totaldifferentialat(Function(x,x),[1],[true])', '各成分'],
    ['totaldifferentialat(Function(x,x),[1],[{1}])', '各成分'],
    ['totaldifferentialat(Function([x,x],x),[1],[1])', '数値になる式'],
  ])('%s は理由付きで拒否する', (source, reason) => {
    expect(() => lower(source)).toThrow(MathInputProblem);
    expect(() => lower(source)).toThrow(reason);
  });

  it('重複する変数ID・表示名と、制限付きの束縛を受け付けない', () => {
    const source = parse(examples[0][0]);
    if (source.kind !== 'operation' || source.operands[0].kind !== 'binder') throw new Error('関数がありません。');
    const fn = source.operands[0], [first, second] = fn.bindings;
    for (const bindings of [
      [first, { ...second, variable: { ...second.variable, id: first.variable.id } }],
      [first, { ...second, variable: { ...second.variable, label: first.variable.label } }],
      [{ ...first, domain: { kind: 'set' as const, value: parse('{1}') } }, second],
    ]) {
      expect(() => LOWERINGS['total-differential-at']({ ...source,
        operands: [{ ...fn, bindings }, ...source.operands.slice(1)] }, 'radian')).toThrow('重複しない1〜3個');
    }
  });
});

const request = (source: string, angleUnit: 'degree' | 'radian' = 'radian'): MathWorkRequest => ({
  source, angleUnit, notation: 'text', coefficients: [],
  identity: { documentId: 'total-differential', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 },
});
const publicCases = [
  ...examples.map(([source, value]) => ({ input: request(source), expected: { status: 'value', kind: 'real', coordinate: value } })),
  { input: request('totaldifferentialat(Function(sin(x),x),[0],[2])'),
    expected: { status: 'value', kind: 'real', coordinate: 2 } },
  { input: request('totaldifferentialat(Function(sin(x),x),[0],[180])', 'degree'),
    expected: { status: 'value', kind: 'real', coordinate: Math.PI } },
  { input: request('totaldifferentialat(Function(x^2,x),[totaldifferentialat(Function(y^2,y),[2],[1])],[1])'),
    expected: { status: 'value', kind: 'real', coordinate: 8 } },
  { input: request('sum(totaldifferentialat(Function(x^2,x),[j],[1]),j,1,3)'),
    expected: { status: 'value', kind: 'real', coordinate: 12 } },
  ...[
    'totaldifferentialat(Function(x/x,x),[0],[0])',
    '0*totaldifferentialat(Function(x/x,x),[0],[1])',
    'component([7,totaldifferentialat(Function(x/x,x),[0],[1])],1)',
    'totaldifferentialat(Function(x*y/(x^2+y^2),x,y),[0,0],[1,1])',
    'totaldifferentialat(Function(component([x,y/y],1),x,y),[2,0],[1,0])',
    'totaldifferentialat(Function(x,x),[i],[1])',
    'totaldifferentialat(Function(x,x),[∞],[1])',
    'totaldifferentialat(Function(i*x,x),[2],[1])',
    'totaldifferentialat(Function(x,x),[2],[1/0])',
  ].map(source => ({ input: request(source), expected: { status: 'invalid', reason: 'domain' } })),
  ...[
    'totaldifferentialat(Function(abs(x),x),[0],[1])',
    'totaldifferentialat(Function(abs(x),x),[0],[0])',
    'totaldifferentialat(Function(sqrt(x),x),[0],[1])',
  ].map(source => ({ input: request(source), expected: { status: 'unresolved', reason: 'unevaluated' } })),
];

describe('実装済みの全微分を通常入力・厳密計算・保存の経路へ接続する', () => {
  let replies: readonly MathExecutionReply[];
  beforeAll(async () => {
    replies = await Promise.all(publicCases.map(({ input }) => executeExactMathWorkRequest(createMathWorkEnvelope(1, input), {
      backend, engine, shouldStop: () => undefined,
    })));
  }, 90_000);

  it.each(publicCases)('$input.source の公開返信で $expected を保持する', entry => {
    const raw = replies[publicCases.indexOf(entry)];
    const result = decodeMathWorkReply(raw, entry.input, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    }).result;
    expect(result.evaluation).toMatchObject(entry.expected);
    if (result.evaluation.status === 'value' && result.evaluation.kind === 'real') {
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ format: 'pointercad-math/1', source: entry.input.source,
        angleUnit: entry.input.angleUnit });
    } else expect(result.evaluation).not.toHaveProperty('coordinate');
  });

  it('元の全微分・変数順序・角度を保存再評価と構造入力への往復で保つ', async () => {
    const inputs: readonly MathWorkRequest[] = [2, 11].map(index => ({ ...publicCases[index].input, presentationNotation: 'latex' }));
    const first = await Promise.all(inputs.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(2, input),
      { backend, engine, shouldStop: () => undefined })));
    const requests = first.flatMap((reply, index) => {
      if (reply.expression === null || reply.presentation === undefined || reply.presentation === null) {
        throw new Error(JSON.stringify(executeMathWorkRequest(createMathWorkEnvelope(2, inputs[index]), backend)));
      }
      expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
      expect(JSON.stringify(reply.expression)).toContain('total-differential-at');
      const input = inputs[index];
      const result = decodeMathWorkReply(reply, input, {
        operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
      }).result;
      if (result.definition === null) throw new Error('保存する全微分がありません。');
      return [
        { ...input, definition: result.definition },
        { ...input, source: reply.presentation.source, notation: 'latex' as const, definition: reply.presentation },
      ].map(value => ({ input: value, expected: reply.evaluation }));
    });
    const reopened = await Promise.all(requests.map(async ({ input, expected }) => {
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, input)));
      return { expected, reply: await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined }) };
    }));
    for (const { expected, reply } of reopened) expect(reply.evaluation).toEqual(expected);
  }, 90_000);

  it('通常入力の保存再評価で元の全微分と変数順序・角度・厳密値を保持する', async () => {
    const reopened = await Promise.all([2, 11].map(async index => {
      const input = publicCases[index].input, raw = replies[index];
      const result = decodeMathWorkReply(raw, input, {
        operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
      }).result;
      if (result.definition === null) throw new Error('保存する全微分がありません。');
      expect(result.definition.source).toBe(input.source);
      expect(JSON.stringify(result.definition.expression)).toContain('total-differential-at');
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(5, { ...input, definition: result.definition })));
      return { expected: raw.evaluation, reply: await executeExactMathWorkRequest(saved, {
        backend, engine, shouldStop: () => undefined,
      }) };
    }));
    for (const { expected, reply } of reopened) expect(reply.evaluation).toEqual(expected);
  }, 60_000);

  it('同名の局所変数と係数を区別し、位置・増分と係数の変更を反映する', async () => {
    const source = 'totaldifferentialat(Function(coef("x")*x^2,x),[coef("位置")],[coef("増分")])';
    const runs = await Promise.all(([
      ['3', '2', '0.5', 6], ['5', '3', '2', 60],
    ] as const).map(async ([factor, point, increment, expected]) => {
      const input: MathWorkRequest = { ...request(source), coefficients: [
        { id: 'factor', label: 'x', decimal: factor },
        { id: 'point', label: '位置', decimal: point },
        { id: 'increment', label: '増分', decimal: increment },
      ] };
      return { input, expected, raw: await executeExactMathWorkRequest(createMathWorkEnvelope(4, input), {
        backend, engine, shouldStop: () => undefined,
      }) };
    }));
    for (const { input, expected, raw } of runs) {
      const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor', 'point', 'increment']), declaredIds: new Set() }).result;
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(result.definition?.source).toBe(source);
    }
  }, 60_000);

  it('置き換えだけでは関数作図の変化する全微分を計算できない', () => {
    const definition = createFunctionMathSource('totaldifferentialat(Function(x^2,x),[X],[1])', 'text', 'radian', {
      axes: ['X'], parameters: [], coefficients: [],
    }, backend);
    expect(() => compileFunctionScalar(definition, ['X'], [], { backend, shouldStop: () => undefined }))
      .toThrow(MathInputProblem);
  });
});
