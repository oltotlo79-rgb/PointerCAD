import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

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
  ResolvedArc,
  ResolvedCurve,
  ResolvedSegment,
  SketchDocument,
  SketchFaceFeature,
  SketchLineFeature,
} from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { cacheKeyFor, type KeyCurve } from './cacheKey.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { resolvePart, resolveRevolveAxis, translateCurve } from './resolvePart.js';
import type { ResolvedPart, ResolvedSolidStep } from './resolvePart.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ExtrudeFeature,
  PartDocument,
  RevolveAxis,
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

function toExpr(value: string | ExpressionValue): ExpressionValue {
  return typeof value === 'string' ? expr(value) : value;
}

/**
 * 評価に失敗した式の欄。保存されたファイルから読み戻したときに起こり得る形
 * (source を保って value を NaN にする、docs/報告記録.md 2026-09-03 07:58 の⑤)。
 */
function notANumber(source: string): ExpressionValue {
  return { source, value: Number.NaN, display: 'NaN' };
}

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
  /** z = 0 の 40×30 の長方形。左下から反時計回り(+Z から見て)。 */
  readonly faceA: SketchFaceRef;
  /** z = 10 の 40×30 の長方形。 */
  readonly faceB: SketchFaceRef;
  /** 境界の点が実在せず、スケッチ側で解決できない面。 */
  readonly brokenFace: SketchFaceRef;
  /** (1,2,3) から (4,6,3) への線分。回転軸に使う。 */
  readonly axisLine: SketchLineRef;
}

/**
 * 検査の土台。1本のスケッチに次を入れる。
 * - 面A: (0,0,0) (40,0,0) (40,30,0) (0,30,0) の 4 点で張った 40×30 の長方形
 * - 面B: 同じ形を z = 10 へ
 * - 壊れた面: 実在しない点 id を境界に持つ
 * - 軸の線分: (1,2,3) → (4,6,3)
 */
function createFixture(): Fixture {
  const base = createEmptyPartDocument();
  const empty = base.sketches[0];
  const cornersA = addPoints(empty, [
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
  const brokenFace = addFace(faceB.sketch, ['point-404']);
  const line: SketchLineFeature = {
    id: nextFeatureId(brokenFace.sketch, 'line'),
    name: nextFeatureName(brokenFace.sketch, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from: absoluteCoordinate(1, 2, 3),
    to: absoluteCoordinate(4, 6, 3),
  };
  const sketch = appendFeature(brokenFace.sketch, line);
  return {
    document: replaceSketch(base, sketch),
    faceA: { sketchId: sketch.id, faceFeatureId: faceA.faceId },
    faceB: { sketchId: sketch.id, faceFeatureId: faceB.faceId },
    brokenFace: { sketchId: sketch.id, faceFeatureId: brokenFace.faceId },
    axisLine: { sketchId: sketch.id, lineFeatureId: line.id },
  };
}

interface ExtrudeOptions {
  readonly distance?: string | ExpressionValue;
  readonly reversed?: boolean;
  readonly symmetric?: boolean;
  readonly suppressed?: boolean;
  readonly name?: string;
}

function extrudeFeature(
  id: string,
  profile: SketchFaceRef,
  options: ExtrudeOptions = {},
): ExtrudeFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: options.suppressed ?? false,
    kind: 'extrude',
    profile,
    distance: toExpr(options.distance ?? '10'),
    reversed: options.reversed ?? false,
    symmetric: options.symmetric ?? false,
  };
}

interface RevolveOptions {
  readonly angle?: string | ExpressionValue;
  readonly axis?: RevolveAxis;
  readonly reversed?: boolean;
  readonly suppressed?: boolean;
}

function revolveFeature(
  id: string,
  profile: SketchFaceRef,
  options: RevolveOptions = {},
): RevolveFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'revolve',
    profile,
    axis: options.axis ?? { kind: 'world', axis: 'z' },
    angle: toExpr(options.angle ?? '360'),
    reversed: options.reversed ?? false,
  };
}

function sewFeature(
  id: string,
  faces: readonly SketchFaceRef[],
  options: { readonly tolerance?: string | ExpressionValue; readonly suppressed?: boolean } = {},
): SewFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'sew',
    faces,
    tolerance: toExpr(options.tolerance ?? '0.01'),
  };
}

function booleanFeature(
  id: string,
  operation: BooleanOperation,
  targetFeatureId: string,
  toolFeatureId: string,
  options: { readonly suppressed?: boolean } = {},
): BooleanFeature {
  return {
    id,
    name: id,
    suppressed: options.suppressed ?? false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
}

function withSolids(document: PartDocument, ...solids: readonly SolidFeature[]): PartDocument {
  return solids.reduce((current, solid) => appendSolid(current, solid), document);
}

/** 段の種類を狭める。違う種類ならテストの前提が壊れているので落とす。 */
function extrudePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'extrude' }> {
  if (step.plan.kind !== 'extrude') {
    throw new Error(`テストの前提が壊れている: 押し出しでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function revolvePlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'revolve' }> {
  if (step.plan.kind !== 'revolve') {
    throw new Error(`テストの前提が壊れている: 回転でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function sewPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'sew' }> {
  if (step.plan.kind !== 'sew') {
    throw new Error(`テストの前提が壊れている: 縫合でない段 ${step.plan.kind}`);
  }
  return step.plan;
}

function booleanPlan(step: ResolvedSolidStep): Extract<ResolvedSolidStep['plan'], { kind: 'boolean' }> {
  if (step.plan.kind !== 'boolean') {
    throw new Error(`テストの前提が壊れている: ブーリアンでない段 ${step.plan.kind}`);
  }
  return step.plan;
}

/** 線分の並びを [始点, 終点] の一覧にする。円弧が混じっていたらテストの前提が壊れている。 */
function segmentEnds(curves: readonly ResolvedCurve[]): readonly (readonly Vec3[])[] {
  return curves.map((curve) => {
    if (curve.kind !== 'segment') {
      throw new Error('テストの前提が壊れている: 線分でない曲線');
    }
    return [curve.from, curve.to];
  });
}

/** 鍵の材料に使う曲線へ詰め替える(cacheKeyFor の入力を独立に組み立てるため)。 */
function keySegment(from: Vec3, to: Vec3): KeyCurve {
  return { kind: 'segment', from, to };
}

function codesOf(result: ResolvedPart): readonly string[] {
  return result.errors.map((error) => error.code);
}

/**
 * 面Aの断面が z = offset にあるときの 4 本の線分。
 * 面Aの境界は (0,0) (40,0) (40,30) (0,30) の順なので、隣どうしを結んで最後は先頭へ戻る。
 */
function rectangleEnds(z: number): readonly (readonly Vec3[])[] {
  return [
    [
      [0, 0, z],
      [40, 0, z],
    ],
    [
      [40, 0, z],
      [40, 30, z],
    ],
    [
      [40, 30, z],
      [0, 30, z],
    ],
    [
      [0, 30, z],
      [0, 0, z],
    ],
  ];
}

describe('translateCurve', () => {
  it('線分は始点と終点の両方が動き、種類と作成元は変わらない', () => {
    const segment: ResolvedSegment = {
      kind: 'segment',
      featureId: 'face-1',
      from: [1, 2, 3],
      to: [4, 5, 6],
    };
    const moved = translateCurve(segment, [10, -20, 30]);
    expect(moved).toEqual({
      kind: 'segment',
      featureId: 'face-1',
      from: [11, -18, 33],
      to: [14, -15, 36],
    });
  });

  it('円弧は中心だけが動き、法線・第1軸・半径・角度は変わらない', () => {
    const arc: ResolvedArc = {
      kind: 'arc',
      featureId: 'arc-1',
      center: [1, 2, 3],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius: 7,
      startAngle: 0.25,
      endAngle: 1.5,
    };
    const moved = translateCurve(arc, [0, 0, -5]);
    expect(moved).toEqual({ ...arc, center: [1, 2, -2] });
  });

  it('元の曲線を書き換えない', () => {
    const segment: ResolvedSegment = {
      kind: 'segment',
      featureId: 'face-1',
      from: [0, 0, 0],
      to: [1, 0, 0],
    };
    translateCurve(segment, [0, 0, 5]);
    expect(segment.from).toEqual([0, 0, 0]);
  });
});

describe('resolveRevolveAxis', () => {
  it('ワールドの X / Y / Z 軸は原点と単位ベクトルになる', () => {
    const { sketches } = resolvePart(createFixture().document);
    expect(resolveRevolveAxis({ kind: 'world', axis: 'x' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [1, 0, 0],
    });
    expect(resolveRevolveAxis({ kind: 'world', axis: 'y' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
    });
    expect(resolveRevolveAxis({ kind: 'world', axis: 'z' }, sketches)).toEqual({
      origin: [0, 0, 0],
      direction: [0, 0, 1],
    });
  });

  it('スケッチの線分は始点と、長さ1に直した向きになる', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    const frame = resolveRevolveAxis({ kind: 'line', line: fixture.axisLine }, sketches);
    // (4,6,3) - (1,2,3) = (3,4,0)、長さは √(9+16) = 5。単位ベクトルは (0.6, 0.8, 0)。
    expect(frame).not.toBeNull();
    expect(frame?.origin).toEqual([1, 2, 3]);
    expect(frame?.direction[0]).toBeCloseTo(0.6, 12);
    expect(frame?.direction[1]).toBeCloseTo(0.8, 12);
    expect(frame?.direction[2]).toBeCloseTo(0, 12);
  });

  it('線分が見つからないときは null', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    expect(
      resolveRevolveAxis(
        { kind: 'line', line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' } },
        sketches,
      ),
    ).toBeNull();
  });

  it('スケッチが見つからないときは null', () => {
    const fixture = createFixture();
    const { sketches } = resolvePart(fixture.document);
    expect(
      resolveRevolveAxis(
        { kind: 'line', line: { sketchId: 'sketch-404', lineFeatureId: 'line-1' } },
        sketches,
      ),
    ).toBeNull();
  });
});

describe('resolvePart スケッチの解決', () => {
  it('文書のスケッチを順に解決して持ち回る', () => {
    const fixture = createFixture();
    const result = resolvePart(fixture.document);
    expect(result.sketches).toHaveLength(1);
    expect(result.sketches[0].sketchId).toBe(fixture.faceA.sketchId);
    // 壊れた面は解決されず、スケッチ側の失敗として残る(部品の errors へは写さない)。
    expect(result.sketches[0].resolved.faces.map((face) => face.featureId)).toEqual([
      fixture.faceA.faceFeatureId,
      fixture.faceB.faceFeatureId,
    ]);
    expect(result.sketches[0].resolved.errors).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('ソリッドが無ければ段も失敗も無い', () => {
    const result = resolvePart(createFixture().document);
    expect(result.steps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });
});

describe('resolvePart 押し出し', () => {
  it('距離・向き・断面をそのまま渡す(向きは面の法線)', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA));
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].featureId).toBe('extrude-1');
    const plan = extrudePlan(result.steps[0]);
    expect(plan.distance).toBe(10);
    // 面Aの境界は +Z から見て反時計回りなので、当てはめた法線は +Z になる
    //(fitPlaneNormal は最初に見つけた最大の外積を採る。(40,0,0)×(40,30,0) = (0,0,1200))。
    expect(plan.direction).toEqual([0, 0, 1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
    expect(result.steps[0].visible).toBe(true);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('鍵は解決済みの断面・向き・距離だけから作られる', () => {
    const fixture = createFixture();
    const document = withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA));
    const result = resolvePart(document);
    const expected = cacheKeyFor({
      kind: 'extrude',
      profile: [
        keySegment([0, 0, 0], [40, 0, 0]),
        keySegment([40, 0, 0], [40, 30, 0]),
        keySegment([40, 30, 0], [0, 30, 0]),
        keySegment([0, 30, 0], [0, 0, 0]),
      ],
      direction: [0, 0, 1],
      distance: 10,
    });
    expect(result.steps[0].key).toBe(expected);
  });

  it('反転すると向きだけが逆になり、断面は動かない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { reversed: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    expect(plan.direction).toEqual([0, 0, -1]);
    expect(plan.distance).toBe(10);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
  });

  it('両側なら断面を距離の半分だけ逆向きへ動かし、距離は変えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { symmetric: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    // 向きは +Z、距離 10 なので、断面は (0,0,-1) × 5 = (0,0,-5) だけ動く。
    expect(plan.direction).toEqual([0, 0, 1]);
    expect(plan.distance).toBe(10);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(-5));
  });

  it('反転と両側を同時に指定すると、逆向きの半分だけ動く', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { reversed: true, symmetric: true }),
    );
    const plan = extrudePlan(resolvePart(document).steps[0]);
    // 向きは -Z、距離 10 なので、断面は (0,0,1) × 5 = (0,0,5) だけ動く。
    expect(plan.direction).toEqual([0, 0, -1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(5));
  });

  it('両側かどうかで鍵が変わる', () => {
    const fixture = createFixture();
    const plain = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA)),
    );
    const symmetric = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { symmetric: true })),
    );
    expect(symmetric.steps[0].key).not.toBe(plain.steps[0].key);
  });

  it('距離が 0 なら段を作らず invalidValue にする', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { distance: '0' }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].featureId).toBe('extrude-1');
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  });

  it('距離が負なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { distance: '0-3' })),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('距離が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA, { distance: notANumber('a') }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('面 id が実在しなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', {
          sketchId: fixture.faceA.sketchId,
          faceFeatureId: 'face-404',
        }),
      ),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('スケッチ id が実在しなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-404', faceFeatureId: 'face-1' }),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('スケッチ側で面が解決できていなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.brokenFace)),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });
});

describe('resolvePart 回転', () => {
  it('ワールド Z 軸まわりの 90 度は π/2 ラジアンになる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, { angle: '90' }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = revolvePlan(result.steps[0]);
    // 90 度 = 90 × π / 180 = π / 2。
    expect(plan.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(plan.axisOrigin).toEqual([0, 0, 0]);
    expect(plan.axisDirection).toEqual([0, 0, 1]);
    expect(segmentEnds(plan.profile)).toEqual(rectangleEnds(0));
  });

  it('全周(360 度)は 2π ラジアンになる', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA)),
    );
    expect(result.errors).toEqual([]);
    expect(revolvePlan(result.steps[0]).angle).toBeCloseTo(2 * Math.PI, 12);
  });

  it('スケッチの線分を軸にできる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, {
        axis: { kind: 'line', line: fixture.axisLine },
      }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    // 線分 (1,2,3) → (4,6,3)。始点が原点、向きは (3,4,0)/5 = (0.6, 0.8, 0)。
    expect(plan.axisOrigin).toEqual([1, 2, 3]);
    expect(plan.axisDirection[0]).toBeCloseTo(0.6, 12);
    expect(plan.axisDirection[1]).toBeCloseTo(0.8, 12);
    expect(plan.axisDirection[2]).toBeCloseTo(0, 12);
  });

  it('反転すると軸の向きだけが逆になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, { reversed: true }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    expect(plan.axisOrigin).toEqual([0, 0, 0]);
    expect(plan.axisDirection).toEqual([0, 0, -1]);
  });

  it('線分の軸を反転すると向きが逆になる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      revolveFeature('revolve-1', fixture.faceA, {
        axis: { kind: 'line', line: fixture.axisLine },
        reversed: true,
      }),
    );
    const plan = revolvePlan(resolvePart(document).steps[0]);
    expect(plan.axisDirection[0]).toBeCloseTo(-0.6, 12);
    expect(plan.axisDirection[1]).toBeCloseTo(-0.8, 12);
  });

  it('角度が 360 を超えたら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA, { angle: '370' })),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('角度が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(fixture.document, revolveFeature('revolve-1', fixture.faceA, { angle: '0' })),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('角度が数になっていなければ invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', fixture.faceA, { angle: notANumber('a') }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });

  it('軸の線分が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', fixture.faceA, {
          axis: {
            kind: 'line',
            line: { sketchId: fixture.axisLine.sketchId, lineFeatureId: 'line-404' },
          },
        }),
      ),
    );
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('断面が見つからなければ missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        revolveFeature('revolve-1', {
          sketchId: fixture.faceA.sketchId,
          faceFeatureId: 'face-404',
        }),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });
});

describe('resolvePart 縫合', () => {
  it('面ごとの曲線列と許容量を渡す', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      sewFeature('sew-1', [fixture.faceA, fixture.faceB]),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    const plan = sewPlan(result.steps[0]);
    expect(plan.tolerance).toBe(0.01);
    expect(plan.profiles).toHaveLength(2);
    expect(segmentEnds(plan.profiles[0])).toEqual(rectangleEnds(0));
    expect(segmentEnds(plan.profiles[1])).toEqual(rectangleEnds(10));
  });

  it('面が 2 枚未満なら degenerate', () => {
    const fixture = createFixture();
    const result = resolvePart(withSolids(fixture.document, sewFeature('sew-1', [fixture.faceA])));
    expect(result.steps).toEqual([]);
    expect(codesOf(result)).toEqual(['degenerate']);
  });

  it('見つからない面が混じっていれば missingProfile', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        sewFeature('sew-1', [
          fixture.faceA,
          { sketchId: fixture.faceA.sketchId, faceFeatureId: 'face-404' },
        ]),
      ),
    );
    expect(codesOf(result)).toEqual(['missingProfile']);
  });

  it('許容量が 0 以下なら invalidValue', () => {
    const fixture = createFixture();
    const result = resolvePart(
      withSolids(
        fixture.document,
        sewFeature('sew-1', [fixture.faceA, fixture.faceB], { tolerance: '0' }),
      ),
    );
    expect(codesOf(result)).toEqual(['invalidValue']);
  });
});

describe('resolvePart ブーリアン', () => {
  it('対象と相手を消費し、自分だけが画面に残る', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('subtract-1', 'subtract', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((step) => step.visible)).toEqual([false, false, true]);
    const plan = booleanPlan(result.steps[2]);
    expect(plan.operation).toBe('subtract');
    expect(plan.targetKey).toBe(result.steps[0].key);
    expect(plan.toolKey).toBe(result.steps[1].key);
    expect(result.liveBodyIds).toEqual(['subtract-1']);
  });

  it('鍵は上流の鍵から作る(上流が変われば必ず変わる)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(result.steps[2].key).toBe(
      cacheKeyFor({
        kind: 'boolean',
        operation: 'union',
        targetKey: result.steps[0].key,
        toolKey: result.steps[1].key,
      }),
    );
  });

  it('同じボディを 2 回消費しようとしたら後の方が consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('union-2', 'union', 'extrude-1', 'extrude-3'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
    expect(result.errors[0].featureId).toBe('union-2');
    expect(result.steps.map((step) => step.featureId)).toEqual([
      'extrude-1',
      'extrude-2',
      'extrude-3',
      'union-1',
    ]);
    expect(result.liveBodyIds).toEqual(['extrude-3', 'union-1']);
  });

  it('相手が消費済みでも consumedTwice', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('union-2', 'union', 'extrude-3', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['consumedTwice']);
    expect(result.errors[0].featureId).toBe('union-2');
  });

  it('対象と相手が同じなら invalidValue', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-1'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue']);
    expect(result.errors[0].featureId).toBe('union-1');
    // 消費しないので対象は画面に残る。
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('参照先のボディが無ければ missingBody', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-404'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.liveBodyIds).toEqual(['extrude-1']);
  });

  it('上流が失敗した段を参照したら missingBody(例外にならない)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { distance: '0' }),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('subtract-1', 'subtract', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['invalidValue', 'missingBody']);
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-2']);
    expect(result.liveBodyIds).toEqual(['extrude-2']);
  });

  it('抑制された段のボディは参照できない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { suppressed: true }),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.liveBodyIds).toEqual(['extrude-2']);
  });

  it('履歴で後にある段は参照できない(前方参照は missingBody)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
    );
    const result = resolvePart(document);
    expect(codesOf(result)).toEqual(['missingBody']);
    expect(result.steps.map((step) => step.featureId)).toEqual(['extrude-1', 'extrude-2']);
  });

  it('ブーリアンの結果をさらに組み合わせられる', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      extrudeFeature('extrude-3', fixture.faceB, { distance: '6' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
      booleanFeature('subtract-1', 'subtract', 'union-1', 'extrude-3'),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['subtract-1']);
    expect(booleanPlan(result.steps[4]).targetKey).toBe(result.steps[3].key);
  });
});

describe('resolvePart 抑制', () => {
  it('抑制した段は飛ばし、失敗としては数えない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA, { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.steps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual([]);
  });

  it('抑制されたブーリアンは何も消費しない', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2', { suppressed: true }),
    );
    const result = resolvePart(document);
    expect(result.errors).toEqual([]);
    expect(result.liveBodyIds).toEqual(['extrude-1', 'extrude-2']);
  });
});

describe('resolvePart 鍵の性質', () => {
  it('同じ文書を 2 回解決すると鍵が一致する(決定性)', () => {
    const fixture = createFixture();
    const document = withSolids(
      fixture.document,
      extrudeFeature('extrude-1', fixture.faceA),
      extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
      booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
    );
    const first = resolvePart(document);
    const second = resolvePart(document);
    expect(second.steps.map((step) => step.key)).toEqual(first.steps.map((step) => step.key));
  });

  it('名前だけを変えても鍵は変わらない', () => {
    const fixture = createFixture();
    const before = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { name: '押し出し1' })),
    );
    const after = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA, { name: '底板' })),
    );
    expect(after.steps[0].key).toBe(before.steps[0].key);
  });

  it('上流の距離を変えると、その段と下流のブーリアンの鍵が変わる', () => {
    const fixture = createFixture();
    const build = (distance: string): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA, { distance }),
          extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
          booleanFeature('union-1', 'union', 'extrude-1', 'extrude-2'),
        ),
      );
    const before = build('10');
    const after = build('20');
    expect(after.steps[0].key).not.toBe(before.steps[0].key);
    // 変えていない段の鍵はそのまま(キャッシュが効く、NFR-PF-3)。
    expect(after.steps[1].key).toBe(before.steps[1].key);
    // 下流へ伝わる(鍵の連鎖)。
    expect(after.steps[2].key).not.toBe(before.steps[2].key);
  });

  it('操作の種類を変えるとブーリアンの鍵が変わる', () => {
    const fixture = createFixture();
    const build = (operation: BooleanOperation): ResolvedPart =>
      resolvePart(
        withSolids(
          fixture.document,
          extrudeFeature('extrude-1', fixture.faceA),
          extrudeFeature('extrude-2', fixture.faceB, { distance: '4' }),
          booleanFeature('op-1', operation, 'extrude-1', 'extrude-2'),
        ),
      );
    expect(build('subtract').steps[2].key).not.toBe(build('union').steps[2].key);
  });

  it('抑制された段があっても残る段の鍵は変わらない', () => {
    const fixture = createFixture();
    const alone = resolvePart(
      withSolids(fixture.document, extrudeFeature('extrude-1', fixture.faceA)),
    );
    const withSuppressed = resolvePart(
      withSolids(
        fixture.document,
        extrudeFeature('extrude-1', fixture.faceA),
        extrudeFeature('extrude-2', fixture.faceB, { suppressed: true }),
      ),
    );
    expect(withSuppressed.steps).toHaveLength(1);
    expect(withSuppressed.steps[0].key).toBe(alone.steps[0].key);
  });
});
