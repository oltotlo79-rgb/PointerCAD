import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';

import {
  formatMeasure,
  measurableKinds,
  measureKindLabel,
  measureKindLabelKey,
  measureKindUnit,
  measureLocally,
  measureReadiness,
  measureRejectionMessageKey,
  needsKernel,
  MEASURE_FAILED_MESSAGE_KEY,
  MEASURE_KIND_LABEL_KEYS,
  MEASURE_KIND_ORDER,
  type LocalMeasureResult,
  type MeasureBody,
  type MeasureKind,
  type MeasureRejectionReason,
} from './measure.js';
import type { SolidEdgeEntry, SolidFaceEntry, SolidVertexEntry } from './subShapeSelection.js';

/*
  検査に使う立体は 40×30×10 の板(角を原点に置く)。期待値はすべて手で出す。

    体積        40 × 30 × 10 = 12000 mm³
    上下の面    40 × 30 = 1200 mm²、間の距離 10 mm
    横の面      40 × 10 = 400 mm²(y=0 / y=30)、30 × 10 = 300 mm²(x=0 / x=40)
    対角の頂点  √(40² + 30² + 10²) = √2600 = 50.99019513592785 mm
    長い辺      40 mm、隣り合う面のなす角 90 度
*/

const NO_MESH = { edgePositions: new Float32Array() };

function planeFace(
  index: number,
  area: number,
  centroid: readonly [number, number, number],
  normal: readonly [number, number, number],
): SolidFaceEntry {
  return {
    index,
    surfaceKind: 'plane',
    area,
    centroid,
    axis: normal,
    radius: null,
    triangleOffset: index * 2,
    triangleCount: 2,
  };
}

/** まっすぐな辺。長さと向きは両端から出す(カーネルが返すものと同じ値になる)。 */
function lineEdge(
  index: number,
  start: readonly [number, number, number],
  end: readonly [number, number, number],
): SolidEdgeEntry {
  const delta: readonly [number, number, number] = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ];
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  return {
    index,
    curveKind: 'line',
    length,
    midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
    start,
    end,
    axis: [delta[0] / length, delta[1] / length, delta[2] / length],
    radius: null,
    segmentOffset: index,
    segmentCount: 1,
  };
}

function vertexAt(
  index: number,
  position: readonly [number, number, number],
): SolidVertexEntry {
  return { index, position };
}

/** 40×30×10 の板。面 6 枚・辺 12 本・頂点 8 個をカーネルと同じ並びで持つ。 */
const BOX: MeasureBody = {
  featureId: 'extrude-1',
  mesh: NO_MESH,
  volume: 12000,
  faces: [
    planeFace(0, 1200, [20, 15, 0], [0, 0, -1]), // 下面
    planeFace(1, 1200, [20, 15, 10], [0, 0, 1]), // 上面
    planeFace(2, 400, [20, 0, 5], [0, -1, 0]), // 手前
    planeFace(3, 400, [20, 30, 5], [0, 1, 0]), // 奥
    planeFace(4, 300, [0, 15, 5], [-1, 0, 0]), // 左
    planeFace(5, 300, [40, 15, 5], [1, 0, 0]), // 右
  ],
  edges: [
    lineEdge(0, [0, 0, 0], [40, 0, 0]),
    lineEdge(1, [40, 0, 0], [40, 30, 0]),
    lineEdge(2, [40, 30, 0], [0, 30, 0]),
    lineEdge(3, [0, 30, 0], [0, 0, 0]),
    lineEdge(4, [0, 0, 10], [40, 0, 10]),
    lineEdge(5, [40, 0, 10], [40, 30, 10]),
    lineEdge(6, [40, 30, 10], [0, 30, 10]),
    lineEdge(7, [0, 30, 10], [0, 0, 10]),
    lineEdge(8, [0, 0, 0], [0, 0, 10]),
    lineEdge(9, [40, 0, 0], [40, 0, 10]),
    lineEdge(10, [40, 30, 0], [40, 30, 10]),
    lineEdge(11, [0, 30, 0], [0, 30, 10]),
  ],
  vertices: [
    vertexAt(0, [0, 0, 0]),
    vertexAt(1, [40, 0, 0]),
    vertexAt(2, [40, 30, 0]),
    vertexAt(3, [0, 30, 0]),
    vertexAt(4, [0, 0, 10]),
    vertexAt(5, [40, 0, 10]),
    vertexAt(6, [40, 30, 10]),
    vertexAt(7, [0, 30, 10]),
  ],
};

/*
  φ6 深さ 10 の丸穴を持つ立体。平面でない面と、まっすぐでない辺を確かめるために使う。

    円筒面の面積  2π × 3 × 10 = 188.49555921538757 mm²
    円の面積      π × 6² = 113.09733552923255 mm²(半径 6 の平らな丸い面)
    円の周長      2π × 3 = 18.84955592153876 mm
*/
const HOLE: MeasureBody = {
  featureId: 'hole-1',
  mesh: NO_MESH,
  volume: 11717.4,
  faces: [
    {
      index: 0,
      surfaceKind: 'cylinder',
      area: 2 * Math.PI * 3 * 10,
      centroid: [20, 15, 5],
      axis: [0, 0, 1],
      radius: 3,
      triangleOffset: 0,
      triangleCount: 16,
    },
    planeFace(1, Math.PI * 36, [20, 15, 10], [0, 0, 1]), // 半径 6 の平らな丸い面
  ],
  edges: [
    {
      index: 0,
      curveKind: 'circle',
      length: 2 * Math.PI * 3,
      midpoint: [23, 15, 10],
      start: [23, 15, 10],
      end: [23, 15, 10],
      axis: [0, 0, 1],
      radius: 3,
      segmentOffset: 0,
      segmentCount: 12,
    },
    lineEdge(1, [0, 0, 10], [10, 20, 40]), // √1400 = 37.416573867739416
  ],
  vertices: [vertexAt(0, [0, 0, 0]), vertexAt(1, [10, 20, 30])],
};

/** 45 度に傾いた面を持つ立体(法線 [1,0,1]/√2 と [0,0,1] のなす角の確認用)。 */
const WEDGE: MeasureBody = {
  featureId: 'wedge-1',
  mesh: NO_MESH,
  volume: 500,
  faces: [
    planeFace(0, 100, [0, 0, 0], [0, 0, 1]),
    planeFace(1, 141.4213562373095, [5, 0, 5], [Math.SQRT1_2, 0, Math.SQRT1_2]),
  ],
  edges: [],
  vertices: [],
};

const BODIES: readonly MeasureBody[] = [BOX, HOLE, WEDGE];

/** 下見が測れると言った種類で、実際に測った結果を取り出す(呼び出し側と同じ手順)。 */
function measure(selection: readonly string[], kind?: MeasureKind) {
  const readiness = measureReadiness(selection, BODIES);
  const chosen = kind ?? readiness.kind;
  return chosen === null ? null : measureLocally(chosen, readiness.targets, BODIES);
}

describe('測れる種類の自動判定(FR-1102、§0.a-0.29、NFR-UX-1)', () => {
  it('頂点 2 つは 2 点の距離', () => {
    const readiness = measureReadiness(['extrude-1#vertex:0', 'extrude-1#vertex:6'], BODIES);
    expect(readiness.ready).toBe(true);
    expect(readiness.kinds).toEqual(['pointDistance']);
    expect(readiness.kind).toBe('pointDistance');
    expect(readiness.message).toBeNull();
    expect(readiness.reason).toBeNull();
  });

  it('向かい合う平らな面 2 枚は距離と角度(距離が既定)', () => {
    const readiness = measureReadiness(['extrude-1#face:0', 'extrude-1#face:1'], BODIES);
    expect(readiness.kinds).toEqual(['faceDistance', 'faceAngle']);
    expect(readiness.kind).toBe('faceDistance');
  });

  it('隣り合う平らな面 2 枚は角度だけ(交わる面の距離は測らない)', () => {
    const readiness = measureReadiness(['extrude-1#face:1', 'extrude-1#face:2'], BODIES);
    expect(readiness.kinds).toEqual(['faceAngle']);
  });

  it('平らでない面が混ざる 2 枚は最短距離だけ(カーネルに任せる)', () => {
    const readiness = measureReadiness(['hole-1#face:0', 'hole-1#face:1'], BODIES);
    expect(readiness.kinds).toEqual(['faceDistance']);
    expect(measureLocally('faceDistance', readiness.targets, BODIES)).toBeNull();
  });

  it('まっすぐな辺 2 本は角度と最短距離(角度が既定)', () => {
    const readiness = measureReadiness(['extrude-1#edge:0', 'extrude-1#edge:1'], BODIES);
    expect(readiness.kinds).toEqual(['edgeAngle', 'edgeDistance']);
    expect(readiness.kind).toBe('edgeAngle');
  });

  it('まっすぐでない辺が混ざる 2 本は最短距離だけ', () => {
    // 円の辺が持つ軸は円が乗る面の法線なので、直線の向きと混ぜて角度にしない。
    expect(measureReadiness(['hole-1#edge:0', 'hole-1#edge:1'], BODIES).kinds).toEqual([
      'edgeDistance',
    ]);
  });

  it('頂点と面は点と面の距離。選んだ順は結果を変えない', () => {
    expect(measureReadiness(['extrude-1#vertex:0', 'extrude-1#face:1'], BODIES).kinds).toEqual([
      'pointFaceDistance',
    ]);
    expect(measureReadiness(['extrude-1#face:1', 'extrude-1#vertex:0'], BODIES).kinds).toEqual([
      'pointFaceDistance',
    ]);
  });

  it('面 1 枚は面積、辺 1 本は長さ', () => {
    expect(measureReadiness(['extrude-1#face:1'], BODIES).kinds).toEqual(['faceArea']);
    expect(measureReadiness(['extrude-1#edge:0'], BODIES).kinds).toEqual(['edgeLength']);
  });

  it('立体 1 つは体積と質量特性(FR-1101)', () => {
    const readiness = measureReadiness(['extrude-1'], BODIES);
    expect(readiness.kinds).toEqual(['bodyVolume', 'massProperties']);
    expect(readiness.targets).toEqual([
      {
        bodyFeatureId: 'extrude-1',
        kind: 'body',
        ref: null,
        index: null,
        elementId: 'extrude-1',
      },
    ]);
  });

  it('測る相手には指紋つきの参照が入る(model の橋渡しへそのまま渡せる)', () => {
    const readiness = measureReadiness(['extrude-1#face:1'], BODIES);
    const target = readiness.targets[0];
    expect(target.bodyFeatureId).toBe('extrude-1');
    expect(target.kind).toBe('face');
    expect(target.index).toBe(1);
    expect(target.elementId).toBe('extrude-1#face:1');
    expect(target.ref).toEqual({
      bodyFeatureId: 'extrude-1',
      index: 1,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    });
  });

  it('measurableKinds は下見と同じ一覧を返す', () => {
    expect(measurableKinds(['extrude-1#face:0', 'extrude-1#face:1'], BODIES)).toEqual([
      'faceDistance',
      'faceAngle',
    ]);
    expect(measurableKinds([], BODIES)).toEqual([]);
  });
});

describe('測れないときは理由を出す(NFR-UX-5)', () => {
  it('何も選んでいない', () => {
    const readiness = measureReadiness([], BODIES);
    expect(readiness.ready).toBe(false);
    expect(readiness.kinds).toEqual([]);
    expect(readiness.kind).toBeNull();
    expect(readiness.targets).toEqual([]);
    expect(readiness.reason).toBe('nothingSelected');
    expect(readiness.message).toBe('測りたいものを 1 つか 2 つ選んでください。');
  });

  it('3 つ以上選んでいる', () => {
    const readiness = measureReadiness(
      ['extrude-1#face:0', 'extrude-1#face:1', 'extrude-1#face:2'],
      BODIES,
    );
    expect(readiness.reason).toBe('tooMany');
    expect(readiness.message).toBe('測れるのは 2 つまでです。選ぶものを減らしてください。');
  });

  it('点 1 つだけでは測れない', () => {
    const readiness = measureReadiness(['extrude-1#vertex:0'], BODIES);
    expect(readiness.reason).toBe('needTwo');
    expect(readiness.message).toBe('距離を測るには 2 つ選んでください。');
  });

  it('立体でも面・辺・頂点でもないものを選んでいる', () => {
    expect(measureReadiness(['line-1'], BODIES).reason).toBe('unsupportedElement');
    expect(measureReadiness(['point-1#3'], BODIES).reason).toBe('unsupportedElement');
  });

  it('選んだものが一覧に無い(形が変わった)', () => {
    expect(measureReadiness(['extrude-1#face:99'], BODIES).reason).toBe('missingTarget');
    expect(measureReadiness(['gone-1#face:0'], BODIES).reason).toBe('missingTarget');
    expect(measureReadiness(['extrude-1#face:99'], BODIES).message).toBe(
      '選んだものが見つかりません。形が変わったため、選び直してください。',
    );
  });

  it('規則に無い組み合わせ(点と辺・面と辺・立体と部分形状)', () => {
    expect(measureReadiness(['extrude-1#vertex:0', 'extrude-1#edge:0'], BODIES).reason).toBe(
      'unsupportedPair',
    );
    expect(measureReadiness(['extrude-1#face:1', 'extrude-1#edge:0'], BODIES).reason).toBe(
      'unsupportedPair',
    );
    // 立体と面のように種類がまたがる組み合わせは、いまも規則が無い。
    expect(measureReadiness(['extrude-1', 'hole-1#face:0'], BODIES).reason).toBe(
      'unsupportedPair',
    );
  });

  /*
    立体 2 つの最短距離(§0.a-0.69、統括の決定 2026-09-05 12:42)。タスク30 の時点では
    「立体どうし」も測れない組み合わせだったが、カーネルの最短距離は形どうし全般で
    測れるため、種類を 1 つ足して測れるようにした(タスク32)。
  */
  it('立体 2 つは最短距離(§0.a-0.69)', () => {
    const readiness = measureReadiness(['extrude-1', 'hole-1'], BODIES);
    expect(readiness.ready).toBe(true);
    expect(readiness.kinds).toEqual(['bodyDistance']);
    expect(readiness.targets.map((target) => target.bodyFeatureId)).toEqual([
      'extrude-1',
      'hole-1',
    ]);
    // 立体そのものなので、部分形状の参照は持たない(model の橋渡しが null を受ける)。
    expect(readiness.targets.every((target) => target.ref === null)).toBe(true);
  });

  it('立体 2 つの最短距離は一覧から出せない(カーネルの役目)', () => {
    const readiness = measureReadiness(['extrude-1', 'hole-1'], BODIES);
    expect(measureLocally('bodyDistance', readiness.targets, BODIES)).toBeNull();
    expect(needsKernel('bodyDistance')).toBe(true);
  });

  it('断りの理由はすべて日本語の文言を持つ(NFR-MA-5)', () => {
    const reasons: readonly MeasureRejectionReason[] = [
      'nothingSelected',
      'tooMany',
      'needTwo',
      'unsupportedElement',
      'unsupportedPair',
      'missingTarget',
    ];
    for (const reason of reasons) {
      expect(t(measureRejectionMessageKey(reason)).length, reason).toBeGreaterThan(0);
    }
  });

  it('カーネルが測れなかったときの断りは文言をそろえる(§0.a-0.30)', () => {
    expect(t(MEASURE_FAILED_MESSAGE_KEY)).toBe('測れませんでした。もう一度お試しください。');
  });
});

describe('カーネルを呼ばずに測る(§2.10.2)', () => {
  it('2 点の距離は √2600 = 50.99019513592785 mm', () => {
    const result = measure(['extrude-1#vertex:0', 'extrude-1#vertex:6']);
    expect(result?.kind).toBe('pointDistance');
    expect(result?.unit).toBe('mm');
    expect(result?.value).toBeCloseTo(Math.sqrt(2600), 9);
    expect(result?.value).toBeCloseTo(50.99019513592785, 9);
    expect(result?.segment).toEqual([
      [0, 0, 0],
      [40, 30, 10],
    ]);
  });

  it('2 点の距離は √1400 = 37.416573867739416 mm(計画書 §2.10.3)', () => {
    const result = measure(['hole-1#vertex:0', 'hole-1#vertex:1']);
    expect(result?.value).toBeCloseTo(37.416573867739416, 9);
  });

  it('向かい合う面の距離は 10 mm。線は面から面へまっすぐ引く', () => {
    const result = measure(['extrude-1#face:0', 'extrude-1#face:1']);
    expect(result?.kind).toBe('faceDistance');
    expect(result?.value).toBeCloseTo(10, 9);
    expect(result?.segment).toEqual([
      [20, 15, 0],
      [20, 15, 10],
    ]);
  });

  it('隣り合う面の角度は 90 度', () => {
    const result = measure(['extrude-1#face:1', 'extrude-1#face:2']);
    expect(result?.kind).toBe('faceAngle');
    expect(result?.unit).toBe('degree');
    expect(result?.value).toBeCloseTo(90, 9);
    expect(result?.segment).toBeNull();
  });

  it('法線 [0,0,1] と [1,0,1]/√2 のなす角は 45 度', () => {
    const result = measure(['wedge-1#face:0', 'wedge-1#face:1'], 'faceAngle');
    expect(result?.value).toBeCloseTo(45, 9);
  });

  it('法線が逆向きの面どうしは 0 度(面の裏表を区別しない)', () => {
    const result = measure(['extrude-1#face:0', 'extrude-1#face:1'], 'faceAngle');
    expect(result?.value).toBeCloseTo(0, 9);
  });

  it('まっすぐな辺 2 本のなす角。直交で 90 度、逆向きで 0 度', () => {
    expect(measure(['extrude-1#edge:0', 'extrude-1#edge:1'])?.value).toBeCloseTo(90, 9);
    expect(measure(['extrude-1#edge:0', 'extrude-1#edge:2'])?.value).toBeCloseTo(0, 9);
  });

  it('辺の長さは 40 mm。線は端から端まで', () => {
    const result = measure(['extrude-1#edge:0']);
    expect(result?.kind).toBe('edgeLength');
    expect(result?.value).toBeCloseTo(40, 9);
    expect(result?.segment).toEqual([
      [0, 0, 0],
      [40, 0, 0],
    ]);
  });

  it('まっすぐでない辺の長さは出すが、線は引かない', () => {
    const result = measure(['hole-1#edge:0']);
    expect(result?.value).toBeCloseTo(2 * Math.PI * 3, 9);
    expect(result?.segment).toBeNull();
  });

  it('面の面積は一覧の値をそのまま出す', () => {
    expect(measure(['extrude-1#face:1'])?.value).toBeCloseTo(1200, 9);
    expect(measure(['extrude-1#face:4'])?.value).toBeCloseTo(300, 9);
    // φ6 深さ 10 の円筒面 2π×3×10、半径 6 の丸い面 π×36(計画書 §2.10.3)。
    expect(measure(['hole-1#face:0'])?.value).toBeCloseTo(188.49555921538757, 6);
    expect(measure(['hole-1#face:1'])?.value).toBeCloseTo(113.09733552923255, 6);
    expect(measure(['extrude-1#face:1'])?.unit).toBe('mm2');
  });

  it('立体の体積は一覧の値をそのまま出す', () => {
    const result = measure(['extrude-1']);
    expect(result?.kind).toBe('bodyVolume');
    expect(result?.value).toBeCloseTo(12000, 9);
    expect(result?.unit).toBe('mm3');
  });

  it('点と平らな面の距離は 10 mm。線は面へ下ろした足まで', () => {
    const result = measure(['extrude-1#vertex:0', 'extrude-1#face:1']);
    expect(result?.kind).toBe('pointFaceDistance');
    expect(result?.value).toBeCloseTo(10, 9);
    expect(result?.segment).toEqual([
      [0, 0, 0],
      [0, 0, 10],
    ]);
  });

  it('点と平らでない面の距離は出せない(カーネルへ回す)', () => {
    const readiness = measureReadiness(['hole-1#vertex:0', 'hole-1#face:0'], BODIES);
    expect(readiness.kinds).toEqual(['pointFaceDistance']);
    expect(measureLocally('pointFaceDistance', readiness.targets, BODIES)).toBeNull();
  });

  it('交わる面どうしの距離は出せない(平行なときだけ測る)', () => {
    const readiness = measureReadiness(['extrude-1#face:1', 'extrude-1#face:2'], BODIES);
    expect(measureLocally('faceDistance', readiness.targets, BODIES)).toBeNull();
  });

  it('最短距離と質量特性はカーネルの役目', () => {
    const edges = measureReadiness(['extrude-1#edge:0', 'extrude-1#edge:1'], BODIES);
    expect(measureLocally('edgeDistance', edges.targets, BODIES)).toBeNull();
    const body = measureReadiness(['extrude-1'], BODIES);
    expect(measureLocally('massProperties', body.targets, BODIES)).toBeNull();
  });

  it('相手が一覧から消えていたら値を出さない', () => {
    const readiness = measureReadiness(['extrude-1#vertex:0', 'extrude-1#vertex:6'], BODIES);
    expect(measureLocally('pointDistance', readiness.targets, [HOLE])).toBeNull();
  });
});

describe('カーネルが要る種類の切り分け(§0.a-0.30)', () => {
  it('最短距離(辺どうし・立体どうし)と質量特性だけがカーネルを要る', () => {
    const withKernel = MEASURE_KIND_ORDER.filter((kind) => needsKernel(kind));
    expect(withKernel).toEqual(['edgeDistance', 'bodyDistance', 'massProperties']);
  });

  it('一覧から出せる種類はカーネルを呼ばずに値が出る', () => {
    expect(needsKernel('pointDistance')).toBe(false);
    expect(needsKernel('faceArea')).toBe(false);
    expect(needsKernel('bodyVolume')).toBe(false);
  });
});

describe('見出しと単位(NFR-MA-5)', () => {
  it('すべての種類に日本語の見出しがある', () => {
    expect(MEASURE_KIND_ORDER).toHaveLength(Object.keys(MEASURE_KIND_LABEL_KEYS).length);
    for (const kind of MEASURE_KIND_ORDER) {
      expect(measureKindLabelKey(kind)).toBe(MEASURE_KIND_LABEL_KEYS[kind]);
      expect(measureKindLabel(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('種類ごとの単位が決まっている', () => {
    expect(measureKindUnit('pointDistance')).toBe('mm');
    expect(measureKindUnit('faceAngle')).toBe('degree');
    expect(measureKindUnit('faceArea')).toBe('mm2');
    expect(measureKindUnit('bodyVolume')).toBe('mm3');
  });
});

describe('測定の表示(小数 3 桁)', () => {
  it('長さは mm を付けて小数 3 桁', () => {
    expect(
      formatMeasure({
        kind: 'pointDistance',
        value: 37.416573867739416,
        unit: 'mm',
        segment: null,
      }),
    ).toBe('37.417 mm');
  });

  it('角度・面積・体積にもそれぞれの単位が付く', () => {
    expect(formatMeasure({ kind: 'faceAngle', value: 90, unit: 'degree', segment: null })).toBe(
      '90.000 度',
    );
    expect(formatMeasure({ kind: 'faceArea', value: 1200, unit: 'mm2', segment: null })).toBe(
      '1200.000 mm²',
    );
    expect(formatMeasure({ kind: 'bodyVolume', value: 12000, unit: 'mm3', segment: null })).toBe(
      '12000.000 mm³',
    );
  });

  it('0 に丸まる値を「-0.000」と出さない', () => {
    expect(formatMeasure({ kind: 'faceAngle', value: -0, unit: 'degree', segment: null })).toBe(
      '0.000 度',
    );
    expect(
      formatMeasure({ kind: 'pointDistance', value: -1e-9, unit: 'mm', segment: null }),
    ).toBe('0.000 mm');
  });

  it('測った結果をそのまま表示できる', () => {
    const result = measure(['extrude-1#face:0', 'extrude-1#face:1']);
    expect(result === null ? '' : formatMeasure(result)).toBe('10.000 mm');
  });

  it('mm を渡しても既存の文言と 1 文字も変わらない(FR-811、P6 タスク3)', () => {
    const distance: LocalMeasureResult = {
      kind: 'pointDistance',
      value: 37.416573867739416,
      unit: 'mm',
      segment: null,
    };
    expect(formatMeasure(distance, 'mm')).toBe(formatMeasure(distance));
    expect(formatMeasure(distance, 'mm')).toBe('37.417 mm');
  });

  it('inch では長さ・面積・体積が次数どおりに換算され、角度は変わらない(P6 §2.9)', () => {
    /*
     * 換算の次数は測る種類で違う(長さは 25.4、面積は 25.4²、体積は 25.4³)。
     * 37.416573867739416 / 25.4 = 1.4730146…→ 1.473、1200 / 645.16 = 1.8600…→ 1.860、
     * 12000 / 16387.064 = 0.73228…→ 0.732。桁は model の `INCH_DISPLAY_DIGITS`(3)。
     */
    expect(
      formatMeasure(
        { kind: 'pointDistance', value: 37.416573867739416, unit: 'mm', segment: null },
        'inch',
      ),
    ).toBe('1.473 in');
    expect(
      formatMeasure({ kind: 'faceArea', value: 1200, unit: 'mm2', segment: null }, 'inch'),
    ).toBe('1.860 in²');
    expect(
      formatMeasure({ kind: 'bodyVolume', value: 12000, unit: 'mm3', segment: null }, 'inch'),
    ).toBe('0.732 in³');
    // 角度は長さの単位に依らない(§2.9 の表)。数も単位の言葉もそのまま。
    expect(
      formatMeasure({ kind: 'faceAngle', value: 90, unit: 'degree', segment: null }, 'inch'),
    ).toBe('90.000 度');
    // 1 inch ちょうどの長さは 1.000 in になる(定義値 25.4 の確認)。
    expect(
      formatMeasure({ kind: 'edgeLength', value: 25.4, unit: 'mm', segment: null }, 'inch'),
    ).toBe('1.000 in');
  });

  it('inch でも 0 に丸まる値を「-0.000」と出さない', () => {
    expect(
      formatMeasure({ kind: 'pointDistance', value: -1e-9, unit: 'mm', segment: null }, 'inch'),
    ).toBe('0.000 in');
    expect(
      formatMeasure({ kind: 'faceAngle', value: -0, unit: 'degree', segment: null }, 'inch'),
    ).toBe('0.000 度');
  });
});
