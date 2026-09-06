import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument, type MeasureOutcome, type PartDocument } from '@pointercad/model';

import {
  defaultDensityMaterialId,
  densityOf,
  describeMeasureKinds,
  describeMeasureTargets,
  formatMeasurePoint,
  formatMeasureValue,
  formatMoments,
  massPropertiesView,
  measurementFromDistance,
  measurementOf,
  measureToolReadiness,
  runMeasure,
  toModelMeasureTargets,
  type MassPropertiesResult,
  type PartMeasurer,
} from './measureCommands.js';
import {
  measureLocally,
  measureReadiness,
  type LocalMeasureResult,
  type MeasureBody,
  type MeasureKind,
  type MeasureTarget,
} from './measure.js';
import type { SolidEdgeEntry, SolidFaceEntry, SolidVertexEntry } from './subShapeSelection.js';

/*
  検査に使う立体は `measure.test.ts` と同じ 40×30×10 の板(角を原点に置く)と、
  そこから 50mm 離した同じ大きさの板の 2 つ。期待値はすべて手で出す。

    体積          40 × 30 × 10 = 12000 mm³
    上下の面      1200 mm²、間の距離 10 mm
    隣り合う面    なす角 90 度
    2 つの板の隙間 x=40 の面と x=90 の面で 50 mm
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

function vertexAt(index: number, position: readonly [number, number, number]): SolidVertexEntry {
  return { index, position };
}

/** 40×30×10 の板を、原点から `offsetX` だけずらして作る。 */
function board(featureId: string, offsetX: number): MeasureBody {
  const x = (value: number): number => value + offsetX;
  return {
    featureId,
    mesh: NO_MESH,
    volume: 12000,
    faces: [
      planeFace(0, 1200, [x(20), 15, 0], [0, 0, -1]),
      planeFace(1, 1200, [x(20), 15, 10], [0, 0, 1]),
      planeFace(2, 400, [x(20), 0, 5], [0, -1, 0]),
      planeFace(3, 400, [x(20), 30, 5], [0, 1, 0]),
      planeFace(4, 300, [x(0), 15, 5], [-1, 0, 0]),
      planeFace(5, 300, [x(40), 15, 5], [1, 0, 0]),
    ],
    edges: [
      lineEdge(0, [x(0), 0, 0], [x(40), 0, 0]),
      lineEdge(1, [x(40), 0, 0], [x(40), 30, 0]),
      lineEdge(2, [x(0), 0, 0], [x(0), 0, 10]),
    ],
    vertices: [
      vertexAt(0, [x(0), 0, 0]),
      vertexAt(1, [x(40), 0, 0]),
      vertexAt(2, [x(40), 30, 0]),
      vertexAt(3, [x(0), 30, 0]),
      vertexAt(4, [x(0), 0, 10]),
      vertexAt(5, [x(40), 0, 10]),
      vertexAt(6, [x(40), 30, 10]),
      vertexAt(7, [x(0), 30, 10]),
    ],
  };
}

const FIRST = board('extrude-1', 0);
/** 50mm 離した 2 枚目(x=90〜130)。1 枚目の右の面(x=40)との隙間は 50mm。 */
const SECOND = board('extrude-2', 90);
const BODIES: readonly MeasureBody[] = [FIRST, SECOND];

const DOCUMENT: PartDocument = createEmptyPartDocument();

/** 何を聞かれたかを覚えるカーネルの偽物。往復の回数まで検査で固定する。 */
function fakeMeasurer(outcome: MeasureOutcome): {
  readonly measurer: PartMeasurer;
  readonly calls: { kind: string; count: number }[];
} {
  const calls: { kind: string; count: number }[] = [];
  const measurer: PartMeasurer = (_document, _targets, kind) => {
    calls.push({ kind, count: calls.length + 1 });
    return Promise.resolve(outcome);
  };
  return { measurer, calls };
}

/** その選択で測る相手を引く(`runMeasure` と同じ手順)。 */
function targetsOf(selection: readonly string[]): readonly MeasureTarget[] {
  return measureReadiness(selection, BODIES).targets;
}

/**
 * 一覧から測った結果。出せないときはテストの前提が壊れているので落とす
 * (`resolvePart.test.ts` の `extrudePlan` と同じ流儀)。
 */
function localOf(kind: MeasureKind, targets: readonly MeasureTarget[]): LocalMeasureResult {
  const result = measureLocally(kind, targets, BODIES);
  if (result === null) {
    throw new Error(`テストの前提が壊れている: ${kind} を一覧から測れない`);
  }
  return result;
}

describe('「測る」の押せる条件(NFR-UX-5、タスク32)', () => {
  it('何も選んでいなければ押せず、理由は「1 つか 2 つ選んでください」', () => {
    const readiness = measureToolReadiness([], BODIES);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasonKey).toBe('measureError.nothingSelected');
  });

  it('頂点 2 つ・面 2 枚・立体 2 つはどれも押せる', () => {
    expect(
      measureToolReadiness(['extrude-1#vertex:0', 'extrude-1#vertex:6'], BODIES).ready,
    ).toBe(true);
    expect(measureToolReadiness(['extrude-1#face:0', 'extrude-1#face:1'], BODIES).ready).toBe(true);
    expect(measureToolReadiness(['extrude-1', 'extrude-2'], BODIES).ready).toBe(true);
  });

  it('3 つ以上選んでいたら押せず、理由は「2 つまで」', () => {
    const readiness = measureToolReadiness(
      ['extrude-1#vertex:0', 'extrude-1#vertex:1', 'extrude-1#vertex:2'],
      BODIES,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.reasonKey).toBe('measureError.tooMany');
  });

  it('押せるときは理由を持たない(押せる/押せないの表し方を 1 つにする)', () => {
    expect(measureToolReadiness(['extrude-1'], BODIES).reasonKey).toBeNull();
  });
});

describe('選んでいるものと測れるものの要約(プロパティ欄)', () => {
  it('選んだ順に種類の札を並べる', () => {
    expect(describeMeasureTargets(targetsOf(['extrude-1#face:0', 'extrude-1#face:1']))).toBe(
      '面 / 面',
    );
    expect(describeMeasureTargets(targetsOf(['extrude-1', 'extrude-2']))).toBe('立体 / 立体');
  });

  it('測れる種類は見出しで並べ、先頭が既定', () => {
    const kinds = measureReadiness(['extrude-1#face:0', 'extrude-1#face:1'], BODIES).kinds;
    expect(describeMeasureKinds(kinds)).toBe('面と面の距離 / 面と面の角度');
  });
});

describe('プロパティ欄の値の書式(統括の指示: 距離・角度・面積・体積)', () => {
  it('距離は formatLength(1000mm 以上は m)', () => {
    expect(formatMeasureValue({ kind: 'pointDistance', value: 10, unit: 'mm', segment: null })).toBe(
      '10 mm',
    );
    expect(
      formatMeasureValue({ kind: 'pointDistance', value: 1500, unit: 'mm', segment: null }),
    ).toBe('1.5 m');
  });

  it('角度は度で小数 2 桁', () => {
    expect(formatMeasureValue({ kind: 'faceAngle', value: 90, unit: 'degree', segment: null })).toBe(
      '90.00 度',
    );
    expect(
      formatMeasureValue({ kind: 'faceAngle', value: 45.678, unit: 'degree', segment: null }),
    ).toBe('45.68 度');
  });

  it('面積は mm²、体積は mm³', () => {
    expect(formatMeasureValue({ kind: 'faceArea', value: 1200, unit: 'mm2', segment: null })).toBe(
      '1200 mm²',
    );
    expect(
      formatMeasureValue({ kind: 'bodyVolume', value: 12000, unit: 'mm3', segment: null }),
    ).toBe('12000 mm³');
  });

  it('重心と慣性モーメントは 3 つ並べて単位を添える', () => {
    expect(formatMeasurePoint([10, 10, 10])).toBe('10, 10, 10 mm');
    expect(formatMoments([1, 2, 3])).toBe('1, 2, 3 g·mm²');
  });

  it('重心の表示だけは 1nm まで丸める(積分の誤差を「0」と書く)', () => {
    /*
      左右対称な箱の重心でも、カーネルの積分は 1.22e-17 のような誤差を残す
      (2026-09-05 のヘッドレスで実測)。12 桁の表示規則をそのまま当てると
      「0.0000000000000000122124532709」になり、真ん中にあることが読み取れない。
    */
    expect(formatMeasurePoint([1.2212453270876722e-17, 1.7763568394002505e-17, 0])).toBe(
      '0, 0, 0 mm',
    );
    // 1nm より大きいずれは残す(測った値をむやみに丸めない)。
    expect(formatMeasurePoint([0.0000015, 0, 0])).toBe('0.000002, 0, 0 mm');
    // −0 は「0」と書く。
    expect(formatMeasurePoint([-1e-18, 0, 0])).toBe('0, 0, 0 mm');
  });
});

describe('画面へ出す 1 件の組み立て(タスク31 の入れ物へ渡す形)', () => {
  it('2 点の距離は線 1 本。札は小数 3 桁のまま(画面とプロパティで書式が違う)', () => {
    const targets = targetsOf(['extrude-1#vertex:0', 'extrude-1#vertex:6']);
    const measurement = measurementOf(localOf('pointDistance', targets), targets, BODIES);
    expect(measurement.text).toBe('50.990 mm');
    expect(measurement.angle).toBeNull();
    expect(measurement.result.segment).toEqual([
      [0, 0, 0],
      [40, 30, 10],
    ]);
  });

  it('面 2 枚の角度は弧の描き方を添える(頂は重心の中点、向きは鋭角側へそろえる)', () => {
    const targets = targetsOf(['extrude-1#face:1', 'extrude-1#face:5']);
    const measurement = measurementOf(localOf('faceAngle', targets), targets, BODIES);
    expect(measurement.result.value).toBeCloseTo(90, 9);
    expect(measurement.angle).not.toBeNull();
    // 上面の重心 [20,15,10] と右面の重心 [40,15,5] の中点。
    expect(measurement.angle?.apex).toEqual([30, 15, 7.5]);
    expect(measurement.angle?.from).toEqual([0, 0, 1]);
    expect(measurement.angle?.to).toEqual([1, 0, 0]);
    expect(measurement.angle?.radius).toBeGreaterThan(0);
  });

  it('向かい合う面どうしは 2 枚目の法線を鋭角側へ裏返す(逆向きの 2 本を描かない)', () => {
    const targets = targetsOf(['extrude-1#face:0', 'extrude-1#face:1']);
    const measurement = measurementOf(localOf('faceAngle', targets), targets, BODIES);
    // 下面 [0,0,-1] と上面 [0,0,1] は逆向き。上面の側を裏返すので 2 本は同じ向きになる。
    expect(measurement.angle?.from[2]).toBeCloseTo(-1, 9);
    expect(measurement.angle?.to[2]).toBeCloseTo(-1, 9);
    // なす角は 0 度(面の裏表を区別しない、`measure.ts` と同じ扱い)。
    expect(measurement.result.value).toBeCloseTo(0, 9);
  });

  it('辺 2 本の角度は共有する角を頂にする', () => {
    const targets = targetsOf(['extrude-1#edge:0', 'extrude-1#edge:2']);
    const measurement = measurementOf(localOf('edgeAngle', targets), targets, BODIES);
    expect(measurement.result.value).toBeCloseTo(90, 9);
    // 辺0 は [0,0,0]→[40,0,0]、辺2 は [0,0,0]→[0,0,10]。共有する角は原点。
    expect(measurement.angle?.apex).toEqual([0, 0, 0]);
    expect(measurement.angle?.from).toEqual([40, 0, 0]);
    expect(measurement.angle?.to).toEqual([0, 0, 10]);
  });

  it('面積は面の重心に、体積は立体の真ん中に札だけを置く', () => {
    const faceTargets = targetsOf(['extrude-1#face:1']);
    const face = measurementOf(localOf('faceArea', faceTargets), faceTargets, BODIES);
    expect(face.anchor).toEqual([20, 15, 10]);
    expect(face.result.segment).toBeNull();

    const bodyTargets = targetsOf(['extrude-1']);
    const body = measurementOf(localOf('bodyVolume', bodyTargets), bodyTargets, BODIES);
    // 8 頂点の平均。
    expect(body.anchor).toEqual([20, 15, 5]);
  });

  it('カーネルの最短距離は 2 つの最近点を結ぶ線になる', () => {
    const measurement = measurementFromDistance('bodyDistance', 50, [40, 15, 5], [90, 15, 5]);
    expect(measurement.text).toBe('50.000 mm');
    expect(measurement.result.kind).toBe('bodyDistance');
    expect(measurement.result.segment).toEqual([
      [40, 15, 5],
      [90, 15, 5],
    ]);
    expect(measurement.anchor).toBeNull();
  });
});

describe('model の橋渡しへ渡す形(タスク29 の MeasureTarget)', () => {
  it('立体そのものは指紋を持たず、部分形状は指紋つきの参照を持つ', () => {
    const bodies = toModelMeasureTargets(targetsOf(['extrude-1', 'extrude-2']));
    expect(bodies.map((target) => target.bodyFeatureId)).toEqual(['extrude-1', 'extrude-2']);
    expect(bodies.every((target) => target.subShape === null)).toBe(true);

    const faces = toModelMeasureTargets(targetsOf(['extrude-1#face:0', 'extrude-1#face:1']));
    expect(faces[0].subShape?.index).toBe(0);
    expect(faces[0].subShape?.fingerprint.kind).toBe('face');
  });
});

describe('測る 1 手(§2.10.2 の往復の切り分け)', () => {
  it('2 点の距離はカーネルを呼ばずに測れる', async () => {
    const { measurer, calls } = fakeMeasurer({ kind: 'failed', message: '呼ばれないはず' });
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1#vertex:0', 'extrude-1#vertex:6'],
      bodies: BODIES,
      measurer,
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('立体 2 つの隙間はカーネルへ 1 往復だけ(§0.a-0.69)', async () => {
    const { measurer, calls } = fakeMeasurer({
      kind: 'distance',
      distance: 50,
      pointA: [40, 15, 5],
      pointB: [90, 15, 5],
      inner: false,
    });
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1', 'extrude-2'],
      bodies: BODIES,
      measurer,
    });
    expect(outcome.ok && outcome.measurement.result.kind).toBe('bodyDistance');
    expect(outcome.ok && outcome.measurement.result.value).toBe(50);
    expect(calls.map((call) => call.kind)).toEqual(['distance']);
  });

  it('立体 1 つは体積を一覧から出し、質量特性だけをカーネルへ聞く(FR-1101)', async () => {
    const { measurer, calls } = fakeMeasurer({
      kind: 'massProperties',
      volume: 12000,
      area: 3400,
      centreOfMass: [20, 15, 5],
      principalMoments: [1, 2, 3],
      principalAxes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    });
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1'],
      bodies: BODIES,
      measurer,
    });
    expect(outcome.ok && outcome.measurement.result.kind).toBe('bodyVolume');
    expect(outcome.ok && outcome.measurement.result.value).toBe(12000);
    expect(outcome.ok && outcome.massProperties?.centreOfMass).toEqual([20, 15, 5]);
    expect(calls.map((call) => call.kind)).toEqual(['massProperties']);
  });

  it('何も選んでいなければ測らず、日本語の理由を返す(NFR-UX-5)', async () => {
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: [],
      bodies: BODIES,
      measurer: null,
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reasonKey).toBe('measureError.nothingSelected');
  });

  it('カーネルが無いときは往復の要る測定だけを断る', async () => {
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1', 'extrude-2'],
      bodies: BODIES,
      measurer: null,
    });
    expect(!outcome.ok && outcome.reasonKey).toBe('measureError.failed');
  });

  it('カーネルが投げても落ちず、断りに変える(NFR-RE-1)', async () => {
    const measurer: PartMeasurer = () => Promise.reject(new Error('Worker が落ちた'));
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1', 'extrude-2'],
      bodies: BODIES,
      measurer,
    });
    expect(!outcome.ok && outcome.reasonKey).toBe('measureError.failed');
  });

  it('質量特性が測れなくても、体積の測定そのものは断らない', async () => {
    const { measurer } = fakeMeasurer({ kind: 'failed', message: '測れませんでした' });
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1'],
      bodies: BODIES,
      measurer,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.massProperties).toBeNull();
  });
});

describe('質量特性(FR-1101、§0.a-0.31、§0.a-0.32)', () => {
  /** 10×20×30 の箱。X 軸まわりの体積の 2 次モーメントは V(b²+c²)/12 = 650000 mm⁵。 */
  const BOX_10_20_30: MassPropertiesResult = {
    bodyFeatureId: 'box-1',
    volume: 6000,
    area: 2200,
    centreOfMass: [5, 10, 15],
    principalMoments: [650000, 500000, 250000],
  };

  it('100×100×10 の板を鋼(7.85)で 785 g(計画書 §2.10.3)', () => {
    const plate: MassPropertiesResult = {
      bodyFeatureId: 'extrude-1',
      volume: 100000,
      area: 24000,
      centreOfMass: [0, 0, 0],
      principalMoments: [0, 0, 0],
    };
    expect(massPropertiesView(plate, 7.85).mass).toBeCloseTo(785, 9);
  });

  it('箱 10×20×30 を鋼で 47.1 g、X 軸まわりの慣性は 5102.5 g·mm²(計画書 §2.10.3)', () => {
    const view = massPropertiesView(BOX_10_20_30, 7.85);
    expect(view.mass).toBeCloseTo(47.1, 9);
    expect(view.moments[0]).toBeCloseTo(5102.5, 6);
  });

  it('材料をアルミ(2.68)にすると質量が変わる', () => {
    const steel = massPropertiesView(BOX_10_20_30, densityOf('steel')).mass;
    const aluminum = massPropertiesView(BOX_10_20_30, densityOf('aluminum')).mass;
    expect(steel).toBeCloseTo(47.1, 9);
    expect(aluminum).toBeCloseTo(16.08, 9);
    expect(aluminum).toBeLessThan(steel);
  });

  it('既定の材料は外観のプリセットから決まる(§0.a-0.31)', () => {
    expect(defaultDensityMaterialId('aluminum', null)).toBe('aluminum');
    expect(defaultDensityMaterialId('stainless', null)).toBe('stainless');
    expect(defaultDensityMaterialId('wood', 'oak')).toBe('wood-oak');
    // 対応の無い外観(既定・鏡)は鋼にする。
    expect(defaultDensityMaterialId('default', null)).toBe('steel');
    expect(defaultDensityMaterialId('mirror', null)).toBe('steel');
  });

  it('知らない材料の密度は既定の材料(鋼 7.85)へ落とす', () => {
    expect(densityOf('steel')).toBe(7.85);
    expect(densityOf('aluminum')).toBe(2.68);
    expect(densityOf('この材料はない')).toBe(7.85);
  });

  it('密度は掛けるだけで丸めない(rules/04 の数値精度)', () => {
    const view = massPropertiesView(BOX_10_20_30, 1.234_567_891_234);
    expect(view.mass).toBe(6000 * 1.234_567_891_234 * 1e-3);
  });
});

describe('測る手立ての差し込み(タスク32 の配線)', () => {
  it('カーネルが「形が見つからない」と断ったら、そのまま断りに変える(§0.a-0.30)', async () => {
    const { measurer, calls } = fakeMeasurer({
      kind: 'failed',
      message: '測れませんでした。もう一度お試しください。',
    });
    const outcome = await runMeasure({
      document: DOCUMENT,
      selection: ['extrude-1', 'extrude-2'],
      bodies: BODIES,
      measurer,
    });
    expect(calls).toHaveLength(1);
    expect(!outcome.ok && outcome.reasonKey).toBe('measureError.failed');
  });
});

describe('測定の札が表示の単位で出る(P6 タスク3 の配線、FR-811)', () => {
  it('一覧から出せた測定の札は inch で出る(値は mm のまま)', () => {
    const targets = targetsOf(['extrude-1#vertex:0', 'extrude-1#vertex:6']);
    const local = localOf('pointDistance', targets);
    expect(measurementOf(local, targets, BODIES, 'inch').text).toBe('2.007 in');
    // 単位を省いたとき・mm を渡したときは P5 までと 1 文字も変わらない。
    expect(measurementOf(local, targets, BODIES).text).toBe('50.990 mm');
    expect(measurementOf(local, targets, BODIES, 'mm').text).toBe('50.990 mm');
    // 測った値そのものは mm のまま(NFR-RE-3)。
    expect(measurementOf(local, targets, BODIES, 'inch').result.value).toBe(local.value);
  });

  it('カーネルの最短距離の札も inch で出る', () => {
    expect(measurementFromDistance('bodyDistance', 50.8, [0, 0, 0], [50.8, 0, 0], 'inch').text).toBe(
      '2.000 in',
    );
    expect(measurementFromDistance('bodyDistance', 50.8, [0, 0, 0], [50.8, 0, 0]).text).toBe(
      '50.800 mm',
    );
  });

  it('角度の札は表示の単位に影響されない(FR-205)', () => {
    const targets = targetsOf(['extrude-1#face:1', 'extrude-1#face:5']);
    const local = localOf('faceAngle', targets);
    expect(measurementOf(local, targets, BODIES, 'inch').text).toBe(
      measurementOf(local, targets, BODIES, 'mm').text,
    );
  });
});
