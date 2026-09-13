import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { buildSolidBodyMesh, measureVolume } from '../occt/solidMesh.js';
import { shapeBodyKind } from '../occt/shapeBodyKind.js';
import { writeStep } from '../occt/writeStep.js';
import { readStep } from '../occt/readStep.js';
import { writeBrepBytes, readBrepBytes } from '../occt/brepBytes.js';
import { measureArea } from '../occt/solidMesh.js';
import { createKernelApi } from './kernelApi.js';
import type { FunctionSurfaceGeometrySpec, FunctionSurfaceInput } from '../occt/functionSurfaceGeometrySpec.js';
import type { SolidStepRequest } from '../types.js';
import { createShapeCache } from './shapeCache.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
const geometry: FunctionSurfaceGeometrySpec = {
  vertices:[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
  triangles:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]],
  bounds:{minimum:[-10,-10,-10],maximum:[10,10,10]},
};
const step = (key: string, input:FunctionSurfaceInput = geometry, visible = true): SolidStepRequest =>
  ({ id:key,label:key,key,visible,step:{kind:'functionSurface',geometry:input} });

describe('関数曲面を通常のWorker再計算・保持・書出しへ接続する', () => {
  it('等式から渡した解析球も加工・STEP往復へ接続し、切抜後の体積2π/3を保つ',async()=>{
    const cache=createShapeCache<CachedSolid>();
    try{
      const sphere:FunctionSurfaceInput={primitive:{kind:'sphere',center:[0,0,0],radius:1},bounds:geometry.bounds};
      const shifted:FunctionSurfaceGeometrySpec={...geometry,vertices:geometry.vertices.map(([x,y,z])=>[x+1,y,z])};
      const result=await recomputeSolids({oc,cache},{generation:1,steps:[step('sphere',sphere,false),step('tool',shifted,false),{
        id:'half',key:'half',label:'half',visible:true,step:{kind:'boolean',operation:'subtract',targetKey:'sphere',toolKey:'tool'},
      }]});
      expect(result.failures).toEqual([]);expect(result.bodies).toHaveLength(1);expect(result.bodies[0].bodyKind).toBe('solid');
      expect(result.bodies[0].volume).toBeCloseTo(2*Math.PI/3,7);
      const stored=cache.get('half');if(stored===undefined) throw new Error('Missing native function body');
      const written=writeStep(oc,[{shape:stored.shape,name:'等式の球を加工',color:null}]),restored=readStep(oc,written.bytes);
      try{expect(restored.bodies).toHaveLength(1);expect(shapeBodyKind(oc,restored.bodies[0].shape)).toBe('solid');
        expect(measureVolume(oc,restored.bodies[0].shape)).toBeCloseTo(2*Math.PI/3,7);
      }finally{restored.delete();}
    }finally{cache.clear();}
  });
  it('空の形はネイティブのShapeTypeへ渡さず理由を返す', () => {
    const empty=new oc.TopoDS_Shape();
    try { expect(()=>shapeBodyKind(oc,empty)).toThrow('形状が空'); }
    finally {empty.delete();}
  });
  it('閉面を立体として描画し、同じ鍵の再計算では元の実形状を再利用する', async () => {
    const cache=createShapeCache<CachedSolid>();
    try {
      const request={generation:1,measureAreas:true,steps:[step('function-box')]};
      const first=await recomputeSolids({oc,cache},request);
      expect(first.failures).toEqual([]); expect(first.bodies).toHaveLength(1);
      expect(first.bodies[0].bodyKind).toBe('solid'); expect(first.bodies[0].volume).toBeCloseTo(8,8);
      expect(first.bodies[0].area).toBeCloseTo(24,8); expect(first.bodies[0].triangleCount).toBeGreaterThan(0);
      const stored=cache.get('function-box'), second=await recomputeSolids({oc,cache},{...request,generation:2});
      expect(second.cacheHits).toBe(1); expect(cache.get('function-box')).toBe(stored);
      expect(second.bodies[0].positions).toEqual(first.bodies[0].positions);
    } finally {cache.clear();}
  });
  it('XYZの境界で切った開面を保持し、境界の蓋や架空の体積を追加しない', async () => {
    const cache=createShapeCache<CachedSolid>();
    try {
      const result=await recomputeSolids({oc,cache},{generation:1,measureAreas:true,steps:[
        step('cut-function',{...geometry,bounds:{minimum:[-2,-2,-2],maximum:[0,2,2]}}),
      ]});
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1);
      const body=result.bodies[0]; expect(body.bodyKind).toBe('shell'); expect(body.volume).toBe(0); expect(body.area).toBeCloseTo(12,8);
      for (let index=0;index<body.positions.length;index+=3) {
        expect(body.positions[index]).toBeGreaterThanOrEqual(-1-1e-6); expect(body.positions[index]).toBeLessThanOrEqual(1e-6);
      }
    } finally {cache.clear();}
  });
  it('開面と立体の混在を表示でも区別し、再測定でも開面を体積へ足さず加工を断る', async () => {
    const cache=createShapeCache<CachedSolid>();
    try {
      const mixed: FunctionSurfaceGeometrySpec={...geometry,vertices:[...geometry.vertices,[4,-1,3],[6,-1,3],[6,1,3],[4,1,3]],
        triangles:[...geometry.triangles,[8,9,10],[8,10,11]]};
      const result=await recomputeSolids({oc,cache},{generation:1,measureAreas:true,steps:[step('mixed',mixed),step('solid')]});
      expect(result.failures).toEqual([]);
      const body=result.bodies.find(item=>item.id==='mixed'); expect(body?.bodyKind).toBe('mixed');
      expect(body?.volume).toBeCloseTo(8,8); expect(body?.area).toBeCloseTo(28,8);
      const stored=cache.get('mixed'); if(!stored) throw new Error('Missing mixed geometry');
      const measured=buildSolidBodyMesh(oc,'measured',stored.shape);
      expect(measured.bodyKind).toBe('mixed'); expect(measured.volume).toBeCloseTo(8,8);
      const api=createKernelApi(loadOcctForNode);
      const restored=await api.importShape({format:'brep',bytes:writeBrepBytes(oc,stored.shape)});
      expect(restored.bodies).toHaveLength(1);
      expect(restored.bodies[0].bodyKind).toBe('mixed'); expect(restored.bodies[0].volume).toBeCloseTo(8,8);
      const stepFile=writeStep(oc,[{shape:stored.shape,name:'閉面と開面',color:null}]);
      const imported=await api.importShape({format:'step',bytes:stepFile.bytes});
      let area=0;
      for(const item of imported.bodies) {
        if(item.bodyKind==='mesh') throw new Error('STEP must preserve B-rep');
        const shape=readBrepBytes(oc,item.brepBytes);
        try {expect(item.bodyKind).toBe(shapeBodyKind(oc,shape)); area+=measureArea(oc,shape);}
        finally {shape.delete();}
      }
      expect(area).toBeCloseTo(28,8);
      expect(imported.bodies.reduce((sum,item)=>sum+item.volume,0)).toBeCloseTo(8,8);
      const combine=await recomputeSolids({oc,cache},{generation:2,steps:[{
        id:'combine',key:'combine',label:'combine',visible:true,step:{kind:'boolean',operation:'union',targetKey:'mixed',toolKey:'solid'},
      }]});
      expect(combine.bodies).toEqual([]); expect(combine.failures).toHaveLength(1);
      expect(combine.failures[0].message).toContain('閉じていない面');
      expect(cache.get('mixed')).toBe(stored); expect(cache.has('combine')).toBe(false);
    } finally {cache.clear();}
  });
  it('関数から作った立体のBooleanとSTEP往復で体積を保つ', async () => {
    const cache=createShapeCache<CachedSolid>();
    try {
      const shifted: FunctionSurfaceGeometrySpec={...geometry,vertices:geometry.vertices.map(([x,y,z])=>[x+1,y,z])};
      const result=await recomputeSolids({oc,cache},{generation:1,steps:[step('left',geometry,false),step('right',shifted,false),{
        id:'difference',key:'difference',label:'difference',visible:true,
        step:{kind:'boolean',operation:'subtract',targetKey:'left',toolKey:'right'},
      }]});
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1); expect(result.bodies[0].volume).toBeCloseTo(4,8);
      const stored=cache.get('difference'); if(!stored) throw new Error('Missing difference');
      const written=writeStep(oc,[{shape:stored.shape,name:'関数の立体',color:null}]), restored=readStep(oc,written.bytes);
      try { expect(restored.bodies).toHaveLength(1); expect(shapeBodyKind(oc,restored.bodies[0].shape)).toBe('solid');
        expect(measureVolume(oc,restored.bodies[0].shape)).toBeCloseTo(4,8);
      } finally {restored.delete();}
    } finally {cache.clear();}
  });
  it('不正なXYZ範囲はWorker入口でも拒否し、前回の形や失敗した鍵を返さない', async () => {
    const cache=createShapeCache<CachedSolid>();
    try {
      await recomputeSolids({oc,cache},{generation:1,steps:[step('good')]});
      const result=await recomputeSolids({oc,cache},{generation:2,steps:[step('bad',{...geometry,bounds:{minimum:[-1,-1,-1],maximum:[1,1,Infinity]}})]});
      expect(result.failures).toHaveLength(1); expect(result.bodies).toEqual([]); expect(cache.has('bad')).toBe(false);
    } finally {cache.clear();}
  });
});
