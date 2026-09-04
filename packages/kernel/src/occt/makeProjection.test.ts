import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import { makeBox } from './makeBox.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  makeProjection,
  orderPlaneCurves,
  planeBasisOf,
  projectPointToPlane,
  type PlaneCurve,
  type SketchPlaneFrame,
  type Vec2Tuple,
} from './makeProjection.js';
import { makeArcEdge, makeSegmentEdge } from './makeSketchEdges.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

const TAU = 2 * Math.PI;

/** XY と平行な作図面(第 1 軸 = X)。2 次元座標はそのまま (x, y) になる。 */
const XY_PLANE: SketchPlaneFrame = { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 1] };

/** 形の中の面(または辺)をすべて取り出す。呼び出し側が delete() する。 */
function collectOf(shape: TopoDS_Shape, kind: 'face' | 'edge'): TopoDS_Shape[] {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const want = kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const found: TopoDS_Shape[] = [];
  const count = Number(map.Size());
  for (let position = 1; position <= count; position += 1) {
    const subShape = map.FindKey(position);
    if (subShape.ShapeType() === want) {
      found.push(subShape);
    } else {
      subShape.delete();
    }
  }
  map.delete();
  return found;
}

/** 重心が指定の位置にある面を返す(面の選び方を座標で書けるようにするための試験用の道具)。 */
function findFaceByCentroid(shape: TopoDS_Shape, expected: Vec3Tuple): TopoDS_Shape | null {
  const faces = collectOf(shape, 'face');
  let found: TopoDS_Shape | null = null;
  for (const candidate of faces) {
    if (found !== null) {
      candidate.delete();
      continue;
    }
    const face = oc.TopoDS.Face_1(candidate);
    const properties = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(face, properties, false, false);
    const centre = properties.CentreOfMass();
    const matches =
      Math.hypot(centre.X() - expected[0], centre.Y() - expected[1], centre.Z() - expected[2]) <
      1e-6;
    centre.delete();
    properties.delete();
    face.delete();
    if (matches) {
      found = candidate;
    } else {
      candidate.delete();
    }
  }
  return found;
}

/** 円の辺のうち、半径と中心の高さが一致する最初のものを返す。 */
function findCircleEdge(shape: TopoDS_Shape, radius: number, z: number): TopoDS_Shape | null {
  const edges = collectOf(shape, 'edge');
  let found: TopoDS_Shape | null = null;
  for (const candidate of edges) {
    if (found !== null) {
      candidate.delete();
      continue;
    }
    const edge = oc.TopoDS.Edge_1(candidate);
    const adaptor = new oc.BRepAdaptor_Curve_2(edge);
    let matches = false;
    if (adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circle = adaptor.Circle();
      const center = circle.Location();
      matches = Math.abs(circle.Radius() - radius) < 1e-9 && Math.abs(center.Z() - z) < 1e-9;
      center.delete();
      circle.delete();
    }
    adaptor.delete();
    edge.delete();
    if (matches) {
      found = candidate;
    } else {
      candidate.delete();
    }
  }
  return found;
}

/** 40×30×10 の板の中央に φ6 の貫通穴を 1 つあけた形。 */
function makePlateWithHole(): { shape: TopoDS_Shape; delete: () => void } {
  const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
  const center = new oc.gp_Pnt_3(20, 15, -1);
  const up = new oc.gp_Dir_4(0, 0, 1);
  const seed = new oc.gp_Dir_4(1, 0, 0);
  const axes = new oc.gp_Ax2_2(center, up, seed);
  const drillMaker = new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 12);
  const drill = drillMaker.Shape();
  const range = new oc.Message_ProgressRange_1();
  const cut = new oc.BRepAlgoAPI_Cut_3(box.shape, drill, range);
  const shape = cut.Shape();
  return {
    shape,
    delete: (): void => {
      shape.delete();
      cut.delete();
      range.delete();
      drill.delete();
      drillMaker.delete();
      axes.delete();
      seed.delete();
      up.delete();
      center.delete();
      box.delete();
    },
  };
}

function startOf(curve: PlaneCurve): Vec2Tuple {
  if (curve.kind === 'segment') {
    return curve.from;
  }
  if (curve.kind === 'arc') {
    return [
      curve.center[0] + curve.radius * Math.cos(curve.startAngle),
      curve.center[1] + curve.radius * Math.sin(curve.startAngle),
    ];
  }
  return curve.points[0];
}

function endOf(curve: PlaneCurve): Vec2Tuple {
  if (curve.kind === 'segment') {
    return curve.to;
  }
  if (curve.kind === 'arc') {
    return [
      curve.center[0] + curve.radius * Math.cos(curve.endAngle),
      curve.center[1] + curve.radius * Math.sin(curve.endAngle),
    ];
  }
  return curve.points[curve.points.length - 1];
}

function gap(a: Vec2Tuple, b: Vec2Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function expectClosedLoop(curves: readonly PlaneCurve[]): void {
  expect(curves.length).toBeGreaterThan(0);
  for (let index = 1; index < curves.length; index += 1) {
    expect(gap(endOf(curves[index - 1]), startOf(curves[index]))).toBeLessThan(1e-6);
  }
  expect(gap(endOf(curves[curves.length - 1]), startOf(curves[0]))).toBeLessThan(1e-6);
}

function expectSameVertices(actual: readonly Vec2Tuple[], expected: readonly Vec2Tuple[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const point of expected) {
    const found = actual.some((candidate) => gap(candidate, point) < 1e-6);
    expect(found, `頂点 (${point[0]}, ${point[1]}) が見つかりません`).toBe(true);
  }
}

describe('作図面の姿勢と点の投影(makeProjection の土台)', () => {
  it('第 1 軸が法線と直交していなくても、直交する成分だけで作図面を決める', () => {
    const basis = planeBasisOf({ origin: [0, 0, 0], axisU: [1, 0, 5], normal: [0, 0, 2] });
    expect(basis.normal).toEqual([0, 0, 1]);
    expect(basis.axisU[0]).toBeCloseTo(1, 12);
    expect(basis.axisU[2]).toBeCloseTo(0, 12);
    // 第 2 軸は「法線 × 第 1 軸」なので Y になる。
    expect(basis.axisV[1]).toBeCloseTo(1, 12);
  });

  it('点は作図面へ直交投影され、原点をずらすと 2 次元座標もその分ずれる', () => {
    const basis = planeBasisOf({ origin: [5, 5, 0], axisU: [1, 0, 0], normal: [0, 0, 1] });
    expect(projectPointToPlane([12, 8, 99], basis)).toEqual([7, 3]);
  });
});

describe('立体の面・辺の投影(FR-325、makeProjection)', () => {
  it('40×30×10 の板の上面の外周を XY 面へ投影すると、線分 4 本の長方形になる', () => {
    const plate = makePlateWithHole();
    const top = findFaceByCentroid(plate.shape, [20, 15, 10]);
    expect(top).not.toBeNull();
    try {
      if (top === null) {
        return;
      }
      const { curves } = makeProjection(oc, { source: top, plane: XY_PLANE });
      expect(curves).toHaveLength(4);
      for (const curve of curves) {
        expect(curve.kind).toBe('segment');
      }
      expectClosedLoop(curves);
      expectSameVertices(
        curves.map((curve) => startOf(curve)),
        [
          [0, 0],
          [40, 0],
          [40, 30],
          [0, 30],
        ],
      );
    } finally {
      top?.delete();
      plate.delete();
    }
  });

  it('作図面の原点をずらすと、投影した輪郭も同じだけずれる', () => {
    const plate = makePlateWithHole();
    const top = findFaceByCentroid(plate.shape, [20, 15, 10]);
    try {
      if (top === null) {
        expect(top).not.toBeNull();
        return;
      }
      const { curves } = makeProjection(oc, {
        source: top,
        plane: { origin: [5, 5, 0], axisU: [1, 0, 0], normal: [0, 0, 1] },
      });
      expectSameVertices(
        curves.map((curve) => startOf(curve)),
        [
          [-5, -5],
          [35, -5],
          [35, 25],
          [-5, 25],
        ],
      );
    } finally {
      top?.delete();
      plate.delete();
    }
  });

  it('φ6 の穴の辺を投影すると、中心 (20, 15)・半径 3 の円 1 本になる', () => {
    const plate = makePlateWithHole();
    const hole = findCircleEdge(plate.shape, 3, 10);
    try {
      if (hole === null) {
        expect(hole).not.toBeNull();
        return;
      }
      const { curves } = makeProjection(oc, { source: hole, plane: XY_PLANE });
      expect(curves).toHaveLength(1);
      const curve = curves[0];
      expect(curve.kind).toBe('arc');
      if (curve.kind !== 'arc') {
        return;
      }
      expect(curve.center[0]).toBeCloseTo(20, 9);
      expect(curve.center[1]).toBeCloseTo(15, 9);
      expect(curve.radius).toBeCloseTo(3, 9);
      expect(Math.abs(curve.endAngle - curve.startAngle)).toBeCloseTo(TAU, 9);
    } finally {
      hole?.delete();
      plate.delete();
    }
  });

  it('作図面を YZ の向きにすると、側面の外周は 30×10 の長方形として返る', () => {
    const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    const side = findFaceByCentroid(box.shape, [40, 15, 5]);
    try {
      if (side === null) {
        expect(side).not.toBeNull();
        return;
      }
      // 第 1 軸を Y、法線を X にすると、2 次元座標は (y, z) になる。
      const { curves } = makeProjection(oc, {
        source: side,
        plane: { origin: [40, 0, 0], axisU: [0, 1, 0], normal: [1, 0, 0] },
      });
      expect(curves).toHaveLength(4);
      expectClosedLoop(curves);
      expectSameVertices(
        curves.map((curve) => startOf(curve)),
        [
          [0, 0],
          [30, 0],
          [30, 10],
          [0, 10],
        ],
      );
    } finally {
      side?.delete();
      box.delete();
    }
  });

  it('立体をそのまま渡すと、作図面に潰れない辺だけが返る(箱は 12 辺のうち 8 本)', () => {
    const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      const { curves } = makeProjection(oc, { source: box.shape, plane: XY_PLANE });
      // 縦 4 辺は Z 方向なので投影すると点に潰れ、結果から落ちる。
      expect(curves).toHaveLength(8);
      for (const curve of curves) {
        expect(curve.kind).toBe('segment');
      }
    } finally {
      box.delete();
    }
  });

  it('作図面の法線と平行な辺だけを投影しようとすると、理由をつけて断る(FR-504)', () => {
    const edge = makeSegmentEdge(oc, [0, 0, 0], [0, 0, 10]);
    try {
      expect(() => makeProjection(oc, { source: edge.edge, plane: XY_PLANE })).toThrow(
        '選んだ辺は作図面に対して真横を向いているため、投影しても線になりません。',
      );
    } finally {
      edge.delete();
    }
  });

  it('辺を 1 本も持たない形は、理由をつけて断る(FR-504)', () => {
    const point = new oc.gp_Pnt_3(1, 2, 3);
    const maker = new oc.BRepBuilderAPI_MakeVertex(point);
    const vertex = maker.Vertex();
    try {
      expect(() => makeProjection(oc, { source: vertex, plane: XY_PLANE })).toThrow(
        '投影できる辺がありません。面か辺を選び直してください。',
      );
    } finally {
      vertex.delete();
      maker.delete();
      point.delete();
    }
  });

  it('点列の点の数は 100 までに間引かれ、両端の点は残る', () => {
    const half = Math.SQRT1_2;
    const arc = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 10],
      normal: [0, half, half],
      xAxis: [1, 0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: TAU,
    });
    try {
      // 細かく刻ませると 100 を超える点が出るので、間引きが働くことを確かめる。
      const { curves } = makeProjection(oc, {
        source: arc.edge,
        plane: XY_PLANE,
        tessellation: { linearDeflection: 1e-4, angularDeflection: 0.02 },
      });
      expect(curves).toHaveLength(1);
      const curve = curves[0];
      expect(curve.kind).toBe('polyline');
      if (curve.kind !== 'polyline') {
        return;
      }
      expect(curve.points).toHaveLength(100);
      // 間引いた後も、全ての点が楕円の上に乗ったままであること。
      for (const [u, v] of curve.points) {
        expect((u / 5) ** 2 + (v / (5 * half)) ** 2).toBeCloseTo(1, 4);
      }
      // 円の第 1 軸(パラメータ 0)の点 (5, 0) が先頭に残る。
      expect(gap(curve.points[0], [5, 0])).toBeLessThan(1e-5);
    } finally {
      arc.delete();
    }
  });

  it('作図面と平行でない円は点列で返り、点は投影後の楕円の上に乗る', () => {
    const half = Math.SQRT1_2;
    // 法線 (0,1,1)/√2 の面に乗る半径 5 の円。XY へ落とすと短軸 5/√2 の楕円になる。
    const arc = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 10],
      normal: [0, half, half],
      xAxis: [1, 0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: TAU,
    });
    try {
      const { curves } = makeProjection(oc, { source: arc.edge, plane: XY_PLANE });
      expect(curves).toHaveLength(1);
      const curve = curves[0];
      expect(curve.kind).toBe('polyline');
      if (curve.kind !== 'polyline') {
        return;
      }
      expect(curve.closed).toBe(true);
      expect(curve.points.length).toBeGreaterThanOrEqual(3);
      expect(curve.points.length).toBeLessThanOrEqual(100);
      for (const [u, v] of curve.points) {
        expect((u / 5) ** 2 + (v / (5 * half)) ** 2).toBeCloseTo(1, 4);
      }
      // 閉じた曲線は最初の点と最後の点を重ねない。
      expect(gap(curve.points[0], curve.points[curve.points.length - 1])).toBeGreaterThan(1e-6);
    } finally {
      arc.delete();
    }
  });

  it('作図面の指定が壊れているときは日本語の理由で断る(FR-504)', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      expect(() =>
        makeProjection(oc, {
          source: box.shape,
          plane: { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 0] },
        }),
      ).toThrow('作図面の法線の長さが 0 です。向きを指定し直してください。');
    } finally {
      box.delete();
    }
  });
});

describe('曲線の並べ替え(orderPlaneCurves)', () => {
  it('ばらばらな順・向きの線分を、つながる順に並べ替えて向きも揃える', () => {
    // 40×30 の長方形を、輪郭をたどる順ではない並びで渡す(OCCT が返す並びと同じ形)。
    const scrambled: PlaneCurve[] = [
      { kind: 'segment', from: [0, 30], to: [0, 0] },
      { kind: 'segment', from: [0, 30], to: [40, 30] },
      { kind: 'segment', from: [0, 0], to: [40, 0] },
      { kind: 'segment', from: [40, 30], to: [40, 0] },
    ];
    const ordered = orderPlaneCurves(scrambled);
    expect(ordered).toHaveLength(4);
    expectClosedLoop(ordered);
  });

  it('全周の円は 1 本で閉じているので、他の曲線とつなげない', () => {
    const curves: PlaneCurve[] = [
      { kind: 'arc', center: [0, 0], radius: 5, startAngle: 0, endAngle: TAU },
      { kind: 'segment', from: [10, 0], to: [20, 0] },
      { kind: 'segment', from: [20, 0], to: [20, 10] },
    ];
    const ordered = orderPlaneCurves(curves);
    expect(ordered).toHaveLength(3);
    expect(ordered[0].kind).toBe('arc');
    expect(gap(endOf(ordered[1]), startOf(ordered[2]))).toBeLessThan(1e-9);
  });

  it('円弧の向きを反転すると開始角と終了角が入れ替わる', () => {
    const curves: PlaneCurve[] = [
      { kind: 'segment', from: [0, 0], to: [5, 0] },
      // 終点 (5,0) につながるのは、この円弧の「終わり」の側。
      { kind: 'arc', center: [5, 5], radius: 5, startAngle: Math.PI / 2, endAngle: -Math.PI / 2 },
    ];
    const ordered = orderPlaneCurves(curves);
    expect(ordered).toHaveLength(2);
    const second = ordered[1];
    expect(second.kind).toBe('arc');
    if (second.kind !== 'arc') {
      return;
    }
    expect(gap(startOf(second), [5, 0])).toBeLessThan(1e-9);
    expect(second.endAngle - second.startAngle).toBeCloseTo(Math.PI, 9);
  });
});
