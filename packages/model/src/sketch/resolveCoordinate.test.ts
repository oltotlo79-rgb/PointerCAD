import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { WORK_PLANES } from './planeMath.js';
import {
  LATITUDE_RANGE_MESSAGE,
  MISSING_SPHERE_MESSAGE,
  resolveCoordinate,
  resolvePointReference,
  sphereGridPosition,
  vertexKey,
  type ResolveContext,
  type ResolvedSphere,
  type ResolveOutcome,
} from './resolveCoordinate.js';
import type { CoordinateInput, PointReference } from './types.js';
import type { Vec3 } from './vec3.js';

/**
 * 解決済みの手掛かり。履歴をたどるのはタスク11 の担当なので、
 * ここでは「そこまでに解決できたもの」を手で組み立てて渡す。
 */
const CONTEXT: ResolveContext = {
  plane: WORK_PLANES.xy,
  points: [
    { id: 'point-1', featureId: 'point-1', position: [10, 20, 30] },
    { id: 'pointArray-2#1', featureId: 'pointArray-2', position: [0, 0, 5] },
  ],
  previous: [1, 2, 3],
  vertices: new Map<string, Vec3>([
    ['line-3:start', [1, 0, 0]],
    ['line-3:end', [5, 5, 0]],
    ['arc-4:center', [0, 0, 7]],
    ['arc-4:start', [2, 0, 7]],
    ['arc-4:end', [0, 2, 7]],
  ]),
};

function expectOk(outcome: ResolveOutcome<Vec3>): Vec3 {
  if (!outcome.ok) {
    throw new Error(`解決に失敗しました: ${outcome.error.code} ${outcome.error.message}`);
  }
  return outcome.value;
}

/** 三成分をそれぞれ許容誤差つきで見る。sin・cos は厳密な 0 や 1 にならないため。 */
function expectCloseTo(actual: Vec3, expected: Vec3, digits = 12): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe('座標の解決(FR-301〜303)', () => {
  it('絶対座標はそのまま使う(FR-301)', () => {
    const input: CoordinateInput = { mode: 'absolute', x: num(1), y: num(2), z: num(3) };
    expect(expectOk(resolveCoordinate(input, CONTEXT, 'point-9'))).toEqual([1, 2, 3]);

    // 負値・小数もそのまま。式の評価値(ExpressionValue.value)だけを見る。
    const decimals: CoordinateInput = {
      mode: 'absolute',
      x: num(-1.5),
      y: num(0),
      z: num(12.25),
    };
    expect(expectOk(resolveCoordinate(decimals, CONTEXT, 'point-9'))).toEqual([-1.5, 0, 12.25]);
  });

  it('基準は原点・直前の点・任意の点・要素の端点から選べる(FR-302)', () => {
    expect(expectOk(resolvePointReference({ kind: 'origin' }, CONTEXT, 'f1'))).toEqual([0, 0, 0]);
    expect(expectOk(resolvePointReference({ kind: 'previous' }, CONTEXT, 'f1'))).toEqual([1, 2, 3]);
    expect(
      expectOk(resolvePointReference({ kind: 'point', pointId: 'point-1' }, CONTEXT, 'f1')),
    ).toEqual([10, 20, 30]);
    // 点列の n 番目は `featureId#n` の id で指せる(§2.6)。
    expect(
      expectOk(resolvePointReference({ kind: 'point', pointId: 'pointArray-2#1' }, CONTEXT, 'f1')),
    ).toEqual([0, 0, 5]);
  });

  it('要素の端点は start・end・center を指せる(FR-302)', () => {
    const start = resolvePointReference(
      { kind: 'vertex', featureId: 'line-3', vertex: 'start' },
      CONTEXT,
      'f1',
    );
    const end = resolvePointReference(
      { kind: 'vertex', featureId: 'line-3', vertex: 'end' },
      CONTEXT,
      'f1',
    );
    const center = resolvePointReference(
      { kind: 'vertex', featureId: 'arc-4', vertex: 'center' },
      CONTEXT,
      'f1',
    );
    const arcStart = resolvePointReference(
      { kind: 'vertex', featureId: 'arc-4', vertex: 'start' },
      CONTEXT,
      'f1',
    );
    const arcEnd = resolvePointReference(
      { kind: 'vertex', featureId: 'arc-4', vertex: 'end' },
      CONTEXT,
      'f1',
    );
    expect(expectOk(start)).toEqual([1, 0, 0]);
    expect(expectOk(end)).toEqual([5, 5, 0]);
    expect(expectOk(center)).toEqual([0, 0, 7]);
    expect(expectOk(arcStart)).toEqual([2, 0, 7]);
    expect(expectOk(arcEnd)).toEqual([0, 2, 7]);
  });

  it('端点の鍵は `featureId:vertex` の形(タスク11 が同じ形で組み立てる)', () => {
    expect(vertexKey('line-3', 'end')).toBe('line-3:end');
    expect(CONTEXT.vertices.get(vertexKey('arc-4', 'center'))).toEqual([0, 0, 7]);
  });

  it('相対座標は基準へ (dx, dy, dz) を足す(FR-302)', () => {
    // 直前の点 (1,2,3) + (10,0,0) = (11,2,3)
    const fromPrevious: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: num(10),
      dy: num(0),
      dz: num(0),
    };
    expect(expectOk(resolveCoordinate(fromPrevious, CONTEXT, 'f1'))).toEqual([11, 2, 3]);

    // 原点 (0,0,0) + (7,8,9) = (7,8,9)
    const fromOrigin: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'origin' },
      dx: num(7),
      dy: num(8),
      dz: num(9),
    };
    expect(expectOk(resolveCoordinate(fromOrigin, CONTEXT, 'f1'))).toEqual([7, 8, 9]);

    // 点 point-1 (10,20,30) + (0,-5,2.5) = (10,15,32.5)
    const fromPoint: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'point', pointId: 'point-1' },
      dx: num(0),
      dy: num(-5),
      dz: num(2.5),
    };
    expect(expectOk(resolveCoordinate(fromPoint, CONTEXT, 'f1'))).toEqual([10, 15, 32.5]);

    // 線分の終点 (5,5,0) + (-5,0,3) = (0,5,3)
    const fromVertex: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'vertex', featureId: 'line-3', vertex: 'end' },
      dx: num(-5),
      dy: num(0),
      dz: num(3),
    };
    expect(expectOk(resolveCoordinate(fromVertex, CONTEXT, 'f1'))).toEqual([0, 5, 3]);

    // 円弧の中心 (0,0,7) + (0,0,-7) = (0,0,0)
    const fromCenter: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'vertex', featureId: 'arc-4', vertex: 'center' },
      dx: num(0),
      dy: num(0),
      dz: num(-7),
    };
    expect(expectOk(resolveCoordinate(fromCenter, CONTEXT, 'f1'))).toEqual([0, 0, 0]);
  });

  it('極座標は XY 面では U=(1,0,0)・V=(0,1,0) に従う(FR-303)', () => {
    // 距離 10・角度 0°・仰角 0° → U 方向へ 10 = (10, 0, 0)
    const east: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(0),
      elevation: num(0),
    };
    expectCloseTo(expectOk(resolveCoordinate(east, CONTEXT, 'f1')), [10, 0, 0]);

    // 角度 90° → V 方向へ 10 = (0, 10, 0)
    const north: CoordinateInput = { ...east, azimuth: num(90) };
    expectCloseTo(expectOk(resolveCoordinate(north, CONTEXT, 'f1')), [0, 10, 0]);

    // 角度 45° → 10·cos45° = 10/√2 = 7.0710678118654755 が U・V 双方へ
    const diagonal: CoordinateInput = { ...east, azimuth: num(45) };
    expectCloseTo(expectOk(resolveCoordinate(diagonal, CONTEXT, 'f1')), [
      7.0710678118654755,
      7.0710678118654755,
      0,
    ]);
  });

  it('極座標の仰角は作図面の法線側へ持ち上げる(FR-303)', () => {
    // XY 面の法線は (0,0,1)。距離 10・角度 0°・仰角 30° は
    // 水平成分 10·cos30° = 5√3 = 8.660254037844387、法線成分 10·sin30° = 5。
    const lifted: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(0),
      elevation: num(30),
    };
    expectCloseTo(expectOk(resolveCoordinate(lifted, CONTEXT, 'f1')), [
      8.660254037844387,
      0,
      5,
    ]);
  });

  it('極座標は XZ 面では U=(1,0,0)・V=(0,0,1)・N=(0,-1,0) に従う(§2.8)', () => {
    const context: ResolveContext = { ...CONTEXT, plane: WORK_PLANES.xz };
    const base: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(0),
      elevation: num(0),
    };
    // 角度 0° → U へ 10 = (10, 0, 0)
    expectCloseTo(expectOk(resolveCoordinate(base, context, 'f1')), [10, 0, 0]);
    // 角度 90° → V(=+Z)へ 10 = (0, 0, 10)
    expectCloseTo(
      expectOk(resolveCoordinate({ ...base, azimuth: num(90) }, context, 'f1')),
      [0, 0, 10],
    );
    // 角度 45° → 10/√2 = 7.0710678118654755 が X と Z へ
    expectCloseTo(expectOk(resolveCoordinate({ ...base, azimuth: num(45) }, context, 'f1')), [
      7.0710678118654755,
      0,
      7.0710678118654755,
    ]);
    // 仰角 30° は法線 (0,-1,0) 側なので Y が -5 になる(10·sin30° = 5)。
    // 水平成分は 10·cos30° = 8.660254037844387。
    expectCloseTo(expectOk(resolveCoordinate({ ...base, elevation: num(30) }, context, 'f1')), [
      8.660254037844387,
      -5,
      0,
    ]);
  });

  it('極座標は YZ 面では U=(0,1,0)・V=(0,0,1)・N=(1,0,0) に従う(§2.8)', () => {
    const context: ResolveContext = { ...CONTEXT, plane: WORK_PLANES.yz };
    const base: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(0),
      elevation: num(0),
    };
    // 角度 0° → U(=+Y)へ 10 = (0, 10, 0)
    expectCloseTo(expectOk(resolveCoordinate(base, context, 'f1')), [0, 10, 0]);
    // 角度 90° → V(=+Z)へ 10 = (0, 0, 10)
    expectCloseTo(
      expectOk(resolveCoordinate({ ...base, azimuth: num(90) }, context, 'f1')),
      [0, 0, 10],
    );
    // 角度 45° → 10/√2 = 7.0710678118654755 が Y と Z へ
    expectCloseTo(expectOk(resolveCoordinate({ ...base, azimuth: num(45) }, context, 'f1')), [
      0,
      7.0710678118654755,
      7.0710678118654755,
    ]);
    // 角度 90°・仰角 30°: 水平 10·cos30° = 8.660254037844387 を V(+Z)へ、
    // 10·sin30° = 5 を法線 (1,0,0) へ。
    expectCloseTo(
      expectOk(
        resolveCoordinate({ ...base, azimuth: num(90), elevation: num(30) }, context, 'f1'),
      ),
      [5, 0, 8.660254037844387],
    );
  });

  it('極座標の基準も原点以外から選べる(FR-303)', () => {
    // 点 point-1 (10,20,30) から XY 面で距離 10・角度 90° → (10, 30, 30)
    const input: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'point', pointId: 'point-1' },
      distance: num(10),
      azimuth: num(90),
      elevation: num(0),
    };
    expectCloseTo(expectOk(resolveCoordinate(input, CONTEXT, 'f1')), [10, 30, 30]);
  });

  it('直前の点が無いときは理由つきで断る(止めない、FR-504)', () => {
    const context: ResolveContext = { ...CONTEXT, previous: null };
    const input: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: num(1),
      dy: num(0),
      dz: num(0),
    };
    const outcome = resolveCoordinate(input, context, 'line-7');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('missingBase');
    expect(outcome.ok ? '' : outcome.error.featureId).toBe('line-7');
    expect(outcome.ok ? '' : outcome.error.message).toBe('基準になる直前の点がありません。');
  });

  it('存在しない点・端点の参照は missingBase(FR-504)', () => {
    const missingPoint = resolvePointReference(
      { kind: 'point', pointId: 'point-99' },
      CONTEXT,
      'line-7',
    );
    expect(missingPoint.ok).toBe(false);
    expect(missingPoint.ok ? '' : missingPoint.error.code).toBe('missingBase');
    expect(missingPoint.ok ? '' : missingPoint.error.message).toContain('point-99');

    const missingVertex = resolvePointReference(
      { kind: 'vertex', featureId: 'line-3', vertex: 'center' }, // 線分に中心は無い
      CONTEXT,
      'line-7',
    );
    expect(missingVertex.ok).toBe(false);
    expect(missingVertex.ok ? '' : missingVertex.error.code).toBe('missingBase');
  });

  it('前方参照と自己参照は missingBase(履歴の後ろは手掛かりに入っていない)', () => {
    // 前方参照: line-8 はこのフィーチャーより後ろにあり、まだ解決されていない。
    const forward = resolveCoordinate(
      {
        mode: 'relative',
        base: { kind: 'vertex', featureId: 'line-8', vertex: 'start' },
        dx: num(1),
        dy: num(0),
        dz: num(0),
      },
      CONTEXT,
      'line-7',
    );
    expect(forward.ok ? '' : forward.error.code).toBe('missingBase');
    expect(forward.ok ? '' : forward.error.featureId).toBe('line-7');

    // 自己参照: 解決中の line-7 自身の端点は手掛かりに入らない。
    const itself = resolveCoordinate(
      {
        mode: 'polar',
        base: { kind: 'vertex', featureId: 'line-7', vertex: 'end' },
        distance: num(1),
        azimuth: num(0),
        elevation: num(0),
      },
      CONTEXT,
      'line-7',
    );
    expect(itself.ok ? '' : itself.error.code).toBe('missingBase');

    // 自分自身を点として指した場合も同じ。
    const selfPoint = resolvePointReference(
      { kind: 'point', pointId: 'point-7' },
      CONTEXT,
      'point-7',
    );
    expect(selfPoint.ok ? '' : selfPoint.error.code).toBe('missingBase');
  });

  it('数になっていない値は invalidValue(NaN・無限)', () => {
    const infinite: CoordinateInput = {
      mode: 'absolute',
      x: { source: '1/0', value: Number.POSITIVE_INFINITY, display: 'Infinity' },
      y: num(0),
      z: num(0),
    };
    const absolute = resolveCoordinate(infinite, CONTEXT, 'point-9');
    expect(absolute.ok ? '' : absolute.error.code).toBe('invalidValue');
    expect(absolute.ok ? '' : absolute.error.featureId).toBe('point-9');

    const notANumber: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'origin' },
      dx: num(0),
      dy: { source: '0/0', value: Number.NaN, display: 'NaN' },
      dz: num(0),
    };
    const relative = resolveCoordinate(notANumber, CONTEXT, 'f1');
    expect(relative.ok ? '' : relative.error.code).toBe('invalidValue');

    const brokenDistance: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: { source: '0/0', value: Number.NaN, display: 'NaN' },
      azimuth: num(0),
      elevation: num(0),
    };
    const polarDistance = resolveCoordinate(brokenDistance, CONTEXT, 'f1');
    expect(polarDistance.ok ? '' : polarDistance.error.code).toBe('invalidValue');

    const brokenElevation: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(0),
      elevation: { source: '1/0', value: Number.NEGATIVE_INFINITY, display: '-Infinity' },
    };
    const polarElevation = resolveCoordinate(brokenElevation, CONTEXT, 'f1');
    expect(polarElevation.ok ? '' : polarElevation.error.code).toBe('invalidValue');
  });

  it('基準も値も壊れているときは基準の欠落を先に伝える', () => {
    const context: ResolveContext = { ...CONTEXT, previous: null };
    const input: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: { source: '0/0', value: Number.NaN, display: 'NaN' },
      dy: num(0),
      dz: num(0),
    };
    const outcome = resolveCoordinate(input, context, 'f1');
    expect(outcome.ok ? '' : outcome.error.code).toBe('missingBase');
  });
});

describe('3D スケッチの座標(FR-330、タスク10)', () => {
  /** 立体の頂点への参照。指紋には選んだ瞬間の位置が入る(P3 §2.2.2)。 */
  function vertexRef(bodyFeatureId: string, index: number, position: Vec3): SubShapeRef {
    return { bodyFeatureId, index, fingerprint: { kind: 'vertex', position } };
  }

  /** 作図面を持たない手掛かり(3D スケッチ)。他の欄は CONTEXT と同じ。 */
  const FREE_CONTEXT: ResolveContext = { ...CONTEXT, plane: null };

  it('立体の頂点の参照は、選び直しの口が無ければ指紋の位置をそのまま使う', () => {
    const reference = vertexRef('extrude-1', 3, [5, 5, 5]);
    expect(
      expectOk(resolvePointReference({ kind: 'subShape', ref: reference }, CONTEXT, 'point-1')),
    ).toEqual([5, 5, 5]);

    // 相対の基準にも使える(ずれ 0 なら頂点そのもの、タスク14 の点の作り方)。
    const input: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'subShape', ref: reference },
      dx: num(0),
      dy: num(0),
      dz: num(2),
    };
    expect(expectOk(resolveCoordinate(input, CONTEXT, 'point-1'))).toEqual([5, 5, 7]);
  });

  it('選び直しの口を渡すと、上流の立体が動いた後の位置に追従する(FR-311)', () => {
    // 指紋は (5,5,5) のままでも、選び直しの口が返す位置が使われる。
    const context: ResolveContext = {
      ...CONTEXT,
      subShape: () => ({
        kind: 'vertex',
        position: [5, 5, 25],
        axis: null,
        surfaceKind: null,
        curveKind: null,
      }),
    };
    const reference = vertexRef('extrude-1', 3, [5, 5, 5]);
    expect(
      expectOk(resolvePointReference({ kind: 'subShape', ref: reference }, context, 'point-1')),
    ).toEqual([5, 5, 25]);
  });

  it('選び直せなかった立体の頂点は missingSubShape で断る(FR-504)', () => {
    const context: ResolveContext = { ...CONTEXT, subShape: () => null };
    const outcome = resolvePointReference(
      { kind: 'subShape', ref: vertexRef('extrude-1', 3, [5, 5, 5]) },
      context,
      'point-1',
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('missingSubShape');
    expect(outcome.ok ? '' : outcome.error.featureId).toBe('point-1');
    expect(outcome.ok ? '' : outcome.error.message).toContain('選び直してください');
  });

  it('作図面が無くても絶対・相対の指定はそのまま解ける(§0.a-0.4)', () => {
    const absolute: CoordinateInput = { mode: 'absolute', x: num(1), y: num(2), z: num(3) };
    expect(expectOk(resolveCoordinate(absolute, FREE_CONTEXT, 'point-9'))).toEqual([1, 2, 3]);

    const relative: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: num(10),
      dy: num(0),
      dz: num(-5),
    };
    // 直前の点は CONTEXT の (1,2,3)。
    expect(expectOk(resolveCoordinate(relative, FREE_CONTEXT, 'point-9'))).toEqual([11, 2, -2]);
  });

  it('作図面が無いと角度と距離での指定は使えない(§0.a-0.5)', () => {
    const polar: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: num(10),
      azimuth: num(45),
      elevation: num(0),
    };
    const outcome = resolveCoordinate(polar, FREE_CONTEXT, 'point-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('missingBase');
    expect(outcome.ok ? '' : outcome.error.message).toContain('3D スケッチ');
  });
});

// ---------------------------------------------------------------------------
// 球面上の点(FR-431、P5 計画書 §2.8、タスク19)
// ---------------------------------------------------------------------------

describe('球面上の点(FR-431)', () => {
  /** 球を 1 つだけ知っている手掛かり。他の球の id を訊かれたら「知らない」を返す。 */
  function contextWithSphere(sphere: ResolvedSphere, sphereFeatureId = 'primitive-1'): ResolveContext {
    return {
      ...CONTEXT,
      sphere: (id) => (id === sphereFeatureId ? sphere : null),
    };
  }

  /** 球面上の点の参照。緯度・経度は度。 */
  function gridPoint(latitude: number, longitude: number): PointReference {
    return {
      kind: 'sphereGrid',
      sphereFeatureId: 'primitive-1',
      latitude: num(latitude),
      longitude: num(longitude),
    };
  }

  it('緯度 0・経度 0 は +X 側の赤道上(軸の規約: 北極 +Z、経度 0 は +X)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(0, 0), context, 'point-9')), [10, 0, 0]);
  });

  it('緯度 90 は北極、緯度 −90 は南極', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(90, 0), context, 'point-9')), [0, 0, 10]);
    expectCloseTo(
      expectOk(resolvePointReference(gridPoint(-90, 123), context, 'point-9')),
      [0, 0, -10],
    );
  });

  it('r=10、緯度 30・経度 45 は [6.123724356957945, 6.123724356957945, 5](§2.8.3)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(30, 45), context, 'point-9')), [
      6.123724356957945,
      6.123724356957945,
      5,
    ]);
  });

  it('r=10、緯度 60・経度 120 は [-2.5, 4.330127018922194, 8.660254037844387](§2.8.3)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(60, 120), context, 'point-9')), [
      -2.5,
      4.330127018922194,
      8.660254037844387,
    ]);
  });

  it('r=25、緯度 0・経度 90 は [0, 25, 0](赤道上、§2.8.3)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 25 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(0, 90), context, 'point-9')), [0, 25, 0]);
  });

  it('同じ緯度・経度の 2 点の距離は 9.538504747461981(§2.8.3)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const a = expectOk(resolvePointReference(gridPoint(30, 45), context, 'point-9'));
    const b = expectOk(resolvePointReference(gridPoint(60, 120), context, 'point-9'));
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // 計画書 §2.8.3 は 9.538504747461981 と書いているが、それを double へ直すと
    // 同じ数(最短表記は 9.538504747461982)になる。桁を落とさない書き方にしてある。
    expect(distance).toBeCloseTo(9.538504747461982, 12);
  });

  it('球の半径を 10 → 20 にすると点も外へ動く(追従、FR-431 の太字部分)', () => {
    const before = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const after = contextWithSphere({ center: [0, 0, 0], radius: 20 });
    // 点そのもの(緯度・経度)は 1 文字も変えない。動くのは球のほうだけ。
    const reference = gridPoint(30, 45);
    expectCloseTo(expectOk(resolvePointReference(reference, before, 'point-9')), [
      6.123724356957945,
      6.123724356957945,
      5,
    ]);
    expectCloseTo(expectOk(resolvePointReference(reference, after, 'point-9')), [
      12.24744871391589,
      12.24744871391589,
      10,
    ]);
  });

  it('球の中心を [5,5,5] へ動かすと点も同じだけ動く(追従)', () => {
    const context = contextWithSphere({ center: [5, 5, 5], radius: 10 });
    expectCloseTo(expectOk(resolvePointReference(gridPoint(30, 45), context, 'point-9')), [
      11.123724356957945,
      11.123724356957945,
      10,
    ]);
  });

  it('経度 450 は 90 と同じ点になる(360 で 1 周回る)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const wrapped = expectOk(resolvePointReference(gridPoint(0, 450), context, 'point-9'));
    const plain = expectOk(resolvePointReference(gridPoint(0, 90), context, 'point-9'));
    expectCloseTo(wrapped, plain);
    expectCloseTo(wrapped, [0, 10, 0]);
  });

  it('緯度が範囲外なら断る(緯度 95)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const outcome = resolvePointReference(gridPoint(95, 0), context, 'point-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('invalidValue');
    expect(outcome.ok ? '' : outcome.error.message).toContain('−90 度から 90 度');
    expect(outcome.ok ? '' : outcome.error.featureId).toBe('point-9');

    const below = resolvePointReference(gridPoint(-95, 0), context, 'point-9');
    expect(below.ok ? '' : below.error.message).toBe(LATITUDE_RANGE_MESSAGE);
  });

  it('球が消えた・球でない・別の id なら「球が見つかりません」で断る', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 }, 'primitive-2');
    const outcome = resolvePointReference(gridPoint(0, 0), context, 'point-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('missingBase');
    expect(outcome.ok ? '' : outcome.error.message).toBe(MISSING_SPHERE_MESSAGE);
  });

  it('球を引く口が渡されていなければ、黙って原点へ落とさず断る', () => {
    const outcome = resolvePointReference(gridPoint(0, 0), CONTEXT, 'point-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.message).toBe(MISSING_SPHERE_MESSAGE);
  });

  it('緯度・経度は式のまま保たれ、評価値だけを使う(FR-202)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const reference: PointReference = {
      kind: 'sphereGrid',
      sphereFeatureId: 'primitive-1',
      latitude: { source: '30*2', value: 60, display: '60' },
      longitude: { source: '60*2', value: 120, display: '120' },
    };
    expect(reference.latitude.source).toBe('30*2');
    expectCloseTo(expectOk(resolvePointReference(reference, context, 'point-9')), [
      -2.5,
      4.330127018922194,
      8.660254037844387,
    ]);
  });

  it('緯度が数になっていなければ断る(0/0 の式)', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const reference: PointReference = {
      kind: 'sphereGrid',
      sphereFeatureId: 'primitive-1',
      latitude: { source: '0/0', value: Number.NaN, display: 'NaN' },
      longitude: num(0),
    };
    const outcome = resolvePointReference(reference, context, 'point-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.code).toBe('invalidValue');
    expect(outcome.ok ? '' : outcome.error.message).toContain('緯度');
  });

  it('球面上の点は相対座標・極座標の基準にも使える', () => {
    const context = contextWithSphere({ center: [0, 0, 0], radius: 10 });
    const input: CoordinateInput = {
      mode: 'relative',
      base: gridPoint(0, 0),
      dx: num(0),
      dy: num(0),
      dz: num(3),
    };
    expectCloseTo(expectOk(resolveCoordinate(input, context, 'point-9')), [10, 0, 3]);
  });

  it('sphereGridPosition は中心と半径だけで決まる純関数', () => {
    expectCloseTo(sphereGridPosition({ center: [1, 2, 3], radius: 0 }, 45, 45), [1, 2, 3]);
    expectCloseTo(sphereGridPosition({ center: [0, 0, 0], radius: 10 }, 0, 180), [-10, 0, 0]);
    expectCloseTo(sphereGridPosition({ center: [0, 0, 0], radius: 10 }, 0, 270), [0, -10, 0]);
  });
});
