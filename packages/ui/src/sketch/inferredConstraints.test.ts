/**
 * 拘束の自動推定の予告と確定(FR-333、計画書 docs/plans/P6-入出力.md タスク41)の検査。
 *
 * 判定そのもの(3°・6 画素・優先順位・上限 2 つ)は model の `inferConstraints.test.ts`
 * (タスク40)で押さえてあるので、ここで確かめるのは **ui 側の 3 つ**だけ。
 *   ①近くの要素の絞り込み(画面上の距離で測る。全要素を回さない、NFR-PF-1)。
 *   ②予告の印(P4b と同じ図柄・最大 2 つ)。
 *   ③確定したときに拘束が増えること(FR-313)と、入切・Shift で止まること。
 *
 * 画面への写し方は**引数で注入する**(`ProjectToScreen`)ので、three.js も DOM も要らない。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  resolveSketch,
  sketchConstraints,
  WORK_PLANES,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import { constraintKindSymbol } from './constraintSummary.js';
import {
  applyInferredConstraints,
  inferredConstraintPreview,
  INFERENCE_NEARBY_RADIUS_PIXELS,
  nearbyInferenceElements,
  pixelsPerMillimetreAt,
  sameInferredPreview,
  screenDistanceToSegment,
  type InferencePreviewInput,
} from './inferredConstraints.js';
import type { ProjectToScreen } from './snapMath.js';

/** 検査に使う作図面。XY 面(u = X、v = Y)。 */
const PLANE = WORK_PLANES.xy;

/** `pointermove` 1 回の上限(NFR-PF-1。60fps の 1 コマ)。**この数は緩めない。** */
const POINTER_MOVE_BUDGET_MS = 16;

/**
 * 画面への写し方。XY 面を真上から見た平行投影で、1mm が `scale` 画素。
 * y は画面の下が正なので符号を返す(実物のビューポートと同じ向き)。
 */
function projector(scale: number): ProjectToScreen {
  return (point: Vec3) => [point[0] * scale, -point[1] * scale] as const;
}

/** 1mm = 4 画素。一致の判定(画面上 6 画素)は 1.5mm に当たる。 */
const SCALE = 4;
const project = projector(SCALE);

function lineAt(
  document: SketchDocument,
  id: string,
  from: readonly [number, number],
  to: readonly [number, number],
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], 0),
    to: absoluteCoordinate(to[0], to[1], 0),
    construction: false,
  });
}

function pointAt(
  document: SketchDocument,
  id: string,
  at: readonly [number, number],
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(at[0], at[1], 0),
  });
}

function arcAt(
  document: SketchDocument,
  id: string,
  centre: readonly [number, number],
  radius: number,
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(centre[0], centre[1], 0),
    radius: expressionValueFromNumber(radius),
    startAngle: expressionValueFromNumber(0),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
}

function resolvedOf(document: SketchDocument): ResolvedSketch {
  return resolveSketch(document);
}

/** 予告 1 回ぶんの材料。既定は「入」「Shift を押していない」。 */
function previewInput(
  document: SketchDocument,
  from: readonly [number, number],
  to: readonly [number, number],
  overrides: Partial<InferencePreviewInput> = {},
): InferencePreviewInput {
  return {
    resolved: resolvedOf(document),
    document,
    plane: PLANE,
    draftFeatureId: 'line-draft',
    fromWorld: [from[0], from[1], 0],
    toWorld: [to[0], to[1], 0],
    project,
    enabled: true,
    suspended: false,
    ...overrides,
  };
}

describe('inferredConstraintPreview(予告の組み立て)', () => {
  it('水平に近い線を引くと、印が 1 つ出る', () => {
    // 角度 atan(5/100) = 2.8624° < 3°(§2.15 の検証表)。
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 5]),
    );
    expect(preview).not.toBeNull();
    expect(preview?.constraints).toHaveLength(1);
    expect(preview?.constraints[0].kind).toBe('horizontal');
    expect(preview?.marks).toHaveLength(1);
  });

  it('印の記号は P4b の拘束の図柄と同じものを使う', () => {
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 5]),
    );
    expect(preview?.marks[0].symbol).toBe(constraintKindSymbol('horizontal'));
    // 予告は「これから付く拘束」なので、矛盾・冗長の色にはしない。
    expect(preview?.marks[0].state).toBe('ok');
  });

  it('印は作図面の上の予告位置(markerAt)をワールドへ戻したところに出る', () => {
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 0]),
    );
    // 水平の印は線の中央(§2.15 のタスク40 の実装)。
    expect(preview?.marks[0].position[0]).toBeCloseTo(50, 9);
    expect(preview?.marks[0].position[1]).toBeCloseTo(0, 9);
  });

  it('3° を外れる線では予告しない', () => {
    // 角度 atan(6/100) = 3.4336° > 3°。
    expect(
      inferredConstraintPreview(previewInput(createEmptySketchDocument(), [0, 0], [100, 6])),
    ).toBeNull();
  });

  it('Shift を押している間は印が出ない(§0.a-0.50)', () => {
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 5], { suspended: true }),
    );
    expect(preview).toBeNull();
  });

  it('入切を切ると印が出ない(§0.a-0.49)', () => {
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 5], { enabled: false }),
    );
    expect(preview).toBeNull();
  });

  it('印は同時に最大 2 つまで(§2.15)', () => {
    /*
      両端が既存の点に一致し、寄せたあとは水平にもなる線を引く。当てはまるのは 3 つだが、
      優先順位(一致 > 接線 > 水平・垂直 > 平行)の上から 2 つだけが出る。
    */
    let document = pointAt(createEmptySketchDocument(), 'point-1', [0, 0]);
    document = pointAt(document, 'point-2', [100, 0]);
    const preview = inferredConstraintPreview(previewInput(document, [0.2, 0], [99.8, 0]));
    expect(preview?.constraints).toHaveLength(2);
    expect(preview?.constraints.map((one) => one.kind)).toStrictEqual([
      'coincident',
      'coincident',
    ]);
    expect(preview?.marks).toHaveLength(2);
  });

  it('画面へ写せない線(視線と平行な面など)では予告しない', () => {
    const preview = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 5], { project: () => null }),
    );
    expect(preview).toBeNull();
  });
});

describe('nearbyInferenceElements(近くの要素の絞り込み)', () => {
  it('引いている線から遠い線分は相手にしない(全要素を回さない、NFR-PF-1)', () => {
    // 1mm = 4 画素なので、120 画素は 30mm。100mm 離した線は候補から落ちる。
    const document = lineAt(createEmptySketchDocument(), 'line-1', [0, 100], [100, 100]);
    const nearby = nearbyInferenceElements(resolvedOf(document), project, [
      [0, 0],
      [400, 0],
    ]);
    expect(nearby.segments).toHaveLength(0);
  });

  it('端は遠くても、線のどこかが近ければ平行の相手になる', () => {
    /*
      端点までの距離ではなく**線分までの最短距離**で測る(`screenDistanceToSegment`)。
      端点で測ると、長い線と平行に引いているのに相手として拾えなくなる。
    */
    const document = lineAt(createEmptySketchDocument(), 'line-1', [-500, 1], [500, 1]);
    const nearby = nearbyInferenceElements(resolvedOf(document), project, [
      [0, 0],
      [400, 0],
    ]);
    expect(nearby.segments).toHaveLength(1);
  });

  it('中心が遠い大きな円でも、円周が近ければ接線の相手になる', () => {
    // 中心は 200mm(= 800 画素)先だが、円周は原点を通る。
    const document = arcAt(createEmptySketchDocument(), 'arc-1', [0, 200], 200);
    const nearby = nearbyInferenceElements(resolvedOf(document), project, [[0, 0]]);
    expect(nearby.arcs).toHaveLength(1);
  });

  it('円周も中心も遠い円は相手にしない', () => {
    const document = arcAt(createEmptySketchDocument(), 'arc-1', [0, 200], 10);
    const nearby = nearbyInferenceElements(resolvedOf(document), project, [[0, 0]]);
    expect(nearby.arcs).toHaveLength(0);
  });

  it('画面へ写せない要素は相手にしない', () => {
    const document = pointAt(createEmptySketchDocument(), 'point-1', [0, 0]);
    const nearby = nearbyInferenceElements(resolvedOf(document), () => null, [[0, 0]]);
    expect(nearby.points).toHaveLength(0);
  });

  it('画面上の点と線分の距離は、線分の外側では近いほうの端との距離になる', () => {
    expect(screenDistanceToSegment([0, 0], [10, 0], [5, 3])).toBeCloseTo(3, 9);
    expect(screenDistanceToSegment([0, 0], [10, 0], [20, 0])).toBeCloseTo(10, 9);
    // 長さ 0 の線分(画面上で潰れた線)でも 0 除算にならない。
    expect(screenDistanceToSegment([4, 4], [4, 4], [4, 7])).toBeCloseTo(3, 9);
  });
});

describe('pixelsPerMillimetreAt(画面の縮尺)', () => {
  it('作図面の 1mm が何画素になるかを返す', () => {
    expect(pixelsPerMillimetreAt(project, PLANE, [0, 0, 0])).toBeCloseTo(SCALE, 9);
  });

  it('写せない場所では 0(model 側は一致だけを止める)', () => {
    expect(pixelsPerMillimetreAt(() => null, PLANE, [0, 0, 0])).toBe(0);
  });
});

describe('applyInferredConstraints(確定)', () => {
  it('確定すると拘束が 1 件増える(FR-333、FR-313)', () => {
    const document = lineAt(createEmptySketchDocument(), 'line-1', [0, 0], [100, 5]);
    const preview = inferredConstraintPreview(
      previewInput(document, [0, 0], [100, 5], { draftFeatureId: 'line-1' }),
    );
    expect(preview).not.toBeNull();
    const before = sketchConstraints(document).length;
    const after = applyInferredConstraints(document, preview?.constraints ?? []);
    expect(sketchConstraints(after.document).length).toBe(before + 1);
    expect(after.constraintIds).toHaveLength(1);
  });

  it('同じ拘束が既にあるときは足さない(同じ拘束を 2 つ付けない)', () => {
    const document = lineAt(createEmptySketchDocument(), 'line-1', [0, 0], [100, 5]);
    const preview = inferredConstraintPreview(
      previewInput(document, [0, 0], [100, 5], { draftFeatureId: 'line-1' }),
    );
    const once = applyInferredConstraints(document, preview?.constraints ?? []);
    const twice = applyInferredConstraints(once.document, preview?.constraints ?? []);
    expect(sketchConstraints(twice.document).length).toBe(sketchConstraints(once.document).length);
    expect(twice.constraintIds).toHaveLength(0);
  });

  it('推定が 1 つも無ければ文書はそのまま(同じ物が返る)', () => {
    const document = lineAt(createEmptySketchDocument(), 'line-1', [0, 0], [100, 5]);
    expect(applyInferredConstraints(document, []).document).toBe(document);
  });
});

describe('sameInferredPreview(書き直しの抑制)', () => {
  it('同じ内容なら同じと判定する(毎コマ書き直さない、NFR-PF-1)', () => {
    const input = previewInput(createEmptySketchDocument(), [0, 0], [100, 5]);
    const a = inferredConstraintPreview(input);
    const b = inferredConstraintPreview(input);
    expect(a).not.toBe(b);
    expect(sameInferredPreview(a, b)).toBe(true);
  });

  it('推定の中身が変われば別と判定する', () => {
    const a = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 0]),
    );
    const b = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [0, 100]),
    );
    expect(sameInferredPreview(a, b)).toBe(false);
  });

  it('片方だけ null なら別と判定する', () => {
    const a = inferredConstraintPreview(
      previewInput(createEmptySketchDocument(), [0, 0], [100, 0]),
    );
    expect(sameInferredPreview(a, null)).toBe(false);
    expect(sameInferredPreview(null, null)).toBe(true);
  });
});

describe('NFR-PF-1: pointermove 1 回の所要', () => {
  it(`近くの要素 200 本でも ${String(POINTER_MOVE_BUDGET_MS)}ms 以内`, () => {
    // 引いている線のすぐそばへ 200 本を並べる(絞り込みで落とせない、いちばん重い形)。
    let document = createEmptySketchDocument();
    for (let index = 0; index < 200; index += 1) {
      document = lineAt(document, `line-${String(index + 1)}`, [0, index * 0.05], [20, index * 0.05]);
    }
    const input = previewInput(document, [0, -1], [20, -1]);
    // 解決は `pointermove` の外(ストアが持っている控え)なので、計測の外で済ませる。
    expect(input.resolved.segments).toHaveLength(200);

    /*
      1 回だけ測ると JIT が温まる前の値になるので、`pickSolidSubShapePerformance.test.ts` と
      同じ流儀で何度も呼んで 1 回あたりを出す。**上限(16ms)は変えていない。**
    */
    const rounds = 200;
    const started = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      inferredConstraintPreview(input);
    }
    const perMove = (performance.now() - started) / rounds;
    console.log(
      `拘束の自動推定 pointermove 1 回(近くの要素 200 本): ${perMove.toFixed(3)} ms / 上限 ${String(POINTER_MOVE_BUDGET_MS)} ms`,
    );
    expectWithinBudget(perMove, POINTER_MOVE_BUDGET_MS, '拘束の自動推定の pointermove 1 回');
  });

  it('絞り込みの広さは定数 1 か所で決まる', () => {
    expect(INFERENCE_NEARBY_RADIUS_PIXELS).toBeGreaterThan(0);
  });
});
