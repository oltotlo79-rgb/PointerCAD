import { describe, expect, it } from 'vitest';
import { hasSimpleFunctionSurfaceProjection } from './functionSurfaceProjection.js';
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';

const bounds={minimum:[-20,-20,-20] as const,maximum:[20,20,20] as const};
function grid():FunctionSurfaceGeometrySpec {
  const vertices:[number,number,number][]=[],triangles:[number,number,number][]=[];
  for(let y=0;y<5;y++)for(let x=0;x<5;x++)vertices.push([x,y,x*x/8-y*y/10]);
  for(let y=0;y<4;y++)for(let x=0;x<4;x++){const a=y*5+x;triangles.push([a,a+1,a+6],[a,a+6,a+5]);}
  return {vertices,triangles,bounds};
}

describe('有限な三角形列の単純な投影から交差がないことを証明する',()=>{
  it('サドルの全3軸の向きと逆向き、平行移動でも成立する',()=>{
    const input=grid();
    for(const axis of [0,1,2])for(const reversed of [false,true]) {
      const vertices=input.vertices.map((point):[number,number,number]=>[point[axis]+2,point[(axis+1)%3]-3,point[(axis+2)%3]+1]);
      const triangles=input.triangles.map(([a,b,c]):[number,number,number]=>reversed?[a,c,b]:[a,b,c]);
      expect(hasSimpleFunctionSurfaceProjection({vertices,triangles,bounds})).toBe(true);
    }
  });
  it('内側の面の反転・重複面・接続の穴・座標の重複を証明済みにしない',()=>{
    const input=grid(),triangles=[...input.triangles];triangles[12]=[12,13,7];
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles})).toBe(false);
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles:[...input.triangles,input.triangles[0]]})).toBe(false);
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles:input.triangles.filter((_,i)=>i!==12)})).toBe(false);
    const vertices=[...input.vertices];vertices[12]=vertices[11];
    expect(hasSimpleFunctionSurfaceProjection({...input,vertices})).toBe(false);
  });
  it('境界が交差する扇形と、投影が折り返す面には従来の検査を要求する',()=>{
    const star:FunctionSurfaceGeometrySpec={vertices:[[0,0,0],[0,3,0],[-2,-3,0],[3,1,0],[-3,1,0],[2,-3,0]],
      triangles:[[0,1,2],[0,2,3],[0,3,4],[0,4,5],[0,5,1]],bounds};
    expect(hasSimpleFunctionSurfaceProjection(star)).toBe(false);
    const input=grid(),vertices=input.vertices.map(([x,y]):[number,number,number]=>[x>2?4-x:x,y,0]);
    expect(hasSimpleFunctionSurfaceProjection({...input,vertices})).toBe(false);
  });
  it('分離した2枚、共有頂点だけの接続、極小の面、途中取消を証明済みにしない',()=>{
    const input=grid();
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles:[input.triangles[0],input.triangles[30]]})).toBe(false);
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles:[input.triangles[0],input.triangles[10]]})).toBe(false);
    expect(hasSimpleFunctionSurfaceProjection({...input,vertices:input.vertices.map(p=>[p[0]*1e-8,p[1]*1e-8,p[2]*1e-8])})).toBe(false);
    expect(hasSimpleFunctionSurfaceProjection(input,()=>true)).toBe(false);
  });
  it('単純な非凸境界は許可し、境界の折り返しは許可しない',()=>{
    const input=grid(),triangles=input.triangles.filter((_,i)=>i<24 || i<26 || i>29);
    expect(hasSimpleFunctionSurfaceProjection({...input,triangles})).toBe(true);
  });
});
