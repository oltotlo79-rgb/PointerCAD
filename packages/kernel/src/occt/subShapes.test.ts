import { beforeAll, describe, expect, it } from 'vitest';

import type { SolidFaceInfo, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations, type OcctDeletable } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makeExtrudeSolid, makeRevolveSolid } from './makeSolidSweep.js';
import { placeShape } from './placeBodies.js';
import type { SubShapeTables } from './subShapes.js';
import {
  booleanMargin,
  boundingDiagonal,
  collectSubShapes,
  edgeAt,
  edgesTouchingVertex,
  faceAt,
  facesTouchingEdge,
  vertexAt,
} from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

describe('解析軸上点の収集(P7-14b)', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function halfShape(kind: 'cylinder' | 'cone'): OcctShapeHandle {
    const { keep, release } = createAllocations();
    try {
      const maker = kind === 'cylinder'
        ? keep(new oc.BRepPrimAPI_MakeCylinder_2(5, 10, Math.PI))
        : keep(new oc.BRepPrimAPI_MakeCone_2(5, 0, 10, Math.PI));
      return { shape: keep(maker.Shape()), delete: release };
    } catch (error) { release(); throw error; }
  }

  function collect(shape: OcctShapeHandle['shape'], factory?: () => Allocations): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const edges = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, edges.edgeRanges, factory);
  }

  function closePoint(actual: Vec3Tuple | null | undefined, expected: Vec3Tuple): void {
    if (actual == null) throw new Error('解析点または軸がない');
    expected.forEach((value, index) => expect(Math.abs(actual[index] - value)).toBeLessThanOrEqual(1e-9));
  }

  function analyticFace(table: SubShapeTables, kind: 'cylinder' | 'cone'): SolidFaceInfo {
    const found = table.faces.find((face) => face.surfaceKind === kind);
    if (found === undefined) throw new Error('解析面がない');
    return found;
  }

  function counted(failAfter?: number): {
    readonly factory: () => Allocations;
    readonly counts: () => { kept: number; deleted: number; duplicates: number };
  } {
    let kept = 0;
    let deleted = 0;
    let duplicates = 0;
    const released = new Set<OcctDeletable>();
    return {
      factory: () => {
        const inner = createAllocations();
        return {
          keep<T extends OcctDeletable>(item: T): T {
            kept += 1;
            const originalDelete = item.delete.bind(item);
            item.delete = (): void => {
              if (released.has(item)) duplicates += 1;
              released.add(item);
              deleted += 1;
              originalDelete();
            };
            inner.keep(item);
            if (kept === failAfter) throw new Error('軸情報の読取検査');
            return item;
          },
          release: () => inner.release(),
        };
      },
      counts: () => ({ kept, deleted, duplicates }),
    };
  }

  it('半円筒の軸上点は原点で、重心は軸から10/π離れる', () => {
    const handle = halfShape('cylinder');
    try {
      const face = analyticFace(collect(handle.shape), 'cylinder');
      closePoint(face.axisOrigin, [0, 0, 0]);
      closePoint(face.centroid, [0, 10 / Math.PI, 5]);
      expect(Math.abs(Math.hypot(face.centroid[0], face.centroid[1]) - 10 / Math.PI)).toBeLessThanOrEqual(1e-9);
      expect(face.radius).toBe(5);
    } finally { handle.delete(); }
  });

  it('半円錐の軸上点は基準断面の中心で、面重心を代用しない', () => {
    const handle = halfShape('cone');
    try {
      const face = analyticFace(collect(handle.shape), 'cone');
      closePoint(face.axisOrigin, [0, 0, 0]);
      closePoint(face.centroid, [0, 20 / (3 * Math.PI), 10 / 3]);
      closePoint(face.axis, [0, 0, 1]);
    } finally { handle.delete(); }
  });

  it('半円の辺は長さ5π・重心y=10/πでも解析中心y=0を返す', () => {
    const handle = halfShape('cylinder');
    try {
      const circles = collect(handle.shape).edges.filter((edge) => edge.curveKind === 'circle');
      expect(circles).toHaveLength(2);
      for (const edge of circles) {
        const z = edge.midpoint[2] > 5 ? 10 : 0;
        closePoint(edge.axisOrigin, [0, 0, z]);
        closePoint(edge.midpoint, [0, 10 / Math.PI, z]);
        expect(Math.abs(edge.length - 5 * Math.PI)).toBeLessThanOrEqual(1e-9);
      }
    } finally { handle.delete(); }
  });

  it('形にあるLocationを軸上点と円中心へ1回だけ適用する', () => {
    for (const kind of ['cylinder', 'cone'] as const) {
      const handle = halfShape(kind);
      const moved = placeShape(oc, handle.shape, {
        position: [11, 13, 17], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      });
      try {
        const table = collect(moved.shape);
        const face = analyticFace(table, kind);
        closePoint(face.axisOrigin, [11, 13, 17]);
        closePoint(face.axis, [0, -1, 0]);
        if (face.axis === null) throw new Error('軸がない');
        expect(Math.abs(Math.hypot(...face.axis) - 1)).toBeLessThanOrEqual(1e-12);
        for (const edge of table.edges.filter((item) => item.curveKind === 'circle' && item.length > 1e-7)) {
          const y = kind === 'cylinder' && edge.midpoint[1] < 8 ? 3 : 13;
          closePoint(edge.axisOrigin, [11, y, 17]);
        }
      } finally { moved.delete(); handle.delete(); }
    }
  });

  it('円筒・円錐・円のLocationと軸Locationは所有元に波及しない複製', () => {
    const { keep, release } = createAllocations();
    try {
      const location = keep(new oc.gp_Pnt_3(11, 13, 17));
      const geometries = [keep(new oc.gp_Cylinder_1()), keep(new oc.gp_Cone_1()), keep(new oc.gp_Circ_1())];
      for (const geometry of geometries) {
        expect(typeof geometry.Location).toBe('function');
        geometry.SetLocation(location);
        const first = keep(geometry.Location());
        const second = keep(geometry.Location());
        const axis = keep(geometry.Axis());
        const axisPoint = keep(axis.Location());
        first.SetX(999);
        axisPoint.SetY(999);
        expect(second.X()).toBe(11);
        expect(keep(geometry.Location()).X()).toBe(11);
        expect(keep(axis.Location()).Y()).toBe(13);
      }
    } finally { release(); }
  });

  it('収集の成功時は円筒・円錐の全登録オブジェクトを各1回だけ解放する', () => {
    for (const kind of ['cylinder', 'cone'] as const) {
      const handle = halfShape(kind);
      const counter = counted();
      try {
        collect(handle.shape, counter.factory);
        const counts = counter.counts();
        expect(counts.kept).toBeGreaterThan(0);
        expect(counts.deleted).toBe(counts.kept);
        expect(counts.duplicates).toBe(0);
        console.info('P7-14b allocations', kind, counts);
      } finally { handle.delete(); }
    }
  });

  it('軸情報を収集中の例外でも全登録オブジェクトを各1回だけ解放する', () => {
    const handle = halfShape('cylinder');
    // map・subShape・face・adaptor・cylinder・axis・direction・Locationの8個目。
    // 解析点そのものを登録した直後に失敗させ、その複製も解放する。
    const counter = counted(8);
    try {
      expect(() => collect(handle.shape, counter.factory)).toThrow('軸情報の読取検査');
      expect(counter.counts()).toEqual({ kept: 8, deleted: 8, duplicates: 0 });
      // 失敗後も貸した形は有効。
      closePoint(analyticFace(collect(handle.shape), 'cylinder').axisOrigin, [0, 0, 0]);
    } finally { handle.delete(); }
  });

  it('収集後に同じ形を再収集・移動しても元の面情報を壊さない', () => {
    const handle = halfShape('cylinder');
    try {
      const before = collect(handle.shape);
      const moved = placeShape(oc, handle.shape, { position: [10, 0, 0], rotation: [0, 0, 0, 1] });
      try { closePoint(analyticFace(collect(moved.shape), 'cylinder').axisOrigin, [10, 0, 0]); }
      finally { moved.delete(); }
      expect(collect(handle.shape)).toEqual(before);
    } finally { handle.delete(); }
  });

  it('平面と直線辺は解析軸上点をnullとし、重心・中点を置き換えない', () => {
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const table = collect(handle.shape);
      expect(table.faces.every((face) => face.axisOrigin === null)).toBe(true);
      expect(table.edges.every((edge) => edge.axisOrigin === null)).toBe(true);
      expect(table.faces.some((face) => face.centroid[2] === 30)).toBe(true);
    } finally { handle.delete(); }
  });

  it('解析点は再収集で決定的になり負のゼロを含まない', () => {
    const handle = halfShape('cylinder');
    try {
      const first = collect(handle.shape);
      expect(collect(handle.shape)).toEqual(first);
      const points = [...first.faces, ...first.edges].flatMap((item) => item.axisOrigin ?? []);
      expect(points.length).toBeGreaterThan(0);
      expect(points.every((value) => Number.isFinite(value) && !Object.is(value, -0))).toBe(true);
    } finally { handle.delete(); }
  });
});

/** 計画書 タスク4 の検証表が使う箱。頂点は (0,0,0)〜(10,20,30)。 */
const BOX = { dx: 10, dy: 20, dz: 30 } as const;

/**
 * 統括の指示にある板。40×30 の面を Z へ 10 押し出した形と同じ寸法で、
 * 計画書 §2.2.3 の指紋の検算表(上の面 = 面積 1200・法線 [0,0,1]・重心 [20,15,10])に対応する。
 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** 数値の並びを文字列にして集合として比べる(-0 と +0 も別物として扱う)。 */
function tupleKey(tuple: Vec3Tuple | null): string {
  if (tuple === null) {
    return 'null';
  }
  return tuple.map((value) => (Object.is(value, -0) ? '-0' : String(value))).join(',');
}

describe('ソリッドの面・辺・頂点の一覧と素性(FR-106、FR-405〜408、FR-502)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function collect(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  /** 半径 20 の円を Z へ 5 押し出した円柱。面 3 枚(側面・上面・下面)・辺 3 本。 */
  function makeCylinder(): OcctShapeHandle {
    return makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 20,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      direction: [0, 0, 1],
      distance: 5,
    });
  }

  /** 直角三角形を Z 軸まわりに 1 周回した円錐(底面の半径 10、高さ 20)。先端に退化した辺が出る。 */
  function makeCone(): OcctShapeHandle {
    return makeRevolveSolid(oc, {
      kind: 'revolve',
      profile: [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        { kind: 'segment', from: [10, 0, 0], to: [0, 0, 20] },
        { kind: 'segment', from: [0, 0, 20], to: [0, 0, 0] },
      ],
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      angle: 2 * Math.PI,
    });
  }

  it('箱では面 6 枚・辺 12 本・頂点 8 個が 0 始まりの通し番号で並ぶ', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { faces, edges, vertices } = collect(handle.shape);
      expect(faces.length).toBe(6);
      expect(edges.length).toBe(12);
      expect(vertices.length).toBe(8);
      expect(faces.map((face) => face.index)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(edges.map((edge) => edge.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(vertices.map((vertex) => vertex.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      handle.delete();
    }
  });

  it('箱の面はすべて平面で、面積の合計が 2·(10·20 + 20·30 + 30·10) = 2200 になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { faces } = collect(handle.shape);
      expect(faces.every((face) => face.surfaceKind === 'plane')).toBe(true);
      expect(faces.every((face) => face.radius === null)).toBe(true);
      const total = faces.reduce((sum, face) => sum + face.area, 0);
      expect(total).toBeCloseTo(2 * (10 * 20 + 20 * 30 + 30 * 10), 6);
      // 面積の内訳。10×20 が 2 枚、20×30 が 2 枚、30×10 が 2 枚。
      expect(sortedNumbers(faces.map((face) => Math.round(face.area)))).toEqual([
        200, 200, 300, 300, 600, 600,
      ]);
    } finally {
      handle.delete();
    }
  });

  it('箱の面の法線が外向きの 6 方向に 1 つずつ揃い、上の面が [0,0,1] になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { faces } = collect(handle.shape);
      // 下地の曲面の軸は 3 方向しか出ないので、面が反転しているときは符号を反転して外向きに揃える。
      expect([...faces.map((face) => tupleKey(face.axis))].sort()).toEqual(
        ['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0'].sort(),
      );

      const top = faces.find((face) => face.centroid[2] === BOX.dz);
      expect(top).toBeDefined();
      expect(top?.axis).toEqual([0, 0, 1]);
      // 上の面の重心は (10/2, 20/2, 30)。
      expect(top?.centroid[0]).toBeCloseTo(5, 6);
      expect(top?.centroid[1]).toBeCloseTo(10, 6);
      expect(top?.centroid[2]).toBeCloseTo(30, 6);
      expect(top?.area).toBeCloseTo(10 * 20, 6);
    } finally {
      handle.delete();
    }
  });

  it('40×30×10 の板でも面積・法線・重心が寸法どおりになる(§2.2.3 の検算表の形)', () => {
    const handle = makeBox(oc, PLATE);
    try {
      const { faces, edges, vertices } = collect(handle.shape);
      expect(faces.length).toBe(6);
      expect(edges.length).toBe(12);
      expect(vertices.length).toBe(8);
      // 40·30 が 2 枚、30·10 が 2 枚、40·10 が 2 枚。
      expect(sortedNumbers(faces.map((face) => Math.round(face.area)))).toEqual([
        300, 300, 400, 400, 1200, 1200,
      ]);

      const top = faces.find((face) => face.centroid[2] === PLATE.dz);
      expect(top?.axis).toEqual([0, 0, 1]);
      expect(top?.area).toBeCloseTo(40 * 30, 6);
      expect(top?.centroid[0]).toBeCloseTo(20, 6);
      expect(top?.centroid[1]).toBeCloseTo(15, 6);
      expect(top?.centroid[2]).toBeCloseTo(10, 6);

      // 辺の長さは 40 が 4 本、30 が 4 本、10 が 4 本。
      expect(sortedNumbers(edges.map((edge) => Math.round(edge.length)))).toEqual([
        10, 10, 10, 10, 30, 30, 30, 30, 40, 40, 40, 40,
      ]);
    } finally {
      handle.delete();
    }
  });

  it('箱の辺はすべて直線で、長さの合計が 4·(10+20+30) = 240 になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { edges } = collect(handle.shape);
      expect(edges.every((edge) => edge.curveKind === 'line')).toBe(true);
      expect(edges.every((edge) => edge.radius === null)).toBe(true);
      const total = edges.reduce((sum, edge) => sum + edge.length, 0);
      expect(total).toBeCloseTo(4 * (10 + 20 + 30), 6);
      expect(sortedNumbers(edges.map((edge) => Math.round(edge.length)))).toEqual([
        10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30,
      ]);
      // 中点は両端のちょうど真ん中、向きは軸に平行な単位ベクトル。
      for (const edge of edges) {
        for (let axis = 0; axis < 3; axis += 1) {
          expect(edge.midpoint[axis]).toBeCloseTo((edge.start[axis] + edge.end[axis]) / 2, 6);
        }
        expect(edge.axis).not.toBeNull();
        const direction = edge.axis ?? [0, 0, 0];
        expect(Math.hypot(...direction)).toBeCloseTo(1, 9);
        expect(Math.abs(direction[0]) + Math.abs(direction[1]) + Math.abs(direction[2])).toBeCloseTo(
          1,
          9,
        );
      }
    } finally {
      handle.delete();
    }
  });

  it('箱の頂点 8 個が 0 と辺の長さの組合せをすべて 1 度ずつ持つ', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { vertices } = collect(handle.shape);
      const expected: string[] = [];
      for (const x of [0, BOX.dx]) {
        for (const y of [0, BOX.dy]) {
          for (const z of [0, BOX.dz]) {
            expected.push(`${x},${y},${z}`);
          }
        }
      }
      expect([...vertices.map((vertex) => tupleKey(vertex.position))].sort()).toEqual(
        expected.sort(),
      );
    } finally {
      handle.delete();
    }
  });

  it('面と辺の通し番号が tessellate / extractEdges の範囲表と 1 対 1 に対応する(P3 の土台)', () => {
    for (const parameters of [BOX, PLATE]) {
      const handle = makeBox(oc, parameters);
      try {
        const mesh = tessellate(oc, handle.shape);
        const lines = extractEdges(oc, handle.shape);
        const { faces, edges } = collectSubShapes(
          oc,
          handle.shape,
          mesh.faceRanges,
          lines.edgeRanges,
        );
        expect(faces.length).toBe(mesh.faceCount);
        expect(edges.length).toBe(lines.edgeCount);
        for (const [index, face] of faces.entries()) {
          expect(face.triangleOffset).toBe(mesh.faceRanges[index].triangleOffset);
          expect(face.triangleCount).toBe(mesh.faceRanges[index].triangleCount);
        }
        for (const [index, edge] of edges.entries()) {
          expect(edge.segmentOffset).toBe(lines.edgeRanges[index].segmentOffset);
          expect(edge.segmentCount).toBe(lines.edgeRanges[index].segmentCount);
        }
      } finally {
        handle.delete();
      }
    }
  });

  it('範囲表の長さが形と食い違ったら理由つきで断る', () => {
    const handle = makeBox(oc, BOX);
    try {
      const mesh = tessellate(oc, handle.shape);
      const lines = extractEdges(oc, handle.shape);
      expect(() =>
        collectSubShapes(oc, handle.shape, mesh.faceRanges.slice(1), lines.edgeRanges),
      ).toThrow(/面の枚数/);
      expect(() =>
        collectSubShapes(oc, handle.shape, mesh.faceRanges, lines.edgeRanges.slice(1)),
      ).toThrow(/辺の本数/);
    } finally {
      handle.delete();
    }
  });

  it('通し番号から面・辺・頂点の実体を取り出せ、範囲の外では null になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const face = faceAt(oc, handle.shape, 0);
      expect(face).not.toBeNull();
      expect(face?.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE).toBe(true);
      face?.delete();

      const lastEdge = edgeAt(oc, handle.shape, 11);
      expect(lastEdge).not.toBeNull();
      expect(lastEdge?.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE).toBe(true);
      lastEdge?.delete();

      const lastVertex = vertexAt(oc, handle.shape, 7);
      expect(lastVertex).not.toBeNull();
      expect(lastVertex?.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX).toBe(true);
      lastVertex?.delete();

      expect(faceAt(oc, handle.shape, 6)).toBeNull();
      expect(edgeAt(oc, handle.shape, 12)).toBeNull();
      expect(vertexAt(oc, handle.shape, 8)).toBeNull();
      expect(faceAt(oc, handle.shape, -1)).toBeNull();
      expect(faceAt(oc, handle.shape, 0.5)).toBeNull();
    } finally {
      handle.delete();
    }
  });

  it('取り出した面の位置が一覧の重心と合う(通し番号の付け方が一致している)', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { faces } = collect(handle.shape);
      for (const [index, info] of faces.entries()) {
        const face = faceAt(oc, handle.shape, index);
        expect(face).not.toBeNull();
        if (face === null) {
          continue;
        }
        const properties = new oc.GProp_GProps_1();
        try {
          oc.BRepGProp.SurfaceProperties_1(face, properties, false, false);
          const centre = properties.CentreOfMass();
          expect(centre.X()).toBeCloseTo(info.centroid[0], 6);
          expect(centre.Y()).toBeCloseTo(info.centroid[1], 6);
          expect(centre.Z()).toBeCloseTo(info.centroid[2], 6);
          expect(properties.Mass()).toBeCloseTo(info.area, 6);
          centre.delete();
        } finally {
          properties.delete();
          face.delete();
        }
      }
    } finally {
      handle.delete();
    }
  });

  it('箱では辺 1 本に面が 2 枚接し、頂点 1 つに辺が 3 本集まる', () => {
    const handle = makeBox(oc, BOX);
    try {
      for (let edgeIndex = 0; edgeIndex < 12; edgeIndex += 1) {
        const faces = facesTouchingEdge(oc, handle.shape, edgeIndex);
        expect(faces.length).toBe(2);
        expect(new Set(faces).size).toBe(2);
        expect(faces.every((index) => index >= 0 && index < 6)).toBe(true);
        // 並びの順(番号の小さい順)で返る。
        expect([...faces]).toEqual(sortedNumbers(faces));
      }
      for (let vertexIndex = 0; vertexIndex < 8; vertexIndex += 1) {
        const edges = edgesTouchingVertex(oc, handle.shape, vertexIndex);
        expect(edges.length).toBe(3);
        expect(new Set(edges).size).toBe(3);
        expect([...edges]).toEqual(sortedNumbers(edges));
      }
      // 範囲の外は空の配列。
      expect(facesTouchingEdge(oc, handle.shape, 12)).toEqual([]);
      expect(edgesTouchingVertex(oc, handle.shape, 8)).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  it('辺に接する面の番号と、頂点に集まる辺の番号が互いに矛盾しない', () => {
    const handle = makeBox(oc, BOX);
    try {
      // 箱の 12 本の辺には、6 枚の面がそれぞれ 4 回ずつ現れる(1 面が 4 辺を持つ)。
      const counts = new Map<number, number>();
      for (let edgeIndex = 0; edgeIndex < 12; edgeIndex += 1) {
        for (const faceIndex of facesTouchingEdge(oc, handle.shape, edgeIndex)) {
          counts.set(faceIndex, (counts.get(faceIndex) ?? 0) + 1);
        }
      }
      expect([...counts.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
      expect([...counts.values()]).toEqual([4, 4, 4, 4, 4, 4]);

      // 8 頂点 × 3 辺 = 24 で、12 本の辺がそれぞれ 2 回(両端)現れる。
      const edgeCounts = new Map<number, number>();
      for (let vertexIndex = 0; vertexIndex < 8; vertexIndex += 1) {
        for (const edgeIndex of edgesTouchingVertex(oc, handle.shape, vertexIndex)) {
          edgeCounts.set(edgeIndex, (edgeCounts.get(edgeIndex) ?? 0) + 1);
        }
      }
      expect(edgeCounts.size).toBe(12);
      expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('境界箱の対角長が √(10²+20²+30²) = √1400 になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      expect(boundingDiagonal(oc, handle.shape)).toBeCloseTo(Math.sqrt(1400), 9);
      // √1400 = 37.416573867739416。
      expect(Math.sqrt(1400)).toBeCloseTo(37.416573867739416, 12);
    } finally {
      handle.delete();
    }
    const plate = makeBox(oc, PLATE);
    try {
      expect(boundingDiagonal(oc, plate.shape)).toBeCloseTo(Math.sqrt(1600 + 900 + 100), 9);
    } finally {
      plate.delete();
    }
  });

  /**
   * ブーリアンの余裕(§0.a-0.12)を 1 か所へまとめた(§0.a-0.78、タスク42b)ので、
   * **まとめる前に 5 か所(makeHole / makeEmboss / makeRib / makeCut / makeSolidSweep)へ
   * 写されていた値とまったく同じ数**であることをここで固定する。期待値はまとめた式を
   * 呼び直さず、`対角長 × 0.01 + 1mm` を手で書いて確かめる(定数を変えたら赤くなる)。
   */
  it('ブーリアンの余裕は 対角長 × 0.01 + 1mm(まとめる前の 5 か所と同じ数)', () => {
    // 40×30×10 の板。対角長 √2600 = 50.99019513592785 → 余裕 1.5099019513592786。
    const plateDiagonal = Math.sqrt(2600);
    expect(booleanMargin(plateDiagonal)).toBe(plateDiagonal * 0.01 + 1);
    expect(booleanMargin(plateDiagonal)).toBeCloseTo(1.5099019513592786, 12);
    // 10×20×30 の箱。対角長 √1400 = 37.416573867739416 → 余裕 1.3741657386773942。
    expect(booleanMargin(Math.sqrt(1400))).toBe(Math.sqrt(1400) * 0.01 + 1);
    expect(booleanMargin(Math.sqrt(1400))).toBeCloseTo(1.3741657386773942, 12);
    // 部品が小さくても下限の 1mm は必ず取る(割合と下限の 2 本立て)。
    expect(booleanMargin(0)).toBe(1);
    expect(booleanMargin(1)).toBe(1.01);
    // 実際の形から測った対角長でも同じ式になる(呼び出し側と同じ経路)。
    const plate = makeBox(oc, PLATE);
    try {
      const measured = boundingDiagonal(oc, plate.shape);
      expect(booleanMargin(measured)).toBe(measured * 0.01 + 1);
    } finally {
      plate.delete();
    }
  });

  it('中身の無い形の対角長は 0 になる', () => {
    const builder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    try {
      builder.MakeCompound(compound);
      expect(boundingDiagonal(oc, compound)).toBe(0);
      const { faces, edges, vertices } = collectSubShapes(oc, compound, [], []);
      expect(faces).toEqual([]);
      expect(edges).toEqual([]);
      expect(vertices).toEqual([]);
    } finally {
      compound.delete();
      builder.delete();
    }
  });

  it('円柱では側面が cylinder・半径 20・軸が Z 方向になり、面積の合計が 1000π になる', () => {
    const handle = makeCylinder();
    try {
      const { faces, edges } = collect(handle.shape);
      expect(faces.length).toBe(3);
      const side = faces.filter((face) => face.surfaceKind === 'cylinder');
      expect(side.length).toBe(1);
      expect(side[0].radius).toBeCloseTo(20, 9);
      expect(side[0].axis).not.toBeNull();
      const axis = side[0].axis ?? [0, 0, 0];
      expect(Math.abs(axis[2])).toBeCloseTo(1, 9);
      expect(axis[0]).toBeCloseTo(0, 9);
      expect(axis[1]).toBeCloseTo(0, 9);
      // 側面 2π·20·5 = 628.3185307179587、上下の円 π·20² ずつ = 2513.274122871834。
      expect(side[0].area).toBeCloseTo(2 * Math.PI * 20 * 5, 6);
      const total = faces.reduce((sum, face) => sum + face.area, 0);
      expect(total).toBeCloseTo(2 * Math.PI * 20 * 20 + 2 * Math.PI * 20 * 5, 6);

      // 辺は上下の円 2 本(長さ 2π·20)と継ぎ目の直線 1 本(長さ 5)。
      expect(edges.length).toBe(3);
      const circles = edges.filter((edge) => edge.curveKind === 'circle');
      expect(circles.length).toBe(2);
      for (const circle of circles) {
        expect(circle.radius).toBeCloseTo(20, 9);
        expect(circle.length).toBeCloseTo(2 * Math.PI * 20, 6);
        expect(Math.abs((circle.axis ?? [0, 0, 0])[2])).toBeCloseTo(1, 9);
      }
      const seam = edges.filter((edge) => edge.curveKind === 'line');
      expect(seam.length).toBe(1);
      expect(seam[0].length).toBeCloseTo(5, 6);
    } finally {
      handle.delete();
    }
  });

  it('円錐では側面が cone になり、長さの無い辺でも中点が先端に置かれる', () => {
    const handle = makeCone();
    try {
      const { faces, edges } = collect(handle.shape);
      expect(faces.length).toBe(2);
      const cone = faces.filter((face) => face.surfaceKind === 'cone');
      expect(cone.length).toBe(1);
      expect(cone[0].radius).toBeCloseTo(10, 6);
      expect(Math.abs((cone[0].axis ?? [0, 0, 0])[2])).toBeCloseTo(1, 9);
      // 側面積 = π·r·母線 = π·10·√(10²+20²)、底面積 = π·10²。
      expect(cone[0].area).toBeCloseTo(Math.PI * 10 * Math.sqrt(500), 6);
      const base = faces.filter((face) => face.surfaceKind === 'plane');
      expect(base.length).toBe(1);
      expect(base[0].area).toBeCloseTo(Math.PI * 100, 6);

      expect(edges.length).toBe(3);
      const degenerate = edges.filter((edge) => edge.length === 0);
      expect(degenerate.length).toBe(1);
      // 長さ 0 の辺は重心が求まらず原点が返るので、両端の中点(= 先端 (0,0,20))で置き換える。
      expect(degenerate[0].midpoint[0]).toBeCloseTo(0, 6);
      expect(degenerate[0].midpoint[1]).toBeCloseTo(0, 6);
      expect(degenerate[0].midpoint[2]).toBeCloseTo(20, 6);
      expect(degenerate[0].start[2]).toBeCloseTo(20, 6);
      expect(degenerate[0].end[2]).toBeCloseTo(20, 6);
    } finally {
      handle.delete();
    }
  });

  it('軸と法線はすべて長さ 1 で、-0 を含む数値が 1 つも無い', () => {
    for (const build of [
      () => makeBox(oc, BOX),
      () => makeCylinder(),
      () => makeCone(),
    ] as const) {
      const handle = build();
      try {
        const { faces, edges, vertices } = collect(handle.shape);
        const numbers: number[] = [];
        for (const face of faces) {
          numbers.push(face.area, ...face.centroid);
          if (face.radius !== null) {
            numbers.push(face.radius);
          }
          if (face.axis !== null) {
            expect(Math.hypot(...face.axis)).toBeCloseTo(1, 9);
            numbers.push(...face.axis);
          }
        }
        for (const edge of edges) {
          numbers.push(edge.length, ...edge.midpoint, ...edge.start, ...edge.end);
          if (edge.radius !== null) {
            numbers.push(edge.radius);
          }
          if (edge.axis !== null) {
            expect(Math.hypot(...edge.axis)).toBeCloseTo(1, 9);
            numbers.push(...edge.axis);
          }
        }
        for (const vertex of vertices) {
          numbers.push(...vertex.position);
        }
        expect(numbers.filter((value) => Object.is(value, -0))).toEqual([]);
        expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
      } finally {
        handle.delete();
      }
    }
  });

  it('同じ形から 2 回集めるとまったく同じ一覧になる(決定性)', () => {
    const handle = makeBox(oc, BOX);
    try {
      const first = collect(handle.shape);
      const second = collect(handle.shape);
      expect(second).toEqual(first);
      // 面の一覧は index の昇順で、抜けも重なりも無い。
      const indices = first.faces.map((face: SolidFaceInfo) => face.index);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    } finally {
      handle.delete();
    }
  });
});
