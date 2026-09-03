import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, ChamferSizeSpec, ChamferStepSpec, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeChamfer } from './makeChamfer.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, collectSubShapes, facesTouchingEdge } from './subShapes.js';
import { tessellate } from './tessellate.js';

/** 計画書 タスク8 の検証表が使う箱。体積 8000 mm³。 */
const BOX: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const BOX_VOLUME = 8000;

/** 統括の指示にある板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };
const PLATE_VOLUME = 12000;

/**
 * 直角の辺 1 本を 2 距離 `d1` / `d2` で面取りしたときに削れる体積(mm³)。
 *
 * **導出:** 直角の角を斜めに落とすので、断面は直角をはさむ 2 辺が `d1` と `d2` の
 * 直角三角形になり、面積は `d1·d2/2`。これが辺の長さ `L` にわたって続くので
 * 削れる体積は `L·d1·d2/2`。等距離(45°)は `d1 = d2 = d` の場合で `L·d²/2`、
 * 距離+角度は `d2 = d1·tan(角度)` の場合で `L·d1²·tan(角度)/2` になる
 * (角度が基準面から測られることは makeChamfer.ts の注釈のとおり 2026-09-03 に実測)。
 */
function chamferedAway(length: number, distance1: number, distance2: number): number {
  return (length * distance1 * distance2) / 2;
}

/**
 * 直角に交わる 2 辺を**同じ等距離 `d`** で面取りしたとき、辺ごとの計算が
 * その 2 辺が出会う頂点 1 つあたり余分に引きすぎるぶん(mm³)。
 *
 * **導出:** 頂点を原点、2 辺を x 軸・y 軸、材料側を z<0 として、
 * 面取りが削る範囲を天面からの深さ `t`(0〜d)で切る。x 軸の辺の面取りは `y > t` の側を、
 * y 軸の辺の面取りは `x > t` の側を削る(45° なので深さ `t` では幅 `d − t` が残る)。
 * 両方が削る範囲は 1 辺 `d − t` の正方形なので、重なりの体積は
 *   `∫₀^d (d − t)² dt = d³/3`。
 * 辺ごとの合計はこの重なりを 2 回数えているので、1 回ぶん `d³/3` を戻す。
 *
 * 2026-09-03 の実測(40×30×10 の板の上面 4 辺を等距離 2mm = 11730.666666666668)は、
 * この式で出した 11730.666666666666 と 2e-12 の差で一致した。
 */
function cornerOverlap(distance: number): number {
  return (distance * distance * distance) / 3;
}

interface Prepared {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  readonly scale: number;
  delete(): void;
}

interface Measured {
  readonly volume: number;
  readonly solid: boolean;
  readonly valid: boolean;
  readonly tables: SubShapeTables;
}

describe('C 面取り(FR-408、FR-504、NFR-RE-1)', () => {
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
      // makeChamfer の中と同じ決め(境界箱の対角長の半分)。
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

  /** Z 方向(縦)の辺の通し番号。箱では 4 本。互いに隣り合わないので頂点の重なりが無い。 */
  function verticalEdgeIndices(tables: SubShapeTables): number[] {
    return tables.edges
      .filter((edge) => edge.axis !== null && Math.abs(Math.abs(edge.axis[2]) - 1) < 1e-9)
      .map((edge) => edge.index);
  }

  /** 上面(z = height)にある辺の通し番号。4 本が輪になって隣り合う。 */
  function topEdgeIndices(tables: SubShapeTables, height: number): number[] {
    return tables.edges
      .filter((edge) => Math.abs(edge.midpoint[2] - height) < 1e-9)
      .map((edge) => edge.index);
  }

  function chamfer(
    targets: readonly SubShapeQuery[],
    size: ChamferSizeSpec,
    swapReferenceFace = false,
  ): ChamferStepSpec {
    return { kind: 'chamfer', targetKey: 'target', targets, size, swapReferenceFace };
  }

  /** 面取りした結果を測って、必ず解放する。 */
  function measureChamfer(prepared: Prepared, spec: ChamferStepSpec): Measured {
    const result = makeChamfer(oc, spec, prepared.shape, prepared.tables);
    try {
      return {
        volume: measureVolume(oc, result.shape),
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
        tables: collectTables(result.shape),
      };
    } finally {
      result.delete();
    }
  }

  /** その位置に頂点があるか(丸め誤差 1e-9 まで許す)。 */
  function hasVertexAt(tables: SubShapeTables, position: Vec3Tuple): boolean {
    return tables.vertices.some(
      (vertex) =>
        Math.hypot(
          vertex.position[0] - position[0],
          vertex.position[1] - position[1],
          vertex.position[2] - position[2],
        ) < 1e-9,
    );
  }

  it('40×30×10 の板の長さ 40 の上辺 1 本を等距離 2mm で面取りすると 11920 になる', () => {
    const prepared = prepare(PLATE);
    try {
      const top = topEdgeIndices(prepared.tables, 10);
      expect(top).toHaveLength(4);
      const long = top.filter((index) => Math.abs(prepared.tables.edges[index].length - 40) < 1e-9);
      expect(long).toHaveLength(2);

      const measured = measureChamfer(
        prepared,
        chamfer([edgeQuery(prepared.tables, long[0])], { kind: 'equal', distance: 2 }),
      );

      // 12000 − 40·2·2/2 = 12000 − 80。
      expect(measured.volume).toBeCloseTo(PLATE_VOLUME - chamferedAway(40, 2, 2), 6);
      expect(measured.volume).toBeCloseTo(11920, 6);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('板の上面 4 辺(隣り合う)を等距離 2mm で面取りすると、角の重なりのぶんが戻る', () => {
    const prepared = prepare(PLATE);
    try {
      const top = topEdgeIndices(prepared.tables, 10);
      const targets = top.map((index) => edgeQuery(prepared.tables, index));
      const totalLength = top.reduce((sum, index) => sum + prepared.tables.edges[index].length, 0);
      expect(totalLength).toBeCloseTo(2 * 40 + 2 * 30, 9);

      const measured = measureChamfer(prepared, chamfer(targets, { kind: 'equal', distance: 2 }));

      // 素朴な合計 (2·40 + 2·30)·2²/2 = 280 から、角 4 つぶんの重なり 4·2³/3 = 32/3 を戻す。
      const expected = PLATE_VOLUME - chamferedAway(totalLength, 2, 2) + 4 * cornerOverlap(2);
      expect(expected).toBeCloseTo(11730.666666666666, 9);
      // 重なりを戻さないと 11720 で、10.67 mm³ ずれる(2026-09-03 実測は 11730.666666666668)。
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('20×20×20 の縦 4 稜線を等距離 2mm で面取りすると 7840 になる', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      expect(vertical).toHaveLength(4);

      const targets = vertical.map((index) => edgeQuery(prepared.tables, index));
      const measured = measureChamfer(prepared, chamfer(targets, { kind: 'equal', distance: 2 }));

      // 縦の 4 辺は互いに隣り合わないので、角の重なりの補正は要らない。
      expect(measured.volume).toBeCloseTo(BOX_VOLUME - 4 * chamferedAway(20, 2, 2), 6);
      expect(measured.volume).toBeCloseTo(7840, 6);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
      // 6 面 + 面取り面 4 枚(2026-09-03 実測)。
      expect(measured.tables.faces).toHaveLength(10);
    } finally {
      prepared.delete();
    }
  });

  it('20×20×20 の縦 4 稜線を 2 距離 3mm / 1mm で面取りすると 7880 になる', () => {
    const prepared = prepare(BOX);
    try {
      const targets = verticalEdgeIndices(prepared.tables).map((index) =>
        edgeQuery(prepared.tables, index),
      );
      const measured = measureChamfer(
        prepared,
        chamfer(targets, { kind: 'twoDistances', distance1: 3, distance2: 1 }),
      );

      expect(measured.volume).toBeCloseTo(BOX_VOLUME - 4 * chamferedAway(20, 3, 1), 6);
      expect(measured.volume).toBeCloseTo(7880, 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('2 距離の distance1 は基準面の側に入り、swapReferenceFace で入れ替わる(§0.a-0.18)', () => {
    const prepared = prepare(BOX);
    try {
      const target = verticalEdgeIndices(prepared.tables)[0];
      // (0,0) を通る縦の辺。接する面は TopExp の並びで x=0 の面 → y=0 の面(2026-09-03 実測)。
      expect(prepared.tables.edges[target].midpoint).toEqual([0, 0, 10]);
      const touching = facesTouchingEdge(oc, prepared.shape, target);
      expect(touching).toHaveLength(2);
      expect(prepared.tables.faces[touching[0]].axis).toEqual([-1, 0, 0]);
      expect(prepared.tables.faces[touching[1]].axis).toEqual([0, -1, 0]);

      const targets = [edgeQuery(prepared.tables, target)];
      const size: ChamferSizeSpec = { kind: 'twoDistances', distance1: 3, distance2: 1 };

      const normal = measureChamfer(prepared, chamfer(targets, size, false));
      const swapped = measureChamfer(prepared, chamfer(targets, size, true));

      // 体積は同じ(断面の三角形の面積が同じ)。区別は頂点の位置でしか付かない。
      const expected = BOX_VOLUME - chamferedAway(20, 3, 1);
      expect(normal.volume).toBeCloseTo(expected, 6);
      expect(swapped.volume).toBeCloseTo(expected, 6);
      expect(normal.volume).toBeCloseTo(7970, 6);

      // 基準面が x=0 の面なら、その面の側(y 方向)へ 3mm 入る。
      expect(hasVertexAt(normal.tables, [0, 3, 0])).toBe(true);
      expect(hasVertexAt(normal.tables, [1, 0, 0])).toBe(true);
      // 入れ替えると基準面が y=0 の面になり、3mm が x 方向へ移る。
      expect(hasVertexAt(swapped.tables, [0, 1, 0])).toBe(true);
      expect(hasVertexAt(swapped.tables, [3, 0, 0])).toBe(true);
      // 取り違えていないことを、逆の位置に頂点が無いことでも確かめる。
      expect(hasVertexAt(normal.tables, [3, 0, 0])).toBe(false);
      expect(hasVertexAt(swapped.tables, [0, 3, 0])).toBe(false);
    } finally {
      prepared.delete();
    }
  });

  it('距離 2mm + 角度 30 度(基準面から)を縦 4 稜線に掛けると 7907.62395693 になる', () => {
    const prepared = prepare(BOX);
    try {
      const targets = verticalEdgeIndices(prepared.tables).map((index) =>
        edgeQuery(prepared.tables, index),
      );
      const angle = Math.PI / 6;
      const measured = measureChamfer(
        prepared,
        chamfer(targets, { kind: 'distanceAngle', distance: 2, angle }),
      );

      // もう一方の距離は 2·tan30° = 1.154700538…(2·/tan30° = 3.46… ではない。2026-09-03 実測)。
      const expected = BOX_VOLUME - 4 * chamferedAway(20, 2, 2 * Math.tan(angle));
      expect(expected).toBeCloseTo(7907.62395693, 8);
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('距離 2mm + 角度 30 度の 2mm は基準面の側に入る', () => {
    const prepared = prepare(BOX);
    try {
      const target = verticalEdgeIndices(prepared.tables)[0];
      const measured = measureChamfer(
        prepared,
        chamfer([edgeQuery(prepared.tables, target)], {
          kind: 'distanceAngle',
          distance: 2,
          angle: Math.PI / 6,
        }),
      );

      // 基準面(x=0 の面)の側へ 2mm、もう一方の面へ 2·tan30° = 1.1547005383792515mm。
      expect(hasVertexAt(measured.tables, [0, 2, 0])).toBe(true);
      expect(hasVertexAt(measured.tables, [2 * Math.tan(Math.PI / 6), 0, 0])).toBe(true);
      expect(measured.volume).toBeCloseTo(
        BOX_VOLUME - chamferedAway(20, 2, 2 * Math.tan(Math.PI / 6)),
        6,
      );
    } finally {
      prepared.delete();
    }
  });

  it('距離が 0 以下・非数なら、面を取らずに理由を返す', () => {
    const prepared = prepare(BOX);
    try {
      const targets = [edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0])];
      const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

      for (const distance of bad) {
        expect(() =>
          makeChamfer(
            oc,
            chamfer(targets, { kind: 'equal', distance }),
            prepared.shape,
            prepared.tables,
          ),
        ).toThrow(/面取りの距離は 0 より大きい数/);
        expect(() =>
          makeChamfer(
            oc,
            chamfer(targets, { kind: 'twoDistances', distance1: 2, distance2: distance }),
            prepared.shape,
            prepared.tables,
          ),
        ).toThrow(/面取りの距離は 0 より大きい数/);
        expect(() =>
          makeChamfer(
            oc,
            chamfer(targets, { kind: 'distanceAngle', distance, angle: Math.PI / 6 }),
            prepared.shape,
            prepared.tables,
          ),
        ).toThrow(/面取りの距離は 0 より大きい数/);
      }
    } finally {
      prepared.delete();
    }
  });

  it('角度が 0 度以下・90 度以上・非数なら、面を取らずに理由を返す', () => {
    const prepared = prepare(BOX);
    try {
      const targets = [edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0])];
      const bad = [0, -Math.PI / 6, Math.PI / 2, Math.PI, Number.NaN];

      for (const angle of bad) {
        expect(() =>
          makeChamfer(
            oc,
            chamfer(targets, { kind: 'distanceAngle', distance: 2, angle }),
            prepared.shape,
            prepared.tables,
          ),
        ).toThrow(/面取りの角度は 0 度より大きく 90 度より小さく/);
      }
    } finally {
      prepared.delete();
    }
  });

  it('距離が大きすぎて面を取れないときは、例外で落ちずに理由を返す', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const one = [edgeQuery(prepared.tables, vertical[0])];
      const all = vertical.map((index) => edgeQuery(prepared.tables, index));

      // 2026-09-03 実測: 縦 1 辺だけなら 15mm は成功する(辺の間隔 20 に収まる)。
      // 計画書 タスク8 の検証表は「距離 15mm は面取りできない」としているが、実測は逆である。
      const fifteen = measureChamfer(prepared, chamfer(one, { kind: 'equal', distance: 15 }));
      expect(fifteen.volume).toBeCloseTo(BOX_VOLUME - chamferedAway(20, 15, 15), 6);
      expect(fifteen.volume).toBeCloseTo(5750, 6);

      // 4 辺同時だと隣どうしがぶつかって IsDone() が false になる(例外は飛ばない)。
      expect(() =>
        makeChamfer(
          oc,
          chamfer(all, { kind: 'equal', distance: 15 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取れませんでした/);

      // 1 辺でも 25mm(辺の間隔 20 を超える)は IsDone() が false。
      expect(() =>
        makeChamfer(
          oc,
          chamfer(one, { kind: 'equal', distance: 25 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取れませんでした/);

      // 断ったあとも対象の形はそのまま使える(target を解放していない)。
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(BOX_VOLUME, 9);
    } finally {
      prepared.delete();
    }
  });

  it('同じ辺を 2 回指しても 1 回だけ面を取る(重複を取り除く)', () => {
    const prepared = prepare(BOX);
    try {
      const query = edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0]);
      const once = measureChamfer(prepared, chamfer([query], { kind: 'equal', distance: 2 }));
      const twice = measureChamfer(
        prepared,
        chamfer([query, query], { kind: 'equal', distance: 2 }),
      );

      expect(twice.volume).toBeCloseTo(once.volume, 9);
      expect(twice.volume).toBeCloseTo(BOX_VOLUME - chamferedAway(20, 2, 2), 6);
    } finally {
      prepared.delete();
    }
  });

  it('辺が 0 本(targets が空)なら、Build を呼ばずに断る', () => {
    const prepared = prepare(BOX);
    try {
      // 辺を 1 本も足さずに Build すると OCCT の C++ 例外(数値)が飛ぶので、手前で断る。
      expect(() =>
        makeChamfer(
          oc,
          chamfer([], { kind: 'equal', distance: 2 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取るもとの辺が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('指紋がどの辺にも届かないときと、一部だけ届かないときは断る', () => {
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

      expect(() =>
        makeChamfer(
          oc,
          chamfer([lost], { kind: 'equal', distance: 2 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取るもとの辺が見つかりません/);

      // 部分成功にしない(1 本だけ面取りされた別の形を黙って作らない)。
      expect(() =>
        makeChamfer(
          oc,
          chamfer([good, lost], { kind: 'equal', distance: 2 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取るもとの辺が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('面の指紋は面取りの対象にならない', () => {
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

      expect(() =>
        makeChamfer(
          oc,
          chamfer([query], { kind: 'equal', distance: 2 }),
          prepared.shape,
          prepared.tables,
        ),
      ).toThrow(/面を取るもとの辺が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('内側(凹み)の辺を面取りすると体積は増えるが、正しい結果として通す', () => {
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

      const result = keep(
        makeChamfer(
          oc,
          chamfer([query], { kind: 'equal', distance: 3 }),
          lShape.shape,
          tables,
        ),
      );

      // 凹んだ角では材料が足されるので、削れる量と同じ大きさだけ体積が増える。
      // したがって**「体積が増えたら失敗」という判定は入れられない**(タスク7 と同じ実測)。
      expect(measureVolume(oc, result.shape)).toBeCloseTo(6000 + chamferedAway(20, 3, 3), 6);
      expect(isValidShape(oc, result.shape)).toBe(true);
    } finally {
      release();
    }
  });

  it('面を取っても対象の形は消費しない(同じ形から続けて面取りできる)', () => {
    const prepared = prepare(BOX);
    try {
      const vertical = verticalEdgeIndices(prepared.tables);
      const first = makeChamfer(
        oc,
        chamfer([edgeQuery(prepared.tables, vertical[0])], { kind: 'equal', distance: 2 }),
        prepared.shape,
        prepared.tables,
      );
      first.delete();

      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(BOX_VOLUME, 9);

      const second = measureChamfer(
        prepared,
        chamfer([edgeQuery(prepared.tables, vertical[1])], { kind: 'equal', distance: 2 }),
      );
      expect(second.volume).toBeCloseTo(BOX_VOLUME - chamferedAway(20, 2, 2), 6);
    } finally {
      prepared.delete();
    }
  });
});
