import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeFunctionSurface } from './makeFunctionSurface.js';
import { classifyFunctionSurface } from './classifyFunctionSurface.js';
import { clipFunctionSurfaceTriangles } from './clipFunctionSurfaceTriangles.js';
import { checkedFunctionSurface, type FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';
import type { Vec3Tuple } from '../types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async()=>{oc=await loadOcctForNode();},180_000);
function paraboloid(): FunctionSurfaceGeometrySpec {
  const count=32, vertices: Vec3Tuple[]=[], triangles:[number,number,number][]=[];
  for(let row=0;row<=count;row++) for(let column=0;column<=count;column++) {
    const x=-2+4*column/count,y=-2+4*row/count;vertices.push([x,y,x*x+y*y]);
  }
  for(let row=0;row<count;row++) for(let column=0;column<count;column++) {
    const a=row*(count+1)+column,b=a+1,c=b+count+1,d=c-1;triangles.push([a,b,c],[a,c,d]);
  }
  return {vertices,triangles,bounds:{minimum:[-2,-2,-2],maximum:[2,2,2]}};
}
describe('関数曲面の範囲切断では隣接面の共有辺を保つ',()=>{
  it('2,048枚の放物面をZ=2で切り、全座標・隣接関係と入力を保つ',()=>{
    const input=paraboloid(),before=JSON.stringify(input),result=clipFunctionSurfaceTriangles(input);
    if(result===null) throw new Error('Unexpected cancellation');
    expect(()=>checkedFunctionSurface(result)).not.toThrow();expect(result.triangles.length).toBeGreaterThan(100);
    for(const [x,y,z] of result.vertices) {
      expect(z).toBeLessThanOrEqual(2);expect(Math.abs(x)).toBeLessThanOrEqual(2);expect(Math.abs(y)).toBeLessThanOrEqual(2);
      expect(Math.abs(z-x*x-y*y)).toBeLessThanOrEqual(0.125**2/2+1e-12);
    }
    const edges=new Map<string,number>();
    for(const face of result.triangles) for(let index=0;index<3;index++) {
      const edge=[face[index],face[(index+1)%3]].sort((a,b)=>a-b).join(',');edges.set(edge,(edges.get(edge)??0)+1);
    }
    for(const [edge,count] of edges) if(count===1) {
      for(const vertex of edge.split(',').map(Number)) expect(result.vertices[vertex][2]).toBe(2);
    }else expect(count).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
    expect(clipFunctionSurfaceTriangles(input,()=>true)).toBeNull();
  });
  it('切断済みの放物面を1枚の開いたCADシェルにし、蓋や体積を作らない',()=>{
    const started=performance.now(),source=makeFunctionSurface(oc,paraboloid());
    console.log(`[実測] 放物面の範囲切断とCAD面作成: ${(performance.now()-started).toFixed(1)}ms`);
    if(source.status!=='shape') throw new Error('Expected clipped faces');
    try{
      const classificationStart=performance.now(),result=classifyFunctionSurface(oc,source.shape);
      console.log(`[実測] 放物面の交差・開閉確認: ${(performance.now()-classificationStart).toFixed(1)}ms`);
      if(result.status!=='bodies') throw new Error('Unexpected cancellation');
      try{expect(result.bodies).toHaveLength(1);expect(result.bodies[0]).toMatchObject({bodyKind:'shell',volume:0});}
      finally{result.delete();}
    }finally{source.delete();}
  },30_000);
});
