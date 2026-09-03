/**
 * ねじの簡略表示の印(§0.a-0.15)の線分を組み立てる純関数の検査
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク23)。
 *
 * `createSolidLayer()` 本体は three.js の入れ物を作るだけで DOM(canvas・WebGL)には
 * 触れないが、実際に描く判定(材質・renderOrder・当たり判定)は目視と E2E(タスク30)で
 * 確かめる方針(P2 タスク20 から続く決め方)なので、ここでは印の線分の座標を作る
 * `buildThreadMarkPositions` だけを検査する。
 */
import { describe, expect, it } from 'vitest';

import { buildThreadMarkPositions, type ThreadMarkInfo } from './createSolidLayer.js';

/** 円 1 つ(48 分割)+ 軸線 1 本ぶんの数値の個数。 */
const FLOATS_PER_MARK = 48 * 6 * 2 + 6;

describe('buildThreadMarkPositions', () => {
  it('印が無ければ空になる', () => {
    expect(buildThreadMarkPositions([])).toEqual(new Float32Array(0));
  });

  it('円2本(48分割の折れ線)+軸線1本ぶんの線分を作る', () => {
    const mark: ThreadMarkInfo = {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      majorDiameter: 10,
      length: 20,
    };
    const positions = buildThreadMarkPositions([mark]);
    expect(positions.length).toBe(FLOATS_PER_MARK);

    // 始めの円(origin 中心、半径5)の最初の点。方位角0のとき、direction=(0,0,1) の
    // 基底は u=(0,-1,0)・v=(1,0,0)(参照軸(1,0,0)との外積)になるので、点は (0,-5,0)。
    expect(Array.from(positions.slice(0, 3))).toEqual([0, -5, 0]);

    // 終わりの円(origin + direction*length = (0,0,20) 中心)の最初の点も同じ向きにずれる。
    const secondCircleStart = 48 * 6;
    expect(Array.from(positions.slice(secondCircleStart, secondCircleStart + 3))).toEqual([
      0, -5, 20,
    ]);

    // 軸線(最後の6個)は origin → origin + direction*length。
    const axisStart = positions.length - 6;
    expect(Array.from(positions.slice(axisStart, axisStart + 6))).toEqual([0, 0, 0, 0, 0, 20]);
  });

  it('外径・長さが違う印を複数まとめて積む(印の数だけ長さが伸びる)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 1], majorDiameter: 6, length: 10 },
      { origin: [5, 5, 0], direction: [1, 0, 0], majorDiameter: 8, length: 12 },
    ];
    const positions = buildThreadMarkPositions(marks);
    expect(positions.length).toBe(FLOATS_PER_MARK * 2);
  });

  it('向きが退化した(長さ0の)印は黙って飛ばす(NaN を作らない)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 0], majorDiameter: 10, length: 20 },
      { origin: [1, 2, 3], direction: [0, 1, 0], majorDiameter: 4, length: 6 },
    ];
    const positions = buildThreadMarkPositions(marks);
    // 退化した1本目は積まれず、2本目ぶんだけになる。
    expect(positions.length).toBe(FLOATS_PER_MARK);
    expect(Array.from(positions).some((value) => Number.isNaN(value))).toBe(false);
  });
});
