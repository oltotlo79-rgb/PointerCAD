import { azimuthToEllipseParameter } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  bulgeToArc,
  DXF_SPLINE_WEIGHT_IGNORED_MESSAGE,
  ellipseFromDxf,
  parseDxfInteger,
  parseDxfNumber,
  splineFromDxf,
  type DxfPoint2d,
} from './dxfCurves.js';
import { DXF_UNSUPPORTED_FORMAT_MESSAGE } from './dxfTags.js';

/*
 * DXF の曲線の換算の検査(計画書 docs/plans/P6-入出力.md §2.7 とタスク23 の検証表)。
 *
 * 期待値はすべて注釈の導出から手で出し、計画書の表からは写さない
 * (P0 タスク10・12、P1 タスク11、P3 タスク5・8 で計画書の期待値が誤っていた実績があるため)。
 */

/**
 * `tan(22.5°) = √2 − 1 = 0.41421356237309503`。中心角 90 度
 * (`Δθ = 4·atan(tan(π/8)) = π/2`)を作る bulge。
 * `Math.SQRT2 - 1` は同じ数の 1 ulp 違いの表現になるので、`Math.tan` の側を使う。
 */
const QUARTER_TURN_BULGE = Math.tan(Math.PI / 8);

const ORIGIN: DxfPoint2d = { x: 0, y: 0 };
const RIGHT_20: DxfPoint2d = { x: 20, y: 0 };

/** 円弧の上の、方位角 `angleDegrees`(度)の点。 */
function pointOnArc(
  center: DxfPoint2d,
  radius: number,
  angleDegrees: number,
): { readonly x: number; readonly y: number } {
  const radians = (angleDegrees * Math.PI) / 180;
  return { x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians) };
}

describe('parseDxfNumber', () => {
  it('小数・符号・指数表記を読む', () => {
    expect(parseDxfNumber('1.5')).toBe(1.5);
    expect(parseDxfNumber('-3.5')).toBe(-3.5);
    expect(parseDxfNumber('.5')).toBe(0.5);
    expect(parseDxfNumber('10.')).toBe(10);
    // 指数表記は DXF を書く実装が使うことがある。
    expect(parseDxfNumber('1E+2')).toBe(100);
  });

  it('値の前後の空白は無視し、`-0` は `0` へ寄せる', () => {
    // タグの段(タスク22)が値の空白を落とさないので、数にする側で落とす。
    expect(parseDxfNumber('  -3.5  ')).toBe(-3.5);
    // `Object.is(-0, 0)` は false になるので、`-0` を作らない(タスク22 の申し送り)。
    expect(Object.is(parseDxfNumber('-0.0'), 0)).toBe(true);
  });

  it('空・空白だけ・数でない文字列・16 進・桁あふれを断る', () => {
    // `Number.parseFloat` なら `'1.5abc'` を 1.5 として飲み込んでしまうため、
    // 形を点検してから `Number` へ渡している。
    for (const bad of ['', '   ', 'abc', '1.5abc', '0x10', 'NaN', 'Infinity', '1e400', '1,5']) {
      expect(() => parseDxfNumber(bad)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    }
  });
});

describe('parseDxfInteger', () => {
  it('符号付きの整数を読み、`-0` は `0` へ寄せる', () => {
    expect(parseDxfInteger('70')).toBe(70);
    expect(parseDxfInteger(' +3 ')).toBe(3);
    expect(Object.is(parseDxfInteger('-0'), 0)).toBe(true);
  });

  it('小数点付き・空・数でない文字列を断る', () => {
    // 旗(70)や次数(71)に小数が来るファイルは壊れているため。
    for (const bad of ['1.5', '', 'A', '1e3']) {
      expect(() => parseDxfInteger(bad)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    }
  });
});

describe('bulgeToArc', () => {
  it('bulge = 1 は半円(中心は弦の中点、半径は弦の半分)', () => {
    // `Δθ = 4·atan(1) = π`(180 度)。`r = c·(1+1)/(4·1) = c/2 = 10`。
    // 高さ `= c·(1−1)/(4·1) = 0` なので中心は弦の中点。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, 1);

    expect(arc).not.toBeNull();
    expect(arc?.center).toEqual({ x: 10, y: 0 });
    expect(arc?.radius).toBe(10);
    // 始点 (0,0) は中心 (10,0) から見て 180 度。反時計回りに 180 度回って終点。
    expect(arc?.startAngle).toBe(180);
    expect(arc?.endAngle).toBeCloseTo(360, 12);
  });

  it('bulge = 1 の半円は弦の右(進行方向の右)へふくらむ', () => {
    // 正の bulge は「始点から終点へ**反時計回り**」(DXF の定義)。中心 → 始点のベクトルを
    // +Δθ 回すと中心 → 終点になるので、Δθ = π のとき弧の中点は中心の真下 (10,−10)。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, 1);
    const middle = pointOnArc(arc?.center ?? ORIGIN, arc?.radius ?? 0, 270);

    expect(middle.x).toBeCloseTo(10, 12);
    expect(middle.y).toBeCloseTo(-10, 12);
  });

  it('bulge = −1 は同じ半円を反対回りに回る', () => {
    // 符号だけが変わるので中心と半径は同じ。中心角が −180 度になる。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, -1);

    expect(arc?.center).toEqual({ x: 10, y: 0 });
    expect(arc?.radius).toBe(10);
    expect(arc?.startAngle).toBe(180);
    expect(arc?.endAngle).toBeCloseTo(0, 12);
    // 弧の中点は反対側(弦の左)。
    const middle = pointOnArc(arc?.center ?? ORIGIN, arc?.radius ?? 0, 90);
    expect(middle.y).toBeCloseTo(10, 12);
  });

  it('bulge = tan(22.5°) は中心角 90 度、半径 = 弦 / √2', () => {
    // `Δθ = 4·atan(tan(π/8)) = π/2`。`t² = (√2−1)² = 3 − 2√2` なので
    // `r = 20·(1 + 3 − 2√2) / (4·(√2−1)) = 20·(4 − 2√2)/(4√2 − 4) = 20/√2 = 14.142135623730951`。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, QUARTER_TURN_BULGE);

    expect(arc).not.toBeNull();
    expect(arc?.radius).toBe(14.142135623730951);
    expect(arc?.radius).toBeCloseTo(Math.sqrt(200), 12);
    expect((arc?.endAngle ?? 0) - (arc?.startAngle ?? 0)).toBeCloseTo(90, 12);
  });

  it('bulge = tan(22.5°) の中心は弦の左へ 10(= r·cos(45°))', () => {
    // 高さ `= c·(1 − t²)/(4t) = 20·(2√2 − 2)/(4(√2−1)) = 10`(正なので弦の向きの左)。
    // 弦は (0,0) → (20,0) で左は +y。弦の中点 (10,0) から +y に 10 で中心 (10,10)。
    //
    // 中心が (10,10) であることは定義からも解ける: 中心 → 始点 (−10,−h) を +90 度
    // 回した (h,−10) が 中心 → 終点 (10,−h) と等しいので h = 10。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, QUARTER_TURN_BULGE);

    expect(arc?.center.x).toBeCloseTo(10, 9);
    expect(arc?.center.y).toBeCloseTo(10, 9);
    expect(arc?.startAngle).toBeCloseTo(225, 12);
    expect(arc?.endAngle).toBeCloseTo(315, 12);
  });

  it('bulge = −tan(22.5°) の中心は弦の右(10,−10)', () => {
    // 正の bulge の鏡像。時計回りなので中心角は −90 度。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, -QUARTER_TURN_BULGE);

    expect(arc?.center.x).toBeCloseTo(10, 9);
    expect(arc?.center.y).toBeCloseTo(-10, 9);
    expect((arc?.endAngle ?? 0) - (arc?.startAngle ?? 0)).toBeCloseTo(-90, 12);
  });

  it('bulge = 0 は円弧にならず null(直線区間)', () => {
    // DXF の定義どおり。呼び出し側(タスク24)が線分として扱えるようにする。
    expect(bulgeToArc(ORIGIN, RIGHT_20, 0)).toBeNull();
  });

  it('始点と終点が重なる区間は null(長さ 0 の区間は円弧が決まらない)', () => {
    expect(bulgeToArc(ORIGIN, { x: 0, y: 0 }, 1)).toBeNull();
  });

  it('bulge が極端に大きくても半径が発散しない', () => {
    // `atan` は π/2 で頭打ちなので `Δθ → 2π`。半径は `r = c·(1+t²)/(4t) ≈ c·t/4`
    // で、t = 1e9 なら 20·1e9/4 = 5e9(有限)。
    const arc = bulgeToArc(ORIGIN, RIGHT_20, 1e9);

    expect(arc).not.toBeNull();
    expect(Number.isFinite(arc?.radius ?? Number.NaN)).toBe(true);
    expect(arc?.radius).toBeCloseTo(5e9, 0);
    const sweep = (arc?.endAngle ?? 0) - (arc?.startAngle ?? 0);
    expect(sweep).toBeLessThan(360);
    expect(sweep).toBeGreaterThan(359.999);
  });

  it('どの bulge でも、開始角の点が始点・終了角の点が終点に一致する', () => {
    // 中心・半径・角度の組が元の 2 点と食い違わないことの検算(換算の全体を 1 つで確かめる)。
    const start: DxfPoint2d = { x: -3.5, y: 2 };
    const end: DxfPoint2d = { x: 7, y: -4.25 };
    for (const bulge of [0.25, 1, 2.5, -0.25, -1, -2.5, QUARTER_TURN_BULGE]) {
      const arc = bulgeToArc(start, end, bulge);
      expect(arc).not.toBeNull();
      if (arc === null) {
        continue;
      }
      const atStart = pointOnArc(arc.center, arc.radius, arc.startAngle);
      const atEnd = pointOnArc(arc.center, arc.radius, arc.endAngle);
      expect(atStart.x).toBeCloseTo(start.x, 9);
      expect(atStart.y).toBeCloseTo(start.y, 9);
      expect(atEnd.x).toBeCloseTo(end.x, 9);
      expect(atEnd.y).toBeCloseTo(end.y, 9);
    }
  });

  it('中心角の絶対値は |bulge| が大きいほど大きくなる(0 < |Δθ| < 360)', () => {
    // `Δθ = 4·atan(t)` は単調増加。半円(|t| = 1)を境に 180 度を跨ぐ。
    const sweepOf = (bulge: number): number => {
      const arc = bulgeToArc(ORIGIN, RIGHT_20, bulge);
      return (arc?.endAngle ?? 0) - (arc?.startAngle ?? 0);
    };

    expect(sweepOf(0.1)).toBeCloseTo((4 * Math.atan(0.1) * 180) / Math.PI, 12);
    expect(sweepOf(0.5)).toBeLessThan(sweepOf(1));
    expect(sweepOf(1)).toBeCloseTo(180, 12);
    expect(sweepOf(1)).toBeLessThan(sweepOf(3));
    expect(sweepOf(3)).toBeLessThan(360);
  });

  it('座標や bulge が有限の数でなければ断る', () => {
    // `NaN` の中心・半径を下流(スケッチ)へ流さないため。
    expect(() => bulgeToArc({ x: Number.NaN, y: 0 }, RIGHT_20, 1)).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
    expect(() => bulgeToArc(ORIGIN, { x: 0, y: Number.POSITIVE_INFINITY }, 1)).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
    expect(() => bulgeToArc(ORIGIN, RIGHT_20, Number.NaN)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });
});

describe('ellipseFromDxf', () => {
  it('長軸の端が (20,0)・比 0.5 なら長半径 20・短半径 10・傾き 0', () => {
    // `a = |(20,0)| = 20`、`b = a × 0.5 = 10`、傾き `= atan2(0,20) = 0`。
    // 面積は `π·a·b = π·200 = 628.3185307179587`(換算が正しいことの検算)。
    const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, 0, 2 * Math.PI);

    expect(ellipse.center).toEqual({ x: 0, y: 0 });
    expect(ellipse.majorRadius).toBe(20);
    expect(ellipse.minorRadius).toBe(10);
    expect(ellipse.rotation).toBe(0);
    expect(Math.PI * ellipse.majorRadius * ellipse.minorRadius).toBeCloseTo(628.3185307179587, 10);
  });

  it('媒介変数 0 〜 2π は全周(終了角 − 開始角 = 360 度ちょうど)', () => {
    // 全周の判定(`SketchEllipseFeature` の「差が ±360 なら全周」)へ誤差を持ち込まないよう、
    // 周回数を先に外してから方位角へ直している。
    const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, 0, 2 * Math.PI);

    expect(ellipse.startAngle).toBe(0);
    expect(ellipse.endAngle - ellipse.startAngle).toBe(360);
  });

  it('長軸の端が (0,20) なら傾き 90 度', () => {
    // `atan2(20,0) = π/2`。長半径は 20 のまま。
    const ellipse = ellipseFromDxf(ORIGIN, { x: 0, y: 20 }, 0.5, 0, 2 * Math.PI);

    expect(ellipse.majorRadius).toBe(20);
    expect(ellipse.minorRadius).toBe(10);
    expect(ellipse.rotation).toBeCloseTo(90, 12);
  });

  it('長軸の端が (3,4) なら長半径 5・短半径 2.5・傾き atan2(4,3)', () => {
    // `a = √(9+16) = 5`、`b = 2.5`、傾き `= atan2(4,3) = 53.13010235415598 度`。
    const ellipse = ellipseFromDxf(ORIGIN, { x: 3, y: 4 }, 0.5, 0, 2 * Math.PI);

    expect(ellipse.majorRadius).toBe(5);
    expect(ellipse.minorRadius).toBe(2.5);
    expect(ellipse.rotation).toBeCloseTo(53.13010235415598, 12);
  });

  it('媒介変数 0 〜 π/2 は 4 分の 1(方位角でも 0 〜 90 度)', () => {
    // 座標軸の上では媒介変数と方位角が一致する(`atan2(b·1, a·0) = π/2`)。
    const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, 0, Math.PI / 2);

    expect(ellipse.startAngle).toBe(0);
    expect(ellipse.endAngle).toBeCloseTo(90, 12);
  });

  it('媒介変数は方位角ではない(π/4 の点の方位角は 26.565 度)', () => {
    // 点は `(a·cos t, b·sin t) = (20/√2, 10/√2)`。方位角は `atan2(10, 20) = atan(0.5)`
    // = 26.565051177077986 度。ここを媒介変数のまま渡すと楕円弧の端が別の場所になる。
    const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, Math.PI / 4, Math.PI);

    expect(ellipse.startAngle).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 12);
    expect(ellipse.startAngle).toBeCloseTo(26.565051177077986, 12);
    // 終了の媒介変数 π は長軸の反対側なので方位角も 180 度ちょうど。
    expect(ellipse.endAngle).toBeCloseTo(180, 12);
  });

  it('方位角を model の `azimuthToEllipseParameter` へ戻すと元の媒介変数になる', () => {
    // 写し先(`SketchEllipseFeature`)は方位角で持ち、解決のときに
    // `azimuthToEllipseParameter` で媒介変数へ戻す。往復で元へ戻ることを確かめる
    // (この 2 つが逆関数でないと、読み込んだ楕円弧の端がずれる)。
    const majorRadius = 20;
    const minorRadius = 10;
    for (const parameter of [0.3, 1, 2, 3, 4, 5, 6]) {
      const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, parameter, parameter);
      const azimuthRadians = (ellipse.startAngle * Math.PI) / 180;
      expect(azimuthToEllipseParameter(azimuthRadians, majorRadius, minorRadius)).toBeCloseTo(
        parameter,
        12,
      );
    }
  });

  it('中心はそのまま持ち、`-0` を作らない', () => {
    const ellipse = ellipseFromDxf({ x: 5, y: -3 }, RIGHT_20, 0.5, 0, 2 * Math.PI);

    expect(ellipse.center).toEqual({ x: 5, y: -3 });
    // 傾き 0 度の楕円で `-0` が出ると、往復の比較や文字にしたときに `"-0"` になる。
    expect(Object.is(ellipse.rotation, 0)).toBe(true);
    expect(Object.is(ellipseFromDxf({ x: -0, y: -0 }, RIGHT_20, 1, 0, 0).center.x, 0)).toBe(true);
  });

  it('比が 0 以下・1 超、長軸の長さ 0、有限でない値を断る', () => {
    // DXF の仕様が比を 1 以下と定めており、1 を超えるとどちらが長軸か決まらない。
    expect(() => ellipseFromDxf(ORIGIN, RIGHT_20, 0, 0, 1)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    expect(() => ellipseFromDxf(ORIGIN, RIGHT_20, -0.5, 0, 1)).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
    expect(() => ellipseFromDxf(ORIGIN, RIGHT_20, 1.5, 0, 1)).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
    expect(() => ellipseFromDxf(ORIGIN, ORIGIN, 0.5, 0, 1)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    expect(() => ellipseFromDxf(ORIGIN, RIGHT_20, 0.5, Number.NaN, 1)).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
  });

  it('比 1 は円(長半径 = 短半径。媒介変数と方位角が一致する)', () => {
    const ellipse = ellipseFromDxf(ORIGIN, RIGHT_20, 1, Math.PI / 4, Math.PI / 3);

    expect(ellipse.majorRadius).toBe(20);
    expect(ellipse.minorRadius).toBe(20);
    expect(ellipse.startAngle).toBeCloseTo(45, 12);
    expect(ellipse.endAngle).toBeCloseTo(60, 12);
  });
});

describe('splineFromDxf', () => {
  const controlPoints: readonly DxfPoint2d[] = [
    { x: 0, y: 0 },
    { x: 10, y: 20 },
    { x: 30, y: 20 },
    { x: 40, y: 0 },
  ];

  it('次数 3・制御点 4 個は制御点の版へ写る', () => {
    const spline = splineFromDxf({ degree: 3, controlPoints, closed: false });

    expect(spline.mode).toBe('control');
    expect(spline.points).toEqual(controlPoints);
    expect(spline.closed).toBe(false);
    expect(spline.degree).toBe(3);
    expect(spline.warnings).toEqual([]);
  });

  it('制御点が無くフィット点だけなら通過点の版へ写る', () => {
    // フィット点は「曲線が通る点」なので、`interpolate` の意味と一致する。
    const fitPoints: readonly DxfPoint2d[] = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const spline = splineFromDxf({ degree: 3, controlPoints: [], fitPoints, closed: false });

    expect(spline.mode).toBe('interpolate');
    expect(spline.points).toEqual(fitPoints);
  });

  it('制御点があればフィット点より制御点を採る', () => {
    const spline = splineFromDxf({
      degree: 3,
      controlPoints,
      fitPoints: [{ x: 99, y: 99 }],
      closed: false,
    });

    expect(spline.mode).toBe('control');
    expect(spline.points).toHaveLength(4);
  });

  it('点が 1 つも無ければ断る', () => {
    expect(() => splineFromDxf({ degree: 3, controlPoints: [], closed: false })).toThrow(
      DXF_UNSUPPORTED_FORMAT_MESSAGE,
    );
    expect(() =>
      splineFromDxf({ degree: 3, controlPoints: [], fitPoints: [], closed: false }),
    ).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('1 でない重みがあれば案内を 1 行返す(断らない)', () => {
    // 写し先が重みを持たないので形がわずかに変わる(計画書 §2.7)。
    const spline = splineFromDxf({
      degree: 3,
      controlPoints,
      weights: [1, 0.7071067811865476, 1, 1],
      closed: false,
    });

    expect(spline.points).toHaveLength(4);
    expect(spline.warnings).toEqual([DXF_SPLINE_WEIGHT_IGNORED_MESSAGE]);
  });

  it('重みがすべて 1 なら案内を出さない', () => {
    const spline = splineFromDxf({ degree: 3, controlPoints, weights: [1, 1, 1, 1], closed: false });

    expect(spline.warnings).toEqual([]);
  });

  it('閉じた曲線の末尾が先頭と同じ点なら落とす', () => {
    // `SketchSplineFeature` は「閉じるための重複点は入れない」約束(型定義の注釈)。
    const spline = splineFromDxf({
      degree: 3,
      controlPoints: [...controlPoints, { x: 0, y: 0 }],
      closed: true,
    });

    expect(spline.points).toEqual(controlPoints);
    expect(spline.closed).toBe(true);
  });

  it('開いた曲線では末尾が先頭と同じでも落とさない', () => {
    // 閉じていない曲線が同じ点へ戻ってくるのは利用者が置いた点なので、勝手に消さない。
    const spline = splineFromDxf({
      degree: 3,
      controlPoints: [...controlPoints, { x: 0, y: 0 }],
      closed: false,
    });

    expect(spline.points).toHaveLength(5);
  });

  it('座標の `-0` は `0` へ寄せる', () => {
    const spline = splineFromDxf({
      degree: 1,
      controlPoints: [
        { x: -0, y: -0 },
        { x: 1, y: 1 },
      ],
      closed: false,
    });

    expect(Object.is(spline.points[0].x, 0)).toBe(true);
    expect(Object.is(spline.points[0].y, 0)).toBe(true);
  });

  it('次数が 1 以上の整数でなければ断る', () => {
    for (const degree of [0, -1, 2.5, Number.NaN]) {
      expect(() => splineFromDxf({ degree, controlPoints, closed: false })).toThrow(
        DXF_UNSUPPORTED_FORMAT_MESSAGE,
      );
    }
  });

  it('座標が有限の数でなければ断る', () => {
    expect(() =>
      splineFromDxf({
        degree: 3,
        controlPoints: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }],
        closed: false,
      }),
    ).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });
});
