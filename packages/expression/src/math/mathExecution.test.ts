import {beforeAll, describe, expect, it} from 'vitest';
import {createMathBackend} from './createMathBackend.js';
import {executeMathWorkRequest, type MathExecutionBackend} from './mathWorkExecution.js';
import {createMathWorkEnvelope, type MathWorkRequest} from './mathWorkRequest.js';
import {decodeMathWorkReply} from './mathWorkReply.js';
import {CANDIDATE_MATH_BY_ID} from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string, angleUnit: MathWorkRequest['angleUnit'] = 'radian', notation: MathWorkRequest['notation'] = 'text') {
  const request: MathWorkRequest = {
    identity: {documentId: 'part', documentVersion: 4, editorId: 'coordinate-X', inputRevision: 2},
    source, notation, angleUnit, coefficients: [{id: 'factor-log', label: 'log', decimal: '3'}],
  };
  const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
  return decodeMathWorkReply(reply, request, {
    operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['factor-log']), declaredIds: new Set(),
  }).result;
}

describe('共通数式を固定エンジンで評価し、原式と型付き返信を保持する', () => {
  it.each([
    {source: '1/3', expected: 1/3},
    {source: 'root(-8,-3)', expected: -0.5},
    {source: 'rank([[1,2],[2,4]])', expected: 1},
    {source: 'abs(3+4*i)', expected: 5},
    {source: 'sum(i^2,i,1,10)', expected: 385},
  ])('$sourceの有限実数を作図用の値へ渡す', ({source, expected}) => {
    const result = evaluate(source);
    expect(result.definition).toMatchObject({source, inputNotation: 'text', angleUnit: 'radian'});
    expect(result.evaluation).toMatchObject({status: 'value', kind: 'real'});
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error('Finite real result required');
    expect(result.evaluation.coordinate).toBeCloseTo(expected, 12);
    expect(Number(result.evaluation.decimal)).toBe(result.evaluation.coordinate);
  });
  it('係数logと底付きlogを区別し、角度単位を保存する', () => {
    expect(evaluate('coef("log")+sin(30)', 'degree').evaluation)
      .toMatchObject({status: 'value', kind: 'real', coordinate: 3.5});
    expect(evaluate('log(8,2)').evaluation).toMatchObject({status: 'value', kind: 'real', coordinate: 3});
  });
  it('度の定積分には積分変数の単位も反映する', () => {
    const result = evaluate('integrate(sin(X),X,0,180)', 'degree');
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error('Finite integral required');
    expect(result.evaluation.coordinate).toBeCloseTo(360 / Math.PI, 11);
  });
  it('構造化した分数も丸める前の原式を保持する', () => {
    const result = evaluate(String.raw`\frac{1}{3}`, 'radian', 'latex');
    expect(result.definition).toMatchObject({source: String.raw`\frac{1}{3}`, inputNotation: 'latex'});
    expect(result.evaluation).toMatchObject({status: 'value', kind: 'real', coordinate: 1/3});
  });
  it.each([
    ['3+4*i', 'complex'], ['[1,2,3]', 'vector'], ['[[1,2],[3,4]]', 'matrix'],
    ['1<2', 'boolean'], ['{1,2,3}', 'set'],
  ])('%sの%s結果を暗黙に1個の座標へ変換しない', (source, kind) => {
    const result = evaluate(source).evaluation;
    expect(result).toMatchObject({status: 'value', kind});
    expect(result).not.toHaveProperty('coordinate');
  });
  it.each(['0*(-1)!', '0*root(-8,1.5)', '0*(1/0)', '0^0', '0^(-1)'])(
    '%sを簡約する前に定義域違反として断る', source => {
      expect(evaluate(source).evaluation).toMatchObject({status: 'invalid', reason: 'domain'});
    });
  it('場合分けは選んだ枝だけを評価し、未定義の条件を簡約で隠さない', () => {
    expect(evaluate('which(1<2,3,0^0)').evaluation).toMatchObject({status: 'invalid'});
    expect(evaluate('which(1<2,3,2<1,0^0)').evaluation).toMatchObject({status: 'value', kind: 'real', coordinate: 3});
    expect(evaluate('which(0^0==1,3,1==1,4)').evaluation).toMatchObject({status: 'invalid', reason: 'domain'});
  });
});
