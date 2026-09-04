import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { discretizeEdge, makeArcEdge, makeCurveEdge, makeSegmentEdge } from './makeSketchEdges.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

/** 折れ線を [x,y,z] の並びへ直す。 */
function toPoints(positions: Float32Array): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    points.push([positions[index], positions[index + 1], positions[index + 2]]);
  }
  return points;
}

/**
 * 折れ線の点が半径 radius の円周の上に乗っていることを確かめる許容量(mm)。
 * 折れ線は Float32Array(有効精度 2^-24 ≒ 5.96e-8 の相対誤差)で返るため、
 * 半径 10mm では成分あたり最大 10 × 5.96e-8 ≒ 6.0e-7 の丸めが乗る。
 * 2026-09-02 の実測での最大ずれは 4.06e-7 mm(倍精度のままなら 3.6e-15 mm)。
 */
const RADIUS_TOLERANCE_MM = 1e-6;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

describe('スケッチの線分の稜線(FR-304)', () => {
  it('線分は始点と終点の 2 点だけの折れ線になる', () => {
    const handle = makeSegmentEdge(oc, [0, 0, 0], [10, 0, 0]);
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      expect(points).toHaveLength(2);
      expect(points[0][0]).toBeCloseTo(0, 6);
      expect(points[0][1]).toBeCloseTo(0, 6);
      expect(points[0][2]).toBeCloseTo(0, 6);
      expect(points[1][0]).toBeCloseTo(10, 6);
      expect(points[1][1]).toBeCloseTo(0, 6);
      expect(points[1][2]).toBeCloseTo(0, 6);
    } finally {
      handle.delete();
    }
  });

  it('3 次元の斜めの線分でも両端の座標がそのまま残る', () => {
    const handle = makeSegmentEdge(oc, [1, 2, 3], [-4, 5.5, 6.25]);
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      expect(points).toHaveLength(2);
      expect(points[0]).toEqual([1, 2, 3]);
      const last = points[points.length - 1];
      expect(last[0]).toBeCloseTo(-4, 6);
      expect(last[1]).toBeCloseTo(5.5, 6);
      expect(last[2]).toBeCloseTo(6.25, 6);
    } finally {
      handle.delete();
    }
  });

  it('始点と終点が重なった線分は理由つきで断る(NFR-RE-1)', () => {
    expect(() => makeSegmentEdge(oc, [1, 2, 3], [1, 2, 3])).toThrow(
      '線分の稜線を作れませんでした。2 点が重なっている可能性があります。',
    );
  });
});

describe('スケッチの円弧の稜線(FR-305、中心+半径+開始角+終了角)', () => {
  it('90 度の円弧は (10,0,0) から (0,10,0) へ回り、全点が半径 10 の円周に乗る', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      // 弦の最大ずれ 0.1mm・半径 10mm なら 1 区間の角度は
      // 2・acos(1 − 0.1/10) = 2・acos(0.99) ≒ 0.2831 ラジアン。
      // 90 度 = 1.5708 ラジアンを割ると約 5.5 区間 → 6〜7 点の見込み(実測 7 点)。
      expect(points.length).toBeGreaterThanOrEqual(4);
      expect(points.length).toBeLessThanOrEqual(60);
      expect(points[0][0]).toBeCloseTo(10, 6);
      expect(points[0][1]).toBeCloseTo(0, 6);
      const last = points[points.length - 1];
      expect(last[0]).toBeCloseTo(0, 6);
      expect(last[1]).toBeCloseTo(10, 6);
      for (const point of points) {
        expect(Math.abs(Math.hypot(point[0], point[1]) - 10)).toBeLessThanOrEqual(
          RADIUS_TOLERANCE_MM,
        );
        expect(point[2]).toBeCloseTo(0, 6);
      }
    } finally {
      handle.delete();
    }
  });

  it('角度の単位はラジアン(0 から π で終点が (-10,0,0) になる)', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      const last = points[points.length - 1];
      // ラジアンなら半周して (-10,0,0)。もし度で解釈されていれば π 度 = 3.14 度で
      // 終点は (9.985, 0.548, 0) となり、この検査は落ちる。
      expect(last[0]).toBeCloseTo(-10, 6);
      expect(last[1]).toBeCloseTo(0, 6);
      // 中ほどの点は最も +Y 側へ膨らむ。度で解釈されていれば y はほぼ 0 のまま。
      const maxY = Math.max(...points.map((point) => point[1]));
      expect(maxY).toBeGreaterThan(9.9);
    } finally {
      handle.delete();
    }
  });

  it('開始角が 0 でない円弧は開始角の位置から始まる(π/2 から π)', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: Math.PI / 2,
      endAngle: Math.PI,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      expect(points[0][0]).toBeCloseTo(0, 6);
      expect(points[0][1]).toBeCloseTo(10, 6);
      const last = points[points.length - 1];
      expect(last[0]).toBeCloseTo(-10, 6);
      expect(last[1]).toBeCloseTo(0, 6);
    } finally {
      handle.delete();
    }
  });

  it('中心をずらした円弧は中心からの距離が半径に等しい', () => {
    const center: [number, number, number] = [5, -3, 2];
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center,
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      expect(points[0][0]).toBeCloseTo(15, 6);
      expect(points[0][1]).toBeCloseTo(-3, 6);
      const last = points[points.length - 1];
      expect(last[0]).toBeCloseTo(5, 6);
      expect(last[1]).toBeCloseTo(7, 6);
      for (const point of points) {
        const distance = Math.hypot(point[0] - center[0], point[1] - center[1]);
        expect(Math.abs(distance - 10)).toBeLessThanOrEqual(RADIUS_TOLERANCE_MM);
        expect(point[2]).toBeCloseTo(2, 6);
      }
    } finally {
      handle.delete();
    }
  });

  it('角度の幅が 2π なら全周の閉じた円になる(§0.a-0.4)', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: 2 * Math.PI,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      // 360 度 ÷ 0.2831 ラジアン ≒ 22 区間。始点と終点はほぼ同じ位置に戻る(実測 24 点)。
      expect(points.length).toBeGreaterThanOrEqual(8);
      const first = points[0];
      const last = points[points.length - 1];
      expect(
        Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]),
      ).toBeLessThanOrEqual(RADIUS_TOLERANCE_MM);
      for (const point of points) {
        expect(Math.abs(Math.hypot(point[0], point[1]) - 10)).toBeLessThanOrEqual(
          RADIUS_TOLERANCE_MM,
        );
      }
      // 全周は BRepBuilderAPI_MakeEdge_8(角度を渡さない版)で作るので、
      // 折れ線の始まりは開始角ではなく第1軸の向き (10,0,0) になる。
      expect(first[0]).toBeCloseTo(10, 6);
      expect(first[1]).toBeCloseTo(0, 6);
    } finally {
      handle.delete();
    }
  });

  it('開始角をずらした全周も同じ閉じた円になる(全周は開始角に依らない)', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: Math.PI / 2,
      endAngle: Math.PI / 2 + 2 * Math.PI,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      expect(points.length).toBeGreaterThanOrEqual(8);
      expect(points[0][0]).toBeCloseTo(10, 6);
      expect(points[0][1]).toBeCloseTo(0, 6);
    } finally {
      handle.delete();
    }
  });

  it('作図面が変わると円弧の向きも変わる(XZ 平面: 法線 (0,-1,0)、第1軸 (1,0,0))', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, -1, 0],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge));
      // 第2軸は normal × xAxis = (0,-1,0)×(1,0,0) = (0,0,1)。終点は (0,0,10)。
      expect(points[0][0]).toBeCloseTo(10, 6);
      expect(points[0][2]).toBeCloseTo(0, 6);
      const last = points[points.length - 1];
      expect(last[0]).toBeCloseTo(0, 6);
      expect(last[2]).toBeCloseTo(10, 6);
      for (const point of points) {
        expect(point[1]).toBeCloseTo(0, 6);
        expect(Math.abs(Math.hypot(point[0], point[2]) - 10)).toBeLessThanOrEqual(
          RADIUS_TOLERANCE_MM,
        );
      }
    } finally {
      handle.delete();
    }
  });

  it('半径が 0 以下なら理由つきで断る(NFR-RE-1)', () => {
    expect(() =>
      makeArcEdge(oc, {
        kind: 'arc',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
        radius: 0,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toThrow('円弧の半径は正の数である必要があります: 0');
    expect(() =>
      makeArcEdge(oc, {
        kind: 'arc',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
        radius: -2.5,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toThrow('円弧の半径は正の数である必要があります: -2.5');
  });
});

describe('曲線の指定からの振り分けと折れ線の細かさ', () => {
  it('makeCurveEdge は線分と円弧を kind で振り分ける', () => {
    const segment = makeCurveEdge(oc, { kind: 'segment', from: [0, 0, 0], to: [0, 8, 0] });
    try {
      const points = toPoints(discretizeEdge(oc, segment.edge));
      expect(points).toHaveLength(2);
      expect(points[1][1]).toBeCloseTo(8, 6);
    } finally {
      segment.delete();
    }

    const arc = makeCurveEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const points = toPoints(discretizeEdge(oc, arc.edge));
      expect(points.length).toBeGreaterThan(2);
      const last = points[points.length - 1];
      expect(last[1]).toBeCloseTo(10, 6);
    } finally {
      arc.delete();
    }
  });

  it('makeCurveEdge は楕円を makeEllipseEdge へ振り分ける(FR-318、タスク5)', () => {
    // 角度を渡さないので全周の楕円になる。長軸 20・短軸 10。
    const handle = makeCurveEdge(oc, {
      kind: 'ellipse',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
    });
    try {
      const points = toPoints(discretizeEdge(oc, handle.edge, { linearDeflection: 0.001 }));
      expect(points.length).toBeGreaterThan(8);
      for (const point of points) {
        // (x/20)² + (y/10)² = 1 の上に乗っている(Float32 の丸めぶんだけ許す)。
        expect((point[0] / 20) ** 2 + (point[1] / 10) ** 2).toBeCloseTo(1, 5);
        expect(point[2]).toBeCloseTo(0, 6);
      }
    } finally {
      handle.delete();
    }
  });

  it('makeCurveEdge はスプラインを makeSplineEdge へ振り分ける(FR-317、タスク5)', () => {
    const points: [number, number, number][] = [
      [0, 0, 0],
      [10, 5, 0],
      [20, 0, 0],
      [30, 5, 0],
    ];
    const handle = makeCurveEdge(oc, {
      kind: 'spline',
      mode: 'interpolate',
      points,
      closed: false,
    });
    try {
      const polyline = toPoints(discretizeEdge(oc, handle.edge, { linearDeflection: 0.001 }));
      expect(polyline.length).toBeGreaterThan(4);
      // 通過点方式なので、両端は与えた最初と最後の点にぴったり来る。
      expect(polyline[0][0]).toBeCloseTo(0, 6);
      expect(polyline[0][1]).toBeCloseTo(0, 6);
      const last = polyline[polyline.length - 1];
      expect(last[0]).toBeCloseTo(30, 6);
      expect(last[1]).toBeCloseTo(5, 6);
    } finally {
      handle.delete();
    }
  });

  it('弦の最大ずれを小さくすると折れ線の点が増える', () => {
    const handle = makeArcEdge(oc, {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const coarse = toPoints(discretizeEdge(oc, handle.edge));
      const fine = toPoints(
        discretizeEdge(oc, handle.edge, { linearDeflection: 0.001, angularDeflection: 0.5 }),
      );
      // 既定は linearDeflection 0.1mm で実測 7 点、0.001mm では実測 57 点。
      expect(fine.length).toBeGreaterThan(coarse.length);
      expect(fine.length).toBeGreaterThanOrEqual(20);
      for (const point of fine) {
        expect(Math.abs(Math.hypot(point[0], point[1]) - 10)).toBeLessThanOrEqual(
          RADIUS_TOLERANCE_MM,
        );
      }
    } finally {
      handle.delete();
    }
  });
});
