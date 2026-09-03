import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  toSolidOutcome,
  toSolidStepRequest,
  type KernelBridge,
  type PartProgress,
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
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  SketchDocument,
  SketchFaceFeature,
  SketchFaceMesh,
  SketchLineFeature,
} from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart, type ResolvedSolidStep } from './resolvePart.js';
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

/**
 * 偽のカーネル。OCCT は読み込まない(実物は kernel 側の Node テストで確かめてある)。
 * async を使わないのは、await の無い async 関数を書かないため(計画書 §4)。
 */
function fakeBridge(overrides: Partial<KernelBridge> = {}): KernelBridge {
  return {
    tessellateSketchFaces: () => Promise.resolve(EMPTY_SKETCH_OUTCOME),
    recomputeSolids: () => Promise.resolve(EMPTY_SOLID_OUTCOME),
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
  };
}

/**
 * kernel が返すボディ 1 つ(@pointercad/kernel の SolidBodyMesh と同じ形)。
 * 型の名前を model のテストへ持ち込まないよう、構造だけで書く。
 */
function kernelBody(id: string, volume: number, triangleCount = 12) {
  return {
    id,
    positions: new Float32Array([0, 0, 0, 40, 0, 0, 40, 30, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    edgePositions: new Float32Array([0, 0, 0, 40, 0, 0]),
    triangleCount,
    faceCount: 6,
    edgeCount: 12,
    volume,
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
