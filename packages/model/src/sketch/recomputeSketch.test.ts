import type { ExpressionValue } from '@pointercad/expression';
import { describe, expect, it, vi } from 'vitest';

import {
  toCurveSpec,
  toFaceRequest,
  type KernelBridge,
  type SketchOffsetContour,
  type SketchOffsetResult,
  type SketchProjectionResult,
  type SketchTessellationOutcome,
  type SolidRecomputeOutcome,
} from '../kernelBridge.js';
import { absoluteCoordinate, DEFAULT_FACE_COLOR } from './createSketchDocument.js';
import { createOffsetCache } from './offsetMath.js';
import { recomputeSketch, reevaluateDocument } from './recomputeSketch.js';
import type {
  CopyPlacement,
  ResolvedArc,
  ResolvedEllipse,
  ResolvedFace,
  ResolvedSpline,
  SketchDocument,
  SketchFaceMesh,
  SketchFeature,
} from './types.js';

const EMPTY_OUTCOME: SketchTessellationOutcome = { mesh: { faces: [] }, failures: [] };

/** ソリッドの再計算は使わないが、橋の口はすべて埋める(型検査を通すため)。 */
const EMPTY_SOLID_OUTCOME: SolidRecomputeOutcome = {
  bodies: [],
  failures: [],
  cacheHits: 0,
  cancelled: false,
};

/** オフセットを頼まないときの戻り値(FR-321、タスク15)。 */
const EMPTY_OFFSET_RESULT: SketchOffsetResult = { results: [], failures: [] };

/** 投影・交差を頼まないときの戻り値(FR-325、P4 タスク25)。 */
const EMPTY_PROJECTION_RESULT: SketchProjectionResult = { results: [], failures: [] };

/**
 * 偽のカーネル。OCCT は読み込まない(実物はタスク13・14 の Node テストで確かめる)。
 * async を使わないのは、await の無い async 関数を書かないため(計画書 §4)。
 */
function fakeBridge(overrides: Partial<KernelBridge> = {}): KernelBridge {
  return {
    tessellateSketchFaces: () => Promise.resolve(EMPTY_OUTCOME),
    recomputeSolids: () => Promise.resolve(EMPTY_SOLID_OUTCOME),
    offsetSketchCurves: () => Promise.resolve(EMPTY_OFFSET_RESULT),
    // 投影・交差(FR-325、P4 タスク25)はスケッチ単体では起きない(立体が要る)。
    projectSketchCurves: () => Promise.resolve(EMPTY_PROJECTION_RESULT),
    sectionSketchCurves: () => Promise.resolve(EMPTY_PROJECTION_RESULT),
    dispose: () => undefined,
    ...overrides,
  };
}

function faceMesh(featureId: string, color: string): SketchFaceMesh {
  return {
    featureId,
    color,
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    boundaryPositions: new Float32Array([0, 0, 0, 10, 0, 0]),
  };
}

const POINTS: SketchFeature[] = [
  { id: 'p1', name: '点1', planeId: 'xy', kind: 'point', at: absoluteCoordinate(0, 0, 0) },
  { id: 'p2', name: '点2', planeId: 'xy', kind: 'point', at: absoluteCoordinate(10, 0, 0) },
  { id: 'p3', name: '点3', planeId: 'xy', kind: 'point', at: absoluteCoordinate(10, 10, 0) },
];

const FACE: SketchFeature = {
  id: 'f1',
  name: '面1',
  planeId: 'xy',
  kind: 'face',
  boundary: [{ featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p3' }],
  color: DEFAULT_FACE_COLOR,
};

function documentOf(...features: SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

/** 保存されている式と評価値の組。再評価で value と display だけが変わる(FR-202)。 */
function expressionOf(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

describe('スケッチの再計算(要件§6.3)', () => {
  it('面が無ければカーネルを呼ばない(NFR-PF-1)', async () => {
    const tessellateSketchFaces = vi.fn(() => Promise.resolve(EMPTY_OUTCOME));
    const result = await recomputeSketch(
      documentOf(...POINTS),
      fakeBridge({ tessellateSketchFaces }),
    );

    expect(tessellateSketchFaces).not.toHaveBeenCalled();
    expect(result.mesh).toBeNull();
    expect(result.resolved.points).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
  });

  it('面があれば 1 回だけ呼ぶ(FR-309)', async () => {
    const tessellateSketchFaces = vi.fn(() => Promise.resolve(EMPTY_OUTCOME));
    await recomputeSketch(documentOf(...POINTS, FACE), fakeBridge({ tessellateSketchFaces }));

    expect(tessellateSketchFaces).toHaveBeenCalledTimes(1);
  });

  it('解決した面をそのままカーネルへ渡す(FR-203)', async () => {
    const tessellateSketchFaces = vi.fn((faces: readonly ResolvedFace[]) => {
      expect(faces).toHaveLength(1);
      expect(faces[0].featureId).toBe('f1');
      expect(faces[0].color).toBe(DEFAULT_FACE_COLOR);
      // 3 点の面は 3 本の線分の閉ループになる。
      expect(faces[0].curves).toHaveLength(3);
      return Promise.resolve(EMPTY_OUTCOME);
    });
    await recomputeSketch(documentOf(...POINTS, FACE), fakeBridge({ tessellateSketchFaces }));

    expect(tessellateSketchFaces).toHaveBeenCalledTimes(1);
  });

  it('カーネルが返した面を色つきで受け取る(FR-310)', async () => {
    const result = await recomputeSketch(
      documentOf(...POINTS, FACE),
      fakeBridge({
        tessellateSketchFaces: () =>
          Promise.resolve({ mesh: { faces: [faceMesh('f1', DEFAULT_FACE_COLOR)] }, failures: [] }),
      }),
    );

    expect(result.mesh?.faces).toHaveLength(1);
    expect(result.mesh?.faces[0].featureId).toBe('f1');
    expect(result.mesh?.faces[0].color).toBe(DEFAULT_FACE_COLOR);
    expect(result.errors).toHaveLength(0);
  });

  it('面ごとの失敗を kernelFailed として理由つきで返す(FR-504)', async () => {
    const result = await recomputeSketch(
      documentOf(...POINTS, FACE),
      fakeBridge({
        tessellateSketchFaces: () =>
          Promise.resolve({
            mesh: { faces: [] },
            failures: [{ featureId: 'f1', message: '面が閉じていません' }],
          }),
      }),
    );

    expect(result.mesh?.faces).toHaveLength(0);
    expect(result.errors).toEqual([
      { featureId: 'f1', code: 'kernelFailed', message: '面を作れませんでした: 面が閉じていません' },
    ]);
  });

  it('カーネルが失敗しても例外にせず理由を返す(FR-504、NFR-RE-1)', async () => {
    const result = await recomputeSketch(
      documentOf(...POINTS, FACE),
      fakeBridge({
        tessellateSketchFaces: () => Promise.reject(new Error('面が閉じていません')),
      }),
    );

    expect(result.mesh).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('kernelFailed');
    expect(result.errors[0].message).toBe('面を作れませんでした: 面が閉じていません');
  });

  it('解決の失敗とカーネルの失敗を合わせて返す(FR-504)', async () => {
    const brokenFace: SketchFeature = {
      id: 'f2',
      name: '面2',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'missing' }],
      color: DEFAULT_FACE_COLOR,
    };
    const result = await recomputeSketch(
      documentOf(...POINTS, FACE, brokenFace),
      fakeBridge({
        tessellateSketchFaces: () =>
          Promise.resolve({
            mesh: { faces: [] },
            failures: [{ featureId: 'f1', message: '面が閉じていません' }],
          }),
      }),
    );

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].featureId).toBe('f2');
    expect(result.errors[0].code).toBe('missingBase');
    expect(result.errors[1].featureId).toBe('f1');
    expect(result.errors[1].code).toBe('kernelFailed');
  });

  it('変数を変えると評価値だけが変わり、式文字列は残る(FR-202、FR-206)', () => {
    const withVariable = documentOf({
      id: 'p1',
      name: '点1',
      planeId: 'xy',
      kind: 'point',
      at: {
        mode: 'absolute',
        x: expressionOf('w*2', 0),
        y: expressionOf('0', 0),
        z: expressionOf('0', 0),
      },
    });
    const updated = reevaluateDocument(withVariable, new Map([['w', 5]]));
    const feature = updated.features[0];

    expect(feature.kind).toBe('point');
    if (feature.kind === 'point' && feature.at.mode === 'absolute') {
      expect(feature.at.x.source).toBe('w*2');
      expect(feature.at.x.value).toBe(10);
      expect(feature.at.x.display).toBe('10');
    }
  });

  it('評価できない式は元の値を残す(壊れた文書にしない)', () => {
    const broken = documentOf({
      id: 'p1',
      name: '点1',
      planeId: 'xy',
      kind: 'point',
      at: {
        mode: 'absolute',
        x: expressionOf('w*2', 3),
        y: expressionOf('0', 0),
        z: expressionOf('0', 0),
      },
    });
    const updated = reevaluateDocument(broken, new Map());
    const feature = updated.features[0];

    if (feature.kind === 'point' && feature.at.mode === 'absolute') {
      expect(feature.at.x.source).toBe('w*2');
      expect(feature.at.x.value).toBe(3);
    }
  });

  it('相対・極・円弧・点列の式もすべて評価し直す(FR-206)', () => {
    const document = documentOf(
      {
        id: 'p1',
        name: '点1',
        planeId: 'xy',
        kind: 'point',
        at: absoluteCoordinate(0, 0, 0),
      },
      {
        id: 'l1',
        name: '線分1',
        planeId: 'xy',
        kind: 'line',
        construction: false,
        from: absoluteCoordinate(0, 0, 0),
        to: {
          mode: 'relative',
          base: { kind: 'previous' },
          dx: expressionOf('w', 0),
          dy: expressionOf('0', 0),
          dz: expressionOf('0', 0),
        },
      },
      {
        id: 'a1',
        name: '円弧1',
        planeId: 'xy',
        kind: 'arc',
        construction: false,
        center: {
          mode: 'polar',
          base: { kind: 'origin' },
          distance: expressionOf('w', 0),
          azimuth: expressionOf('0', 0),
          elevation: expressionOf('0', 0),
        },
        radius: expressionOf('w', 0),
        startAngle: expressionOf('0', 0),
        endAngle: expressionOf('w*10', 0),
      },
      {
        id: 'pa1',
        name: '点列1',
        planeId: 'xy',
        kind: 'pointArray',
        layout: {
          kind: 'linear',
          base: absoluteCoordinate(0, 0, 0),
          azimuth: expressionOf('0', 0),
          spacing: expressionOf('w', 0),
          count: expressionOf('w-3', 0),
        },
      },
      FACE,
    );
    const updated = reevaluateDocument(document, new Map([['w', 5]]));

    const line = updated.features[1];
    if (line.kind === 'line' && line.to.mode === 'relative') {
      expect(line.to.dx.value).toBe(5);
      expect(line.to.base).toEqual({ kind: 'previous' });
    }
    const arc = updated.features[2];
    if (arc.kind === 'arc' && arc.center.mode === 'polar') {
      expect(arc.center.distance.value).toBe(5);
      expect(arc.radius.value).toBe(5);
      expect(arc.endAngle.value).toBe(50);
    }
    const array = updated.features[3];
    if (array.kind === 'pointArray' && array.layout.kind === 'linear') {
      expect(array.layout.spacing.value).toBe(5);
      expect(array.layout.count.value).toBe(2);
    }
    // 面は式を持たないのでそのまま残る。
    expect(updated.features[4]).toBe(FACE);
    expect(updated.id).toBe(document.id);
  });
});

describe('カーネルへの詰め替え', () => {
  it('線分をそのまま線分の依頼にする', () => {
    const spec = toCurveSpec({
      kind: 'segment',
      featureId: 'l1',
      from: [0, 0, 0],
      to: [10, 0, 0],
    });

    expect(spec).toEqual({ kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] });
  });

  it('円弧の角度はラジアンのまま渡す(FR-203)', () => {
    const arc: ResolvedArc = {
      kind: 'arc',
      featureId: 'a1',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: Math.PI,
    };

    expect(toCurveSpec(arc)).toEqual({
      kind: 'arc',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: Math.PI,
    });
  });

  it('面の依頼は featureId を id にし、曲線を順に並べる(FR-309)', () => {
    const face: ResolvedFace = {
      featureId: 'f1',
      color: DEFAULT_FACE_COLOR,
      curves: [
        { kind: 'segment', featureId: 'f1', from: [0, 0, 0], to: [10, 0, 0] },
        { kind: 'segment', featureId: 'f1', from: [10, 0, 0], to: [0, 0, 0] },
      ],
    };
    const request = toFaceRequest(face);

    expect(request.id).toBe('f1');
    expect(request.curves).toHaveLength(2);
    expect(request.curves[0]).toEqual({ kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] });
  });

  it('全周の楕円は開始角・終了角を渡さない(カーネルが全周として作る、FR-318)', () => {
    const full: ResolvedEllipse = {
      kind: 'ellipse',
      featureId: 'e1',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: 2 * Math.PI,
    };

    expect(toCurveSpec(full)).toEqual({
      kind: 'ellipse',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
    });
  });

  it('楕円弧はパラメータ角をそのまま渡す(方位角への読み替えは解決の段で済んでいる)', () => {
    const quarter: ResolvedEllipse = {
      kind: 'ellipse',
      featureId: 'e1',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };

    expect(toCurveSpec(quarter)).toEqual({
      kind: 'ellipse',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
  });

  it('スプラインは点の並び・通過点/制御点・閉じるかをそのまま渡す(FR-317)', () => {
    const spline: ResolvedSpline = {
      kind: 'spline',
      featureId: 'sp1',
      mode: 'interpolate',
      points: [
        [0, 0, 0],
        [10, 5, 0],
        [20, 0, 0],
      ],
      closed: true,
    };

    expect(toCurveSpec(spline)).toEqual({
      kind: 'spline',
      mode: 'interpolate',
      points: [
        [0, 0, 0],
        [10, 5, 0],
        [20, 0, 0],
      ],
      closed: true,
    });
  });
});

describe('楕円・スプラインの式の評価し直し(FR-206、タスク5)', () => {
  it('楕円の 5 つの式と、スプラインの点の座標が変数の変更に追従する', () => {
    const document = documentOf(
      {
        id: 'e1',
        name: '楕円1',
        planeId: 'xy',
        kind: 'ellipse',
        center: {
          mode: 'relative',
          base: { kind: 'origin' },
          dx: expressionOf('w', 0),
          dy: expressionOf('0', 0),
          dz: expressionOf('0', 0),
        },
        majorRadius: expressionOf('w*4', 0),
        minorRadius: expressionOf('w*2', 0),
        rotation: expressionOf('w', 0),
        startAngle: expressionOf('0', 0),
        endAngle: expressionOf('w*72', 0),
        construction: false,
      },
      {
        id: 'sp1',
        name: 'スプライン1',
        planeId: 'xy',
        kind: 'spline',
        mode: 'interpolate',
        points: [
          absoluteCoordinate(0, 0, 0),
          {
            mode: 'relative',
            base: { kind: 'previous' },
            dx: expressionOf('w*2', 0),
            dy: expressionOf('w', 0),
            dz: expressionOf('0', 0),
          },
        ],
        closed: false,
        construction: false,
      },
    );
    const updated = reevaluateDocument(document, new Map([['w', 5]]));

    const ellipse = updated.features[0];
    if (ellipse.kind === 'ellipse' && ellipse.center.mode === 'relative') {
      expect(ellipse.center.dx.value).toBe(5);
      expect(ellipse.majorRadius.value).toBe(20);
      expect(ellipse.minorRadius.value).toBe(10);
      expect(ellipse.rotation.value).toBe(5);
      expect(ellipse.endAngle.value).toBe(360);
      // 式の文字列は変えない(FR-202)。
      expect(ellipse.majorRadius.source).toBe('w*4');
    }
    const spline = updated.features[1];
    if (spline.kind === 'spline') {
      const second = spline.points[1];
      expect(second.mode).toBe('relative');
      if (second.mode === 'relative') {
        expect(second.dx.value).toBe(10);
        expect(second.dy.value).toBe(5);
        expect(second.dx.source).toBe('w*2');
      }
    }
  });
});

describe('オフセットの再計算(FR-321、タスク15)', () => {
  const RECTANGLE: SketchFeature = {
    id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  };

  const OFFSET: SketchFeature = {
    id: 'of1', name: 'オフセット1', planeId: 'xy', kind: 'offset',
    source: [{ featureId: 'r1' }], distance: expressionOf('5', 5),
    side: 'outside', corner: 'sharp', construction: false,
  };

  const LINE_A: SketchFeature = {
    id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(20, 0, 0), construction: false,
  };
  const LINE_B: SketchFeature = {
    id: 'l2', name: '線分2', planeId: 'xy', kind: 'line',
    from: absoluteCoordinate(20, 0, 0), to: absoluteCoordinate(20, 15, 0), construction: false,
  };

  /** 50×40 の閉じた輪郭(40×30 を外へ 5、尖った角)。 */
  const OUTSIDE_RECTANGLE: SketchOffsetContour = {
    closed: true,
    curves: [
      { kind: 'segment', featureId: 'of1', from: [-5, -5, 0], to: [45, -5, 0] },
      { kind: 'segment', featureId: 'of1', from: [45, -5, 0], to: [45, 35, 0] },
      { kind: 'segment', featureId: 'of1', from: [45, 35, 0], to: [-5, 35, 0] },
      { kind: 'segment', featureId: 'of1', from: [-5, 35, 0], to: [-5, -5, 0] },
    ],
  };

  /** 折れ線を右(進む向きの -Y 側)へずらした結果。 */
  const OPEN_RIGHT: SketchOffsetContour = {
    closed: false,
    curves: [
      { kind: 'segment', featureId: 'of1', from: [0, -5, 0], to: [25, -5, 0] },
      { kind: 'segment', featureId: 'of1', from: [25, -5, 0], to: [25, 15, 0] },
    ],
  };

  /** 同じ折れ線を左(+Y 側)へずらした結果。 */
  const OPEN_LEFT: SketchOffsetContour = {
    closed: false,
    curves: [
      { kind: 'segment', featureId: 'of1', from: [0, 5, 0], to: [15, 5, 0] },
      { kind: 'segment', featureId: 'of1', from: [15, 5, 0], to: [15, 15, 0] },
    ],
  };

  function offsetResultOf(featureId: string, contour: SketchOffsetContour): SketchOffsetResult {
    return { results: [{ featureId, contours: [contour] }], failures: [] };
  }

  it('依頼をカーネルへ渡し、返った曲線を解決へ差し込む', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve(offsetResultOf('of1', OUTSIDE_RECTANGLE)),
    );
    const result = await recomputeSketch(
      documentOf(RECTANGLE, OFFSET),
      fakeBridge({ offsetSketchCurves }),
    );

    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);
    const requests = offsetSketchCurves.mock.calls[0][0];
    expect(requests).toHaveLength(1);
    expect(requests[0].featureId).toBe('of1');
    expect(requests[0].curves).toHaveLength(4);
    // 閉じた輪郭の外側は正(offsetMath.ts 冒頭の実測)。角は尖らせる指定。
    expect(requests[0].distance).toBe(5);
    expect(requests[0].corner).toBe('sharp');

    expect(result.errors).toEqual([]);
    expect(result.resolved.pendingOffsets).toEqual([]);
    expect(result.resolved.segments.filter((curve) => curve.featureId === 'of1')).toHaveLength(4);
  });

  it('内側を選ぶと符号を反転して頼む', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve(offsetResultOf('of1', OUTSIDE_RECTANGLE)),
    );
    await recomputeSketch(
      documentOf(RECTANGLE, { ...OFFSET, side: 'inside' }),
      fakeBridge({ offsetSketchCurves }),
    );
    expect(offsetSketchCurves.mock.calls[0][0][0].distance).toBe(-5);
  });

  it('オフセットが無ければカーネルへ頼まない(NFR-PF-1)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() => Promise.resolve(EMPTY_OFFSET_RESULT));
    await recomputeSketch(documentOf(RECTANGLE), fakeBridge({ offsetSketchCurves }));
    expect(offsetSketchCurves).not.toHaveBeenCalled();
  });

  it('覚え書きを渡すと 2 回目はカーネルへ頼まない(NFR-PF-2)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve(offsetResultOf('of1', OUTSIDE_RECTANGLE)),
    );
    const offsets = createOffsetCache();
    const document = documentOf(RECTANGLE, OFFSET);
    const bridge = fakeBridge({ offsetSketchCurves });

    await recomputeSketch(document, bridge, { offsets });
    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);

    const second = await recomputeSketch(document, bridge, { offsets });
    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);
    expect(second.resolved.segments.filter((curve) => curve.featureId === 'of1')).toHaveLength(4);
  });

  it('距離を変えると鍵が変わり、もう一度カーネルへ頼む(上流が変われば作り直す)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve(offsetResultOf('of1', OUTSIDE_RECTANGLE)),
    );
    const offsets = createOffsetCache();
    const bridge = fakeBridge({ offsetSketchCurves });

    await recomputeSketch(documentOf(RECTANGLE, OFFSET), bridge, { offsets });
    await recomputeSketch(
      documentOf(RECTANGLE, { ...OFFSET, distance: expressionOf('7', 7) }),
      bridge,
      { offsets },
    );
    expect(offsetSketchCurves).toHaveBeenCalledTimes(2);
    expect(offsetSketchCurves.mock.calls[1][0][0].distance).toBe(7);
  });

  it('開いた曲線が頼んだ側と逆に出たら、符号を反転して頼み直す', async () => {
    // 進む向きは +X、上は +Z なので左は +Y。1 回目は右(-Y)に出るので頼み直す。
    const offsetSketchCurves = vi
      .fn<KernelBridge['offsetSketchCurves']>(() =>
        Promise.resolve(offsetResultOf('of1', OPEN_RIGHT)),
      )
      .mockImplementationOnce(() => Promise.resolve(offsetResultOf('of1', OPEN_RIGHT)))
      .mockImplementationOnce(() => Promise.resolve(offsetResultOf('of1', OPEN_LEFT)));
    const openOffset: SketchFeature = {
      ...OFFSET,
      source: [{ featureId: 'l1' }, { featureId: 'l2' }],
      side: 'outside',
    };
    const result = await recomputeSketch(
      documentOf(LINE_A, LINE_B, openOffset),
      fakeBridge({ offsetSketchCurves }),
    );

    expect(offsetSketchCurves).toHaveBeenCalledTimes(2);
    expect(offsetSketchCurves.mock.calls[0][0][0].distance).toBe(5);
    expect(offsetSketchCurves.mock.calls[1][0][0].distance).toBe(-5);
    expect(result.errors).toEqual([]);
    const created = result.resolved.segments.filter((curve) => curve.featureId === 'of1');
    expect(created).toHaveLength(2);
    expect(created[0].from).toEqual([0, 5, 0]);
  });

  it('開いた曲線が頼んだ側に出ていれば頼み直さない', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() => Promise.resolve(offsetResultOf('of1', OPEN_RIGHT)));
    const openOffset: SketchFeature = {
      ...OFFSET,
      source: [{ featureId: 'l1' }, { featureId: 'l2' }],
      side: 'inside',
    };
    await recomputeSketch(
      documentOf(LINE_A, LINE_B, openOffset),
      fakeBridge({ offsetSketchCurves }),
    );
    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);
  });

  it('カーネルが断ったら理由を errors へ入れ、形は作らない(FR-504)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve<SketchOffsetResult>({
        results: [],
        failures: [{ featureId: 'of1', message: 'これ以上内側にはオフセットできません。' }],
      }),
    );
    const result = await recomputeSketch(
      documentOf(RECTANGLE, OFFSET),
      fakeBridge({ offsetSketchCurves }),
    );

    expect(result.resolved.segments.filter((curve) => curve.featureId === 'of1')).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('kernelFailed');
    expect(result.errors[0].featureId).toBe('of1');
    expect(result.errors[0].message).toContain('これ以上内側には');
  });

  it('カーネルとの通信ごと失敗しても落ちない(NFR-RE-1)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() => Promise.reject(new Error('worker が応答しません')));
    const result = await recomputeSketch(
      documentOf(RECTANGLE, OFFSET),
      fakeBridge({ offsetSketchCurves }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('kernelFailed');
    expect(result.errors[0].message).toContain('worker が応答しません');
  });

  it('オフセットの曲線で面を張れる(押し出しの材料になる)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve(offsetResultOf('of1', OUTSIDE_RECTANGLE)),
    );
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'of1' }], color: DEFAULT_FACE_COLOR,
    };
    const tessellateSketchFaces = vi.fn(() => Promise.resolve(EMPTY_OUTCOME));
    const result = await recomputeSketch(
      documentOf(RECTANGLE, OFFSET, face),
      fakeBridge({ offsetSketchCurves, tessellateSketchFaces }),
    );

    expect(result.resolved.faces).toHaveLength(1);
    expect(result.resolved.faces[0].curves).toHaveLength(4);
    expect(tessellateSketchFaces).toHaveBeenCalledTimes(1);
  });

  it('式を変数で評価し直すと、オフセットの距離も追従する(FR-206)', () => {
    const offset: SketchFeature = {
      ...OFFSET,
      distance: expressionOf('t', 5),
    };
    const updated = reevaluateDocument(
      documentOf(RECTANGLE, offset),
      new Map([['t', 8]]),
    );
    const changed = updated.features[1];
    if (changed.kind !== 'offset') {
      throw new Error('オフセットのはず');
    }
    expect(changed.distance.value).toBe(8);
    expect(changed.distance.source).toBe('t');
  });
});

describe('複製の式の再評価(FR-324、FR-206、タスク20)', () => {
  const LINE: SketchFeature = {
    id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0), construction: false,
  };

  function copyOf(placement: CopyPlacement): SketchFeature {
    return {
      id: 'cp1', name: '複製1', planeId: 'xy', kind: 'copy',
      source: [{ featureId: 'l1' }], placement, construction: false,
    };
  }

  it('直線配列の間隔・個数・向きが変数に追従する', () => {
    const placement: CopyPlacement = {
      kind: 'linearArray',
      direction: {
        mode: 'absolute',
        x: expressionOf('1', 1),
        y: expressionOf('0', 0),
        z: expressionOf('0', 0),
      },
      spacing: expressionOf('t', 20),
      count: expressionOf('n', 3),
    };
    const updated = reevaluateDocument(
      documentOf(LINE, copyOf(placement)),
      new Map([
        ['t', 35],
        ['n', 4],
      ]),
    );
    const changed = updated.features[1];
    if (changed.kind !== 'copy' || changed.placement.kind !== 'linearArray') {
      throw new Error('直線配列のはず');
    }
    expect(changed.placement.spacing.value).toBe(35);
    expect(changed.placement.spacing.source).toBe('t');
    expect(changed.placement.count.value).toBe(4);
  });

  it('円形配列の角度・中心が変数に追従し、全周の印はそのまま残る', () => {
    const placement: CopyPlacement = {
      kind: 'circularArray',
      center: {
        mode: 'absolute',
        x: expressionOf('c', 0),
        y: expressionOf('0', 0),
        z: expressionOf('0', 0),
      },
      angle: expressionOf('a', 90),
      count: expressionOf('3', 3),
      fullCircle: false,
    };
    const updated = reevaluateDocument(
      documentOf(LINE, copyOf(placement)),
      new Map([
        ['a', 180],
        ['c', 5],
      ]),
    );
    const changed = updated.features[1];
    if (changed.kind !== 'copy' || changed.placement.kind !== 'circularArray') {
      throw new Error('円形配列のはず');
    }
    expect(changed.placement.angle.value).toBe(180);
    expect(changed.placement.fullCircle).toBe(false);
    if (changed.placement.center.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(changed.placement.center.x.value).toBe(5);
  });

  it('移動の複写は移動量が追従する', () => {
    const placement: CopyPlacement = {
      kind: 'translate',
      delta: {
        mode: 'absolute',
        x: expressionOf('0', 0),
        y: expressionOf('t', 20),
        z: expressionOf('0', 0),
      },
    };
    const updated = reevaluateDocument(documentOf(LINE, copyOf(placement)), new Map([['t', 45]]));
    const changed = updated.features[1];
    if (changed.kind !== 'copy' || changed.placement.kind !== 'translate') {
      throw new Error('移動のはず');
    }
    if (changed.placement.delta.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(changed.placement.delta.y.value).toBe(45);
  });

  it('鏡像は式を持たないので、評価し直しても中身が変わらない', () => {
    const placement: CopyPlacement = {
      kind: 'mirror',
      basis: { kind: 'axis', axis: { featureId: 'l9' } },
    };
    const feature = copyOf(placement);
    const updated = reevaluateDocument(documentOf(LINE, feature), new Map([['t', 45]]));
    expect(updated.features[1]).toEqual(feature);
  });
});
