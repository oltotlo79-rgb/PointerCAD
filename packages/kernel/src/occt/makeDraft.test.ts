import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { BoxParameters, SolidFaceInfo, SubShapeQuery } from '../types.js';
import { createAllocations } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { DraftInput } from './makeDraft.js';
import { draftStatusName, makeDraft } from './makeDraft.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes, faceAt } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * 抜き勾配(FR-417、FR-504、NFR-RE-1)の検査。計画書 P5 タスク34 の検証表。
 *
 * 期待値はすべて解析式から出す(§2.11)。40×30×10 の板の 4 側面に、上面を中立面として
 * 角度 θ を掛けると、中立面からの深さ d での断面は `(40 ± 2t)(30 ± 2t)`(`t = d·tanθ`)に
 * なるので、体積は
 *
 *   V = ∫₀^h (40 ± 2t)(30 ± 2t) dd = (1/tanθ)·(1200T ± 70T² + (4/3)T³)   (T = h·tanθ)
 *     = h·(1200 ± 70T + (4/3)T²)
 *
 * になる。`+` が外向き(広がる)、`−` が内向き(狭まる)。
 */

/** 計画書 タスク34 の検証表が使う板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };
const PLATE_VOLUME = 12000;

/** 検証表の角度 5 度(ラジアン)。 */
const FIVE_DEGREES = (5 * Math.PI) / 180;

/** 中立面(上面)から板の底までの距離 10mm で、側面が横へ寄る量 `T = 10·tan5°`。 */
const SHIFT = 10 * Math.tan(FIVE_DEGREES);

/**
 * 40×30×10 の板の 4 側面を、上面基準の角度 θ で傾けたときの体積(mm³)。
 * `outward` が真なら外へ広がり、偽なら内へ狭まる。上の式のとおり。
 */
function draftedPlateVolume(angle: number, outward: boolean): number {
  const shift = PLATE.dz * Math.tan(angle);
  const sign = outward ? 1 : -1;
  return (
    PLATE.dz *
    (PLATE.dx * PLATE.dy + sign * (PLATE.dx + PLATE.dy) * shift + (4 / 3) * shift * shift)
  );
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
  readonly size: readonly [number, number, number];
}

describe('抜き勾配(FR-417、FR-504、NFR-RE-1)', () => {
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

  /** 形の境界箱の 3 辺の長さ(mm)。上面が変わらないこと・下面が広がることを見るのに使う。 */
  function boxSize(shape: TopoDS_Shape): readonly [number, number, number] {
    const { keep, release } = createAllocations();
    try {
      const box = keep(new oc.Bnd_Box_1());
      // 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定(subShapes.ts と同じ)。
      oc.BRepBndLib.Add(shape, box, false);
      box.SetGap(0);
      const low = keep(box.CornerMin());
      const high = keep(box.CornerMax());
      return [high.X() - low.X(), high.Y() - low.Y(), high.Z() - low.Z()];
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

  /**
   * 法線が指定の向きに一致する**平らな**面 1 枚。見つからなければ検査の前提が崩れているので止める。
   *
   * 平面に限るのは、円柱の側面も軸(= 円柱の軸)を持ち、上面と同じ [0,0,1] を返すため
   * (2026-09-05 実測。`SolidFaceInfo.axis` は平面以外にも入る)。
   */
  function faceWithAxis(tables: SubShapeTables, axis: readonly [number, number, number]): SolidFaceInfo {
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

  /** 通し番号から面の実体を取り出す。取れなければ検査の前提が崩れているので止める。 */
  function takeFaceAt(prepared: Prepared, index: number): TopoDS_Face {
    const face = faceAt(oc, prepared.shape, index);
    if (face === null) {
      throw new Error(`通し番号 ${index} の面を取り出せません(検査の前提が崩れています)。`);
    }
    return face;
  }

  /** 法線の向きから面の実体を取り出す。呼び出し側が delete() する。 */
  function takeFace(prepared: Prepared, axis: readonly [number, number, number]): TopoDS_Face {
    return takeFaceAt(prepared, faceWithAxis(prepared.tables, axis).index);
  }

  /** 上下を向いていない平らな面(箱では側面 4 枚)。 */
  function sideFaces(tables: SubShapeTables): readonly SolidFaceInfo[] {
    return tables.faces.filter(
      (face) => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2]) < 1e-9,
    );
  }

  /** 上面を中立面にした依頼を組み立てる。 */
  function draftFromTop(
    tables: SubShapeTables,
    faces: readonly SolidFaceInfo[],
    angle: number,
    reversed: boolean,
  ): DraftInput {
    return {
      faces: faces.map(faceQuery),
      neutralFace: faceQuery(faceWithAxis(tables, [0, 0, 1])),
      angle,
      reversed,
    };
  }

  /** 傾けた結果を測って、必ず解放する。 */
  function measureDraft(prepared: Prepared, input: DraftInput): Measured {
    const result = makeDraft(oc, prepared.shape, prepared.tables, input);
    try {
      return {
        volume: measureVolume(oc, result.shape),
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
        tables: collectTables(result.shape),
        size: boxSize(result.shape),
      };
    } finally {
      result.delete();
    }
  }

  it('40×30×10 の 4 側面に上面基準 5 度(外向き)を掛けると 12622.6263 になる', () => {
    const prepared = prepare(PLATE);
    try {
      const sides = sideFaces(prepared.tables);
      expect(sides).toHaveLength(4);

      const measured = measureDraft(
        prepared,
        draftFromTop(prepared.tables, sides, FIVE_DEGREES, false),
      );

      // 解析値 = 10·(1200 + 70·T + (4/3)·T²)、T = 10·tan5° = 0.8748866352592401。
      const expected = draftedPlateVolume(FIVE_DEGREES, true);
      // 計画書は 12622.626333008903 と書いているが、その桁は倍精度で表せない
      // (最も近い倍精度は 12622.626333008902)。1e-12 の違いなので比較は 6 桁で足りる。
      expect(expected).toBeCloseTo(12622.626333008902, 6);
      // 計画書の許容は相対 1e-4。2026-09-05 の実測は 12622.626333008871 で、差は 3e-11。
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(Math.abs(measured.volume - expected) / expected).toBeLessThan(1e-4);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
    } finally {
      prepared.delete();
    }
  });

  it('同じ形を内向き(reversed)にすると 11397.7850 になる', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureDraft(
        prepared,
        draftFromTop(prepared.tables, sideFaces(prepared.tables), FIVE_DEGREES, true),
      );

      const expected = draftedPlateVolume(FIVE_DEGREES, false);
      expect(expected).toBeCloseTo(11397.785043645907, 6);
      expect(measured.volume).toBeCloseTo(expected, 6);
      expect(Math.abs(measured.volume - expected) / expected).toBeLessThan(1e-4);
      expect(measured.valid).toBe(true);
      // 外向きより痩せる(向きの取り違えを体積の大小でも捕まえる)。
      expect(measured.volume).toBeLessThan(PLATE_VOLUME);
    } finally {
      prepared.delete();
    }
  });

  it('中立面(上面)は 40×30 のまま動かず、下面だけが 41.7498×31.7498 へ広がる', () => {
    const prepared = prepare(PLATE);
    try {
      const measured = measureDraft(
        prepared,
        draftFromTop(prepared.tables, sideFaces(prepared.tables), FIVE_DEGREES, false),
      );

      // 上面は中立面なので面積が 1200 mm² のまま(法線も上向きのまま)。
      const top = faceWithAxis(measured.tables, [0, 0, 1]);
      expect(top.area).toBeCloseTo(PLATE.dx * PLATE.dy, 6);
      expect(top.centroid[2]).toBeCloseTo(PLATE.dz, 6);

      // 下面は両側へ T ずつ広がるので 40+2T、30+2T。
      const bottom = faceWithAxis(measured.tables, [0, 0, -1]);
      expect(bottom.area).toBeCloseTo(
        (PLATE.dx + 2 * SHIFT) * (PLATE.dy + 2 * SHIFT),
        6,
      );

      // 境界箱の底は下面と同じ大きさ。高さは変わらない。
      expect(measured.size[0]).toBeCloseTo(41.74977327051848, 6);
      expect(measured.size[1]).toBeCloseTo(31.74977327051848, 6);
      expect(measured.size[2]).toBeCloseTo(PLATE.dz, 6);
    } finally {
      prepared.delete();
    }
  });

  it('傾けても面の数は 6 枚のまま(面を増やさない)', () => {
    const prepared = prepare(PLATE);
    try {
      expect(prepared.tables.faces).toHaveLength(6);
      const measured = measureDraft(
        prepared,
        draftFromTop(prepared.tables, sideFaces(prepared.tables), FIVE_DEGREES, false),
      );
      expect(measured.tables.faces).toHaveLength(6);
    } finally {
      prepared.delete();
    }
  });

  it('1 枚だけ傾けると、その面だけが動いて他の 3 枚は変わらない', () => {
    const prepared = prepare(PLATE);
    try {
      const target = faceWithAxis(prepared.tables, [-1, 0, 0]);
      const measured = measureDraft(
        prepared,
        draftFromTop(prepared.tables, [target], FIVE_DEGREES, false),
      );

      // 足される材料は、断面が直角三角形(高さ 10、底辺 T)の三角柱で、長さは 30。
      const added = (PLATE.dy * PLATE.dz * SHIFT) / 2;
      expect(added).toBeCloseTo(131.232995288886, 9);
      expect(measured.volume).toBeCloseTo(PLATE_VOLUME + added, 6);
      expect(measured.volume).toBeCloseTo(12131.232995288887, 6);

      // 広がったのは x の向きだけ(y は 30 のまま)。
      expect(measured.size[0]).toBeCloseTo(PLATE.dx + SHIFT, 6);
      expect(measured.size[1]).toBeCloseTo(PLATE.dy, 9);
      // 反対側(x = 40)の面は法線も面積も変わらない。
      const untouched = faceWithAxis(measured.tables, [1, 0, 0]);
      expect(untouched.area).toBeCloseTo(PLATE.dy * PLATE.dz, 9);
    } finally {
      prepared.delete();
    }
  });

  // 上限は 60 度(統括の決定 §0.a-0.72、2026-09-05。P5 タスク42a で 90 度未満から狭めた)。
  // 89.99999 度のような値が妥当性検査を通って巨大な形になるのを、入り口で止めるため。
  it('角度が 0 以下・60 度より大きい・非数なら、傾けずに理由を返す', () => {
    const prepared = prepare(PLATE);
    try {
      const sides = sideFaces(prepared.tables);
      const bad = [
        0,
        -FIVE_DEGREES,
        // 60 度のすぐ上。ここが新しい境目で、以前(90 度未満)は通っていた値。
        Math.PI / 3 + 1e-9,
        (89.99999 / 180) * Math.PI,
        Math.PI / 2,
        Math.PI,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ];

      for (const angle of bad) {
        expect(() =>
          makeDraft(oc, prepared.shape, prepared.tables, draftFromTop(prepared.tables, sides, angle, false)),
        ).toThrow(/抜き勾配の角度は 0 度より大きく 60 度以下/);
      }

      // 検証表の 2 行(角度 0 は「0 度より大きく」、上限は「60 度以下」)を文言でも押さえる。
      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, draftFromTop(prepared.tables, sides, 0, false)),
      ).toThrow(/0 度より大きく/);
      expect(() =>
        makeDraft(
          oc,
          prepared.shape,
          prepared.tables,
          draftFromTop(prepared.tables, sides, Math.PI / 2, false),
        ),
      ).toThrow(/60 度以下/);
    } finally {
      prepared.delete();
    }
  });

  it('傾ける面が 1 枚も無ければ、Build を呼ばずに断る', () => {
    const prepared = prepare(PLATE);
    try {
      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, draftFromTop(prepared.tables, [], FIVE_DEGREES, false)),
      ).toThrow(/傾きを付ける面が選ばれていません/);
    } finally {
      prepared.delete();
    }
  });

  it('中立面に曲がった面(円柱面)を指すと、平らな面だけだと断る', () => {
    const { keep, release } = createAllocations();
    try {
      // 半径 10・高さ 20 の円柱。側面は円柱面、上下は平面。
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_1(10, 20));
      const cylinder = keep(maker.Shape());
      const tables = collectTables(cylinder);

      const curved = tables.faces.find((face) => face.surfaceKind === 'cylinder');
      const top = faceWithAxis(tables, [0, 0, 1]);
      if (curved === undefined) {
        throw new Error('円柱面が見つかりません(検査の前提が崩れています)。');
      }

      expect(() =>
        makeDraft(oc, cylinder, tables, {
          faces: [faceQuery(top)],
          neutralFace: faceQuery(curved),
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      ).toThrow(/平らな面だけ/);
    } finally {
      release();
    }
  });

  it('中立面の指紋がどの面にも届かなければ、基準の面が見つからないと断る', () => {
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
        makeDraft(oc, prepared.shape, prepared.tables, {
          faces: sideFaces(prepared.tables).map(faceQuery),
          neutralFace: lost,
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      ).toThrow(/基準の面が見つかりません/);

      // 面以外(辺)の指紋も同じ理由で断る(直し方が同じなので言い分けない)。
      const edge = prepared.tables.edges[0];
      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, {
          faces: sideFaces(prepared.tables).map(faceQuery),
          neutralFace: {
            kind: 'edge',
            index: edge.index,
            curveKind: edge.curveKind,
            length: edge.length,
            position: edge.midpoint,
            axis: edge.axis,
            radius: edge.radius,
          },
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      ).toThrow(/基準の面が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('傾ける面の指紋が 1 つでも届かなければ、部分成功にせず断る', () => {
    const prepared = prepare(PLATE);
    try {
      const good = faceQuery(sideFaces(prepared.tables)[0]);
      const lost: SubShapeQuery = {
        kind: 'face',
        index: 9999,
        surfaceKind: 'plane',
        area: 500000,
        position: [1000, 1000, 1000],
        axis: [1, 0, 0],
        radius: null,
      };
      const neutralFace = faceQuery(faceWithAxis(prepared.tables, [0, 0, 1]));

      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, {
          faces: [lost],
          neutralFace,
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      ).toThrow(/傾きを付ける面が見つかりません/);

      // 1 枚だけ傾いた別の形を黙って作らない。
      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, {
          faces: [good, lost],
          neutralFace,
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      ).toThrow(/傾きを付ける面が見つかりません/);
    } finally {
      prepared.delete();
    }
  });

  it('同じ面を 2 回指しても 1 回だけ傾ける(重複を取り除く)', () => {
    const prepared = prepare(PLATE);
    try {
      const target = faceWithAxis(prepared.tables, [-1, 0, 0]);
      const once = measureDraft(
        prepared,
        draftFromTop(prepared.tables, [target], FIVE_DEGREES, false),
      );
      const twice = measureDraft(
        prepared,
        draftFromTop(prepared.tables, [target, target], FIVE_DEGREES, false),
      );

      expect(twice.volume).toBeCloseTo(once.volume, 9);
      expect(twice.volume).toBeCloseTo(PLATE_VOLUME + (PLATE.dy * PLATE.dz * SHIFT) / 2, 6);
    } finally {
      prepared.delete();
    }
  });

  it('中立面と平行な面(抜き方向に垂直な面)を対象にすると、その面には付けられないと断る', () => {
    const prepared = prepare(PLATE);
    try {
      const top = faceWithAxis(prepared.tables, [0, 0, 1]);
      const bottom = faceWithAxis(prepared.tables, [0, 0, -1]);

      // 中立面そのもの。
      expect(() =>
        makeDraft(oc, prepared.shape, prepared.tables, draftFromTop(prepared.tables, [top], FIVE_DEGREES, false)),
      ).toThrow(/この面には傾きを付けられませんでした/);

      // 中立面と平行な向かいの面も同じ理由で断られる(2026-09-05 実測)。
      expect(() =>
        makeDraft(
          oc,
          prepared.shape,
          prepared.tables,
          draftFromTop(prepared.tables, [bottom], FIVE_DEGREES, false),
        ),
      ).toThrow(/この面には傾きを付けられませんでした/);
    } finally {
      prepared.delete();
    }
  });

  it('角度が大きすぎて面がぶつかるときは、例外で落ちずに理由を返す', () => {
    // 40×4×10 の細い板。内向きに 12 度傾けると向かい合う側面がぶつかる(2026-09-05 実測)。
    const prepared = prepare({ dx: 40, dy: 4, dz: 10 });
    try {
      const sides = sideFaces(prepared.tables);
      const degrees = (value: number): number => (value * Math.PI) / 180;

      // 11 度ならまだ成立する(境目のすぐ手前で成功することを押さえる)。
      const ok = measureDraft(prepared, draftFromTop(prepared.tables, sides, degrees(11), true));
      const shift = 10 * Math.tan(degrees(11));
      expect(ok.volume).toBeCloseTo(
        10 * (40 * 4 - (40 + 4) * shift + (4 / 3) * shift * shift),
        6,
      );
      expect(ok.valid).toBe(true);

      expect(() =>
        makeDraft(
          oc,
          prepared.shape,
          prepared.tables,
          draftFromTop(prepared.tables, sides, degrees(12), true),
        ),
      ).toThrow(/抜き勾配を付けられませんでした/);

      // 断ったあとも対象の形はそのまま使える(target を解放していない)。
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(40 * 4 * 10, 9);
    } finally {
      prepared.delete();
    }
  });

  it('傾ける面は曲がっていてもよい(円柱の側面は円錐台になる)', () => {
    const { keep, release } = createAllocations();
    try {
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_1(10, 20));
      const cylinder = keep(maker.Shape());
      const tables = collectTables(cylinder);
      const curved = tables.faces.find((face) => face.surfaceKind === 'cylinder');
      if (curved === undefined) {
        throw new Error('円柱面が見つかりません(検査の前提が崩れています)。');
      }

      const result = keep(
        makeDraft(oc, cylinder, tables, {
          faces: [faceQuery(curved)],
          neutralFace: faceQuery(faceWithAxis(tables, [0, 0, 1])),
          angle: FIVE_DEGREES,
          reversed: false,
        }),
      );

      // 上半径 10・下半径 10 + 20·tan5° の円錐台。V = π·h/3·(R² + R·r + r²)。
      const lower = 10 + 20 * Math.tan(FIVE_DEGREES);
      const expected = ((Math.PI * 20) / 3) * (lower * lower + lower * 10 + 100);
      expect(expected).toBeCloseTo(7446.724508549709, 6);
      expect(measureVolume(oc, result.shape)).toBeCloseTo(expected, 6);
      expect(isValidShape(oc, result.shape)).toBe(true);
    } finally {
      release();
    }
  });

  it('傾けても対象の形は消費しない(同じ形から続けて傾けられる)', () => {
    const prepared = prepare(PLATE);
    try {
      const sides = sideFaces(prepared.tables);
      const first = makeDraft(
        oc,
        prepared.shape,
        prepared.tables,
        draftFromTop(prepared.tables, [sides[0]], FIVE_DEGREES, false),
      );
      first.delete();

      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(PLATE_VOLUME, 9);

      const second = measureDraft(
        prepared,
        draftFromTop(prepared.tables, sides, FIVE_DEGREES, false),
      );
      expect(second.volume).toBeCloseTo(draftedPlateVolume(FIVE_DEGREES, true), 6);
    } finally {
      prepared.delete();
    }
  });

  it('1 段の所要は 500ms 未満(NFR-PF-2)', () => {
    const prepared = prepare(PLATE);
    try {
      const input = draftFromTop(prepared.tables, sideFaces(prepared.tables), FIVE_DEGREES, false);
      const started = performance.now();
      const result = makeDraft(oc, prepared.shape, prepared.tables, input);
      const elapsed = performance.now() - started;
      result.delete();

      // 実測を必ず記録に残す(rules/03-品質ゲート.md の性能検査と同じ流儀)。
      console.log(`抜き勾配 1 段(40×30×10 の 4 側面、5 度): ${elapsed.toFixed(1)}ms`);
      expectWithinBudget(elapsed, 500, '抜き勾配 1 段');
    } finally {
      prepared.delete();
    }
  });

  it('Status() の値と状況の対応(§1.5-16 の実測を固定する)', () => {
    const prepared = prepare(PLATE);
    const { keep, release } = createAllocations();
    try {
      const neutral = takeFace(prepared, [0, 0, 1]);
      keep(neutral);
      const adaptor = keep(new oc.BRepAdaptor_Surface_2(neutral, false));
      const plane = keep(adaptor.Plane());
      const direction = keep(new oc.gp_Dir_4(0, 0, 1));

      // ① 成功したときは Draft_NoError。
      const good = keep(new oc.BRepOffsetAPI_DraftAngle_2(prepared.shape));
      for (const info of sideFaces(prepared.tables)) {
        const face = takeFaceAt(prepared, info.index);
        try {
          good.Add(face, direction, FIVE_DEGREES, plane, true);
        } finally {
          face.delete();
        }
      }
      expect(good.AddDone()).toBe(true);
      good.Build(keep(new oc.Message_ProgressRange_1()));
      expect(good.IsDone()).toBe(true);
      expect(draftStatusName(oc, good.Status())).toBe('Draft_NoError');

      // ② 抜き方向に垂直な面(中立面と平行な面)は AddDone() が false で Draft_FaceRecomputation。
      const parallel = keep(new oc.BRepOffsetAPI_DraftAngle_2(prepared.shape));
      const bottom = takeFace(prepared, [0, 0, -1]);
      keep(bottom);
      parallel.Add(bottom, direction, FIVE_DEGREES, plane, true);
      expect(parallel.AddDone()).toBe(false);
      expect(draftStatusName(oc, parallel.Status())).toBe('Draft_FaceRecomputation');
    } finally {
      release();
      prepared.delete();
    }
  });

  it('角度が大きすぎて潰れたときの Status() は Draft_EdgeRecomputation', () => {
    // 40×4×10 の板を内向き 20 度。makeDraft は理由へ直して断るので、
    // ここでは OCCT の生の値がどれかだけを固定する(§1.5-16)。
    const prepared = prepare({ dx: 40, dy: 4, dz: 10 });
    const { keep, release } = createAllocations();
    try {
      const neutral = takeFace(prepared, [0, 0, 1]);
      keep(neutral);
      const adaptor = keep(new oc.BRepAdaptor_Surface_2(neutral, false));
      const plane = keep(adaptor.Plane());
      // 内向きなので抜き方向は上面の外向き法線の逆(makeDraft の reversed と同じ)。
      const direction = keep(new oc.gp_Dir_4(0, 0, -1));
      const maker = keep(new oc.BRepOffsetAPI_DraftAngle_2(prepared.shape));

      for (const info of sideFaces(prepared.tables)) {
        const face = takeFaceAt(prepared, info.index);
        try {
          maker.Add(face, direction, (20 * Math.PI) / 180, plane, true);
        } finally {
          face.delete();
        }
      }
      expect(maker.AddDone()).toBe(true);
      maker.Build(keep(new oc.Message_ProgressRange_1()));
      expect(maker.IsDone()).toBe(false);
      expect(draftStatusName(oc, maker.Status())).toBe('Draft_EdgeRecomputation');
    } finally {
      release();
      prepared.delete();
    }
  });
});
