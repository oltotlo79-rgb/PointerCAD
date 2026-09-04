import { describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type {
  CurveSpec,
  PlaneCurve,
  SketchPlaneFrame,
  SolidBodyMesh,
  SolidProgress,
  SolidStepRequest,
  SubShapeQuery,
} from '../types.js';
import { createKernelApi } from './kernelApi.js';

/** XY 平面の 10×10 の正方形を、隣り合う頂点をつなぐ 4 本の線分で表す。 */
const SQUARE_CURVES: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

/** XY 平面の 40×30 の長方形。Z へ 10 押し出すと 40·30·10 = 12000 mm³(手計算)。 */
const RECTANGLE_CURVES: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];
const RECTANGLE_EXTRUDE_VOLUME = 12000;

/** 40×30 の長方形を Z へ distance だけ押し出す 1 段。鍵は検査ごとに変える。 */
function extrudeStep(id: string, key: string, distance: number): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: {
      kind: 'extrude',
      profile: RECTANGLE_CURVES,
      direction: [0, 0, 1],
      distance,
    },
  };
}

/** 線分・円弧の列の長さの合計(mm)。オフセットの結果の確かめに使う。 */
function perimeterOf(curves: readonly CurveSpec[]): number {
  return curves.reduce((sum, curve) => {
    if (curve.kind === 'segment') {
      return (
        sum +
        Math.hypot(
          curve.to[0] - curve.from[0],
          curve.to[1] - curve.from[1],
          curve.to[2] - curve.from[2],
        )
      );
    }
    if (curve.kind === 'arc') {
      return sum + curve.radius * Math.abs(curve.endAngle - curve.startAngle);
    }
    throw new Error(`線分でも円弧でもありません: ${curve.kind}`);
  }, 0);
}

describe('KernelApi', () => {
  const api = createKernelApi(loadOcctForNode);

  it('履歴の段から立体のメッシュを作り、進捗を段ごとに知らせる', async () => {
    const progress: SolidProgress[] = [];
    const result = await api.recomputeSolids(
      { steps: [extrudeStep('extrude-1', 'api-extrude', 10)], generation: 1 },
      {},
      (value) => {
        progress.push(value);
      },
    );

    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('extrude-1');
    expect(result.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
    expect(result.bodies[0].faceCount).toBe(6);
    expect(result.bodies[0].edgeCount).toBe(12);
    expect(progress).toEqual([
      { stepId: 'extrude-1', index: 0, total: 1, label: 'extrude-1' },
    ]);
  });

  it('同じ鍵の依頼を続けて呼ぶと、窓口が持つキャッシュが効く(NFR-PF-3)', async () => {
    const request = {
      steps: [extrudeStep('extrude-1', 'api-cache', 10)],
      generation: 1,
    };

    const first = await api.recomputeSolids(request);
    expect(first.cacheHits).toBe(0);

    const second = await api.recomputeSolids(request);
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].volume).toBeCloseTo(RECTANGLE_EXTRUDE_VOLUME, 6);
  });

  it('作れない段は例外にせず、理由つきの失敗として返す(FR-504)', async () => {
    const result = await api.recomputeSolids({
      steps: [extrudeStep('extrude-1', 'api-bad', 0), extrudeStep('extrude-2', 'api-good', 10)],
      generation: 1,
    });

    expect(result.failures).toEqual([
      { id: 'extrude-1', message: '押し出す長さは 0 より大きい数にしてください。' },
    ]);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-2']);
  });

  it('スケッチの曲線を折れ線にして返す', async () => {
    const result = await api.tessellateSketch({
      curves: [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 10,
          startAngle: 0,
          endAngle: Math.PI / 2,
        },
      ],
      faces: [],
    });
    expect(result.curvePolylines).toHaveLength(2);
    // 線分は 2 点 × 3 座標。円弧は既定の粗さ(0.1mm)で実測 7 点。
    expect(result.curvePolylines[0]).toHaveLength(6);
    expect(result.curvePolylines[1].length).toBeGreaterThan(6);
    expect(result.curvePolylines[1].length % 3).toBe(0);
    expect(result.faces).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('閉ループから面のメッシュ・法線・境界の稜線を返す(FR-309)', async () => {
    const result = await api.tessellateSketch({
      curves: [],
      faces: [{ id: 'square', curves: SQUARE_CURVES }],
    });
    expect(result.curvePolylines).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.faces).toHaveLength(1);

    const face = result.faces[0];
    expect(face.id).toBe('square');
    expect(face.triangleCount).toBe(2);
    expect(face.indices.length).toBe(6);
    expect(face.positions.length / 3).toBe(4);
    expect(face.normals.length).toBe(face.positions.length);
    // 作図面 XY の法線 (0,0,1) と一致する。
    for (let index = 0; index + 2 < face.normals.length; index += 3) {
      expect(face.normals[index]).toBeCloseTo(0, 6);
      expect(face.normals[index + 1]).toBeCloseTo(0, 6);
      expect(face.normals[index + 2]).toBeCloseTo(1, 6);
    }
    // 境界は 4 本の線分。1 本あたり 6 個(始点 xyz + 終点 xyz)。
    expect(face.boundaryEdgeCount).toBe(4);
    expect(face.boundaryPositions.length).toBe(24);

    // Comlink 越しに渡せる型(TypedArray と純データ)だけを使っている。
    expect(face.positions).toBeInstanceOf(Float32Array);
    expect(face.normals).toBeInstanceOf(Float32Array);
    expect(face.indices).toBeInstanceOf(Uint32Array);
    expect(face.boundaryPositions).toBeInstanceOf(Float32Array);
  });

  it('面が 1 枚失敗しても残りは作る(FR-504、NFR-RE-1)', async () => {
    const broken: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
      { kind: 'segment', from: [50, 50, 0], to: [60, 50, 0] },
    ];
    const result = await api.tessellateSketch({
      curves: [],
      faces: [
        { id: 'ok', curves: SQUARE_CURVES },
        { id: 'ng', curves: broken },
      ],
    });
    expect(result.faces.map((face) => face.id)).toEqual(['ok']);
    expect(result.faces[0].triangleCount).toBe(2);
    expect(result.failures).toEqual([
      { id: 'ng', message: '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。' },
    ]);
  });

  it('輪郭をずらした曲線を、1 回の依頼でまとめて返す(FR-321)', async () => {
    // 40×30 の長方形を外へ 5(尖った角)→ 50×40 の線分 4 本。
    // 同じ長方形を内へ 5 → 30×20 の線分 4 本。周の長さは 180 と 100(手計算)。
    const result = await api.offsetSketchCurves({
      items: [
        { id: 'outside', curves: RECTANGLE_CURVES, distance: 5, joinType: 'intersection' },
        { id: 'inside', curves: RECTANGLE_CURVES, distance: -5, joinType: 'intersection' },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.results.map((entry) => entry.id)).toEqual(['outside', 'inside']);
    for (const entry of result.results) {
      expect(entry.contours).toHaveLength(1);
      expect(entry.contours[0].closed).toBe(true);
      expect(entry.contours[0].curves).toHaveLength(4);
    }

    const outside = result.results[0].contours[0].curves;
    const inside = result.results[1].contours[0].curves;
    expect(perimeterOf(outside)).toBeCloseTo(180, 6);
    expect(perimeterOf(inside)).toBeCloseTo(100, 6);
  });

  it('丸い角を頼むと、線分 4 本と半径 5 の円弧 4 本が返る(FR-321)', async () => {
    const result = await api.offsetSketchCurves({
      items: [{ id: 'round', curves: RECTANGLE_CURVES, distance: 5, joinType: 'arc' }],
    });

    expect(result.failures).toEqual([]);
    const curves = result.results[0].contours[0].curves;
    expect(curves.filter((curve) => curve.kind === 'segment')).toHaveLength(4);
    const arcs = curves.filter((curve) => curve.kind === 'arc');
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      expect(arc.radius).toBeCloseTo(5, 9);
    }
  });

  it('ずらせない依頼は例外にせず、理由つきの失敗として返す(FR-504、NFR-RE-1)', async () => {
    const circle: readonly CurveSpec[] = [
      {
        kind: 'arc',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
        radius: 10,
        startAngle: 0,
        endAngle: 2 * Math.PI,
      },
    ];
    const result = await api.offsetSketchCurves({
      items: [
        { id: 'ng', curves: circle, distance: -15, joinType: 'arc' },
        { id: 'ok', curves: circle, distance: -3, joinType: 'arc' },
      ],
    });

    expect(result.failures).toEqual([
      { id: 'ng', message: 'これ以上内側にはオフセットできません。' },
    ]);
    expect(result.results.map((entry) => entry.id)).toEqual(['ok']);
    const arc = result.results[0].contours[0].curves[0];
    if (arc.kind !== 'arc') {
      throw new Error('円弧が返るはず');
    }
    expect(arc.radius).toBeCloseTo(7, 9);
  });

  // ------------------------------------------------------------------
  // 投影・交差(FR-325、P4 タスク25)。形状キャッシュの鍵でもとの立体を引く。
  // ------------------------------------------------------------------

  /** XY と平行な作図面(第 1 軸 = X)。2 次元座標はそのまま (x, y) になる。 */
  function xyPlaneAt(z: number): SketchPlaneFrame {
    return { origin: [0, 0, z], axisU: [1, 0, 0], normal: [0, 0, 1] };
  }

  /** 作図面の上の線分の列がなす閉じた輪郭の面積(靴ひもの公式)。 */
  function planeAreaOf(curves: readonly PlaneCurve[]): number {
    let twice = 0;
    for (const curve of curves) {
      if (curve.kind !== 'segment') {
        throw new Error(`線分が返るはず: ${curve.kind}`);
      }
      twice += curve.from[0] * curve.to[1] - curve.to[0] * curve.from[1];
    }
    return Math.abs(twice) / 2;
  }

  /** 40×30×10 の板を作り、その段の鍵と面の一覧を返す。 */
  async function makePlate(key: string): Promise<SolidBodyMesh> {
    const result = await api.recomputeSolids({
      steps: [extrudeStep('plate', key, 10)],
      generation: 1,
    });
    expect(result.failures).toEqual([]);
    return result.bodies[0];
  }

  /** 一覧の中から、指定した向きの平らな面の指紋を作る。 */
  function planeFaceQuery(body: SolidBodyMesh, height: number): SubShapeQuery {
    const found = body.faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 &&
        Math.abs(face.centroid[2] - height) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`z=${height} の平らな面が見つかりません`);
    }
    return {
      kind: 'face',
      index: found.index,
      surfaceKind: found.surfaceKind,
      area: found.area,
      position: found.centroid,
      axis: found.axis,
      radius: found.radius,
    };
  }

  it('板の上面を XY 面へ投影すると、線分 4 本・面積 1200 の長方形になる(FR-325)', async () => {
    const body = await makePlate('api-project-plate');
    const result = await api.projectSketchCurves({
      items: [
        {
          id: 'proj-1',
          shapeKey: 'api-project-plate',
          subShape: planeFaceQuery(body, 10),
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(1);
    const curves = result.results[0].curves;
    expect(curves).toHaveLength(4);
    expect(planeAreaOf(curves)).toBeCloseTo(1200, 6);
  });

  it('立体そのもの(部分形状の指定なし)を投影すると、潰れない辺だけが返る', async () => {
    await makePlate('api-project-whole');
    const result = await api.projectSketchCurves({
      items: [
        { id: 'proj-2', shapeKey: 'api-project-whole', subShape: null, plane: xyPlaneAt(0) },
      ],
    });

    expect(result.failures).toEqual([]);
    // 箱の 12 辺のうち、作図面の法線と平行な縦 4 本は点に潰れるので 8 本(makeProjection.test.ts)。
    expect(result.results[0].curves).toHaveLength(8);
  });

  it('もとの立体が形状キャッシュに無い依頼は、例外にせず理由つきの失敗にする(FR-504)', async () => {
    const result = await api.projectSketchCurves({
      items: [{ id: 'proj-3', shapeKey: 'api-no-such-key', subShape: null, plane: xyPlaneAt(0) }],
    });

    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      {
        id: 'proj-3',
        message: 'もとになる立体が見つかりませんでした。もう一度計算し直してください。',
      },
    ]);
  });

  it('指紋に合う面が無い依頼は、例外にせず理由つきの失敗にする(FR-504)', async () => {
    await makePlate('api-project-missing');
    const result = await api.projectSketchCurves({
      items: [
        {
          id: 'proj-4',
          shapeKey: 'api-project-missing',
          // 球面は板に 1 枚も無いので、種類の一致条件で候補が 0 になる。
          subShape: {
            kind: 'face',
            index: 99,
            surfaceKind: 'sphere',
            area: 1,
            position: [0, 0, 0],
            axis: null,
            radius: 1,
          },
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.results).toEqual([]);
    expect(result.failures[0].id).toBe('proj-4');
    expect(result.failures[0].message).toContain('形が大きく変わったため、選び直してください。');
  });

  it('板を z=5 の作図面で切ると、線分 4 本・面積 1200 の断面になる(FR-325)', async () => {
    await makePlate('api-section-plate');
    const result = await api.sectionSketchCurves({
      items: [{ id: 'sec-1', shapeKey: 'api-section-plate', plane: xyPlaneAt(5) }],
    });

    expect(result.failures).toEqual([]);
    const curves = result.results[0].curves;
    expect(curves).toHaveLength(4);
    expect(planeAreaOf(curves)).toBeCloseTo(1200, 6);
  });

  it('交わらない作図面で切っても失敗にせず、曲線 0 本で返す(呼び出し側が断る)', async () => {
    await makePlate('api-section-away');
    const result = await api.sectionSketchCurves({
      items: [{ id: 'sec-2', shapeKey: 'api-section-away', plane: xyPlaneAt(50) }],
    });

    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([{ id: 'sec-2', curves: [] }]);
  });

  it('1 件失敗しても残りの投影は作る(FR-504、NFR-RE-1)', async () => {
    const body = await makePlate('api-project-mixed');
    const result = await api.projectSketchCurves({
      items: [
        { id: 'ng', shapeKey: 'api-no-such-key', subShape: null, plane: xyPlaneAt(0) },
        {
          id: 'ok',
          shapeKey: 'api-project-mixed',
          subShape: planeFaceQuery(body, 0),
          plane: xyPlaneAt(0),
        },
      ],
    });

    expect(result.failures.map((failure) => failure.id)).toEqual(['ng']);
    expect(result.results.map((entry) => entry.id)).toEqual(['ok']);
    expect(planeAreaOf(result.results[0].curves)).toBeCloseTo(1200, 6);
  });
});
