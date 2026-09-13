import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { exactFunctionCurveBezier } from './exactFunctionCurveBezier.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';
import type { FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(formulas: readonly [string, string, string], independent: FunctionCurveWorkRequest['independent'] = 'X'): FunctionCurveWorkRequest {
  const coefficients = [{ id: 'scale', label: 'a', decimal: '0.1' }];
  const source = (text: string) => createFunctionMathSource(text, 'text', 'degree',
    { axes: independent === 'T' ? [] : [independent], parameters: independent === 'T' ? ['T'] : [], coefficients }, backend);
  return { identity: { documentId: 'bezier', documentVersion: 1, editorId: 'curve', inputRevision: 1 }, independent,
    outputs: [source(formulas[0]), source(formulas[1]), source(formulas[2])], coefficients,
    lower: 0, upper: 10, minimum: [0, 0, -1], maximum: [10, 10, 1], tolerance: 0.001 };
}
function value(points: readonly (readonly number[])[], u: number): number[] {
  // Direct Bernstein evaluation is independent of the production endpoint/derivative conversion.
  const weights = [(1-u)**3, 3*u*(1-u)**2, 3*u*u*(1-u), u**3];
  return [0,1,2].map(axis => weights.reduce((sum, weight, index) => sum + weight*points[index][axis], 0));
}
describe('原式から証明できる範囲内多項式だけを滑らかなCAD曲線へ変換', () => {
  it.each(['X^2/10', 'coef("a")*X^2'])('%sを点列補間せず再現し、4制御点の丸めを精度内へ収める', formula => {
    const input = request(['X', formula, '0']), controls = exactFunctionCurveBezier(input, () => false);
    expect(controls).not.toBeNull(); if (controls === null) throw new Error('Expected polynomial');
    for (let index = 0; index <= 100; index++) {
      const x = index/10, point = value(controls, index/100);
      expect(Math.hypot(point[0]-x, point[1]-x*x/10, point[2])).toBeLessThan(1e-12);
    }
  });
  it('Tの別区間と全3座標の三次多項式を再現する', () => {
    const input = { ...request(['T', 'T^2', 'T^3'], 'T'), lower: -2, upper: 3,
      minimum: [-3,-10,-20] as const, maximum: [4,10,30] as const };
    // Although T^3 itself stays above -10, its third control coordinate is -18.
    // Keep this original narrow box as an explicit conservative-fallback regression.
    expect(exactFunctionCurveBezier({...input,minimum:[-3,-10,-10]},()=>false)).toBeNull();
    const controls = exactFunctionCurveBezier(input, () => false); expect(controls).not.toBeNull();
    if (controls === null) throw new Error('Expected polynomial');
    for (let i=0;i<=100;i++) {
      const t=-2+5*i/100, point=value(controls,i/100);
      expect(Math.hypot(point[0]-t,point[1]-t*t,point[2]-t*t*t)).toBeLessThan(1e-12);
    }
  });
  it.each(['X^4', '1/X', 'X/X', '0*(1/X)', 'sin(X)', 'abs(X)', 'ln(X)', 'log(X,10)'])('%sの次数・定義域・角を勝手に変えない', formula => {
    expect(exactFunctionCurveBezier(request(['X', formula, '0']), () => false)).toBeNull();
  });
  it('底のないlog(X)は曲線生成へ進む前に入力契約で拒否する',()=>{
    expect(()=>request(['X','log(X)','0'])).toThrow('引数');
  });
  it('XYZを越える制御点は端へ丸めず既存の切断へ戻す', () => {
    const input=request(['X','X^2/10','0']);
    expect(exactFunctionCurveBezier({...input,maximum:[10,9,1]},()=>false)).toBeNull();
    expect(exactFunctionCurveBezier({...input,minimum:[0,0,0.5]},()=>false)).toBeNull();
  });
  it('必要精度以下の丸めを証明できない時、閉じた曲線、取消は変換しない', () => {
    const input=request(['X','X^2/10','0']);
    expect(exactFunctionCurveBezier({...input,tolerance:1e-30},()=>false)).toBeNull();
    expect(exactFunctionCurveBezier(request(['T*(10-T)','0','0'],'T'),()=>false)).toBeNull();
    expect(exactFunctionCurveBezier(input,()=>true)).toBeNull();
  });
  it('実Workerの原文照合・受信検査を通り、変更された返信から独立した4点を受け取る', () => {
    const input=request(['X','X^2/10','0']);
    const reply=executeFunctionCurveWorkRequest({kind:'sample-function-curve',serial:1,request:input},backend);
    const received=decodeFunctionCurveWorkReply(reply,input);
    if(received.result.status!=='ready') throw new Error('Expected ready');
    expect(received.result.bezier).toHaveLength(4);
    expect(Object.isFrozen(received.result.bezier?.[1])).toBe(true);
    if(reply.result.status!=='ready') throw new Error('Expected ready');
    const original = reply.result;
    const bad = [[], [[0,0,0],[1,0,0],[2,0,0],[11,0,0]], [[0,0,0],[1,NaN,0],[2,0,0],[10,0,0]],
      [[0,0,0],[1,0,0],[2,0,0],[0,0,0]]];
    for(const bezier of bad) expect(()=>decodeFunctionCurveWorkReply({...reply,result:{...reply.result,bezier}},input)).toThrow();
    expect(()=>decodeFunctionCurveWorkReply({...reply,result:{status:'empty',stats:{samples:0,cells:0},bezier:original.bezier}},input)).toThrow();
  });
});
