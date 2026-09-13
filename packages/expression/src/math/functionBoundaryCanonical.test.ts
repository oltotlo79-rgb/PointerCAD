import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { functionBoundaryKey } from './functionBoundaryCanonical.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const scope = { axes: [], parameters: ['U','V'] as const, coefficients: [{ id:'coefficient:1',label:'上昇' }] };
const source = (value: string, unit: 'degree' | 'radian' = 'radian') => createFunctionMathSource(value,'text',unit,scope,backend);
function key(expression: string, unit: 'degree' | 'radian', fixed: Readonly<Record<string,string>>, coefficient = '1') {
  const formula = source(expression,unit);
  return functionBoundaryKey(formula.expression,unit,reference => {
    if (reference.role === 'coefficient') return { expression: { kind:'number',decimal:coefficient },angleUnit:'radian' };
    if (reference.role !== 'parameter' || fixed[reference.name] === undefined) return null;
    return source(fixed[reference.name],unit);
  });
}
describe('媒介面の周期境界と極を浮動値でなく式として比較する', () => {
  it.each(['radian','degree'] as const)('%sの球で一周と両極を厳密に比較する', unit => {
    const full = unit === 'radian' ? '2*pi' : '360', half = unit === 'radian' ? 'pi' : '180';
    for (const expression of ['sin(V)*cos(U)','sin(V)*sin(U)','cos(V)']) {
      expect(key(expression,unit,{U:'0'})).toBe(key(expression,unit,{U:full}));
      for (const v of ['0',half]) expect(key(expression,unit,{V:v})).toBe(key(expression,unit,{U:'17',V:v}));
    }
  });
  it('トーラスの両方向と位相のずれた正弦を一致させる', () => {
    for (const expression of ['(2+cos(V))*cos(U)','(2+cos(V))*sin(U)','sin(V)']) {
      expect(key(expression,'radian',{U:'0'})).toBe(key(expression,'radian',{U:'2*pi'}));
      expect(key(expression,'radian',{V:'0'})).toBe(key(expression,'radian',{V:'2*pi'}));
    }
    expect(key('sin(U+V)','radian',{U:'0'})).toBe(key('sin(U+V)','radian',{U:'2*pi'}));
  });
  it.each(['0.001','1e-100'])('上昇%sを含む一周を接続せず、近さや桁落ちで同一視しない', coefficient => {
    expect(key('V+coef("上昇")*U','radian',{U:'0'},coefficient))
      .not.toBe(key('V+coef("上昇")*U','radian',{U:'2*pi'},coefficient));
    expect(key('cos(U)','radian',{U:'0'})).not.toBe(key('cos(U)','radian',{U:`2*pi+${coefficient}`}));
  });
  it('式本体と境界の角度単位を混同しない', () => {
    const formula = source('U');
    const at = (unit: 'degree'|'radian') => functionBoundaryKey(formula.expression,'radian',()=>source('cos(180)',unit));
    expect(at('degree')).toBe('q:-1/1'); expect(at('radian')).not.toBe(at('degree'));
  });
  it('数値として近い有理数とpiを混同せず、未確定の束縛式を証明に使わない', () => {
    expect(key('U','radian',{U:'pi'})).not.toBe(key('U','radian',{U:'3.141592653589793'}));
    expect(functionBoundaryKey({kind:'binder',operation:'integrate',body:{kind:'number',decimal:'0'},bindings:[]},'radian',()=>null)).toBeNull();
  });
});
