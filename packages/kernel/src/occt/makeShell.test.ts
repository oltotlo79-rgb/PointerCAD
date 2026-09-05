import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { BoxParameters, SolidFaceInfo, SubShapeQuery } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { ShellInput } from './makeShell.js';
import { makeShell } from './makeShell.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * くり抜き(シェル、FR-418、FR-504、NFR-RE-1)の検査。計画書 P5 タスク53 の検証表。
 *
 * 期待値はすべて手計算で出す。20 × 20 × 20 の箱を肉厚 t で内向きにくり抜くと、
 * 中の空洞は「開けた面の側だけ壁が無い直方体」になるので、
 *
 *   開口なし   : 8000 − (20 − 2t)³
 *   上面だけ開口: 8000 − (20 − 2t)²(20 − t)
 *   上下を開口 : 8000 − (20 − 2t)²·20
 *
 * になる(t = 2 でそれぞれ 3904 / 3392 / 2880)。
 */

/** 検証表の箱。体積 8000 mm³。 */
const CUBE: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const CUBE_VOLUME = 8000;

/** 指示書の板。体積 12000 mm³。 */
const PLATE: BoxParameters = { dx: 40, dy: 30, dz: 10 };
const PLATE_VOLUME = 12000;

/** 検証表の肉厚(mm)。 */
const THICKNESS = 2;

/** 20³ を肉厚 2 で閉じたままくり抜いた体積 3904 = 8000 − 16³。 */
const CLOSED_VOLUME = CUBE_VOLUME - 16 ** 3;

/** 20³ の上面を開けて肉厚 2 でくり抜いた体積 3392 = 8000 − 16×16×18。 */
const TOP_OPEN_VOLUME = CUBE_VOLUME - 16 * 16 * 18;

/** 20³ の上下を開けて肉厚 2 でくり抜いた体積 2880 = 8000 − 16×16×20。 */
const BOTH_OPEN_VOLUME = CUBE_VOLUME - 16 * 16 * 20;

/** 40×30×10 の板の上面を開けて肉厚 2 でくり抜いた体積 4512 = 12000 − 36×26×8。 */
const PLATE_TOP_OPEN_VOLUME = PLATE_VOLUME - 36 * 26 * 8;

/**
 * 20³ を肉厚 2 で**外向き**にくり抜いた壁の体積 5587.492568…。
 *
 * 外向きのオフセットは角の作り方が `GeomAbs_Arc`(丸み)なので、外側の形は
 * 「箱と半径 2 の球のミンコフスキー和」になる。凸多面体のシュタイナーの公式
 *   V(K ⊕ rB) = V + A·r + (r²/2)·Σ(辺の長さ × 外角) + (4/3)πr³
 * に V = 8000、A = 2400、辺 12 本 × 長さ 20 × 外角 π/2 を入れると
 *   8000 + 4800 + (4/2)(120π) + (32/3)π = 12800 + 240π + (32/3)π
 * になり、そこから元の 8000 を引いたものが壁の体積である。
 */
const OUTWARD_CLOSED_VOLUME = 4800 + 240 * Math.PI + (32 / 3) * Math.PI;

/** くり抜き 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)の数値そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

/** 境界箱の 6 つの値を 1 つずつ 6 桁で比べる。 */
function expectBounds(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index], 6);
  }
}

interface Prepared {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  delete(): void;
}

describe('くり抜き(FR-418、FR-504、NFR-RE-1)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
    // 捨て計算。WASM の初回呼び出しに伴う立ち上がりぶんを所要から外す
    // (packages/kernel/src/worker/solidPerformance.test.ts と同じ決め。
    //  2026-09-05 実測: 入れないと 1 回目だけ 500ms を超えた)。
    // 2 つの経路(開口ありは MakeThickSolid、開口なしは MakeOffsetShape + ブーリアン)を
    // それぞれ 1 度ずつ流す。
    withBox({ dx: 10, dy: 10, dz: 10 }, (prepared) => {
      makeShell(oc, prepared.shape, prepared.tables, openTop(prepared.tables, 1)).delete();
      makeShell(oc, prepared.shape, prepared.tables, {
        openFaces: [],
        thickness: 1,
        outward: false,
      }).delete();
    });
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  /** 箱と、その面・辺・頂点の一覧を用意して渡し、必ず解放する。 */
  function withBox(parameters: BoxParameters, body: (prepared: Prepared) => void): void {
    const handle = makeBox(oc, parameters);
    try {
      body({
        shape: handle.shape,
        tables: collectTables(handle.shape),
        delete: () => {
          handle.delete();
        },
      });
    } finally {
      handle.delete();
    }
  }

  /** 一覧の面 1 枚から、文書が保存するのと同じ形の指紋を作る(makeDraft.test.ts と同じ)。 */
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
  function faceWithAxis(
    tables: SubShapeTables,
    axis: readonly [number, number, number],
  ): SolidFaceInfo {
    const found = tables.faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(
        `法線 ${JSON.stringify(axis)} の平らな面が見つかりません(検査の前提が崩れています)。`,
      );
    }
    return found;
  }

  /** 面の数を数える。 */
  function countFaces(shape: TopoDS_Shape): number {
    const subShapes = new oc.TopTools_IndexedMapOfShape_1();
    try {
      oc.TopExp.MapShapes_2(shape, subShapes, true, true);
      const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
      let count = 0;
      for (let position = 1; position <= subShapes.Size(); position += 1) {
        if (subShapes.FindKey(position).ShapeType() === faceType) {
          count += 1;
        }
      }
      return count;
    } finally {
      subShapes.delete();
    }
  }

  /** 境界箱を [minX, minY, minZ, maxX, maxY, maxZ] で返す。 */
  function boundsOf(shape: TopoDS_Shape): readonly number[] {
    const box = new oc.Bnd_Box_1();
    try {
      oc.BRepBndLib.Add(shape, box, false);
      box.SetGap(0);
      const low = box.CornerMin();
      const high = box.CornerMax();
      const bounds = [low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()];
      high.delete();
      low.delete();
      return bounds;
    } finally {
      box.delete();
    }
  }

  /** 上向きの面だけを開口にした依頼。 */
  function openTop(tables: SubShapeTables, thickness: number, outward = false): ShellInput {
    return {
      openFaces: [faceQuery(faceWithAxis(tables, [0, 0, 1]))],
      thickness,
      outward,
    };
  }

  it('面を 1 枚も選ばなければ、外から見た形はそのままで中だけが空になる(体積 3904)', () => {
    withBox(CUBE, (prepared) => {
      const started = performance.now();
      const result = makeShell(oc, prepared.shape, prepared.tables, {
        openFaces: [],
        thickness: THICKNESS,
        outward: false,
      });
      const elapsed = performance.now() - started;
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(CLOSED_VOLUME, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        // 外から見た大きさは変わらない(壁は内側にできる)。
        expectBounds(boundsOf(result.shape), [0, 0, 0, 20, 20, 20]);
        expectWithinBudget(elapsed, SINGLE_STEP_BUDGET_MS, 'くり抜き(開口なし)');
      } finally {
        result.delete();
      }
    });
  });

  it('上面を 1 枚選ぶと、その面が開いた入れ物になる(体積 3392、面 11 枚)', () => {
    withBox(CUBE, (prepared) => {
      const started = performance.now();
      const result = makeShell(oc, prepared.shape, prepared.tables, openTop(prepared.tables, THICKNESS));
      const elapsed = performance.now() - started;
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(TOP_OPEN_VOLUME, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        // 外 5 枚 + 内 5 枚 + 口の縁 1 枚(2026-09-05 実測)。
        expect(countFaces(result.shape)).toBe(11);
        expectWithinBudget(elapsed, SINGLE_STEP_BUDGET_MS, 'くり抜き(上面開口)');
      } finally {
        result.delete();
      }
    });
  });

  it('上面と底面の 2 枚を選ぶと、筒になる(体積 2880)', () => {
    withBox(CUBE, (prepared) => {
      const result = makeShell(oc, prepared.shape, prepared.tables, {
        openFaces: [
          faceQuery(faceWithAxis(prepared.tables, [0, 0, 1])),
          faceQuery(faceWithAxis(prepared.tables, [0, 0, -1])),
        ],
        thickness: THICKNESS,
        outward: false,
      });
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(BOTH_OPEN_VOLUME, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    });
  });

  it('同じ面を 2 度指しても 1 度だけ数える(結果は 1 枚選んだときと同じ)', () => {
    withBox(CUBE, (prepared) => {
      const top = faceQuery(faceWithAxis(prepared.tables, [0, 0, 1]));
      const result = makeShell(oc, prepared.shape, prepared.tables, {
        openFaces: [top, top],
        thickness: THICKNESS,
        outward: false,
      });
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(TOP_OPEN_VOLUME, 6);
        expect(countFaces(result.shape)).toBe(11);
      } finally {
        result.delete();
      }
    });
  });

  it('40×30×10 の板の上面を開けて肉厚 2 でくり抜くと 4512(底は残る)', () => {
    withBox(PLATE, (prepared) => {
      const started = performance.now();
      const result = makeShell(oc, prepared.shape, prepared.tables, openTop(prepared.tables, THICKNESS));
      const elapsed = performance.now() - started;
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(PLATE_TOP_OPEN_VOLUME, 6);
        expect(isValidShape(oc, result.shape)).toBe(true);
        expectWithinBudget(elapsed, SINGLE_STEP_BUDGET_MS, 'くり抜き(板の上面開口)');
      } finally {
        result.delete();
      }
    });
  });

  it('外向きにすると、元の形のまわりに壁ができる(角は丸くなる)', () => {
    withBox(CUBE, (prepared) => {
      const result = makeShell(oc, prepared.shape, prepared.tables, {
        openFaces: [],
        thickness: THICKNESS,
        outward: true,
      });
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(OUTWARD_CLOSED_VOLUME, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        // 外側は肉厚ぶん広がる(角は半径 2 の丸みになるので境界箱はちょうど ±2)。
        expectBounds(boundsOf(result.shape), [-2, -2, -2, 22, 22, 22]);
      } finally {
        result.delete();
      }
    });
  });

  it('もとの立体は変わらない(くり抜きは複製系で、引数に触れない)', () => {
    withBox(CUBE, (prepared) => {
      const result = makeShell(oc, prepared.shape, prepared.tables, openTop(prepared.tables, THICKNESS));
      try {
        expect(measureVolume(oc, prepared.shape)).toBeCloseTo(CUBE_VOLUME, 6);
      } finally {
        result.delete();
      }
      expect(measureVolume(oc, prepared.shape)).toBeCloseTo(CUBE_VOLUME, 6);
    });
  });

  it('肉厚 0 は理由をつけて断る(落ちない)', () => {
    withBox(CUBE, (prepared) => {
      expect(() =>
        makeShell(oc, prepared.shape, prepared.tables, {
          openFaces: [],
          thickness: 0,
          outward: false,
        }),
      ).toThrow('肉厚は 0 より大きい数にしてください。');
    });
  });

  it('肉厚が負でも数でなくても、同じ理由で断る', () => {
    withBox(CUBE, (prepared) => {
      for (const thickness of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          makeShell(oc, prepared.shape, prepared.tables, {
            openFaces: [],
            thickness,
            outward: false,
          }),
        ).toThrow('肉厚は 0 より大きい数にしてください。');
      }
    });
  });

  it('肉厚が大きすぎる(12)ときは理由をつけて断る(落ちない)', () => {
    withBox(CUBE, (prepared) => {
      expect(() =>
        makeShell(oc, prepared.shape, prepared.tables, openTop(prepared.tables, 12)),
      ).toThrow('肉厚が大きすぎます。小さくしてください。');
    });
  });

  it('肉厚が形の差し渡しを超えるときは、OCCT を呼ぶ前に断る', () => {
    withBox(CUBE, (prepared) => {
      // 境界箱の対角長 20√3 ≒ 34.64 の半分を超える肉厚は事前検査で落ちる。
      expect(() =>
        makeShell(oc, prepared.shape, prepared.tables, {
          openFaces: [],
          thickness: 20,
          outward: false,
        }),
      ).toThrow('肉厚が大きすぎます。小さくしてください。');
    });
  });

  it('開ける面の指紋が外れたら、選び直しを促して断る', () => {
    withBox(CUBE, (prepared) => {
      const top = faceWithAxis(prepared.tables, [0, 0, 1]);
      const strayed: SubShapeQuery = {
        kind: 'face',
        surfaceKind: top.surfaceKind,
        radius: top.radius,
        index: 99,
        area: 1,
        position: [500, 500, 500],
        axis: [1, 0, 0],
      };
      expect(() =>
        makeShell(oc, prepared.shape, prepared.tables, {
          openFaces: [strayed],
          thickness: THICKNESS,
          outward: false,
        }),
      ).toThrow('開ける面が見つかりません。');
    });
  });

  it('面ではない指紋(辺)を渡されたら、面を選び直すよう促して断る', () => {
    withBox(CUBE, (prepared) => {
      const edge = prepared.tables.edges[0];
      const query: SubShapeQuery = {
        kind: 'edge',
        index: edge.index,
        curveKind: edge.curveKind,
        length: edge.length,
        position: edge.midpoint,
        axis: edge.axis,
        radius: edge.radius,
      };
      expect(() =>
        makeShell(oc, prepared.shape, prepared.tables, {
          openFaces: [query],
          thickness: THICKNESS,
          outward: false,
        }),
      ).toThrow('開ける面が見つかりません。');
    });
  });
});
