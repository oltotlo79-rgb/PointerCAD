import { describe, expect, it } from 'vitest';

import {
  buildBaseMaterials,
  type ThreeMfColor,
  type ThreeMfFaceRange,
} from './baseMaterials.js';

/*
 * 面ごとの色 → `<basematerials>` の並びと `p1`(計画書 docs/plans/P6-入出力.md §2.6 の
 * 「面ごとの色」とタスク14b の検証表)。XML にする前の組み替えだけをここで確かめる。
 */

/** 立体の色(既定の `#b8bfcc`)。 */
const BODY: ThreeMfColor = [184 / 255, 191 / 255, 204 / 255];

const RED: ThreeMfColor = [0.8, 0.2667, 0.2667];
const GREEN: ThreeMfColor = [0.2, 0.7, 0.3];
const BLUE: ThreeMfColor = [0.1, 0.2, 0.9];

/** 面 1 枚あたり三角形 2 枚(箱の 6 面)。 */
function boxFaceRanges(): ThreeMfFaceRange[] {
  return Array.from({ length: 6 }, (_unused, faceIndex) => ({
    triangleOffset: faceIndex * 2,
    triangleCount: 2,
  }));
}

describe('buildBaseMaterials(面ごとの色。§2.6、タスク14b)', () => {
  it('面の色を渡さなければ立体の色だけで、三角形の対応は作らない', () => {
    const built = buildBaseMaterials(BODY);
    expect(built.colors).toEqual([BODY]);
    expect(built.triangleColors).toBeNull();
  });

  it('面の色が空の表・範囲が無いときも立体の色だけになる', () => {
    expect(buildBaseMaterials(BODY, new Map(), boxFaceRanges()).triangleColors).toBeNull();
    expect(buildBaseMaterials(BODY, new Map([[0, RED]])).colors).toEqual([BODY]);
  });

  it('箱の 6 面を別の色にすると、立体の色 + 6 色で 7 色になる', () => {
    const faceColors = new Map<number, ThreeMfColor>([
      [0, RED],
      [1, GREEN],
      [2, BLUE],
      [3, [0.5, 0.5, 0.5]],
      [4, [0, 0, 0]],
      [5, [1, 1, 1]],
    ]);
    const built = buildBaseMaterials(BODY, faceColors, boxFaceRanges());
    expect(built.colors).toHaveLength(7);
    expect(built.colors[0]).toEqual(BODY);
    // 12 枚すべてが立体の色と違う面に属するので、全部に添字が付く。
    expect(built.triangleColors?.size).toBe(12);
    expect(built.triangleColors?.get(0)).toBe(1);
    expect(built.triangleColors?.get(11)).toBe(6);
  });

  it('3 面が同じ色なら重複を除いて 4 色になる', () => {
    const faceColors = new Map<number, ThreeMfColor>([
      [0, RED],
      [1, RED],
      [2, RED],
      [3, GREEN],
      [4, BLUE],
    ]);
    const built = buildBaseMaterials(BODY, faceColors, boxFaceRanges());
    expect(built.colors).toEqual([BODY, RED, GREEN, BLUE]);
    // 同じ色の 3 面(三角形 6 枚)は同じ添字を指す。
    expect(built.triangleColors?.get(0)).toBe(1);
    expect(built.triangleColors?.get(5)).toBe(1);
    expect(built.triangleColors?.get(6)).toBe(2);
  });

  it('色の並びは「最初にその色が現れた面の通し番号」の昇順(表の作り順に左右されない)', () => {
    const ascending = new Map<number, ThreeMfColor>([
      [1, RED],
      [3, GREEN],
      [5, BLUE],
    ]);
    // 同じ組み合わせを逆の順で足した表。`Map` の挿入順は違う。
    const descending = new Map<number, ThreeMfColor>([
      [5, BLUE],
      [3, GREEN],
      [1, RED],
    ]);
    expect(buildBaseMaterials(BODY, ascending, boxFaceRanges()).colors).toEqual([
      BODY,
      RED,
      GREEN,
      BLUE,
    ]);
    expect(buildBaseMaterials(BODY, descending, boxFaceRanges()).colors).toEqual([
      BODY,
      RED,
      GREEN,
      BLUE,
    ]);
  });

  it('同じ入力から 2 回組み立てると同じ並びになる(§0.a-0.62)', () => {
    const faceColors = new Map<number, ThreeMfColor>([
      [4, GREEN],
      [0, RED],
      [2, GREEN],
    ]);
    const first = buildBaseMaterials(BODY, faceColors, boxFaceRanges());
    const second = buildBaseMaterials(BODY, faceColors, boxFaceRanges());
    expect(first.colors).toEqual(second.colors);
    expect(Array.from(first.triangleColors ?? [])).toEqual(
      Array.from(second.triangleColors ?? []),
    );
  });

  it('立体の色と同じ色の面は <base> を増やさず、三角形にも添字を付けない', () => {
    const built = buildBaseMaterials(
      BODY,
      new Map<number, ThreeMfColor>([
        [0, BODY],
        [1, RED],
      ]),
      boxFaceRanges(),
    );
    expect(built.colors).toEqual([BODY, RED]);
    // 面 0(三角形 0・1)は立体の色なので入らない。面 1(三角形 2・3)だけが入る。
    expect(Array.from(built.triangleColors ?? [])).toEqual([
      [2, 1],
      [3, 1],
    ]);
  });

  it('faceRanges に無い面の番号は黙って読み飛ばす(警告を出さない)', () => {
    const built = buildBaseMaterials(
      BODY,
      new Map<number, ThreeMfColor>([
        [9, RED],
        [-1, GREEN],
        [1.5, BLUE],
        [2, RED],
      ]),
      boxFaceRanges(),
    );
    expect(built.colors).toEqual([BODY, RED]);
    expect(built.triangleColors?.size).toBe(2);
    expect(built.triangleColors?.get(4)).toBe(1);
  });

  it('三角形を 1 枚も持たない面・壊れた範囲は色を増やさない', () => {
    const ranges: ThreeMfFaceRange[] = [
      { triangleOffset: 0, triangleCount: 0 },
      { triangleOffset: -1, triangleCount: 2 },
      { triangleOffset: 0.5, triangleCount: 2 },
      { triangleOffset: 0, triangleCount: Number.NaN },
      { triangleOffset: 0, triangleCount: 2 },
    ];
    const built = buildBaseMaterials(
      BODY,
      new Map<number, ThreeMfColor>([
        [0, RED],
        [1, GREEN],
        [2, BLUE],
        [3, RED],
        [4, GREEN],
      ]),
      ranges,
    );
    // 使えるのは面 4(緑)だけ。
    expect(built.colors).toEqual([BODY, GREEN]);
    expect(Array.from(built.triangleColors ?? [])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it('わずかに違う 2 色は別の <base> になる(丸めでまとめない)', () => {
    const built = buildBaseMaterials(
      BODY,
      new Map<number, ThreeMfColor>([
        [0, [0.5, 0.5, 0.5]],
        [1, [0.5000001, 0.5, 0.5]],
      ]),
      boxFaceRanges(),
    );
    expect(built.colors).toHaveLength(3);
  });

  it('面が多くても三角形の対応は範囲どおりに広がる', () => {
    const built = buildBaseMaterials(
      BODY,
      new Map<number, ThreeMfColor>([[0, RED]]),
      [{ triangleOffset: 10, triangleCount: 3 }],
    );
    expect(Array.from(built.triangleColors ?? [])).toEqual([
      [10, 1],
      [11, 1],
      [12, 1],
    ]);
  });
});
