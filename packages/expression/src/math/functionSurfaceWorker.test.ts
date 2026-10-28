import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionSurfaceWorkRequest, createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { beginFunctionSurfaceWorkReply, decodeFunctionSurfaceWorkReply } from './functionSurfaceWorkReply.js';
import { certifySplineAgainstMesh, certifySplineAgainstMeshSteps, completeSteps, smoothFunctionSurface,
  type FunctionSurfaceSpline, type SurfaceMeshEvidence } from './smoothFunctionSurface.js';
import { sampleFunctionSurface, type FunctionSurfaceLeafObserver } from './adaptiveFunctionSurface.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { FunctionSurfaceWorkerClient } from './functionSurfaceWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';

let backend: MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function request(): FunctionSurfaceWorkRequest {
  const source = (source:string)=>createFunctionMathSource(source,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
  return {identity:{documentId:'surface',documentVersion:3,editorId:'plot',inputRevision:1},independent:['U','V'],
    outputs:[source('U'),source('V'),source('U+V')],lower:[-2,-2],upper:[2,2],minimum:[-1,-1,-1],maximum:[1,1,1],
    tolerance:0.01,coefficients:[],budget:{maximumSamples:10000,maximumCells:10000,maximumTriangles:10000,maximumDepth:10}};
}
class Port implements CalculationWorkerPort {
  onmessage:CalculationWorkerPort['onmessage']=null;
  onerror:CalculationWorkerPort['onerror']=null;
  onmessageerror:CalculationWorkerPort['onmessageerror']=null;
  readonly requests:unknown[]=[]; terminated=false;
  postMessage(value:unknown):void {this.requests.push(value);}
  terminate():void {this.terminated=true;}
  complete():void {this.onmessage?.({data:executeFunctionSurfaceWorkRequest(this.requests[0],backend)});}
}
describe('request-local sampler evidence reused by smoothing', () => {
  it('uses the actual sampler point/interval evidence and leaves every output and budget charge unchanged', () => {
    const base = request();
    const curved = createFunctionMathSource('0.1*U*V', 'text', 'radian', { axes: [], parameters: ['U', 'V'], coefficients: [] }, backend);
    const input = { ...base, outputs: [base.outputs[0], base.outputs[1], curved] as const };
    const evaluator = createFunctionSurfaceEvaluator(input.outputs, input.independent, input.coefficients, { backend, shouldStop: () => undefined });
    const captured: { value?: Parameters<FunctionSurfaceLeafObserver['leaves']> } = {};
    const mesh = sampleFunctionSurface(evaluator, { ...input, ...input.budget }, { leaves: (...args) => { captured.value = args; } });
    if (mesh.status !== 'ready' || captured.value === undefined) throw new Error('Expected complete plain patch');
    const [leaves, parameter, knownSample] = captured.value;
    let pointCalls = 0, intervalCalls = 0, reused = 0;
    const source = {
      point: (parameters: Parameters<typeof evaluator.point>[0]) => { pointCalls++; return evaluator.point(parameters); },
      enclosure: (...args: Parameters<typeof evaluator.enclosure>) => { intervalCalls++; return evaluator.enclosure(...args); },
    };
    const options = { minimum: input.minimum, maximum: input.maximum, tolerance: input.tolerance, parameter,
      remainingSamples: input.budget.maximumSamples - mesh.stats.samples,
      remainingCells: input.budget.maximumCells - mesh.stats.cells,
      mesh: { vertices: mesh.vertices, triangles: mesh.triangles, bound: mesh.maximumInterpolationErrorBound }, stop: () => false };
    const expected = smoothFunctionSurface(source, leaves, options), coldPoints = pointCalls, coldIntervals = intervalCalls;
    pointCalls = 0; intervalCalls = 0;
    const actual = smoothFunctionSurface(source, leaves, { ...options, knownSample: grid => {
      const sample = knownSample(grid);
      if (sample !== undefined) reused++;
      return sample;
    } });
    expect(actual).toEqual(expected);
    expect(actual.status).toBe('ready');
    expect(reused).toBeGreaterThan(0);
    expect(pointCalls + reused).toBe(coldPoints);
    expect(intervalCalls + reused).toBe(coldIntervals);
    expect(actual.used.samples).toBe(coldPoints);
    expect(pointCalls).toBeLessThan(coldPoints);
    expect(intervalCalls).toBeLessThan(coldIntervals);
  });
});

describe('曲面の有限XYZと中止可能なWorker通信',()=>{
  it('XYZより広いUV範囲を別に保持し、原式・予算・結果を深く固定する',()=>{
    const input=request(), decoded=decodeFunctionSurfaceWorkRequest(input), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,decoded),backend);
    const checked=decodeFunctionSurfaceWorkReply(reply,decoded);
    if(checked.result.status!=='ready') throw new Error(JSON.stringify(checked));
    expect(checked.result.vertices.some(value=>Math.abs(value.point[0])>1)).toBe(true); // CAD clips next.
    expect(Object.isFrozen(decoded.budget)).toBe(true); expect(Object.isFrozen(decoded.outputs[0].expression)).toBe(true);
    expect(Object.isFrozen(checked.result.vertices[0].point)).toBe(true); expect(Object.isFrozen(checked.result.triangles[0])).toBe(true);
  });
  it.each([0,1,2])('軸%sの全不正値・欠落をUV範囲があっても拒否する',axis=>{
    const input=request();
    for(const invalid of [undefined,NaN,Infinity,-Infinity,input.minimum[axis],input.minimum[axis]-1]) {
      const maximum:unknown[]=[...input.maximum]; maximum[axis]=invalid;
      expect(()=>decodeFunctionSurfaceWorkRequest({...input,maximum})).toThrow();
    }
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,minimum:input.minimum.slice(0,2)})).toThrow();
  });
  it('座標軸の範囲相違、重複変数、過大予算、保存AST差替えを拒否する',()=>{
    const input=request();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,independent:['X','Y']})).toThrow();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,independent:['U','U']})).toThrow();
    expect(()=>decodeFunctionSurfaceWorkRequest({...input,budget:{...input.budget,maximumTriangles:200001}})).toThrow();
    const reply=executeFunctionSurfaceWorkRequest({kind:'sample-function-surface',serial:1,request:{...input,
      outputs:[{...input.outputs[0],expression:input.outputs[1].expression},input.outputs[1],input.outputs[2]]}},backend);
    expect(reply.result.status).toBe('invalid'); expect(reply.result).not.toHaveProperty('vertices');
  });
  it('精度超過・不正頂点番号・非有限座標・範囲外UV・停止結果に付けたメッシュを拒否する',()=>{
    const input=request(), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(2,input),backend);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply));
    const result=reply.result;
    for(const invalid of [
      {...result,maximumInterpolationErrorBound:0.02}, {...result,triangles:[[0,1,1000000]],stats:{...result.stats,triangles:1}},
      {...result,vertices:result.vertices.map((v,i)=>i===0?{...v,point:[NaN,0,0]}:v)},
      {...result,vertices:result.vertices.map((v,i)=>i===0?{...v,parameters:[-3,0]}:v)},
      {...result,status:'stopped',reason:'deadline'}, {...result,stats:{...result.stats,samples:10001}},
    ]) expect(()=>decodeFunctionSurfaceWorkReply({...reply,result:invalid},input)).toThrow();
    expect(()=>decodeFunctionSurfaceWorkReply({...reply,identity:{...reply.identity,documentVersion:2}},input)).toThrow();
  });
  it('中止すると共通クライアントがWorkerを交換し、古い曲面を次の依頼へ適用しない',async()=>{
    const ports:Port[]=[], client=new FunctionSurfaceWorkerClient({createWorker:()=>{const port=new Port();ports.push(port);return port;}});
    try {
      const abort=new AbortController(), first=client.evaluate(request(),5000,abort.signal), oldReply=ports[0].onmessage;
      const input=request(), next=client.evaluate({...input,identity:{...input.identity,documentVersion:4}},5000);
      abort.abort(); expect(await first).toMatchObject({status:'cancelled'}); expect(ports[0].terminated).toBe(true);
      oldReply?.({data:executeFunctionSurfaceWorkRequest(ports[0].requests[0],backend)});
      ports[1].complete(); expect(await next).toMatchObject({status:'result',identity:{documentVersion:4}});
    } finally {client.dispose();}
  });
});

describe('曲面の滑らかなBスプラインの返答を独立に検査する',()=>{
  /** A curved surface over the same request: z = 0.1 U V (bilinear, not planar). */
  function curvedRequest(): FunctionSurfaceWorkRequest {
    const base=request(), source=(text:string)=>createFunctionMathSource(text,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    return {...base,outputs:[source('U'),source('V'),source('0.1*U*V')]};
  }
  it('平面は既に厳密な平面三角形なので、滑らかな面を付けず理由を返す',()=>{
    const input=decodeFunctionSurfaceWorkRequest(request()), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(8,input),backend);
    const decoded=decodeFunctionSurfaceWorkReply(reply,input).result;
    expect(decoded).toMatchObject({status:'ready',splineDeclined:'affine'}); expect(decoded).not.toHaveProperty('spline');
  });
  function smoothReply(budget:Partial<FunctionSurfaceWorkRequest['budget']>={}) {
    const base=curvedRequest(), input=decodeFunctionSurfaceWorkRequest({...base,budget:{...base.budget,...budget}});
    const reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(9,input),backend);
    if(reply.result.status!=='ready') throw new Error(JSON.stringify(reply.result));
    return {input,reply,result:reply.result};
  }
  function fixture() {
    const {input,reply,result}=smoothReply();
    if(!('spline' in result)||result.spline===undefined) throw new Error(JSON.stringify('splineDeclined' in result?result.splineDeclined:result.status));
    return {input,reply,result,spline:result.spline};
  }
  type Pole=readonly [number,number,number];
  /** Independent double-knot junction weight (OCCT knot insertion) and node point, not the production helper. */
  const share=(knots:readonly number[],node:number)=>node===0?0:node===knots.length-1?1:(knots[node]-knots[node-1])/(knots[node+1]-knots[node-1]);
  function node(spline:{uKnots:readonly number[];vKnots:readonly number[];poles:readonly Pole[]},k:number,l:number):Pole {
    const columns=2*spline.vKnots.length, a=share(spline.uKnots,k), b=share(spline.vKnots,l), out=[0,0,0];
    const rows:[number,number][]=k===0?[[0,1]]:k===spline.uKnots.length-1?[[2*k+1,1]]:[[2*k,1-a],[2*k+1,a]];
    const cols:[number,number][]=l===0?[[0,1]]:l===spline.vKnots.length-1?[[2*l+1,1]]:[[2*l,1-b],[2*l+1,b]];
    for(const [p,x] of rows) for(const [q,y] of cols) for(let axis=0;axis<3;axis++) out[axis]+=x*y*spline.poles[p*columns+q][axis];
    return [out[0],out[1],out[2]];
  }
  /** Independent Bezier evaluation at the centre of cell (i, j). */
  function centre(spline:{uKnots:readonly number[];vKnots:readonly number[];poles:readonly Pole[]},i:number,j:number):Pole {
    const columns=2*spline.vKnots.length, weights=[1/8,3/8,3/8,1/8], out=[0,0,0];
    const control=(knots:readonly number[],s:number,r:number):[number,number][]=>{
      const junction=(n:number):[number,number][]=>n===0?[[0,1]]:n===knots.length-1?[[2*n+1,1]]:[[2*n,1-share(knots,n)],[2*n+1,share(knots,n)]];
      return r===0?junction(s):r===3?junction(s+1):[[2*s+r,1]];
    };
    for(let r=0;r<4;r++) for(let s=0;s<4;s++) for(const [p,x] of control(spline.uKnots,i,r)) for(const [q,y] of control(spline.vKnots,j,s)) {
      for(let axis=0;axis<3;axis++) out[axis]+=weights[r]*weights[s]*x*y*spline.poles[p*columns+q][axis];
    }
    return [out[0],out[1],out[2]];
  }
  const allNodes=(spline:{uKnots:readonly number[];vKnots:readonly number[];poles:readonly Pole[]})=>
    spline.uKnots.flatMap((_,k)=>spline.vKnots.map((__,l)=>node(spline,k,l)));
  const sameNodes=(a:readonly Pole[],b:readonly Pole[])=>a.every((point,index)=>point.every((value,axis)=>Math.abs(value-b[index][axis])<=1e-12*(1+Math.abs(value))));
  const rejects=(reply:unknown,input:FunctionSurfaceWorkRequest,result:unknown)=>
    expect(()=>decodeFunctionSurfaceWorkReply({...(reply as object),result},input)).toThrow();

  it('曲がった面は証明付きの滑らかな面になり、節点は変数の範囲内で描く三角形を全て含み、標本と面の数に平滑化の分を足す',()=>{
    const {input,reply,result}=smoothReply();
    const decoded=decodeFunctionSurfaceWorkReply(reply,input).result;
    if(decoded.status!=='ready'||decoded.spline===undefined) throw new Error(JSON.stringify('splineDeclined' in result?result.splineDeclined:result.status));
    const {uKnots,vKnots,poles,errorBound}=decoded.spline;
    // Clipped by the XYZ box: knots need not reach U, V = +-2, but every drawn vertex lies inside the spline rectangle.
    expect(uKnots[0]).toBeGreaterThanOrEqual(-2); expect(uKnots.at(-1)).toBeLessThanOrEqual(2);
    expect(decoded.vertices.every(({parameters:[u,v]})=>u>=uKnots[0]&&u<=uKnots[uKnots.length-1]&&v>=vKnots[0]&&v<=vKnots[vKnots.length-1])).toBe(true);
    expect(poles).toHaveLength(4*uKnots.length*vKnots.length);
    // The spline error is the mesh's own bound plus a strictly positive spline-to-mesh part, within the tolerance.
    expect(errorBound).toBeGreaterThan(decoded.maximumInterpolationErrorBound); expect(errorBound).toBeLessThanOrEqual(input.tolerance);
    // Shared totals: the sampler's distinct samples (at least its vertices) plus one evaluation per product node, and
    // its cells plus every product cell, all inside the one request budget.
    expect(decoded.stats.samples).toBeGreaterThanOrEqual(decoded.vertices.length+uKnots.length*vKnots.length);
    expect(decoded.stats.cells).toBeGreaterThanOrEqual((uKnots.length-1)*(vKnots.length-1));
    expect(decoded.stats.samples).toBeLessThanOrEqual(input.budget.maximumSamples); expect(decoded.stats.cells).toBeLessThanOrEqual(input.budget.maximumCells);
  });

  it('平滑化は残りの予算だけを使い、ちょうど足りる時は面を作り、1つ足りない時は理由付きで三角形を残す',()=>{
    const {result,spline}=fixture();
    const nodes=spline.uKnots.length*spline.vKnots.length, cells=(spline.uKnots.length-1)*(spline.vKnots.length-1);
    // The sampler's own totals are deterministic for any budget it does not reach.
    const sampler={samples:result.stats.samples-nodes,cells:result.stats.cells-cells};
    const exact=smoothReply({maximumSamples:result.stats.samples,maximumCells:result.stats.cells}).result;
    expect(exact).toHaveProperty('spline'); expect(exact.stats).toEqual(result.stats);
    const samples=smoothReply({maximumSamples:result.stats.samples-1}).result;
    expect(samples).toMatchObject({status:'ready',splineDeclined:'budget',stats:{samples:sampler.samples,cells:sampler.cells}});
    expect(samples).not.toHaveProperty('spline');
    const cellBudget=smoothReply({maximumCells:result.stats.cells-1}).result;
    expect(cellBudget).toMatchObject({status:'ready',splineDeclined:'budget',stats:{samples:sampler.samples,cells:sampler.cells}});
  });

  it('全ての節点を保ったまま内部の極を膨らませた面は、網と三角形の差が許容を超えるので拒否する',()=>{
    const {input,reply,result,spline}=fixture(), columns=2*spline.vKnots.length;
    const k=spline.uKnots.indexOf(0), l=spline.vKnots.indexOf(0), a=share(spline.uKnots,k), b=share(spline.vKnots,l), delta=1;
    expect(k).toBeGreaterThan(0); expect(l).toBeGreaterThan(0);
    // Pole (2k+1, 2l+1) feeds only node (k, l); pole (2k, 2l) cancels it there, so every node keeps its position.
    const poles=spline.poles.map((pole,index):Pole=>index===(2*k+1)*columns+2*l+1?[pole[0],pole[1],pole[2]+delta]
      :index===2*k*columns+2*l?[pole[0],pole[1],pole[2]-delta*a*b/((1-a)*(1-b))]:pole);
    const bulged={...spline,poles};
    expect(sameNodes(allNodes(bulged),allNodes(spline))).toBe(true);
    // Exact unexecuted expectation: the centre of cell (k, l) moves by delta (9 + 3(a + b)) / 64 >= 0.14, far beyond the
    // 0.01 tolerance; the complete-net certificate sees the moved control, so neither the old claim nor any claim passes.
    expect(centre(bulged,k,l)[2]-centre(spline,k,l)[2]).toBeCloseTo(delta*(9+3*(a+b))/64,12);
    rejects(reply,input,{...result,spline:bulged});
    rejects(reply,input,{...result,spline:{...bulged,errorBound:input.tolerance}});
  });

  it('内部の節点で反対向きの接線を打ち消した面は、節点も接続も保つが網の差で拒否する',()=>{
    const {input,reply,result,spline}=fixture(), columns=2*spline.vKnots.length;
    const k=spline.uKnots.indexOf(0), a=share(spline.uKnots,k), delta=1;
    // Along the whole knot line U = 0: (1 - a) * (+a delta) + a * (-(1 - a) delta) = 0 keeps every junction.
    const poles=spline.poles.map((pole,index):Pole=>{
      const row=Math.floor(index/columns);
      return row===2*k?[pole[0],pole[1],pole[2]+a*delta]:row===2*k+1?[pole[0],pole[1],pole[2]-(1-a)*delta]:pole;
    });
    const cancelled={...spline,poles};
    expect(sameNodes(allNodes(cancelled),allNodes(spline))).toBe(true);
    // Exact expectation: the cell (k, l) centre beside the knot moves by -(1 - a) delta * 3/8 * (1/8 + 3/8 + 3/8 + 1/8).
    const l=spline.vKnots.indexOf(0);
    expect(centre(cancelled,k,l)[2]-centre(spline,k,l)[2]).toBeCloseTo(-(1-a)*delta*3/8,12);
    rejects(reply,input,{...result,spline:cancelled});
  });

  it('面を覆う三角形を省いた返答は、三角形だけなら通るが滑らかな面は覆いの不足で拒否する',()=>{
    const {input,reply,result,spline}=fixture();
    const k=spline.uKnots.indexOf(0), l=spline.vKnots.indexOf(0);
    const [u0,u1,v0,v1]=[spline.uKnots[k],spline.uKnots[k+1],spline.vKnots[l],spline.vKnots[l+1]];
    // Drop every triangle whose parameter box meets the open cell (k, l), which lies inside the XYZ box: the cell is then
    // wholly uncovered while its control net is not beyond any box face.
    const kept=result.triangles.filter(face=>{
      const us=face.map(index=>result.vertices[index].parameters[0]), vs=face.map(index=>result.vertices[index].parameters[1]);
      return !(Math.max(...us)>u0&&Math.min(...us)<u1&&Math.max(...vs)>v0&&Math.min(...vs)<v1);
    });
    expect(kept.length).toBeLessThan(result.triangles.length);
    const holed={...result,triangles:kept,stats:{...result.stats,triangles:kept.length}};
    const withoutSpline=Object.fromEntries(Object.entries(holed).filter(([key])=>key!=='spline'));
    expect(decodeFunctionSurfaceWorkReply({...reply,result:withoutSpline},input).result.status).toBe('ready');
    rejects(reply,input,holed);
    // A duplicated triangle is an overlap, rejected the same way.
    rejects(reply,input,{...result,triangles:[...result.triangles,result.triangles[0]],stats:{...result.stats,triangles:result.triangles.length+1}});
  });

  it('別の頂点番号・逆向きの重複三角形で欠けを埋め合わせ、面積の合計が変わらない返答を拒否する',()=>{
    const {input,reply,result}=fixture();
    const area=(face:readonly number[])=>{
      const [a,b,c]=face.map(index=>result.vertices[index].parameters);
      return Math.abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2;
    };
    // Triangle 0 and another triangle of exactly the same parameter area sharing a vertex with it (same leaf fan).
    const first=result.triangles[0], twin=result.triangles.findIndex((face,index)=>index>0&&area(face)===area(first)&&face.some(vertex=>first.includes(vertex)));
    expect(twin).toBeGreaterThan(0);
    // Copies of triangle 0's vertices under new indices, in reversed winding, replace the twin: the total drawn area is
    // unchanged and no index triple repeats, but the twin's region is now uncovered and triangle 0's region is doubled.
    const n=result.vertices.length, vertices=[...result.vertices,...[...first].reverse().map(index=>result.vertices[index])];
    const triangles=result.triangles.map((face,index)=>index===twin?[n,n+1,n+2]:face);
    expect(triangles.reduce((sum,face)=>sum+area(face.map(index=>index<n?index:first[2-(index-n)])),0))
      .toBeCloseTo(result.triangles.reduce((sum,face)=>sum+area(face),0),12);
    const balanced={...result,vertices,triangles,stats:{...result.stats,samples:Math.max(result.stats.samples,vertices.length)}};
    // The same mesh without the spline is still a decodable (mesh-route) reply; the spline certificate rejects it.
    expect(decodeFunctionSurfaceWorkReply({...reply,result:Object.fromEntries(Object.entries(balanced).filter(([key])=>key!=='spline'))},input).result.status).toBe('ready');
    rejects(reply,input,balanced);
    // A plain geometric duplicate under new indices and reversed winding, nothing removed, is an overlap too.
    rejects(reply,input,{...result,vertices,triangles:[...result.triangles,[n,n+1,n+2]],
      stats:{...result.stats,samples:Math.max(result.stats.samples,vertices.length),triangles:result.triangles.length+1}});
  });

  it('精度の主張や作図の誤差を書き換えた返答は、再計算と一致しないので拒否する',()=>{
    const {input,reply,result,spline}=fixture();
    rejects(reply,input,{...result,spline:{...spline,errorBound:spline.errorBound/2}});
    rejects(reply,input,{...result,spline:{...spline,errorBound:Math.min(input.tolerance,spline.errorBound*2)}});
    rejects(reply,input,{...result,spline:{...spline,errorBound:0}});
    // The original-function part is the mesh bound: lowering it changes the recomputed sum, so the claim no longer matches.
    rejects(reply,input,{...result,maximumInterpolationErrorBound:0});
    expect(decodeFunctionSurfaceWorkReply(reply,input).result).toHaveProperty('spline.errorBound',spline.errorBound);
  });

  it('範囲外・増加しない節点、極の数、非有限、矛盾、未知の理由を断る',()=>{
    const {input,reply,result,spline}=fixture();
    for(const value of [
      {...result,spline:{...spline,vKnots:[...spline.vKnots.slice(0,-1),3]}},
      {...result,spline:{...spline,uKnots:[spline.uKnots[1],spline.uKnots[0],...spline.uKnots.slice(2)]}},
      {...result,spline:{...spline,uKnots:spline.uKnots.slice(1)}},
      {...result,spline:{...spline,poles:spline.poles.slice(1)}},
      {...result,spline:{...spline,poles:spline.poles.map((pole,index)=>index===5?[pole[0],Number.NaN,pole[2]]:pole)}},
      {...result,spline:{...spline,poles:spline.poles.map((pole,index)=>index===5?[pole[0],Number.POSITIVE_INFINITY,pole[2]]:pole)}},
      {...result,spline:{...spline,errorBound:input.tolerance*2}},
      {...result,splineDeclined:'bound'},
      {...Object.fromEntries(Object.entries(result).filter(([key])=>key!=='spline')),splineDeclined:'unknown'},
    ]) rejects(reply,input,value);
  });
});

describe('曲面の返信は封筒を先に照合し、結果の検査は区切って進めても同じ答えになる',()=>{
  function curved(): FunctionSurfaceWorkRequest {
    const base=request(), source=(text:string)=>createFunctionMathSource(text,'text','radian',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    return decodeFunctionSurfaceWorkRequest({...base,outputs:[source('U'),source('V'),source('0.1*U*V')]});
  }
  /** A result whose every read is recorded: proves whether the client decoded it at all. */
  function watched(result:unknown,touched:{count:number}) {
    return new Proxy(result as object,{get:(target,key,receiver)=>{touched.count++;return Reflect.get(target,key,receiver) as unknown;},
      ownKeys:target=>{touched.count++;return Reflect.ownKeys(target);},has:(target,key)=>{touched.count++;return Reflect.has(target,key);}});
  }
  class ReplyPort implements CalculationWorkerPort {
    onmessage:CalculationWorkerPort['onmessage']=null; onerror:CalculationWorkerPort['onerror']=null; onmessageerror:CalculationWorkerPort['onmessageerror']=null;
    readonly answer:(serial:number)=>unknown;
    constructor(answer:(serial:number)=>unknown){this.answer=answer;}
    postMessage(value:unknown):void {
      const serial=typeof value==='object'&&value!==null&&'serial' in value&&typeof value.serial==='number'?value.serial:0;
      queueMicrotask(()=>this.onmessage?.({data:this.answer(serial)}));
    }
    terminate():void {this.onmessage=null;}
  }

  it('区切った検査の答えは、同期の検査の答えと完全に一致する',()=>{
    const input=curved(), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(3,input),backend);
    const begun=beginFunctionSurfaceWorkReply(reply,input);
    expect(begun.serial).toBe(3);
    let slices=0, step=begun.steps.next();
    while(step.done!==true){slices++;step=begun.steps.next();}
    expect(slices).toBeGreaterThan(1);
    expect(step.value).toEqual(decodeFunctionSurfaceWorkReply(reply,input));
    expect(completeSteps(beginFunctionSurfaceWorkReply(reply,input).steps)).toEqual(step.value);
  });

  it('別の編集状態の返信は封筒の照合で即座に断り、結果を1度も読まない',()=>{
    const input=curved(), reply=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(4,input),backend), touched={count:0};
    expect(()=>beginFunctionSurfaceWorkReply({...reply,identity:{...reply.identity,documentVersion:2},result:watched(reply.result,touched)},input)).toThrow();
    expect(touched.count).toBe(0);
  });

  it('同じ編集状態の古いserialの返信は、本物のクライアントが結果を1度も読まずに断る（今のserialなら読む）',async()=>{
    const input=curved(), executed=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,input),backend);
    const stale={count:0}, current={count:0};
    // Request 1 is answered with a stale serial 7 (refused unread); request 2 with its own serial (decoded).
    const port=new ReplyPort(serial=>serial===1?{...executed,serial:7,result:watched(executed.result,stale)}:{...executed,serial,result:watched(executed.result,current)});
    const client=new FunctionSurfaceWorkerClient({createWorker:()=>port});
    try {
      expect(await client.evaluate(input,5000)).toMatchObject({status:'worker-error'});
      expect(stale.count).toBe(0);
      expect(await client.evaluate(input,5000)).toMatchObject({status:'result',result:{status:'ready'}});
      expect(current.count).toBeGreaterThan(0);
    } finally {client.dispose();}
  });

  it('本物のクライアントで検査中に中止すると、結果を出さずに中止で終わり、次の依頼は新しいWorkerで完了する',async()=>{
    const input=curved(), executed=executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1,input),backend);
    const ports:ReplyPort[]=[], client=new FunctionSurfaceWorkerClient({createWorker:()=>{const port=new ReplyPort(serial=>({...executed,serial}));ports.push(port);return port;}});
    try {
      const abort=new AbortController(), first=client.evaluate(input,5000,abort.signal);
      // The reply is delivered on a microtask; the abort is a later task, so it lands during or after verification.
      setTimeout(()=>abort.abort(),0);
      const outcome=await first;
      // Either the small curved reply finished within its slices before the click, or the click abandoned it; never a
      // partial result, and a cancelled request terminates its Worker.
      if(outcome.status==='cancelled') expect(ports[0].onmessage).toBeNull();
      else {
        expect(outcome).toMatchObject({status:'result',result:{status:'ready'}});
        if(outcome.status!=='result'||outcome.result.status!=='ready'||outcome.result.spline===undefined) {
          throw new Error('Expected a complete ready spline reply');
        }
        expect(outcome.result.spline.errorBound).toBeTypeOf('number');
      }
      expect(await client.evaluate(input,5000)).toMatchObject({status:'result',result:{status:'ready'}});
    } finally {client.dispose();}
  });
});

describe('surface certificate preparation is resumable before inspecting triangles', () => {
  const box = { minimum: [-1, -1, -1] as const, maximum: [1, 1, 1] as const };
  function outsideSpline(): Pick<FunctionSurfaceSpline, 'uKnots' | 'vKnots' | 'poles'> {
    const uKnots = Array.from({ length: 513 }, (_, index) => index), vKnots = [0, 1];
    return { uKnots, vKnots, poles: Array.from({ length: 4 * uKnots.length * vKnots.length }, () => [2, 2, 2] as const) };
  }
  const emptyMesh: SurfaceMeshEvidence = { vertices: [], triangles: [], bound: 0 };

  it('yields during knot checks, pole checks and cell initialization before reading the mesh', () => {
    const plain = outsideSpline();
    let knotReads = 0, poleReads = 0, meshReads = 0;
    const uKnots = plain.uKnots.map((value, index, knots) => {
      Object.defineProperty(knots, index, { get: () => { knotReads++; return value; } });
      return value;
    });
    // The accessors belong to plain.uKnots; use that array, keeping the independent values for the oracle.
    const poles = plain.poles.map((value, index, entries) => {
      Object.defineProperty(entries, index, { get: () => { poleReads++; return value; } });
      return value;
    });
    const mesh: SurfaceMeshEvidence = { vertices: [], bound: 0, get triangles() { meshReads++; return []; } };
    const steps = certifySplineAgainstMeshSteps(plain, mesh, box);
    let knotPauses = 0, polePauses = 0, initializationPauses = 0;
    let previousKnots = 0, previousPoles = 0, step = steps.next();
    while (step.done !== true) {
      if (meshReads === 0) {
        expect(knotReads - previousKnots).toBeLessThanOrEqual(512);
        expect(poleReads - previousPoles).toBeLessThanOrEqual(256);
        if (knotReads > 0 && poleReads === 0) knotPauses++;
        if (poleReads > 0 && poleReads < poles.length) polePauses++;
        if (poleReads === poles.length) initializationPauses++;
      }
      previousKnots = knotReads; previousPoles = poleReads;
      step = steps.next();
    }
    expect(knotPauses).toBeGreaterThan(1);
    expect(polePauses).toBeGreaterThan(1);
    expect(initializationPauses).toBeGreaterThanOrEqual(2);
    expect(poleReads).toBeGreaterThanOrEqual(poles.length);
    expect(step.value).toEqual({ status: 'certified', splineToMesh: 0, coveredCells: 0, outsideCells: 512,
      curved: false, visitedCells: 512, work: 0 });
    expect(step.value).toEqual(certifySplineAgainstMesh({ ...plain, uKnots, poles }, emptyMesh, box));
  });

  it('rejects invalid entries after preparation pauses without touching triangle geometry', () => {
    const base = outsideSpline();
    const nonfinite = base.poles.map((pole, index) => index === base.poles.length - 1 ? [2, NaN, 2] as const : pole);
    // Array.every skips holes; the late nonfinite pole still determines the rejection.
    const sparse = nonfinite.slice(0, 1);
    for (let index = 2; index < nonfinite.length; index++) sparse[index] = nonfinite[index];
    const malformed = base.poles.map((pole): [number, number, number] => [pole[0], pole[1], pole[2]]);
    Object.defineProperty(malformed[malformed.length - 1], 'length', { value: 2 });
    const descending = base.uKnots.map((knot, index) => index === base.uKnots.length - 1 ? 0 : knot);
    const infinite = base.uKnots.map((knot, index) => index === base.uKnots.length - 1 ? Infinity : knot);
    for (const [spline, reason] of [
      [{ ...base, poles: nonfinite }, 'nonfinite'], [{ ...base, uKnots: descending }, 'structure'],
      [{ ...base, uKnots: infinite }, 'structure'],
      [{ ...base, poles: sparse }, 'nonfinite'], [{ ...base, poles: malformed }, 'nonfinite'],
    ] as const) {
      let meshReads = 0, pauses = 0;
      const mesh: SurfaceMeshEvidence = { vertices: [], bound: 0, get triangles() { meshReads++; return []; } };
      const steps = certifySplineAgainstMeshSteps(spline, mesh, box);
      let step = steps.next();
      while (step.done !== true) { pauses++; step = steps.next(); }
      expect(pauses).toBeGreaterThan(1);
      expect(meshReads).toBe(0);
      expect(step.value).toEqual({ status: 'rejected', reason, visitedCells: 0 });
      expect(completeSteps(certifySplineAgainstMeshSteps(spline, emptyMesh, box))).toEqual(step.value);
    }
  });
});
