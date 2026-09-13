import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { buildImplicitGrid, type ImplicitGridOptions, type ImplicitGridResult } from './implicitGrid.js';
import { meshImplicitTetrahedra, type ImplicitMesh } from './implicitTetrahedra.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(()=>{ backend=createMathBackend(); });
const options:ImplicitGridOptions = {minimum:[-2,-2,-2],maximum:[2,2,2],tolerance:0.5,
  maximumSamples:200_000,maximumCells:400_000,maximumTriangles:200_000,maximumDepth:12};
function grid(source:string, changes:Partial<ImplicitGridOptions>={}):ImplicitGridResult {
  const definition=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
  return buildImplicitGrid(createFunctionImplicitEvaluator(definition,[],{backend,shouldStop:()=>undefined}),{...options,...changes});
}
function mesh(source:string, changes:Partial<ImplicitGridOptions>={}):ImplicitMesh {
  const sampled=grid(source,changes); if(sampled.status!=='ready') throw new Error(JSON.stringify(sampled));
  expect(sampled.maximumCellDiameter).toBeLessThanOrEqual(changes.tolerance ?? options.tolerance);
  const definition=createFunctionMathSource(source,'text','radian',{axes:['X','Y','Z'],parameters:[],coefficients:[]},backend);
  const evaluator=createFunctionImplicitEvaluator(definition,[],{backend,shouldStop:()=>undefined});
  const result=meshImplicitTetrahedra(sampled.cells,{maximumVertices:200_000,maximumTriangles:200_000,tolerance:changes.tolerance??options.tolerance,
    regularRegion:(minimum,maximum)=>evaluator.enclosure(minimum,maximum).continuous && evaluator.partials(minimum,maximum).some(value=>value!==null && (value.lower>0 || value.upper<0))});
  if(result.status!=='ready') throw new Error(JSON.stringify(result)); return result.mesh;
}
function edgeCounts(mesh:ImplicitMesh):readonly {readonly count:number;readonly orientation:number}[] {
  const edges=new Map<string,{count:number;orientation:number}>();
  for(const triangle of mesh.triangles) for(let i=0;i<3;i++){
    const a=triangle[i],b=triangle[(i+1)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`,value=edges.get(key)??{count:0,orientation:0};
    value.count++; value.orientation+=a<b?1:-1; edges.set(key,value);
  }
  return [...edges.values()];
}
function volume(mesh:ImplicitMesh):number {
  return mesh.triangles.reduce((sum,triangle)=>{
    const [a,b,c]=triangle.map(index=>mesh.vertices[index]);
    return sum+(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
  },0);
}
describe('XYZの有限範囲から陰関数の接続した等値面を作る',()=>{
  it('トーラスの全辺の共有・向きと体積を保つ',()=>{
    const torus=mesh('(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)',{minimum:[-3,-3,-1],maximum:[3,3,1],tolerance:1});
    expect(edgeCounts(torus).filter(edge=>edge.count!==2 || edge.orientation!==0)).toEqual([]);
    const measured=volume(torus); expect(measured).toBeGreaterThan(Math.PI**2*0.85);expect(measured).toBeLessThan(Math.PI**2*1.05);
  });
  it('離れた2つの球面を接続せず、全成分を保持する',()=>{
    const separated=mesh('((X-1)^2+Y^2+Z^2-0.25)*((X+1)^2+Y^2+Z^2-0.25)');
    const joined=separated.triangles.filter(triangle=>{
      const x=triangle.map(index=>separated.vertices[index][0]);
      return !(x.every(value=>value>0)||x.every(value=>value<0));
    });
    expect(joined).toEqual([]);
    expect(separated.vertices.some(point=>point[0]<0)).toBe(true);expect(separated.vertices.some(point=>point[0]>0)).toBe(true);
  });
  it('球の全辺を2面で共有し、向き・残差・体積を独立な解析値で確認する',()=>{
    const result=mesh('X^2+Y^2+Z^2-1'); expect(result.triangles.length).toBeGreaterThan(100);
    for(const edge of edgeCounts(result)){ expect(edge.count).toBe(2); expect(edge.orientation).toBe(0); }
    expect(volume(result)).toBeGreaterThan(4*Math.PI/3*0.97); expect(volume(result)).toBeLessThan(4*Math.PI/3);
    for(const point of result.vertices) expect(Math.abs(Math.hypot(...point)-1)).toBeLessThan(options.tolerance);
  });
  it('XYZで球を切ると境界の辺を残し、切り口の底面を追加しない',()=>{
    const result=mesh('X^2+Y^2+Z^2-1',{minimum:[-2,-2,0]});
    expect(edgeCounts(result).some(edge=>edge.count===1)).toBe(true);
    expect(result.vertices.every(point=>point[2]>=0 && point[0]>=-2 && point[0]<=2 && point[1]>=-2 && point[1]<=2)).toBe(true);
    expect(result.triangles.some(triangle=>triangle.every(index=>result.vertices[index][2]===0))).toBe(false);
  });
  it('XYZの境界に完全に乗った平面も消さず、格子の対角線で穴を作らない',()=>{
    const result=mesh('Z',{minimum:[-1,-1,0],maximum:[1,1,1]});
    expect(result.triangles.length).toBeGreaterThan(0); expect(result.vertices.every(point=>point[2]===0)).toBe(true);
    expect(edgeCounts(result).every(edge=>edge.count<=2 && (edge.count===1 || edge.orientation===0))).toBe(true);
  });
  it('無解、恒等0、零点1つだけの特異な集合を区別する',()=>{
    expect(grid('X^2+Y^2+Z^2+1').status).toBe('empty');
    expect(grid('0').status).toBe('degenerate');
    expect(grid('X^2+Y^2+Z^2')).toMatchObject({status:'stopped',reason:'singular'});
  });
  it('極を0面として結ばず、予算・中止では途中の面を返さない',()=>{
    expect(grid('1/X').status).toBe('empty');
    expect(grid('X+Y+Z',{maximumSamples:1})).toMatchObject({status:'stopped',reason:'samples'});
    expect(grid('X+Y+Z',{maximumCells:1})).toMatchObject({status:'stopped',reason:'cells'});
    expect(grid('X+Y+Z',{shouldStop:()=>'cancelled'})).toMatchObject({status:'stopped',reason:'cancelled'});
    expect(grid('X+Y+Z',{shouldStop:()=>'deadline'})).not.toHaveProperty('cells');
  });
  it('全6境界と精度を必須にし、表現できない分割数を作図前に断る',()=>{
    for(const changes of [{minimum:[-Infinity,-1,-1] as const},{maximum:[1,NaN,1] as const},{minimum:[2,-2,-2] as const},{tolerance:0}]){
      expect(()=>grid('X',changes)).toThrow();
    }
    expect(grid('X',{tolerance:1e-12,maximumDepth:4})).toMatchObject({status:'stopped',reason:'subdivision',samples:0});
  });
});
