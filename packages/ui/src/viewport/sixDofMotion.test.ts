import { describe, expect, it } from 'vitest';
import { HOME_ORBIT, orbit, pan, zoom } from './cameraMath.js';
import {
  DEFAULT_SIX_DOF_MOTION, isSixDofStill, movedBySixDof, readSixDofReport, SIX_DOF_AT_REST, sixDofViewMotion, type SixDofMotionSettings,
} from './sixDofMotion.js';

/*
 * 3D マウス(設計 B-09 3-5)の報告の読み取りと視点の動き。報告の形は多軸の入力機器の規格の形(各軸は符号つき 16 ビット・
 * 小さい桁が先)を写したバイトの並び。実機では確かめていない(この単体の検査まで)。
 */
function report(...values: readonly number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((value, index) => { view.setInt16(index * 2, value, true); });
  return view;
}
const bytes = (...values: readonly number[]): DataView => new DataView(Uint8Array.from(values).buffer);

describe('報告の読み取り', () => {
  it('古い形: 報告 1 は平行 3 軸、報告 2 は回転 3 軸、報告 3 はボタンのビット。ほかの値は保つ', () => {
    let reading = readSixDofReport(SIX_DOF_AT_REST, 1, report(100, -100, 350));
    expect(reading.axes).toEqual({ tx: 100, ty: -100, tz: 350, rx: 0, ry: 0, rz: 0 });
    reading = readSixDofReport(reading, 2, report(-350, 20, 7));
    expect(reading.axes).toEqual({ tx: 100, ty: -100, tz: 350, rx: -350, ry: 20, rz: 7 });
    reading = readSixDofReport(reading, 3, bytes(0b101, 0x01));
    expect(reading.buttons).toBe(0b101 + 256);
    expect(reading.axes.rx).toBe(-350);
  });

  it('新しい形: 報告 1 の 12 バイトに 6 軸', () => {
    expect(readSixDofReport(SIX_DOF_AT_REST, 1, report(1, -2, 3, -4, 5, -6)).axes).toEqual({ tx: 1, ty: -2, tz: 3, rx: -4, ry: 5, rz: -6 });
  });

  it('知らない報告・長さの足りない報告は、今の値のまま(壊れた報告で視点を動かさない)', () => {
    const before = readSixDofReport(SIX_DOF_AT_REST, 1, report(10, 20, 30));
    for (const [id, data] of [[1, bytes(1, 2, 3)], [2, bytes(1)], [3, bytes()], [4, report(1, 2, 3)], [0, report(1, 2, 3, 4, 5, 6)]] as const) {
      expect(readSixDofReport(before, id, data)).toBe(before);
    }
  });
});

describe('軸の値から視点の動きへ', () => {
  it('既定の割り当て: 左右→平行移動の横、押し引き→拡大縮小、上下→平行移動の縦、前後の傾き→上下に回す、ひねり→左右に回す', () => {
    const motion = sixDofViewMotion({ ...SIX_DOF_AT_REST, axes: { tx: 350, ty: -175, tz: 175, rx: 350, ry: 350, rz: -350 } },
      DEFAULT_SIX_DOF_MOTION);
    expect(motion).toEqual({ panX: 1, zoom: -0.5, panY: 0.5, orbitPitch: 1, orbitYaw: -1 });
  });

  it('不感帯より小さい軸は 0、範囲の外は最大量に切る。静かな時は止まっている', () => {
    const small = sixDofViewMotion({ ...SIX_DOF_AT_REST, axes: { ...SIX_DOF_AT_REST.axes, tx: 20 } }, DEFAULT_SIX_DOF_MOTION);
    expect(isSixDofStill(small)).toBe(true);
    expect(sixDofViewMotion({ ...SIX_DOF_AT_REST, axes: { ...SIX_DOF_AT_REST.axes, tx: 2000 } }, DEFAULT_SIX_DOF_MOTION).panX).toBe(1);
    expect(isSixDofStill(sixDofViewMotion(SIX_DOF_AT_REST, DEFAULT_SIX_DOF_MOTION))).toBe(true);
  });

  it('感度・反転・同じ動きへの足し合わせ・いちばん大きい軸だけ', () => {
    const settings: SixDofMotionSettings = { ...DEFAULT_SIX_DOF_MOTION, axes: { ...DEFAULT_SIX_DOF_MOTION.axes,
      tx: { target: 'panX', sensitivity: 2, invert: true }, ry: { target: 'panX', sensitivity: 1, invert: false } } };
    const axes = { ...SIX_DOF_AT_REST.axes, tx: 175, ry: 350, rz: 70 };
    expect(sixDofViewMotion({ ...SIX_DOF_AT_REST, axes }, settings).panX).toBeCloseTo(-1 + 1, 12);
    const dominant = sixDofViewMotion({ ...SIX_DOF_AT_REST, axes }, { ...settings, dominantAxisOnly: true });
    expect(dominant).toEqual({ panX: 1, panY: 0, zoom: 0, orbitYaw: 0, orbitPitch: 0 });
  });
});

describe('視点を動かす', () => {
  it('回転 → 平行移動 → 拡大縮小の順に、秒数に比べた量だけ動かし、止まっている時は同じ視点を返す', () => {
    const motion = { panX: 1, panY: 0, zoom: 0.5, orbitYaw: -1, orbitPitch: 0 };
    const expected = zoom(pan(orbit(HOME_ORBIT, -400 * 0.02, 0), 600 * 0.02, 0, 800), 400 * 0.5 * 0.02);
    expect(movedBySixDof(HOME_ORBIT, motion, 0.02, 800)).toEqual(expected);
    expect(movedBySixDof(HOME_ORBIT, { panX: 0, panY: 0, zoom: 0, orbitYaw: 0, orbitPitch: 0 }, 0.02, 800)).toBe(HOME_ORBIT);
  });
});
