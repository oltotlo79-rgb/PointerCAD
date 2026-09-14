import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { ExactMathEngineStopped } from './exactMathEngineClient.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { type MathExecutionBackend } from './mathWorkExecution.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const operation = (name: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
const fraction = operation('divide', number('1'), number('3'));
const wire = (expression: MathNode) => ({ status: 'value', kind: 'real', expression, domainConditions: [], coordinateAuthorized: false });
function request(source = '1/3'): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 4, editorId: 'x', inputRevision: 2 },
    source, notation: 'text', angleUnit: 'degree', coefficients: [] };
}
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function unsupportedOnce(): MathExecutionBackend {
  return { ...backend, box: vi.fn(backend.box).mockImplementationOnce(() => {
    throw new MathInputProblem('unsupported', 'この計算は補助エンジンを必要とします。');
  }) };
}
function decode(value: unknown, input: MathWorkRequest) {
  return decodeMathWorkReply(value, input, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(input.coefficients.map(value => value.id)), declaredIds: new Set() });
}

describe('補助計算中も原式と編集番号を保持して既存の返信検証へ戻す', () => {
  it('有理数でない行列の階数を未対応の再判定で止めず、厳密計算へ渡す', async () => {
    const input = request('rank([[sqrt(2),1],[2,sqrt(2)]])');
    // The second row is sqrt(2) times the first, so its exact rank is one.
    const evaluate = vi.fn(() => Promise.resolve(wire(number('1'))));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(24, input), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ operation: 'rank' }), 'degree');
    expect(decode(reply, input).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 1 });
    expect(reply.source).toBe(input.source);
  });
  it.each(['rank([[sqrt(2),1],[2]])', 'rank([[sqrt(2),1],[2,1/0]])',
    '0*rank([[sqrt(2),1],[2]])', 'rank([[[sqrt(2)],[1]],[[2],[3]]])',
    'rank([[sqrt(2),1],[2,true]])'])('有理数でない成分が先にあっても不正な行列を補助へ送らない: %s', async source => {
    const input = request(source), evaluate = vi.fn(() => Promise.resolve(wire(number('0'))));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(25, input), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(decode(reply, input).result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('既存計算で確定できる式には補助エンジンを起動しない', async () => {
    const input = request(), evaluate = vi.fn(() => Promise.resolve(wire(number('999'))));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(decode(reply, input).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 1 / 3 });
  });
  it('未対応の結果を受け取り、原式・入力方式・角度と正確な分数を返信に保つ', async () => {
    const input = request(), evaluate = vi.fn(() => Promise.resolve(wire(fraction)));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), {
      backend: unsupportedOnce(), engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).toHaveBeenCalledWith(fraction, 'degree');
    expect(decode(reply, input).result).toMatchObject({ definition: { source: '1/3', angleUnit: 'degree' },
      evaluation: { status: 'value', kind: 'real', exact: fraction, coordinate: 1 / 3 } });
  });
  it('待機中に呼出し元が編集しても、古い結果に新しい編集番号を付けない', async () => {
    const input = { ...request(), identity: { ...request().identity } };
    let release: ((result: unknown) => void) | undefined;
    const pending = executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 3, request: input }, {
      backend: unsupportedOnce(), engine: { evaluate: () => new Promise(resolve => { release = resolve; }) }, shouldStop: () => undefined,
    });
    input.identity.inputRevision = 3; input.source = '9';
    release?.(wire(fraction));
    const reply = await pending;
    expect(reply).toMatchObject({ serial: 3, identity: { inputRevision: 2 }, source: '1/3' });
    expect(() => decode(reply, input)).toThrow('現在の入力');
    expect(decode(reply, request()).result.evaluation).toMatchObject({ coordinate: 1 / 3 });
  });
  it.each(['cancelled', 'deadline'] as const)('%s後に届いた正常値を作図可能な結果にしない', async reason => {
    const state: { stop?: 'cancelled' | 'deadline' } = {};
    let release: ((result: unknown) => void) | undefined;
    const pending = executeExactMathWorkRequest(createMathWorkEnvelope(4, request()), {
      backend: unsupportedOnce(), engine: { evaluate: () => new Promise(resolve => { release = resolve; }) }, shouldStop: () => state.stop,
    });
    state.stop = reason; release?.(wire(fraction));
    expect(decode(await pending, request()).result.evaluation).toEqual({ status: 'stopped', reason });
  });
  it('補助側が不正な式や勝手な座標許可を返しても既存の数値にはしない', async () => {
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(5, request()), {
      backend: unsupportedOnce(), engine: { evaluate: () => Promise.resolve({ ...wire(number('1')), coordinateAuthorized: true }) }, shouldStop: () => undefined,
    });
    expect(decode(reply, request()).result.evaluation).toMatchObject({ status: 'invalid', reason: 'syntax' });
  });
  it('ゼロ除算と0^0を未対応扱いにして補助へ送らない', async () => {
    for (const source of ['0*(1/0)', '0^0']) {
      const evaluate = vi.fn(() => Promise.resolve(wire(number('0')))), input = request(source);
      const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(6, input), {
        backend, engine: { evaluate }, shouldStop: () => undefined,
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(decode(reply, input).result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it('係数の表示丸めを使わず正確な原式を代入してから補助へ送る', async () => {
    const input = { ...request('coef("a")'), coefficients: [{ id: 'a', label: 'a', decimal: '0.33333', exactExpression: fraction }] };
    const evaluate = vi.fn(() => Promise.resolve(wire(fraction)));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), {
      backend: unsupportedOnce(), engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).toHaveBeenCalledWith(fraction, 'degree');
    expect(decode(reply, input).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 1 / 3 });
  });
  it('入力形式の変換結果を補助計算後も保持する', async () => {
    const input = { ...request(), presentationNotation: 'latex' as const };
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(8, input), {
      backend: unsupportedOnce(), engine: { evaluate: () => Promise.resolve(wire(fraction)) }, shouldStop: () => undefined,
    });
    expect(decode(reply, input).result.presentation).toMatchObject({ inputNotation: 'latex', expression: fraction });
  });
  it('補助の読込み失敗も現在の依頼に属する失敗として戻す', async () => {
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(9, request()), {
      backend: unsupportedOnce(), engine: { evaluate: () => Promise.reject(new Error('loading failed')) }, shouldStop: () => undefined,
    });
    expect(decode(reply, request()).result.evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
});


describe('外側から中止した補助計算を未対応や正常値と取り違えない', () => {
  it.each(['cancelled', 'deadline'] as const)('%sは元の入力世代とともに停止として返す', async reason => {
    const input = request();
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(23, input), {
      backend: unsupportedOnce(), shouldStop: () => undefined,
      engine: { evaluate: () => Promise.reject(new ExactMathEngineStopped(reason)) },
    });
    expect(decode(reply, input).result.evaluation).toEqual({ status: 'stopped', reason });
    expect(reply).toMatchObject({ serial: 23, identity: input.identity, source: input.source });
  });
});
