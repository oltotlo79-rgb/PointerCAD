import {beforeAll,describe,expect,it} from 'vitest';
import {loadOcctForNode} from './loadOcct.node.js';
import {makeFunctionSurfaceBodies} from './makeFunctionSurfaceBodies.js';
import {createAllocations} from './allocations.js';
import {hasSolid,isValidShape,measureArea,measureVolume} from './solidMesh.js';
import {FUNCTION_CLIP_BOUND_TOLERANCE,type FunctionClipBox} from './clipFunctionShape.js';
import type {FunctionSurfacePrimitive,FunctionSurfacePrimitiveSpec} from './functionSurfacePrimitiveSpec.js';

let oc:Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async()=>{oc=await loadOcctForNode();},180_000);
const bounds:FunctionClipBox={minimum:[-4,-4,-4],maximum:[4,4,4]};
function examine(primitive:FunctionSurfacePrimitive,limits:FunctionClipBox=bounds){
  const result=makeFunctionSurfaceBodies(oc,{primitive,bounds:limits});if(result.status!=='bodies') throw new Error(JSON.stringify(result));
  const allocations=createAllocations();
  try{return result.bodies.map(body=>{
    expect(isValidShape(oc,body.shape)).toBe(true);expect(hasSolid(oc,body.shape)).toBe(body.bodyKind==='solid');
    expect(measureArea(oc,body.shape)).toBeCloseTo(body.area,8);if(body.bodyKind==='solid') expect(measureVolume(oc,body.shape)).toBeCloseTo(body.volume,8);
    const box=allocations.keep(new oc.Bnd_Box_1());oc.BRepBndLib.AddOptimal(body.shape,box,false,false);box.SetGap(0);
    const low=allocations.keep(box.CornerMin()),high=allocations.keep(box.CornerMax());
    for(const [axis,min,max] of [[0,low.X(),high.X()],[1,low.Y(),high.Y()],[2,low.Z(),high.Z()]]){
      expect(min).toBeGreaterThanOrEqual(limits.minimum[axis]-FUNCTION_CLIP_BOUND_TOLERANCE);
      expect(max).toBeLessThanOrEqual(limits.maximum[axis]+FUNCTION_CLIP_BOUND_TOLERANCE);
    }
    return {kind:body.bodyKind,volume:body.volume,area:body.area};
  });}finally{allocations.release();result.delete();}
}
describe('陰関数の解析形状もXYZで面を切り、周期継ぎ目と極を正しく分類する',()=>{
  it('半径1の球の周期辺と退化極を開口にせず、体積4π/3の閉立体にする',()=>{
    const result=examine({kind:'sphere',center:[0.1,0.2,0.3],radius:1});expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({kind:'solid'});expect(result[0].volume).toBeCloseTo(4*Math.PI/3,8);expect(result[0].area).toBeCloseTo(4*Math.PI,8);
  });
  it('球をZで切ると面積2πの開いた半球となり、底面と体積を足さない',()=>{
    const result=examine({kind:'sphere',center:[0,0,0],radius:1},{minimum:[-2,-2,0],maximum:[2,2,2]});
    expect(result).toHaveLength(1);expect(result[0]).toMatchObject({kind:'shell',volume:0});expect(result[0].area).toBeCloseTo(2*Math.PI,8);
  });
  it.each([0,1,2] as const)('軸%sのトーラスは周期辺があっても閉立体で、体積π²を持つ',axis=>{
    const result=examine({kind:'torus',axis,majorRadius:2,minorRadius:0.5});expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('solid');expect(result[0].volume).toBeCloseTo(Math.PI**2,8);expect(result[0].area).toBeCloseTo(4*Math.PI**2,8);
  });
  it('トーラスを半分で切っても穴をふさがず、開いた面のまま残す',()=>{
    const result=examine({kind:'torus',axis:2,majorRadius:2,minorRadius:0.5},{minimum:[0,-4,-4],maximum:[4,4,4]});
    expect(result).toHaveLength(1);expect(result[0]).toMatchObject({kind:'shell',volume:0});expect(result[0].area).toBeCloseTo(2*Math.PI**2,7);
  });
  it('中止・範囲外・不正境界の後も所有を残さず同じ形を再作成する',()=>{
    const input:FunctionSurfacePrimitiveSpec={primitive:{kind:'sphere',center:[0,0,0],radius:1},bounds};
    expect(makeFunctionSurfaceBodies(oc,input,()=>true)).toEqual({status:'cancelled'});
    expect(makeFunctionSurfaceBodies(oc,{...input,bounds:{minimum:[2,2,2],maximum:[3,3,3]}})).toEqual({status:'empty'});
    expect(()=>makeFunctionSurfaceBodies(oc,{...input,bounds:{minimum:[0,0,0],maximum:[1,1,Infinity]}})).toThrow();
    expect(examine(input.primitive)[0].volume).toBeCloseTo(4*Math.PI/3,8);
  });
});
