import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, FilletStepSpec, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeFillet, resolveFilletEdges } from './makeFillet.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/** 計画書 タスク7 の検証表が使う箱。体積 8000 mm³。 */
const BOX: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const BOX_VOLUME = 8000;

/** 統括の指示にある板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };
const PLATE_VOLUME = 12000;

/**
 * 直角の辺 1 本を半径 r で丸めたときに削れる断面積(mm²)の係数。
 *
 * **導出:** 直角の角を半径 r で丸めると、断面では 1 辺 r の正方形(面積 r²)から
 * 四分円(面積 πr²/4)を残して削る。削れる面積は `r² − πr²/4 = r²(1 − π/4)`。
 * これが辺の長さ L にわたって続くので、削れる体積は `L · r² · (1 − π/4)`。
 */
const CORNER_AREA_FACTOR = 1 - Math.PI / 4;

/**
 * 直角の 3 辺が集まる頂点 1 つあたり、上の式が余分に引きすぎるぶん(mm³ / r³)。
 *
 * **導出:** 角にある 1 辺 r の立方体(体積 r³)を考える。3 辺すべてを丸めると、
 * この立方体に残る材料は球(半径 r、中心は立方体の内側の角)の 1/8 で `πr³/6` なので、
 * 実際に削れるのは `r³ − πr³/6`。ところが辺ごとの計算はこの立方体を 3 回数えていて、
 * 合計 `3·r³(1 − π/4)` を引いてしまう。引きすぎたぶんは
 *   `3r³(1 − π/4) − (r³ − πr³/6) = 2r³ − πr³(3/4 − 1/6) = r³(2 − 7π/12)`。
 * したがって「全辺を丸めた体積 = 素朴な合計 + 頂点の数 × r³(2 − 7π/12)」になる。
 *
 * 2026-09-03 の実測(20×20×20 の全 12 辺 R2 = 7804.696111127532)は、この式で
 * 出した 7804.696111127531 と 1e-12 の差で一致した。
 */
const VERTEX_CORRECTION_FACTOR = 2 - (7 * Math.PI) / 12;

/** 辺を丸めたときの体積。頂点の補正は別に足す。 */
function filletedVolume(base: number, totalEdgeLength: number, radius: number): number {
  return base - totalEdgeLength * radius * radius * CORNER_AREA_FACTOR;
}

/** 直角の 3 辺が集まる頂点 count 個ぶんの補正(mm³)。 */
function vertexCorrection(count: number, radius: number): number {
  return count * radius * radius * radius * VERTEX_CORRECTION_FACTOR;
}

interface Prepared {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  readonly scale: number;
  delete(): void;
}

describe('R 面取り(FR-407、FR-504、NFR-RE-1)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  /** 箱と、その一覧・位置の正規化の長さを用意する。 */
  function prepare(parameters: BoxParameters): Prepared {
    const handle = makeBox(oc, parameters);
    return {
      shape: handle.shape,
      tables: collectTables(handle.shape),
      // makeFillet の中と同じ決め(境界箱の対角長の半分)。
      scale: boundingDiagonal(oc, handle.shape) * 0.5,
      delete: () => {
        handle.delete();
      },
    };
  }

  /** 一覧の辺 1 本から、文書が保存するのと同じ形の指紋を作る。 */
  function edgeQuery(tables: SubShapeTables, index: number): SubShapeQuery {
    const edge = tables.edges[index];
    return {
      kind: 'edge',
      index: edge.index,
      curveKind: edge.curveKind,
      length: edge.length,
      position: edge.midpoint,
      axis: edge.axis,
      radius: edge.radius,
    };
  }

  /** 一覧の頂点 1 つから指紋を作る。 */
  function vertexQuery(tables: SubShapeTables, index: number): SubShapeQuery {
    const vertex = tables.vertices[index];
    return { kind: 'vertex', index: vertex.index, position: vertex.position };
  }

  /** Z 方向(縦)の辺の通し番号。箱では 4 本。 */
  function verticalEdgeIndices(tables: SubShapeTables): number[] {
    return tables.edges
      .filter((edge) => edge.axis !== null && Math.abs(Math.abs(edge.axis[2]) - 1) < 1e-9)
      .map((edge) => edge.index);
  }

  /** 位置がぴったり合う頂点の通し番号。 */
  function vertexIndexAt(tables: SubShapeTables, position: Vec3Tuple): number {
    const found = tables.vertices.find(
      (vertex) =>
        Math.hypot(
          vertex.position[0] - position[0],
          vertex.position[1] - position[1],
          vertex.position[2] - position[2],
        ) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`頂点 [${position.join(',')}] が見つかりません(検査の前提が崩れています)。`);
    }
    return found.index;
  }

  function fillet(targets: readonly SubShapeQuery[], radius: number): FilletStepSpec {
    return { kind: 'fillet', targetKey: 'target', targets, radius };
  }

  /** 丸めた結果の体積と面の数を測って、必ず解放する。 */
  function measureFillet(
    prepared: Prepared,
    spec: FilletStepSpec,
  ): { volume: number; faceCount: number; solid: boolean; valid: boolean } {
    const result = makeFillet(oc, spec, prepared.shape, prepared.tables);
    try {
      return {
        volume: measureVolume(oc, result.shape),
        faceCount: collectTables(result.shape).faces.length,
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
      };
    } finally {
      result.delete();
    }
  }

  it('20×20×20 の縦 4 稜線を R5 で丸めると、体積が 8000 − 4·20·25·(1 − π/4) になる', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      expect(vertical).toHaveLength(4);

      const targets = vertical.map((index) => edgeQuery(prepared.tables, index));
      const measured = measureFillet(prepared, fillet(targets, 5));

      // 4 本とも縦の辺で、上下の辺は丸めないので頂点の補正は要らない。
      expect(measured.volume).toBeCloseTo(filletedVolume(BOX_VOLUME, 4 * 20, 5), 6);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
      // 6 面 + 丸め面 4 枚(2026-09-03 実測)。
      expect(measured.faceCount).toBe(10);
    } finally {
      prepared.delete();
    }
  });

  it('20×20×20 の縦 1 稜線だけを R5 で丸めると、体積が 8000 − 20·25·(1 − π/4) になる', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const measured = measureFillet(
        prepared,
        fillet([edgeQuery(prepared.tables, vertical[0])], 5),
      );

      expect(measured.volume).toBeCloseTo(filletedVolume(BOX_VOLUME, 20, 5), 6);
      expect(measured.valid).toBe(true);
      // 6 面 + 丸め面 1 枚(2026-09-03 実測)。
      expect(measured.faceCount).toBe(7);
    } finally {
      prepared.delete();
    }
  });

  it('20×20×20 の全 12 辺を R2 で丸めると、頂点 8 つぶんの引きすぎが戻る', () => {
    const prepared = prepare(BOX);
    try {
      const targets = prepared.tables.edges.map((edge) => edgeQuery(prepared.tables, edge.index));
      expect(targets).toHaveLength(12);

      const measured = measureFillet(prepared, fillet(targets, 2));
      const expected = filletedVolume(BOX_VOLUME, 12 * 20, 2) + vertexCorrection(8, 2);

      // 補正を入れないと 7793.98…(実測は 7804.69…)で、8 頂点ぶん 10.71 mm³ ずれる。
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('頂点を指定すると、その頂点に集まる 3 本の辺へ展開して丸める(§0.a-0.17)', () => {
    const prepared = prepare(BOX);
    try {
      const vertexIndex = vertexIndexAt(prepared.tables, [0, 0, 0]);
      const query = vertexQuery(prepared.tables, vertexIndex);

      const edges = resolveFilletEdges(
        oc,
        prepared.shape,
        prepared.tables,
        [query],
        prepared.scale,
      );
      expect(edges).toHaveLength(3);

      const measured = measureFillet(prepared, fillet([query], 2));
      // 3 辺ぶんの削りから、その頂点 1 つぶんの引きすぎを戻した値。
      expect(measured.volume).toBeCloseTo(
        filletedVolume(BOX_VOLUME, 3 * 20, 2) + vertexCorrection(1, 2),
        6,
      );
      expect(measured.volume).toBeLessThan(BOX_VOLUME);
    } finally {
      prepared.delete();
    }
  });

  it('同じ辺を 2 回指しても 1 回だけ丸める(重複を取り除く)', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const query = edgeQuery(prepared.tables, vertical[0]);

      expect(
        resolveFilletEdges(oc, prepared.shape, prepared.tables, [query, query], prepared.scale),
      ).toEqual([vertical[0]]);

      const twice = measureFillet(prepared, fillet([query, query], 5));
      expect(twice.volume).toBeCloseTo(filletedVolume(BOX_VOLUME, 20, 5), 6);
    } finally {
      prepared.delete();
    }
  });

  it('選び直した辺の番号は昇順で返る(同じ入力から同じ形が出る)', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const reversed = [...vertical].reverse().map((index) => edgeQuery(prepared.tables, index));

      expect(
        resolveFilletEdges(oc, prepared.shape, prepared.tables, reversed, prepared.scale),
      ).toEqual([...vertical].sort((left, right) => left - right));
    } finally {
      prepared.delete();
    }
  });

  it('半径が 0 以下・非数なら、丸めずに理由を返す', () => {
    const prepared = prepare(BOX);
    try {
      const targets = [edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0])];
      for (const radius of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => makeFillet(oc, fillet(targets, radius), prepared.shape, prepared.tables))
          .toThrow(/丸める半径は 0 より大きい数/);
      }
    } finally {
      prepared.delete();
    }
  });

  it('半径が大きすぎて丸め切れないときは、例外で落ちずに理由を返す', () => {
    const prepared = prepare(BOX);
    try {
      const targets = verticalEdgeIndices(prepared.tables).map((index) =>
        edgeQuery(prepared.tables, index),
      );
      // 2026-09-03 実測: 縦 4 辺に R15 は IsDone() が false・NbFaultyContours() が 0・
      // NbFaultyVertices() が 4(隣り合う丸めどうしがぶつかる)。プロセスは落ちない。
      expect(() => makeFillet(oc, fillet(targets, 15), prepared.shape, prepared.tables)).toThrow(
        /丸められませんでした|丸められない辺/,
      );
      // 断ったあとも対象の形はそのまま使える(target を解放していない)。
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(BOX_VOLUME, 9);
    } finally {
      prepared.delete();
    }
  });

  it('半径が隣の面からはみ出すときは、丸められない辺の本数を添えて断る', () => {
    const prepared = prepare(PLATE);
    try {
      const targets = [edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0])];
      // 2026-09-03 実測: 40×30×10 の板の縦 1 辺に R40 は
      // IsDone() が false・NbFaultyContours() が 1。
      expect(() => makeFillet(oc, fillet(targets, 40), prepared.shape, prepared.tables)).toThrow(
        /丸められない辺が 1 本ありました/,
      );
    } finally {
      prepared.delete();
    }
  });

  it('指紋がどの辺にも届かないときは「もとの辺が見つかりません」で断る', () => {
    const prepared = prepare(BOX);
    try {
      // 番号・大きさ・位置のすべてを外した指紋(形が大きく変わった状態を模す)。
      const lost: SubShapeQuery = {
        kind: 'edge',
        index: 9999,
        curveKind: 'line',
        length: 2000,
        position: [1000, 1000, 1000],
        axis: [0, 0, 1],
        radius: null,
      };

      expect(resolveFilletEdges(oc, prepared.shape, prepared.tables, [lost], prepared.scale))
        .toEqual([]);
      expect(() => makeFillet(oc, fillet([lost], 5), prepared.shape, prepared.tables)).toThrow(
        /丸めるもとの辺が見つかりません/,
      );
    } finally {
      prepared.delete();
    }
  });

  it('種類の違う指紋(箱に円の辺)は候補が無いので断る', () => {
    const prepared = prepare(BOX);
    try {
      const circle: SubShapeQuery = {
        kind: 'edge',
        index: 0,
        curveKind: 'circle',
        length: 20,
        position: [0, 0, 10],
        axis: [0, 0, 1],
        radius: 3,
      };
      expect(() => makeFillet(oc, fillet([circle], 5), prepared.shape, prepared.tables)).toThrow(
        /丸めるもとの辺が見つかりません/,
      );
    } finally {
      prepared.delete();
    }
  });

  it('辺が 0 本(targets が空)なら、Build を呼ばずに断る', () => {
    const prepared = prepare(BOX);
    try {
      expect(resolveFilletEdges(oc, prepared.shape, prepared.tables, [], prepared.scale)).toEqual(
        [],
      );
      expect(() => makeFillet(oc, fillet([], 5), prepared.shape, prepared.tables)).toThrow(
        /丸めるもとの辺が見つかりません/,
      );
    } finally {
      prepared.delete();
    }
  });

  it('一部の指紋だけ届かないときも、部分的に丸めずに断る', () => {
    const prepared = prepare(BOX);
    try {
      const good = edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0]);
      const lost: SubShapeQuery = {
        kind: 'edge',
        index: 9999,
        curveKind: 'line',
        length: 2000,
        position: [1000, 1000, 1000],
        axis: [0, 0, 1],
        radius: null,
      };

      expect(
        resolveFilletEdges(oc, prepared.shape, prepared.tables, [good, lost], prepared.scale),
      ).toEqual([]);
      expect(() => makeFillet(oc, fillet([good, lost], 5), prepared.shape, prepared.tables))
        .toThrow(/丸めるもとの辺が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('面の指紋は丸める対象にならない', () => {
    const prepared = prepare(BOX);
    try {
      const face = prepared.tables.faces[0];
      const query: SubShapeQuery = {
        kind: 'face',
        index: face.index,
        surfaceKind: face.surfaceKind,
        area: face.area,
        position: face.centroid,
        axis: face.axis,
        radius: face.radius,
      };
      expect(resolveFilletEdges(oc, prepared.shape, prepared.tables, [query], prepared.scale))
        .toEqual([]);
    } finally {
      prepared.delete();
    }
  });

  it('40×30×10 の板の縦 1 辺を R2 で丸めると、体積が 12000 − 10·4·(1 − π/4) になる', () => {
    const prepared = prepare(PLATE);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      expect(vertical).toHaveLength(4);

      const measured = measureFillet(
        prepared,
        fillet([edgeQuery(prepared.tables, vertical[0])], 2),
      );
      expect(measured.volume).toBeCloseTo(filletedVolume(PLATE_VOLUME, 10, 2), 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('40×30×10 の板の縦 4 辺は R6 まで丸められ、R20 は 4 辺同時だと断る', () => {
    const prepared = prepare(PLATE);
    try {
      const targets = verticalEdgeIndices(prepared.tables).map((index) =>
        edgeQuery(prepared.tables, index),
      );

      const measured = measureFillet(prepared, fillet(targets, 6));
      expect(measured.volume).toBeCloseTo(filletedVolume(PLATE_VOLUME, 4 * 10, 6), 6);
      expect(measured.valid).toBe(true);

      // 2026-09-03 実測: R20 は縦 1 辺だけなら成功する(板の幅 40・30 に収まる)が、
      // 4 辺同時では隣どうしがぶつかって IsDone() が false になる。
      expect(() => makeFillet(oc, fillet(targets, 20), prepared.shape, prepared.tables)).toThrow(
        /丸められませんでした|丸められない辺/,
      );
    } finally {
      prepared.delete();
    }
  });

  it('40×30×10 の板の全 12 辺を R2 で丸めた体積も、頂点の補正を入れた式と合う', () => {
    const prepared = prepare(PLATE);
    try {
      const targets = prepared.tables.edges.map((edge) => edgeQuery(prepared.tables, edge.index));
      const totalLength = prepared.tables.edges.reduce((sum, edge) => sum + edge.length, 0);
      expect(totalLength).toBeCloseTo(4 * (40 + 30 + 10), 9);

      const measured = measureFillet(prepared, fillet(targets, 2));
      expect(measured.volume).toBeCloseTo(
        filletedVolume(PLATE_VOLUME, totalLength, 2) + vertexCorrection(8, 2),
        6,
      );
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('内側(凹み)の辺を丸めると体積は増えるが、正しい結果として通す', () => {
    // L 字の立体: 20×20×20 の箱から、(10,10,-1) を角とする 20×20×22 の箱を引く。
    // 残るのは体積 6000 mm³ の L 字で、(10,10,z) に凹んだ縦の辺が 1 本できる。
    const { keep, release } = createAllocations();
    try {
      const big = keep(makeBox(oc, BOX));
      const corner = keep(new oc.gp_Pnt_3(10, 10, -1));
      const cutter = keep(new oc.BRepPrimAPI_MakeBox_3(corner, 20, 20, 22));
      const tool = keep(cutter.Shape());
      const lShape = keep(booleanOp(oc, 'subtract', big.shape, tool));
      const tables = collectTables(lShape.shape);

      const concave = tables.edges.find(
        (edge) =>
          Math.abs(edge.midpoint[0] - 10) < 1e-9 &&
          Math.abs(edge.midpoint[1] - 10) < 1e-9 &&
          Math.abs(edge.length - 20) < 1e-9,
      );
      if (concave === undefined) {
        throw new Error('凹んだ縦の辺が見つかりません(検査の前提が崩れています)。');
      }

      const query: SubShapeQuery = {
        kind: 'edge',
        index: concave.index,
        curveKind: concave.curveKind,
        length: concave.length,
        position: concave.midpoint,
        axis: concave.axis,
        radius: concave.radius,
      };

      const result = keep(makeFillet(oc, fillet([query], 3), lShape.shape, tables));

      // 凹んだ角では材料が足されるので、削れる量と同じ大きさだけ体積が増える。
      // したがって**「体積が増えたら失敗」という判定は入れられない**(2026-09-03 実測)。
      expect(measureVolume(oc, result.shape)).toBeCloseTo(
        6000 + 20 * 3 * 3 * CORNER_AREA_FACTOR,
        6,
      );
      expect(isValidShape(oc, result.shape)).toBe(true);
    } finally {
      release();
    }
  });

  it('丸めても対象の形は消費しない(同じ形から続けて丸められる)', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const first = makeFillet(
        oc,
        fillet([edgeQuery(prepared.tables, vertical[0])], 5),
        prepared.shape,
        prepared.tables,
      );
      first.delete();

      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(BOX_VOLUME, 9);

      const second = measureFillet(
        prepared,
        fillet([edgeQuery(prepared.tables, vertical[1])], 5),
      );
      expect(second.volume).toBeCloseTo(filletedVolume(BOX_VOLUME, 20, 5), 6);
    } finally {
      prepared.delete();
    }
  });
});
