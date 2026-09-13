import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createAllocations, createKernelApi, functionCurvePolylines, makePlanarFace, measureArea, makeSplineEdge } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { borrowHandle } from '../../../kernel/src/occt/borrowHandle.js';
import { createDirectKernelBridge, toCurveSpec, fromCurveSpec } from '../kernelBridge.js';
import { keyCurveList } from '../part/cacheKey.js';
import { mirrorTransform, transformCurve } from '../sketch/copyMath.js';
import { sampleSpline, splineCurveData } from '../sketch/splineMath.js';
import type { ResolvedSpline } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { readFunctionCurveGeometry, type FunctionCurveGeometryInput } from './functionCurveGeometry.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
const bounds = { minimum: [-1, -1, -1] as Vec3, maximum: [1, 1, 1] as Vec3 };
const input: FunctionCurveGeometryInput = { featureId: 'function', bounds,
  components: [[[-2, 0, 0], [-0.5, 0, 0], [0, 2, 0], [0.5, 0, 0], [2, 0, 0]]] };
const square: ResolvedSpline = { kind: 'spline', featureId: 'square', mode: 'control', degree: 1, closed: true,
  points: [[-2, -1.5, 0], [2, -1.5, 0], [2, 1.5, 0], [-2, 1.5, 0]] };

describe('関数の切断済み曲線を通常スケッチへ接続する', () => {
  it('証明済みの三次曲線は実CADの同じ4制御点を返し、すり替えと範囲外を断る', async () => {
    const bezier: readonly [Vec3,Vec3,Vec3,Vec3]=[[-1,0,0],[-0.5,-1,0],[0.5,1,0],[1,0,0]];
    const request:FunctionCurveGeometryInput={featureId:'cubic',bounds,components:[],bezier};
    const bridge=createDirectKernelBridge(createKernelApi(()=>Promise.resolve(oc)));
    try {
      const result=await bridge.functionSketchCurves(request);
      if(result.status!=='ready') throw new Error(JSON.stringify(result));
      expect(result.curves).toHaveLength(1); expect(result.curves[0].points).toEqual(bezier);
      expect(result.curves[0]).not.toHaveProperty('degree');
      expect(fromCurveSpec(toCurveSpec(result.curves[0]),'copy')).toEqual({...result.curves[0],featureId:'copy'});
      const reply={status:'ready',curves:[toCurveSpec(result.curves[0])]};
      expect(readFunctionCurveGeometry({status:'ready',curves:[]},request).status).toBe('failed');
      expect(readFunctionCurveGeometry(reply,input).status).toBe('failed');
      expect(readFunctionCurveGeometry({...reply,curves:[{...reply.curves[0],points:[...bezier.slice(0,3),[0.9,0,0]]}]},request).status).toBe('failed');
      expect((await bridge.functionSketchCurves({...request,bezier:[bezier[0],[-2,0,0],bezier[2],bezier[3]]})).status).toBe('failed');
      expect((await bridge.functionSketchCurves({...request,components:input.components})).status).toBe('failed');
      expect(functionCurvePolylines(oc,request,()=>true)).toEqual({status:'cancelled'});
      expect((await bridge.functionSketchCurves(request)).status).toBe('ready');
    } finally { bridge.dispose(); }
  });
  it('借用された実OCCT曲線を解放一覧へ渡せる型にしない', () => {
    expectTypeOf<ReturnType<typeof borrowHandle>>().not.toHaveProperty('delete');
  });
  it('実CAD切断の2枝・途中の角・境界上の端点を橋の往復後も保持する', async () => {
    const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
    try {
      const result = await bridge.functionSketchCurves(input);
      if (result.status !== 'ready') throw new Error(JSON.stringify(result));
      expect(result.curves).toHaveLength(2);
      const ordered = [...result.curves].sort((a, b) => Math.min(...a.points.map(p => p[0])) - Math.min(...b.points.map(p => p[0])));
      const expected = [[[-1, 0, 0], [-0.5, 0, 0], [-0.25, 1, 0]], [[0.25, 1, 0], [0.5, 0, 0], [1, 0, 0]]];
      for (let i = 0; i < ordered.length; i++) {
        const points = [...sampleSpline(ordered[i])].sort((a, b) => a[0] - b[0]);
        expect(points).toHaveLength(3);
        points.forEach((p, n) => p.forEach((x, axis) => expect(x).toBeCloseTo(expected[i][n][axis], 9)));
        expect(ordered[i].featureId).toBe('function');
        expect(fromCurveSpec(toCurveSpec(ordered[i]), 'copy')).toEqual({ ...ordered[i], featureId: 'copy' });
      }
    } finally { bridge.dispose(); }
  });

  it('閉じた関数輪郭を通常の面張りに渡すと四隅と面積が変わらない', async () => {
    const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
    try {
      const result = await bridge.functionSketchCurves({ featureId: 'closed',
        bounds: { minimum: [-3, -3, -1], maximum: [3, 3, 1] }, components: [[...square.points, square.points[0]]] });
      if (result.status !== 'ready') throw new Error(JSON.stringify(result));
      expect(result.curves).toHaveLength(1); expect(result.curves[0].closed).toBe(true);
      expect(result.curves[0].points).toHaveLength(4);
      const spec = toCurveSpec(result.curves[0]);
      if (spec.kind !== 'spline') throw new Error('Expected linear spline');
      const owned = createAllocations();
      try {
        const edge = owned.keep(makeSplineEdge(oc, spec)), adaptor = owned.keep(new oc.BRepAdaptor_Curve_2(edge.edge));
        const read = (u: number) => { const p = owned.keep(adaptor.Value(u)); return [p.X(), p.Y(), p.Z()]; };
        expect([adaptor.FirstParameter(), adaptor.LastParameter()]).toEqual([0, 4]);
        expect(Array.from({ length: 5 }, (_, n) => read(n))).toEqual([...square.points, square.points[0]]);
      } finally { owned.release(); }
      const face = makePlanarFace(oc, result.curves.map(toCurveSpec));
      try {
        expect(face.boundaryEdgeCount).toBe(4);
        expect(measureArea(oc, face.face)).toBeCloseTo(12, 9);
      } finally { face.delete(); }
      const mesh = await bridge.tessellateSketchFaces([{ featureId: 'face', color: '#abcdef', curves: result.curves }]);
      expect(mesh.failures).toEqual([]); expect(mesh.mesh.faces).toHaveLength(1);
    } finally { bridge.dispose(); }
  });

  it('100点を超える折れ線も角を間引かず、16倍の描画点を作らない', () => {
    const points: Vec3[] = Array.from({ length: 1001 }, (_, n) => [n / 100, n % 2, 0]);
    const curve = { ...square, points, closed: false };
    expect(splineCurveData(curve)?.degree).toBe(1);
    expect(sampleSpline(curve)).toEqual(points);
    expect(splineCurveData({ ...curve, degree: undefined })).toBeNull();
    expect(splineCurveData({ ...curve, mode: 'interpolate' })).toBeNull();
  });

  it('鏡像でも折れ線を維持し、同じ制御点の三次曲線とは別の形状キャッシュを使う', () => {
    const mirrored = transformCurve(mirrorTransform([0, 0, 0], [1, 0, 0]), square, 'mirror');
    if (mirrored.kind !== 'spline') throw new Error('Expected spline');
    expect(mirrored.degree).toBe(1);
    expect(sampleSpline(mirrored)).toEqual([...square.points, square.points[0]].map(([x, y, z]) => [-x, y, z]));
    const ordinary: ResolvedSpline = { kind: square.kind, featureId: square.featureId, mode: square.mode, closed: square.closed, points: square.points };
    expect(keyCurveList([square])).not.toEqual(keyCurveList([ordinary]));
    const mapped = toCurveSpec(square);
    if (mapped.kind !== 'spline') throw new Error('Expected mapped spline');
    expect(keyCurveList([square])).toEqual(keyCurveList([mapped]));
  });

  it('範囲外・疎なXYZ・不正次数・部分結果を断り、CADの取消後も再計算できる', () => {
    const ready = { status: 'ready', curves: [{ kind: 'spline', mode: 'control', degree: 1, closed: false, points: [[0, 0, 0], [1, 1, 0]] }] };
    expect(readFunctionCurveGeometry(ready, input).status).toBe('ready');
    for (const points of [[[0, 0, 0], [2, 1, 0]], [[0, 0, 0], [1, NaN, 0]], [[0, 0, 0], Array(3)]]) {
      expect(readFunctionCurveGeometry({ ...ready, curves: [{ ...ready.curves[0], points }] }, input).status).toBe('failed');
    }
    expect(readFunctionCurveGeometry({ ...ready, curves: [{ ...ready.curves[0], degree: 3 }] }, input).status).toBe('failed');
    expect(readFunctionCurveGeometry({ ...ready, status: 'cancelled' }, input).status).toBe('failed');
    let count = 0;
    expect(functionCurvePolylines(oc, input, () => ++count > 4)).toEqual({ status: 'cancelled' });
    expect(functionCurvePolylines(oc, input).status).toBe('ready');
  });
});
