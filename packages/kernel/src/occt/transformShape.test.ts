import { beforeAll, describe, expect, it } from 'vitest';

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  gp_Trsf,
} from 'opencascade.js/dist/opencascade.full.js';

import type { RigidTransformSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';
import {
  IDENTITY_TRANSFORM,
  applyTransformToDirection,
  applyTransformToPoint,
  isIdentityTransform,
  makeCompound,
  makeMirrorTransform,
  mirrorShape,
  scaleShape,
  transformShape,
  transformsOrIdentity,
} from './transformShape.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 境界箱の角 2 つ。箱は平面だけでできているので、この値は厳密に出る。 */
function corners(oc: OpenCascadeInstance, shape: TopoDS_Shape): { low: Vec3Tuple; high: Vec3Tuple } {
  const box = new oc.Bnd_Box_1();
  try {
    oc.BRepBndLib.Add(shape, box, false);
    box.SetGap(0);
    const low = box.CornerMin();
    const high = box.CornerMax();
    try {
      return {
        low: [low.X(), low.Y(), low.Z()],
        high: [high.X(), high.Y(), high.Z()],
      };
    } finally {
      high.delete();
      low.delete();
    }
  } finally {
    box.delete();
  }
}

function expectTuple(actual: Vec3Tuple, expected: Vec3Tuple, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

function transform(overrides: Partial<RigidTransformSpec>): RigidTransformSpec {
  return { ...IDENTITY_TRANSFORM, ...overrides };
}

describe('剛体変換とコンパウンド(FR-411、FR-412)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 計画書 タスク9 の検証表が使う箱。20×10×5、原点が角。 */
  const BAR = { dx: 20, dy: 10, dz: 5 } as const;

  it('平行移動だけの変換は、箱を X へ 10 ずらす', () => {
    const handle = makeBox(oc, BAR);
    try {
      const moved = transformShape(oc, handle.shape, transform({ translation: [10, 0, 0] }));
      try {
        expectTuple(corners(oc, moved.shape).low, [10, 0, 0]);
        expectTuple(corners(oc, moved.shape).high, [30, 10, 5]);
        // もとの形は動かない(Copy = true)。
        expectTuple(corners(oc, handle.shape).low, [0, 0, 0]);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('Z 軸まわり 90 度の回転だけで、20×10×5 の箱が 10×20×5 になる', () => {
    const handle = makeBox(oc, BAR);
    try {
      const moved = transformShape(
        oc,
        handle.shape,
        transform({ rotationAxis: [0, 0, 1], rotationAngle: Math.PI / 2 }),
      );
      try {
        const { low, high } = corners(oc, moved.shape);
        expectTuple(low, [-10, 0, 0]);
        expectTuple(high, [0, 20, 5]);
        expectVolumeUnchanged(oc, handle.shape, moved.shape);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('回転と平行移動の両方では、回転してから平行移動する(順序を固定する)', () => {
    const handle = makeBox(oc, BAR);
    try {
      const moved = transformShape(
        oc,
        handle.shape,
        transform({
          rotationAxis: [0, 0, 1],
          rotationAngle: Math.PI / 2,
          translation: [10, 0, 0],
        }),
      );
      try {
        const { low, high } = corners(oc, moved.shape);
        // 回転 → 平行移動: x[-10,0] を +10 して x[0,10]。
        // 平行移動 → 回転 だと x[-10,0]・y[10,30] になるので、順序を取り違えたら落ちる。
        expectTuple(low, [0, 0, 0]);
        expectTuple(high, [10, 20, 5]);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('回転の中心を動かすと、その点まわりに回る', () => {
    const handle = makeBox(oc, BAR);
    try {
      const moved = transformShape(
        oc,
        handle.shape,
        transform({
          rotationOrigin: [20, 10, 0],
          rotationAxis: [0, 0, 1],
          rotationAngle: Math.PI,
        }),
      );
      try {
        // (20,10) まわりに 180 度回すと、[0,20]×[0,10] は [20,40]×[10,20] へ移る。
        expectTuple(corners(oc, moved.shape).low, [20, 10, 0]);
        expectTuple(corners(oc, moved.shape).high, [40, 20, 5]);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('makeCompound は 2 つの箱をまとめ、体積は足し算になる', () => {
    const big = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const small = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const moved = transformShape(oc, small.shape, transform({ translation: [100, 0, 0] }));
      try {
        const compound = makeCompound(oc, [big.shape, moved.shape]);
        try {
          // 8000 + 1000。離れているのでコンパウンドの体積は単純な足し算になる。
          expect(Math.abs(measureVolume(oc, compound.shape) - 9000)).toBeLessThan(1e-6);
        } finally {
          compound.delete();
        }
      } finally {
        moved.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('makeCompound は形が 1 つも無ければ断る', () => {
    expect(() => makeCompound(oc, [])).toThrow(/差し引く形がありません/);
  });

  it('applyTransformToPoint は OCCT の変換と同じ位置を出す', () => {
    const handle = makeBox(oc, BAR);
    const spec = transform({
      rotationAxis: [0, 0, 1],
      rotationAngle: Math.PI / 2,
      translation: [3, 4, 5],
    });
    try {
      const moved = transformShape(oc, handle.shape, spec);
      try {
        // 箱の角 (0,0,0) と (20,10,5) の像から境界箱が決まる(90 度回転は軸に沿うため)。
        const first = applyTransformToPoint(spec, [0, 0, 0]);
        const second = applyTransformToPoint(spec, [20, 10, 5]);
        expectTuple(first, [3, 4, 5]);
        expectTuple(second, [-7, 24, 10]);
        const { low, high } = corners(oc, moved.shape);
        expectTuple(low, [Math.min(first[0], second[0]), Math.min(first[1], second[1]), 5]);
        expectTuple(high, [Math.max(first[0], second[0]), Math.max(first[1], second[1]), 10]);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('applyTransformToDirection は平行移動を無視し、長さ 1 を保つ', () => {
    const spec = transform({
      rotationAxis: [0, 0, 1],
      rotationAngle: Math.PI / 2,
      translation: [100, 200, 300],
    });
    const turned = applyTransformToDirection(spec, [1, 0, 0]);
    expectTuple(turned, [0, 1, 0]);
    expect(Math.hypot(turned[0], turned[1], turned[2])).toBeCloseTo(1, 12);
  });

  it('恒等の変換は点も向きも変えない', () => {
    expect(isIdentityTransform(IDENTITY_TRANSFORM)).toBe(true);
    expectTuple(applyTransformToPoint(IDENTITY_TRANSFORM, [1, 2, 3]), [1, 2, 3]);
    expectTuple(applyTransformToDirection(IDENTITY_TRANSFORM, [0, 0, 1]), [0, 0, 1]);
    expect(isIdentityTransform(transform({ translation: [0, 0, 1] }))).toBe(false);
    expect(isIdentityTransform(transform({ rotationAngle: 0.1 }))).toBe(false);
  });

  it('transformsOrIdentity は空の一覧を恒等 1 つにする', () => {
    expect(transformsOrIdentity([])).toEqual([IDENTITY_TRANSFORM]);
    const one = [transform({ translation: [5, 0, 0] })];
    expect(transformsOrIdentity(one)).toBe(one);
  });

  it('数でない値の変換は断る', () => {
    expect(() => applyTransformToPoint(transform({ translation: [Number.NaN, 0, 0] }), [0, 0, 0])).toThrow(
      /数になっていません/,
    );
    expect(() =>
      applyTransformToPoint(transform({ rotationAngle: Number.POSITIVE_INFINITY }), [0, 0, 0]),
    ).toThrow(/数になっていません/);
  });

  it('回すのに軸の向きが無ければ断る(回転角が 0 なら軸は見ない)', () => {
    expect(() =>
      applyTransformToPoint(transform({ rotationAxis: [0, 0, 0], rotationAngle: 1 }), [1, 0, 0]),
    ).toThrow(/並べる向きが決まりません/);
    // 回転角 0 なら軸が無くても平行移動として通る。
    expectTuple(
      applyTransformToPoint(
        transform({ rotationAxis: [0, 0, 0], rotationAngle: 0, translation: [1, 2, 3] }),
        [0, 0, 0],
      ),
      [1, 2, 3],
    );
  });
});

describe('ミラー・移動/回転・拡大縮小(FR-419、FR-424)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 計画書 タスク35 の検証表が使う箱。10×20×30、原点が角。体積 6000。 */
  const BLOCK = { dx: 10, dy: 20, dz: 30 } as const;
  /** 統括の指示の検証で使う板。40×30×10、原点が角。体積 12000。 */
  const PLATE = { dx: 40, dy: 30, dz: 10 } as const;

  it('軸ごとの拡大縮小に要る OCCT の道具がそろっている(計画書 §1.5-1 の実測)', () => {
    // そろっていなければ軸ごとの拡大縮小は作れないので、真っ先に確かめる。
    expect(oc.gp_Mat_2).toBeTypeOf('function');
    expect(oc.gp_GTrsf_3).toBeTypeOf('function');
    expect(oc.BRepBuilderAPI_GTransform_2).toBeTypeOf('function');
    // ミラーの側(P3 §0.a-0.1 が「安く入る」と見込んだ道具)も同じ場で確かめる。
    expect(oc.gp_Ax2_3).toBeTypeOf('function');
  });

  it('箱 10×20×30 を XY 平面でミラーすると、体積は 6000 のまま z が [-30, 0] になる', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const mirrored = mirrorShape(oc, handle.shape, { origin: [0, 0, 0], normal: [0, 0, 1] });
      try {
        expect(Math.abs(measureVolume(oc, mirrored.shape) - 6000)).toBeLessThan(1e-6);
        const { low, high } = corners(oc, mirrored.shape);
        expectTuple(low, [0, 0, -30]);
        expectTuple(high, [10, 20, 0]);
      } finally {
        mirrored.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('ミラーの変換は向きを反転している(IsNegative が true)', () => {
    const { keep, release } = createAllocations();
    try {
      const mirror = makeMirrorTransform(oc, { origin: [0, 0, 0], normal: [0, 0, 1] }, keep);
      expect(mirror.IsNegative()).toBe(true);
      // 平行移動だけの変換は反転しない(比べる相手を置いて、判定が効いていることを示す)。
      expect(makeTransformForCompare(oc, keep).IsNegative()).toBe(false);
    } finally {
      release();
    }
  });

  it('ミラーの結果は B-rep として妥当で、もとの形は動かない(Copy = true)', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const mirrored = mirrorShape(oc, handle.shape, { origin: [0, 0, 0], normal: [0, 0, 1] });
      try {
        expect(isValidShape(oc, mirrored.shape)).toBe(true);
        // もとの形は元の位置・元の体積のまま。
        expectTuple(corners(oc, handle.shape).low, [0, 0, 0]);
        expectTuple(corners(oc, handle.shape).high, [10, 20, 30]);
        expect(Math.abs(measureVolume(oc, handle.shape) - 6000)).toBeLessThan(1e-6);
      } finally {
        mirrored.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('板 40×30×10 を XZ 平面(y=0)でミラーすると、体積 12000 のまま y が [-30, 0] になる', () => {
    const handle = makeBox(oc, PLATE);
    try {
      const mirrored = mirrorShape(oc, handle.shape, { origin: [0, 0, 0], normal: [0, 1, 0] });
      try {
        expect(Math.abs(measureVolume(oc, mirrored.shape) - 12000)).toBeLessThan(1e-6);
        const { low, high } = corners(oc, mirrored.shape);
        expectTuple(low, [0, -30, 0]);
        expectTuple(high, [40, 0, 10]);
        // 表面積も変わらない(2(40·30 + 40·10 + 30·10) = 3800)。
        expect(Math.abs(measureArea(oc, mirrored.shape) - 3800)).toBeLessThan(1e-6);
      } finally {
        mirrored.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('原点から離れた平面(x=50)でミラーすると、鏡の向こう側へ移る', () => {
    const handle = makeBox(oc, PLATE);
    try {
      const mirrored = mirrorShape(oc, handle.shape, { origin: [50, 0, 0], normal: [1, 0, 0] });
      try {
        // x = 50 に対する鏡像は x' = 100 − x。x[0,40] は x[60,100] へ移る。
        expectTuple(corners(oc, mirrored.shape).low, [60, 0, 0]);
        expectTuple(corners(oc, mirrored.shape).high, [100, 30, 10]);
      } finally {
        mirrored.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('法線の長さが 0 の平面ではミラーを断る', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      expect(() => mirrorShape(oc, handle.shape, { origin: [0, 0, 0], normal: [0, 0, 0] })).toThrow(
        /鏡にする面の向きが決まりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('数でない位置・向きのミラーを断る', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      expect(() =>
        mirrorShape(oc, handle.shape, { origin: [Number.NaN, 0, 0], normal: [0, 0, 1] }),
      ).toThrow(/位置や向きが数になっていません/);
      expect(() =>
        mirrorShape(oc, handle.shape, {
          origin: [0, 0, 0],
          normal: [0, 0, Number.POSITIVE_INFINITY],
        }),
      ).toThrow(/位置や向きが数になっていません/);
    } finally {
      handle.delete();
    }
  });

  it('FR-424 の移動は既存の transformShape がそのまま満たす(体積 6000 のまま +10 ずれる)', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const moved = transformShape(oc, handle.shape, transform({ translation: [10, 0, 0] }));
      try {
        expect(Math.abs(measureVolume(oc, moved.shape) - 6000)).toBeLessThan(1e-6);
        expectTuple(corners(oc, moved.shape).low, [10, 0, 0]);
        expectTuple(corners(oc, moved.shape).high, [20, 20, 30]);
      } finally {
        moved.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('FR-424 の回転も既存の transformShape がそのまま満たす(Z 軸まわり 90 度)', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const turned = transformShape(
        oc,
        handle.shape,
        transform({ rotationAxis: [0, 0, 1], rotationAngle: Math.PI / 2 }),
      );
      try {
        // (x, y) → (−y, x)。x[0,10]・y[0,20] は x[−20,0]・y[0,10] へ移る。
        expectTuple(corners(oc, turned.shape).low, [-20, 0, 0]);
        expectTuple(corners(oc, turned.shape).high, [0, 10, 30]);
        expectVolumeUnchanged(oc, handle.shape, turned.shape);
      } finally {
        turned.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('箱 10×20×30 を全体 2 倍にすると体積 48000(6000 × 2³)になる', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const scaled = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: 2,
        perAxis: null,
      });
      try {
        expect(Math.abs(measureVolume(oc, scaled.shape) - 48000)).toBeLessThan(1e-6);
        expectTuple(corners(oc, scaled.shape).low, [0, 0, 0]);
        expectTuple(corners(oc, scaled.shape).high, [20, 40, 60]);
        expect(isValidShape(oc, scaled.shape)).toBe(true);
        // もとの形は変わらない(Copy = true)。
        expectTuple(corners(oc, handle.shape).high, [10, 20, 30]);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('全体 0.5 倍では体積 750(6000 × 0.5³)、表面積は 1/4 になる', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const before = measureArea(oc, handle.shape);
      const scaled = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: 0.5,
        perAxis: null,
      });
      try {
        expect(Math.abs(measureVolume(oc, scaled.shape) - 750)).toBeLessThan(1e-6);
        expect(Math.abs(measureArea(oc, scaled.shape) - before / 4)).toBeLessThan(1e-6);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('全体の拡大縮小の中心にした点は動かない', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const scaled = scaleShape(oc, handle.shape, {
        origin: [10, 20, 30],
        uniform: 3,
        perAxis: null,
      });
      try {
        // 角 (10,20,30) を中心に 3 倍すると、反対の角 (0,0,0) は (−20,−40,−60) へ移る。
        expectTuple(corners(oc, scaled.shape).low, [-20, -40, -60]);
        expectTuple(corners(oc, scaled.shape).high, [10, 20, 30]);
        expect(Math.abs(measureVolume(oc, scaled.shape) - 6000 * 27)).toBeLessThan(1e-6);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('X だけ 2 倍にすると体積 12000(6000 × 2)になる', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const scaled = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: null,
        perAxis: [2, 1, 1],
      });
      try {
        expect(Math.abs(measureVolume(oc, scaled.shape) - 12000)).toBeLessThan(1e-6);
        expectTuple(corners(oc, scaled.shape).low, [0, 0, 0]);
        expectTuple(corners(oc, scaled.shape).high, [20, 20, 30]);
        expect(isValidShape(oc, scaled.shape)).toBe(true);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('X 2 / Y 3 / Z 0.5 倍にすると体積 18000(6000 × 3)になる', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const scaled = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: null,
        perAxis: [2, 3, 0.5],
      });
      try {
        expect(Math.abs(measureVolume(oc, scaled.shape) - 18000)).toBeLessThan(1e-6);
        expectTuple(corners(oc, scaled.shape).low, [0, 0, 0]);
        expectTuple(corners(oc, scaled.shape).high, [20, 60, 15]);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('軸ごとの拡大縮小でも、中心にした点は動かない', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const scaled = scaleShape(oc, handle.shape, {
        origin: [10, 20, 30],
        uniform: null,
        perAxis: [2, 3, 0.5],
      });
      try {
        // 中心 (10,20,30) は動かず、反対の角 (0,0,0) は (−10,−40,15) へ移る。
        expectTuple(corners(oc, scaled.shape).low, [-10, -40, 15]);
        expectTuple(corners(oc, scaled.shape).high, [10, 20, 30]);
        expect(Math.abs(measureVolume(oc, scaled.shape) - 18000)).toBeLessThan(1e-6);
      } finally {
        scaled.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('倍率が 0・負・非数のときは断る(負の鏡像はミラーで作る)', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
      for (const value of bad) {
        expect(() =>
          scaleShape(oc, handle.shape, { origin: [0, 0, 0], uniform: value, perAxis: null }),
        ).toThrow(/倍率は 0 より大きい数にしてください/);
        expect(() =>
          scaleShape(oc, handle.shape, { origin: [0, 0, 0], uniform: null, perAxis: [value, 1, 1] }),
        ).toThrow(/倍率は 0 より大きい数にしてください/);
        expect(() =>
          scaleShape(oc, handle.shape, { origin: [0, 0, 0], uniform: null, perAxis: [1, 1, value] }),
        ).toThrow(/倍率は 0 より大きい数にしてください/);
      }
    } finally {
      handle.delete();
    }
  });

  it('「全体」と「軸ごと」は片方だけを指定する(両方・どちらも無しは断る)', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      expect(() =>
        scaleShape(oc, handle.shape, { origin: [0, 0, 0], uniform: 2, perAxis: [2, 2, 2] }),
      ).toThrow(/どちらか一方を指定してください/);
      expect(() =>
        scaleShape(oc, handle.shape, { origin: [0, 0, 0], uniform: null, perAxis: null }),
      ).toThrow(/どちらか一方を指定してください/);
    } finally {
      handle.delete();
    }
  });

  it('数でない中心の拡大縮小を断る', () => {
    const handle = makeBox(oc, BLOCK);
    try {
      expect(() =>
        scaleShape(oc, handle.shape, {
          origin: [0, Number.NaN, 0],
          uniform: 2,
          perAxis: null,
        }),
      ).toThrow(/位置や向きが数になっていません/);
    } finally {
      handle.delete();
    }
  });

  it('ミラー・拡大縮小の 1 段は 500ms(NFR-PF-2)に収まる', () => {
    const handle = makeBox(oc, PLATE);
    try {
      const mirrorStarted = performance.now();
      const mirrored = mirrorShape(oc, handle.shape, { origin: [0, 0, 0], normal: [0, 1, 0] });
      const mirrorMs = performance.now() - mirrorStarted;
      mirrored.delete();

      const uniformStarted = performance.now();
      const uniform = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: 2,
        perAxis: null,
      });
      const uniformMs = performance.now() - uniformStarted;
      uniform.delete();

      const perAxisStarted = performance.now();
      const perAxis = scaleShape(oc, handle.shape, {
        origin: [0, 0, 0],
        uniform: null,
        perAxis: [2, 3, 0.5],
      });
      const perAxisMs = performance.now() - perAxisStarted;
      perAxis.delete();

      console.log(
        `ミラー 1 段: ${mirrorMs.toFixed(1)}ms / 全体倍率 1 段: ${uniformMs.toFixed(1)}ms / ` +
          `軸ごと倍率 1 段: ${perAxisMs.toFixed(1)}ms(いずれも上限 500ms)`,
      );
      expect(mirrorMs).toBeLessThan(500);
      expect(uniformMs).toBeLessThan(500);
      expect(perAxisMs).toBeLessThan(500);
    } finally {
      handle.delete();
    }
  });
});

/**
 * IsNegative の比べる相手(平行移動だけの変換)。
 * 鏡像でない変換では false になることを示すために使う。
 */
function makeTransformForCompare(
  oc: OpenCascadeInstance,
  keep: ReturnType<typeof createAllocations>['keep'],
): gp_Trsf {
  const moved = keep(new oc.gp_Trsf_1());
  moved.SetTranslation_1(keep(new oc.gp_Vec_4(1, 2, 3)));
  return moved;
}

/** 剛体変換なので体積は変わらない。 */
function expectVolumeUnchanged(
  oc: OpenCascadeInstance,
  before: TopoDS_Shape,
  after: TopoDS_Shape,
): void {
  const source = measureVolume(oc, before);
  expect(Math.abs(measureVolume(oc, after) - source) / source).toBeLessThan(1e-12);
}
