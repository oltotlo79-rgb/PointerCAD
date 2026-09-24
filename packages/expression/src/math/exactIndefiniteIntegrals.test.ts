import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply, type MathWorkResult } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { mathScalarExpression, mathScalarValue } from './mathScalarExpression.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createScalarSampler } from './scalarMathTape.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import type { MathNode, StoredMathExpression } from './mathInputContract.js';

/**
 * MC-20: integrate(f,x) with no bound is the indefinite form. Both grammars build the same 'integrate'
 * binder with an 'unrestricted' domain, and the native backend defers it to the exact runtime.
 *
 * The exact runtime finds an antiderivative and proves it by differentiating it back
 * (cas_integrals.py). When the whole formula is that one integral, the answer is the family F+C: a
 * function, never a number. cas_result.py therefore always returns it as a one-variable lambda over
 * the source integral's own binding (also a constant F such as integrate(0,t)); exactMathResult.ts
 * accepts that lambda only for exactly that source, as the non-scalar shape 'function', and the
 * Worker delivers it as a 'function' evaluation, so every coordinate, component and coefficient
 * boundary refuses it. A condition on the integral's own variable (t≠0 for 1/t) only says where F
 * applies and is not an obligation of the whole answer. An indefinite integral inside a larger
 * formula keeps its previous result.
 */
let backend: MathExecutionBackend;
function textRequest(source: string, angleUnit: 'degree' | 'radian' = 'radian',
  coefficients: MathWorkRequest['coefficients'] = []): MathWorkRequest {
  return { source, notation: 'text', angleUnit, coefficients,
    identity: { documentId: 'indefinite', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
function latexRequest(source: string): MathWorkRequest {
  return { source, notation: 'latex', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'indefinite', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
const COEFFICIENT = { id: 'coefficient-a', label: 'a', decimal: '2' };
const context = (request: MathWorkRequest) => ({ operationsById: backend.operationsById,
  coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set<string>() });
const script = fileURLToPath(new URL('./exactRuntime/cas_integrals_test.py', import.meta.url));
const requests = new Map<string, MathWorkRequest>();
const results = new Map<string, MathWorkResult>();
function result(key: string): MathWorkResult {
  const value = results.get(key);
  if (value === undefined) throw new Error(`計算していない入力です: ${key}`);
  return value;
}
function definitionOf(key: string): StoredMathExpression {
  const definition = result(key).definition;
  if (definition === null) throw new Error(`原式がありません: ${key}`);
  return definition;
}
/** The answer must be a lambda over the very binding of the source's own integral (same id and label). */
function antiderivative(key: string): Extract<MathNode, { kind: 'binder' }> {
  const { evaluation } = result(key), root = definitionOf(key).expression;
  if (evaluation.status !== 'value' || evaluation.kind !== 'function') throw new Error(`${key}: ${JSON.stringify(evaluation)}`);
  const fn = evaluation.expression;
  if (fn.kind !== 'binder' || root.kind !== 'binder') throw new Error(`${key}: ${JSON.stringify(fn)}`);
  expect(fn).toMatchObject({ operation: 'lambda', bindings: [{ variable: root.bindings[0].variable, domain: { kind: 'unrestricted' } }] });
  expect(fn.bindings).toHaveLength(1);
  return fn;
}
const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const operation = (name: string, ...operands: MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });

beforeAll(async () => {
  backend = createMathBackend();
  const plain: Readonly<Record<string, MathWorkRequest>> = {
    square: textRequest('integrate(t^2,t)'),
    zero: textRequest('integrate(0,t)'),
    reciprocal: textRequest('integrate(1/t,t)'),
    degree: textRequest('integrate(sin(t),t)', 'degree'),
    coefficient: textRequest('integrate(coef("a")*t,t)', 'radian', [COEFFICIENT]),
    structural: latexRequest(String.raw`\int t^2\,\mathrm{d}t`),
    noClosedForm: textRequest('integrate(sin(sin(t)),t)'),
    piecewise: textRequest('integrate(abs(t),t)'),
    zeroDenominator: textRequest('integrate(t/(ln(6)-ln(2)-ln(3)),t)'),
    nested: textRequest('2*integrate(t^2,t)'),
    cancelled: textRequest('0*integrate(t^2,t)'),
    definite: textRequest('integrate(t^2,t,0,3)'),
    mapping: textRequest('mapping(2*x+1,x,ℝ,ℝ)'),
  };
  for (const [key, request] of Object.entries(plain)) requests.set(key, request);
  // Saving keeps only the source; reopening and the LaTeX presentation are prepared without the exact
  // runtime, so every exact calculation below shares one prepared runtime launch.
  const square = plain.square;
  const parsed = decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, square), backend), square, context(square)).result;
  if (parsed.definition === null) throw new Error('integrate(t^2,t)を読めません。');
  const saved = JSON.parse(JSON.stringify(parsed.definition)) as StoredMathExpression;
  requests.set('reopened', { ...square, definition: saved });
  const presentedRequest: MathWorkRequest = { ...square, presentationNotation: 'latex' };
  requests.set('presented', presentedRequest);
  const presentation = decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, presentedRequest), backend),
    presentedRequest, context(presentedRequest)).result.presentation;
  if (presentation === null || presentation === undefined) throw new Error('構造入力へ変換できません。');
  requests.set('latex', { ...latexRequest(presentation.source), definition: presentation });
  const engine = sharedExactEngine(exactRuntimeBatch(script, 20_000));
  const entries = [...requests];
  const replies = await Promise.all(entries.map(([, request]) =>
    executeExactMathWorkRequest(createMathWorkEnvelope(2, request), { backend, engine, shouldStop: () => undefined })));
  entries.forEach(([key, request], index) => results.set(key, decodeMathWorkReply(replies[index], request, context(request)).result));
}, 300_000);

describe('不定積分integrate(f,x)の読取りと振り分け(MC-20)', () => {
  it('通常入力integrate(t^2,t)は境界のないbinderとして読取り、実計算部へ回す(未評価と決めつけない)', () => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, textRequest('integrate(t^2,t)')), backend);
    expect(reply.expression).toMatchObject({ kind: 'binder', operation: 'integrate',
      bindings: [{ domain: { kind: 'unrestricted' } }] });
    // The native backend never resolves any binder itself (sum/product/integrate/differentiate are
    // 'structural'); a status other than 'value' here proves the request is correctly routed onward
    // to the exact runtime, not silently mistreated as a plain error at this layer.
    expect(reply.evaluation.status).not.toBe('value');
  });
  it('構造入力\\int t^2\\,\\mathrm{d}tも同じ境界のないbinderに読取り、通常入力と同じ意味になる', () => {
    const structural = executeMathWorkRequest(createMathWorkEnvelope(2, latexRequest(String.raw`\int t^2\,\mathrm{d}t`)), backend);
    expect(structural.expression).toMatchObject({ kind: 'binder', operation: 'integrate',
      bindings: [{ domain: { kind: 'unrestricted' } }] });
    const normal = executeMathWorkRequest(createMathWorkEnvelope(3, textRequest('integrate(t^2,t)')), backend);
    expect(structural.expression && normal.expression && sameMathMeaning(structural.expression, normal.expression)).toBe(true);
  });
  it('定積分integrate(t^2,t,0,3)は従来どおり範囲つきのbinderのままで、境界のない形にはならない(今の動きを変えない)', () => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(4, textRequest('integrate(t^2,t,0,3)')), backend);
    expect(reply.expression).toMatchObject({ kind: 'binder', operation: 'integrate',
      bindings: [{ domain: { kind: 'range' } }] });
  });

  it('integrate(t^2,t)を実計算部で解くと、原始関数t^3/3を厳密な記号のまま返す', () => {
    const fn = antiderivative('square'), t: MathNode = { kind: 'symbol', reference: fn.bindings[0].variable };
    expect(fn.body).toEqual(operation('multiply', operation('divide', number('1'), number('3')), operation('power', t, number('3'))));
    // The structural input is the same integral and receives the same function.
    const structural = antiderivative('structural');
    expect(sameMathMeaning(structural, fn)).toBe(true);
    // Coefficients are substituted for the calculation, but the answer stays tied to the saved source's own binding.
    expect(definitionOf('coefficient').expression).toMatchObject({ kind: 'binder', body: { operands: [
      { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient-a', label: 'a' } }, {}] } });
    const scaled = antiderivative('coefficient');
    expect(scaled.body).toEqual(operation('power', { kind: 'symbol', reference: scaled.bindings[0].variable }, number('2')));
  });
  it('原始関数の値は積分定数を含むため座標・成分・係数の数値には使えない(mathScalarValueが拒否する)', () => {
    // integrate(0,t) used to reach the CAD as the number 0; it is the constant function 0+C as well.
    expect(antiderivative('zero').body).toEqual(number('0'));
    for (const key of ['square', 'zero', 'reciprocal', 'degree', 'coefficient', 'structural']) {
      const value = result(key);
      expect(value.evaluation).toMatchObject({ status: 'value', kind: 'function' });
      expect(value.evaluation).not.toHaveProperty('coordinate');
      expect(mathScalarValue(value.evaluation)).toEqual({ ok: false, message: 'この欄には一意に決まる実数が必要です。式と条件を確認してください。' });
      expect(mathScalarExpression(value).ok).toBe(false);
    }
  });
  it('SymPyが単一の閉形式を確立できない不定積分(例 sin(sin(t)))は理由付きで未評価のまま断る', () => {
    expect(result('noClosedForm').evaluation).toEqual({ status: 'unresolved', reason: 'unevaluated', names: [] });
    // A branch-dependent (piecewise) candidate is not one closed form either.
    expect(result('piecewise').evaluation).toEqual({ status: 'unresolved', reason: 'unevaluated', names: [] });
  });
  it('原式・角度単位を保存し、構造入力への切替や再読込でも不定積分の意味を保つ', () => {
    const square = result('square'), fn = antiderivative('square');
    expect(result('reopened').definition).toEqual(square.definition);
    expect(result('reopened').evaluation).toEqual(square.evaluation);
    const presented = result('presented');
    if (presented.presentation === null || presented.presentation === undefined) throw new Error('構造入力への変換がありません。');
    expect(presented.presentation.inputNotation).toBe('latex');
    expect(sameMathMeaning(presented.presentation.expression, definitionOf('square').expression)).toBe(true);
    expect(presented.evaluation).toEqual(square.evaluation);
    expect(definitionOf('latex')).toMatchObject({ inputNotation: 'latex', angleUnit: 'radian' });
    expect(sameMathMeaning(antiderivative('latex'), fn)).toBe(true);
    // The angle unit belongs to the saved source; in degrees the answer keeps the degree convention.
    expect(definitionOf('degree').angleUnit).toBe('degree');
    const degree = antiderivative('degree'), t: MathNode = { kind: 'symbol', reference: degree.bindings[0].variable };
    expect(degree.body).toEqual(operation('multiply', number('-180'), operation('power', { kind: 'constant', name: 'pi' }, number('-1')),
      operation('cos', t)));
  });
});

describe('不定積分の答えの成立条件と、他の答えの形を変えないこと(MC-20)', () => {
  it('1/tの原始関数ln(t)を返し、積分の変数だけの条件t≠0は答え全体の条件にしない', () => {
    const fn = antiderivative('reciprocal');
    expect(fn.body).toEqual(operation('natural-log', { kind: 'symbol', reference: fn.bindings[0].variable }));
  });
  it('積分の変数を含まない元の条件(分母ln(6)-ln(2)-ln(3)≠0)は従来どおり確かめ、確かめられなければ答えにしない', () => {
    expect(result('zeroDenominator').evaluation.status).not.toBe('value');
    expect(result('zeroDenominator').evaluation).toMatchObject({ status: 'unresolved', reason: 'missing-condition' });
  });
  it('式の内側の不定積分・定積分・写像の関数値は従来どおりの答えのまま(写像は原式への差し替えも従来どおり)', () => {
    expect(result('nested').evaluation).toEqual({ status: 'unresolved', reason: 'unevaluated', names: [] });
    expect(result('cancelled').evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '0', coordinate: 0 });
    expect(result('definite').evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '9', coordinate: 9 });
    const mapping = result('mapping');
    expect(mapping.evaluation).toEqual({ status: 'value', kind: 'function', expression: definitionOf('mapping').expression });
  });
});

describe('関数作図の式での不定積分の扱い(MC-20)', () => {
  const scope = { axes: ['X' as const], parameters: [] };
  const INDEFINITE_IN_FUNCTION = '不定積分は積分定数が定まらない関数の集まりのため、関数の式には使えません。原始関数を式で書き、積分定数を決めてください（例 integrate(X^2,X) の代わりに X^3/3+1）。';
  const confirm = async (source: string) => {
    const request: MathWorkRequest = { ...textRequest(source), functionScope: scope };
    const evaluate = vi.fn(() => Promise.reject(new Error('関数の式の確認で実計算部を呼びました。')));
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(5, request), { backend, engine: { evaluate }, shouldStop: () => undefined });
    expect(evaluate).not.toHaveBeenCalled();
    return { request, raw, result: decodeMathWorkReply(raw, request, context(request)).result };
  };
  it('関数の式の確認は実計算部を使わず、不定積分を「使えないこと」と「代わりの書き方」の理由付きで断る', async () => {
    // Its own X is bound by the integral, so the formula is a family F+C that does not follow the axis X.
    for (const source of ['integrate(X^2,X)', 'X+integrate(t^2,t)']) {
      expect((await confirm(source)).result.evaluation).toEqual({ status: 'invalid', reason: 'unsupported', detail: INDEFINITE_IN_FUNCTION });
    }
    // The suggested form, the antiderivative written out with a chosen constant, is an ordinary function formula.
    expect((await confirm('X^3/3+1')).result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    // Only an integral without bounds is refused by this check; a bounded one keeps its previous handling.
    expect((await confirm('X+integrate(t^2,t,0,1)')).result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
  });
  it('原始関数の答えを関数の式の確認の返信として差し込んでも受け取らない', async () => {
    const { request, raw } = await confirm('integrate(X^2,X)');
    const square = result('square').evaluation;
    expect(() => decodeMathWorkReply({ ...raw, evaluation: square }, request, context(request))).toThrow('関数の原式と確認した定義が一致しません。');
  });
  it('保存済みの不定積分の関数の式も作図の段で断り、案内どおりに書いた原始関数X^3/3+1は作図できる', () => {
    const compile = (source: string) => compileFunctionScalar(createFunctionMathSource(source, 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [] }, backend), ['X'], [], { backend, shouldStop: () => undefined });
    expect(() => compile('integrate(X^2,X)')).toThrow('この欄には一意に決まる実数が必要です。式と条件を確認してください。');
    expect(createScalarSampler(compile('X^3/3+1'))([3])).toBeCloseTo(10, 12);
    // A definite integral up to the variable is not a plotting alternative either (existing limitation, not MC-20).
    expect(() => compile('integrate(t^2,t,0,X)')).toThrow('変数を含む積分などは、先に解析した式への変換が必要です。');
  });
});
