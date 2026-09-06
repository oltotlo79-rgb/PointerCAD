import { describe, expect, it } from 'vitest';

import {
  applyPlacementToDirection, applyPlacementToPoint, composePlacement, exponentialMap,
  IDENTITY_PLACEMENT, IDENTITY_QUATERNION, multiplyQuaternion, normalizeQuaternion,
  placementToRigidTransform, QUATERNION_TOLERANCE, quaternionFromAxisAngle, quaternionToAxisAngle,
  type Quaternion, type RigidPlacement, rotateVector,
} from './placementMath.js';
import { type Vec3 } from '../sketch/vec3.js';

/**
 * 期待値との差を成分ごとに測る(倍精度の刻みは 2.2e-16 なので、1e-15 は
 * 「数え違いではなく丸めの範囲」を表す線引き。計画書 §2.4 の検証表の値をそのまま使う)。
 */
function expectClose(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(Math.abs(actual[index] - expected[index]), `成分 ${index}`).toBeLessThanOrEqual(tolerance);
  }
}

/** Z 軸まわり 90°。検証表の要になる向き。 */
const Z_QUARTER: Quaternion = quaternionFromAxisAngle([0, 0, 1], Math.PI / 2);

function placement(position: Vec3, rotation: Quaternion): RigidPlacement {
  return { position, rotation };
}

describe('四元数の作り方と規約(計画書 P7 §2.4、§0.54)', () => {
  it('Z 軸まわり 90° は (0, 0, √2/2, √2/2)', () => {
    // 実測(2026-09-06、Node 上): [0, 0, 0.7071067811865475, 0.7071067811865476]。
    // Math.sin(π/4) と Math.cos(π/4) が最後の 1 ビットだけ違うため z と w が揃わない
    // (差は 1.1e-16 で、計画書の期待値 0.7071067811865476 と 1e-15 以内で一致する)。
    expectClose(Z_QUARTER, [0, 0, 0.7071067811865476, 0.7071067811865476], 1e-15);
  });

  it('Z 軸まわり 90° を (1,0,0) に掛けると (0,1,0)', () => {
    expectClose(rotateVector(Z_QUARTER, [1, 0, 0]), [0, 1, 0], 1e-15);
  });

  it('Z 軸まわり 90° を (0,1,0) に掛けると (−1,0,0)', () => {
    expectClose(rotateVector(Z_QUARTER, [0, 1, 0]), [-1, 0, 0], 1e-15);
  });

  it('X 軸まわり 180° は w = cos90° = 0 で、w >= 0 を満たす', () => {
    const half = quaternionFromAxisAngle([1, 0, 0], Math.PI);
    // 実測: w = 6.123233995736766e-17(Math.cos(π/2) はちょうど 0 にならない)。
    expectClose(half, [1, 0, 0, 0], 1e-15);
    expect(half[3]).toBeGreaterThanOrEqual(0);
  });

  it('w < 0 の四元数は全成分の符号を反転して w >= 0 へ揃える', () => {
    const flipped = normalizeQuaternion([0, 0, -0.7071067811865476, -0.7071067811865476]);
    expectClose(flipped, [0, 0, 0.7071067811865476, 0.7071067811865476], 1e-15);
    expect(flipped[3]).toBeGreaterThan(0);
  });

  it('揃えたあとの長さは 1', () => {
    const skewed = normalizeQuaternion([1, 2, 3, 4]);
    expect(Math.hypot(skewed[0], skewed[1], skewed[2], skewed[3])).toBeCloseTo(1, 15);
    expect(Math.hypot(Z_QUARTER[0], Z_QUARTER[1], Z_QUARTER[2], Z_QUARTER[3])).toBeCloseTo(1, 15);
  });

  it('w がちょうど 0 のときも符号が一意に決まる(§0.54 の決定性)', () => {
    // 180° 回転は w = 0 なので、w の符号だけでは q と −q を区別できない。
    // x → y → z の順で最初に 0 でない成分を正にする決まりを固定する。
    expect(normalizeQuaternion([-1, 0, 0, 0])).toEqual([1, 0, 0, 0]);
    expect(normalizeQuaternion([0, -1, 0, 0])).toEqual([0, 1, 0, 0]);
    expect(normalizeQuaternion([0, 0, -1, 0])).toEqual([0, 0, 1, 0]);
  });

  it('長さが取れない・NaN の四元数は恒等へ落とす(投げない。FR-504)', () => {
    expect(normalizeQuaternion([0, 0, 0, 0])).toEqual(IDENTITY_QUATERNION);
    expect(normalizeQuaternion([Number.NaN, 0, 0, 1])).toEqual(IDENTITY_QUATERNION);
    expect(normalizeQuaternion([0, 0, 0, Number.POSITIVE_INFINITY])).toEqual(IDENTITY_QUATERNION);
    expect(normalizeQuaternion([0, 0, 0, QUATERNION_TOLERANCE / 2])).toEqual(IDENTITY_QUATERNION);
  });

  it('長さ 0 の軸では回しようがないので恒等になる', () => {
    expect(quaternionFromAxisAngle([0, 0, 0], Math.PI / 3)).toEqual(IDENTITY_QUATERNION);
    expect(quaternionFromAxisAngle([0, 0, 1], Number.NaN)).toEqual(IDENTITY_QUATERNION);
  });
});

describe('指数写像(回転ベクトル → 四元数、計画書 §2.4 手順3)', () => {
  it('(0, 0, π/2) は Z 軸まわり 90° と同じ', () => {
    expect(exponentialMap([0, 0, Math.PI / 2])).toEqual(Z_QUARTER);
  });

  it('長さ 0 は恒等', () => {
    expect(exponentialMap([0, 0, 0])).toEqual(IDENTITY_QUATERNION);
  });

  it('極端に小さい回転でも NaN にならない(0 割りの分岐)', () => {
    // θ = 1e-15 は分岐の境目 1e-12 より小さいので、割り算を含まない 1 次近似を通る。
    const tiny = exponentialMap([1e-15, 0, 0]);
    for (const value of tiny) {
      expect(Number.isNaN(value)).toBe(false);
    }
    expectClose(tiny, [5e-16, 0, 0, 1], 1e-15);
  });

  it('回転ベクトルの長さがそのまま回転角になる', () => {
    const turned = quaternionToAxisAngle(exponentialMap([0, 0.7, 0]));
    expect(turned.angleRadians).toBeCloseTo(0.7, 12);
    expectClose(turned.axis, [0, 1, 0], 1e-12);
  });
});

describe('軸と角度との往復(計画書 §2.4)', () => {
  it('軸と角度へ戻すと元へ戻る', () => {
    const axis: Vec3 = [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)];
    const round = quaternionToAxisAngle(quaternionFromAxisAngle(axis, 0.7));
    expectClose(round.axis, axis, 1e-12);
    expect(Math.abs(round.angleRadians - 0.7)).toBeLessThanOrEqual(1e-12);
  });

  it('回転が 0 のときの軸は Z 軸(§1.4-8)', () => {
    const identity = quaternionToAxisAngle(IDENTITY_QUATERNION);
    expect(identity.axis).toEqual([0, 0, 1]);
    expect(identity.angleRadians).toBe(0);
  });
});

describe('配置の合成(計画書 §2.4)', () => {
  it('90°Z ずつ 2 回で 180°Z になる', () => {
    const composed = composePlacement(
      placement([10, 0, 0], Z_QUARTER),
      placement([0, 0, 0], Z_QUARTER),
    );
    expectClose(composed.rotation, [0, 0, 1, 0], 1e-15);
  });

  it('内側の平行移動が 0 なら合成の平行移動は外側のまま', () => {
    const composed = composePlacement(
      placement([10, 0, 0], Z_QUARTER),
      placement([0, 0, 0], Z_QUARTER),
    );
    expectClose(composed.position, [10, 0, 0], 1e-15);
  });

  it('外側が回らないなら平行移動どうしの足し算になる', () => {
    const composed = composePlacement(
      placement([10, 0, 0], IDENTITY_QUATERNION),
      placement([5, 0, 0], Z_QUARTER),
    );
    expectClose(applyPlacementToPoint(composed, [0, 0, 0]), [15, 0, 0], 1e-15);
  });

  it('外側が回るなら内側の平行移動も回る', () => {
    const composed = composePlacement(
      placement([0, 0, 0], Z_QUARTER),
      placement([5, 0, 0], IDENTITY_QUATERNION),
    );
    // 許容差だけ 1e-14。回転行列の対角成分 1 − 2(y²+z²) は 0 のかわりに 2.2e-16 になり、
    // それが 5mm 倍されて X に 1.11e-15 残る(実測、2026-09-06)。誤差は長さに比例するので、
    // 5mm の距離に対する 1e-14 は相対で 2e-15 ── 倍精度の刻み(2.2e-16)の 10 倍以内に収まる。
    expectClose(applyPlacementToPoint(composed, [0, 0, 0]), [0, 5, 0], 1e-14);
  });

  it('恒等との合成は元のまま', () => {
    const one = placement([3, -4, 5], quaternionFromAxisAngle([1, 1, 0], 0.3));
    expect(composePlacement(IDENTITY_PLACEMENT, one)).toEqual(one);
    expect(composePlacement(one, IDENTITY_PLACEMENT)).toEqual(one);
  });

  it('四元数の積は「内側で回してから外側で回す」順', () => {
    const both = multiplyQuaternion(Z_QUARTER, Z_QUARTER);
    expectClose(rotateVector(both, [1, 0, 0]), rotateVector(Z_QUARTER, rotateVector(Z_QUARTER, [1, 0, 0])), 1e-15);
    expect(multiplyQuaternion(IDENTITY_QUATERNION, Z_QUARTER)).toEqual(Z_QUARTER);
  });
});

describe('点と向きへの適用(計画書 §2.4)', () => {
  it('点は回してから移す', () => {
    expectClose(applyPlacementToPoint(placement([10, 0, 0], Z_QUARTER), [1, 0, 0]), [10, 1, 0], 1e-15);
  });

  it('向きは平行移動を受けない', () => {
    const moved = placement([100, -50, 7], Z_QUARTER);
    const still = placement([0, 0, 0], Z_QUARTER);
    expect(applyPlacementToDirection(moved, [1, 0, 0])).toEqual(
      applyPlacementToDirection(still, [1, 0, 0]),
    );
    expectClose(applyPlacementToDirection(moved, [1, 0, 0]), [0, 1, 0], 1e-15);
  });

  it('向きの長さは変わらない(剛体変換)', () => {
    const turned = applyPlacementToDirection(placement([9, 9, 9], Z_QUARTER), [3, 4, 0]);
    expect(Math.hypot(turned[0], turned[1], turned[2])).toBeCloseTo(5, 12);
  });

  it('長さ 1 でない四元数を渡しても拡大縮小しない(内側で正規化する)', () => {
    const doubled: Quaternion = [
      Z_QUARTER[0] * 2, Z_QUARTER[1] * 2, Z_QUARTER[2] * 2, Z_QUARTER[3] * 2,
    ];
    expectClose(rotateVector(doubled, [1, 0, 0]), [0, 1, 0], 1e-15);
  });
});

describe('既存の RigidTransform への写し(計画書 §1.4-8)', () => {
  it('回転が 0 のときは軸が Z・角が 0', () => {
    const spec = placementToRigidTransform(placement([1, 2, 3], IDENTITY_QUATERNION));
    expect(spec.rotationAxis).toEqual([0, 0, 1]);
    expect(spec.rotationAngle).toBe(0);
    expect(spec.translation).toEqual([1, 2, 3]);
    expect(spec.rotationOrigin).toEqual([0, 0, 0]);
  });

  it('回転がある配置は軸と角へ分かれ、平行移動はそのまま', () => {
    const spec = placementToRigidTransform(placement([10, 0, 0], Z_QUARTER));
    expectClose(spec.rotationAxis, [0, 0, 1], 1e-12);
    expect(Math.abs(spec.rotationAngle - Math.PI / 2)).toBeLessThanOrEqual(1e-12);
    expect(spec.translation).toEqual([10, 0, 0]);
  });

  it('写した先の式(原点まわりに回してから移す)が applyPlacementToPoint と一致する', () => {
    // kernel の `applyTransformToPoint` は「点 − 回転中心 → 回す → 回転中心 + 平行移動」。
    // 回転中心が原点なので R·p + t になり、こちらの式とぴったり重なることを固定する。
    const one = placement([3, -4, 5], quaternionFromAxisAngle([1, 2, 3], 0.7));
    const spec = placementToRigidTransform(one);
    const point: Vec3 = [2, 1, -3];
    const byAxisAngle = applyPlacementToPoint(
      placement(spec.translation, quaternionFromAxisAngle(spec.rotationAxis, spec.rotationAngle)),
      point,
    );
    expectClose(byAxisAngle, applyPlacementToPoint(one, point), 1e-12);
  });
});
