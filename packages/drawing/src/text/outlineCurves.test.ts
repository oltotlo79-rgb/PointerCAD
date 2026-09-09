import { describe, expect, it } from 'vitest';
import { outlineCurves } from './outlineCurves.js';
import { textOutline } from './textOutline.js';

describe('文字の閉輪郭から厳密な曲線への変換', () => {
  it('二次曲線を三次へ上げ、Bezierと同じ4制御点のB-splineを作る', () => {
    const outline = textOutline([
      { type: 'M', x: 0, y: 0 }, { type: 'Q', x1: 3, y1: 3, x: 6, y: 0 }, { type: 'Z' },
    ], false);
    if (outline === null) throw new Error('輪郭がない');
    const result = outlineCurves(outline.subpaths);
    expect(result?.[0].curves).toEqual([
      { kind: 'spline', mode: 'control', closed: false, points: [[0, 0, 0], [2, 2, 0], [4, 2, 0], [6, 0, 0]] },
      { kind: 'segment', from: [6, 0, 0], to: [0, 0, 0] },
    ]);
    // x=6t、y=6t(1-t)、底辺との面積は integral(y dx)=6。
    expect(result?.[0].signedArea).toBeCloseTo(-6, 12);
  });
  it('逆向きの穴を正向きの面に変えない', () => {
    const result = outlineCurves([
      { commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [10, 0] }, { kind: 'L', to: [10, 10] }, { kind: 'L', to: [0, 10] }, { kind: 'Z' }] },
      { commands: [{ kind: 'M', to: [2, 2] }, { kind: 'L', to: [2, 8] }, { kind: 'L', to: [8, 8] }, { kind: 'L', to: [8, 2] }, { kind: 'Z' }] },
    ]);
    expect(result?.map((contour) => contour.signedArea)).toEqual([100, -36]);
    expect(result?.map((contour) => contour.curves.length)).toEqual([4, 4]);
  });
  it('終点が始点へ戻っているときに長さ0の閉じ辺を増やさない', () => {
    const result = outlineCurves([{ commands: [
      { kind: 'M', to: [0, 0] }, { kind: 'L', to: [2, 0] }, { kind: 'L', to: [0, 2] }, { kind: 'L', to: [0, 0] }, { kind: 'Z' },
    ] }]);
    expect(result?.[0].curves).toHaveLength(3);
  });
  it('非有限点・開いた輪・面積0の輪を断る', () => {
    expect(outlineCurves([{ commands: [{ kind: 'M', to: [NaN, 0] }, { kind: 'Z' }] }])).toBeNull();
    expect(outlineCurves([{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [2, 0] }] }])).toBeNull();
    expect(outlineCurves([{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [2, 0] }, { kind: 'Z' }] }])).toBeNull();
  });
  it('文字のない空輪郭は空のまま', () => {
    expect(outlineCurves([])).toEqual([]);
  });
  it('離れた位置でも面積計算の大きな数の差引きを避ける', () => {
    const result = outlineCurves([{ commands: [
      { kind: 'M', to: [1e8, 1e8] }, { kind: 'L', to: [1e8 + 10, 1e8] },
      { kind: 'L', to: [1e8 + 10, 1e8 + 10] }, { kind: 'L', to: [1e8, 1e8 + 10] }, { kind: 'Z' },
    ] }]);
    expect(result?.[0].signedArea).toBe(100);
    expect(result?.[0].curves[0]).toMatchObject({ from: [1e8, 1e8, 0], to: [1e8 + 10, 1e8, 0] });
  });
});
