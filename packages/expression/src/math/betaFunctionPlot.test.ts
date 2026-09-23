import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { BETA_FUNCTION_REFERENCES } from './betaFunctionReferences.js';
import type { MathInterval } from './mathInterval.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', angleUnit,
    { axes: ['X','Y'], parameters: [], coefficients: [] }, backend), ['X','Y'], [], { backend, shouldStop: () => undefined });
}
function contains(range: MathInterval | null | undefined, expected: number): void {
  expect(range).not.toBeNull(); if (range === null || range === undefined) throw new Error('Missing enclosure');
  expect(range.lower).toBeLessThanOrEqual(expected); expect(range.upper).toBeGreaterThanOrEqual(expected);
}
const references = BETA_FUNCTION_REFERENCES.filter(([, , ...values]) =>
  values.every(text => Number.isFinite(Number(text)) && Number(text) !== 0));

describe('Betaの二変数作図と混合微分を元の正の範囲へ接続する', () => {
  it.each(references)('Beta(%s,%s)の値・一階・二階を独立な基準値で照合する', (a,b,value,da,db,daa,dbb,dab) => {
    const compiled = tape('beta(X,Y)'), inputs = [Number(a),Number(b)];
    expect(Math.abs(createScalarSampler(compiled)(inputs)/Number(value)-1)).toBeLessThan(5e-9);
    const box = inputs.map(x => ({ lower: x, upper: x }));
    for (const [direction,first,second] of [
      [[1,0],Number(da),Number(daa)], [[0,1],Number(db),Number(dbb)],
      [[1,1],Number(da)+Number(db),Number(daa)+2*Number(dab)+Number(dbb)],
    ] as const) {
      const jet = createScalarDirectionalJet(compiled,direction)(box);
      contains(jet.first,first); contains(jet.second,second);
    }
    if (Math.min(...inputs) >= 1e-8 && Math.max(...inputs) < 128) {
      const differential = createScalarDifferential(compiled)(inputs);
      expect(differential.reason).toBeNull();
      expect(Math.abs((differential.gradient?.[0] ?? NaN)/Number(da)-1)).toBeLessThan(5e-7);
      expect(Math.abs((differential.gradient?.[1] ?? NaN)/Number(db)-1)).toBeLessThan(5e-7);
    }
  });
  it('式の微分・合成・混合微分と角度を保つ', () => {
    expect(createScalarSampler(tape('diff(beta(X,Y),X)'))([1,1])).toBeCloseTo(-1,10);
    expect(createScalarSampler(tape('diff(beta(X,Y),Y)'))([1,1])).toBeCloseTo(-1,10);
    expect(createScalarSampler(tape('diff(beta(X,Y),X,Y)'))([1,1])).toBeCloseTo(2-Math.PI**2/6,10);
    const source = tape('beta(X^2+1,2*X+1)'), reference = references.find(([a,b]) => a==='2' && b==='3');
    if (reference === undefined) throw new Error('Missing independent Beta(2,3) derivatives');
    const jet = createScalarDirectionalJet(source,[1,0])([{lower:1,upper:1},{lower:0,upper:0}]);
    contains(jet.first,2*Number(reference[3])+2*Number(reference[4]));
    contains(jet.second,4*Number(reference[5])+8*Number(reference[7])+4*Number(reference[6])+2*Number(reference[3]));
    expect(createScalarSampler(tape('beta(sin(X),0.5)','degree'))([30,0])).toBeCloseTo(Math.PI,10);
  });
  it.each(['1','19999'])('非常に小さい1e-100と%sの微分も近い値の差で0へ消さない', b => {
    const reference = references.find(([a,y]) => a === '1e-100' && y === b);
    if (reference === undefined) throw new Error('Missing independent tiny-argument derivatives');
    const differential = createScalarDifferential(tape('beta(X,Y)'))([1e-100,Number(b)]);
    expect(differential.reason).toBeNull();
    expect(Math.abs((differential.gradient?.[0] ?? NaN)/Number(reference[3])-1)).toBeLessThan(5e-10);
    expect(Math.abs((differential.gradient?.[1] ?? NaN)/Number(reference[4])-1)).toBeLessThan(5e-10);
  });
  it('定数と幅のある二変数範囲を丸めた単点で代用しない', () => {
    const constant = createScalarIntervalSampler(tape('beta(0.5,0.5)+X'))([{lower:0,upper:0},{lower:0,upper:0}]);
    expect(constant.continuous).toBe(true); contains(constant.ranges[0],Math.PI);
    const box = createScalarIntervalSampler(tape('beta(X,Y)'))([{lower:1,upper:2},{lower:1,upper:3}]);
    expect(box.continuous).toBe(true); contains(box.ranges[0],1); contains(box.ranges[0],1/12);
  });
  it.each(['beta(X,Y)','0*beta(X,Y)','beta(X,Y)/beta(X,Y)','diff(beta(X,Y),X)',
    'diff(0*beta(X,Y),X)','diff(beta(X,Y),X,Y)'])('%sから元の0と負の領域を消さない', source => {
    const compiled = tape(source), sample = createScalarSampler(compiled), interval = createScalarIntervalSampler(compiled);
    for (const inputs of [[0,1],[1,0],[-1,1],[1,-1]]) {
      expect(Number.isFinite(sample(inputs))).toBe(false);
      expect(interval(inputs.map(x => ({lower:x-0.1,upper:x+0.1}))).continuous).toBe(false);
    }
  });
  it('合成の内側の穴と上限超過を作図の途中でも断る', () => {
    for (const source of ['beta(1/X,1)','diff(beta(1/X,1),X)']) {
      const compiled = tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([0,0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{lower:-1,upper:1},{lower:0,upper:0}]).continuous).toBe(false);
    }
    expect(Number.isFinite(createScalarSampler(tape('beta(X,Y)'))([20000,1e-100]))).toBe(false);
  });
});
