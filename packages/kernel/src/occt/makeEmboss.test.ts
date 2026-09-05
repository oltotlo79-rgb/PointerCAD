import type {
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, CurveSpec, SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { EmbossInput } from './makeEmboss.js';
import { makeEmboss } from './makeEmboss.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * エンボス・刻印(FR-421、FR-504、NFR-RE-1)の検査。計画書 P5 タスク39 の検証表。
 *
 * 期待値はすべて手計算で出す。40×30×10 の板(体積 12000 mm³)の上面へ、
 * 面積 A の輪郭を深さ d で彫れば `12000 − A·d`、浮き出せば `12000 + A·d` になる。
 * 面の数は、彫っても浮き出しても **11 枚**(もとの 6 枚のうち上面は穴の開いた面 1 枚のまま、
 * そこへ輪郭の側面 4 枚と底(または頂)の面 1 枚が増える)。
 */

/** 計画書 タスク39 の検証表が使う板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };
const PLATE_VOLUME = 12000;

/** 上面の中心。輪郭はここを中心に置く。 */
const TOP_CENTRE: Vec3Tuple = [20, 15, 10];

/** 水平な正方形の輪郭(1 辺 size、中心 centre)。並んだ順につながって閉じる。 */
function squareProfile(centre: Vec3Tuple, size: number): readonly CurveSpec[] {
  const half = size / 2;
  const corners: readonly Vec3Tuple[] = [
    [centre[0] - half, centre[1] - half, centre[2]],
    [centre[0] + half, centre[1] - half, centre[2]],
    [centre[0] + half, centre[1] + half, centre[2]],
    [centre[0] - half, centre[1] + half, centre[2]],
  ];
  return corners.map((from, index) => ({
    kind: 'segment',
    from,
    to: corners[(index + 1) % corners.length],
  }));
}

/** 水平な円の輪郭(全周の円弧 1 本)。 */
function circleProfile(centre: Vec3Tuple, radius: number): readonly CurveSpec[] {
  return [
    {
      kind: 'arc',
      center: centre,
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius,
      startAngle: 0,
      endAngle: 2 * Math.PI,
    },
  ];
}

interface Prepared {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  delete(): void;
}

interface Measured {
  readonly volume: number;
  readonly solid: boolean;
  readonly valid: boolean;
  readonly tables: SubShapeTables;
  readonly bounds: { readonly low: Vec3Tuple; readonly high: Vec3Tuple };
}

describe('エンボス・刻印(FR-421、FR-504、NFR-RE-1)', () => {
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

  /** 形の境界箱(mm)。押し出した向き(上か下か)を確かめるのに使う。 */
  function bounds(shape: TopoDS_Shape): Measured['bounds'] {
    const { keep, release } = createAllocations();
    try {
      const box = keep(new oc.Bnd_Box_1());
      // 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定(subShapes.ts と同じ)。
      oc.BRepBndLib.Add(shape, box, false);
      box.SetGap(0);
      const low = keep(box.CornerMin());
      const high = keep(box.CornerMax());
      return {
        low: [low.X(), low.Y(), low.Z()],
        high: [high.X(), high.Y(), high.Z()],
      };
    } finally {
      release();
    }
  }

  /** 箱と、その面・辺・頂点の一覧を用意する。 */
  function prepare(parameters: BoxParameters): Prepared {
    const handle = makeBox(oc, parameters);
    return {
      shape: handle.shape,
      tables: collectTables(handle.shape),
      delete: () => {
        handle.delete();
      },
    };
  }

  /** 一覧の面 1 枚から、文書が保存するのと同じ形の指紋を作る。 */
  function faceQuery(face: SolidFaceInfo): SubShapeQuery {
    return {
      kind: 'face',
      index: face.index,
      surfaceKind: face.surfaceKind,
      area: face.area,
      position: face.centroid,
      axis: face.axis,
      radius: face.radius,
    };
  }

  /** 法線が指定の向きに一致する平らな面 1 枚。見つからなければ検査の前提が崩れている。 */
  function faceWithAxis(tables: SubShapeTables, axis: Vec3Tuple): SolidFaceInfo {
    const found = tables.faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`法線 ${JSON.stringify(axis)} の平らな面が見つかりません(検査の前提が崩れています)。`);
    }
    return found;
  }

  /** 上面(法線 +Z)を相手にした依頼を組み立てる。 */
  function embossOnTop(
    tables: SubShapeTables,
    profiles: readonly (readonly CurveSpec[])[],
    depth: number,
    raised: boolean,
  ): EmbossInput {
    return { face: faceQuery(faceWithAxis(tables, [0, 0, 1])), profiles, depth, raised };
  }

  /** エンボスした結果を測って、必ず解放する。 */
  function measureEmboss(prepared: Prepared, input: EmbossInput): Measured {
    const result = makeEmboss(oc, prepared.shape, prepared.tables, input);
    try {
      return {
        volume: result.volume,
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
        tables: collectTables(result.shape),
        bounds: bounds(result.shape),
      };
    } finally {
      result.delete();
    }
  }

  it('40×30×10 の上面に 10×10 を深さ 2 で彫ると 11800 になる(面は 11 枚)', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 2, false),
      );

      expect(measured.volume).toBeCloseTo(PLATE_VOLUME - 10 * 10 * 2, 6);
      expect(measured.volume).toBeCloseTo(11800, 6);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
      // もとの 6 枚 + 彫った穴の側面 4 枚 + 底 1 枚(上面は穴の開いた 1 枚のまま)。
      expect(prepared.tables.faces).toHaveLength(6);
      expect(measured.tables.faces).toHaveLength(11);
      // 彫った先は材料の中なので、外形は 40×30×10 のまま。
      expect(measured.bounds.low[2]).toBeCloseTo(0, 9);
      expect(measured.bounds.high[2]).toBeCloseTo(10, 9);
    } finally {
      prepared.delete();
    }
  });

  it('同じ輪郭を深さ 2 で浮き出すと 12200 になり、上へ 2mm 伸びる(面は 11 枚)', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 2, true),
      );

      expect(measured.volume).toBeCloseTo(PLATE_VOLUME + 10 * 10 * 2, 6);
      expect(measured.volume).toBeCloseTo(12200, 6);
      expect(measured.valid).toBe(true);
      expect(measured.tables.faces).toHaveLength(11);
      // 上面の外(+Z)へ深さぶんだけ伸びる。横へは広がらない。
      expect(measured.bounds.high[2]).toBeCloseTo(12, 9);
      expect(measured.bounds.low[2]).toBeCloseTo(0, 9);
      expect(measured.bounds.high[0]).toBeCloseTo(PLATE.dx, 9);
      expect(measured.bounds.high[1]).toBeCloseTo(PLATE.dy, 9);
    } finally {
      prepared.delete();
    }
  });

  it('輪郭 2 つ(10×10 と 5×5)を深さ 2 で彫ると 11750 になる', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(
          prepared.tables,
          [squareProfile([12, 15, 10], 10), squareProfile([30, 15, 10], 5)],
          2,
          false,
        ),
      );

      expect(measured.volume).toBeCloseTo(PLATE_VOLUME - (100 + 25) * 2, 6);
      expect(measured.volume).toBeCloseTo(11750, 6);
      expect(measured.valid).toBe(true);
      // 穴 2 つぶん(側面 4 + 底 1)が増える。
      expect(measured.tables.faces).toHaveLength(16);
    } finally {
      prepared.delete();
    }
  });

  it('φ10 の円を深さ 1 で浮き出すと 12000 + 25π = 12078.5398 になる', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [circleProfile(TOP_CENTRE, 5)], 1, true),
      );

      const expected = PLATE_VOLUME + Math.PI * 25;
      expect(expected).toBeCloseTo(12078.539816339744, 9);
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(measured.valid).toBe(true);
      expect(measured.bounds.high[2]).toBeCloseTo(11, 9);
      // 円柱 1 本ぶん(側面 1 枚 + 頂 1 枚)が増えて 8 枚。
      expect(measured.tables.faces).toHaveLength(8);
    } finally {
      prepared.delete();
    }
  });

  it('深さが板の厚みより大きい(15)ときは貫通する(断らない)', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 15, false),
      );

      // 板の厚み 10 までしか材料が無いので、削れるのは 100×10 = 1000 mm³。
      expect(measured.volume).toBeCloseTo(PLATE_VOLUME - 100 * PLATE.dz, 6);
      expect(measured.volume).toBeCloseTo(11000, 6);
      expect(measured.volume).toBeLessThan(11800);
      expect(measured.valid).toBe(true);
      // 貫通した穴の側面 4 枚が増え、上面と下面はどちらも穴の開いた 1 枚のまま。
      expect(measured.tables.faces).toHaveLength(10);
    } finally {
      prepared.delete();
    }
  });

  it('下向きの面(底面)でも、彫れば中へ・浮き出せば外へ向かう', () => {
    const prepared = prepare(PLATE);
    try {
      const bottom = faceQuery(faceWithAxis(prepared.tables, [0, 0, -1]));
      const profiles = [squareProfile([20, 15, 0], 10)];

      const carved = measureEmboss(prepared, { face: bottom, profiles, depth: 2, raised: false });
      expect(carved.volume).toBeCloseTo(11800, 6);
      // 材料の中(上向き)へ彫るので外形は変わらない。
      expect(carved.bounds.low[2]).toBeCloseTo(0, 9);

      const raised = measureEmboss(prepared, { face: bottom, profiles, depth: 2, raised: true });
      expect(raised.volume).toBeCloseTo(12200, 6);
      // 面の向き(TopAbs_REVERSED)を見ていないと、ここが 0 のままになる。
      expect(raised.bounds.low[2]).toBeCloseTo(-2, 9);
      expect(raised.bounds.high[2]).toBeCloseTo(10, 9);
    } finally {
      prepared.delete();
    }
  });

  it('輪郭が面からはみ出していれば断る', () => {
    const prepared = prepare(PLATE);
    try {
      // 中心を x = 40(板の縁)に置くと、半分が面の外へ出る。
      expect(() =>
        makeEmboss(
          oc,
          prepared.shape,
          prepared.tables,
          embossOnTop(prepared.tables, [squareProfile([40, 15, 10], 10)], 2, false),
        ),
      ).toThrow(/輪郭が面からはみ出しています/);

      // 面から完全に外れた輪郭も同じ理由で断る。
      expect(() =>
        makeEmboss(
          oc,
          prepared.shape,
          prepared.tables,
          embossOnTop(prepared.tables, [squareProfile([60, 15, 10], 10)], 2, true),
        ),
      ).toThrow(/輪郭が面からはみ出しています/);

      // 2 つのうち 1 つだけがはみ出す場合も、部分成功にせず断る。
      expect(() =>
        makeEmboss(
          oc,
          prepared.shape,
          prepared.tables,
          embossOnTop(
            prepared.tables,
            [squareProfile(TOP_CENTRE, 10), squareProfile([40, 15, 10], 10)],
            2,
            false,
          ),
        ),
      ).toThrow(/輪郭が面からはみ出しています/);
    } finally {
      prepared.delete();
    }
  });

  it('深さが 0 以下・非数なら断る', () => {
    const prepared = prepare(PLATE);
    try {
      for (const depth of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          makeEmboss(
            oc,
            prepared.shape,
            prepared.tables,
            embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], depth, false),
          ),
        ).toThrow(/深さは 0 より大きい数にしてください/);
      }
    } finally {
      prepared.delete();
    }
  });

  it('輪郭が 1 本も無ければ断る', () => {
    const prepared = prepare(PLATE);
    try {
      expect(() =>
        makeEmboss(oc, prepared.shape, prepared.tables, embossOnTop(prepared.tables, [], 2, false)),
      ).toThrow(/エンボスの輪郭が選ばれていません/);

      // 空の輪郭が混ざっている場合も同じ。
      expect(() =>
        makeEmboss(oc, prepared.shape, prepared.tables, embossOnTop(prepared.tables, [[]], 2, false)),
      ).toThrow(/エンボスの輪郭が選ばれていません/);
    } finally {
      prepared.delete();
    }
  });

  it('曲がった面(円柱面)を指すと、平らな面だけだと断る(§0.a-0.38)', () => {
    const { keep, release } = createAllocations();
    try {
      // 半径 10・高さ 20 の円柱。側面は円柱面、上下は平面。
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_1(10, 20));
      const cylinder = keep(maker.Shape());
      const tables = collectTables(cylinder);
      const curved = tables.faces.find((face) => face.surfaceKind === 'cylinder');
      if (curved === undefined) {
        throw new Error('円柱面が見つかりません(検査の前提が崩れています)。');
      }

      expect(() =>
        makeEmboss(oc, cylinder, tables, {
          face: faceQuery(curved),
          profiles: [squareProfile([0, 0, 20], 5)],
          depth: 1,
          raised: false,
        }),
      ).toThrow(/平らな面だけ/);

      // 同じ円柱の上面(平面)なら通る。半径 10 の円の上に 5×5 を 1mm 浮き出す。
      const result = makeEmboss(oc, cylinder, tables, {
        face: faceQuery(faceWithAxis(tables, [0, 0, 1])),
        profiles: [squareProfile([0, 0, 20], 5)],
        depth: 1,
        raised: true,
      });
      try {
        expect(result.volume).toBeCloseTo(Math.PI * 100 * 20 + 25, 6);
      } finally {
        result.delete();
      }
    } finally {
      release();
    }
  });

  it('面の指紋がどの面にも届かなければ、もとの面が見つからないと断る', () => {
    const prepared = prepare(PLATE);
    try {
      const lost: SubShapeQuery = {
        kind: 'face',
        index: 9999,
        surfaceKind: 'plane',
        area: 500000,
        position: [1000, 1000, 1000],
        axis: [0, 0, 1],
        radius: null,
      };

      expect(() =>
        makeEmboss(oc, prepared.shape, prepared.tables, {
          face: lost,
          profiles: [squareProfile(TOP_CENTRE, 10)],
          depth: 2,
          raised: false,
        }),
      ).toThrow(/エンボスするもとの面が見つかりません/);

      // 面以外(辺)の指紋も同じ理由で断る(直し方が同じなので言い分けない)。
      const edge = prepared.tables.edges[0];
      expect(() =>
        makeEmboss(oc, prepared.shape, prepared.tables, {
          face: {
            kind: 'edge',
            index: edge.index,
            curveKind: edge.curveKind,
            length: edge.length,
            position: edge.midpoint,
            axis: edge.axis,
            radius: edge.radius,
          },
          profiles: [squareProfile(TOP_CENTRE, 10)],
          depth: 2,
          raised: false,
        }),
      ).toThrow(/エンボスするもとの面が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('輪郭の平面が面と平行でなければ断る', () => {
    const prepared = prepare(PLATE);
    try {
      // 4 点は同じ平面に乗っているが、その平面は上面(z = 10)に対して傾いている。
      const tilted: readonly CurveSpec[] = [
        { kind: 'segment', from: [15, 10, 10], to: [25, 10, 10] },
        { kind: 'segment', from: [25, 10, 10], to: [25, 20, 12] },
        { kind: 'segment', from: [25, 20, 12], to: [15, 20, 12] },
        { kind: 'segment', from: [15, 20, 12], to: [15, 10, 10] },
      ];

      expect(() =>
        makeEmboss(
          oc,
          prepared.shape,
          prepared.tables,
          embossOnTop(prepared.tables, [tilted], 2, false),
        ),
      ).toThrow(/輪郭が面と平行ではありません/);
    } finally {
      prepared.delete();
    }
  });

  it('面と平行なまま少しだけ浮いた輪郭は、面へ落としてから彫る(丸めのぶんを吸収する)', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [squareProfile([20, 15, 10 + 1e-6], 10)], 2, false),
      );
      // 落とさずに押し出すと 1e-6 ぶん浅い穴になる。落としているので厳密に 200 減る。
      expect(measured.volume).toBeCloseTo(11800, 6);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('閉じていない輪郭は、面を張れない理由をそのまま返す', () => {
    const prepared = prepare(PLATE);
    try {
      const open: readonly CurveSpec[] = [
        { kind: 'segment', from: [15, 10, 10], to: [25, 10, 10] },
        { kind: 'segment', from: [25, 10, 10], to: [25, 20, 10] },
      ];

      expect(() =>
        makeEmboss(oc, prepared.shape, prepared.tables, embossOnTop(prepared.tables, [open], 2, false)),
      ).toThrow(/輪郭が閉じていないため/);
    } finally {
      prepared.delete();
    }
  });

  it('エンボスしても対象の形は消費しない(同じ形から続けて彫れる)', () => {
    const prepared = prepare(PLATE);
    try {
      const first = makeEmboss(
        oc,
        prepared.shape,
        prepared.tables,
        embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 2, false),
      );
      first.delete();

      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(PLATE_VOLUME, 9);

      const second = measureEmboss(
        prepared,
        embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 2, true),
      );
      expect(second.volume).toBeCloseTo(12200, 6);
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(PLATE_VOLUME, 9);
    } finally {
      prepared.delete();
    }
  });

  it('1 段の所要は 500ms 未満(NFR-PF-2)', () => {
    const prepared = prepare(PLATE);
    try {
      const input = embossOnTop(prepared.tables, [squareProfile(TOP_CENTRE, 10)], 2, false);
      const started = performance.now();
      const result = makeEmboss(oc, prepared.shape, prepared.tables, input);
      const elapsed = performance.now() - started;
      result.delete();

      // 実測を必ず記録に残す(rules/03-品質ゲート.md の性能検査と同じ流儀)。
      console.log(`エンボス 1 段(40×30×10 の上面に 10×10 を深さ 2 で彫る): ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(500);
    } finally {
      prepared.delete();
    }
  });
});

