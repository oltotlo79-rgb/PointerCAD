/**
 * 断面表示の純関数(`sectionView.ts`)の検査
 * (計画書 docs/plans/P6-入出力.md §2.12 の表、タスク34 の検証表)。
 *
 * 期待値の導出(three の `Plane` は `n · x + constant = 0`):
 * - XY 面(原点、法線 (0,0,1))→ `constant = −((0,0,1)·(0,0,0)) = 0`
 * - 点 (0,0,5) を通る同じ向き → `constant = −((0,0,1)·(0,0,5)) = −5`
 * - 同、オフセット +3 → `−5 − 3 = −8`(オフセットは法線の向きへ平面を進める)
 * - 同、裏返し → 方程式を −1 倍するので `normal = (0,0,−1)`、`constant = +8`
 * - 斜めの平面(法線 (1,1,1)、点 (1,1,1))→ 正規化して `n = (1/√3, 1/√3, 1/√3)`、
 *   `n · p = 3/√3 = √3` なので `constant = −√3 = −1.7320508075688772`
 *   (**倍精度の丸めで実測は −1.7320508075688776。差は 4.44e−16 = 2 ulp** なので
 *   桁数を指定した近似で比べる。`Math.sqrt(3)` そのものとも 2 ulp ずれる)
 * - 同、オフセット +2 → `−√3 − 2 = −3.7320508075688772`
 */

import type { ResolvedPlane } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';

import {
  toThreePlane,
  type SectionPlaneNumbers,
  type SectionPlaneOutcome,
} from './sectionView.js';

/** 原点を通る、法線 +Z の XY 面。 */
const XY_AT_ORIGIN: ResolvedPlane = {
  origin: [0, 0, 0],
  axisU: [1, 0, 0],
  axisV: [0, 1, 0],
  normal: [0, 0, 1],
};

/** z = 5 の高さにある、法線 +Z の平面。 */
const XY_AT_Z5: ResolvedPlane = { ...XY_AT_ORIGIN, origin: [0, 0, 5] };

/** 法線が単位でない(長さ 2)平面。z = 5 を通る。 */
const XY_AT_Z5_UNNORMALIZED: ResolvedPlane = { ...XY_AT_Z5, normal: [0, 0, 2] };

/** 斜めの平面。法線 (1,1,1) は単位でなく、点 (1,1,1) を通る。 */
const DIAGONAL_PLANE: ResolvedPlane = {
  origin: [1, 1, 1],
  // 平面内の 2 軸は法線に垂直であればよい(この検査は法線と原点しか使わない)。
  axisU: [Math.SQRT1_2, -Math.SQRT1_2, 0],
  // n × u = (1,1,−2)/√6(法線と第 1 軸の両方に垂直な単位ベクトル)。
  axisV: [1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)],
  normal: [1, 1, 1],
};

/** 検査の中で「成功したこと」を確かめてから中身を取り出す。 */
function planeOf(outcome: SectionPlaneOutcome): SectionPlaneNumbers {
  if (!outcome.ok) {
    throw new Error(`平面を作れませんでした: ${outcome.message}`);
  }
  return outcome.plane;
}

describe('toThreePlane の基本(§2.12 の表)', () => {
  it('XY 面(原点、法線 +Z)、オフセット 0 は normal = (0,0,1)、constant = 0', () => {
    const plane = planeOf(toThreePlane(XY_AT_ORIGIN, 0, false));
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.constant).toBe(0);
  });

  it('点 (0,0,5) を通る同じ向きの平面は constant = −5', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5, 0, false));
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.constant).toBe(-5);
  });

  it('同、オフセット +3 で constant = −8(法線の向きへ 3mm 進む)', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5, 3, false));
    expect(plane.constant).toBe(-8);
  });

  it('同、裏返しで normal = (0,0,−1)、constant = +8(方程式の符号を反転)', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5, 3, true));
    expect(plane.normal).toEqual([0, 0, -1]);
    expect(plane.constant).toBe(8);
  });

  it('オフセットが負なら法線と反対へ進む(constant = −5 + 2 = −3)', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5, -2, false));
    expect(plane.constant).toBe(-3);
  });

  it('切った平面の上の点は n·p + constant = 0 を満たす(オフセット 4 のとき z = 9)', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5, 4, false));
    const pointOnPlane: readonly [number, number, number] = [12, -7, 9];
    const value =
      plane.normal[0] * pointOnPlane[0] +
      plane.normal[1] * pointOnPlane[1] +
      plane.normal[2] * pointOnPlane[2] +
      plane.constant;
    expect(value).toBeCloseTo(0, 12);
  });
});

describe('toThreePlane の正規化(タスク34 の検証表)', () => {
  it('法線が単位でない (0,0,2) でも normal = (0,0,1) に揃う', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5_UNNORMALIZED, 0, false));
    expect(plane.normal).toEqual([0, 0, 1]);
  });

  it('constant も同じ縮尺になる(正規化しなければ −10 になるところが −5)', () => {
    const plane = planeOf(toThreePlane(XY_AT_Z5_UNNORMALIZED, 0, false));
    expect(plane.constant).toBe(-5);
  });

  it('正規化した結果は、はじめから単位法線を渡した場合と一致する', () => {
    const fromUnit = planeOf(toThreePlane(XY_AT_Z5, 1.5, false));
    const fromScaled = planeOf(toThreePlane(XY_AT_Z5_UNNORMALIZED, 1.5, false));
    expect(fromScaled.normal).toEqual(fromUnit.normal);
    expect(fromScaled.constant).toBe(fromUnit.constant);
  });

  it('斜めの平面(法線 (1,1,1)、点 (1,1,1))は normal = (1/√3, 1/√3, 1/√3)', () => {
    const plane = planeOf(toThreePlane(DIAGONAL_PLANE, 0, false));
    const expected = 1 / Math.sqrt(3);
    expect(plane.normal[0]).toBeCloseTo(expected, 15);
    expect(plane.normal[1]).toBeCloseTo(expected, 15);
    expect(plane.normal[2]).toBeCloseTo(expected, 15);
  });

  it('同、constant = −√3 = −1.7320508075688772(実測は 2 ulp ぶんの丸め差)', () => {
    const plane = planeOf(toThreePlane(DIAGONAL_PLANE, 0, false));
    expect(plane.constant).toBeCloseTo(-1.7320508075688772, 12);
    expect(Math.abs(plane.constant + Math.sqrt(3))).toBeLessThan(1e-15);
  });

  it('同、オフセット +2 で constant = −3.7320508075688772', () => {
    const plane = planeOf(toThreePlane(DIAGONAL_PLANE, 2, false));
    expect(plane.constant).toBeCloseTo(-3.7320508075688772, 12);
  });

  it('同、裏返しで normal と constant の両方の符号が反転する', () => {
    const upright = planeOf(toThreePlane(DIAGONAL_PLANE, 2, false));
    const flipped = planeOf(toThreePlane(DIAGONAL_PLANE, 2, true));
    expect(flipped.normal[0]).toBeCloseTo(-upright.normal[0], 15);
    expect(flipped.normal[1]).toBeCloseTo(-upright.normal[1], 15);
    expect(flipped.normal[2]).toBeCloseTo(-upright.normal[2], 15);
    expect(flipped.constant).toBeCloseTo(-upright.constant, 12);
  });

  it('裏返しても平面そのものは動かない(平面上の点が方程式を満たしたまま)', () => {
    const flipped = planeOf(toThreePlane(XY_AT_Z5, 0, true));
    const value = flipped.normal[2] * 5 + flipped.constant;
    expect(value).toBe(0);
  });

  it('−0 を返さない(裏返して 0 になる成分も +0 に揃える)', () => {
    const plane = planeOf(toThreePlane(XY_AT_ORIGIN, 0, true));
    expect(Object.is(plane.constant, -0)).toBe(false);
    expect(Object.is(plane.normal[0], -0)).toBe(false);
    expect(Object.is(plane.normal[1], -0)).toBe(false);
  });
});

describe('toThreePlane が断る場合(NFR-UX-5、0 除算をしない)', () => {
  it('法線が零ベクトルなら日本語の理由で断る', () => {
    const outcome = toThreePlane({ ...XY_AT_ORIGIN, normal: [0, 0, 0] }, 0, false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('degenerate');
      expect(outcome.message).toContain('向き');
    }
  });

  it('法線が零ベクトルでも NaN や Infinity を返さない(0 で割らない)', () => {
    const outcome = toThreePlane({ ...XY_AT_ORIGIN, normal: [0, 0, 0] }, 0, false);
    expect('plane' in outcome).toBe(false);
  });

  it('法線が長さ 1e−12 でも(向きが定まらないとみなして)断る', () => {
    const outcome = toThreePlane({ ...XY_AT_ORIGIN, normal: [0, 0, 1e-12] }, 0, false);
    expect(outcome.ok).toBe(false);
  });

  it('法線に NaN があれば断る', () => {
    const outcome = toThreePlane({ ...XY_AT_ORIGIN, normal: [Number.NaN, 0, 1] }, 0, false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('degenerate');
    }
  });

  it('オフセットが NaN(式が解けなかった)なら断る', () => {
    const outcome = toThreePlane(XY_AT_Z5, Number.NaN, false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalidValue');
      expect(outcome.message).toContain('断面');
    }
  });

  it('オフセットが無限大なら断る', () => {
    expect(toThreePlane(XY_AT_Z5, Number.POSITIVE_INFINITY, false).ok).toBe(false);
    expect(toThreePlane(XY_AT_Z5, Number.NEGATIVE_INFINITY, false).ok).toBe(false);
  });

  it('平面の原点が数でなければ断る(constant が数にならないため)', () => {
    const outcome = toThreePlane({ ...XY_AT_ORIGIN, origin: [0, Number.NaN, 0] }, 0, false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalidValue');
    }
  });

  it('断るときも例外を投げない(FR-504)', () => {
    const degenerate: ResolvedPlane = { ...XY_AT_ORIGIN, normal: [0, 0, 0] };
    expect(() => toThreePlane(degenerate, Number.NaN, true)).not.toThrow();
  });
});

describe('toThreePlane の決定性と所要(§2.17-7)', () => {
  it('同じ入力からは常に同じ数が出る(100 回)', () => {
    const first = planeOf(toThreePlane(DIAGONAL_PLANE, 2.5, true));
    for (let index = 0; index < 100; index += 1) {
      const again = planeOf(toThreePlane(DIAGONAL_PLANE, 2.5, true));
      expect(again.normal).toEqual(first.normal);
      expect(again.constant).toBe(first.constant);
    }
  });

  it('裏返しは値の大きさを変えず、符号だけを変える', () => {
    const upright = planeOf(toThreePlane(DIAGONAL_PLANE, 1, false));
    const twice = planeOf(toThreePlane(DIAGONAL_PLANE, 1, true));
    expect(-twice.constant).toBeCloseTo(upright.constant, 12);
  });

  it('1 コマぶんの呼び出しが 16ms に十分収まる(10 万回の実測から換算)', () => {
    // §2.17-7 の 16ms は「断面表示の入切と平面の移動」= 配線側(タスク35)の判定なので、
    // ここでは純関数そのものの所要を 10 万回まとめて測って**記録**し、判定は
    // 「1 コマで実際に起こる呼び出し数」に換算した値で行う。断面表示は平面 1 枚なので
    // 1 コマの呼び出しは 1 回で足りるが、つまみのドラッグと入切が重なる最悪でも
    // 数回に収まる。余裕を見て 8 回ぶんを 1 コマの見積もりとする。
    const iterations = 100_000;
    const callsPerFrame = 8;
    // 暖機(JIT の最適化が済んでから測る)。
    for (let index = 0; index < 1000; index += 1) {
      toThreePlane(DIAGONAL_PLANE, index * 0.001, index % 2 === 0);
    }
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < iterations; index += 1) {
      const outcome = toThreePlane(DIAGONAL_PLANE, index * 0.001, index % 2 === 0);
      if (outcome.ok) {
        checksum += outcome.plane.constant;
      }
    }
    const elapsed = performance.now() - started;
    expect(Number.isFinite(checksum)).toBe(true);
    const perFrameMs = (elapsed / iterations) * callsPerFrame;
    console.log(
      `toThreePlane ${String(iterations)} 回: ${elapsed.toFixed(2)} ms` +
        `(1 回あたり ${((elapsed / iterations) * 1000).toFixed(3)} µs、` +
        `1 コマ ${String(callsPerFrame)} 回ぶん ${perFrameMs.toFixed(4)} ms)`,
    );
    expectWithinBudget(perFrameMs, 16, `断面表示の平面の作り直し(1 コマ ${String(callsPerFrame)} 回ぶん)`);
  });
});
