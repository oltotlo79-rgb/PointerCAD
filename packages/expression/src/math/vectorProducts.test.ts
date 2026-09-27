import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { coordinateFromMath, type MathEvaluation } from './mathInputContract.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeStoredMathStructure } from './decodeStoredMath.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

const script = fileURLToPath(new URL('./exactRuntime/cas_vector_products_test.py', import.meta.url));
const values = [
  ['dot([1,2,3],[4,5,6])', 32],
  ['[1,2,3]·[4,5,6]', 32],
  ['dot([1/3,sqrt(2)],[3,sqrt(2)])', 3],
  ['norm([3,4])', 5],
  ['norm([1,1])', Math.SQRT2],
  ['norm([0.3,0.4])', 0.5],
  ['norm([-3,4],1)', 7],
  ['norm([-3,4],∞)', 4],
  ['norm([3+4*i,12])', 13],
  ['norm([0,0],2)', 0],
  ['component([1,0,0]×[0,1,0],3)', 1],
  ['tensorelement(cross([1,0,0],[0,1,0]),[3])', 1],
  ['component(cross([1,2,3],[4,5,6]),1)', -3],
  ['cross([1,0,0],[0,1,0])·[0,0,2]', 2],
  ['component(cross([1,0,0],[0,1,0])×[0,1,0],1)', -1],
  ['component(cross([1,0,0],[0,1,0]),3)×4', 4],
  ['dot([coef("a"),1],[2,3])', 9],
] as const;
/** Components selected after the exact runtime calculated a vector or matrix (R-COORD), as text and as the picker's tensorelement. */
const selected = [
  ['component(transpose([[1,2],[3,4]]),1,2)', 3],
  ['tensorelement(transpose([[1,2],[3,4]]),[2,1])', 2],
  ['component(conjugatetranspose([[1,2],[3,4]]),1,2)', 3],
  ['component(inverse([[2,0],[0,4]]),2,2)', 0.25],
  ['tensorelement(inverse([[2,0],[0,4]]),[1,1])', 0.5],
  ['component(projection([1,2],[3,4]),1)', 33 / 25],
  ['tensorelement(projection([1,2],[3,4]),[2])', 44 / 25],
  ['component(identitymatrix(3),2,2)', 1],
  ['tensorelement(identitymatrix(3),[1,2])', 0],
  ['component(zeromatrix(2,3),2,3)', 0],
  ['tensorelement(zeromatrix(2),[2,1])', 0],
  ['component(component(transpose([[1,2],[3,4]]),2),1)', 2],
  ['component(cross([1,2,3],[4,5,6]),2)×component([[1,2],[3,4]],2,1)', 18],
  // A defined unselected cell keeps its selected value; it is only checked, never discarded unchecked.
  ['component([7,dot([1],[1])],1)', 7],
  ['tensorelement([7,norm([3,4])],[1])', 7],
] as const;
const rejected = [
  ['dot([1,2],[3])', 'dimension'],
  ['cross([1,2],[3,4])', 'dimension'],
  ['dot([i],[i])', 'domain'],
  ['norm([1,2],0)', 'domain'],
  ['norm([1,2],0.5)', 'domain'],
  ['norm([[1,2],[3,4]])', 'domain'],
  ['0*dot([i],[0])', 'domain'],
  ['component(cross([1/0,0,0],[0,1,0]),1)', 'domain'],
] as const;
/** An unselected cell that only the exact runtime can check is never discarded by the selection (MC-30, MC-31b). */
const hiddenInvalid = [
  ['component([7,dot([i],[i])],1)', 'domain'],
  ['component([7,1/norm([0,0])],1)', 'domain'],
  ['component([7,cross([1,2],[3,4])],1)', 'dimension'],
  ['component([7,dot([1,2],[3])],1)', 'dimension'],
  ['component([7,inverse([[1,1],[1,1]])],1)', 'domain'],
  ['component([7,det([[1,2]])],1)', 'domain'],
  ['component([7,component(gradientat(x/x,[x],[0]),1)],1)', 'domain'],
  ['component([7,derivativeat(t/t,t,0)],1)', 'domain'],
  ['component([7,limit(1/t,t,0)],1)', 'no-limit'],
  ['component([7,integrate(1/t,t,0,1)],1)', 'divergent'],
  ['component([7,sum(1/n,n,1,∞)],1)', 'divergent'],
  ['component([[1,2],[3,1/norm([0,0])]],1,1)', 'domain'],
  ['tensorelement([7,1/norm([0,0])],[1])', 'domain'],
  ['tensorelement([7,cross([1,2],[3,4])],[1])', 'dimension'],
] as const;
/** An index outside a calculated result whose size the input fixes is rejected with its reason before calculating. */
const outOfRange = [
  ['component(cross([1,0,0],[0,1,0]),4)', '成分の番号は各軸の範囲内の整数で指定してください。'],
  ['component(transpose([[1,2,3],[4,5,6]]),3,3)', '成分の番号は各軸の範囲内の整数で指定してください。'],
  ['component(identitymatrix(3),0,1)', '成分の番号は各軸の範囲内の整数で指定してください。'],
  ['component(projection([1,2],[3,4]),0)', '成分の番号は各軸の範囲内の整数で指定してください。'],
  ['tensorelement(identitymatrix(3),[4,1])', '各軸に1つずつ、1から成分数までの添字を指定してください。'],
  ['tensorelement(transpose([[1,2],[3,4]]),[1])', '各軸に1つずつ、1から成分数までの添字を指定してください。'],
  ['tensorelement(zeromatrix(2,3),[3,1])', '各軸に1つずつ、1から成分数までの添字を指定してください。'],
  ['component(dot([1],[2]),1)', '成分を取り出すベクトルまたは行列を指定してください。'],
] as const;
const vectorSource = '[1,0,0]×[0,1,0]';
const sources = [...values, ...selected, ...rejected, ...hiddenInvalid, ...outOfRange].map(([source]) => source);
const replies = new Map<string, ReturnType<typeof decodeMathWorkReply>['result']>();
const references = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['a']), declaredIds: new Set<string>() };
const request = (source: string): MathWorkRequest => ({
  identity: { documentId: 'vectors', documentVersion: 1, editorId: 'vector-products', inputRevision: 1 },
  source, notation: 'text', angleUnit: 'degree', coefficients: [{ id: 'a', label: 'a', decimal: '3' }],
});
const backend = createMathBackend();
beforeAll(async () => {
  const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
  await Promise.all([...sources, vectorSource].map(async source => {
    const envelope = createMathWorkEnvelope(1, request(source));
    const reply = await executeExactMathWorkRequest(envelope, { backend, engine, shouldStop: () => undefined });
    replies.set(source, decodeMathWorkReply(reply, envelope.request, references).result);
  }));
}, 90_000);

function evaluation(source: string): MathEvaluation {
  const reply = replies.get(source);
  if (reply === undefined) throw new Error(`Missing calculation: ${source}`);
  return reply.evaluation;
}
/** The calculation without the exact runtime, as the Worker tries first. */
function nativeEvaluation(source: string): MathEvaluation {
  const envelope = createMathWorkEnvelope(1, request(source));
  return decodeMathWorkReply(executeMathWorkRequest(envelope, backend), envelope.request, references).result.evaluation;
}

describe('内積・外積・ノルムの実計算と座標への接続', () => {
  it.each(values)('%sの厳密値から座標を求める', (source, expected) => {
    const result = evaluation(source);
    expect(result, source).toMatchObject({ status: 'value', kind: 'real' });
    expect(coordinateFromMath(result)).toBeCloseTo(expected, 12);
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.exact).not.toBeNull();
  });
  it.each(rejected)('%sを理由付きで拒否する', (source, reason) => {
    const result = evaluation(source);
    expect(result).toMatchObject({ status: 'invalid', reason });
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.detail.length).toBeGreaterThan(0);
    expect(() => coordinateFromMath(result)).toThrow();
  });
  it('外積の3成分を保ち、ベクトル全体を1つの座標にしない', () => {
    const result = evaluation(vectorSource);
    expect(result).toEqual({ status: 'value', kind: 'vector', expression: {
      kind: 'operation', operation: 'list', operands: [0, 0, 1].map(value => ({ kind: 'number', decimal: String(value) })),
    } });
    expect(() => coordinateFromMath(result)).toThrow();
  });
  it('元の演算と係数IDを保存して再読取りできる', () => {
    const reply = replies.get('dot([coef("a"),1],[2,3])');
    if (reply?.definition === null || reply?.definition === undefined) throw new Error('Missing stored source');
    expect(decodeStoredMathStructure(JSON.parse(JSON.stringify(reply.definition)), references)).toEqual(reply.definition);
    expect(reply.definition.source).toBe('dot([coef("a"),1],[2,3])');
    expect(JSON.stringify(reply.definition.expression)).toContain('coefficient');
    expect(JSON.stringify(reply.definition.expression)).toContain('dot');
  });
  it('同梱の固定計算部で記号・厳密値・定義域を独立に照合する', () => {
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) throw new Error(`${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    expect(result.stderr).toContain('Ran 31 tests');
  });
});

describe('追加計算部で計算したベクトル・行列から成分を選び、選ばれない要素の不成立を消さない', () => {
  it.each(selected)('%sは計算した結果から厳密な成分を選んで座標に使える', (source, expected) => {
    const result = evaluation(source);
    expect(result, source).toMatchObject({ status: 'value', kind: 'real' });
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.exact).not.toBeNull();
    expect(coordinateFromMath(result)).toBeCloseTo(expected, 12);
  });
  it.each(hiddenInvalid)('%sは選ばれない要素を捨てずに%sとして拒否する', (source, reason) => {
    const result = evaluation(source);
    expect(result, source).toMatchObject({ status: 'invalid', reason });
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.detail.length).toBeGreaterThan(0);
    // The Worker's first calculation must not return the selected cell either.
    expect(nativeEvaluation(source).status, source).not.toBe('value');
  });
  it.each(outOfRange)('%sは計算の前に理由を示して拒否する', (source, detail) => {
    expect(evaluation(source)).toEqual({ status: 'invalid', reason: 'domain', detail });
    expect(nativeEvaluation(source)).toEqual({ status: 'invalid', reason: 'domain', detail });
  });
  it('明示した一覧からの成分の選択は、従来どおり追加計算部なしで同じ値を返す', () => {
    for (const [source, expected] of [['component([3,4,5],2)', 4], ['component([[1,2],[3,4]],2,1)', 3],
      ['tensorelement([[1,2],[3,4]],[2,1])', 3], ['component([7,sqrt(-1)],1)', 7], ['component([1,erfc(ln(-1))],1)', 1]] as const) {
      const result = nativeEvaluation(source);
      expect(result, source).toMatchObject({ status: 'value', kind: 'real' });
      expect(coordinateFromMath(result)).toBeCloseTo(expected, 12);
    }
  });
});
