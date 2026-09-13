import { describe, expect, it } from 'vitest';
import { functionSurfacePlanarPairs } from './functionSurfacePlanarPairs.js';
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';
import type { Vec3Tuple } from '../types.js';

const square: FunctionSurfaceGeometrySpec = {vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],
  triangles:[[0,1,2],[0,2,3]],bounds:{minimum:[-10,-10,-10],maximum:[10,10,10]}};
describe('関数面の形を変えない平面対の統合',()=>{
  it.each([false,true])('傾いた平面の外周と面の向きを保つ（裏向き%s）',(reverse)=>{
    const input: FunctionSurfaceGeometrySpec={...square,vertices:[[0,0,0],[2,0,2],[2,2,6],[0,2,4]],
      triangles:reverse ? square.triangles.map(([a,b,c])=>[a,c,b] as const) : square.triangles};
    const result=functionSurfacePlanarPairs(input);
    expect(result).toHaveLength(1);
    const outline=result![0]; expect([...outline].sort()).toEqual([0,1,2,3]);
    // The removed edge is the internal diagonal; the four oriented exterior edges are unchanged.
    expect(outline.map((start,i)=>`${start},${outline[(i+1)%outline.length]}`).sort())
      .toEqual((reverse ? ['1,0','2,1','3,2','0,3'] : ['0,1','1,2','2,3','3,0']).sort());
  });
  it.each([Number.MIN_VALUE,2**-500,Number.EPSILON,0.5])('非零の折れ%sを丸めて消さない',(height)=>{
    const input={...square,vertices:[...square.vertices.slice(0,3),[0,2,height] as Vec3Tuple]};
    expect(functionSurfacePlanarPairs(input)).toEqual(square.triangles);
  });
  it.each([2**-500,2**400])('通常の外積が下溢れ/上溢れする縮尺%sでも同じ平面だけを統合する',(scale)=>{
    const vertices=square.vertices.map(([x,y]): Vec3Tuple=>[x*scale,y*scale,(x+2*y)*scale]);
    expect(functionSurfacePlanarPairs({...square,vertices})).toHaveLength(1);
    const crease: Vec3Tuple[]=[...vertices.slice(0,3),[vertices[3][0],vertices[3][1],vertices[3][2]+scale/2]];
    expect(functionSurfacePlanarPairs({...square,vertices:crease})).toEqual(square.triangles);
  });
  it.each([[0.75,0.25,0],[1,1,0],[3,1,0]] as const)('重なり・一直線・凹みを持つ外周を無理に四角形へしない（%s）',(x,y,z)=>{
    expect(functionSurfacePlanarPairs({...square,vertices:[...square.vertices.slice(0,3),[x,y,z]]})).toEqual(square.triangles);
  });
  it('一方しか使われない穴や切断の縁を埋めず、中止時に部分結果を渡さない',()=>{
    const vertices: Vec3Tuple[]=[...square.vertices,...square.vertices.map(([x,y,z]): Vec3Tuple=>[x+5,y,z])];
    const input: FunctionSurfaceGeometrySpec={...square,vertices,triangles:[...square.triangles,[4,5,6]]};
    const before=JSON.stringify(input), result=functionSurfacePlanarPairs(input);
    expect(result).toHaveLength(2); expect(result![1]).toEqual([4,5,6]);
    let checks=0;expect(functionSurfacePlanarPairs(input,()=>++checks>=2)).toBeNull();
    expect(JSON.stringify(input)).toBe(before);expect(functionSurfacePlanarPairs(input)).toEqual(result);
  });
});
