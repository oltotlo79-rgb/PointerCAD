import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLOSED_CURVE_OPEN, CLOSED_CURVE_UNPROVED, CLOSED_INTEGRAL_BASES, CLOSED_INTEGRAL_FINITE, CLOSED_INTEGRAL_UNDEFINED,
  CLOSED_SURFACE_OPEN, CLOSED_SURFACE_UNPROVED, LOWERINGS } from './closedIntegrals.js';
import { createMathBackend } from './createMathBackend.js';
import { decodeMathJson } from './decodeMathJson.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { formatMathText } from './formatMathText.js';
import { CLOSED_INTEGRAL_UNAVAILABLE } from './lineIntegrals.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { EXTENDED_OPERATION_DEFINITIONS } from './mathExtendedOperations.js';
import { displayMathJson, sameMathMeaning } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { parseMathText } from './mathTextSyntax.js';
import { type MathExecutionReply } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { prepareExactMathCalculation } from './prepareMathCalculation.js';

const names = { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] };
const parse = (source: string): MathNode => parseMathText(source, { names, operations: CANDIDATE_MATH_OPERATIONS });
const backend = createMathBackend();
const fromLatex = (source: string): MathNode => decodeMathJson(backend.parseLatex(source),
  { names, operations: CANDIDATE_MATH_OPERATIONS, allowRenderedProducts: true });
const toLatex = (node: MathNode): string => backend.serializeLatex(displayMathJson(node, CANDIDATE_MATH_BY_ID));
// One prepared runtime serves every calculation requested in the same turn (rules/06 §10.323).
const engine = sharedExactEngine(exactRuntimeBatch(
  fileURLToPath(new URL('./exactRuntime/cas_line_integrals_test.py', import.meta.url)), 60_000));
const identity = { documentId: 'closed-integrals', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 };
type Coefficients = MathWorkRequest['coefficients'];
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree', coefficients: Coefficients = []): MathWorkRequest {
  return { identity, source, notation: 'text', angleUnit, coefficients };
}
function evaluation(reply: MathExecutionReply, input: MathWorkRequest, coefficientIds: readonly string[] = []) {
  return decodeMathWorkReply(reply, input, { operationsById: backend.operationsById,
    coefficientIds: new Set(coefficientIds), declaredIds: new Set() }).result;
}
function problem(action: () => unknown): MathInputProblem {
  try { action(); } catch (error) {
    if (error instanceof MathInputProblem) return error;
    throw error;
  }
  throw new Error('例外が発生しませんでした。');
}

const SPHERE = '[sin(u)*cos(v),sin(u)*sin(v),cos(u)]', TORUS = '[(2+cos(v))*cos(u),(2+cos(v))*sin(u),sin(v)]';
const CIRCLE = 'closedcirculation([-y,x],[x,y],[cos(t),sin(t)],t';
type Expected = { readonly value: number } | { readonly reason: 'domain' | 'unsupported'; readonly detail: string };
/** Independent analytic values: circumference, 2·area by Green's theorem, and volumes by the divergence theorem. */
const CASES: readonly (readonly [source: string, unit: 'degree' | 'radian', expected: Expected])[] = [
  ['closedlineintegral(1,[x,y],[cos(t),sin(t)],t,0,360)', 'degree', { value: 2 * Math.PI }],
  [`${CIRCLE},0,360)`, 'degree', { value: 2 * Math.PI }],
  ['∮([-y,x],[x,y],[cos(t),sin(t)],t,0,360)', 'degree', { value: 2 * Math.PI }],
  [`${CIRCLE},0,2*pi)`, 'radian', { value: 2 * Math.PI }],
  [`${CIRCLE},2*pi,0)`, 'radian', { value: -2 * Math.PI }],
  [`${CIRCLE},0,720)`, 'degree', { value: 4 * Math.PI }],
  [`${CIRCLE},30,390)`, 'degree', { value: 2 * Math.PI }],
  [`${CIRCLE},1,1+2*pi)`, 'radian', { value: 2 * Math.PI }],
  ['closedcirculation([-y,x],[x,y],[3*cos(t),2*sin(t)],t,0,360)', 'degree', { value: 12 * Math.PI }],
  ['closedcirculation([-y,x],[x,y],[t^2-1,t^3-t],t,-1,1)', 'degree', { value: 16 / 15 }],
  ['closedcirculation([x,y],[x,y],[t^2-1,t^3-t],t,-1,1)', 'degree', { value: 0 }],
  // The same curve closes in degrees but not in radians, and half a turn is open.
  [`${CIRCLE},0,360)`, 'radian', { reason: 'domain', detail: CLOSED_CURVE_OPEN }],
  [`${CIRCLE},0,180)`, 'degree', { reason: 'domain', detail: CLOSED_CURVE_OPEN }],
  ['closedlineintegral(1,[x,y],[t,t^2],t,0,1)', 'degree', { reason: 'domain', detail: CLOSED_CURVE_OPEN }],
  ['∮(1,[x,y],[t,t^2],t,0,1)', 'degree', { reason: 'domain', detail: CLOSED_CURVE_OPEN }],
  // Closed, or closed up to rounding, but not provable exactly: never calculated as closed.
  [`${CIRCLE},0,2*gamma(1/2)^2)`, 'radian', { reason: 'unsupported', detail: CLOSED_CURVE_UNPROVED }],
  [`${CIRCLE},0,6.283185307179586)`, 'radian', { reason: 'unsupported', detail: CLOSED_CURVE_UNPROVED }],
  ['closedlineintegral(1,[x,y],[cos(t),sin(t)+(exp(pi*sqrt(163))-262537412640768744)*t/360],t,0,360)', 'degree',
    { reason: 'unsupported', detail: CLOSED_CURVE_UNPROVED }],
  ['closedlineintegral(exp(-x),[x],[t],t,0,∞)', 'degree', { reason: 'domain', detail: CLOSED_INTEGRAL_FINITE }],
  ['closedlineintegral(1,[x,y],[1/t,t],t,0,1)', 'degree', { reason: 'domain', detail: CLOSED_INTEGRAL_UNDEFINED }],
  [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'degree', { value: 4 * Math.PI }],
  [`closedfluxintegral([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'degree', { value: 4 * Math.PI }],
  [`∯([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'degree', { value: 4 * Math.PI }],
  [`closedfluxintegral([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[pi,2*pi])`, 'radian', { value: 4 * Math.PI }],
  [`closedsurfaceintegral(1,[x,y,z],${TORUS},[u,v],[0,0],[360,360])`, 'degree', { value: 8 * Math.PI ** 2 }],
  [`closedfluxintegral([0,0,z],[x,y,z],${TORUS},[u,v],[0,0],[360,360])`, 'degree', { value: 4 * Math.PI ** 2 }],
  [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[90,360])`, 'degree', { reason: 'domain', detail: CLOSED_SURFACE_OPEN }],
  ['closedfluxintegral([x,y,0],[x,y,z],[cos(u),sin(u),v],[u,v],[0,0],[360,1])', 'degree', { reason: 'domain', detail: CLOSED_SURFACE_OPEN }],
  [`closedfluxintegral([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'radian', { reason: 'domain', detail: CLOSED_SURFACE_OPEN }],
  [`closedsurfaceintegral(1,[x,y,z],${TORUS},[u,v],[0,0],[2*gamma(1/2)^2,2*pi])`, 'radian',
    { reason: 'unsupported', detail: CLOSED_SURFACE_UNPROVED }],
  // The existing open integrals keep their meaning and values, including the open half sphere and circle.
  ['lineintegral(1,[x,y],[3*t,4*t],t,0,1)', 'degree', { value: 5 }],
  ['circulation([-y,x],[x,y],[cos(t),sin(t)],t,0,360)', 'radian', { value: 360 }],
  [`surfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[90,360])`, 'degree', { value: 2 * Math.PI }],
  ['fluxintegral([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])', 'degree', { value: 24 }],
];
const caseIndex = (source: string, unit: 'degree' | 'radian'): number => CASES.findIndex(entry => entry[0] === source && entry[1] === unit);

let replies: readonly MathExecutionReply[];
let direct: unknown;
beforeAll(async () => {
  // The closed operation itself never reaches the calculation: the runtime rejects it unchanged.
  const unlowered = parse(`${CIRCLE},0,360)`);
  [replies, direct] = await Promise.all([
    Promise.all(CASES.map(([source, unit]) => executeExactMathWorkRequest(createMathWorkEnvelope(1, request(source, unit)),
      { backend, engine, shouldStop: () => undefined }))),
    engine.evaluate(unlowered, 'degree'),
  ]);
}, 150_000);

describe('∮・∯を、閉じていることを厳密に確かめてから既存の積分として計算する（MC-19d）', () => {
  it('4演算を実装済みとして登録し、閉じていることの証明を通った場合だけ既存の4演算へ置き換える', () => {
    const closed = EXTENDED_OPERATION_DEFINITIONS.filter(value => CLOSED_INTEGRAL_BASES.has(value.id));
    expect(closed.map(value => [value.id, value.head, value.task, value.status, value.result])).toEqual([
      ['closed-line-integral', 'ClosedLineIntegral', 'MC-19', 'implemented', 'scalar'],
      ['closed-circulation', 'ClosedCirculation', 'MC-19', 'implemented', 'scalar'],
      ['closed-surface-integral', 'ClosedSurfaceIntegral', 'MC-19', 'implemented', 'scalar'],
      ['closed-flux-integral', 'ClosedFluxIntegral', 'MC-19', 'implemented', 'scalar'],
    ]);
    expect(Object.keys(LOWERINGS)).toEqual([...CLOSED_INTEGRAL_BASES.keys()]);
    expect([...CLOSED_INTEGRAL_BASES.values()]).toEqual(['line-integral', 'circulation', 'surface-integral', 'flux-integral']);
  });

  it.each(CASES)('%s（%s）', (source, unit, expected) => {
    const input = request(source, unit), result = evaluation(replies[caseIndex(source, unit)], input);
    if ('value' in expected) {
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.coordinate).toBeCloseTo(expected.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ format: 'pointercad-math/1', source, angleUnit: unit });
    } else {
      expect(result.evaluation).toEqual({ status: 'invalid', ...expected });
    }
  });

  it('閉じた演算をそのまま渡しても追加計算部は閉じていることを確かめずに計算しない', () => {
    expect(direct).toEqual({ status: 'invalid', reason: 'unsupported', coordinateAuthorized: false });
  });

  it('準備処理は証明した後の既存の積分だけを追加計算部へ渡し、束縛された変数で決まる端点は証明しない', () => {
    const settings = { resolve: () => null, angleUnit: 'degree' as const };
    for (const [source, operation] of [[`${CIRCLE},0,360)`, 'circulation'],
      ['closedlineintegral(1,[x,y],[cos(t),sin(t)],t,0,360)', 'line-integral'],
      [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'surface-integral'],
      [`closedfluxintegral([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'flux-integral']] as const) {
      const prepared = prepareExactMathCalculation(parse(source), settings);
      expect(prepared).toMatchObject({ status: 'ready', expression: { kind: 'operation', operation } });
      expect(JSON.stringify(prepared)).not.toContain('"closed-');
    }
    const bound = problem(() => prepareExactMathCalculation(parse(`sum(${CIRCLE},0,360*k),k,1,2)`), settings));
    expect([bound.code, bound.message]).toEqual(['unsupported', CLOSED_CURVE_UNPROVED]);
  });

  it.each([
    [`${CIRCLE},15,375)`, 'degree', 'circulation'], [`${CIRCLE},-pi,pi)`, 'radian', 'circulation'],
    [`${CIRCLE},0,4*arcsin(1))`, 'radian', 'circulation'], [`${CIRCLE},0,4*arcsin(1))`, 'degree', 'circulation'],
    [`${CIRCLE},0,8*arctan(1))`, 'radian', 'circulation'],
    ['closedcirculation([-y,x],[x,y],[cos(t)^3,sin(t)^3],t,0,360)', 'degree', 'circulation'],
    ['closedlineintegral(1,[x,y],[sqrt(2)*cos(t),sqrt(8)*sin(t)/2],t,45,405)', 'degree', 'line-integral'],
    ['closedlineintegral(1,[x,y],[cos(t)*cos(t),sin(t)*cos(t)],t,0,180)', 'degree', 'line-integral'],
    [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,-180],[180,180])`, 'degree', 'surface-integral'],
  ] as const)('%s（%s）は特殊角・周期・逆三角関数の厳密な値で閉じていることを確かめ、%s へ置き換える', (source, unit, operation) => {
    expect(prepareExactMathCalculation(parse(source), { resolve: () => null, angleUnit: unit }))
      .toMatchObject({ status: 'ready', expression: { kind: 'operation', operation } });
  });

  it.each([
    [`${CIRCLE},0,1)`, 'radian', 'domain', CLOSED_CURVE_OPEN],
    [`${CIRCLE},0,359)`, 'degree', 'domain', CLOSED_CURVE_OPEN],
    ['closedlineintegral(1,[x,y],[tan(t),t],t,0,90)', 'degree', 'domain', CLOSED_INTEGRAL_UNDEFINED],
    [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[180,359])`, 'degree', 'domain', CLOSED_SURFACE_OPEN],
  ] as const)('%s（%s）は準備処理で閉じていないことを示して断る', (source, unit, code, reason) => {
    const failure = problem(() => prepareExactMathCalculation(parse(source), { resolve: () => null, angleUnit: unit }));
    expect([failure.code, failure.message]).toEqual([code, reason]);
  });

  it('係数の値で閉じる・閉じないが変わり、保存した原式の再計算でも代入後の値で確かめる', async () => {
    const source = 'closedcirculation([-y,x],[x,y],[coef("半径")*cos(t),coef("半径")*sin(t)],t,0,coef("終点"))';
    const coefficients = (radius: string, end: string): Coefficients => [
      { id: 'radius', label: '半径', decimal: radius }, { id: 'end', label: '終点', decimal: end }];
    const inputs = [['2', '360'], ['1', '720'], ['1', '180']].map(([radius, end]) => request(source, 'degree', coefficients(radius, end)));
    const first = await Promise.all(inputs.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(2, input),
      { backend, engine, shouldStop: () => undefined })));
    const results = first.map((reply, index) => evaluation(reply, inputs[index], ['radius', 'end']));
    expect(results.map(result => result.evaluation)).toMatchObject([
      { status: 'value', kind: 'real', coordinate: 8 * Math.PI }, { status: 'value', kind: 'real', coordinate: 4 * Math.PI },
      { status: 'invalid', reason: 'domain', detail: CLOSED_CURVE_OPEN }]);
    const definition = results[0].definition;
    if (definition === null) throw new Error('保存する原式がありません。');
    expect(definition.source).toBe(source);
    // The saved formula is recalculated with the edited end point: half a turn is no longer closed.
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...inputs[2], definition })));
    const again = await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
    expect(again.evaluation).toEqual({ status: 'invalid', reason: 'domain', detail: CLOSED_CURVE_OPEN });
  }, 60_000);

  it('保存した原式と ∮・∯ の構造入力への往復から、同じ閉じた積分と同じ値を再計算する', async () => {
    const chosen = [[`${CIRCLE},0,360)`, 'degree'], ['∮([-y,x],[x,y],[cos(t),sin(t)],t,0,360)', 'degree'],
      [`closedsurfaceintegral(1,[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'degree'],
      [`closedfluxintegral([0,0,z],[x,y,z],${TORUS},[u,v],[0,0],[360,360])`, 'degree']] as const;
    const shown = chosen.map(([source, unit]): MathWorkRequest => ({ ...request(source, unit), presentationNotation: 'latex' }));
    const presented = await Promise.all(shown.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(4, input),
      { backend, engine, shouldStop: () => undefined })));
    const reopened = presented.flatMap((reply, index) => {
      const [source, unit] = chosen[index], input = request(source, unit);
      const result = evaluation(reply, shown[index]);
      if (result.definition === null || reply.expression === null || reply.presentation === undefined || reply.presentation === null) {
        throw new Error(JSON.stringify(reply));
      }
      expect(reply.evaluation).toEqual(replies[caseIndex(source, unit)].evaluation);
      expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
      expect(reply.presentation.source).toMatch(/^\\oi?int\\left\(/u);
      return [{ ...input, definition: result.definition },
        { ...input, source: reply.presentation.source, notation: 'latex' as const, definition: reply.presentation }]
        .map(value => ({ input: value, expected: reply.evaluation }));
    });
    const again = await Promise.all(reopened.map(({ input }) => {
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(5, input)));
      return executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
    }));
    again.forEach((reply, index) => { expect(reply.evaluation).toEqual(reopened[index].expected); });
  }, 60_000);

  it.each([
    [`${CIRCLE},0,360)`, 'closed-circulation', '∮'],
    ['closedlineintegral(1,[x,y,z],[cos(t),sin(t),t],t,0,360)', 'closed-line-integral', '∮'],
    [`closedsurfaceintegral(1,[x,y,z],${TORUS},[u,v],[0,0],[360,360])`, 'closed-surface-integral', '∯'],
    [`closedfluxintegral([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`, 'closed-flux-integral', '∯'],
  ])('%s を既存の積分と同じ形で読み、∮・∯ の通常入力と構造入力でも同じ演算に戻す', (source, operation, symbol) => {
    const node = parse(source);
    expect(node).toMatchObject({ kind: 'operation', operation, operands: [{ kind: 'binder', operation: 'lambda' },
      { kind: 'binder', operation: 'lambda' }, expect.anything(), expect.anything()] });
    const text = formatMathText(node, CANDIDATE_MATH_BY_ID), latex = toLatex(node);
    expect(text.startsWith(`${symbol}(`)).toBe(true);
    expect(latex.startsWith(symbol === '∮' ? String.raw`\oint\left(` : String.raw`\oiint\left(`)).toBe(true);
    for (const back of [parse(text), fromLatex(latex), fromLatex(`${symbol}${latex.slice(latex.indexOf(String.raw`\left(`))}`)]) {
      expect(back).toMatchObject({ kind: 'operation', operation });
      expect(sameMathMeaning(node, back)).toBe(true);
    }
  });

  it.each([
    ['closedcirculation(1,[x,y],[cos(t),sin(t)],t,0,360)', '仕事の線積分は座標変数と同じ数のベクトル成分を指定してください。'],
    ['closedlineintegral([1,2],[x,y],[cos(t),sin(t)],t,0,360)', '弧長による線積分には一つの数値になる場を指定してください。'],
    ['closedfluxintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[1,1])', '流束には3成分の場を、面積と体積の積分には一つの数値になる量を指定してください。'],
    ['closedsurfaceintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[1])', '座標式は3個、下限と上限は媒介変数と同じ個数で指定してください。'],
    ['∮(1,[x,y],[t],t,0,1)', '曲線の座標式は場の座標変数と同じ順序・個数で指定してください。'],
  ])('%s は読取りの時点で既存の積分と同じ理由で断る', (source, reason) => {
    expect(problem(() => parse(source)).message).toBe(reason);
  });

  it.each([['∮+1', 'text'], ['∯', 'text'], [String.raw`\oint_{C}x`, 'latex'],
    [String.raw`\oiiint\left(1,[x,y,z],[u,v,w],[u,v,w],[0,0,0],[1,1,1]\right)`, 'latex']] as const)(
    '%s（%s）は引数の一覧の無い記号と閉じた体積分なので、普通の積分として計算せず断る', (source, notation) => {
      const failure = problem(() => notation === 'text' ? parse(source) : fromLatex(source));
      expect([failure.code, failure.message]).toEqual(['unsupported', CLOSED_INTEGRAL_UNAVAILABLE]);
    });

  it('閉じた積分の結果は数値として型が決まり、「·」「×」を掛け算として読む', () => {
    for (const source of [`${CIRCLE},0,360)`, `∯([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`]) {
      expect(resolveTypedMathProduct('dot', [parse('2'), parse(source)], () => true)).toBe('multiply');
      expect(parse(`${source}×3`)).toMatchObject({ kind: 'operation', operation: 'multiply' });
    }
  });
});
