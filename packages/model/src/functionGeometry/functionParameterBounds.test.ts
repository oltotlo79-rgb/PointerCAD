import {beforeAll,describe,expect,it} from 'vitest';
import {createMathBackend,readFunctionMathSource,type MathExecutionBackend} from '@pointercad/expression/math/worker';
import {expressionValueFromNumber} from '@pointercad/expression';
import {functionParameterBounds} from './functionParameterBounds.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
describe('U/Vの範囲を元の表示式と同じ構造で保存する',()=>{
  it.each(['-2','+2','-0.25','1e-3','-0'])('符号や指数を含む%sもWorkerで再読込できる',source=>{
    const value={source,display:source,value:Number(source)},range={min:value,max:expressionValueFromNumber(10)};
    const bounds=functionParameterBounds(range,range);if(bounds===undefined)throw new Error('Missing bounds');
    for(const saved of [...bounds.lower,...bounds.upper]){
      expect(readFunctionMathSource(saved,{axes:[],parameters:[],coefficients:[]},backend)).toEqual(saved);
    }
    expect(bounds.lower[0].source).toBe(source);
  });
  it('定義がない計算式を数値キャッシュへ置き換えない',()=>{
    const range={min:{source:'-2*π',display:'-6.28',value:-2*Math.PI},max:expressionValueFromNumber(10)};
    expect(functionParameterBounds(range,range)).toBeUndefined();
  });
});
