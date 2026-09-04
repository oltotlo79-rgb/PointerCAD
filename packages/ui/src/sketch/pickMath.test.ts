import { describe, expect, it } from 'vitest';
import { DEFAULT_FACE_COLOR, type ResolvedSketch, type Vec3 } from '@pointercad/model';

import {
  distanceToSegment2d, isInsidePolygon2d, PICK_RADIUS_PIXELS, pickSketchElement,
} from './pickMath.js';

const project = (point: Vec3): readonly [number, number] => [point[0], point[1]];

const SKETCH: ResolvedSketch = {
  points: [{ id: 'p1', featureId: 'p1', position: [0, 0, 0] }],
  segments: [
    // 点 p1 と端点を共有する線。点を優先することを確かめるために置く。
    { kind: 'segment', featureId: 'l0', from: [0, 0, 0], to: [0, 20, 0] },
    { kind: 'segment', featureId: 'l1', from: [20, 0, 0], to: [20, 20, 0] },
  ],
  arcs: [
    {
      kind: 'arc', featureId: 'a1', center: [100, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
      radius: 10, startAngle: 0, endAngle: Math.PI / 2,
    },
  ],
  ellipses: [],
  splines: [],
  faces: [
    {
      featureId: 'f1',
      color: DEFAULT_FACE_COLOR,
      curves: [
        { kind: 'segment', featureId: 'f1', from: [50, 0, 0], to: [70, 0, 0] },
        { kind: 'segment', featureId: 'f1', from: [70, 0, 0], to: [70, 20, 0] },
        { kind: 'segment', featureId: 'f1', from: [70, 20, 0], to: [50, 20, 0] },
        { kind: 'segment', featureId: 'f1', from: [50, 20, 0], to: [50, 0, 0] },
      ],
    },
  ],
  errors: [],
};

describe('選択の当たり判定(FR-106)', () => {
  it('画面座標での点と線分の距離', () => {
    // 垂線の足が線分の内側(比 0.5)に落ちるので、そのまま垂線の長さ。
    expect(distanceToSegment2d([5, 5], [0, 0], [10, 0])).toBe(5);
    // 線分の外側(比 −0.3 → 0 に丸め)は端点 (0,0) までの距離 √(9+16) = 5。
    expect(distanceToSegment2d([-3, 4], [0, 0], [10, 0])).toBe(5);
    // 長さ 0 の線分はその点までの距離。
    expect(distanceToSegment2d([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it('多角形の内外判定', () => {
    const square: (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(isInsidePolygon2d([5, 5], square)).toBe(true);
    expect(isInsidePolygon2d([15, 5], square)).toBe(false);
    expect(isInsidePolygon2d([5, 15], square)).toBe(false);
  });

  it('点を最優先で拾う', () => {
    // (1,1) からは 線 l0 まで 1.0、点 p1 まで √2 ≈ 1.414。線の方が近いが点を先に取る。
    expect(pickSketchElement(SKETCH, project, [1, 1])).toEqual({
      kind: 'point', featureId: 'p1', elementId: 'p1',
    });
  });

  it('線の近くでは線を拾う', () => {
    // (22,10) から l1(x = 20 の縦線)まで 2、l0 まで 22、点 p1 まで √584 ≈ 24.2。
    expect(pickSketchElement(SKETCH, project, [22, 10])).toEqual({
      kind: 'curve', featureId: 'l1', elementId: 'l1',
    });
  });

  it('円弧の近くでは円弧を拾う', () => {
    // 中心 (100,0)・半径 10 の円弧。(107,7) は中心から √98 ≈ 9.899 なので弧まで約 0.10。
    // 折れ線に落とした分のたわみ(10 × (1 − cos(90°/16/2)) ≈ 0.012)を足しても半径 6 の中。
    expect(pickSketchElement(SKETCH, project, [107, 7])).toEqual({
      kind: 'curve', featureId: 'a1', elementId: 'a1',
    });
  });

  it('面の内側では面を拾い、どこにも当たらなければ null', () => {
    expect(PICK_RADIUS_PIXELS).toBe(6);
    // (60,10) は x が 50〜70、y が 0〜20 の四角の内側。線や円弧までは 40 以上離れている。
    expect(pickSketchElement(SKETCH, project, [60, 10])).toEqual({
      kind: 'face', featureId: 'f1', elementId: 'f1',
    });
    expect(pickSketchElement(SKETCH, project, [200, 200])).toBeNull();
  });

  it('楕円とスプラインも曲線として拾える(FR-317、FR-318、P4 タスク12)', () => {
    const withCurves: ResolvedSketch = {
      ...SKETCH,
      ellipses: [
        {
          kind: 'ellipse',
          featureId: 'e1',
          center: [200, 0, 0],
          normal: [0, 0, 1],
          majorAxis: [1, 0, 0],
          majorRadius: 20,
          minorRadius: 10,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      splines: [
        {
          kind: 'spline',
          featureId: 's1',
          mode: 'control',
          points: [
            [300, 0, 0],
            [310, 0, 0],
            [320, 0, 0],
          ],
          closed: false,
        },
      ],
    };
    // 楕円の長軸の端(220, 0)。
    expect(pickSketchElement(withCurves, project, [220, 0])).toEqual({
      kind: 'curve', featureId: 'e1', elementId: 'e1',
    });
    // 制御点方式のスプラインは 3 点が一直線なので、その線の上を拾える。
    expect(pickSketchElement(withCurves, project, [310, 0])).toEqual({
      kind: 'curve', featureId: 's1', elementId: 's1',
    });
  });

  it('判定半径は引数で変えられる', () => {
    // (30,10) は l1 まで 10。既定の 6 では当たらないが、12 なら当たる。
    expect(pickSketchElement(SKETCH, project, [30, 10])).toBeNull();
    expect(pickSketchElement(SKETCH, project, [30, 10], 12)).toEqual({
      kind: 'curve', featureId: 'l1', elementId: 'l1',
    });
  });
});
