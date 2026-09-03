import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { HelixSpec } from './makeHelix.js';
import {
  helixArcLength,
  helixAxisFrame,
  helixParameterLength,
  helixStartFrame,
  makeHelixEdge,
  makeHelixWire,
} from './makeHelix.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 曲線の長さ(mm)。BRepGProp.LinearProperties の Mass がそのまま長さになる。 */
function measureLength(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const properties = new oc.GProp_GProps_1();
  try {
    // 第 3・第 4 引数は SkipShared と UseTriangulation。厳密な曲線から測る。
    oc.BRepGProp.LinearProperties(shape, properties, false, false);
    return properties.Mass();
  } finally {
    properties.delete();
  }
}

function helix(overrides: Partial<HelixSpec> = {}): HelixSpec {
  return {
    origin: [0, 0, 0],
    direction: [0, 0, 1],
    radius: 10,
    pitch: 5,
    turns: 4,
    handedness: 'right',
    ...overrides,
  };
}

function expectClose(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

describe('らせんの数値(OCCT を使わない純関数)', () => {
  it('helixParameterLength は 巻数 × 2π × √(1 + (pitch/2π)²)', () => {
    expectClose(helixParameterLength(1, 1), 6.362265132);
    expectClose(helixParameterLength(5, 1), 8.029845428);
    expectClose(helixParameterLength(5, 4), 32.119381714);
    // ねじのピッチ 1.25 / 1.5(§2.4.2 の検算値)。
    expectClose(helixParameterLength(1.25, 1), 6.406318569);
    expectClose(helixParameterLength(1.5, 1), 6.45975368);
  });

  it('helixParameterLength は巻数に比例する', () => {
    expectClose(helixParameterLength(5, 4), helixParameterLength(5, 1) * 4);
  });

  it('helixArcLength は 巻数 × √((2π·半径)² + pitch²)', () => {
    expectClose(helixArcLength(10, 5, 1), 63.030482788);
    expectClose(helixArcLength(10, 5, 4), 252.12193115);
    expectClose(helixArcLength(5, 3, 5), 157.794204592);
  });

  it('helixParameterLength は半径に依らない(u は角度で長さではない)', () => {
    // 引数に半径が無いことを、らせんの 3D の長さが半径で変わることと対比して固定する。
    expect(helixArcLength(10, 5, 4)).not.toBeCloseTo(helixArcLength(20, 5, 4), 6);
    expectClose(helixParameterLength(5, 4), 32.119381714);
  });

  it('0 や負を渡しても式のまま返す(値の妥当性は呼び出し側が断る)', () => {
    expectClose(helixParameterLength(0, 1), Math.PI * 2);
    expectClose(helixParameterLength(5, 0), 0);
    expectClose(helixArcLength(10, 5, 0), 0);
    expectClose(helixArcLength(0, 5, 1), 5);
    expect(helixParameterLength(5, -1)).toBeLessThan(0);
  });

  it('helixStartFrame は軸から半径ぶん離れた点と、軸成分 0.079326697 の接線を返す', () => {
    const { point, tangent } = helixStartFrame(helix());
    expect(point[0]).toBeCloseTo(10, 12);
    expect(point[1]).toBeCloseTo(0, 12);
    expect(point[2]).toBeCloseTo(0, 12);
    // 接線 = (R·ŷ + (p/2π)·ẑ) の正規化。ẑ 成分 = p/√((2πR)² + p²) = 5/63.030482788。
    expect(Math.hypot(tangent[0], tangent[1], tangent[2])).toBeCloseTo(1, 12);
    expectClose(tangent[2], 5 / 63.030482788, 1e-9);
    expect(tangent[0]).toBeCloseTo(0, 12);
    expect(tangent[1]).toBeGreaterThan(0);
  });

  it('左巻きは接線の ŷ 成分だけが反転し、軸成分は同じ', () => {
    const right = helixStartFrame(helix());
    const left = helixStartFrame(helix({ handedness: 'left' }));
    expect(left.point).toEqual(right.point);
    expectClose(left.tangent[1], -right.tangent[1], 1e-12);
    expectClose(left.tangent[2], right.tangent[2], 1e-12);
  });

  it('helixAxisFrame は右手系で、同じ軸なら必ず同じ第 1 軸を返す', () => {
    const frame = helixAxisFrame([0, 0, 1]);
    expect(frame).not.toBeNull();
    if (frame === null) {
      return;
    }
    expect(frame.xAxis).toEqual([1, 0, 0]);
    expect(frame.yAxis).toEqual([0, 1, 0]);
    expect(frame.zAxis).toEqual([0, 0, 1]);
    // ẑ × x̂ = ŷ(右手系)。
    const again = helixAxisFrame([0, 0, 2]);
    expect(again?.xAxis).toEqual(frame.xAxis);
  });

  it('軸の向きが決まらなければ断る', () => {
    expect(helixAxisFrame([0, 0, 0])).toBeNull();
    expect(() => helixStartFrame(helix({ direction: [0, 0, 0] }))).toThrow(/らせんの軸の向き/);
  });
});

describe('らせんの辺とワイヤ(FR-406、FR-414)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('らせんの辺の長さが helixArcLength と一致する(3D 曲線が付いている証拠)', () => {
    const { keep, release } = createAllocations();
    try {
      const spec = helix();
      const edge = makeHelixEdge(oc, spec, keep);
      // 3D 曲線が付いていなければ長さは 0 か測れない。相対 1e-6 は円柱面上の
      // 直線を厳密に積分した値との差で、近似は入らない。
      const expected = helixArcLength(spec.radius, spec.pitch, spec.turns);
      expect(Math.abs(measureLength(oc, edge) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      release();
    }
  });

  it('左巻きでも長さは同じ(向きだけが違う)', () => {
    const { keep, release } = createAllocations();
    try {
      const right = measureLength(oc, makeHelixEdge(oc, helix(), keep));
      const left = measureLength(oc, makeHelixEdge(oc, helix({ handedness: 'left' }), keep));
      expect(Math.abs(left - right) / right).toBeLessThan(1e-9);
    } finally {
      release();
    }
  });

  it('らせんのワイヤは掃引路になる長さを持つ', () => {
    const { keep, release } = createAllocations();
    try {
      const spec = helix({ radius: 5, pitch: 3, turns: 5 });
      const wire = makeHelixWire(oc, spec, keep);
      const expected = helixArcLength(spec.radius, spec.pitch, spec.turns);
      expect(Math.abs(measureLength(oc, wire) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      release();
    }
  });

  it('らせんの辺の始点と終点が、計算した位置と一致する(断面をここへ置く)', () => {
    const { keep, release } = createAllocations();
    try {
      const spec = helix({ radius: 5, pitch: 3, turns: 5 });
      const edge = makeHelixEdge(oc, spec, keep);
      const start = helixStartFrame(spec).point;

      const firstVertex = keep(oc.TopExp.FirstVertex(edge, false));
      const first = keep(oc.BRep_Tool.Pnt(firstVertex));
      const firstPoint: Vec3Tuple = [first.X(), first.Y(), first.Z()];
      expect(firstPoint[0]).toBeCloseTo(start[0], 9);
      expect(firstPoint[1]).toBeCloseTo(start[1], 9);
      expect(firstPoint[2]).toBeCloseTo(start[2], 9);

      // 終点は軸方向に ピッチ×巻数 だけ進み、角度は 2π×巻数(= 5 周)ぶん回るので
      // 始点と同じ半径・同じ方位に戻る。
      const lastVertex = keep(oc.TopExp.LastVertex(edge, false));
      const last = keep(oc.BRep_Tool.Pnt(lastVertex));
      expect(last.X()).toBeCloseTo(start[0], 6);
      expect(last.Y()).toBeCloseTo(start[1], 6);
      expect(last.Z()).toBeCloseTo(start[2] + spec.pitch * spec.turns, 6);
    } finally {
      release();
    }
  });

  it('半径・ピッチ・巻数が 0 以下なら断る', () => {
    const { keep, release } = createAllocations();
    try {
      expect(() => makeHelixEdge(oc, helix({ radius: 0 }), keep)).toThrow(/0 より大きい数/);
      expect(() => makeHelixEdge(oc, helix({ pitch: 0 }), keep)).toThrow(/0 より大きい数/);
      expect(() => makeHelixEdge(oc, helix({ turns: 0 }), keep)).toThrow(/0 より大きい数/);
      expect(() => makeHelixEdge(oc, helix({ turns: Number.NaN }), keep)).toThrow(/0 より大きい数/);
    } finally {
      release();
    }
  });

  it('軸が 0 ベクトルなら断る', () => {
    const { keep, release } = createAllocations();
    try {
      expect(() => makeHelixWire(oc, helix({ direction: [0, 0, 0] }), keep)).toThrow(
        /らせんの軸の向き/,
      );
    } finally {
      release();
    }
  });
});
