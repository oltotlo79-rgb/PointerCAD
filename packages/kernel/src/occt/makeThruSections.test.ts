import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, ThruSectionSpec, ThruSectionsStepSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeThruSections } from './makeThruSections.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { tangentPointOnSphere } from './sphereTangent.js';

let oc: OpenCascadeInstance;

beforeAll(async () => {
  oc = await loadOcctForNode();
}, 180_000);

/** 単一フィーチャーの上限(NFR-PF-2)。この段は上限の中に収まっていることを確かめる。 */
const SINGLE_FEATURE_BUDGET_MS = 500;

/**
 * 性能上限の判定を「厳密」と「参考」で切り替える窓口。
 * 決めと理由は packages/kernel/src/worker/solidPerformance.test.ts の
 * expectWithinBudget と同じ(rules/03-品質ゲート.md §7.1、rules/06 の 10.3)。
 * 上限の数値は変えない。
 *
 * **t42 で `src/testUtils/` へ 1 本にまとめる**(いまは makeRib / makeShell / makeCut
 * などの検査ごとに同じ関数が並んでいる。統括の決定 2026-09-05)。
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

/**
 * (a) 軸対称の罫線立体の体積(球 r=10、円 r=20、距離 30)。
 *
 * **計画書 §2.9.3 の値をそのまま信じず、担当が独立に解き直した値**
 * (`docs/報告記録.md` 2026-09-03 23:40 の②の対策)。
 * `(a²−r²)z₀² − 2r²h·z₀ − r²(a²+h²) = 0` の正の解 z₀ = 33.094010767585026 から
 * 接触円(中心 z = 3.021694792519623、半径 9.532542188779432)を出し、
 * 円錐台 π/3·(3.021694792519623+30)·(9.532542188779432² + 9.532542188779432·20 + 400)
 * = 23567.130816037534 と、球冠 π·h²(3r−h)/3(h = 10 − 3.021694792519623)
 * = 1173.993872522489 を足したもの。計画書の 24741.124688560002 とは 2e-15 しか違わない。
 */
const AXIAL_SPHERE_VOLUME = 24741.124688560023;

/** 断面 1 つを組み立てる小さな道具。 */
function curvesSection(curves: readonly CurveSpec[]): ThruSectionSpec {
  return { kind: 'curves', curves };
}

function sphereSection(center: Vec3Tuple, radius: number): ThruSectionSpec {
  return { kind: 'sphere', center, radius };
}

/** 長方形の輪郭(z の高さに置く)。線分 4 本で、並びは反時計回り。 */
function rectangle(width: number, depth: number, z: number): readonly CurveSpec[] {
  const corners: Vec3Tuple[] = [
    [-width / 2, -depth / 2, z],
    [width / 2, -depth / 2, z],
    [width / 2, depth / 2, z],
    [-width / 2, depth / 2, z],
  ];
  return corners.map((from, index) => ({
    kind: 'segment',
    from,
    to: corners[(index + 1) % corners.length],
  }));
}

/** 全周の円の輪郭。`makeThruSections` はこの形を見て (a) の経路を選ぶ。 */
function circle(center: Vec3Tuple, radius: number, normal: Vec3Tuple = [0, 0, 1]): readonly CurveSpec[] {
  return [
    {
      kind: 'arc',
      center,
      normal,
      xAxis: [1, 0, 0],
      radius,
      startAngle: 0,
      endAngle: 2 * Math.PI,
    },
  ];
}

/** 同じ円を 4 本の円弧で描いたもの。全周 1 本ではないので (b) の経路が選ばれる。 */
function quarteredCircle(center: Vec3Tuple, radius: number): readonly CurveSpec[] {
  return [0, 1, 2, 3].map((quarter) => ({
    kind: 'arc',
    center,
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius,
    startAngle: (quarter * Math.PI) / 2,
    endAngle: ((quarter + 1) * Math.PI) / 2,
  }));
}

function spec(
  sections: readonly ThruSectionSpec[],
  overrides: Partial<Omit<ThruSectionsStepSpec, 'kind' | 'sections'>> = {},
): ThruSectionsStepSpec {
  return { kind: 'thruSections', sections, ruled: true, closed: true, twist: 0, ...overrides };
}

/** 面の枚数。三角形分割を要らないので `collectSubShapes` ではなく直に数える。 */
function faceCount(shape: TopoDS_Shape): number {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let count = 0;
    const size = Number(map.Size());
    for (let index = 1; index <= size; index += 1) {
      if (map.FindKey(index).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
        count += 1;
      }
    }
    return count;
  } finally {
    map.delete();
  }
}

/** 境界箱(mm)。`makePrimitive.test.ts` と同じ取り方。 */
function boundingBox(shape: TopoDS_Shape): { readonly min: Vec3Tuple; readonly max: Vec3Tuple } {
  const box = new oc.Bnd_Box_1();
  try {
    oc.BRepBndLib.Add(shape, box, false);
    box.SetGap(0);
    const low = box.CornerMin();
    const high = box.CornerMax();
    const result = {
      min: [low.X(), low.Y(), low.Z()] as Vec3Tuple,
      max: [high.X(), high.Y(), high.Z()] as Vec3Tuple,
    };
    low.delete();
    high.delete();
    return result;
  } finally {
    box.delete();
  }
}

/** 作って測って片づける。検査ごとに形を持ち回らずに済ませるための道具。 */
function withSolid<T>(step: ThruSectionsStepSpec, read: (shape: TopoDS_Shape) => T): T {
  const handle = makeThruSections(oc, step);
  try {
    return read(handle.shape);
  } finally {
    handle.delete();
  }
}

describe('makeThruSections(輪郭どうし。§2.9.2)', () => {
  it('長方形 40×30 → 20×15、高さ 10 の体積は 7000', () => {
    const volume = withSolid(
      spec([curvesSection(rectangle(40, 30, 0)), curvesSection(rectangle(20, 15, 10))]),
      (shape) => {
        expect(hasSolid(oc, shape)).toBe(true);
        expect(isValidShape(oc, shape)).toBe(true);
        expect(faceCount(shape)).toBe(6);
        return measureVolume(oc, shape);
      },
    );
    // ∫₀¹ (40−20t)(30−15t) dt × 10 = 10(1200−600+100)
    expect(volume).toBeCloseTo(7000, 6);
  });

  it('同じ大きさの長方形どうし(40×30 → 40×30、高さ 10)は角柱で 12000', () => {
    const volume = withSolid(
      spec([curvesSection(rectangle(40, 30, 0)), curvesSection(rectangle(40, 30, 10))]),
      (shape) => measureVolume(oc, shape),
    );
    expect(volume).toBeCloseTo(12000, 6);
  });

  it('円 r=10 → r=5、高さ 20 を直線で結ぶと円錐台の体積になる', () => {
    const volume = withSolid(
      spec([curvesSection(circle([0, 0, 0], 10)), curvesSection(circle([0, 0, 20], 5))]),
      (shape) => {
        expect(faceCount(shape)).toBe(3);
        return measureVolume(oc, shape);
      },
    );
    // π·20/3·(10² + 10·5 + 5²)
    expect(volume).toBeCloseTo((Math.PI * 20) / 3 * (100 + 50 + 25), 6);
  });

  it('同じ入力をロフト(ruled = false)で作っても体積は変わらない', () => {
    const ruledVolume = withSolid(
      spec([curvesSection(circle([0, 0, 0], 10)), curvesSection(circle([0, 0, 20], 5))]),
      (shape) => measureVolume(oc, shape),
    );
    const loftVolume = withSolid(
      spec([curvesSection(circle([0, 0, 0], 10)), curvesSection(circle([0, 0, 20], 5))], {
        ruled: false,
      }),
      (shape) => measureVolume(oc, shape),
    );
    // 円が 2 つだけなら、なめらかに結んでも直線で結ぶ以外に道が無い。
    expect(loftVolume).toBeCloseTo(ruledVolume, 6);
  });

  it('ひねりを 1 つずらすと形(体積)が変わる', () => {
    const straight = withSolid(
      spec([curvesSection(rectangle(40, 30, 0)), curvesSection(rectangle(40, 30, 10))]),
      (shape) => measureVolume(oc, shape),
    );
    const twisted = withSolid(
      spec([curvesSection(rectangle(40, 30, 0)), curvesSection(rectangle(40, 30, 10))], {
        twist: 1,
      }),
      (shape) => {
        expect(hasSolid(oc, shape)).toBe(true);
        return measureVolume(oc, shape);
      },
    );
    console.log(`ひねり 0 の体積 ${straight} / ひねり 1 の体積 ${twisted}`);
    expect(twisted).not.toBeCloseTo(straight, 3);
    expect(twisted).toBeGreaterThan(0);
  });

  it('断面が 1 つだけなら「つなぐ面を 2 つ」と断る', () => {
    expect(() => makeThruSections(oc, spec([curvesSection(rectangle(40, 30, 0))]))).toThrow(
      /つなぐ面を 2 つ/,
    );
  });

  it('閉じていない輪郭は断る', () => {
    const open: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
      { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
    ];
    expect(() =>
      makeThruSections(oc, spec([curvesSection(open), curvesSection(rectangle(20, 15, 10))])),
    ).toThrow(/閉じている必要があります/);
  });

  it('ひねりの数が整数でなければ断る', () => {
    expect(() =>
      makeThruSections(
        oc,
        spec([curvesSection(rectangle(40, 30, 0)), curvesSection(rectangle(20, 15, 10))], {
          twist: 1.5,
        }),
      ),
    ).toThrow(/整数/);
  });
});

describe('makeThruSections(球へ・軸対称。§2.9.3-(a))', () => {
  const axial = spec([
    sphereSection([0, 0, 0], 10),
    curvesSection(circle([0, 0, -30], 20)),
  ]);

  it('球 r=10 と 円 r=20 @ z=−30 の体積が手計算と 0.1% 以内で一致する', () => {
    const volume = withSolid(axial, (shape) => measureVolume(oc, shape));
    console.log(
      `(a) 体積 実測 ${volume} / 手計算 ${AXIAL_SPHERE_VOLUME} 相対差 ${(((volume - AXIAL_SPHERE_VOLUME) / AXIAL_SPHERE_VOLUME) * 100).toFixed(6)}%`,
    );
    expect(Math.abs(volume - AXIAL_SPHERE_VOLUME) / AXIAL_SPHERE_VOLUME).toBeLessThan(0.001);
  });

  it('閉じた立体になり、面は 3 枚(円錐台の側面・球冠・輪郭の面)', () => {
    withSolid(axial, (shape) => {
      expect(hasSolid(oc, shape)).toBe(true);
      expect(isValidShape(oc, shape)).toBe(true);
      const faces = faceCount(shape);
      const box = boundingBox(shape);
      console.log(
        `(a) 面の数 ${faces} 境界箱 [${box.min.map((v) => v.toFixed(4)).join(',')}]〜[${box.max.map((v) => v.toFixed(4)).join(',')}]`,
      );
      expect(faces).toBe(3);
      // 球の頂(z = +10)から輪郭の平面(z = −30)まで、半径 20 の円が入る大きさ。
      expect(box.max[2]).toBeCloseTo(10, 6);
      expect(box.min[2]).toBeCloseTo(-30, 6);
      expect(box.max[0]).toBeCloseTo(20, 6);
    });
  });

  it('1 段の所要が 500ms(NFR-PF-2)に収まる', () => {
    const started = performance.now();
    withSolid(axial, (shape) => measureVolume(oc, shape));
    const elapsed = performance.now() - started;
    console.log(`(a) 1 段の所要 ${elapsed.toFixed(1)}ms`);
    expectWithinBudget(elapsed, SINGLE_FEATURE_BUDGET_MS, '罫線立体(a)1 段');
  });
});

describe('makeThruSections(球へ・一般の輪郭。§2.9.3-(b))', () => {
  /** 中心が球の真下に無い輪郭。(a) の経路では断られ、(b) の経路で成り立つ。 */
  const general = spec([
    sphereSection([0, 0, 0], 10),
    curvesSection(circle([5, 0, -20], 8)),
  ]);

  it('軸から外れた輪郭でも断られずに立体ができる', () => {
    withSolid(general, (shape) => {
      expect(hasSolid(oc, shape)).toBe(true);
      expect(isValidShape(oc, shape)).toBe(true);
      const volume = measureVolume(oc, shape);
      const faces = faceCount(shape);
      const box = boundingBox(shape);
      console.log(
        `(b) 体積 ${volume} 面の数 ${faces} 境界箱 [${box.min.map((v) => v.toFixed(4)).join(',')}]〜[${box.max.map((v) => v.toFixed(4)).join(',')}]`,
      );
      expect(volume).toBeGreaterThan(1e-9);
      // 球(半径 10)と輪郭の平面(z = −20)を含む大きさになる。
      expect(box.min[2]).toBeCloseTo(-20, 6);
      expect(box.max[0]).toBeCloseTo(13, 6);
      expect(box.max[2]).toBeGreaterThan(9.9);
    });
  });

  it('輪郭の各点から求めた接点がすべて球面の上にある', () => {
    const center: Vec3Tuple = [0, 0, 0];
    const radius = 10;
    let checked = 0;
    for (let index = 0; index < 72; index += 1) {
      const angle = (2 * Math.PI * index) / 72;
      const point: Vec3Tuple = [5 + 8 * Math.cos(angle), 8 * Math.sin(angle), -20];
      const tangent = tangentPointOnSphere(center, radius, [0, 0, 1], point);
      expect(tangent).not.toBeNull();
      if (tangent === null) {
        continue;
      }
      expect(Math.hypot(tangent[0], tangent[1], tangent[2])).toBeCloseTo(radius, 6);
      // 接線であること: (T − C)·(T − P) = 0。
      const dot =
        tangent[0] * (tangent[0] - point[0]) +
        tangent[1] * (tangent[1] - point[1]) +
        tangent[2] * (tangent[2] - point[2]);
      expect(dot).toBeCloseTo(0, 6);
      checked += 1;
    }
    expect(checked).toBe(72);
  });

  it('1 段の所要が 500ms(NFR-PF-2)に収まる', () => {
    const started = performance.now();
    withSolid(general, (shape) => measureVolume(oc, shape));
    const elapsed = performance.now() - started;
    console.log(`(b) 1 段の所要 ${elapsed.toFixed(1)}ms`);
    expectWithinBudget(elapsed, SINGLE_FEATURE_BUDGET_MS, '罫線立体(b)1 段');
  });

  it('軸対称の入力を (b) の経路で作っても (a) の値に近い体積になる', () => {
    // 同じ円を 4 本の円弧で描くと「全周 1 本」ではなくなるので (b) の経路へ入る。
    const volume = withSolid(
      spec([sphereSection([0, 0, 0], 10), curvesSection(quarteredCircle([0, 0, -30], 20))]),
      (shape) => {
        expect(hasSolid(oc, shape)).toBe(true);
        expect(isValidShape(oc, shape)).toBe(true);
        return measureVolume(oc, shape);
      },
    );
    const ratio = (volume - AXIAL_SPHERE_VOLUME) / AXIAL_SPHERE_VOLUME;
    console.log(`(b) の経路での軸対称の体積 ${volume} 相対差 ${(ratio * 100).toFixed(3)}%`);
    // 輪郭を内接多角形で近似するぶんだけ必ず少なめに出る(24 点で −0.91% の理屈値)。
    expect(ratio).toBeLessThan(0);
    expect(Math.abs(ratio)).toBeLessThan(0.02);
  });
});

describe('makeThruSections(球へ・断り。§2.9.3 の表)', () => {
  it('球どうしは断る', () => {
    expect(() =>
      makeThruSections(oc, spec([sphereSection([0, 0, 0], 10), sphereSection([0, 0, 40], 10)])),
    ).toThrow(/球どうしを/);
  });

  it('輪郭の平面が球を切っているときは断る(円 r=20 @ z=−5、球 r=10)', () => {
    expect(() =>
      makeThruSections(
        oc,
        spec([sphereSection([0, 0, 0], 10), curvesSection(circle([0, 0, -5], 20))]),
      ),
    ).toThrow(/丸い輪郭の中心が/);
  });

  it('輪郭が球の中にあるときは断る', () => {
    expect(() =>
      makeThruSections(
        oc,
        spec([sphereSection([0, 0, 0], 10), curvesSection(circle([0, 0, -2], 3))]),
      ),
    ).toThrow(/丸い輪郭の中心が/);
  });

  it('球に輪郭を 2 つつなごうとしたら断る', () => {
    expect(() =>
      makeThruSections(
        oc,
        spec([
          sphereSection([0, 0, 0], 10),
          curvesSection(circle([0, 0, -30], 20)),
          curvesSection(circle([0, 0, 30], 20)),
        ]),
      ),
    ).toThrow(/球とつなげる輪郭は 1 つだけ/);
  });

  it('球の半径が 0 以下なら断る', () => {
    expect(() =>
      makeThruSections(
        oc,
        spec([sphereSection([0, 0, 0], 0), curvesSection(circle([0, 0, -30], 20))]),
      ),
    ).toThrow(/球の半径は/);
  });
});
