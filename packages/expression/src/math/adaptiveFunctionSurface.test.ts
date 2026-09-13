import { describe, expect, it } from 'vitest';
import { intervalUnion } from './mathIntervalUnion.js';
import { sampleFunctionSurface, type FunctionSurfaceOptions, type FunctionSurfaceEvaluator } from './adaptiveFunctionSurface.js';

const options: FunctionSurfaceOptions = { lower:[-1,-1], upper:[1,1], minimum:[-2,-2,-2], maximum:[2,2,2],
  tolerance:0.01,maximumSamples:10000,maximumCells:10000,maximumTriangles:10000,maximumDepth:8 };
const plane: FunctionSurfaceEvaluator = { point:([u,v])=>[u,v,0],
  enclosure:(a,b)=>[intervalUnion(a[0],b[0]),intervalUnion(a[1],b[1]),intervalUnion(0)],interpolationErrorBound:()=>0 };
describe('曲面生成のXYZ必須と資源・中止の境界', () => {
  it.each([0,1,2])('XYZの軸%sで欠落・非有限・同値・逆転を計算開始前に拒否する', axis => {
    let calls = 0;
    const never = () => { calls++; throw new Error('must not evaluate'); };
    for (const value of [NaN,Infinity,-Infinity,-2,-3]) {
      const upper: [number,number,number] = [2,2,2]; upper[axis]=value;
      expect(()=>sampleFunctionSurface({point:never,enclosure:never},{...options,maximum:upper})).toThrow(RangeError);
    }
    const missing: [number,number,number] = [-2,-2,-2]; Reflect.deleteProperty(missing,axis);
    expect(()=>sampleFunctionSurface({point:never,enclosure:never},{...options,minimum:missing})).toThrow(RangeError);
    expect(calls).toBe(0);
  });
  it.each(['samples','cells','triangles','subdivision'] as const)('%s上限で部分メッシュを完成として返さない', reason => {
    const modified = {...options,...(reason==='samples'?{maximumSamples:5}:reason==='cells'?{maximumCells:1}
      :reason==='triangles'?{maximumTriangles:4}:{maximumDepth:1})};
    if (reason==='samples'||reason==='triangles') {
      const refined = sampleFunctionSurface({...plane,interpolationErrorBound:(a,b)=>(b[0]-a[0])**2/10},modified);
      expect(refined).toMatchObject({status:'stopped',reason}); expect(refined).not.toHaveProperty('vertices');
    } else {
      const result = sampleFunctionSurface({...plane,interpolationErrorBound:()=>0.02},modified);
      expect(result).toMatchObject({status:'stopped',reason}); expect(result).not.toHaveProperty('triangles');
    }
  });
  it('取消、期限切れ、丸め限界では旧形も途中の形も返さず、次の依頼は実行できる', () => {
    for (const reason of ['cancelled','deadline'] as const) expect(sampleFunctionSurface(plane,{...options,shouldStop:()=>reason}))
      .toMatchObject({status:'stopped',reason});
    expect(sampleFunctionSurface({...plane,point:([u,v])=>[u,v,0.1]},options)).toMatchObject({status:'stopped',reason:'roundoff'});
    expect(sampleFunctionSurface(plane,options).status).toBe('ready');
  });
});
