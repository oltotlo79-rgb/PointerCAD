import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveShapeSpec, SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox, type OcctShapeHandle } from './makeBox.js';
import type { CutInput } from './makeCut.js';
import { makeCut } from './makeCut.js';
import { makePrimitive } from './makePrimitive.js';
import { matchFace, SUB_SHAPE_MATCH_THRESHOLD } from './matchSubShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * 平面による切断(FR-432、FR-424、FR-504、NFR-RE-1)の検査。
 * 期待値は計画書 P5 §2.9b.4 とタスク27b の検証表からそのまま取り、解析式で導ける値だけを使う。
 */

/** 検証表の板。体積 12000 mm³、`0..40 × 0..30 × 0..10`、重心 `[20,15,5]`。 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;
const PLATE_VOLUME = 12000;

/** 切断 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)の数値そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

/**
 * 性能上限の判定を「厳密」と「参考」で切り替える窓口。
 * 決めと理由は packages/kernel/src/worker/solidPerformance.test.ts の
 * expectWithinBudget と同じ(rules/03-品質ゲート.md §7.1、rules/06 の 10.3)。
 * 上限の数値は変えない。
 */
function expectWithinBudget(actualMs: number, limitMs: number, label: string): void {
  if (process.env.POINTERCAD_PERF_STRICT === '1') {
    expect(actualMs).toBeLessThan(limitMs);
    return;
  }
  if (actualMs >= limitMs) {
    console.log(
      `[参考] 上限超過: ${label}(実測 ${actualMs.toFixed(1)} ms ≥ 上限 ${String(limitMs)} ms。コミット前検査のため失敗にしません)`,
    );
  }
}

/** 相対誤差で比べる(球・円柱のように厳密値が無理数になる期待値で使う)。 */
function expectRelative(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

/** 長さ 1 へ揃える(検査の中で法線を作るときに使う)。 */
function unit(value: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** 3 点を通る平面の法線(§2.9b.1 の規則。p1→p2 と p1→p3 の外積、右ねじ)。 */
function normalOfThreePoints(p1: Vec3Tuple, p2: Vec3Tuple, p3: Vec3Tuple): Vec3Tuple {
  const a: Vec3Tuple = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const b: Vec3Tuple = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
  return unit([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

/** 面 1 枚の素性を、文書が保存する指紋の形へ写す(model がやることと同じ)。 */
function faceQuery(face: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
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

describe('平面による切断(FR-432、FR-424、FR-504、NFR-RE-1)', () => {
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

  /** 形の中の面の数。 */
  function countFaces(shape: TopoDS_Shape): number {
    const { keep, release } = createAllocations();
    try {
      const map = keep(new oc.TopTools_IndexedMapOfShape_1());
      // 第 3・第 4 引数は「向きと位置を親からたどって積み上げる」指定(subShapes.ts と同じ)。
      oc.TopExp.MapShapes_2(shape, map, true, true);
      const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
      let count = 0;
      const size = Number(map.Size());
      for (let position = 1; position <= size; position += 1) {
        if (keep(map.FindKey(position)).ShapeType() === faceType) {
          count += 1;
        }
      }
      return count;
    } finally {
      release();
    }
  }

  /** 基本形状を 1 つ作る(球・円柱・中心が原点の箱)。 */
  function primitive(origin: Vec3Tuple, axis: Vec3Tuple, shape: PrimitiveShapeSpec): OcctShapeHandle {
    return makePrimitive(oc, {
      kind: 'primitive',
      origin,
      axis,
      shape,
      originQuery: null,
      targetKey: null,
    });
  }

  /** 切ってから体積・面数・立体かどうかを測り、形は解放する。 */
  function cutAndMeasure(
    target: TopoDS_Shape,
    input: CutInput,
  ): { readonly volume: number; readonly faces: number; readonly solid: boolean; readonly valid: boolean } {
    const result = makeCut(oc, target, input);
    try {
      return {
        volume: measureVolume(oc, result.shape),
        faces: countFaces(result.shape),
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
      };
    } finally {
      result.delete();
    }
  }

  /** 板を切ったときの体積だけを返す(検証表の 1 行ぶん)。 */
  function plateCutVolume(origin: Vec3Tuple, normal: Vec3Tuple, keepPositive: boolean): number {
    const plate = makeBox(oc, PLATE);
    try {
      return cutAndMeasure(plate.shape, { origin, normal, keepPositive }).volume;
    } finally {
      plate.delete();
    }
  }

  describe('OCCT の API(§1.5-23 / -24 の実測)', () => {
    it('切断に使うクラスが束縛されている', () => {
      expect(oc.BRepPrimAPI_MakeHalfSpace_1).toBeTypeOf('function');
      expect(oc.gp_Pln_3).toBeTypeOf('function');
      expect(oc.BRepBuilderAPI_MakeFace_9).toBeTypeOf('function');
      expect(oc.BRepBuilderAPI_Copy_2).toBeTypeOf('function');
    });

    /**
     * (a) 半空間 + intersect と (b) 大きな箱 + intersect を同じ配置で比べる(§1.5-24)。
     * 数値は環境差が大きいので上限判定はせず、統括への報告のために表を出す。
     * **どちらも同じ体積・同じ面数になること**だけを固定する(方式の選択が結果を変えない)。
     */
    it('(a) 半空間と (b) 大きな箱が同じ結果になる(所要は記録する)', () => {
      const plate = makeBox(oc, PLATE);
      const diagonal = Math.hypot(PLATE.dx, PLATE.dy, PLATE.dz);
      const size = diagonal + (diagonal * 0.01 + 1);
      // 上面に平行で真ん中でない平面(z=3)。上下の体積が違うので「どちらが残ったか」が分かる。
      const expected = new Map<number, number>([
        [1, PLATE.dx * PLATE.dy * 7],
        [-1, PLATE.dx * PLATE.dy * 3],
      ]);

      try {
        for (const sign of [1, -1]) {
          const halfSpace = createAllocations();
          const startedA = performance.now();
          const location = halfSpace.keep(new oc.gp_Pnt_3(20, 15, 3));
          const direction = halfSpace.keep(new oc.gp_Dir_4(0, 0, 1));
          const plane = halfSpace.keep(new oc.gp_Pln_3(location, direction));
          const faceMaker = halfSpace.keep(
            new oc.BRepBuilderAPI_MakeFace_9(plane, -size, size, -size, size),
          );
          const face = halfSpace.keep(faceMaker.Face());
          // 参照点は平面から sign 方向へ size だけ離した点。
          const reference = halfSpace.keep(new oc.gp_Pnt_3(20, 15, 3 + sign * size));
          const maker = halfSpace.keep(new oc.BRepPrimAPI_MakeHalfSpace_1(face, reference));
          const solid = halfSpace.keep(maker.Solid());
          const resultA = booleanOp(oc, 'intersect', plate.shape, solid);
          const elapsedA = performance.now() - startedA;
          const facesA = countFaces(resultA.shape);
          const volumeA = resultA.volume;
          resultA.delete();
          halfSpace.release();

          const bigBox = createAllocations();
          const startedB = performance.now();
          // 軸に平行な平面なので、この比較では 2 隅で箱を作れる(斜めの平面では回転が要る)。
          const low = bigBox.keep(new oc.gp_Pnt_3(20 - size, 15 - size, sign > 0 ? 3 : 3 - size));
          const high = bigBox.keep(new oc.gp_Pnt_3(20 + size, 15 + size, sign > 0 ? 3 + size : 3));
          const boxMaker = bigBox.keep(new oc.BRepPrimAPI_MakeBox_4(low, high));
          const resultB = booleanOp(oc, 'intersect', plate.shape, bigBox.keep(boxMaker.Shape()));
          const elapsedB = performance.now() - startedB;
          const facesB = countFaces(resultB.shape);
          const volumeB = resultB.volume;
          resultB.delete();
          bigBox.release();

          console.log(
            `[実測 §1.5-24] 参照点 ${sign > 0 ? '正' : '負'}側: (a) 半空間 体積 ${volumeA.toFixed(6)} / 面 ${String(facesA)} / ${elapsedA.toFixed(1)} ms、(b) 大きな箱 体積 ${volumeB.toFixed(6)} / 面 ${String(facesB)} / ${elapsedB.toFixed(1)} ms`,
          );

          // 参照点を置いた側が残る(§1.5-23 ③。makeCut.ts の注釈に残した規約)。
          expect(volumeA).toBeCloseTo(expected.get(sign) ?? 0, 6);
          expect(volumeB).toBeCloseTo(expected.get(sign) ?? 0, 6);
          expect(facesA).toBe(facesB);
        }
      } finally {
        plate.delete();
      }
    });
  });

  describe('体積(§2.9b.4 の表)', () => {
    it('重心を通る水平な面(z=5)は、どちらの側も半分になる', () => {
      expect(plateCutVolume([20, 15, 5], [0, 0, 1], true)).toBeCloseTo(6000, 6);
      expect(plateCutVolume([20, 15, 5], [0, 0, 1], false)).toBeCloseTo(6000, 6);
    });

    it('「反対側も残す」の 2 段の合計は元の体積に戻る', () => {
      const positive = plateCutVolume([20, 15, 5], [0, 0, 1], true);
      const negative = plateCutVolume([20, 15, 5], [0, 0, 1], false);
      expect(positive + negative).toBeCloseTo(PLATE_VOLUME, 6);
    });

    it('x=10 の面(法線 [1,0,0])は 9000 と 3000 に分かれる', () => {
      expect(plateCutVolume([10, 15, 5], [1, 0, 0], true)).toBeCloseTo(9000, 6);
      expect(plateCutVolume([10, 15, 5], [1, 0, 0], false)).toBeCloseTo(3000, 6);
    });

    it('上面に平行な z=3 の面は 8400 と 3600 に分かれる', () => {
      expect(plateCutVolume([20, 15, 3], [0, 0, 1], true)).toBeCloseTo(8400, 6);
      expect(plateCutVolume([20, 15, 3], [0, 0, 1], false)).toBeCloseTo(3600, 6);
    });

    /** 重心を通る平面は向きに依らず立体を二等分する(強い検査)。 */
    it('重心を通る平面は、向きに依らず 6000 ずつに分ける', () => {
      const normals: readonly Vec3Tuple[] = [
        unit([1, 1, 1]),
        unit([2, -1, 3]),
        unit([-1, 4, 2]),
        unit([0, 1, 0]),
      ];
      for (const normal of normals) {
        expect(plateCutVolume([20, 15, 5], normal, true)).toBeCloseTo(6000, 6);
        expect(plateCutVolume([20, 15, 5], normal, false)).toBeCloseTo(6000, 6);
      }
    });

    /**
     * Z 軸から 30 度倒した法線 `[0.5, 0, √3/2]` で `[10,15,5]` を通る平面。
     * 負側の断面積は `10·(10−5√3) + 10·(10√3)/2 = 100`(§2.9b.4 の導出)。
     */
    it('30 度傾けた面は 9000 と 3000 に分かれる', () => {
      const normal: Vec3Tuple = [0.5, 0, Math.sqrt(3) / 2];
      expect(plateCutVolume([10, 15, 5], normal, true)).toBeCloseTo(9000, 6);
      expect(plateCutVolume([10, 15, 5], normal, false)).toBeCloseTo(3000, 6);
    });

    it('中心が原点の 20³ を法線 [1,1,0]/√2・原点を通る面で切ると、どちらも 4000', () => {
      const cube = primitive([0, 0, 0], [0, 0, 1], {
        kind: 'box',
        sizeX: 20,
        sizeY: 20,
        sizeZ: 20,
      });
      try {
        const normal = unit([1, 1, 0]);
        expect(cutAndMeasure(cube.shape, { origin: [0, 0, 0], normal, keepPositive: true }).volume)
          .toBeCloseTo(4000, 6);
        expect(cutAndMeasure(cube.shape, { origin: [0, 0, 0], normal, keepPositive: false }).volume)
          .toBeCloseTo(4000, 6);
      } finally {
        cube.delete();
      }
    });

    it('半径 10 の球を z=5 で切ると球冠と残りに分かれる', () => {
      const sphere = primitive([0, 0, 0], [0, 0, 1], { kind: 'sphere', radius: 10 });
      try {
        const cap = cutAndMeasure(sphere.shape, {
          origin: [0, 0, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        }).volume;
        const rest = cutAndMeasure(sphere.shape, {
          origin: [0, 0, 5],
          normal: [0, 0, 1],
          keepPositive: false,
        }).volume;
        // 球冠 πh²(3r−h)/3(r=10、h=5)= 654.4984694978736、
        // 残りは球の体積 4πr³/3 = 4188.790204786391 との差 = 3534.2917352885174
        // (§2.9b.4 の導出。桁を落とさないよう式のまま書く)。
        const capVolume = (Math.PI * 5 * 5 * (3 * 10 - 5)) / 3;
        const sphereVolume = (4 * Math.PI * 10 * 10 * 10) / 3;
        expectRelative(cap, capVolume, 1e-4);
        expectRelative(rest, sphereVolume - capVolume, 1e-4);
      } finally {
        sphere.delete();
      }
    });

    it('半径 10・高さ 20 の円柱を z=5 で切ると π·100·15 と π·100·5 に分かれる', () => {
      const cylinder = primitive([0, 0, 0], [0, 0, 1], {
        kind: 'cylinder',
        radius: 10,
        height: 20,
      });
      try {
        const upper = cutAndMeasure(cylinder.shape, {
          origin: [0, 0, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        }).volume;
        const lower = cutAndMeasure(cylinder.shape, {
          origin: [0, 0, 5],
          normal: [0, 0, 1],
          keepPositive: false,
        }).volume;
        // π·100·15 = 4712.38898038469、π·100·5 = 1570.7963267948967(§2.9b.4)。
        expectRelative(upper, Math.PI * 100 * 15, 1e-4);
        expectRelative(lower, Math.PI * 100 * 5, 1e-4);
      } finally {
        cylinder.delete();
      }
    });

    it('3 点 [0,0,5] [40,0,5] [0,30,5] で決まる面の正側は 6000', () => {
      const normal = normalOfThreePoints([0, 0, 5], [40, 0, 5], [0, 30, 5]);
      expect(normal[2]).toBeCloseTo(1, 12);
      expect(plateCutVolume([0, 0, 5], normal, true)).toBeCloseTo(6000, 6);
    });
  });

  describe('形と面の数(タスク27b の検証表)', () => {
    it('z=5 で切った結果は面 6 枚の立体で、B-rep として妥当', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const measured = cutAndMeasure(plate.shape, {
          origin: [20, 15, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        console.log(`[実測] z=5 で切った結果の面数: ${String(measured.faces)}`);
        expect(measured.faces).toBe(6);
        expect(measured.solid).toBe(true);
        expect(measured.valid).toBe(true);
      } finally {
        plate.delete();
      }
    });

    it('対象は消費されない(切ったあとも元の形が使える)', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const result = makeCut(oc, plate.shape, {
          origin: [20, 15, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        result.delete();
        // 結果を解放したあとでも、元の形はそのまま測れる(引数を解放していない証拠)。
        expect(measureVolume(oc, plate.shape)).toBeCloseTo(PLATE_VOLUME, 6);
      } finally {
        plate.delete();
      }
    });
  });

  describe('平面が交わらないとき(§2.9b.3 の断り方)', () => {
    it('z=100 の面の負側は、対象がそのまま残る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const measured = cutAndMeasure(plate.shape, {
          origin: [20, 15, 100],
          normal: [0, 0, 1],
          keepPositive: false,
        });
        expect(measured.volume).toBeCloseTo(PLATE_VOLUME, 6);
        expect(measured.faces).toBe(6);
        expect(measured.solid).toBe(true);
      } finally {
        plate.delete();
      }
    });

    it('z=100 の面の正側は「切った先に立体が残りません」で断る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, {
            origin: [20, 15, 100],
            normal: [0, 0, 1],
            keepPositive: true,
          }),
        ).toThrow('切った先に立体が残りません');
      } finally {
        plate.delete();
      }
    });

    it('上面にちょうど接する面(z=10)の正側も断る(厚み 0 の板を作らない)', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, {
            origin: [20, 15, 10],
            normal: [0, 0, 1],
            keepPositive: true,
          }),
        ).toThrow('切った先に立体が残りません');
      } finally {
        plate.delete();
      }
    });

    it('下面にちょうど接する面(z=0)の正側は、対象がそのまま残る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(
          cutAndMeasure(plate.shape, {
            origin: [20, 15, 0],
            normal: [0, 0, 1],
            keepPositive: true,
          }).volume,
        ).toBeCloseTo(PLATE_VOLUME, 6);
      } finally {
        plate.delete();
      }
    });
  });

  describe('入力の門番(OCCT を呼ぶ前に断る。FR-504、NFR-UX-5)', () => {
    it('法線の長さが 0 なら「切断面の向きを決められません。」', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, { origin: [20, 15, 5], normal: [0, 0, 0], keepPositive: true }),
        ).toThrow('切断面の向きを決められません。');
      } finally {
        plate.delete();
      }
    });

    it('法線が NaN なら日本語で断る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, {
            origin: [20, 15, 5],
            normal: [Number.NaN, 0, 1],
            keepPositive: true,
          }),
        ).toThrow('切断面の向きを決められません。');
      } finally {
        plate.delete();
      }
    });

    it('通る点が NaN なら日本語で断る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, {
            origin: [Number.NaN, 15, 5],
            normal: [0, 0, 1],
            keepPositive: true,
          }),
        ).toThrow('切断面の位置を決められません。');
      } finally {
        plate.delete();
      }
    });

    it('通る点が ∞ でも日本語で断る', () => {
      const plate = makeBox(oc, PLATE);
      try {
        expect(() =>
          makeCut(oc, plate.shape, {
            origin: [20, 15, Number.POSITIVE_INFINITY],
            normal: [0, 0, 1],
            keepPositive: true,
          }),
        ).toThrow('切断面の位置を決められません。');
      } finally {
        plate.delete();
      }
    });
  });

  describe('指紋の引き継ぎ(§0.a-0.62 / §0.a-0.63)', () => {
    /** 板に φ6 の貫通穴を 1 つあけた形。穴の中心は板の真ん中 `[20,15]`。 */
    function drilledPlate(): OcctShapeHandle {
      const plate = makeBox(oc, PLATE);
      try {
        // 上下へ 1mm ずつはみ出させて、面と面が正確に接する配置を避ける(P3 §0.a-0.12)。
        const drill = primitive([20, 15, -1], [0, 0, 1], {
          kind: 'cylinder',
          radius: 3,
          height: PLATE.dz + 2,
        });
        try {
          return booleanOp(oc, 'subtract', plate.shape, drill.shape);
        } finally {
          drill.delete();
        }
      } finally {
        plate.delete();
      }
    }

    it('切断の前にあけた φ6 の穴の円筒面が、切断の後も指紋で選び直せる', () => {
      const drilled = drilledPlate();
      try {
        const before = collectTables(drilled.shape);
        const cylinder = before.faces.find((face) => face.surfaceKind === 'cylinder');
        expect(cylinder).toBeDefined();
        if (cylinder === undefined) {
          return;
        }

        const cut = makeCut(oc, drilled.shape, {
          origin: [20, 15, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        try {
          const after = collectTables(cut.shape);
          const scale = boundingDiagonal(oc, cut.shape) * 0.5;
          const match = matchFace(after.faces, faceQuery(cylinder), scale);
          expect(match).not.toBeNull();
          if (match === null) {
            return;
          }
          console.log(
            `[実測 §0.a-0.63] 穴の円筒面の点: ${match.score.toFixed(3)}(しきい値 ${String(SUB_SHAPE_MATCH_THRESHOLD)})`,
          );
          expect(match.score).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
          // 選び直した先も円筒面である(平面へ飛び移っていない)。
          const chosen = after.faces.find((face) => face.index === match.index);
          expect(chosen?.surfaceKind).toBe('cylinder');
        } finally {
          cut.delete();
        }
      } finally {
        drilled.delete();
      }
    });

    it('切られて半分になった側面が、切断の後も指紋で選び直せる', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const before = collectTables(plate.shape);
        // y=0 の側面(面積 400、法線 [0,-1,0])。z=5 で切ると面積が半分になる。
        const side = before.faces.find(
          (face) => face.axis !== null && face.axis[1] < -0.9 && face.surfaceKind === 'plane',
        );
        expect(side).toBeDefined();
        if (side === undefined) {
          return;
        }
        expect(side.area).toBeCloseTo(400, 6);

        const cut = makeCut(oc, plate.shape, {
          origin: [20, 15, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        try {
          const after = collectTables(cut.shape);
          const scale = boundingDiagonal(oc, cut.shape) * 0.5;
          const match = matchFace(after.faces, faceQuery(side), scale);
          expect(match).not.toBeNull();
          if (match === null) {
            return;
          }
          const chosen = after.faces.find((face) => face.index === match.index);
          console.log(
            `[実測 §0.a-0.62] 半分になった側面の点: ${match.score.toFixed(3)}(面積 ${String(side.area)} → ${chosen?.area.toFixed(3) ?? '?'})`,
          );
          expect(match.score).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
          expect(chosen?.area).toBeCloseTo(200, 6);
        } finally {
          cut.delete();
        }
      } finally {
        plate.delete();
      }
    });

    /**
     * 切断面は「それまで存在しなかった面」なので、切断前のどの面の指紋を当てても選ばれない
     * (§0.a-0.62 の①。選ばれないから外観が付かず、既定の外観になる)。
     *
     * **平面の向きは `[1,1,1]/√3` を使う。** 板の重心を通るこの向きの断面は六角形になり、
     * 6 面のどれも消えずに残る。軸に平行な平面(z=5 など)で切ると、**消えた面**
     * (下面)と切断面が「同じ法線・同じ面積」になって指紋がそちらへ当たりうるので、
     * この検査には向かない(実測値は報告記録へ。§0.a-0.63 の「選び直しに失敗しやすい」の裏返し)。
     */
    it('切断面(新しい面)は、切断前のどの面の指紋でも選ばれない', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const before = collectTables(plate.shape);
        const normal = unit([1, 1, 1]);
        const cut = makeCut(oc, plate.shape, {
          origin: [20, 15, 5],
          normal,
          keepPositive: true,
        });
        try {
          const after = collectTables(cut.shape);
          const scale = boundingDiagonal(oc, cut.shape) * 0.5;
          // 切断面は、残す側から見て法線の逆を向く平面(六角形)。
          const cutFace = after.faces.find(
            (face) =>
              face.surfaceKind === 'plane' &&
              face.axis !== null &&
              face.axis[0] * normal[0] + face.axis[1] * normal[1] + face.axis[2] * normal[2] < -0.99,
          );
          expect(cutFace).toBeDefined();
          if (cutFace === undefined) {
            return;
          }

          for (const face of before.faces) {
            const match = matchFace(after.faces, faceQuery(face), scale);
            if (match !== null && match.index === cutFace.index) {
              console.log(
                `[実測 §0.a-0.62] 切断面へ当たった指紋: 面 ${String(face.index)}(点 ${match.score.toFixed(3)})`,
              );
            }
            expect(match?.index).not.toBe(cutFace.index);
          }
        } finally {
          cut.delete();
        }
      } finally {
        plate.delete();
      }
    });

    /**
     * 上の検査の裏側。**軸に平行な平面で切ると、消えた面の指紋が切断面へ当たる。**
     *
     * 板を `z=5` で切って上側を残すと、消える下面(法線 `[0,0,-1]`・面積 1200)と
     * 切断面(法線 `[0,0,-1]`・面積 1200)が、面積も向きも同じで位置だけ 5mm 違う面になる。
     * §2.2.3 の重みでは位置の差だけでは点が落ちきらず、切断面が選ばれる。
     *
     * これは §0.a-0.63 が「切断は下流の参照が選び直しに失敗しやすい」と書いている性質の
     * 裏返しで、**外観を割り当てた面が消えたとき、その色が切断面へ移ることがある**という
     * 実際の振る舞いである。仕組みは変えない(重みを触らない。§0.a-0.63 の承認)ので、
     * ここでは起きることを実測して固定し、統括とヘルプ(`cut.md`)へ回す。
     */
    it('軸に平行な平面で切ると、消えた下面の指紋が切断面へ当たる(実測の記録)', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const before = collectTables(plate.shape);
        const bottom = before.faces.find(
          (face) => face.surfaceKind === 'plane' && face.axis !== null && face.axis[2] < -0.9,
        );
        expect(bottom).toBeDefined();
        if (bottom === undefined) {
          return;
        }
        const cut = makeCut(oc, plate.shape, {
          origin: [20, 15, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        try {
          const after = collectTables(cut.shape);
          const scale = boundingDiagonal(oc, cut.shape) * 0.5;
          const match = matchFace(after.faces, faceQuery(bottom), scale);
          const chosen =
            match === null ? undefined : after.faces.find((face) => face.index === match.index);
          console.log(
            `[実測 §0.a-0.63] 消えた下面の指紋 → 面 ${String(match?.index ?? -1)}(点 ${match?.score.toFixed(3) ?? '—'}、重心 z ${chosen?.centroid[2].toFixed(3) ?? '—'})`,
          );
          expect(match).not.toBeNull();
          // 選ばれたのは切断面(z=5 の下向きの平面)である。
          expect(chosen?.centroid[2]).toBeCloseTo(5, 6);
        } finally {
          cut.delete();
        }
      } finally {
        plate.delete();
      }
    });

    /**
     * 種類の違う面へ飛び移らないことも押さえる(§2.2.3 の「候補は surfaceKind が一致するものだけ」)。
     * 球を切ると切断面は平らな円板だが、球面の指紋は平面を候補にしないので、
     * 何度切っても切断面が選ばれることはない。
     */
    it('球を切っても、球面の指紋は切断面(平らな円板)を選ばない', () => {
      const sphere = primitive([0, 0, 0], [0, 0, 1], { kind: 'sphere', radius: 10 });
      try {
        const before = collectTables(sphere.shape);
        const cut = makeCut(oc, sphere.shape, {
          origin: [0, 0, 5],
          normal: [0, 0, 1],
          keepPositive: true,
        });
        try {
          const after = collectTables(cut.shape);
          const scale = boundingDiagonal(oc, cut.shape) * 0.5;
          const disc = after.faces.find((face) => face.surfaceKind === 'plane');
          expect(disc).toBeDefined();
          for (const face of before.faces) {
            const match = matchFace(after.faces, faceQuery(face), scale);
            expect(match?.index).not.toBe(disc?.index);
          }
        } finally {
          cut.delete();
        }
      } finally {
        sphere.delete();
      }
    });
  });

  describe('所要(NFR-PF-2)', () => {
    it('切断 1 段の所要を実測する(上限 500ms)', () => {
      const plate = makeBox(oc, PLATE);
      try {
        const input: CutInput = { origin: [20, 15, 5], normal: [0, 0, 1], keepPositive: true };
        // 1 回目は WASM の暖機を含むので、3 回測って中央値で見る。
        const samples: number[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const startedAt = performance.now();
          const result = makeCut(oc, plate.shape, input);
          samples.push(performance.now() - startedAt);
          result.delete();
        }
        const sorted = [...samples].sort((left, right) => left - right);
        const median = sorted[1];
        console.log(
          `[実測 NFR-PF-2] 切断 1 段: ${samples.map((value) => value.toFixed(1)).join(' / ')} ms(中央値 ${median.toFixed(1)} ms、上限 ${String(SINGLE_STEP_BUDGET_MS)} ms)`,
        );
        expectWithinBudget(median, SINGLE_STEP_BUDGET_MS, '切断 1 段');
      } finally {
        plate.delete();
      }
    });
  });
});
