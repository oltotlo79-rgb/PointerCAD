import type { ExpressionValue } from '@pointercad/expression';
import { describe, expect, it, vi } from 'vitest';

import {
  toCurveSpec,
  toFaceRequest,
  type KernelBridge,
  type SketchTessellationOutcome,
} from '../kernelBridge.js';
import { absoluteCoordinate, DEFAULT_FACE_COLOR } from './createSketchDocument.js';
import { recomputeSketch, reevaluateDocument } from './recomputeSketch.js';
import type {
  ResolvedArc,
  ResolvedFace,
  SketchDocument,
  SketchFaceMesh,
  SketchFeature,
} from './types.js';

const EMPTY_OUTCOME: SketchTessellationOutcome = { mesh: { faces: [] }, failures: [] };

/**
 * 偽のカーネル。OCCT は読み込まない(実物はタスク13・14 の Node テストで確かめる)。
 * async を使わないのは、await の無い async 関数を書かないため(計画書 §4)。
 */
function fakeBridge(overrides: Partial<KernelBridge> = {}): KernelBridge {
  return {
    tessellateSketchFaces: () => Promise.resolve(EMPTY_OUTCOME),
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
        base: absoluteCoordinate(0, 0, 0),
        azimuth: expressionOf('0', 0),
        spacing: expressionOf('w', 0),
        count: expressionOf('w-3', 0),
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
    if (array.kind === 'pointArray') {
      expect(array.spacing.value).toBe(5);
      expect(array.count.value).toBe(2);
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
});
