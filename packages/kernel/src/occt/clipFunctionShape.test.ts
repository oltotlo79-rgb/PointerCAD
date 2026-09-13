import { beforeAll, describe, expect, it } from 'vitest';
import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { createAllocations } from './allocations.js';
import { clipFunctionShape, type FunctionClipBox } from './clipFunctionShape.js';
import { makeSegmentEdge } from './makeSketchEdges.js';
import { makeSplineEdge } from './makeSplineEdge.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeBox } from './makeBox.js';
import { hasSolid, isValidShape, measureArea, measureVolume } from './solidMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
const box: FunctionClipBox = { minimum: [-3, -4, -3], maximum: [5, 6, 12] };
function vertices(shape: TopoDS_Shape): readonly Vec3Tuple[] {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const result: Vec3Tuple[] = [];
    for (let index = 1; index <= map.Size(); index++) {
      const item = keep(map.FindKey(index));
      if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_VERTEX) continue;
      const vertex = keep(oc.TopoDS.Vertex_1(item)), point = keep(oc.BRep_Tool.Pnt(vertex));
      result.push([point.X(), point.Y(), point.Z()]);
    }
    return result;
  } finally { release(); }
}
function readBounds(shape: TopoDS_Shape): FunctionClipBox {
  const { keep, release } = createAllocations();
  try {
    const bounds = keep(new oc.Bnd_Box_1()); oc.BRepBndLib.AddOptimal(shape, bounds, false, false); bounds.SetGap(0);
    const low = keep(bounds.CornerMin()), high = keep(bounds.CornerMax());
    return { minimum: [low.X(), low.Y(), low.Z()], maximum: [high.X(), high.Y(), high.Z()] };
  } finally { release(); }
}
function bounded(shape: TopoDS_Shape, expected: FunctionClipBox): void {
  const actual = readBounds(shape);
  // AddOptimal evaluates the trimmed geometry; Add can also include spline control-hull slack.
  for (let axis = 0; axis < 3; axis++) {
    expect(actual.minimum[axis]).toBeGreaterThanOrEqual(expected.minimum[axis] - 1e-6);
    expect(actual.maximum[axis]).toBeLessThanOrEqual(expected.maximum[axis] + 1e-6);
  }
}

describe('指定したXYZ範囲で関数のCAD辺・面を切り取る（ADD-4〜8）', () => {
  it('斜めの線をYとZの境界で切り、元の線上の端点を作る（座標クランプをしない）', () => {
    const line = makeSegmentEdge(oc, [-10, -20, -30], [10, 20, 30]);
    try {
      const before = vertices(line.edge), result = clipFunctionShape(oc, line.edge, box, 'edge');
      expect(result.status).toBe('shape');
      if (result.status !== 'shape') throw new Error('Expected clipped edge');
      try {
        bounded(result.shape, box); expect(result.count).toBe(1);
        const points = [...vertices(result.shape)].sort((a, b) => a[0] - b[0]);
        expect(points).toHaveLength(2);
        expect(points[0][0]).toBeCloseTo(-1, 8); expect(points[1][0]).toBeCloseTo(3, 8);
        for (const [x, y, z] of points) { expect(y).toBeCloseTo(2 * x, 8); expect(z).toBeCloseTo(3 * x, 8); }
        expect(vertices(line.edge)).toEqual(before);
      } finally { result.delete(); }
      expect(isValidShape(oc, line.edge)).toBe(true);
    } finally { line.delete(); }
  });

  it.each([0, 1, 2])('軸%sの両境界を実際の辺に適用する', (axis) => {
    const from: [number, number, number] = [0, 0, 0], to: [number, number, number] = [0, 0, 0];
    from[axis] = -20; to[axis] = 20;
    const line = makeSegmentEdge(oc, from, to);
    try {
      const result = clipFunctionShape(oc, line.edge, box, 'edge');
      if (result.status !== 'shape') throw new Error('Expected clipped edge');
      try {
        const values = vertices(result.shape).map(point => point[axis]).sort((a, b) => a - b);
        expect(values[0]).toBeCloseTo(box.minimum[axis], 8); expect(values[1]).toBeCloseTo(box.maximum[axis], 8);
        bounded(result.shape, box);
      } finally { result.delete(); }
    } finally { line.delete(); }
  });

  it('XYZ境界を横断する傾いた面を切り、元の平面式と面積を保つ', () => {
    const points: readonly Vec3Tuple[] = [[-10, -10, -30], [10, -10, -10], [10, 10, 30], [-10, 10, 10]];
    const curves: readonly CurveSpec[] = points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % points.length] }));
    const face = makePlanarFace(oc, curves);
    try {
      const bounds: FunctionClipBox = { minimum: [-1, -1, -10], maximum: [1, 1, 10] };
      const result = clipFunctionShape(oc, face.face, bounds, 'face');
      if (result.status !== 'shape') throw new Error('Expected clipped face');
      try {
        expect(result.count).toBe(1); bounded(result.shape, bounds); expect(hasSolid(oc, result.shape)).toBe(false);
        expect(measureArea(oc, result.shape)).toBeCloseTo(4 * Math.sqrt(6), 8);
        for (const [x, y, z] of vertices(result.shape)) expect(z).toBeCloseTo(x + 2 * y, 8);
      } finally { result.delete(); }
    } finally { face.delete(); }
  });

  it('閉じた表面を半分に切っても、範囲の境界に蓋を足さない', () => {
    const source = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const bounds: FunctionClipBox = { minimum: [-1, -1, -1], maximum: [5, 11, 11] };
      const result = clipFunctionShape(oc, source.shape, bounds, 'face');
      if (result.status !== 'shape') throw new Error('Expected open surface');
      try {
        expect(result.count).toBe(5); expect(hasSolid(oc, result.shape)).toBe(false);
        expect(measureArea(oc, result.shape)).toBeCloseTo(300, 8); // A cap at X=5 would incorrectly make this 400.
        bounded(result.shape, bounds);
      } finally { result.delete(); }
      expect(measureVolume(oc, source.shape)).toBeCloseTo(1000, 8);
    } finally { source.delete(); }
  });

  it('途中で範囲から出入りするBスプラインを、離れた成分へ分ける', () => {
    const curve = makeSplineEdge(oc, { mode: 'control', points: [[-4, 0, 0], [-1, 10, 0], [1, -10, 0], [4, 0, 0]] });
    try {
      const bounds: FunctionClipBox = { minimum: [-5, -1, -1], maximum: [5, 1, 1] };
      const result = clipFunctionShape(oc, curve.edge, bounds, 'edge');
      if (result.status !== 'shape') throw new Error('Expected separated edges');
      try {
        expect(result.count).toBe(3); bounded(result.shape, bounds);
        const allocations = createAllocations();
        try {
          const map = allocations.keep(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_2(result.shape, map, true, true);
          for (let index = 1; index <= map.Size(); index++) {
            const item = allocations.keep(map.FindKey(index));
            if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
            const edge = allocations.keep(oc.TopoDS.Edge_1(item)), adaptor = allocations.keep(new oc.BRepAdaptor_Curve_2(edge));
            for (let sample = 0; sample <= 20; sample++) {
              const t = adaptor.FirstParameter() + (adaptor.LastParameter() - adaptor.FirstParameter()) * sample / 20;
              const point = allocations.keep(adaptor.Value(t)), s = 1 - t;
              expect(point.X()).toBeCloseTo(-4*s**3 - 3*s**2*t + 3*s*t**2 + 4*t**3, 8);
              expect(point.Y()).toBeCloseTo(30*s**2*t - 30*s*t**2, 8);
              expect(point.Y()).toBeGreaterThanOrEqual(-1 - 1e-7);
              expect(point.Y()).toBeLessThanOrEqual(1 + 1e-7);
            }
          }
        } finally { allocations.release(); }
      } finally { result.delete(); }
    } finally { curve.delete(); }
  });

  it('範囲外の辺は空を返し、境界上の辺は保持する', () => {
    const outside = makeSegmentEdge(oc, [10, 0, 0], [20, 0, 0]), boundary = makeSegmentEdge(oc, [-3, 0, 0], [-3, 2, 0]);
    try {
      expect(clipFunctionShape(oc, outside.edge, box, 'edge')).toEqual({ status: 'empty' });
      const result = clipFunctionShape(oc, boundary.edge, box, 'edge');
      if (result.status !== 'shape') throw new Error('Expected boundary edge');
      try { expect(result.count).toBe(1); bounded(result.shape, box); } finally { result.delete(); }
    } finally { outside.delete(); boundary.delete(); }
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])('無効な範囲%sを拒否しても入力形状は残り、正しい範囲で再実行できる', (maximum) => {
    const line = makeSegmentEdge(oc, [-10, 0, 0], [10, 0, 0]);
    try {
      expect(() => clipFunctionShape(oc, line.edge, { minimum: [0, -1, -1], maximum: [maximum, 1, 1] }, 'edge')).toThrow('有限');
      const result = clipFunctionShape(oc, line.edge, box, 'edge');
      if (result.status !== 'shape') throw new Error('Expected retry to succeed');
      result.delete(); expect(isValidShape(oc, line.edge)).toBe(true);
    } finally { line.delete(); }
  });
});
