import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionSurfaceWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';



import { makeFunctionSurface, createAllocations, isValidShape, hasSolid, measureArea,
  type Vec3Tuple, type FunctionClipBox, type FunctionSurfaceGeometrySpec } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { functionSurfaceRequest } from './functionSurfaceRequest.js';
import { FunctionPlotBounds } from './functionPlotBounds.js';

let backend: MathExecutionBackend, oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { backend = createMathBackend(); oc = await loadOcctForNode(); },180_000);
const box: FunctionClipBox = { minimum:[-1,-1,-1],maximum:[1,1,1] };
const square: FunctionSurfaceGeometrySpec = { vertices:[[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],
  triangles:[[0,1,2],[0,2,3]],bounds:box };
function facts(shape: Parameters<typeof isValidShape>[1]) {
  const { keep,release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(shape,map,true,true);
    const vertices: Vec3Tuple[] = [], centres: Vec3Tuple[] = []; let edges = 0,faces = 0;
    for (let index = 1; index <= map.Size(); index++) {
      const item = keep(map.FindKey(index));
      if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
        const point = keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(item)))); vertices.push([point.X(),point.Y(),point.Z()]);
      } else if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
        faces++;
        const properties = keep(new oc.GProp_GProps_1()); oc.BRepGProp.SurfaceProperties_1(item,properties,false,false);
        const centre = keep(properties.CentreOfMass()); centres.push([centre.X(),centre.Y(),centre.Z()]);
      } else if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges++;
    }
    return { vertices,centres,edges,faces };
  } finally { release(); }
}
function expectBounded(points: readonly Vec3Tuple[], bounds: FunctionClipBox): void {
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    expect(point[axis]).toBeGreaterThanOrEqual(bounds.minimum[axis]-1e-6);
    expect(point[axis]).toBeLessThanOrEqual(bounds.maximum[axis]+1e-6);
  }
}
function sampled(outputs: readonly [string,string,string], bounds: FunctionClipBox, tolerance: number): FunctionSurfaceGeometrySpec {
  const definitions = outputs.map(source => createFunctionMathSource(source,'text','radian',
    {axes:[],parameters:['U','V'],coefficients:[]},backend));
  const checked=FunctionPlotBounds.read({X:{min:bounds.minimum[0],max:bounds.maximum[0]},
    Y:{min:bounds.minimum[1],max:bounds.maximum[1]},Z:{min:bounds.minimum[2],max:bounds.maximum[2]}});
  if(!checked.ok) throw new Error(JSON.stringify(checked));
  const interval={min:{source:'-2',value:-2,display:'-2'},max:{source:'2',value:2,display:'2'}};
  const request=functionSurfaceRequest({kind:'parametric-surface',outputs:{X:definitions[0],Y:definitions[1],Z:definitions[2]},U:interval,V:interval},
    {bounds:checked.bounds,tolerance,parameters:[{parameter:'U',range:{min:-2,max:2}},{parameter:'V',range:{min:-2,max:2}}],fixedCoordinate:null},
    {identity:{documentId:'surface-kernel',documentVersion:1,editorId:'surface',inputRevision:1},coefficients:[]});
  const {result}=executeFunctionSurfaceWorkRequest({kind:'sample-function-surface',serial:1,request},backend);
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return {vertices:result.vertices.map(vertex=>vertex.point),triangles:result.triangles,bounds};
}

describe('関数の区間分割から実CADの面とXYZ切取へ接続する', () => {
  it('同一平面の2三角形を、4つの外周頂点と面積を保った1面へまとめる', () => {
    const result = makeFunctionSurface(oc,square);
    if (result.status !== 'shape') throw new Error('Expected CAD faces');
    try {
      expect(isValidShape(oc,result.shape)).toBe(true); expect(hasSolid(oc,result.shape)).toBe(false);
      const actual = facts(result.shape); expect(actual).toMatchObject({faces:1,edges:4}); expect(actual.vertices).toHaveLength(4);
      expect(measureArea(oc,result.shape)).toBeCloseTo(4,8); expectBounded(actual.vertices,box);
    } finally { result.delete(); }
  });
  it('折れ曲がる2面の共通辺・4頂点を同じ実トポロジーに保つ', () => {
    const input: FunctionSurfaceGeometrySpec = {...square,vertices:[[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0.5]]};
    const result = makeFunctionSurface(oc,input);
    if (result.status !== 'shape') throw new Error('Expected creased CAD faces');
    try {
      expect(isValidShape(oc,result.shape)).toBe(true); expect(hasSolid(oc,result.shape)).toBe(false);
      const actual = facts(result.shape); expect(actual).toMatchObject({faces:2,edges:5}); expect(actual.vertices).toHaveLength(4);
      expect(measureArea(oc,result.shape)).toBeCloseTo(2+Math.sqrt(18)/2,8); expectBounded(actual.vertices,box);
    } finally { result.delete(); }
  });
  it('傾いた面を実際のX/Z境界で切り、内点も元の平面式上に残る', () => {
    const limits: FunctionClipBox = {minimum:[-1,-1,-0.5],maximum:[1,1,0.5]};
    const input: FunctionSurfaceGeometrySpec = {vertices:[[-2,-2,-6],[2,-2,-2],[2,2,6],[-2,2,2]],triangles:square.triangles,bounds:limits};
    const before = JSON.stringify(input), result = makeFunctionSurface(oc,input);
    if (result.status !== 'shape') throw new Error('Expected trimmed plane');
    try {
      expect(isValidShape(oc,result.shape)).toBe(true); expect(measureArea(oc,result.shape)).toBeCloseTo(Math.sqrt(6),8);
      const actual = facts(result.shape), points = [...actual.vertices,...actual.centres];
      expectBounded(points,limits); for (const [x,y,z] of points) expect(z).toBeCloseTo(x+2*y,8);
      expect(JSON.stringify(input)).toBe(before);
    } finally { result.delete(); }
  });
  it('閉じた箱の表面を切っても境界面を捏造せず、面積3の開面にする', () => {
    const input: FunctionSurfaceGeometrySpec = {vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
      triangles:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]],
      bounds:{minimum:[-1,-1,-1],maximum:[0.5,2,2]}};
    const result = makeFunctionSurface(oc,input);
    if (result.status !== 'shape') throw new Error('Expected open cropped surface');
    try {
      expect(isValidShape(oc,result.shape)).toBe(true); expect(hasSolid(oc,result.shape)).toBe(false);
      expect(measureArea(oc,result.shape)).toBeCloseTo(3,8); expectBounded(facts(result.shape).vertices,input.bounds);
    } finally { result.delete(); }
  });
  it('実数式の放物面を生成し、切取後の面内点と端点が範囲と指定精度を満たす', () => {
    const limits: FunctionClipBox = {minimum:[-1,-1,-0.1],maximum:[1,1,0.15]}, tolerance = 0.01;
    const spec = sampled(['U','V','(U^2+V^2)/10'],limits,tolerance), before = JSON.stringify(spec);
    const result = makeFunctionSurface(oc,spec);
    if (result.status !== 'shape') throw new Error('Expected paraboloid');
    try {
      expect(isValidShape(oc,result.shape)).toBe(true); const actual = facts(result.shape);
      const points = [...actual.vertices,...actual.centres]; expect(points.length).toBeGreaterThan(50); expectBounded(points,limits);
      for (const [x,y,z] of points) expect(Math.abs(z-(x*x+y*y)/10)).toBeLessThanOrEqual(tolerance);
      expect(JSON.stringify(spec)).toBe(before);
    } finally { result.delete(); }
  });
  it('不正な範囲・重複面・同じ向きの共通辺を拒否し、取消の後も再生成できる', () => {
    expect(()=>makeFunctionSurface(oc,{...square,bounds:{...box,maximum:[1,Infinity,1]}})).toThrow();
    expect(()=>makeFunctionSurface(oc,{...square,triangles:[[0,1,2],[2,1,0]]})).toThrow();
    expect(()=>makeFunctionSurface(oc,{...square,triangles:[[0,1,2],[0,3,2]]})).toThrow();
    let checks = 0;
    expect(makeFunctionSurface(oc,square,()=>++checks>=3)).toEqual({status:'cancelled'});
    const result = makeFunctionSurface(oc,square);
    if (result.status !== 'shape') throw new Error('Expected recreated faces');
    try { expect(isValidShape(oc,result.shape)).toBe(true); expect(measureArea(oc,result.shape)).toBeCloseTo(4,8); }
    finally { result.delete(); }
  });
});
