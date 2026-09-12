import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type {
  CurveSpec,
  SphereSegmentCount,
  SubShapeQuery,
  ThruSectionSpec,
  ThruSectionsStepSpec,
  Vec3Tuple,
} from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { checkSphereSegments, makeThruSections } from './makeThruSections.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { tangentPointOnSphere } from './sphereTangent.js';
import { tessellate } from './tessellate.js';

let oc: OpenCascadeInstance;

beforeAll(async () => {
  oc = await loadOcctForNode();
}, 180_000);

/** 単一フィーチャーの上限(NFR-PF-2)。この段は上限の中に収まっていることを確かめる。 */
const SINGLE_FEATURE_BUDGET_MS = 500;

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
  return {
    kind: 'thruSections', smooth: false,
    sections,
    ruled: true,
    closed: true,
    twist: 0,
    // 既定は model 側と同じ 24(§0.a-0.74)。細かさを見る検査だけが上書きする。
    sphereSegments: 24,
    ...overrides,
  };
}

/**
 * 立体の面を輪郭にする断面(§0.a-0.73、タスク24b)。
 *
 * このファイルの検査は輪郭のワイヤを `makeThruSections` へ直に渡すので、
 * `targetKey` と指紋は使われない(選び直しは `worker/recomputeSolids.ts` の役目で、
 * その筋道は `recomputeSolids.test.ts` が端から端まで確かめる)。
 */
function faceSection(): ThruSectionSpec {
  const query: Extract<SubShapeQuery, { kind: 'face' }> = {
    kind: 'face',
    index: 0,
    surfaceKind: 'plane',
    area: 1200,
    position: [0, 0, 10],
    axis: [0, 0, 1],
    radius: null,
  };
  return { kind: 'faceQuery', targetKey: 'key-plate', query };
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

describe('makeThruSections(立体の面を輪郭にする。§0.a-0.73、タスク24b)', () => {
  it('面の外周を取り出す API が束縛されている(loadOcct.node.test.ts と同じ確かめ方)', () => {
    // 静的メソッドは呼ばずに参照すると @typescript-eslint/unbound-method が働くため、
    // 同じ判定を typeof で書く(loadOcct.node.test.ts の書き方に合わせる)。
    console.log(
      `BRepTools.OuterWire: ${typeof oc.BRepTools.OuterWire} / ` +
        `ShapeAnalysis.OuterWire: ${typeof oc.ShapeAnalysis.OuterWire} / ` +
        `BRepTools.IsReallyClosed: ${typeof oc.BRepTools.IsReallyClosed} / ` +
        `BRep_Tool.Degenerated: ${typeof oc.BRep_Tool.Degenerated}`,
    );
    expect(typeof oc.BRepTools.OuterWire).toBe('function');
    expect(typeof oc.BRepTools.IsReallyClosed).toBe('function');
    expect(typeof oc.BRep_Tool.Degenerated).toBe('function');
  });

  it('平らな面の外周と矩形をつなぐと、ロフトの台形則どおり 14000 mm³ になる', () => {
    const { keep, release } = createAllocations();
    try {
      // 箱 40×30×10 の上面(z = 10)と同じ平面の面を作り、その外周を輪郭にする。
      const face = keep(makePlanarFace(oc, rectangle(40, 30, 10))).face;
      const wire = keep(oc.BRepTools.OuterWire(face));
      const handle = makeThruSections(
        oc,
        spec([faceSection(), curvesSection(rectangle(20, 15, 30))]),
        {},
        new Map([[0, wire]]),
      );
      try {
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(isValidShape(oc, handle.shape)).toBe(true);
        const volume = measureVolume(oc, handle.shape);
        // h/3 ×(A1 + A2 + √(A1·A2))= 20/3 ×(1200 + 300 + 600)= 14000。
        console.log(`面の外周 → 矩形の体積 ${volume}(手計算 14000)`);
        expect(Math.abs(volume - 14000) / 14000).toBeLessThan(1e-6);
      } finally {
        handle.delete();
      }
    } finally {
      release();
    }
  });

  it('面の輪郭が渡されていなければ、選び直しを促して断る', () => {
    expect(() =>
      makeThruSections(oc, spec([faceSection(), curvesSection(rectangle(20, 15, 30))])),
    ).toThrow(/つなぐ面が見つかりません/);
  });
});

describe('makeThruSections(球へつなぐ分割数 sphereSegments。§0.a-0.74)', () => {
  const CHOICES: readonly SphereSegmentCount[] = [24, 48, 72];

  it('24 / 48 / 72 以外の分割数は断る', () => {
    expect(() => {
      checkSphereSegments(36);
    }).toThrow(/24・48・72/);
    expect(() => {
      checkSphereSegments(0);
    }).toThrow(/24・48・72/);
    // 3 択の値はどれも通る(段の既定 24 を含む)。
    for (const segments of CHOICES) {
      expect(() => {
        checkSphereSegments(segments);
      }).not.toThrow();
    }
  });

  it('分割を細かくするほど、軸対称の検算 24741.124688560023 へ近づく', () => {
    /** 分割数ごとの体積(同じ円を 4 本の円弧で描いて (b) の経路へ入れる)。 */
    const volumes = CHOICES.map((segments) => {
      const volume = withSolid(
        spec([sphereSection([0, 0, 0], 10), curvesSection(quarteredCircle([0, 0, -30], 20))], {
          sphereSegments: segments,
        }),
        (shape) => {
          expect(hasSolid(oc, shape)).toBe(true);
          expect(isValidShape(oc, shape)).toBe(true);
          return measureVolume(oc, shape);
        },
      );
      const ratio = (volume - AXIAL_SPHERE_VOLUME) / AXIAL_SPHERE_VOLUME;
      console.log(
        `分割 ${segments}: 体積 ${volume.toFixed(6)} 相対差 ${(ratio * 100).toFixed(4)}%`,
      );
      return volume;
    });

    // 輪郭を内接多角形で近似するので必ず少なめに出て、細かくするほど厳密値へ近づく。
    for (const volume of volumes) {
      expect(volume).toBeLessThan(AXIAL_SPHERE_VOLUME);
    }
    expect(volumes[0]).toBeLessThan(volumes[1]);
    expect(volumes[1]).toBeLessThan(volumes[2]);
  });

  it('t24 と同じ配置(球 r10 + 円 r8 @ (5,0,−20))で 3 通りの所要・三角形の数を実測する', () => {
    // Preserve the accepted surface while optimizing the builder. In particular,
    // disabling cap compatibility changes its fitted geometry at all resolutions.
    const acceptedVolumes = { 24: 6975.920596, 48: 7072.168197, 72: 7090.318721 };
    for (const segments of CHOICES) {
      const started = performance.now();
      const handle = makeThruSections(
        oc,
        spec([sphereSection([0, 0, 0], 10), curvesSection(circle([5, 0, -20], 8))], {
          sphereSegments: segments,
        }),
      );
      try {
        const elapsed = performance.now() - started;
        const volume = measureVolume(oc, handle.shape);
        const triangles = tessellate(oc, handle.shape).indices.length / 3;
        console.log(
          `分割 ${segments}: 所要 ${elapsed.toFixed(1)}ms 三角形 ${triangles} 枚 体積 ${volume.toFixed(6)}`,
        );
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(volume).toBeGreaterThan(1e-9);
        expect(Math.abs(volume - acceptedVolumes[segments]) / acceptedVolumes[segments])
          .toBeLessThanOrEqual(1e-6);
      } finally {
        handle.delete();
      }
    }
  });
});
