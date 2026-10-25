import { describe, expect, it } from 'vitest';

import type { SolidBody, SolidEdgeEntry } from '../../kernelBridge.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { RigidPlacement } from '../placementMath.js';
import { weldTestBox } from './filletWeld.testSupport.js';
import { WELD_LENGTH_TOLERANCE_MM } from './types.js';
import { footprintContact, type WeldFootprint } from './weldContact.js';

const IDENTITY: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** 底板の上面 z=10 の上の足元: x 10〜30、y 34〜40(`shift` だけ平行に動かせる)。 */
function footprint(shift: Vec3 = [0, 0, 0]): WeldFootprint {
  return { corner: [10 + shift[0], 34 + shift[1], 10 + shift[2]], along: [1, 0, 0], across: [0, 1, 0], length: 20, width: 6 };
}

/**
 * 曲線の辺を 1 本足す。表示用の折れ線は始点と終点を結ぶ弦 1 本だけ(実カーネルの粗い分割と同じく、弦が
 * 曲線からどれだけずれるかの保証は無い)。弧の長さ `length` が弦より長いので、本物の曲線は弦から膨らみうる。
 */
function withCurve(body: SolidBody, kind: 'ellipse' | 'other', start: Vec3, end: Vec3, length: number): SolidBody {
  const segmentOffset = body.mesh.edgePositions.length / 6;
  const edge: SolidEdgeEntry = {
    index: body.edges.length, curveKind: kind, length, start, end,
    midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
    axis: null, radius: null, segmentOffset, segmentCount: 1,
  };
  return { ...body, edges: [...body.edges, edge],
    mesh: { ...body.mesh, edgePositions: new Float32Array([...body.mesh.edgePositions, ...start, ...end]) } };
}

const BASE = weldTestBox([0, 0, 0], [100, 60, 10]);

describe('保証の無い曲線の境界は、表示の弦では横切らないと証明しない', () => {
  it.each(['ellipse', 'other'] as const)('弦が足元を外れても、%s の弧が足元に届きうるなら判定できないとして断る', (kind) => {
    // 弦は y=41(足元 y≤40 の外)。弦 16 に対して弧の長さ 20 なので、曲線は弦から約 6 mm まで膨らみうる
    // (例: 中央で y=35 まで下がる切り欠き)。以前の判定は弦だけを見て「横切らない」としていた。
    const notched = withCurve(BASE, kind, [12, 41, 10], [28, 41, 10], 20);
    expect(footprintContact([notched], IDENTITY, footprint())).toEqual({ code: 'contactUndecidable', reason: 'unsupportedCurveNear', coveredRatio: null });
  });

  it('弧の長さの半分の球が足元に届かない曲線は、横切らないと証明できるので当たりを妨げない', () => {
    // 弦の中点 (20,55,10) から足元まで 15 mm、弧の長さ 18 の半分は 9 mm。
    const far = withCurve(BASE, 'ellipse', [12, 55, 10], [28, 55, 10], 18);
    const result = footprintContact([far], IDENTITY, footprint());
    expect(result.code).toBeNull();
    expect(result.coveredRatio).toBeCloseTo(1, 9);
  });
});

describe('平面の一致は解析の値と溶接の許容差で見る(表示の Float32 の誤差で広げない)', () => {
  const FAR: Vec3 = [1e6, 1e6, 0];
  const box = (gap: number, origin?: Vec3): SolidBody =>
    weldTestBox([FAR[0], FAR[1], 0], [FAR[0] + 100, FAR[1] + 60, 10 + gap], origin === undefined ? {} : { origin });

  it.each([0.01, 5e-5])('座標 1e6 mm の世界の座標系で、%s mm 離れた平行な面を当たりとしない', (gap) => {
    // 以前は表示の誤差(1e6 × 2^-22 ≈ 0.24 mm)で平面の一致を見ていたので、この面を当たりとしていた。
    expect(footprintContact([box(gap)], IDENTITY, footprint(FAR))).toEqual({ code: 'contactNotCovered', reason: 'noFaceOnPlane', coveredRatio: 0 });
  });

  it.each([0.01, 5e-5])('同じ形を局所の座標系で持っても、%s mm 離れた平行な面を当たりとしない', (gap) => {
    // 局所の座標系の表示の誤差は 1e-4 mm。以前はこれで 5e-5 mm の隙間を当たりとしていた。
    expect(footprintContact([box(gap, FAR)], IDENTITY, footprint(FAR))).toEqual({ code: 'contactNotCovered', reason: 'noFaceOnPlane', coveredRatio: 0 });
  });

  it('許容差の内(その半分)の一致は、局所の座標系なら当たりにする', () => {
    const result = footprintContact([box(WELD_LENGTH_TOLERANCE_MM / 2, FAR)], IDENTITY, footprint(FAR));
    expect(result.code).toBeNull();
    expect(result.coveredRatio).toBeCloseTo(1, 6);
  });

  it('世界の座標系の 1e6 mm では表示が粗すぎて内外を区別できないので、ぴったりの面でも判定できないとして断る', () => {
    // 表示の点の誤差 ≈ 0.24 mm × 周 52 mm ≥ 面積 120 mm² の 1%。覆う割合だけで当たりにしない。
    expect(footprintContact([box(0)], IDENTITY, footprint(FAR))).toEqual({ code: 'contactUndecidable', reason: 'meshTooCoarse', coveredRatio: null });
  });
});
