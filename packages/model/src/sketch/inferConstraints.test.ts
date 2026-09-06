import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { resolveConstrainedSketch } from './constraints/solveSketch.js';
import { sketchConstraints, type SketchConstraint } from './constraints/types.js';
import { absoluteCoordinate } from './createSketchDocument.js';
import {
  constraintFromInference,
  inferConstraints,
  inferredConstraintTargets,
  INFER_ANGLE_TOLERANCE_DEGREES,
  INFER_COINCIDENT_RADIUS_PIXELS,
  MAX_INFERRED_CONSTRAINTS,
  type DraftSegment,
  type InferConstraintsOptions,
  type InferenceElements,
  type InferredConstraint,
  type InferredConstraintKind,
} from './inferConstraints.js';
import { degreesToRadians, WORK_PLANES } from './planeMath.js';
import type { ResolvedArc, ResolvedPoint, ResolvedSegment, SketchDocument } from './types.js';

/**
 * タスク40 の検査(計画書 docs/plans/P6-入出力.md §2.15 の表と「タスク40」の検証表)。
 *
 * **作図面は XY** に固定してあるので、作図面の座標 (u, v) はワールドの (x, y) と同じで、
 * 期待値を手で導ける。**画面の縮尺は 1 画素/mm** を既定にしてあるので、
 * 「画面上 6 画素」はそのまま「6mm」として読める。
 */

const PLANE = WORK_PLANES.xy;

function draftOf(
  from: readonly [number, number],
  to: readonly [number, number],
  featureId = 'line-draft',
): DraftSegment {
  return { featureId, from, to };
}

function optionsOf(extra: Partial<InferConstraintsOptions> = {}): InferConstraintsOptions {
  return { plane: PLANE, pixelsPerMillimetre: 1, ...extra };
}

function pointAt(id: string, u: number, v: number, height = 0): ResolvedPoint {
  return { id, featureId: id, position: [u, v, height] };
}

function segmentOf(
  featureId: string,
  from: readonly [number, number],
  to: readonly [number, number],
): ResolvedSegment {
  return { kind: 'segment', featureId, from: [from[0], from[1], 0], to: [to[0], to[1], 0] };
}

/** 中心 (u, v)・半径 r の**まるごとの円**(端点は角度 0 の 1 点に重なる)。 */
function circleOf(featureId: string, u: number, v: number, radius: number): ResolvedArc {
  return {
    kind: 'arc',
    featureId,
    center: [u, v, 0],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius,
    startAngle: 0,
    endAngle: 2 * Math.PI,
  };
}

function kindsOf(inferred: readonly InferredConstraint[]): readonly InferredConstraintKind[] {
  return inferred.map((one) => one.kind);
}

const NO_ELEMENTS: InferenceElements = {};

describe('しきい値の定数(§0.a-0.48)', () => {
  it('角度は 3°、一致は画面上 6 画素、同時に出すのは 2 つまで', () => {
    expect(INFER_ANGLE_TOLERANCE_DEGREES).toBe(3);
    // ui の PICK_RADIUS_PIXELS と同じ値(§0.a-0.48「使い回す」)。
    expect(INFER_COINCIDENT_RADIUS_PIXELS).toBe(6);
    expect(MAX_INFERRED_CONSTRAINTS).toBe(2);
  });

  it('3° の正接は 0.0524077792830412(計画書の 0.05240777928304121 と最後の 1 桁だけ違う)', () => {
    /*
      計画書 §0.a-0.48 は `tan 3° = 0.05240777928304121` と書いているが、
      **度をラジアンへ直す割り算の丸めが 1 桁ぶん効く**ので、実際に計算すると
      0.0524077792830412(倍精度で 1 つ隣の値)になる。判定はこの計算した値で行うので、
      境界(ちょうど 3°)の推定は揺れない(下の「ちょうど 3°」の検査)。
    */
    expect(Math.tan(degreesToRadians(INFER_ANGLE_TOLERANCE_DEGREES))).toBe(0.0524077792830412);
    expect(Math.tan(degreesToRadians(INFER_ANGLE_TOLERANCE_DEGREES))).toBeCloseTo(
      0.05240777928304121,
      15,
    );
  });
});

describe('§2.15 の表: 向きの推定', () => {
  it('(0,0)→(100,0) は水平(角度 0°)', () => {
    const inferred = inferConstraints(draftOf([0, 0], [100, 0]), NO_ELEMENTS, optionsOf());
    expect(kindsOf(inferred)).toEqual(['horizontal']);
    expect(inferred[0].relatedId).toBeNull();
    // 印は描いている線の真ん中に出す(相手がいないため)。
    expect(inferred[0].markerAt).toEqual([50, 0]);
  });

  it('(0,0)→(100,5) は水平(atan(0.05) = 2.8624° < 3°)', () => {
    const inferred = inferConstraints(draftOf([0, 0], [100, 5]), NO_ELEMENTS, optionsOf());
    expect(kindsOf(inferred)).toEqual(['horizontal']);
  });

  it('(0,0)→(100,6) は推定しない(atan(0.06) = 3.4336° > 3°)', () => {
    const inferred = inferConstraints(draftOf([0, 0], [100, 6]), NO_ELEMENTS, optionsOf());
    expect(inferred).toEqual([]);
  });

  it('ちょうど 3° は推定する(境界は ≤ で判定する)', () => {
    const rise = 100 * Math.tan(degreesToRadians(INFER_ANGLE_TOLERANCE_DEGREES));
    const inferred = inferConstraints(draftOf([0, 0], [100, rise]), NO_ELEMENTS, optionsOf());
    expect(kindsOf(inferred)).toEqual(['horizontal']);
  });

  it('(0,0)→(0,100) は垂直(角度 90°)', () => {
    const inferred = inferConstraints(draftOf([0, 0], [0, 100]), NO_ELEMENTS, optionsOf());
    expect(kindsOf(inferred)).toEqual(['vertical']);
  });

  it('水平と垂直は同時に出ない(0° と 90° は 3° の幅では両立しない)', () => {
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const radians = degreesToRadians(degrees);
      const inferred = inferConstraints(
        draftOf([0, 0], [100 * Math.cos(radians), 100 * Math.sin(radians)]),
        NO_ELEMENTS,
        optionsOf(),
      );
      const axes = kindsOf(inferred).filter((kind) => kind === 'horizontal' || kind === 'vertical');
      expect(axes.length).toBeLessThanOrEqual(1);
    }
  });

  it('既存の要素が無ければ水平・垂直しか出ない', () => {
    const kinds = new Set<InferredConstraintKind>();
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const radians = degreesToRadians(degrees);
      const inferred = inferConstraints(
        draftOf([0, 0], [100 * Math.cos(radians), 100 * Math.sin(radians)]),
        NO_ELEMENTS,
        optionsOf(),
      );
      for (const kind of kindsOf(inferred)) {
        kinds.add(kind);
      }
    }
    expect([...kinds].sort()).toEqual(['horizontal', 'vertical']);
  });

  it('長さ 0 の線は向きが決まらないので推定しない', () => {
    const inferred = inferConstraints(draftOf([5, 5], [5, 5]), NO_ELEMENTS, optionsOf());
    expect(inferred).toEqual([]);
  });
});

describe('§2.15 の表: 平行', () => {
  const existing: InferenceElements = { segments: [segmentOf('line-1', [0, 0], [100, 0])] };

  it('既存の線 (0,0)→(100,0) の近くの (0,10)→(100,15) は平行を推定する(角度差 2.8624°)', () => {
    const inferred = inferConstraints(draftOf([0, 10], [100, 15]), existing, optionsOf());
    expect(kindsOf(inferred)).toContain('parallel');
    const parallel = inferred.find((one) => one.kind === 'parallel');
    expect(parallel?.relatedId).toBe('line-1');
    // 印は相手の線の真ん中(§0.a-0.50「相手の近くに小さな印」)。
    expect(parallel?.markerAt).toEqual([50, 0]);
  });

  it('角度差が 3° を超える相手とは平行にしない', () => {
    const inferred = inferConstraints(draftOf([0, 10], [100, 16]), existing, optionsOf());
    expect(inferred).toEqual([]);
  });

  it('相手が既に水平拘束を持つときは、こちらの水平と重ねて平行を出さない(足しすぎ)', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '水平1',
        kind: 'horizontal',
        target: { kind: 'curve', element: { featureId: 'line-1' } },
      },
    ];
    const inferred = inferConstraints(
      draftOf([0, 10], [100, 15]),
      existing,
      optionsOf({ constraints }),
    );
    expect(kindsOf(inferred)).toEqual(['horizontal']);
  });

  it('相手の候補が複数あれば角度差のいちばん小さい 1 本だけを選ぶ', () => {
    const inferred = inferConstraints(
      draftOf([0, 10], [100, 12]),
      {
        segments: [
          segmentOf('line-far', [0, 0], [100, 4]),
          segmentOf('line-near', [0, -10], [100, -8]),
        ],
      },
      optionsOf(),
    );
    const parallels = inferred.filter((one) => one.kind === 'parallel');
    expect(parallels).toHaveLength(1);
    expect(parallels[0].relatedId).toBe('line-near');
  });
});

describe('§2.15 の表: 一致', () => {
  it('端点が既存の点から 5 画素なら一致を推定する(6 画素以内)', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { points: [pointAt('point-1', 105, 50)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident']);
    const [coincident] = inferred;
    expect(coincident.relatedId).toBe('point-1');
    expect(coincident.markerAt).toEqual([105, 50]);
    expect(inferredConstraintTargets(coincident)).toEqual([
      { kind: 'vertex', featureId: 'line-draft', vertex: 'end' },
      { kind: 'point', pointId: 'point-1' },
    ]);
  });

  it('端点が既存の点から 7 画素なら推定しない(6 画素超)', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { points: [pointAt('point-1', 107, 50)] },
      optionsOf(),
    );
    expect(inferred).toEqual([]);
  });

  it('しきい値は画面の縮尺で決まる(2 画素/mm なら 5mm 離れた点は遠い)', () => {
    const nearby: InferenceElements = { points: [pointAt('point-1', 105, 50)] };
    const draft = draftOf([0, 0], [100, 50]);
    expect(inferConstraints(draft, nearby, optionsOf({ pixelsPerMillimetre: 2 }))).toEqual([]);
    // 同じ縮尺でも 2mm(= 4 画素)なら届く。
    expect(
      kindsOf(
        inferConstraints(
          draft,
          { points: [pointAt('point-1', 102, 50)] },
          optionsOf({ pixelsPerMillimetre: 2 }),
        ),
      ),
    ).toEqual(['coincident']);
  });

  it('線分の端点にも一致する(指し先は featureId と start / end)', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { segments: [segmentOf('line-1', [102, 50], [200, 200])] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident']);
    expect(inferred[0].relatedId).toBe('line-1:start');
    expect(inferredConstraintTargets(inferred[0])[1]).toEqual({
      kind: 'vertex',
      featureId: 'line-1',
      vertex: 'start',
    });
  });

  it('作図面の上に無い点は相手にしない', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { points: [pointAt('point-1', 105, 50, 5)] },
      optionsOf(),
    );
    expect(inferred).toEqual([]);
  });

  it('描いている線そのものの端点は相手にしない', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50], 'line-1'),
      { segments: [segmentOf('line-1', [0, 0], [100, 50])] },
      optionsOf(),
    );
    expect(inferred).toEqual([]);
  });
});

describe('§2.15 の表: 接線', () => {
  // 半径 10 の円の 45° の点。ここでの接線の向きは (n_v, −n_u) = (0.7071, −0.7071)。
  const touch: readonly [number, number] = [10 * Math.SQRT1_2, 10 * Math.SQRT1_2];
  const away: readonly [number, number] = [touch[0] + 70.71, touch[1] - 70.71];

  it('円の上の端点から接線の向きへ引くと接線を推定する', () => {
    const inferred = inferConstraints(
      draftOf(touch, away),
      { arcs: [circleOf('arc-1', 0, 0, 10)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['tangent']);
    expect(inferred[0].relatedId).toBe('arc-1');
    expect(inferred[0].markerAt).toEqual(touch);
    expect(inferredConstraintTargets(inferred[0])).toEqual([
      { kind: 'curve', element: { featureId: 'line-draft' } },
      { kind: 'curve', element: { featureId: 'arc-1' } },
    ]);
  });

  it('円の中心が線の進む向きの左側になる引き方では推定しない(接線の式の符号)', () => {
    const reversed: readonly [number, number] = [touch[0] - 70.71, touch[1] + 70.71];
    const inferred = inferConstraints(
      draftOf(touch, reversed),
      { arcs: [circleOf('arc-1', 0, 0, 10)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).not.toContain('tangent');
  });

  it('端点が円周から離れていれば推定しない', () => {
    const outside: readonly [number, number] = [touch[0] * 1.7, touch[1] * 1.7];
    const inferred = inferConstraints(
      draftOf(outside, [outside[0] + 70.71, outside[1] - 70.71]),
      { arcs: [circleOf('arc-1', 0, 0, 10)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).not.toContain('tangent');
  });

  it('一致と接線は同時に出す(上限 2 つ)', () => {
    const inferred = inferConstraints(
      draftOf(touch, away),
      { arcs: [circleOf('arc-1', 0, 0, 10)], points: [pointAt('point-1', touch[0], touch[1])] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident', 'tangent']);
  });
});

describe('優先順位と上限(§2.15)', () => {
  it('一致・接線・水平の 3 つが成り立つときは上位 2 つ(一致と接線)だけ', () => {
    // 円の (0,−10) の点から −u 方向へ引く。接線の向きは (n_v, −n_u) = (−1, 0)。
    const inferred = inferConstraints(
      draftOf([0, -10], [-100, -10]),
      { arcs: [circleOf('arc-1', 0, 0, 10)], points: [pointAt('point-1', 0, -10)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident', 'tangent']);
  });

  it('両端が既存の点に近ければ一致が 2 つになり、水平は落ちる', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      { points: [pointAt('point-1', 0, 0), pointAt('point-2', 100, 0)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident', 'coincident']);
    expect(inferred.map((one) => one.relatedId)).toEqual(['point-1', 'point-2']);
    expect(inferred).toHaveLength(MAX_INFERRED_CONSTRAINTS);
  });

  it('一致で端点が寄った後の向きで水平を判定する', () => {
    // 引いた線は 0°(水平)だが、終点が 5mm 上の点へ寄ると 3.43° になり水平ではなくなる。
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      { points: [pointAt('point-1', 100, 6)] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident']);
  });
});

describe('入切と一時停止(§0.a-0.49、§0.a-0.50)', () => {
  it('Shift を押している間は 1 つも推定しない', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      { points: [pointAt('point-1', 0, 0)] },
      optionsOf({ suspended: true }),
    );
    expect(inferred).toEqual([]);
  });

  it('推定を切ったときは 1 つも推定しない', () => {
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      NO_ELEMENTS,
      optionsOf({ enabled: false }),
    );
    expect(inferred).toEqual([]);
  });

  it('既定は入(enabled を渡さなくても推定する)', () => {
    expect(kindsOf(inferConstraints(draftOf([0, 0], [100, 0]), NO_ELEMENTS, optionsOf()))).toEqual([
      'horizontal',
    ]);
  });
});

describe('既存の拘束との重複(§2.15 の検証表)', () => {
  it('同じ水平拘束が既にあれば推定しない', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '水平1',
        kind: 'horizontal',
        target: { kind: 'curve', element: { featureId: 'line-draft' } },
      },
    ];
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      NO_ELEMENTS,
      optionsOf({ constraints }),
    );
    expect(inferred).toEqual([]);
  });

  it('同じ一致拘束が既にあれば、左右が逆に書かれていても推定しない', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '一致1',
        kind: 'coincident',
        a: { kind: 'point', pointId: 'point-1' },
        b: { kind: 'vertex', featureId: 'line-draft', vertex: 'end' },
      },
    ];
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { points: [pointAt('point-1', 105, 50)] },
      optionsOf({ constraints }),
    );
    expect(inferred).toEqual([]);
  });

  it('別の要素に付いている水平拘束は重複ではない', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '水平1',
        kind: 'horizontal',
        target: { kind: 'curve', element: { featureId: 'line-9' } },
      },
    ];
    const inferred = inferConstraints(
      draftOf([0, 0], [100, 0]),
      NO_ELEMENTS,
      optionsOf({ constraints }),
    );
    expect(kindsOf(inferred)).toEqual(['horizontal']);
  });
});

describe('推定した拘束を足す(FR-313)', () => {
  /** 推定した拘束に id と名前を付けて文書へ足す(ui のタスク41 が行うことの最小形)。 */
  function withInferred(
    document: SketchDocument,
    inferred: readonly InferredConstraint[],
  ): SketchDocument {
    const added = inferred.map((one, index) =>
      constraintFromInference(one, `constraint-${String(index + 1)}`, `推定${String(index + 1)}`),
    );
    return { ...document, constraints: [...sketchConstraints(document), ...added] };
  }

  it('水平の推定を足すと拘束が 1 件増え、形が水平に整う(矛盾しない)', () => {
    const document: SketchDocument = {
      id: 'sketch-1',
      name: 'スケッチ1',
      features: [
        {
          id: 'line-1',
          kind: 'line',
          name: '線分1',
          planeId: 'xy',
          from: absoluteCoordinate(0, 0, 0),
          to: absoluteCoordinate(100, 5, 0),
          construction: false,
        },
      ],
      constraints: [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
        },
      ],
    };
    const draft = draftOf([0, 0], [100, 5], 'line-1');
    const inferred = inferConstraints(draft, NO_ELEMENTS, optionsOf());
    expect(kindsOf(inferred)).toEqual(['horizontal']);

    const next = withInferred(document, inferred);
    expect(sketchConstraints(next)).toHaveLength(sketchConstraints(document).length + 1);

    const solved = resolveConstrainedSketch(next);
    expect(solved.errors).toEqual([]);
    expect(solved.diagnosis?.conflicting).toEqual([]);
    expect(solved.diagnosis?.redundant).toEqual([]);
    expect(solved.diagnosis?.satisfied).toBe(true);
    const [segment] = solved.resolved.segments;
    expect(segment.from[1]).toBeCloseTo(0, 8);
    expect(segment.to[1]).toBeCloseTo(0, 8);
    // 固定した始点は動かない。
    expect(segment.from[0]).toBeCloseTo(0, 8);
  });

  it('一致と接線の 2 つを足してもソルバーが解ける(矛盾しない)', () => {
    const touch: readonly [number, number] = [10 * Math.SQRT1_2, 10 * Math.SQRT1_2];
    const away: readonly [number, number] = [touch[0] + 70.71, touch[1] - 70.71];
    // 円の中心と半径、そして相手の点は動かないように固定しておく(何が動いたかを一意にする)。
    const document: SketchDocument = {
      id: 'sketch-1',
      name: 'スケッチ1',
      features: [
        {
          id: 'arc-1',
          kind: 'arc',
          name: '円弧1',
          planeId: 'xy',
          center: absoluteCoordinate(0, 0, 0),
          radius: num(10),
          startAngle: num(0),
          endAngle: num(360),
          construction: false,
        },
        {
          id: 'point-1',
          kind: 'point',
          name: '点1',
          planeId: 'xy',
          at: absoluteCoordinate(touch[0], touch[1], 0),
        },
        {
          id: 'line-1',
          kind: 'line',
          name: '線分1',
          planeId: 'xy',
          from: absoluteCoordinate(touch[0] + 0.5, touch[1] + 0.5, 0),
          to: absoluteCoordinate(away[0], away[1], 0),
          construction: false,
        },
      ],
      constraints: [
        { id: 'fix-1', name: '固定1', kind: 'fix', target: { kind: 'point', pointId: 'point-1' } },
      ],
    };
    const inferred = inferConstraints(
      draftOf([touch[0] + 0.5, touch[1] + 0.5], away, 'line-1'),
      { arcs: [circleOf('arc-1', 0, 0, 10)], points: [pointAt('point-1', touch[0], touch[1])] },
      optionsOf(),
    );
    expect(kindsOf(inferred)).toEqual(['coincident', 'tangent']);

    const next = withInferred(document, inferred);
    expect(sketchConstraints(next)).toHaveLength(sketchConstraints(document).length + 2);

    const solved = resolveConstrainedSketch(next);
    expect(solved.errors).toEqual([]);
    expect(solved.diagnosis?.conflicting).toEqual([]);
    expect(solved.diagnosis?.satisfied).toBe(true);

    // 始点は点1 へ重なる(点1 は固定してあるので線の側が動く)。
    const [segment] = solved.resolved.segments;
    expect(segment.from[0]).toBeCloseTo(touch[0], 6);
    expect(segment.from[1]).toBeCloseTo(touch[1], 6);
    // 線は円へ接する(解けた中心から線までの距離が、解けた半径に等しい)。
    const [arc] = solved.resolved.arcs;
    const du = segment.to[0] - segment.from[0];
    const dv = segment.to[1] - segment.from[1];
    const offsetU = arc.center[0] - segment.from[0];
    const offsetV = arc.center[1] - segment.from[1];
    const distance = Math.abs(du * offsetV - dv * offsetU) / Math.hypot(du, dv);
    expect(distance).toBeCloseTo(arc.radius, 6);
  });
});

describe('拘束の形への詰め替え', () => {
  it('constraintFromInference が P4b の欄の並びで拘束を作る', () => {
    const [horizontal] = inferConstraints(draftOf([0, 0], [100, 0]), NO_ELEMENTS, optionsOf());
    expect(constraintFromInference(horizontal, 'c1', '水平1')).toEqual({
      id: 'c1',
      name: '水平1',
      kind: 'horizontal',
      target: { kind: 'curve', element: { featureId: 'line-draft' } },
    });

    const [coincident] = inferConstraints(
      draftOf([0, 0], [100, 50]),
      { points: [pointAt('point-1', 105, 50)] },
      optionsOf(),
    );
    expect(constraintFromInference(coincident, 'c2', '一致1')).toEqual({
      id: 'c2',
      name: '一致1',
      kind: 'coincident',
      a: { kind: 'vertex', featureId: 'line-draft', vertex: 'end' },
      b: { kind: 'point', pointId: 'point-1' },
    });
  });
});
