import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { WORK_PLANES } from '../sketch/planeMath.js';
import type { PointReference } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import {
  planeSpecKeyText,
  resolvePlaneSpec,
  subShapeFromFingerprint,
  type AxisFrame,
  type AxisSpec,
  type PlaneResolveContext,
  type PlaneSpec,
} from './planeSpec.js';
import { fingerprintKeyText, type SubShapeRef } from './subShapeRef.js';

const ev = expressionValueFromNumber;

/** 点の参照。検査では id をそのまま座標表に引く。 */
function pointRef(id: string): PointReference {
  return { kind: 'point', pointId: id };
}

/** 平らな面の参照(z = 10 の面、法線 +Z)。 */
function topFace(): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 3,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [0, 0, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 曲がった面の参照(円柱面)。平面が決まらないことの検査に使う。 */
function cylinderFace(): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 4,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'cylinder',
      area: 100,
      position: [0, 0, 5],
      axis: [0, 0, 1],
      radius: 3,
    },
  };
}

/** X 方向のまっすぐな辺(中点 (20,0,0)、長さ 40)。 */
function straightEdge(): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 1,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [20, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

/** 円の辺。まっすぐでないことの検査に使う。 */
function circleEdge(): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 2,
    fingerprint: {
      kind: 'edge',
      curveKind: 'circle',
      length: 18.84,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: 3,
    },
  };
}

const POINTS: Readonly<Record<string, Vec3>> = {
  'point-1': [0, 0, 0],
  'point-2': [10, 0, 0],
  'point-3': [0, 10, 0],
  'point-line': [20, 0, 0],
  'point-side': [0, 10, 0],
  'point-high': [0, 0, 5],
  'point-any': [1, 2, 3],
};

const AXES: Readonly<Record<string, AxisFrame>> = {
  'axis-z': { origin: [0, 0, 0], direction: [0, 0, 1] },
  'axis-x': { origin: [0, 0, 0], direction: [1, 0, 0] },
};

function context(overrides: Partial<PlaneResolveContext> = {}): PlaneResolveContext {
  return {
    point: (reference) =>
      reference.kind === 'origin'
        ? [0, 0, 0]
        : reference.kind === 'point'
          ? (POINTS[reference.pointId] ?? null)
          : null,
    axis: (spec: AxisSpec) => (spec.kind === 'reference' ? (AXES[spec.referenceFeatureId] ?? null) : null),
    workPlane: (planeId) => {
      const base = planeId === 'xy' ? WORK_PLANES.xy : planeId === 'yz' ? WORK_PLANES.yz : null;
      return base === null
        ? null
        : { origin: base.origin, axisU: base.axisU, axisV: base.axisV, normal: base.normal };
    },
    ...overrides,
  };
}

function expectVec3(actual: Vec3, expected: Vec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 12);
  expect(actual[1]).toBeCloseTo(expected[1], 12);
  expect(actual[2]).toBeCloseTo(expected[2], 12);
}

describe('平面の指定(FR-328、P5 の切断 FR-432 と共有)', () => {
  it('3 点 (0,0,0) (10,0,0) (0,10,0) の法線は +Z、第 1 軸は p1→p2 の +X', () => {
    // (p2−p1) × (p3−p1) = (10,0,0) × (0,10,0) = (0,0,100) → 単位法線 (0,0,1)。
    const spec: PlaneSpec = {
      kind: 'threePoints',
      p1: pointRef('point-1'),
      p2: pointRef('point-2'),
      p3: pointRef('point-3'),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 0]);
    expectVec3(outcome.plane.normal, [0, 0, 1]);
    expectVec3(outcome.plane.axisU, [1, 0, 0]);
    expectVec3(outcome.plane.axisV, [0, 1, 0]);
  });

  it('3 点が一直線なら collinear で断る', () => {
    const spec: PlaneSpec = {
      kind: 'threePoints',
      p1: pointRef('point-1'),
      p2: pointRef('point-2'),
      p3: pointRef('point-line'),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('collinear');
    expect(outcome.message).toContain('一直線');
  });

  it('点が見つからなければ missingPoint で断る(止めずに理由を出す、FR-504)', () => {
    const spec: PlaneSpec = {
      kind: 'threePoints',
      p1: pointRef('point-1'),
      p2: pointRef('point-missing'),
      p3: pointRef('point-3'),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('missingPoint');
  });

  it('点+辺(垂直)の法線は辺の向き', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndEdge',
      point: pointRef('point-high'),
      edge: straightEdge(),
      mode: 'perpendicular',
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 5]);
    expectVec3(outcome.plane.normal, [1, 0, 0]);
  });

  it('点+辺(含む)の法線は 辺の向き × (点 − 辺の中点)', () => {
    // (1,0,0) × ((0,10,0) − (20,0,0)) = (1,0,0) × (−20,10,0) = (0,0,10) → (0,0,1)。
    const spec: PlaneSpec = {
      kind: 'pointAndEdge',
      point: pointRef('point-side'),
      edge: straightEdge(),
      mode: 'containing',
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.normal, [0, 0, 1]);
    // 第 1 軸は辺の向き(平面の中で辺が角度 0 になる)。
    expectVec3(outcome.plane.axisU, [1, 0, 0]);
    expectVec3(outcome.plane.origin, [0, 10, 0]);
  });

  it('点が辺の延長線の上にあると degenerate で断る', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndEdge',
      point: pointRef('point-2'),
      edge: straightEdge(),
      mode: 'containing',
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('degenerate');
  });

  it('円の辺は notStraightEdge で断る', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndEdge',
      point: pointRef('point-1'),
      edge: circleEdge(),
      mode: 'perpendicular',
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('notStraightEdge');
    expect(outcome.message).toContain('まっすぐな辺');
  });

  it('点+軸(傾き 0)は軸に垂直な平面になる', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndAxis',
      point: pointRef('point-high'),
      axis: { kind: 'reference', referenceFeatureId: 'axis-z' },
      tilt: ev(0),
      azimuth: ev(0),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 5]);
    expectVec3(outcome.plane.normal, [0, 0, 1]);
  });

  it('点+軸(Z 軸・傾き 30 度・方位 0 度)は法線が XY 面から 30 度倒れる', () => {
    // 方位角 0 の基準は planeAxesFor の第 1 軸で、Z 軸に対しては (0,−1,0)(穴・ばねと同じ規約)。
    // sin30・(0,−1,0) + cos30・(0,0,1) = (0, −0.5, 0.8660254037844387)。
    // 法線と XY 面の法線 (0,0,1) の内積は cos30 なので、傾きはちょうど 30 度になる。
    const spec: PlaneSpec = {
      kind: 'pointAndAxis',
      point: pointRef('point-1'),
      axis: { kind: 'reference', referenceFeatureId: 'axis-z' },
      tilt: ev(30),
      azimuth: ev(0),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.normal, [0, -0.5, 0.8660254037844387]);
  });

  it('傾き角が 180 度以上なら invalidValue で断る', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndAxis',
      point: pointRef('point-1'),
      axis: { kind: 'reference', referenceFeatureId: 'axis-z' },
      tilt: ev(180),
      azimuth: ev(0),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('invalidValue');
    expect(outcome.message).toContain('180');
  });

  it('軸が見つからなければ missingAxis で断る', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndAxis',
      point: pointRef('point-1'),
      axis: { kind: 'reference', referenceFeatureId: 'axis-missing' },
      tilt: ev(0),
      azimuth: ev(0),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('missingAxis');
  });

  it('点+既存面に平行は、面の法線をそのまま使い、原点は指定した点', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndParallelFace',
      point: pointRef('point-any'),
      face: topFace(),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [1, 2, 3]);
    expectVec3(outcome.plane.normal, [0, 0, 1]);
  });

  it('平らでない面は notFlatFace で断る', () => {
    const spec: PlaneSpec = {
      kind: 'pointAndParallelFace',
      point: pointRef('point-1'),
      face: cylinderFace(),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('notFlatFace');
    expect(outcome.message).toContain('平らな面');
  });

  it('既存の面そのもの(オフセット 0)は面の重心と法線になる', () => {
    const spec: PlaneSpec = { kind: 'face', face: topFace(), offset: ev(0) };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 10]);
    expectVec3(outcome.plane.normal, [0, 0, 1]);
  });

  it('既存の面から 5mm 離した平面は原点が法線方向へ 5 動く', () => {
    const spec: PlaneSpec = { kind: 'face', face: topFace(), offset: ev(5) };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 15]);
  });

  it('XY 面のオフセット 10 は原点 (0,0,10)、法線 +Z', () => {
    const spec: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: ev(10) };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [0, 0, 10]);
    expectVec3(outcome.plane.normal, [0, 0, 1]);
    expectVec3(outcome.plane.axisU, [1, 0, 0]);
    expectVec3(outcome.plane.axisV, [0, 1, 0]);
  });

  it('無い平面を基準にすると missingPlane で断る', () => {
    const spec: PlaneSpec = { kind: 'workPlane', planeId: 'referencePlane-9', offset: ev(0) };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('missingPlane');
  });

  it('XY 面を X 軸まわりに 90 度傾けると法線が (0,-1,0) になる', () => {
    // ロドリゲスの回転公式、θ=90°、k=(1,0,0)、v=(0,0,1) → k × v = (0,-1,0)。
    const spec: PlaneSpec = {
      kind: 'tilted',
      base: 'xy',
      axis: { kind: 'reference', referenceFeatureId: 'axis-x' },
      angle: ev(90),
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.normal, [0, -1, 0]);
    expectVec3(outcome.plane.axisU, [1, 0, 0]);
    expectVec3(outcome.plane.axisV, [0, 0, 1]);
    expectVec3(outcome.plane.origin, [0, 0, 0]);
  });

  it('傾ける角度が数でなければ invalidValue で断る', () => {
    const spec: PlaneSpec = {
      kind: 'tilted',
      base: 'xy',
      axis: { kind: 'reference', referenceFeatureId: 'axis-x' },
      angle: { source: '1/0', value: Number.POSITIVE_INFINITY, display: '∞' },
    };
    const outcome = resolvePlaneSpec(spec, context());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('invalidValue');
  });

  it('選び直しの関数を渡すと、保存された指紋ではなく今の面の向きで解ける(上流への追従)', () => {
    // 指紋は z=10・法線 +Z だが、上流が変わって法線が +X の面になった場合。
    const spec: PlaneSpec = { kind: 'face', face: topFace(), offset: ev(0) };
    const outcome = resolvePlaneSpec(
      spec,
      context({
        subShape: () => ({
          kind: 'face',
          position: [7, 0, 0],
          axis: [1, 0, 0],
          surfaceKind: 'plane',
          curveKind: null,
        }),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expectVec3(outcome.plane.origin, [7, 0, 0]);
    expectVec3(outcome.plane.normal, [1, 0, 0]);
  });

  it('選び直しが失敗したら missingSubShape で断る', () => {
    const spec: PlaneSpec = { kind: 'face', face: topFace(), offset: ev(0) };
    const outcome = resolvePlaneSpec(spec, context({ subShape: () => null }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('missingSubShape');
  });
});

describe('指紋からの詰め替え(選び直しの関数が無いときの既定)', () => {
  it('面は重心と法線、辺は中点と向き、頂点は位置を返す', () => {
    const face = subShapeFromFingerprint(topFace());
    expect(face.kind).toBe('face');
    expect(face.surfaceKind).toBe('plane');
    expect(face.position).toEqual([0, 0, 10]);
    const edge = subShapeFromFingerprint(straightEdge());
    expect(edge.curveKind).toBe('line');
    expect(edge.position).toEqual([20, 0, 0]);
    const vertex = subShapeFromFingerprint({
      bodyFeatureId: 'extrude-1',
      index: 9,
      fingerprint: { kind: 'vertex', position: [1, 1, 1] },
    });
    expect(vertex.kind).toBe('vertex');
    expect(vertex.axis).toBeNull();
  });
});

describe('鍵の材料の文字列(P5 のタスク27c が使う)', () => {
  it('同じ指定からは同じ文字列、違う指定からは違う文字列になる', () => {
    const a: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: ev(10) };
    const b: PlaneSpec = { kind: 'workPlane', planeId: 'xy', offset: ev(11) };
    expect(planeSpecKeyText(a, fingerprintKeyText)).toBe(planeSpecKeyText(a, fingerprintKeyText));
    expect(planeSpecKeyText(a, fingerprintKeyText)).not.toBe(
      planeSpecKeyText(b, fingerprintKeyText),
    );
  });

  it('7 種類すべてが空でない文字列になり、種類ごとに違う', () => {
    const specs: readonly PlaneSpec[] = [
      { kind: 'threePoints', p1: pointRef('point-1'), p2: pointRef('point-2'), p3: pointRef('point-3') },
      { kind: 'pointAndEdge', point: pointRef('point-1'), edge: straightEdge(), mode: 'containing' },
      {
        kind: 'pointAndAxis',
        point: pointRef('point-1'),
        axis: { kind: 'world', axis: 'z' },
        tilt: ev(30),
        azimuth: ev(0),
      },
      { kind: 'pointAndParallelFace', point: pointRef('point-1'), face: topFace() },
      { kind: 'face', face: topFace(), offset: ev(5) },
      { kind: 'workPlane', planeId: 'xy', offset: ev(0) },
      { kind: 'tilted', base: 'xy', axis: { kind: 'line', line: { sketchId: 's', lineFeatureId: 'l' } }, angle: ev(45) },
    ];
    const texts = specs.map((spec) => planeSpecKeyText(spec, fingerprintKeyText));
    expect(new Set(texts).size).toBe(specs.length);
    expect(texts.every((text) => text.length > 0)).toBe(true);
  });
});
