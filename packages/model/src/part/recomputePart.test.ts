import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  createKernelHealth,
  KERNEL_BROKEN_MESSAGE,
  toAppearanceMatches,
  toAppearanceQueries,
  toSolidOutcome,
  toSolidStepRequest,
  type AppearanceFaceRequest,
  type KernelBridge,
  type MeasureOutcome,
  type PartProgress,
  type SketchOffsetContour,
  type SketchOffsetResult,
  type SketchProjectionResult,
  type SketchTessellationOutcome,
  type SolidBody,
  type SolidRecomputeOutcome,
} from '../kernelBridge.js';
import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  ResolvedCurve,
  SketchDocument,
  SketchFaceFeature,
  SketchFaceMesh,
  SketchFeature,
  SketchLineFeature,
} from '../sketch/types.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  addSketch,
  appendSolid,
  createEmptyPartDocument,
  replaceSketch,
} from './createPartDocument.js';
import { appearanceOf, assignFaceAppearance } from '../appearance/documentAppearance.js';
import { DEFAULT_APPEARANCE } from '../appearance/materialPresets.js';
import { affectsShape } from './documentChange.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart, type ResolvedSolidStep, type SubShapeQueryPlan } from './resolvePart.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ExtrudeFeature,
  PartDocument,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SolidFeature,
} from './types.js';

/** テストの中で式を書くための補助。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// 偽のカーネル(OCCT は読み込まない)
// ---------------------------------------------------------------------------

const EMPTY_SKETCH_OUTCOME: SketchTessellationOutcome = { mesh: { faces: [] }, failures: [] };

const EMPTY_SOLID_OUTCOME: SolidRecomputeOutcome = {
  bodies: [],
  failures: [],
  cacheHits: 0,
  cancelled: false,
};

/** オフセットを頼まないときの戻り値(FR-321、P4 タスク15)。 */
const EMPTY_OFFSET_RESULT: SketchOffsetResult = { results: [], failures: [] };

/** 投影・交差を頼まないときの戻り値(FR-325、P4 タスク25)。 */
const EMPTY_PROJECTION_RESULT: SketchProjectionResult = { results: [], failures: [] };

/**
 * 測定(FR-1101、FR-1102、P5 タスク29)を頼まないときの戻り値。
 * このテストは `measure` を検査しないので、呼ばれたら分かるよう失敗にしておく。
 */
const UNCALLED_MEASURE_OUTCOME: MeasureOutcome = {
  kind: 'failed',
  message: 'このテストの偽のカーネルは measure を検査しません。',
};

/**
 * 偽のカーネル。OCCT は読み込まない(実物は kernel 側の Node テストで確かめてある)。
 * async を使わないのは、await の無い async 関数を書かないため(計画書 §4)。
 */
function fakeBridge(overrides: Partial<KernelBridge> = {}): KernelBridge {
  return {
    tessellateSketchFaces: () => Promise.resolve(EMPTY_SKETCH_OUTCOME),
    recomputeSolids: () => Promise.resolve(EMPTY_SOLID_OUTCOME),
    offsetSketchCurves: () => Promise.resolve(EMPTY_OFFSET_RESULT),
    projectSketchCurves: () => Promise.resolve(EMPTY_PROJECTION_RESULT),
    sectionSketchCurves: () => Promise.resolve(EMPTY_PROJECTION_RESULT),
    measure: () => Promise.resolve(UNCALLED_MEASURE_OUTCOME),
    dispose: () => undefined,
    ...overrides,
  };
}

/** ソリッドの依頼を記録する偽の口。呼ばれた回数と引数をそのまま覚える。 */
function recordSolids(
  outcome: SolidRecomputeOutcome = EMPTY_SOLID_OUTCOME,
): Mock<KernelBridge['recomputeSolids']> {
  return vi.fn<KernelBridge['recomputeSolids']>(() => Promise.resolve(outcome));
}

function faceMesh(featureId: string): SketchFaceMesh {
  return {
    featureId,
    color: DEFAULT_FACE_COLOR,
    positions: new Float32Array([0, 0, 0, 40, 0, 0, 40, 30, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    boundaryPositions: new Float32Array([0, 0, 0, 40, 0, 0]),
  };
}

function solidBody(featureId: string, volume = 12000): SolidBody {
  return {
    featureId,
    mesh: {
      positions: new Float32Array([0, 0, 0, 40, 0, 0, 40, 30, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array([0, 0, 0, 40, 0, 0]),
      triangleCount: 1,
    },
    volume,
    isValid: true,
    // P3 タスク17 で SolidBody に必須で足された欄。ここでは中身を使わない検査ばかりなので
    // 空配列で埋める(kernelBody と同じ考え方)。
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/**
 * kernel が返すボディ 1 つ(@pointercad/kernel の SolidBodyMesh と同じ形)。
 * 型の名前を model のテストへ持ち込まないよう、構造だけで書く。
 *
 * faces / edges / vertices / threadMarks は P3 タスク10 で SolidBodyMesh へ足された欄
 * (計画書 §2.8)。ここでは中身を使わない検査ばかりなので空配列で埋めておく。
 * 中身のある一覧が SolidBody へそのまま写ることは、この関数を使わない
 * 「faces / edges / vertices / threadMarks を model の言葉へそのまま写す」検査(タスク17)で
 * 個別に固定する。
 */
function kernelBody(
  id: string,
  volume: number,
  triangleCount = 12,
  // P5 タスク3 で SolidBodyMesh へ足された任意の欄(表面積と形の種類)。
  // 既定では入れず、詰め替えの検査だけが明示的に渡す。
  extra: { readonly area?: number; readonly bodyKind?: 'solid' | 'shell' } = {},
) {
  return {
    ...extra,
    id,
    positions: new Float32Array([0, 0, 0, 40, 0, 0, 40, 30, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    edgePositions: new Float32Array([0, 0, 0, 40, 0, 0]),
    triangleCount,
    faceCount: 6,
    edgeCount: 12,
    volume,
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

// ---------------------------------------------------------------------------
// 検査の土台
// ---------------------------------------------------------------------------

function addPoints(
  sketch: SketchDocument,
  coordinates: readonly (readonly [number, number, number])[],
): { sketch: SketchDocument; pointIds: readonly string[] } {
  let current = sketch;
  const pointIds: string[] = [];
  for (const [x, y, z] of coordinates) {
    const point = createPointFeature(current, absoluteCoordinate(x, y, z));
    current = appendFeature(current, point);
    pointIds.push(point.id);
  }
  return { sketch: current, pointIds };
}

function addFace(
  sketch: SketchDocument,
  pointIds: readonly string[],
): { sketch: SketchDocument; faceId: string } {
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: pointIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(sketch, face), faceId: face.id };
}

interface Fixture {
  readonly document: PartDocument;
  /** z = 0 の 40×30 の長方形。 */
  readonly faceA: SketchFaceRef;
  /** z = 10 の 40×30 の長方形。 */
  readonly faceB: SketchFaceRef;
  /** (1,2,3) から (4,6,3) への線分。回転軸に使う。 */
  readonly axisLine: SketchLineRef;
}

/** 1 本のスケッチに面 2 枚と線分 1 本を入れた部品。ソリッドはまだ無い。 */
function createFixture(): Fixture {
  const base = createEmptyPartDocument();
  const cornersA = addPoints(base.sketches[0], [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
  ]);
  const faceA = addFace(cornersA.sketch, cornersA.pointIds);
  const cornersB = addPoints(faceA.sketch, [
    [0, 0, 10],
    [40, 0, 10],
    [40, 30, 10],
    [0, 30, 10],
  ]);
  const faceB = addFace(cornersB.sketch, cornersB.pointIds);
  const line: SketchLineFeature = {
    id: nextFeatureId(faceB.sketch, 'line'),
    name: nextFeatureName(faceB.sketch, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from: absoluteCoordinate(1, 2, 3),
    to: absoluteCoordinate(4, 6, 3),
    construction: false,
  };
  const sketch = appendFeature(faceB.sketch, line);
  return {
    document: replaceSketch(base, sketch),
    faceA: { sketchId: sketch.id, faceFeatureId: faceA.faceId },
    faceB: { sketchId: sketch.id, faceFeatureId: faceB.faceId },
    axisLine: { sketchId: sketch.id, lineFeatureId: line.id },
  };
}

/** 境界の点が実在しない面を 1 枚足す。スケッチ側の解決が missingBase で失敗する。 */
function withBrokenFace(document: PartDocument): PartDocument {
  const sketch = document.sketches[0];
  const broken = addFace(sketch, ['point-404']);
  return replaceSketch(document, broken.sketch);
}

function extrudeFeature(
  id: string,
  profile: SketchFaceRef,
  options: { readonly distance?: string; readonly name?: string } = {},
): ExtrudeFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: false,
    kind: 'extrude',
    profile,
    distance: expr(options.distance ?? '10'),
    reversed: false,
    symmetric: false,
  };
}

function revolveFeature(id: string, profile: SketchFaceRef, axis: SketchLineRef): RevolveFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'revolve',
    profile,
    axis: { kind: 'line', line: axis },
    angle: expr('180'),
    reversed: false,
  };
}

function sewFeature(id: string, faces: readonly SketchFaceRef[]): SewFeature {
  return { id, name: id, suppressed: false, kind: 'sew', faces, tolerance: expr('0.01') };
}

function booleanFeature(
  id: string,
  operation: BooleanOperation,
  targetFeatureId: string,
  toolFeatureId: string,
): BooleanFeature {
  return { id, name: id, suppressed: false, kind: 'boolean', operation, targetFeatureId, toolFeatureId };
}

function withSolids(document: PartDocument, ...solids: readonly SolidFeature[]): PartDocument {
  return solids.reduce((current, solid) => appendSolid(current, solid), document);
}

/** 押し出し 1 段だけを持つ部品と、その段の解決結果。 */
function oneExtrude(): { document: PartDocument; step: ResolvedSolidStep } {
  const fixture = createFixture();
  const document = withSolids(
    fixture.document,
    extrudeFeature('extrude-1', fixture.faceA, { name: '押し出し1' }),
  );
  return { document, step: resolvePart(document).steps[0] };
}

// ---------------------------------------------------------------------------
// 再計算の流れ
// ---------------------------------------------------------------------------

describe('部品の再計算(要件§6.3)', () => {
  it('空の部品ではカーネルを 1 回も呼ばない(NFR-PF-1)', async () => {
    const tessellateSketchFaces = vi.fn(() => Promise.resolve(EMPTY_SKETCH_OUTCOME));
    const recomputeSolids = recordSolids();
    const result = await recomputePart(
      createEmptyPartDocument(),
      fakeBridge({ tessellateSketchFaces, recomputeSolids }),
    );

    expect(tessellateSketchFaces).not.toHaveBeenCalled();
    expect(recomputeSolids).not.toHaveBeenCalled();
    expect(result.bodies).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.cacheHits).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.sketches).toHaveLength(1);
    expect(result.sketches[0].mesh).toBeNull();
  });

  it('面はあって段が無ければ、面だけ頼んでソリッドは頼まない', async () => {
    const tessellateSketchFaces = vi.fn(() => Promise.resolve(EMPTY_SKETCH_OUTCOME));
    const recomputeSolids = recordSolids();
    const { document } = createFixture();
    const result = await recomputePart(document, fakeBridge({ tessellateSketchFaces, recomputeSolids }));

    expect(tessellateSketchFaces).toHaveBeenCalledTimes(1);
    expect(recomputeSolids).not.toHaveBeenCalled();
    expect(result.bodies).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('カーネルが返した面をスケッチごとに持ち帰る(FR-309)', async () => {
    const { document, faceA } = createFixture();
    const result = await recomputePart(
      document,
      fakeBridge({
        tessellateSketchFaces: () =>
          Promise.resolve({ mesh: { faces: [faceMesh(faceA.faceFeatureId)] }, failures: [] }),
      }),
    );

    expect(result.sketches).toHaveLength(1);
    expect(result.sketches[0].sketchId).toBe(document.sketches[0].id);
    expect(result.sketches[0].mesh?.faces).toHaveLength(1);
    expect(result.sketches[0].resolved.faces).toHaveLength(2);
  });

  it('段があれば 1 回だけ頼み、解決した段をそのまま渡す(FR-401)', async () => {
    const recomputeSolids = recordSolids();
    const { document, step } = oneExtrude();
    await recomputePart(document, fakeBridge({ recomputeSolids }));

    expect(recomputeSolids).toHaveBeenCalledTimes(1);
    const steps = recomputeSolids.mock.calls[0][0];
    expect(steps).toHaveLength(1);
    expect(steps[0].featureId).toBe('extrude-1');
    expect(steps[0].name).toBe('押し出し1');
    expect(steps[0].visible).toBe(true);
    // 鍵は resolvePart が決めたものをそのまま渡す(NFR-PF-3 のキャッシュがこの鍵で当たる)。
    expect(steps[0].key).toBe(step.key);
    expect(steps[0].plan).toEqual(step.plan);
  });

  /**
   * パラメータ表(FR-207)の配線。**部品の再計算の経路で実際に効く**ことをここで固定する
   * (`reevaluateDocument` が P1 から一度も呼ばれていなかったのと同じ配線もれを防ぐため。
   * docs/報告記録.md 2026-09-04 21:05 の教訓、計画書 タスク3)。
   *
   * 距離の式 `板厚 * 2` は変数表が無ければ評価できず、保存値の 0 が残る。0 の押し出しは
   * `resolvePart` が断って段を作らないので、段が 1 つあって距離が 6 であることが
   * 「表の値が式へ配られた」ことの証明になる。
   */
  /** 距離が `板厚 * 2`(そのままでは評価できない)の押し出しと、板厚の値を持つ部品。 */
  function withThicknessParameter(thickness: string, savedDistance: number): PartDocument {
    const fixture = createFixture();
    const extrude: ExtrudeFeature = {
      ...extrudeFeature('extrude-1', fixture.faceA),
      distance: { source: '板厚 * 2', value: savedDistance, display: String(savedDistance) },
    };
    return {
      ...withSolids(fixture.document, extrude),
      parameters: [{ name: '板厚', value: expr(thickness), unit: 'mm', description: '' }],
    };
  }

  it('パラメータ表の値を全式へ配ってから解決する(FR-207、FR-502)', async () => {
    const recomputeSolids = recordSolids();
    await recomputePart(withThicknessParameter('3', 0), fakeBridge({ recomputeSolids }));

    const steps = recomputeSolids.mock.calls[0][0];
    expect(steps).toHaveLength(1);
    expect(steps[0].plan).toEqual(expect.objectContaining({ kind: 'extrude', distance: 6 }));
  });

  it('パラメータの値を変えると立体の寸法が追従する(板厚 3 → 5 で 6 → 10)', async () => {
    const recomputeSolids = recordSolids();
    await recomputePart(withThicknessParameter('5', 6), fakeBridge({ recomputeSolids }));

    const steps = recomputeSolids.mock.calls[0][0];
    expect(steps[0].plan).toEqual(expect.objectContaining({ kind: 'extrude', distance: 10 }));
  });

  it('段は履歴の順に並び、消費されたボディは visible が false になる(§0.a-0.5)', async () => {
    const recomputeSolids = recordSolids();
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '20' }),
      booleanFeature('subtract-1', 'subtract', 'extrude-1', 'extrude-2'),
    );
    await recomputePart(document, fakeBridge({ recomputeSolids }));

    const steps = recomputeSolids.mock.calls[0][0];
    expect(steps.map((step) => step.featureId)).toEqual(['extrude-1', 'extrude-2', 'subtract-1']);
    expect(steps.map((step) => step.visible)).toEqual([false, false, true]);
  });

  it('解決できなかった段はカーネルへ渡さず、理由を errors に入れる(FR-504)', async () => {
    const recomputeSolids = recordSolids();
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { distance: '0' }),
      extrudeFeature('extrude-2', fixture.faceB),
    );
    const result = await recomputePart(document, fakeBridge({ recomputeSolids }));

    const steps = recomputeSolids.mock.calls[0][0];
    expect(steps.map((step) => step.featureId)).toEqual(['extrude-2']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].featureId).toBe('extrude-1');
    expect(result.errors[0].code).toBe('invalidValue');
  });

  it('成功したボディをそのまま返す(FR-401)', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [solidBody('extrude-1')],
            failures: [],
            cacheHits: 3,
            cancelled: false,
          }),
      }),
    );

    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].featureId).toBe('extrude-1');
    expect(result.bodies[0].volume).toBe(12000);
    expect(result.cacheHits).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('段ごとの失敗を kernelFailed として理由つきで返す(FR-504)', async () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB),
    );
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [solidBody('extrude-2')],
            failures: [{ featureId: 'extrude-1', message: '押し出しても厚みが出ませんでした。' }],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    // 1 段失敗しても残りのボディは残る(止めずに警告する、NFR-RE-1)。
    expect(result.bodies).toHaveLength(1);
    expect(result.errors).toEqual([
      {
        featureId: 'extrude-1',
        code: 'kernelFailed',
        message: '押し出しても厚みが出ませんでした。',
      },
    ]);
  });

  it('ソリッドの呼び出しごと失敗しても例外にせず、全段を kernelFailed にする(FR-504)', async () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB),
    );
    const result = await recomputePart(
      document,
      fakeBridge({ recomputeSolids: () => Promise.reject(new Error('Worker が落ちました')) }),
    );

    expect(result.bodies).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((error) => error.featureId)).toEqual(['extrude-1', 'extrude-2']);
    expect(result.errors[0].code).toBe('kernelFailed');
    expect(result.errors[0].message).toBe('立体を作れませんでした: Worker が落ちました');
  });

  it('スケッチの解決の失敗とカーネルの失敗を errors へ集める(FR-504)', async () => {
    const fixture = createFixture();
    const document = withSolids(
      withBrokenFace(fixture.document),
      extrudeFeature('extrude-1', fixture.faceA),
    );
    const result = await recomputePart(
      document,
      fakeBridge({
        tessellateSketchFaces: () =>
          Promise.resolve({
            mesh: { faces: [] },
            failures: [{ featureId: fixture.faceA.faceFeatureId, message: '面が閉じていません' }],
          }),
      }),
    );

    // 上流(スケッチ)から下流(ソリッド)の順に並べる。
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].code).toBe('missingBase');
    expect(result.errors[1]).toEqual({
      featureId: fixture.faceA.faceFeatureId,
      code: 'kernelFailed',
      message: '面を作れませんでした: 面が閉じていません',
    });
  });

  it('面の呼び出しごと失敗しても例外にせず、頼んだ面すべてを kernelFailed にする', async () => {
    const { document, faceA, faceB } = createFixture();
    const result = await recomputePart(
      document,
      fakeBridge({ tessellateSketchFaces: () => Promise.reject(new Error('Worker が落ちました')) }),
    );

    expect(result.sketches[0].mesh).toBeNull();
    expect(result.errors.map((error) => error.featureId)).toEqual([
      faceA.faceFeatureId,
      faceB.faceFeatureId,
    ]);
    expect(result.errors[0].message).toBe('面を作れませんでした: Worker が落ちました');
  });

  it('進捗をそのまま呼び出し側へ伝える(NFR-PF-4)', async () => {
    const received: PartProgress[] = [];
    const { document } = oneExtrude();
    await recomputePart(
      document,
      fakeBridge({
        // 段を始める前に 1 回ずつ知らせる、という kernel の約束をここで真似る。
        recomputeSolids: (steps, options) => {
          steps.forEach((step, index) => {
            options?.onProgress?.({
              featureId: step.featureId,
              index,
              total: steps.length,
              label: step.name,
            });
          });
          return Promise.resolve(EMPTY_SOLID_OUTCOME);
        },
      }),
      { onProgress: (progress) => received.push(progress) },
    );

    expect(received).toEqual([{ featureId: 'extrude-1', index: 0, total: 1, label: '押し出し1' }]);
  });

  it('中止を尋ねる口をそのまま橋へ渡す(NFR-PF-4)', async () => {
    const recomputeSolids = recordSolids();
    const shouldCancel = (): boolean => true;
    const { document } = oneExtrude();
    await recomputePart(document, fakeBridge({ recomputeSolids }), { shouldCancel });

    expect(recomputeSolids.mock.calls[0][1]?.shouldCancel).toBe(shouldCancel);
  });

  it('打ち切られたことを結果に写す(NFR-PF-4)', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({ bodies: [], failures: [], cacheHits: 0, cancelled: true }),
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(result.bodies).toEqual([]);
  });

  it('世代番号を橋へ渡し、結果にも入れる(古い応答を捨てられるようにする)', async () => {
    const recomputeSolids = recordSolids();
    const { document } = oneExtrude();
    const result = await recomputePart(document, fakeBridge({ recomputeSolids }), { generation: 7 });

    expect(recomputeSolids.mock.calls[0][1]?.generation).toBe(7);
    expect(result.generation).toBe(7);
  });

  it('世代番号を省いたら 0 になる', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(document, fakeBridge());

    expect(result.generation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// カーネルへの詰め替え(kernelBridge.ts)
// ---------------------------------------------------------------------------

describe('段の詰め替え', () => {
  it('押し出しの欄をそのまま渡す(FR-401)', () => {
    const { step } = oneExtrude();
    const request = toSolidStepRequest(step);

    expect(request.id).toBe('extrude-1');
    expect(request.label).toBe('押し出し1');
    expect(request.key).toBe(step.key);
    expect(request.visible).toBe(true);
    expect(request.step).toEqual({
      kind: 'extrude',
      // 4 点の面は 4 本の線分の閉ループになる。
      profile: [
        { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
        { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
        { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
        { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
      ],
      // z = 0 の面の法線は +Z(docs/報告記録.md 2026-09-03 08:23 の②で実測)。
      direction: [0, 0, 1],
      distance: 10,
    });
  });

  it('回転は軸と角(ラジアン)を渡す(FR-402)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, fixture.axisLine),
    );
    const request = toSolidStepRequest(resolvePart(document).steps[0]);

    expect(request.step.kind).toBe('revolve');
    if (request.step.kind === 'revolve') {
      expect(request.step.axisOrigin).toEqual([1, 2, 3]);
      // (4,6,3) − (1,2,3) = (3,4,0)、長さ 5 なので単位ベクトルは (0.6, 0.8, 0)。
      // 3 × (1/5) は double では 0.6000000000000001 になる(2026-09-03 実測)ので、
      // 座標の比較は許容誤差つきで行う(rules/04-設計の規律.md「double + 明示的な許容誤差」)。
      expect(request.step.axisDirection[0]).toBeCloseTo(0.6, 12);
      expect(request.step.axisDirection[1]).toBeCloseTo(0.8, 12);
      expect(request.step.axisDirection[2]).toBe(0);
      expect(request.step.angle).toBeCloseTo(Math.PI, 12);
      expect(request.step.profile).toHaveLength(4);
    }
  });

  it('縫合は面ごとの閉ループと許容量を渡す(FR-403)', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, sewFeature('sew-1', [fixture.faceA, fixture.faceB]));
    const request = toSolidStepRequest(resolvePart(document).steps[0]);

    expect(request.step.kind).toBe('sew');
    if (request.step.kind === 'sew') {
      expect(request.step.profiles).toHaveLength(2);
      expect(request.step.profiles[0]).toHaveLength(4);
      expect(request.step.tolerance).toBe(0.01);
    }
  });

  it('ブーリアンは上流の鍵をそのまま渡す(FR-404)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '20' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const steps = resolvePart(document).steps;
    const request = toSolidStepRequest(steps[2]);

    expect(request.step).toEqual({
      kind: 'boolean',
      operation: 'union',
      targetKey: steps[0].key,
      toolKey: steps[1].key,
    });
    expect(request.visible).toBe(true);
  });

  it('円弧はラジアンのまま渡す(FR-203)', () => {
    const request = toSolidStepRequest({
      featureId: 'extrude-9',
      name: '押し出し9',
      key: 'key-9',
      visible: true,
      plan: {
        kind: 'extrude',
        profile: [
          {
            kind: 'arc',
            featureId: 'a1',
            center: [1, 2, 3],
            normal: [0, 0, 1],
            xAxis: [1, 0, 0],
            radius: 5,
            startAngle: 0,
            endAngle: Math.PI,
          },
        ],
        direction: [0, 0, 1],
        distance: 4,
      },
    });

    expect(request.step).toEqual({
      kind: 'extrude',
      profile: [
        {
          kind: 'arc',
          center: [1, 2, 3],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 5,
          startAngle: 0,
          endAngle: Math.PI,
        },
      ],
      direction: [0, 0, 1],
      distance: 4,
    });
  });

  // -------------------------------------------------------------------------
  // 加工フィーチャーの詰め替え(P3 計画書 §2.4.2、§2.8、タスク17)。
  // -------------------------------------------------------------------------

  /** 面の指紋(SubShapeQueryPlan)を1つ組み立てる。bodyFeatureId は kernel へ渡らない。 */
  function faceRef(index: number): SubShapeQueryPlan {
    return {
      bodyFeatureId: 'extrude-1',
      index,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    };
  }

  /** 辺の指紋を1つ組み立てる。番号だけを変えて並びの検査に使う。 */
  function edgeRef(index: number): SubShapeQueryPlan {
    return {
      bodyFeatureId: 'extrude-1',
      index,
      fingerprint: {
        kind: 'edge',
        curveKind: 'line',
        length: 10,
        position: [0, 0, index],
        axis: [0, 0, 1],
        radius: null,
      },
    };
  }

  it('穴の欄を詰め替える。指紋は bodyFeatureId を落として kernel の形へ写る(FR-405)', () => {
    const request = toSolidStepRequest({
      featureId: 'hole-1',
      name: '穴1',
      key: 'key-hole-1',
      visible: true,
      plan: {
        kind: 'hole',
        targetKey: 'key-extrude-1',
        face: faceRef(3),
        centers: [
          [10, 10, 10],
          [30, 10, 10],
        ],
        diameter: 6,
        depth: 8,
        tiltAngle: 0.1,
        tiltAzimuth: 0.2,
        transforms: [],
      },
    });

    expect(request.step).toEqual({
      kind: 'hole',
      targetKey: 'key-extrude-1',
      face: {
        kind: 'face',
        index: 3,
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
      centers: [
        [10, 10, 10],
        [30, 10, 10],
      ],
      diameter: 6,
      depth: 8,
      tiltAngle: 0.1,
      tiltAzimuth: 0.2,
      transforms: [],
    });
  });

  it('貫通穴は depth が null のまま渡る(§0.a-0.12)', () => {
    const request = toSolidStepRequest({
      featureId: 'hole-2',
      name: '穴2',
      key: 'key-hole-2',
      visible: true,
      plan: {
        kind: 'hole',
        targetKey: 'key-extrude-1',
        face: faceRef(0),
        centers: [[0, 0, 0]],
        diameter: 6,
        depth: null,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
      },
    });

    expect(request.step.kind).toBe('hole');
    if (request.step.kind === 'hole') {
      expect(request.step.depth).toBeNull();
    }
  });

  it('ねじ穴は thread と mark をそのまま渡し、鍵専用の pitch は kernel へ渡らない(FR-406)', () => {
    const request = toSolidStepRequest({
      featureId: 'thread-1',
      name: 'ねじ穴1',
      key: 'key-thread-1',
      visible: true,
      plan: {
        kind: 'thread',
        targetKey: 'key-extrude-1',
        face: faceRef(3),
        centers: [[10, 10, 10]],
        drillDiameter: 4.917468,
        pitch: 1,
        depth: null,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
        thread: { majorDiameter: 6, pitch: 1, length: 10 },
        mark: { majorDiameter: 6, length: 10 },
      },
    });

    expect(request.step).toEqual({
      kind: 'thread',
      targetKey: 'key-extrude-1',
      face: {
        kind: 'face',
        index: 3,
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
      centers: [[10, 10, 10]],
      drillDiameter: 4.917468,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
      thread: { majorDiameter: 6, pitch: 1, length: 10 },
      mark: { majorDiameter: 6, length: 10 },
    });
    // model 側だけが持つ pitch(鍵の材料用、resolvePart.ts の注釈)は kernel の欄に無い。
    expect('pitch' in request.step).toBe(false);
  });

  it('簡略表示のねじ穴は thread が null のまま渡る(§0.a-0.15)', () => {
    const request = toSolidStepRequest({
      featureId: 'thread-2',
      name: 'ねじ穴2',
      key: 'key-thread-2',
      visible: true,
      plan: {
        kind: 'thread',
        targetKey: 'key-extrude-1',
        face: faceRef(0),
        centers: [[0, 0, 0]],
        drillDiameter: 4.917468,
        pitch: 1,
        depth: 10,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
        thread: null,
        mark: { majorDiameter: 6, length: 10 },
      },
    });

    expect(request.step.kind).toBe('thread');
    if (request.step.kind === 'thread') {
      expect(request.step.thread).toBeNull();
      expect(request.step.mark).toEqual({ majorDiameter: 6, length: 10 });
    }
  });

  it('R面取りは targets の並びを保ったまま詰め替える(FR-407)', () => {
    const request = toSolidStepRequest({
      featureId: 'fillet-1',
      name: 'R面取り1',
      key: 'key-fillet-1',
      visible: true,
      plan: {
        kind: 'fillet',
        targetKey: 'key-extrude-1',
        targets: [edgeRef(5), edgeRef(2), edgeRef(9)],
        radius: 2,
      },
    });

    expect(request.step.kind).toBe('fillet');
    if (request.step.kind === 'fillet') {
      expect(request.step.targets.map((target) => target.index)).toEqual([5, 2, 9]);
      expect(request.step.targets[0]).toEqual({
        kind: 'edge',
        index: 5,
        curveKind: 'line',
        length: 10,
        position: [0, 0, 5],
        axis: [0, 0, 1],
        radius: null,
      });
      expect(request.step.radius).toBe(2);
    }
  });

  it('C面取りは size と swapReferenceFace をそのまま渡す(FR-408)', () => {
    const request = toSolidStepRequest({
      featureId: 'chamfer-1',
      name: 'C面取り1',
      key: 'key-chamfer-1',
      visible: true,
      plan: {
        kind: 'chamfer',
        targetKey: 'key-extrude-1',
        targets: [edgeRef(1), edgeRef(4)],
        size: { kind: 'twoDistances', distance1: 1, distance2: 2 },
        swapReferenceFace: true,
      },
    });

    expect(request.step.kind).toBe('chamfer');
    if (request.step.kind === 'chamfer') {
      expect(request.step.targets.map((target) => target.index)).toEqual([1, 4]);
      expect(request.step.size).toEqual({ kind: 'twoDistances', distance1: 1, distance2: 2 });
      expect(request.step.swapReferenceFace).toBe(true);
    }
  });

  it('ばねは対象を持たないので targetKey が無い(§0.36)', () => {
    const request = toSolidStepRequest({
      featureId: 'spring-1',
      name: 'ばね1',
      key: 'key-spring-1',
      visible: true,
      plan: {
        kind: 'spring',
        origin: [0, 0, 0],
        direction: [0, 0, 1],
        coilDiameter: 20,
        wireDiameter: 2,
        pitch: 5,
        turns: 4,
        handedness: 'right',
      },
    });

    expect(request.step).toEqual({
      kind: 'spring',
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      coilDiameter: 20,
      wireDiameter: 2,
      pitch: 5,
      turns: 4,
      handedness: 'right',
    });
    expect('targetKey' in request.step).toBe(false);
  });
});

describe('結果の詰め替え', () => {
  const visibleStep: ResolvedSolidStep = {
    featureId: 'extrude-1',
    name: '押し出し1',
    key: 'key-1',
    visible: true,
    plan: { kind: 'extrude', profile: [], direction: [0, 0, 1], distance: 10 },
  };
  const hiddenStep: ResolvedSolidStep = { ...visibleStep, featureId: 'extrude-2', visible: false };

  it('ボディの欄を model の言葉へ詰め替える(FR-105)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [kernelBody('extrude-1', 12000)],
      failures: [],
      cacheHits: 2,
      cancelled: false,
    });

    expect(outcome.bodies).toHaveLength(1);
    expect(outcome.bodies[0].featureId).toBe('extrude-1');
    expect(outcome.bodies[0].volume).toBe(12000);
    expect(outcome.bodies[0].isValid).toBe(true);
    expect(outcome.bodies[0].mesh.triangleCount).toBe(12);
    expect(outcome.bodies[0].mesh.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(outcome.cacheHits).toBe(2);
    expect(outcome.failures).toEqual([]);
  });

  it('体積が 0 のボディは isValid が false になる', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [kernelBody('extrude-1', 0)],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.bodies[0].isValid).toBe(false);
  });

  it('faces / edges / vertices / threadMarks を model の言葉へそのまま写す(§2.8、タスク17)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [
        {
          id: 'extrude-1',
          positions: new Float32Array([0, 0, 0, 40, 0, 0, 40, 30, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          edgePositions: new Float32Array([0, 0, 0, 40, 0, 0]),
          triangleCount: 1,
          // SolidBody.faces / edges の長さは kernel の faceCount / edgeCount と必ず一致する
          // (計画書 §2.8)。ここでは長さ1の一覧を渡して一致を確かめる。
          faceCount: 1,
          edgeCount: 1,
          volume: 12000,
          faces: [
            {
              index: 0,
              surfaceKind: 'plane',
              area: 1200,
              centroid: [20, 15, 10],
              axis: [0, 0, 1],
              radius: null,
              triangleOffset: 0,
              triangleCount: 1,
            },
          ],
          edges: [
            {
              index: 0,
              curveKind: 'line',
              length: 40,
              midpoint: [20, 0, 0],
              start: [0, 0, 0],
              end: [40, 0, 0],
              axis: [1, 0, 0],
              radius: null,
              segmentOffset: 0,
              segmentCount: 1,
            },
          ],
          vertices: [{ index: 0, position: [0, 0, 0] }],
          threadMarks: [{ origin: [0, 0, 0], direction: [0, 0, 1], majorDiameter: 6, length: 10 }],
        },
      ],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    const body = outcome.bodies[0];
    expect(body.faces).toEqual([
      {
        index: 0,
        surfaceKind: 'plane',
        area: 1200,
        centroid: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
        triangleOffset: 0,
        triangleCount: 1,
      },
    ]);
    expect(body.edges).toEqual([
      {
        index: 0,
        curveKind: 'line',
        length: 40,
        midpoint: [20, 0, 0],
        start: [0, 0, 0],
        end: [40, 0, 0],
        axis: [1, 0, 0],
        radius: null,
        segmentOffset: 0,
        segmentCount: 1,
      },
    ]);
    expect(body.vertices).toEqual([{ index: 0, position: [0, 0, 0] }]);
    expect(body.threadMarks).toEqual([
      { origin: [0, 0, 0], direction: [0, 0, 1], majorDiameter: 6, length: 10 },
    ]);
    // SolidBody の一覧の長さが kernel の faceCount / edgeCount と一致する(計画書 §2.8)。
    expect(body.faces).toHaveLength(1);
    expect(body.edges).toHaveLength(1);
  });

  it('ねじの印が無ければ threadMarks は空配列のまま(§0.a-0.15)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [kernelBody('extrude-1', 12000)],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.bodies[0].threadMarks).toEqual([]);
  });

  it('カーネルの失敗を featureId つきで持ち回る(FR-504)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [],
      failures: [{ id: 'extrude-1', message: '押し出しても厚みが出ませんでした。' }],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.failures).toEqual([
      { featureId: 'extrude-1', message: '押し出しても厚みが出ませんでした。' },
    ]);
  });

  it('画面に出すはずの段の結果が返らなければ、理由を補って失敗にする(FR-504)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.failures).toEqual([
      { featureId: 'extrude-1', message: 'カーネルから立体が返りませんでした。' },
    ]);
  });

  it('消費された段(visible が false)の結果が無くても失敗にしない(§0.a-0.5)', () => {
    const outcome = toSolidOutcome([hiddenStep], {
      bodies: [],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.failures).toEqual([]);
  });

  it('打ち切られたときは、計算していない段を失敗にしない(NFR-PF-4)', () => {
    const outcome = toSolidOutcome([visibleStep], {
      bodies: [],
      failures: [],
      cacheHits: 0,
      cancelled: true,
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Worker の健康状態(kernelBridge.ts の createKernelHealth、§2.9、§0.a-0.19)。
// Worker そのものは Node で起動できないので、判断のロジックだけを検査する
// (docs/報告記録.md 2026-09-02 14:50 の④「Worker の実動作は Node では確かめられない」)。
// ---------------------------------------------------------------------------

describe('createKernelHealth(Worker が壊れたかどうかの状態機械)', () => {
  it('初期状態は壊れていない', () => {
    expect(createKernelHealth().broken).toBe(false);
  });

  it('markBroken を呼ぶと broken が true になる', () => {
    const health = createKernelHealth();
    health.markBroken();
    expect(health.broken).toBe(true);
  });

  it('reset を呼ぶと broken が false に戻る(Worker を作り直したことにする)', () => {
    const health = createKernelHealth();
    health.markBroken();
    health.reset();
    expect(health.broken).toBe(false);
  });

  it('reset の後にもう一度 markBroken すれば再び壊れた状態になる', () => {
    const health = createKernelHealth();
    health.markBroken();
    health.reset();
    health.markBroken();
    expect(health.broken).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// missingSubShape への詰め替え(recomputePart.ts の solidKernelFailed、§0.a-0.5、§2.2.5)。
// ---------------------------------------------------------------------------

describe('missingSubShape への詰め替え(加工するもとの面・辺が見つからない失敗)', () => {
  it('穴が「もとの面が見つかりません」で失敗したら missingSubShape に詰め替える', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [],
            failures: [
              {
                featureId: 'extrude-1',
                message:
                  '穴をあけるもとの面が見つかりません。形が大きく変わったため、選び直してください。',
              },
            ],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    expect(result.errors).toEqual([
      {
        featureId: 'extrude-1',
        code: 'missingSubShape',
        message: '穴をあけるもとの面が見つかりません。形が大きく変わったため、選び直してください。',
      },
    ]);
  });

  it('R面取りが「もとの辺が見つかりません」で失敗したら missingSubShape に詰め替える', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [],
            failures: [
              {
                featureId: 'extrude-1',
                message:
                  '丸めるもとの辺が見つかりません。形が大きく変わったため、選び直してください。',
              },
            ],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    expect(result.errors[0].code).toBe('missingSubShape');
  });

  it('C面取りが「もとの辺が見つかりません」で失敗したら missingSubShape に詰め替える', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [],
            failures: [
              {
                featureId: 'extrude-1',
                message:
                  '面を取るもとの辺が見つかりません。形が大きく変わったため、選び直してください。',
              },
            ],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    expect(result.errors[0].code).toBe('missingSubShape');
  });

  it('「見つかりません」を含んでいても missingSubShape の言い回しでなければ kernelFailed のまま(誤判定防止)', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [],
            failures: [
              { featureId: 'extrude-1', message: 'もとになる立体が見つかりませんでした。' },
            ],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    expect(result.errors).toEqual([
      {
        featureId: 'extrude-1',
        code: 'kernelFailed',
        message: 'もとになる立体が見つかりませんでした。',
      },
    ]);
  });

  it('Worker が壊れたときの理由(KERNEL_BROKEN_MESSAGE)は kernelFailed のまま(§2.9)', async () => {
    const { document } = oneExtrude();
    const result = await recomputePart(
      document,
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({
            bodies: [],
            failures: [{ featureId: 'extrude-1', message: KERNEL_BROKEN_MESSAGE }],
            cacheHits: 0,
            cancelled: false,
          }),
      }),
    );

    expect(result.errors).toEqual([
      { featureId: 'extrude-1', code: 'kernelFailed', message: KERNEL_BROKEN_MESSAGE },
    ]);
  });
});

/*
 * オフセット(FR-321、タスク15・21)は resolvePart 単体では完結せず、`recomputePart` が
 * `resolvePart` → カーネルで形を作る → `resolvePart` をやり直す、の2段で埋める
 * (`recomputeSketch.ts` の同名の2段構成と同じ考え方)。resolvePart / recomputeSketch は
 * それぞれ単体の検査で固定済みなので、ここでは「部品全体を通したときに、この配線が
 * 実際に効くこと」だけを確かめる(統括の目視検査 2026-09-04 で見つかった配線もれの回帰検査)。
 */
describe('部品を通したオフセットの解決(FR-321、タスク21)', () => {
  const RECTANGLE: SketchFeature = {
    id: 'r1',
    name: '矩形1',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0),
    corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  };

  const OFFSET: SketchFeature = {
    id: 'of1',
    name: 'オフセット1',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'offset',
    source: [{ featureId: 'r1' }],
    distance: expr('5'),
    side: 'outside',
    corner: 'sharp',
    construction: false,
  };

  /** 50×40 の閉じた輪郭(40×30 を外へ 5、尖った角。recomputeSketch.test.ts と同じ形)。 */
  const OUTSIDE_RECTANGLE: SketchOffsetContour = {
    closed: true,
    curves: [
      { kind: 'segment', featureId: 'of1', from: [-5, -5, 0], to: [45, -5, 0] },
      { kind: 'segment', featureId: 'of1', from: [45, -5, 0], to: [45, 35, 0] },
      { kind: 'segment', featureId: 'of1', from: [45, 35, 0], to: [-5, 35, 0] },
      { kind: 'segment', featureId: 'of1', from: [-5, 35, 0], to: [-5, -5, 0] },
    ],
  };

  function partWithRectangleAndOffset(): PartDocument {
    const base = createEmptyPartDocument();
    const sketch = appendFeature(appendFeature(base.sketches[0], RECTANGLE), OFFSET);
    return replaceSketch(base, sketch);
  }

  it('resolvePart はカーネルを呼べないので pendingOffsets へ積んだままになる(回帰検査)', () => {
    const resolved = resolvePart(partWithRectangleAndOffset());
    expect(resolved.sketches[0].resolved.pendingOffsets).toHaveLength(1);
    expect(resolved.sketches[0].resolved.segments.filter((s) => s.featureId === 'of1')).toEqual([]);
  });

  it('recomputePart はカーネルへ頼んでオフセットの曲線を解決に差し込む', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve({ results: [{ featureId: 'of1', contours: [OUTSIDE_RECTANGLE] }], failures: [] }),
    );
    const result = await recomputePart(
      partWithRectangleAndOffset(),
      fakeBridge({ offsetSketchCurves }),
    );

    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    const resolvedSketch = result.sketches[0].resolved;
    expect(resolvedSketch.pendingOffsets).toEqual([]);
    expect(resolvedSketch.segments.filter((s) => s.featureId === 'of1')).toHaveLength(4);
  });

  it('オフセットの結果は面の境界にも使える(このタスクの完了条件)', async () => {
    const offsetSketchCurves = () =>
      Promise.resolve<SketchOffsetResult>({
        results: [{ featureId: 'of1', contours: [OUTSIDE_RECTANGLE] }],
        failures: [],
      });
    const withFace = (() => {
      const base = partWithRectangleAndOffset();
      const sketch = appendFeature(base.sketches[0], {
        id: 'face1',
        name: '面1',
        planeId: DEFAULT_WORK_PLANE_ID,
        kind: 'face',
        boundary: [{ featureId: 'of1' }],
        color: DEFAULT_FACE_COLOR,
      });
      return replaceSketch(base, sketch);
    })();

    const result = await recomputePart(withFace, fakeBridge({ offsetSketchCurves }));
    expect(result.errors).toEqual([]);
    expect(result.sketches[0].resolved.faces).toHaveLength(1);
  });

  it('計算済みのオフセットを覚え書きで渡すと、2 回目はカーネルへ頼まない(NFR-PF-2)', async () => {
    const offsetSketchCurves = vi.fn<KernelBridge['offsetSketchCurves']>(() =>
      Promise.resolve({ results: [{ featureId: 'of1', contours: [OUTSIDE_RECTANGLE] }], failures: [] }),
    );
    const offsets = createOffsetCache();
    const document = partWithRectangleAndOffset();
    await recomputePart(document, fakeBridge({ offsetSketchCurves }), { offsets });
    await recomputePart(document, fakeBridge({ offsetSketchCurves }), { offsets });
    expect(offsetSketchCurves).toHaveBeenCalledTimes(1);
  });
});

describe('部品を通した投影・交差の解決(FR-325、タスク25)', () => {
  const FACE_REF: SubShapeRef = {
    bodyFeatureId: 'extrude-1',
    index: 4,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };

  /** カーネルが返したことにする 40×30 の輪郭(線分 4 本)。 */
  const RECTANGLE: readonly ResolvedCurve[] = [
    { kind: 'segment', featureId: 'pj1', from: [0, 0, 0], to: [40, 0, 0] },
    { kind: 'segment', featureId: 'pj1', from: [40, 0, 0], to: [40, 30, 0] },
    { kind: 'segment', featureId: 'pj1', from: [40, 30, 0], to: [0, 30, 0] },
    { kind: 'segment', featureId: 'pj1', from: [0, 30, 0], to: [0, 0, 0] },
  ];

  /**
   * 面Aを押し出した立体と、その面を投影(または交差)して面を張るスケッチ2 を持つ文書。
   * `sketch-2` の面はどの立体も使わないので、順序の制約には引っかからない。
   */
  function partWithProjection(kind: 'projectedCurve' | 'planeSection'): PartDocument {
    const fixture = createFixture();
    const source: SketchFeature =
      kind === 'projectedCurve'
        ? {
            id: 'pj1',
            name: '投影1',
            planeId: DEFAULT_WORK_PLANE_ID,
            kind: 'projectedCurve',
            source: FACE_REF,
            construction: false,
          }
        : {
            id: 'pj1',
            name: '断面1',
            planeId: DEFAULT_WORK_PLANE_ID,
            kind: 'planeSection',
            targetFeatureId: 'extrude-1',
            construction: false,
          };
    const document = addSketch(fixture.document, {
      id: 'sketch-2',
      name: 'スケッチ2',
      features: [
        source,
        {
          id: 'face-pj',
          name: '面-投影',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'face',
          boundary: [{ featureId: 'pj1' }],
          color: DEFAULT_FACE_COLOR,
        },
      ],
    });
    return withSolids(document, extrudeFeature('extrude-1', fixture.faceA));
  }

  /** 立体を 1 つ返す偽のカーネル(投影のもとになる立体が出来たことにする)。 */
  function bridgeWithBody(overrides: Partial<KernelBridge> = {}): KernelBridge {
    return fakeBridge({
      recomputeSolids: () =>
        Promise.resolve({
          bodies: [solidBody('extrude-1')],
          failures: [],
          cacheHits: 0,
          cancelled: false,
        }),
      ...overrides,
    });
  }

  it('resolvePart はカーネルを呼べないので pendingProjections へ積んだままになる(回帰検査)', () => {
    const resolved = resolvePart(partWithProjection('projectedCurve'));
    expect(resolved.sketches[1].resolved.pendingProjections).toHaveLength(1);
    expect(resolved.projections).toHaveLength(1);
  });

  it('recomputePart は投影をカーネルへ頼み、結果を解決へ差し込む(配線の検査)', async () => {
    const projectSketchCurves = vi.fn<KernelBridge['projectSketchCurves']>(() =>
      Promise.resolve({ results: [{ featureId: 'pj1', curves: RECTANGLE }], failures: [] }),
    );
    const result = await recomputePart(
      partWithProjection('projectedCurve'),
      bridgeWithBody({ projectSketchCurves }),
    );

    expect(projectSketchCurves).toHaveBeenCalledTimes(1);
    // 依頼にはもとの立体の段の鍵が乗る(カーネルが形状キャッシュから引くため)。
    const request = projectSketchCurves.mock.calls[0][0][0];
    expect(request.featureId).toBe('pj1');
    expect(request.bodyKey.length).toBeGreaterThan(0);
    expect(request.source).toEqual(FACE_REF);
    expect(result.errors).toEqual([]);
    const sketch2 = result.sketches[1].resolved;
    expect(sketch2.pendingProjections).toEqual([]);
    expect(sketch2.curvesByFeature.get('pj1')).toHaveLength(4);
    // 取り込んだ輪郭は面の境界にそのまま使える(FR-325)。
    expect(sketch2.faces).toHaveLength(1);
  });

  it('交差は sectionSketchCurves へ頼み、立体の指定に指紋を渡さない', async () => {
    const sectionSketchCurves = vi.fn<KernelBridge['sectionSketchCurves']>(() =>
      Promise.resolve({ results: [{ featureId: 'pj1', curves: RECTANGLE }], failures: [] }),
    );
    const projectSketchCurves = vi.fn<KernelBridge['projectSketchCurves']>(() =>
      Promise.resolve(EMPTY_PROJECTION_RESULT),
    );
    const result = await recomputePart(
      partWithProjection('planeSection'),
      bridgeWithBody({ sectionSketchCurves, projectSketchCurves }),
    );

    expect(projectSketchCurves).not.toHaveBeenCalled();
    expect(sectionSketchCurves).toHaveBeenCalledTimes(1);
    expect(sectionSketchCurves.mock.calls[0][0][0].source).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.sketches[1].resolved.curvesByFeature.get('pj1')).toHaveLength(4);
  });

  it('曲線が入ると立体の再計算をもう一度行う(投影の面を使う下流のため)', async () => {
    const recomputeSolids = vi.fn<KernelBridge['recomputeSolids']>(() =>
      Promise.resolve({
        bodies: [solidBody('extrude-1')],
        failures: [],
        cacheHits: 0,
        cancelled: false,
      }),
    );
    await recomputePart(
      partWithProjection('projectedCurve'),
      fakeBridge({
        recomputeSolids,
        projectSketchCurves: () =>
          Promise.resolve({ results: [{ featureId: 'pj1', curves: RECTANGLE }], failures: [] }),
      }),
    );

    expect(recomputeSolids).toHaveBeenCalledTimes(2);
  });

  it('投影を持たない部品では 2 巡目が起きない(費用を増やさない、NFR-PF-3)', async () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA));
    const recomputeSolids = vi.fn<KernelBridge['recomputeSolids']>(() =>
      Promise.resolve({
        bodies: [solidBody('extrude-1')],
        failures: [],
        cacheHits: 0,
        cancelled: false,
      }),
    );

    await recomputePart(document, fakeBridge({ recomputeSolids }));

    expect(recomputeSolids).toHaveBeenCalledTimes(1);
  });

  it('カーネルが断ったときは理由を持ち回り、文書は壊れない(FR-504)', async () => {
    const result = await recomputePart(
      partWithProjection('projectedCurve'),
      bridgeWithBody({
        projectSketchCurves: () =>
          Promise.resolve({
            results: [],
            failures: [{ featureId: 'pj1', message: '投影できる辺がありません。' }],
          }),
      }),
    );

    const failure = result.errors.find((error) => error.featureId === 'pj1');
    expect(failure?.code).toBe('kernelFailed');
    expect(failure?.message).toContain('投影・交差を作れませんでした');
    // もとの立体は返っている(止めずに警告する)。
    expect(result.bodies.map((body) => body.featureId)).toEqual(['extrude-1']);
  });

  it('選び直せなかった面の断りは missingSubShape へ詰め替える', async () => {
    const result = await recomputePart(
      partWithProjection('projectedCurve'),
      bridgeWithBody({
        projectSketchCurves: () =>
          Promise.resolve({
            results: [],
            failures: [
              {
                featureId: 'pj1',
                message: '選んだ面(辺)が見つかりません。形が大きく変わったため、選び直してください。',
              },
            ],
          }),
      }),
    );

    expect(result.errors.find((error) => error.featureId === 'pj1')?.code).toBe('missingSubShape');
  });

  it('Worker との通信ごと失敗しても例外にせず、理由を持ち回る(NFR-RE-1)', async () => {
    const result = await recomputePart(
      partWithProjection('projectedCurve'),
      bridgeWithBody({
        projectSketchCurves: () => Promise.reject(new Error('worker が応答しません')),
      }),
    );

    const failure = result.errors.find((error) => error.featureId === 'pj1');
    expect(failure?.message).toContain('worker が応答しません');
  });

  it('計算済みの投影を覚え書きで渡すと、2 回目はカーネルへ頼まない(NFR-PF-2)', async () => {
    const projectSketchCurves = vi.fn<KernelBridge['projectSketchCurves']>(() =>
      Promise.resolve({ results: [{ featureId: 'pj1', curves: RECTANGLE }], failures: [] }),
    );
    const projections = createProjectionCache();
    const document = partWithProjection('projectedCurve');
    await recomputePart(document, bridgeWithBody({ projectSketchCurves }), { projections });
    await recomputePart(document, bridgeWithBody({ projectSketchCurves }), { projections });

    expect(projectSketchCurves).toHaveBeenCalledTimes(1);
  });

  it('途中で打ち切られたときは投影を頼まない(NFR-PF-4)', async () => {
    const projectSketchCurves = vi.fn<KernelBridge['projectSketchCurves']>(() =>
      Promise.resolve(EMPTY_PROJECTION_RESULT),
    );
    await recomputePart(
      partWithProjection('projectedCurve'),
      fakeBridge({
        recomputeSolids: () =>
          Promise.resolve({ bodies: [], failures: [], cacheHits: 0, cancelled: true }),
        projectSketchCurves,
      }),
    );

    expect(projectSketchCurves).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 外観の橋渡し(FR-1106、FR-428、P5 §2.2.3、タスク4)。
//
// 面に付けた色は指紋で覚えているだけなので、形を作り直すと面の通し番号がずれる。
// 選び直しの採点はカーネルにしか無い(§0.a-0.2)ので、model は「依頼を組み立てて渡し、
// 返った結果を詰め替える」だけを受け持つ。ここで固定するのはその詰め替えの規約である。
// ---------------------------------------------------------------------------

describe('外観の橋渡し(FR-1106、タスク4)', () => {
  const stepA: ResolvedSolidStep = {
    featureId: 'extrude-1',
    name: '押し出し1',
    key: 'key-extrude-1',
    visible: true,
    plan: { kind: 'extrude', profile: [], direction: [0, 0, 1], distance: 10 },
  };
  const stepB: ResolvedSolidStep = {
    ...stepA,
    featureId: 'extrude-2',
    name: '押し出し2',
    key: 'key-extrude-2',
  };

  /** 面の指紋(外観の割り当て先)。番号だけを変えて並びの検査に使う。 */
  function faceRefOf(bodyFeatureId: string, index: number): SubShapeRef {
    return {
      bodyFeatureId,
      index,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    };
  }

  /** 辺の指紋。外観は面にしか付かないので、依頼から落ちることの検査に使う。 */
  function edgeRefOf(bodyFeatureId: string, index: number): SubShapeRef {
    return {
      bodyFeatureId,
      index,
      fingerprint: {
        kind: 'edge',
        curveKind: 'line',
        length: 40,
        position: [20, 0, 10],
        axis: [1, 0, 0],
        radius: null,
      },
    };
  }

  function faceRequest(id: string, bodyFeatureId: string, index: number): AppearanceFaceRequest {
    return { id, bodyFeatureId, ref: faceRefOf(bodyFeatureId, index) };
  }

  // -------------------------------------------------------------------------
  // 依頼の組み立て(toAppearanceQueries)
  // -------------------------------------------------------------------------

  it('割り当てが 1 件も無ければ依頼は空になる(カーネルに費用を払わせない、§0.a-0.54)', () => {
    expect(toAppearanceQueries([stepA, stepB], [])).toEqual([]);
  });

  it('面の割り当て 3 件は依頼 3 件になり、段の鍵とともに渡る', () => {
    const queries = toAppearanceQueries(
      [stepA, stepB],
      [
        faceRequest('appearance-1', 'extrude-1', 0),
        faceRequest('appearance-2', 'extrude-1', 4),
        faceRequest('appearance-3', 'extrude-2', 2),
      ],
    );

    expect(queries).toHaveLength(3);
    expect(queries.map((query) => query.id)).toEqual([
      'appearance-1',
      'appearance-2',
      'appearance-3',
    ]);
    expect(queries.map((query) => query.bodyKey)).toEqual([
      'key-extrude-1',
      'key-extrude-1',
      'key-extrude-2',
    ]);
    // 指紋は kernel の平らな形へ展開され、bodyFeatureId は落ちる(§2.4.2 の詰め替え)。
    expect(queries[1].query).toEqual({
      kind: 'face',
      index: 4,
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    });
  });

  it('段が見つからない割り当ては依頼に乗らない(消えた・抑制された・消費された段)', () => {
    const queries = toAppearanceQueries(
      [stepA],
      [faceRequest('appearance-1', 'extrude-1', 0), faceRequest('appearance-2', 'extrude-404', 1)],
    );

    expect(queries.map((query) => query.id)).toEqual(['appearance-1']);
  });

  it('面以外の指紋は依頼に乗らない(外観は面にしか付かない)', () => {
    const queries = toAppearanceQueries(
      [stepA],
      [{ id: 'appearance-1', bodyFeatureId: 'extrude-1', ref: edgeRefOf('extrude-1', 3) }],
    );

    expect(queries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 結果の詰め替え(toAppearanceMatches)
  // -------------------------------------------------------------------------

  it('照合の結果は依頼と同じ並び・同じ件数で返る', () => {
    const requests = [
      faceRequest('appearance-1', 'extrude-1', 0),
      faceRequest('appearance-2', 'extrude-2', 5),
    ];
    const matches = toAppearanceMatches(requests, [
      { id: 'appearance-2', bodyId: 'extrude-2', faceIndex: 3 },
      { id: 'appearance-1', bodyId: 'extrude-1', faceIndex: 1 },
    ]);

    expect(matches).toEqual([
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 1 },
      { id: 'appearance-2', bodyFeatureId: 'extrude-2', faceIndex: 3 },
    ]);
  });

  it('選び直せなかった割り当ては faceIndex が null で返る(FR-1106 の「警告して既定へ」)', () => {
    const requests = [faceRequest('appearance-1', 'extrude-1', 0)];
    const matches = toAppearanceMatches(requests, [
      { id: 'appearance-1', bodyId: 'extrude-1', faceIndex: null },
    ]);

    expect(matches).toEqual([{ id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: null }]);
  });

  it('カーネルが返さなかった割り当ても null で補い、件数を合わせる', () => {
    const requests = [
      faceRequest('appearance-1', 'extrude-1', 0),
      faceRequest('appearance-2', 'extrude-404', 1),
    ];
    const matches = toAppearanceMatches(requests, [
      { id: 'appearance-1', bodyId: 'extrude-1', faceIndex: 2 },
    ]);

    expect(matches).toEqual([
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 2 },
      // 段が無いので照合しようがない。ボディの id は文書側の値をそのまま見せる。
      { id: 'appearance-2', bodyFeatureId: 'extrude-404', faceIndex: null },
    ]);
  });

  it('カーネルが照合の欄そのものを返さなくても落ちない(欄が任意のあいだの守り)', () => {
    const requests = [faceRequest('appearance-1', 'extrude-1', 0)];

    expect(toAppearanceMatches(requests, undefined)).toEqual([
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: null },
    ]);
  });

  it('依頼が空なら結果も空(頼んでいないものを勝手に返さない)', () => {
    expect(
      toAppearanceMatches([], [{ id: 'appearance-1', bodyId: 'extrude-1', faceIndex: 0 }]),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ボディの表面積と形の種類(FR-1102、FR-428)
  // -------------------------------------------------------------------------

  it('表面積と形の種類をカーネルの値のまま持ち回る', () => {
    const outcome = toSolidOutcome([stepA], {
      bodies: [kernelBody('extrude-1', 12000, 12, { area: 3800, bodyKind: 'solid' })],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    // 40×30×10 の箱の表面積 = 2(40×30 + 40×10 + 30×10) = 2(1200+400+300) = 3800。
    expect(outcome.bodies[0].area).toBe(3800);
    expect(outcome.bodies[0].bodyKind).toBe('solid');
  });

  it('面だけのボディは bodyKind が shell のまま届く(FR-428、タスク41 の下ごしらえ)', () => {
    const outcome = toSolidOutcome([stepA], {
      bodies: [kernelBody('extrude-1', 12000, 12, { area: 400, bodyKind: 'shell' })],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.bodies[0].bodyKind).toBe('shell');
  });

  it('形の種類が来なければ solid として読み、測っていない表面積は空のまま残す', () => {
    const outcome = toSolidOutcome([stepA], {
      bodies: [kernelBody('extrude-1', 12000)],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.bodies[0].bodyKind).toBe('solid');
    // 表面積は依頼が求めたときだけ測る(統括の決定 2026-09-05 07:28)。0 と偽らない。
    expect(outcome.bodies[0].area).toBeUndefined();
  });

  it('外観を頼まなければ照合の結果は空(既存の詰め替えの振る舞いを変えない)', () => {
    const outcome = toSolidOutcome([stepA], {
      bodies: [kernelBody('extrude-1', 12000)],
      failures: [],
      cacheHits: 0,
      cancelled: false,
    });

    expect(outcome.appearanceMatches).toEqual([]);
  });

  it('カーネルの照合の結果を詰め替えて outcome に載せる', () => {
    const requests = [faceRequest('appearance-1', 'extrude-1', 0)];
    const outcome = toSolidOutcome(
      [stepA],
      {
        bodies: [kernelBody('extrude-1', 12000)],
        failures: [],
        cacheHits: 0,
        cancelled: false,
        appearanceMatches: [{ id: 'appearance-1', bodyId: 'extrude-1', faceIndex: 4 }],
      },
      requests,
    );

    expect(outcome.appearanceMatches).toEqual([
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 4 },
    ]);
  });

  // -------------------------------------------------------------------------
  // recomputePart を通した配線(FR-1106)
  // -------------------------------------------------------------------------

  it('割り当てが 1 つも無ければ、橋へ渡す外観の一覧は空(費用ゼロ)', async () => {
    const recomputeSolids = recordSolids();
    const { document } = oneExtrude();
    await recomputePart(document, fakeBridge({ recomputeSolids }));

    expect(recomputeSolids.mock.calls[0][1]?.appearance).toEqual([]);
  });

  it('面へ割り当てた外観を橋へ渡す(立体への割り当ては指紋が無いので渡らない、§2.2.2)', async () => {
    const recomputeSolids = recordSolids();
    const { document } = oneExtrude();
    const painted = assignFaceAppearance(document, faceRefOf('extrude-1', 2), DEFAULT_APPEARANCE);
    await recomputePart(painted, fakeBridge({ recomputeSolids }));

    const appearance = recomputeSolids.mock.calls[0][1]?.appearance;
    expect(appearance).toHaveLength(1);
    expect(appearance?.[0].bodyFeatureId).toBe('extrude-1');
    expect(appearance?.[0].ref.index).toBe(2);
  });

  it('照合の結果を PartRecomputeResult に載せる', async () => {
    const { document } = oneExtrude();
    const painted = assignFaceAppearance(document, faceRefOf('extrude-1', 2), DEFAULT_APPEARANCE);
    const entryId = appearanceOf(painted).entries[0].id;
    const result = await recomputePart(
      painted,
      fakeBridge({
        recomputeSolids: (steps, options) =>
          Promise.resolve(
            toSolidOutcome(
              steps,
              {
                bodies: [kernelBody('extrude-1', 12000)],
                failures: [],
                cacheHits: 0,
                cancelled: false,
                appearanceMatches: [{ id: entryId, bodyId: 'extrude-1', faceIndex: 5 }],
              },
              options?.appearance ?? [],
            ),
          ),
      }),
    );

    expect(result.appearanceMatches).toEqual([
      { id: entryId, bodyFeatureId: 'extrude-1', faceIndex: 5 },
    ]);
  });

  it('カーネルの呼び出しごと失敗したときは照合の結果を空で返す(警告を重ねない)', async () => {
    const { document } = oneExtrude();
    const painted = assignFaceAppearance(document, faceRefOf('extrude-1', 2), DEFAULT_APPEARANCE);
    const result = await recomputePart(
      painted,
      fakeBridge({ recomputeSolids: () => Promise.reject(new Error('通信が切れました')) }),
    );

    expect(result.appearanceMatches).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('外観だけを変えても形に影響せず、段の鍵も変わらない(全段がキャッシュに当たる)', async () => {
    const recomputeSolids = recordSolids();
    const { document } = oneExtrude();
    const painted = assignFaceAppearance(document, faceRefOf('extrude-1', 2), DEFAULT_APPEARANCE);

    // ①そもそも再計算を起こさない判定(画面側はここを見て呼ばない、§2.3.2)。
    expect(affectsShape(document, painted)).toBe(false);

    // ②仮に呼んでも、段の鍵は 1 つも変わらない(cacheKeyFor が外観を見ない、§2.2.3)。
    await recomputePart(document, fakeBridge({ recomputeSolids }));
    await recomputePart(painted, fakeBridge({ recomputeSolids }));

    const before = recomputeSolids.mock.calls[0][0].map((step) => step.key);
    const after = recomputeSolids.mock.calls[1][0].map((step) => step.key);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
  });
});
