import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { RigidTransformSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { measureVolume } from './solidMesh.js';
import {
  IDENTITY_TRANSFORM,
  applyTransformToDirection,
  applyTransformToPoint,
  isIdentityTransform,
  makeCompound,
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

/** 剛体変換なので体積は変わらない。 */
function expectVolumeUnchanged(
  oc: OpenCascadeInstance,
  before: TopoDS_Shape,
  after: TopoDS_Shape,
): void {
  const source = measureVolume(oc, before);
  expect(Math.abs(measureVolume(oc, after) - source) / source).toBeLessThan(1e-12);
}
