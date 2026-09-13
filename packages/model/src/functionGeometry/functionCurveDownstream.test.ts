import { beforeAll, describe, expect, it } from 'vitest';
import { expectWithinBudget } from '@pointercad/test-utils';
import { createFunctionMathSource, createMathBackend, executeFunctionCurveWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { createFunctionCurveWorkEnvelope, decodeFunctionCurveWorkReply } from '@pointercad/expression/math/contracts';
import { createKernelApi, hasSolid, isValidShape, makeSweep, measureVolume, type FunctionClipBox } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, toCurveSpec } from '../kernelBridge.js';
import { FunctionPlotBounds } from './functionPlotBounds.js';
import { sampleFunctionCurveGeometry } from './sampleFunctionCurveGeometry.js';

let backend: MathExecutionBackend, oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async()=>{ backend=createMathBackend();oc=await loadOcctForNode(); },180_000);
describe('関数曲線を通常のスイープの経路へ渡す（ADD-5）',()=>{
  it.each([
    {name:'XYZで切り取った直線',formula:'0',end:50,radius:2,length:50},
    {name:'放物線',formula:'X^2/10',end:10,radius:0.1,length:5*Math.sqrt(5)+2.5*Math.asinh(2)},
  ])('$nameが断面積×独立した経路長の体積を持つ実立体になる',async({name,formula,end,radius,length})=>{
    const limits: FunctionClipBox={minimum:[0,-1,-1],maximum:[end,11,1]};
    const checked=FunctionPlotBounds.read({X:{min:limits.minimum[0],max:limits.maximum[0]},
      Y:{min:limits.minimum[1],max:limits.maximum[1]},Z:{min:limits.minimum[2],max:limits.maximum[2]}});
    if(!checked.ok) throw new Error(JSON.stringify(checked));
    const source=(text:string)=>createFunctionMathSource(text,'text','degree',{axes:['X'],parameters:[],coefficients:[]},backend);
    const sampled=await sampleFunctionCurveGeometry('path',{kind:'coordinate-curve',independent:'X',outputs:{Y:source(formula),Z:source('0')}},
      {bounds:checked.bounds,tolerance:0.001,parameters:[],fixedCoordinate:null},
      {coefficients:[],identity:{documentId:'downstream',documentVersion:1,editorId:'function',inputRevision:1}},
      {curves:{evaluate:(request)=>{
        const reply=decodeFunctionCurveWorkReply(executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(1,request),backend),request);
        return Promise.resolve({status:'result',identity:reply.identity,result:reply.result});
      }}},undefined,()=>true);
    if(sampled===null) throw new Error('Cancelled sampling');
    expect(sampled.bezier).toHaveLength(4);
    const bridge=createDirectKernelBridge(createKernelApi(()=>Promise.resolve(oc)));
    try{
      const path=await bridge.functionSketchCurves(sampled);
      if(path.status!=='ready') throw new Error(JSON.stringify(path));
      const stages: Record<string,number>={};
      const started=performance.now();
      const sweep=makeSweep(oc,{profile:[{kind:'arc',center:[0,0,0],normal:[1,0,0],xAxis:[0,1,0],radius,startAngle:0,endAngle:2*Math.PI}],
        path:path.curves.map(toCurveSpec),frenet:true},(stage,elapsed)=>{stages[stage]=elapsed;});
      try{
        const elapsed=performance.now()-started;
        console.log(`[実測] 関数${name}のスイープ: ${elapsed.toFixed(1)}ms / 上限500ms`);
        console.log(JSON.stringify({points:path.curves.map(curve=>curve.points.length),stages}));
        expect(isValidShape(oc,sweep.shape)).toBe(true);expect(hasSolid(oc,sweep.shape)).toBe(true);
        expect(Math.abs(measureVolume(oc,sweep.shape)/(Math.PI*radius*radius*length)-1)).toBeLessThan(0.005);
        expectWithinBudget(elapsed,500,`関数${name}のスイープ`);
      }finally{sweep.delete();}
    }finally{bridge.dispose();}
  },30_000);
});
