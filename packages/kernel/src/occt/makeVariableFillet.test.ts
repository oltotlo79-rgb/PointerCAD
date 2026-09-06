import { expectWithinBudget } from '@pointercad/test-utils';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, SubShapeQuery, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeFillet } from './makeFillet.js';
import type { VariableFilletInput } from './makeVariableFillet.js';
import { makeVariableFillet } from './makeVariableFillet.js';
import { distanceBetween } from './measureShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * 半径の変わる R 面取り(FR-426、FR-504、NFR-RE-1)の検査。計画書 P5 タスク53 の検証表。
 *
 * **期待値の立て方(統括へ報告した判断)。** 一定半径の R 面取りは解析式で厳密に出せる
 * (直角の辺 1 本を半径 r で丸めると `L·r²·(1 − π/4)` だけ削れる)が、
 * 半径が変わる場合の OCCT の面は「半径を長さに比例させた掃引」ではないので、
 * 断面積を `(r1² + r1·r2 + r2²)/3` で平均した近似(計画書の 7944.203522483337)とは
 * 削れた量の 1.43% ずれる(2026-09-05 実測: 7943.407681943796)。そこで
 *   ① 一定 R2 と一定 R5 の間にあること
 *   ② 両端の丸みの半径が指定どおりであること(角の点からの距離で測る)
 *   ③ 近似値との差が削れた量の 2% 以内であること
 * の 3 つで固定する。①②は仕様そのもの、③は「近似からかけ離れていない」ことの網である。
 */

/** 検証表の箱。体積 8000 mm³。 */
const CUBE: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const CUBE_VOLUME = 8000;

/** 統括の指示にある板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };

/** 直角の辺 1 本を半径 r で丸めたときに削れる断面積の係数(makeFillet.test.ts と同じ導出)。 */
const CORNER_AREA_FACTOR = 1 - Math.PI / 4;

/** 20³ の縦稜線 1 本を一定半径 r で丸めた体積。 */
function constantFilletVolume(radius: number): number {
  return CUBE_VOLUME - 20 * radius * radius * CORNER_AREA_FACTOR;
}

/**
 * 半径が長さに比例して変わると見なした近似の体積(計画書の期待値の出し方)。
 * 断面の欠けは `r(z)²(1 − π/4)` で、`r` が直線なら `r²` の平均は `(r1² + r1r2 + r2²)/3`。
 */
function taperedFilletVolume(startRadius: number, endRadius: number): number {
  const meanSquare =
    (startRadius * startRadius + startRadius * endRadius + endRadius * endRadius) / 3;
  return CUBE_VOLUME - 20 * meanSquare * CORNER_AREA_FACTOR;
}

/** 直角の角を半径 r で丸めたとき、角の点から残った材料までの距離(mm)。 */
function cornerGap(radius: number): number {
  return radius * (Math.SQRT2 - 1);
}

/** 検証表の半径。 */
const START_RADIUS = 2;
const END_RADIUS = 5;

/** 半径の変わる R 面取り 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

interface Prepared {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  readonly scale: number;
  delete(): void;
}

describe('半径の変わる R 面取り(FR-426、FR-504、NFR-RE-1)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
    // 捨て計算。WASM の初回呼び出しに伴う立ち上がりぶんを所要から外す
    // (packages/kernel/src/worker/solidPerformance.test.ts と同じ決め。
    //  2026-09-05 実測: 入れないと 1 回目だけ 500ms を超えた)。
    withBox({ dx: 10, dy: 10, dz: 10 }, (prepared) => {
      makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, 1, 2),
      ).delete();
    });
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  /** 箱と一覧を用意して渡し、必ず解放する。 */
  function withBox(parameters: BoxParameters, body: (prepared: Prepared) => void): void {
    const handle = makeBox(oc, parameters);
    try {
      body({
        shape: handle.shape,
        tables: collectTables(handle.shape),
        scale: boundingDiagonal(oc, handle.shape) * 0.5,
        delete: () => {
          handle.delete();
        },
      });
    } finally {
      handle.delete();
    }
  }

  /** 一覧の辺 1 本から、文書が保存するのと同じ形の指紋を作る(makeFillet.test.ts と同じ)。 */
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

  /** Z 方向(縦)の辺の通し番号。箱では 4 本。 */
  function verticalEdgeIndices(tables: SubShapeTables): number[] {
    return tables.edges
      .filter((edge) => edge.axis !== null && Math.abs(Math.abs(edge.axis[2]) - 1) < 1e-9)
      .map((edge) => edge.index);
  }

  /** 点から形までの最短距離(mm)。丸みの半径を確かめるのに使う。 */
  function distanceFromPoint(shape: TopoDS_Shape, point: Vec3Tuple): number {
    const location = new oc.gp_Pnt_3(point[0], point[1], point[2]);
    const maker = new oc.BRepBuilderAPI_MakeVertex(location);
    const vertex = maker.Vertex();
    try {
      return distanceBetween(oc, shape, vertex).distance;
    } finally {
      vertex.delete();
      maker.delete();
      location.delete();
    }
  }

  /** 縦稜線 1 本を丸める依頼(通し番号の小さいほうから n 本目)。 */
  function taperOnVertical(
    tables: SubShapeTables,
    nth: number,
    startRadius: number,
    endRadius: number,
  ): VariableFilletInput {
    return {
      targets: [
        { target: edgeQuery(tables, verticalEdgeIndices(tables)[nth]), startRadius, endRadius },
      ],
    };
  }

  it('縦稜線 1 本を R2 → R5 で丸めると、一定 R2 と一定 R5 の間の体積になる', () => {
    withBox(CUBE, (prepared) => {
      const started = performance.now();
      const result = makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, START_RADIUS, END_RADIUS),
      );
      const elapsed = performance.now() - started;
      try {
        const volume = measureVolume(oc, result.shape);
        expect(volume).toBeLessThan(constantFilletVolume(START_RADIUS));
        expect(volume).toBeGreaterThan(constantFilletVolume(END_RADIUS));
        // 半径を直線で変えたと見なした近似との差は、削れた量の 2% 以内(上の注釈)。
        const approximate = taperedFilletVolume(START_RADIUS, END_RADIUS);
        const removed = CUBE_VOLUME - approximate;
        expect(Math.abs(volume - approximate)).toBeLessThan(removed * 0.02);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        expectWithinBudget(elapsed, SINGLE_STEP_BUDGET_MS, '半径の変わる R 面取り');
      } finally {
        result.delete();
      }
    });
  });

  it('両端の丸みの半径が、指定した 2 と 5 になっている', () => {
    withBox(CUBE, (prepared) => {
      const result = makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, START_RADIUS, END_RADIUS),
      );
      try {
        // 丸めた辺は x = 0, y = 0 の縦稜線。角の点からの距離が r(√2 − 1) になる。
        expect(distanceFromPoint(result.shape, [0, 0, 0])).toBeCloseTo(cornerGap(START_RADIUS), 3);
        expect(distanceFromPoint(result.shape, [0, 0, 20])).toBeCloseTo(cornerGap(END_RADIUS), 2);
        // 途中は 2 と 5 の間にある(丸みが連続して変わっている)。
        const middle = distanceFromPoint(result.shape, [0, 0, 10]);
        expect(middle).toBeGreaterThan(cornerGap(START_RADIUS));
        expect(middle).toBeLessThan(cornerGap(END_RADIUS));
      } finally {
        result.delete();
      }
    });
  });

  it('始点と終点の半径が同じなら、一定半径の R 面取りと同じ形になる', () => {
    withBox(CUBE, (prepared) => {
      const variable = makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, END_RADIUS, END_RADIUS),
      );
      try {
        const constant = makeFillet(
          oc,
          {
            kind: 'fillet',
            targetKey: 'box',
            targets: [edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0])],
            radius: END_RADIUS,
          },
          prepared.shape,
          prepared.tables,
        );
        try {
          expect(measureVolume(oc, variable.shape)).toBeCloseTo(
            measureVolume(oc, constant.shape),
            6,
          );
          // 解析値(8000 − 20·5²·(1 − π/4))とも一致する。
          expect(measureVolume(oc, variable.shape)).toBeCloseTo(
            constantFilletVolume(END_RADIUS),
            6,
          );
        } finally {
          constant.delete();
        }
      } finally {
        variable.delete();
      }
    });
  });

  it('始点と終点を入れ替えても、削れる量は変わらない', () => {
    withBox(CUBE, (prepared) => {
      const forward = makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, START_RADIUS, END_RADIUS),
      );
      try {
        const backward = makeVariableFillet(
          oc,
          prepared.shape,
          prepared.tables,
          taperOnVertical(prepared.tables, 0, END_RADIUS, START_RADIUS),
        );
        try {
          expect(measureVolume(oc, forward.shape)).toBeCloseTo(
            measureVolume(oc, backward.shape),
            6,
          );
          // ただし丸みの向きは逆になる(角の点からの距離が入れ替わる)。
          expect(distanceFromPoint(backward.shape, [0, 0, 0])).toBeCloseTo(
            cornerGap(END_RADIUS),
            2,
          );
        } finally {
          backward.delete();
        }
      } finally {
        forward.delete();
      }
    });
  });

  it('辺ごとに違う半径の組を指定できる', () => {
    withBox(CUBE, (prepared) => {
      const vertical = verticalEdgeIndices(prepared.tables);
      const result = makeVariableFillet(oc, prepared.shape, prepared.tables, {
        targets: [
          { target: edgeQuery(prepared.tables, vertical[0]), startRadius: 2, endRadius: 5 },
          { target: edgeQuery(prepared.tables, vertical[1]), startRadius: 1, endRadius: 3 },
        ],
      });
      try {
        const single = makeVariableFillet(
          oc,
          prepared.shape,
          prepared.tables,
          taperOnVertical(prepared.tables, 0, 2, 5),
        );
        try {
          // 2 本目を丸めたぶんだけ体積が減る。
          expect(measureVolume(oc, result.shape)).toBeLessThan(measureVolume(oc, single.shape));
        } finally {
          single.delete();
        }
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    });
  });

  it('同じ辺を 2 度指したときは、先に書いた半径を使う', () => {
    withBox(CUBE, (prepared) => {
      const query = edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0]);
      const result = makeVariableFillet(oc, prepared.shape, prepared.tables, {
        targets: [
          { target: query, startRadius: END_RADIUS, endRadius: END_RADIUS },
          { target: query, startRadius: START_RADIUS, endRadius: START_RADIUS },
        ],
      });
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(constantFilletVolume(END_RADIUS), 6);
      } finally {
        result.delete();
      }
    });
  });

  it('もとの立体は変わらない(複製系で、引数に触れない)', () => {
    withBox(CUBE, (prepared) => {
      const result = makeVariableFillet(
        oc,
        prepared.shape,
        prepared.tables,
        taperOnVertical(prepared.tables, 0, START_RADIUS, END_RADIUS),
      );
      try {
        expect(measureVolume(oc, prepared.shape)).toBeCloseTo(CUBE_VOLUME, 6);
      } finally {
        result.delete();
      }
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(CUBE_VOLUME, 6);
    });
  });

  it('半径が 0 以下・非数なら、OCCT を呼ぶ前に理由をつけて断る', () => {
    withBox(CUBE, (prepared) => {
      for (const [start, end] of [
        [0, 5],
        [-1, 5],
        [2, 0],
        [Number.NaN, 5],
        [2, Number.POSITIVE_INFINITY],
      ]) {
        expect(() =>
          makeVariableFillet(
            oc,
            prepared.shape,
            prepared.tables,
            taperOnVertical(prepared.tables, 0, start, end),
          ),
        ).toThrow('丸める半径は 0 より大きい数にしてください。');
      }
    });
  });

  it('丸める辺が 1 本も選ばれていなければ断る', () => {
    withBox(CUBE, (prepared) => {
      expect(() =>
        makeVariableFillet(oc, prepared.shape, prepared.tables, { targets: [] }),
      ).toThrow('丸める辺が選ばれていません。');
    });
  });

  it('指紋が外れたら、選び直しを促して断る', () => {
    withBox(CUBE, (prepared) => {
      const strayed: SubShapeQuery = {
        kind: 'edge',
        index: 99,
        curveKind: 'line',
        length: 1,
        position: [500, 500, 500],
        axis: [1, 0, 0],
        radius: null,
      };
      expect(() =>
        makeVariableFillet(oc, prepared.shape, prepared.tables, {
          targets: [{ target: strayed, startRadius: START_RADIUS, endRadius: END_RADIUS }],
        }),
      ).toThrow('丸めるもとの辺が見つかりません。');
    });
  });

  it('辺ではない指紋(面)を渡されたら、辺を選び直すよう促して断る', () => {
    withBox(CUBE, (prepared) => {
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
        makeVariableFillet(oc, prepared.shape, prepared.tables, {
          targets: [{ target: query, startRadius: START_RADIUS, endRadius: END_RADIUS }],
        }),
      ).toThrow('丸めるもとの辺が見つかりません。');
    });
  });

  it('半径が隣の面からはみ出すときは、丸められない辺の本数を添えて断る(落ちない)', () => {
    withBox(PLATE, (prepared) => {
      // 40×30×10 の板の縦 1 辺に R40(makeFillet.test.ts と同じ条件)。2026-09-05 の実測では
      // IsDone() が偽・NbFaultyContours() が 1 になった。**片側だけ大きい指定
      // (2 → 40)は成功してしまう**ので、断りの検査には両端とも大きい値を使う。
      expect(() =>
        makeVariableFillet(oc, prepared.shape, prepared.tables, {
          targets: [
            {
              target: edgeQuery(prepared.tables, verticalEdgeIndices(prepared.tables)[0]),
              startRadius: 40,
              endRadius: 40,
            },
          ],
        }),
      ).toThrow('丸められない辺が 1 本ありました。半径を小さくしてください。');
    });
  });

  it('隣り合う丸みどうしがぶつかるときも、理由をつけて断る(落ちない)', () => {
    withBox(CUBE, (prepared) => {
      // 20³ の縦 4 稜線を R5 → R15 にすると、上のほうで丸みどうしがぶつかる。
      // 2026-09-05 の実測では IsDone() が偽・NbFaultyContours() は 0 で
      // NbFaultyVertices() が 2 になった(makeFillet.ts と同じ 2 通り目の失敗)。
      expect(() =>
        makeVariableFillet(oc, prepared.shape, prepared.tables, {
          targets: verticalEdgeIndices(prepared.tables).map((index) => ({
            target: edgeQuery(prepared.tables, index),
            startRadius: 5,
            endRadius: 15,
          })),
        }),
      ).toThrow('丸められませんでした。半径を小さくするか、辺を選び直してください。');
    });
  });
});
