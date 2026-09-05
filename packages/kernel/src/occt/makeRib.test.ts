import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { CurveSpec } from '../types.js';
import { booleanOp } from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import type { RibInput } from './makeRib.js';
import { makeRib } from './makeRib.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/**
 * リブ(FR-420、計画書 P5 タスク38)の検査。
 *
 * 相手はいつも 40 × 30 × 10 の板(原点から x 40 / y 30 / z 10、体積 12000 mm³)。
 * 輪郭は板の**上の空中**に置き、下向き(−Z)へ伸ばして板に当てる。
 * リブが足す材料は「輪郭と板の間の空間」なので、期待値は
 * 「板の体積 12000 + 壁の体積」で手計算できる。
 */

/** 相手の板の体積(mm³)。40 × 30 × 10。 */
const PLATE_VOLUME = 12000;

/** 板の上面の高さ(mm)。 */
const PLATE_TOP_Z = 10;

/** 輪郭を置く高さ(mm)。板の上面から 20 mm 上。 */
const PROFILE_Z = 30;

/** 板を x 方向に横切る長さ 40 の線(y = 15、z = 30)。指示書の例。 */
const LINE_ACROSS: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 15, PROFILE_Z], to: [40, 15, PROFILE_Z] },
];

/** 計画書の検証表の例。長さ 20 の線を板の上面から 10 mm 上(z = 20)に置く。 */
const LINE_SHORT: readonly CurveSpec[] = [
  { kind: 'segment', from: [10, 15, 20], to: [30, 15, 20] },
];

/**
 * 段のある開いた輪郭(水平 20 mm → 斜め)。
 * 伸ばす向き(−Z)と平行な辺を持たないので、どの辺も潰れずに壁になる。
 */
const STEP_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 15, PROFILE_Z], to: [20, 15, PROFILE_Z] },
  { kind: 'segment', from: [20, 15, PROFILE_Z], to: [35, 15, 20] },
];

/**
 * 円弧の輪郭。中心 (20, 15, 10)・半径 10 の円を y = 15 の平面(XZ 面)に置き、
 * 30 度から 90 度までを使う。始点 (28.660254…, 15, 15)、終点 (20, 15, 20)。
 * 法線を (0, −1, 0)、第 1 軸を (1, 0, 0) にすると第 2 軸が +Z になり、
 * 角 θ の点が (20 + 10cosθ, 15, 10 + 10sinθ) になる。
 */
const ARC_PROFILE: readonly CurveSpec[] = [
  {
    kind: 'arc',
    center: [20, 15, PLATE_TOP_Z],
    normal: [0, -1, 0],
    xAxis: [1, 0, 0],
    radius: 10,
    startAngle: Math.PI / 6,
    endAngle: Math.PI / 2,
  },
];

/** 板に届かない位置(y = 50)に置いた線。板は y = 30 までしかない。 */
const LINE_BESIDE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 50, PROFILE_Z], to: [40, 50, PROFILE_Z] },
];

/** 板の中(z = 5)に置いた線。 */
const LINE_INSIDE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 15, 5], to: [40, 15, 5] },
];

/** つながっていない 2 本の線。 */
const BROKEN_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 15, PROFILE_Z], to: [10, 15, PROFILE_Z] },
  { kind: 'segment', from: [20, 15, PROFILE_Z], to: [30, 15, PROFILE_Z] },
];

/** 指示書の例の壁: 長さ 40 × 厚み 2 × 高さ 20 = 1600 mm³。 */
const WALL_VOLUME = 1600;

/** 計画書の例の壁: 長さ 20 × 厚み 3 × 高さ 10 = 600 mm³。 */
const SHORT_WALL_VOLUME = 600;

/**
 * 段のある輪郭が足す体積 1250 mm³。
 *   水平の部分: 長さ 20 × 高さ (30 − 10) × 厚み 2 = 800
 *   斜めの部分: x = 20 → 35 で高さが 20 → 10 に減る台形
 *              (20 + 10) / 2 × 15 × 厚み 2 = 450
 */
const STEP_WALL_VOLUME = 1250;

/**
 * 円弧の輪郭が足す体積 148.02102530888172 mm³。
 *
 * 円弧の下(高さ z(x) = 10 + √(100 − (x − 20)²))から板の上面 z = 10 までの面積は
 *   ∫₀^{10sin60°} √(100 − u²) du = [u√(100 − u²)/2 + 50·asin(u/10)]
 *     = 8.660254037844387 × 5 / 2 + 50 × π/3 = 74.01051265444086 mm²
 * これに厚み 2 を掛ける。
 */
const ARC_WALL_VOLUME = 148.02102530888172;

/** リブ 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)の数値そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

/** 指示書の例のリブ(両側・厚み 2・下向き)。 */
const RIB_ACROSS: RibInput = {
  profile: LINE_ACROSS,
  normal: [0, 1, 0],
  thickness: 2,
  symmetric: true,
  direction: [0, 0, -1],
};

/** 依頼を 1 か所だけ差し替える。 */
function withInput(base: RibInput, patch: Partial<RibInput>): RibInput {
  return { ...base, ...patch };
}

describe('リブ(FR-420)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 40 × 30 × 10 の板を作り、渡した手続きへ貸す(必ず解放する)。 */
  function withPlate(body: (plate: OcctShapeHandle) => void): void {
    const plate = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      body(plate);
    } finally {
      plate.delete();
    }
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

  it('開いた線に厚みを付けて板まで伸ばし、和を取る(体積 13600)', () => {
    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, RIB_ACROSS);
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + WALL_VOLUME, 6);
        expect(measureVolume(oc, result.shape)).toBeCloseTo(PLATE_VOLUME + WALL_VOLUME, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    });
  });

  it('体積は対象より大きくなる(材料を足す加工なので増えるのが正しい)', () => {
    withPlate((plate) => {
      const before = measureVolume(oc, plate.shape);
      const result = makeRib(oc, plate.shape, RIB_ACROSS);
      try {
        expect(before).toBeCloseTo(PLATE_VOLUME, 6);
        expect(result.volume).toBeGreaterThan(before);
        // 対象の板そのものは変わらない(リブは複製系ではなく、引数に触れない)。
        expect(measureVolume(oc, plate.shape)).toBeCloseTo(PLATE_VOLUME, 6);
      } finally {
        result.delete();
      }
    });
  });

  it('両側に付けると、足した壁が法線の両側へ半分ずつ広がる', () => {
    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, RIB_ACROSS);
      try {
        // 足した部分だけを取り出して測る(結果 − 板)。
        const added = booleanOp(oc, 'subtract', result.shape, plate.shape);
        try {
          expect(added.volume).toBeCloseTo(WALL_VOLUME, 6);
          const bounds = boundsOf(added.shape);
          expect(bounds[0]).toBeCloseTo(0, 6);
          expect(bounds[1]).toBeCloseTo(14, 6);
          expect(bounds[2]).toBeCloseTo(PLATE_TOP_Z, 6);
          expect(bounds[3]).toBeCloseTo(40, 6);
          expect(bounds[4]).toBeCloseTo(16, 6);
          expect(bounds[5]).toBeCloseTo(PROFILE_Z, 6);
        } finally {
          added.delete();
        }
      } finally {
        result.delete();
      }
    });
  });

  it('片側に付けると、足した壁が法線の側だけへ広がる(体積は同じ)', () => {
    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, withInput(RIB_ACROSS, { symmetric: false }));
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + WALL_VOLUME, 6);
        const added = booleanOp(oc, 'subtract', result.shape, plate.shape);
        try {
          expect(added.volume).toBeCloseTo(WALL_VOLUME, 6);
          const bounds = boundsOf(added.shape);
          expect(bounds[1]).toBeCloseTo(15, 6);
          expect(bounds[4]).toBeCloseTo(17, 6);
        } finally {
          added.delete();
        }
      } finally {
        result.delete();
      }
    });
  });

  it('計画書の例(長さ 20・高さ 10・厚み 3)で体積 12600 になる', () => {
    withPlate((plate) => {
      const result = makeRib(
        oc,
        plate.shape,
        withInput(RIB_ACROSS, { profile: LINE_SHORT, thickness: 3 }),
      );
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + SHORT_WALL_VOLUME, 6);
      } finally {
        result.delete();
      }
    });
  });

  it('同じ例を片側に付けても体積は 12600(厚みの総和が同じ)', () => {
    withPlate((plate) => {
      const result = makeRib(
        oc,
        plate.shape,
        withInput(RIB_ACROSS, { profile: LINE_SHORT, thickness: 3, symmetric: false }),
      );
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + SHORT_WALL_VOLUME, 6);
      } finally {
        result.delete();
      }
    });
  });

  it('段のある輪郭では、辺ごとに材料までの高さが変わる(体積 13250)', () => {
    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: STEP_PROFILE }));
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + STEP_WALL_VOLUME, 6);
        expect(isValidShape(oc, result.shape)).toBe(true);
        expect(hasSolid(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    });
  });

  it('円弧の輪郭でも、円弧の下が材料で埋まる(体積 12148.02102530888)', () => {
    // 期待値そのものを積分の式で検算する(∫₀^a √(r² − u²) du)。
    const half = 10 * Math.sin(Math.PI / 3);
    const area = (half * Math.sqrt(100 - half * half)) / 2 + 50 * Math.asin(half / 10);
    expect(ARC_WALL_VOLUME).toBeCloseTo(area * 2, 9);

    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: ARC_PROFILE }));
      try {
        expect(result.volume).toBeCloseTo(PLATE_VOLUME + ARC_WALL_VOLUME, 6);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    });
  });

  it('面の数は 12 になる(板 7 + 壁 5)', () => {
    withPlate((plate) => {
      const result = makeRib(oc, plate.shape, RIB_ACROSS);
      try {
        // 板の上面が壁の足もとで 2 つに割れて 7 枚、壁は側面 2・端 2・上面 1 で 5 枚。
        expect(countFaces(result.shape)).toBe(12);
      } finally {
        result.delete();
      }
    });
  });

  it('板に届かない位置の輪郭は断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: LINE_BESIDE }))).toThrow(
        'リブが立体に届いていません。位置を見直してください。',
      );
    });
  });

  it('板の中にある輪郭は断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: LINE_INSIDE }))).toThrow(
        'リブの輪郭が立体の中にあります。',
      );
    });
  });

  it('厚み 0 は断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { thickness: 0 }))).toThrow(
        '厚みは 0 より大きい数にしてください。',
      );
    });
  });

  it('負の厚みも断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { thickness: -2 }))).toThrow(
        '厚みは 0 より大きい数にしてください。',
      );
    });
  });

  it('輪郭が空なら断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: [] }))).toThrow(
        'リブの輪郭が選ばれていません。',
      );
    });
  });

  it('つながっていない輪郭は断る', () => {
    withPlate((plate) => {
      expect(() =>
        makeRib(oc, plate.shape, withInput(RIB_ACROSS, { profile: BROKEN_PROFILE })),
      ).toThrow('つながっていない');
    });
  });

  it('伸ばす向きが厚みの向きと同じなら断る(壁が潰れる)', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { direction: [0, 1, 0] }))).toThrow(
        'リブに厚みが出ませんでした。',
      );
    });
  });

  it('向きの長さが 0 なら断る', () => {
    withPlate((plate) => {
      expect(() => makeRib(oc, plate.shape, withInput(RIB_ACROSS, { normal: [0, 0, 0] }))).toThrow(
        'リブの向きが決まりません。',
      );
    });
  });

  it('1 段の所要が 500ms 未満', () => {
    withPlate((plate) => {
      const startedAt = performance.now();
      const result = makeRib(oc, plate.shape, RIB_ACROSS);
      const elapsedMs = performance.now() - startedAt;
      result.delete();
      console.log(
        `リブ 1 段: 実測 ${elapsedMs.toFixed(1)} ms(上限 ${String(SINGLE_STEP_BUDGET_MS)} ms)`,
      );
      expectWithinBudget(elapsedMs, SINGLE_STEP_BUDGET_MS, 'リブ 1 段');
    });
  });
});
