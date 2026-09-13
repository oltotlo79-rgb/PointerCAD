import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeFunctionSurface } from './makeFunctionSurface.js';
import { classifyFunctionSurface } from './classifyFunctionSurface.js';
import { makeFunctionSurfaceBodies } from './makeFunctionSurfaceBodies.js';
import { hasSolid, isValidShape, measureArea, measureVolume } from './solidMesh.js';
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';
import type { Vec3Tuple } from '../types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
const bounds = { minimum: [-10,-10,-10] as const, maximum: [10,10,10] as const };
const triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]] as const;
function cube(low: number, high: number, offset: Vec3Tuple = [0,0,0]): FunctionSurfaceGeometrySpec {
  const vertices: Vec3Tuple[] = [[low,low,low],[high,low,low],[high,high,low],[low,high,low],
    [low,low,high],[high,low,high],[high,high,high],[low,high,high]];
  return { vertices: vertices.map(([x,y,z]) => [x+offset[0],y+offset[1],z+offset[2]]), triangles, bounds };
}
function together(...inputs: FunctionSurfaceGeometrySpec[]): FunctionSurfaceGeometrySpec {
  const vertices: Vec3Tuple[] = [], faces: [number,number,number][] = [];
  for (const input of inputs) {
    const offset = vertices.length; vertices.push(...input.vertices);
    faces.push(...input.triangles.map(([a,b,c]): [number,number,number] => [a+offset,b+offset,c+offset]));
  }
  return { vertices, triangles: faces, bounds };
}
function examine(input: FunctionSurfaceGeometrySpec) {
    const result = makeFunctionSurfaceBodies(oc,input);
    if (result.status !== 'bodies') throw new Error('Expected actual bounded bodies');
    try { return result.bodies.map(body => {
      expect(isValidShape(oc,body.shape)).toBe(true);
      expect(hasSolid(oc,body.shape)).toBe(body.bodyKind === 'solid');
      expect(measureArea(oc,body.shape)).toBeCloseTo(body.area,8);
      if (body.bodyKind === 'solid') expect(measureVolume(oc,body.shape)).toBeCloseTo(body.volume,8);
      return {kind:body.bodyKind,volume:body.volume,area:body.area};
    }); } finally { result.delete(); }
}
const body = (kind: 'solid' | 'shell', volume: number, area: number): { kind: 'solid' | 'shell'; volume: unknown; area: unknown } =>
  ({ kind, volume: expect.closeTo(volume,8), area: expect.closeTo(area,8) });

describe('XYZ切断後の関数面を実トポロジーから面・立体・空洞へ分類する', () => {
  it('全て同じ向きの三角形でも、星形の交差する境界は証明を通さず実交差検査で拒否する',()=>{
    const input:FunctionSurfaceGeometrySpec={vertices:[[0,0,0],[0,3,0],[-2,-3,0],[3,1,0],[-3,1,0],[2,-3,0]],
      triangles:[[0,1,2],[0,2,3],[0,3,4],[0,4,5],[0,5,1]],bounds};
    expect(()=>examine(input)).toThrow(/交差|重複|つながり/);
  });
  it('交差検査に統合された妥当性検査でも、曲面のない不正な実CAD面を拒否する',()=>{
    const face=new oc.TopoDS_Face(),builder=new oc.BRep_Builder();
    try{
      builder.MakeFace_1(face);
      expect(face.IsNull()).toBe(false);
      expect(isValidShape(oc,face)).toBe(false);
      expect(()=>classifyFunctionSurface(oc,face)).toThrow(/交差|重複|つながり/);
    }finally{builder.delete();face.delete();}
  });
  it('閉じた12三角形を体積8の1立体にし、裏向きでも正しい向きへ揃える', () => {
    const input = cube(-1,1);
    expect(examine(input)).toEqual([body('solid',8,24)]);
    const reversed = {...input,triangles:input.triangles.map(([a,b,c]): [number,number,number] => [a,c,b])};
    expect(examine(reversed)).toEqual([body('solid',8,24)]);
  });
  it('XYZで箱の表面を半分に切ると面積12の開面で、切断境界へ蓋を作らない', () => {
    expect(examine({...cube(-1,1),bounds:{minimum:[-2,-2,-2],maximum:[0,2,2]}}))
      .toEqual([body('shell',0,12)]);
  });
  it('面が1枚分欠けた箱を、体積値が出ることだけで立体にしない', () => {
    const input = cube(-1,1);
    expect(examine({...input,triangles:input.triangles.slice(2)})).toEqual([body('shell',0,20)]);
  });
  it('入れ子の閉面を空洞とし、さらに内側の島と離れた立体も保持する', () => {
    const result = examine(together(cube(-3,3),cube(-2,2),cube(-1,1),cube(-0.5,0.5,[6,0,0])));
    expect(result.map(body=>body.volume).sort((a,b)=>a-b)).toEqual([expect.closeTo(1,8),expect.closeTo(8,8),expect.closeTo(152,8)]);
    expect(result.reduce((sum,body)=>sum+body.area,0)).toBeCloseTo(342,8);
  });
  it('閉面と離れた開面を両方保持し、どちらかを捨てない', () => {
    const open = {...cube(-1,1,[5,0,0]),triangles:triangles.slice(0,2)};
    const result = examine(together(cube(-1,1),open));
    expect(result.filter(item=>item.kind==='solid')).toEqual([body('solid',8,24)]);
    expect(result.filter(item=>item.kind==='shell')).toEqual([body('shell',0,4)]);
  });
  it('重なって交差する閉面を空洞や独立した立体として採用しない', () => {
    expect(()=>examine(together(cube(-1,1),cube(-1,1,[0.5,0,0])))).toThrow(/交差|重複|つながり/);
  });
  it('取消時は部分立体を返さず、同じ面から続けて再生成できる', () => {
    const source = makeFunctionSurface(oc,cube(-1,1));
    if (source.status!=='shape') throw new Error('Expected faces');
    try {
      let count=0;
      expect(classifyFunctionSurface(oc,source.shape,()=>++count>=3)).toEqual({status:'cancelled'});
      const result=classifyFunctionSurface(oc,source.shape);
      if(result.status!=='bodies') throw new Error('Expected recovered bodies');
      try {expect(result.bodies[0].volume).toBeCloseTo(8,8);} finally {result.delete();}
    } finally {source.delete();}
  });
});
