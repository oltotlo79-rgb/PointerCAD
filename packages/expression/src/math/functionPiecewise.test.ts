import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { compileScalarMath, compileScalarCondition, createScalarConditionSampler, createScalarSampler, type ScalarInput } from './scalarMathTape.js';
import { createScalarConditionIntervalSampler, createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionCurve } from './adaptiveFunctionCurve.js';
import { sampleFunctionSurface } from './adaptiveFunctionSurface.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { expandFunctionDerivatives } from './functionDerivatives.js';
import { decodeCurvePointWorkRequest } from './curvePointWorkRequest.js';
import { createCurvePointWorkEnvelope } from './curvePointWorkEnvelope.js';
import { executeCurvePointWorkRequest } from './curvePointWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const context = () => ({ backend, shouldStop: () => undefined });
function definition(source: string, inputs: readonly ScalarInput[] = ['X', 'Y']) {
  return createFunctionMathSource(source, 'text', 'radian', {
    axes: inputs.filter(input => input === 'X' || input === 'Y' || input === 'Z'),
    parameters: inputs.filter(input => input === 'T' || input === 'U' || input === 'V'), coefficients: [],
  }, backend);
}
function tape(source: string, inputs: readonly ScalarInput[] = ['X', 'Y']) {
  return compileFunctionScalar(definition(source, inputs), inputs, [], context());
}
const interval = (lower: number, upper = lower) => ({ lower, upper });

describe('関数作図の条件付きの枝と未定義領域', () => {
  it.each([
    ['which(X<0,X^2,true,X+3)', -2, 4],
    ['which(X<0,X^2,true,X+3)', 2, 5],
    ['which(X<0,1,true,2)', 0, 2],
    ['which(X<=0,1,true,2)', 0, 1],
    ['which(X>0,1,true,2)', 0, 2],
    ['which(X>=0,1,true,2)', 0, 1],
    ['which(X=0,1,X!=0,2)', 0, 1],
    ['which(X=0,1,X!=0,2)', -1, 2],
    ['which(X>=0,7,X>=-1,8,true,9)', 1, 7],
    ['which(and(X>=-2,X<=-1),4,or(X>1,X=0),6,true,8)', -1.5, 4],
    ['which(and(X>=-2,X<=-1),4,or(X>1,X=0),6,true,8)', 0, 6],
    ['which(not(X<0),5,true,9)', -1, 9],
    ['which(X<0,which(X<-1,2,true,3),true,4)', -0.5, 3],
    ['2+which(X<0,X^2,true,X)*3', -2, 14],
    ['which(X<0,sqrt(-X),true,sqrt(X))', -4, 2],
    ['which(X<0,sqrt(-X),true,sqrt(X))', 4, 2],
    ['which(X<0,1/0,true,X+1)', 1, 2],
    ['which(X<0,clamp(X,-2,2),true,X)', -4, -2],
    ['clamp(which(X<0,X,true,2*X),-2,2)', 4, 2],
  ])('%s の X=%s で選択した枝の値を返す', (source, x, expected) => {
    expect(createScalarSampler(tape(source))([x, 0])).toBeCloseTo(expected, 12);
  });

  it('繰り返す標本で前の枝の値や不成立を再利用しない', () => {
    const sample = createScalarSampler(tape('which(X<0,sqrt(-X),X>0,ln(X))'));
    expect(sample([-4, 0])).toBe(2);
    expect(sample([0, 0])).toBeNaN();
    expect(sample([1, 0])).toBe(0);
    expect(sample([-9, 0])).toBe(3);
  });

  it.each(['which(X<0,1)', 'which(X>=0,1/0,true,2)', '0*which(X>=0,1/0,true,2)',
    'which(1/X>0,1,true,2)'])('%s の不成立を値や後続の枝で埋めない', source => {
    expect(createScalarSampler(tape(source))([0, 0])).toBeNaN();
  });

  it('枝の中だけの区間はその枝の値域と連続性を返す', () => {
    const sample = createScalarIntervalSampler(tape('which(X<0,X^2,true,X+10)'));
    const negative = sample([interval(-2, -1), interval(0)]);
    expect(negative.continuous).toBe(true);
    expect(negative.ranges).toHaveLength(1);
    expect(negative.ranges[0].lower).toBeLessThanOrEqual(1);
    expect(negative.ranges[0].upper).toBeGreaterThanOrEqual(4);
    const positive = sample([interval(1, 2), interval(0)]);
    expect(positive.continuous).toBe(true);
    expect(positive.ranges[0].lower).toBeLessThanOrEqual(11);
    expect(positive.ranges[0].upper).toBeGreaterThanOrEqual(12);
  });

  it('境界をまたぐ区間の離れた値域を結合可能と認定しない', () => {
    const sample = createScalarIntervalSampler(tape('which(X<0,-2,true,3)'));
    expect(sample([interval(-1, 1), interval(0)])).toEqual({
      ranges: [interval(-2), interval(3)], continuous: false,
    });
    expect(sample([interval(0), interval(0)])).toEqual({ ranges: [interval(3)], continuous: true });
  });

  it('到達しない後続の枝の穴を区間の不成立にしない', () => {
    const sample = createScalarIntervalSampler(tape('which(X<1,2,true,sqrt(-1))'));
    expect(sample([interval(-2, 0), interval(0)])).toEqual({ ranges: [interval(2)], continuous: true });
  });

  it('定数の定義域違反はその枝が選ばれたときだけ不成立になる', () => {
    const compiled = tape('which(X<0,(-1)!,true,2)');
    const point = createScalarSampler(compiled), range = createScalarIntervalSampler(compiled);
    expect(point([1, 0])).toBe(2);
    expect(point([-1, 0])).toBeNaN();
    expect(range([interval(1, 2), interval(0)])).toEqual({ ranges: [interval(2)], continuous: true });
    expect(range([interval(-2, -1), interval(0)])).toEqual({ ranges: [], continuous: false });
  });

  it('定数の値が未確定なことを証明済みの空領域へ変換しない', () => {
    const expression = definition('which(X<0,1,true,2)').expression;
    expect(() => compileScalarMath(expression, { inputs: ['X', 'Y'], angleUnit: 'radian',
      evaluateConstant: () => { throw new MathInputProblem('domain', 'Unresolved constant'); },
    })).toThrow('Unresolved constant');
  });

  it('有限でない定数を返す計算部を有効な作図式として採用しない', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => compileScalarMath({ kind: 'number', decimal: '0' }, {
        inputs: ['X'], angleUnit: 'radian', evaluateConstant: () => value,
      })).toThrow('有限の実数');
    }
  });

  it('どの枝も成立しない区間を空として返す', () => {
    const sample = createScalarIntervalSampler(tape('which(X<-1,2,X>1,3)'));
    expect(sample([interval(-0.5, 0.5), interval(0)])).toEqual({ ranges: [], continuous: false });
    expect(sample([interval(-2, 2), interval(0)]).continuous).toBe(false);
  });

  it('比較の等号と不等号の点の値域を区別する', () => {
    const sample = createScalarIntervalSampler(tape('which(X=0,1,X!=0,2)'));
    expect(sample([interval(0), interval(0)])).toEqual({ ranges: [interval(1)], continuous: true });
    expect(sample([interval(1, 2), interval(0)])).toEqual({ ranges: [interval(2)], continuous: true });
    expect(sample([interval(-1, 1), interval(0)])).toEqual({ ranges: [interval(1), interval(2)], continuous: false });
  });

  it('かつ・またはの条件を区間でも先勝ちで評価する', () => {
    const sample = createScalarIntervalSampler(tape('which(and(X>=-2,X<=-1),4,or(X>1,X=0),6,true,8)'));
    expect(sample([interval(-1.8, -1.2), interval(0)])).toEqual({ ranges: [interval(4)], continuous: true });
    expect(sample([interval(2, 3), interval(0)])).toEqual({ ranges: [interval(6)], continuous: true });
    expect(sample([interval(-3, 3), interval(0)]).continuous).toBe(false);
  });

  it.each([
    ['diff(which(X<0,X^2,true,X^3),X)', -2, 4, -4],
    ['diff(which(X<0,X^2,true,X^3),X)', 2, 4, 12],
    ['diff(which(X<0,X^2,true,X^3),X,X)', -2, 4, 2],
    ['diff(which(X<0,X^2,true,X^3),X,X)', 2, 4, 12],
    ['diff(which(X<0,X*Y,true,X^2*Y),X,Y)', 2, 4, 4],
    ['which(X<0,diff(sqrt(-X),X),true,diff(sqrt(X),X))', -4, 0, -0.25],
    ['which(X<0,diff(sqrt(-X),X),true,diff(sqrt(X),X))', 4, 0, 0.25],
  ])('%s の枝内の導関数を保つ', (source, x, y, expected) => {
    expect(createScalarSampler(tape(source))([x, y])).toBeCloseTo(expected, 12);
  });

  it.each(['diff(which(X<0,X^2,true,X^3),X)', 'diff(which(X<=0,1,true,2),X)',
    'diff(which(X=0,1,true,X),X)', '0*diff(which(X<0,X,true,X),X)'])('%s の境界で導関数を捏造しない', source => {
    const compiled = tape(source);
    expect(createScalarSampler(compiled)([0, 0])).toBeNaN();
    expect(createScalarIntervalSampler(compiled)([interval(0), interval(0)])).toEqual({ ranges: [], continuous: false });
    expect(createScalarIntervalSampler(compiled)([interval(-1, 1), interval(0)]).continuous).toBe(false);
  });

  it('曲面の式も同じ枝・未定義領域を使う', () => {
    const source = 'which(X^2+Y^2<1,X+Y,X>2,4)';
    const evaluator = createFunctionSurfaceEvaluator([definition('X'), definition('Y'), definition(source)], ['X', 'Y'], [], context());
    expect(evaluator.point([0.25, 0.5])).toEqual([0.25, 0.5, 0.75]);
    expect(evaluator.point([1.5, 0])).toBeNull();
    expect(evaluator.point([3, 0])).toEqual([3, 0, 4]);
    expect(evaluator.enclosure([1.5, 0], [1.6, 0.1])[2]).toEqual({ ranges: [], continuous: false });
    expect(evaluator.enclosure([-2, -2], [3, 3])[2].continuous).toBe(false);
  });

  it('独立座標を指定した関数上の点にも選択した枝の値を渡す', () => {
    const outputs = ['X', 'which(X<0,X^2,true,X+2)', '0'].map(source => definition(source, ['X']));
    for (const [x, y] of [[-2, 4], [0, 2], [1, 3]]) {
      const request = decodeCurvePointWorkRequest({ kind: 'curve',
        identity: { documentId: 'piecewise', documentVersion: 1, editorId: 'point', inputRevision: 1 },
        independent: 'X', outputs, lower: -3, upper: 3, minimum: [-3, -1, -1], maximum: [3, 10, 1],
        tolerance: 1e-6, coefficients: [], known: [{ axis: 'X', value: x }],
      });
      const reply = executeCurvePointWorkRequest(createCurvePointWorkEnvelope(1, request), backend);
      expect(reply.result.status).toBe('ready');
      if (reply.result.status !== 'ready') throw new Error(JSON.stringify(reply));
      expect(reply.result.candidates).toHaveLength(1);
      expect(reply.result.candidates[0].point).toEqual([x, y, 0]);
    }
  });

  it('共有された枝の部分式でも微分の成立条件を別の枝へ流用しない', () => {
    const x: MathNode = { kind: 'symbol', reference: { role: 'axis', name: 'X' } };
    const y: MathNode = { kind: 'symbol', reference: { role: 'axis', name: 'Y' } };
    const body: MathNode = { kind: 'operation', operation: 'absolute', operands: [x] };
    const condition: MathNode = { kind: 'operation', operation: 'less', operands: [y, { kind: 'number', decimal: '0' }] };
    const expression: MathNode = { kind: 'operation', operation: 'differentiate', operands: [
      { kind: 'operation', operation: 'which', operands: [condition, body, { kind: 'constant', name: 'true' }, body] }, x,
    ] };
    const expanded = expandFunctionDerivatives(expression, ['X', 'Y'], 'radian');
    const compiled = compileScalarMath(expanded.expression, { inputs: ['X', 'Y'], angleUnit: 'radian',
      domainGuards: expanded.guards, evaluateConstant: node => {
        if (node.kind !== 'number') throw new Error('Expected a numeric literal');
        return Number(node.decimal);
      } });
    const sample = createScalarSampler(compiled);
    expect(sample([0, -1])).toBeNaN();
    expect(sample([0, 1])).toBeNaN();
    expect(sample([-2, 1])).toBe(-1);
  });

  it('根の等式を関数作図の数値へ変換しない', () => {
    expect(() => tape('X=0')).toThrow();
    expect(() => tape('X^2+Y^2=1')).toThrow();
  });

  it('条件付き範囲から使う入口も同じ比較と境界判定を返す', () => {
    const source = definition('X<=0');
    const condition = compileScalarCondition(source.expression, { inputs: ['X', 'Y'], angleUnit: 'radian',
      evaluateConstant: node => {
        if (node.kind !== 'number') throw new Error('Expected a numeric literal');
        return Number(node.decimal);
      } });
    const point = createScalarConditionSampler(condition), box = createScalarConditionIntervalSampler(condition);
    expect(point([0, 0])).toEqual({ truth: true, boundary: true });
    expect(box([interval(-2, -1), interval(0)])).toEqual({ truth: true, boundary: false, defined: true });
    expect(box([interval(-1, 1), interval(0)])).toEqual({ truth: null, boundary: true, defined: true });
    expect(box([interval(1, 2), interval(0)])).toEqual({ truth: false, boundary: false, defined: true });
  });

  it('真偽でない条件と不完全な枝をコンパイル時に拒否する', () => {
    expect(() => tape('which(X,1,true,2)')).toThrow();
    const axis: MathNode = { kind: 'symbol', reference: { role: 'axis', name: 'X' } };
    expect(() => compileScalarMath({ kind: 'operation', operation: 'which', operands: [axis] }, {
      inputs: ['X'], angleUnit: 'radian', evaluateConstant: () => 0,
    })).toThrow();
  });

  it('枝内の自動微分経路は選ばれた式の接線と曲率を返す', () => {
    const compiled = tape('which(X<0,X^2,true,X^3)');
    expect(createScalarDifferential(compiled)([2, 0])).toEqual({ value: 8, gradient: [12, 0], reason: null });
    const jet = createScalarDirectionalJet(compiled, [1, 0])([interval(1, 2), interval(0)]);
    expect(jet.first?.lower).toBeCloseTo(3, 12);
    expect(jet.first?.upper).toBeCloseTo(12, 12);
    expect(jet.second?.lower).toBeCloseTo(6, 12);
    expect(jet.second?.upper).toBeCloseTo(12, 12);
  });

  it('閉じた境界で曲線を分け、未定義の帯に橋を作らない', () => {
    const outputs = ['X', 'which(X<=-1,-2,X>=1,3)', '0'].map(source => definition(source, ['X']));
    const evaluator = createFunctionCurveEvaluator([outputs[0], outputs[1], outputs[2]], 'X', [], context());
    const result = sampleFunctionCurve(evaluator, {
      lower: -2, upper: 2, minimum: [-3, -4, -1], maximum: [3, 4, 1],
      tolerance: 0.02, maximumSamples: 2000, maximumCells: 4000, maximumDepth: 30,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components.map(component => [component[0].parameter, component.at(-1)?.parameter]))
      .toEqual([[-2, -1], [1, 2]]);
    expect(result.components[0].every(sample => sample.parameter <= -1 && sample.point[1] === -2)).toBe(true);
    expect(result.components[1].every(sample => sample.parameter >= 1 && sample.point[1] === 3)).toBe(true);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });

  it('一つの枝の範囲では曲線を作り、全不成立の範囲では形を作らない', () => {
    const outputs = ['X', 'which(X<0,X^2)', '0'].map(source => definition(source, ['X']));
    const evaluator = createFunctionCurveEvaluator([outputs[0], outputs[1], outputs[2]], 'X', [], context());
    const options = { lower: -2, upper: -1, minimum: [-3, -1, -1] as const, maximum: [3, 5, 1] as const,
      tolerance: 0.02, maximumSamples: 2000, maximumCells: 4000, maximumDepth: 30 };
    const result = sampleFunctionCurve(evaluator, options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);
    for (const component of result.components) for (const sample of component) {
      expect(sample.point).toEqual([sample.parameter, sample.parameter ** 2, 0]);
    }
    expect(sampleFunctionCurve(evaluator, { ...options, lower: 1, upper: 2 }).status).toBe('empty');
  });

  it('極で分かれる二つの枝を別々の曲線として作図する', () => {
    const outputs = ['X', 'which(X<0,1/X,X>0,1/X+1)', '0'].map(source => definition(source, ['X']));
    const evaluator = createFunctionCurveEvaluator([outputs[0], outputs[1], outputs[2]], 'X', [], context());
    const result = sampleFunctionCurve(evaluator, {
      lower: -2, upper: 2, minimum: [-3, -5, -1], maximum: [3, 5, 1],
      tolerance: 0.02, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components[0].every(sample => sample.parameter < 0)).toBe(true);
    expect(result.components[1].every(sample => sample.parameter > 0)).toBe(true);
    for (const component of result.components) for (let index = 1; index < component.length; index++) {
      const a = component[index - 1], b = component[index];
      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = a.parameter + fraction * (b.parameter - a.parameter);
        const y = a.point[1] + fraction * (b.point[1] - a.point[1]);
        expect(Math.abs(y - (1 / x + (x > 0 ? 1 : 0)))).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('場合分けのない式の値・区間・命令列を変えない', () => {
    const compiled = tape('X^2+2*X+Y');
    expect(compiled.instructions.some(instruction => instruction.kind === 'piecewise')).toBe(false);
    expect(createScalarSampler(compiled)([2, 3])).toBe(11);
    expect(createScalarIntervalSampler(compiled)([interval(1, 2), interval(3)])).toMatchObject({ continuous: true });
    expect(createScalarDifferential(compiled)([2, 3])).toMatchObject({ value: 11, gradient: [6, 1] });
  });
});

describe('場合分けの境界と自動微分（MC-22a2）', () => {
  it.each([
    ['which(X<0,X^2,true,X^3)', -2, 3, 4, [-4, 0]],
    ['which(X<0,X^2,true,X^3)', 2, 3, 8, [12, 0]],
    ['which(X<0,X*Y,true,X^2*Y)', -2, 3, -6, [3, -2]],
    ['which(X<0,X*Y,true,X^2*Y)', 2, 3, 12, [12, 4]],
    ['2*which(X<0,which(Y<0,X*Y,true,X^2),true,X)', -2, -3, 12, [-6, -4]],
    ['which(X<1,X^2,X<0,sqrt(-1),true,X)', -2, 3, 4, [-4, 0]],
  ] as const)('%s の枝内で値と全座標のgradientを返す', (source, x, y, value, gradient) => {
    expect(createScalarDifferential(tape(source))([x, y])).toEqual({ value, gradient, reason: null });
  });

  it.each(['X<0', 'X<=0', 'X>0', 'X>=0', 'X=0', 'X!=0'])('%s の境界のgradientは理由付きで未定義になる', condition => {
    expect(createScalarDifferential(tape(`which(${condition},X^2,true,X^3)`))([0, 1]))
      .toMatchObject({ gradient: null, reason: 'nonsmooth' });
  });

  it.each([[-2, -1, -4, -2, 2, 2], [1, 2, 3, 12, 6, 12]])('区間[%s,%s]の枝の一階・二階微分を包む', (lower, upper, firstLow, firstHigh, secondLow, secondHigh) => {
    const jet = createScalarDirectionalJet(tape('which(X<0,X^2,true,X^3)'), [1, 0])([interval(lower, upper), interval(0)]);
    expect(jet.first?.lower).toBeLessThanOrEqual(firstLow);
    expect(jet.first?.upper).toBeGreaterThanOrEqual(firstHigh);
    expect(jet.second?.lower).toBeLessThanOrEqual(secondLow);
    expect(jet.second?.upper).toBeGreaterThanOrEqual(secondHigh);
  });

  it.each([[0, 0], [-1, 0], [0, 1], [-1, 1]])('境界を含む区間[%s,%s]のjetを理由付きで未定義にする', (lower, upper) => {
    expect(createScalarDirectionalJet(tape('which(X<=0,X^2,true,X^3)'), [1, 0])([interval(lower, upper), interval(0)]))
      .toEqual({ first: null, second: null, reason: 'piecewise-boundary' });
  });

  function curve(source: string, lower = -2, upper = 2) {
    const outputs = ['X', source, '0'].map(value => definition(value, ['X']));
    return sampleFunctionCurve(createFunctionCurveEvaluator([outputs[0], outputs[1], outputs[2]], 'X', [], context()), {
      lower, upper, minimum: [-3, -10, -1], maximum: [3, 10, 1], tolerance: 0.02,
      maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 30,
    });
  }

  it.each(['<', '<=', '>', '>='])('曲線の%s境界を正しい枝だけへ含め、ジャンプを線で結ばない', comparison => {
    const result = curve(`which(X${comparison}0,-2,true,3)`);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    const zeroY = comparison.includes('=') ? -2 : 3;
    expect(result.components.flat().filter(sample => sample.parameter === 0).map(sample => sample.point[1])).toEqual([zeroY]);
    for (const component of result.components) expect(new Set(component.map(sample => sample.point[1])).size).toBe(1);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });

  it('閉じた両端を持つ枝と未定義の帯を分離して返す', () => {
    const result = curve('which(X<=-1,-2,X>=1,3)');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components.map(component => [component[0].parameter, component.at(-1)?.parameter])).toEqual([[-2, -1], [1, 2]]);
    expect(result.components[0].every(sample => sample.point[1] === -2)).toBe(true);
    expect(result.components[1].every(sample => sample.point[1] === 3)).toBe(true);
  });

  it('開いた両端と非二進分割点の枝を分離する', () => {
    const result = curve('which(X< -0.75,-2,X>1.25,3)');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components[0].at(-1)?.parameter).toBeLessThan(-0.75);
    expect(result.components[1][0].parameter).toBeGreaterThan(1.25);
  });

  it('orによる区間の和集合と入れ子の枝を分ける', () => {
    const result = curve('which(or(X< -1,X>1),which(X<0,-2,true,3))');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components[0].every(sample => sample.parameter < -1 && sample.point[1] === -2)).toBe(true);
    expect(result.components[1].every(sample => sample.parameter > 1 && sample.point[1] === 3)).toBe(true);
    expect(curve('which(X< -1,-2,X>1,3)', -0.5, 0.5).status).toBe('empty');
  });

  it('二進数で厳密に表せない小数の境界も包絡区間の外で枝を分ける', () => {
    const result = curve('which(X<=0.1,-2,X>=0.3,3)');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components[0].at(-1)?.parameter).toBeLessThan(0.1);
    expect(result.components[1][0].parameter).toBeGreaterThan(0.3);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.02);
  });

  it('枝内の曲率で放物線の線分誤差を証明する', () => {
    const result = curve('which(X<0,X^2,true,X^2+1)');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    for (const component of result.components) for (let i = 1; i < component.length; i++) {
      const a = component[i - 1], b = component[i];
      const x = a.parameter / 2 + b.parameter / 2;
      expect(Math.abs((a.point[1] + b.point[1]) / 2 - (x * x + (x >= 0 ? 1 : 0)))).toBeLessThanOrEqual(0.02);
    }
  });

  it.each([
    ['which(X<0,-2,true,3)', 0],
    ['which(X<=0,-2,true,3)', 0],
    ['which(Y<0,-2,true,3)', 1],
    ['which(X<=-1,-2,X>=1,3)', 0],
    ['which(X<=-0.1,-2,X>=0.3,3)', 0],
    ['which(and(X<=-0.5,Y<=-0.5),-2,and(X>=0.5,Y>=0.5),3)', 0],
  ] as const)('曲面%sの各三角形が一つの枝に属する', (source, axis) => {
    const evaluator = createFunctionSurfaceEvaluator([definition('X'), definition('Y'), definition(source)], ['X', 'Y'], [], context());
    const result = sampleFunctionSurface(evaluator, { lower: [-2, -2], upper: [2, 2], minimum: [-3, -3, -4], maximum: [3, 3, 4],
      tolerance: 0.02, maximumSamples: 20_000, maximumCells: 40_000, maximumTriangles: 20_000, maximumDepth: 16 });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.triangles.length).toBeGreaterThanOrEqual(4);
    for (const face of result.triangles) {
      const vertices = face.map(index => result.vertices[index]);
      expect(new Set(vertices.map(vertex => vertex.point[2])).size).toBe(1);
      for (const vertex of vertices) expect(evaluator.point(vertex.parameters)).toEqual(vertex.point);
      const coordinates = vertices.map(vertex => vertex.parameters[axis]);
      expect(Math.min(...coordinates) < 0 && Math.max(...coordinates) > 0).toBe(false);
    }
    expect(result.maximumInterpolationErrorBound).toBeLessThanOrEqual(0.02);
  });

  it('曲面でどの枝も成立しない領域から面を生成しない', () => {
    const evaluator = createFunctionSurfaceEvaluator([definition('X'), definition('Y'), definition('which(X<-1,2,X>1,3)')], ['X', 'Y'], [], context());
    expect(sampleFunctionSurface(evaluator, { lower: [-0.5, -1], upper: [0.5, 1], minimum: [-2, -2, -4], maximum: [2, 2, 4],
      tolerance: 0.02, maximumSamples: 1000, maximumCells: 1000, maximumTriangles: 1000, maximumDepth: 12 }).status).toBe('empty');
  });

  it('開端点の移動が空間精度を超える曲線を完成扱いにしない', () => {
    const outputs = ['X', 'which(X<0,1e308*X,true,1)', '0'].map(value => definition(value, ['X']));
    const evaluator = createFunctionCurveEvaluator([outputs[0], outputs[1], outputs[2]], 'X', [], context());
    const result = sampleFunctionCurve(evaluator, { lower: -10 * Number.MIN_VALUE, upper: 10 * Number.MIN_VALUE,
      minimum: [-1, -2, -1], maximum: [1, 2, 1], tolerance: 1e-20,
      maximumSamples: 1000, maximumCells: 1000, maximumDepth: 30 });
    expect(result.status).toBe('stopped');
    expect(result).not.toHaveProperty('components');
  });

  it('曲線の境界でXYZ範囲外と証明できた枝を除き、範囲内の枝を返す', () => {
    const result = curve('which(X<0,-20,true,3)');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);
    expect(result.components[0].map(sample => [sample.parameter, sample.point[1]])).toEqual([[0, 3], [2, 3]]);
  });

  it('曲面の境界でXYZ範囲外と証明できた枝を除き、範囲内の枝を返す', () => {
    const evaluator = createFunctionSurfaceEvaluator([definition('X'), definition('Y'), definition('which(X<0,-20,true,3)')], ['X', 'Y'], [], context());
    const result = sampleFunctionSurface(evaluator, { lower: [-1, -1], upper: [1, 1], minimum: [-2, -2, -4], maximum: [2, 2, 4],
      tolerance: 0.02, maximumSamples: 1000, maximumCells: 1000, maximumTriangles: 1000, maximumDepth: 12 });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.triangles).toHaveLength(2);
    expect(result.vertices.every(vertex => vertex.parameters[0] >= 0 && vertex.point[2] === 3)).toBe(true);
  });

  it('開端点の移動が空間精度を超える曲面を完成扱いにしない', () => {
    const evaluator = createFunctionSurfaceEvaluator([definition('X'), definition('Y'), definition('which(X<0,1e308*X,true,1)')], ['X', 'Y'], [], context());
    const result = sampleFunctionSurface(evaluator, { lower: [-10 * Number.MIN_VALUE, -1], upper: [10 * Number.MIN_VALUE, 1],
      minimum: [-1, -2, -2], maximum: [1, 2, 2], tolerance: 1e-20,
      maximumSamples: 1000, maximumCells: 1000, maximumTriangles: 1000, maximumDepth: 12 });
    expect(result.status).toBe('stopped');
    expect(result).not.toHaveProperty('triangles');
  });
});
