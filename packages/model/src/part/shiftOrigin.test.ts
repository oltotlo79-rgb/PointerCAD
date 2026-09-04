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
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFaceFeature,
  SketchPointFeature,
} from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import {
  appendReference,
  appendSolid,
  createEmptyPartDocument,
  replaceSketch,
} from './createPartDocument.js';
import { resolvePart, type SolidStepPlan } from './resolvePart.js';
import { originShiftFor, originShiftFromPosition, shiftOrigin } from './shiftOrigin.js';
import type {
  HoleFeature,
  ExtrudeFeature,
  PartDocument,
  ReferencePlaneFeature,
  ReferencePointFeature,
  SketchFaceRef,
  SpringFeature,
  SubShapeRef,
} from './types.js';

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`評価に失敗しました: ${source} / ${result.error.message}`);
  }
  return result.value;
}

/** 式で書いた絶対座標(`absoluteCoordinate` は数値しか受け取らないため)。 */
function coordinate(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: expr(x), y: expr(y), z: expr(z) };
}

/** 作図面を指定して点フィーチャーを1つ足す。 */
function addPoint(
  sketch: SketchDocument,
  at: CoordinateInput,
  planeId?: string,
): { readonly sketch: SketchDocument; readonly featureId: string } {
  const base = createPointFeature(sketch, at);
  const point: SketchPointFeature = planeId === undefined ? base : { ...base, planeId };
  return { sketch: appendFeature(sketch, point), featureId: point.id };
}

function pointOf(document: PartDocument, sketchId: string, featureId: string): SketchPointFeature {
  const sketch = document.sketches.find((item) => item.id === sketchId);
  const feature = sketch?.features.find((item) => item.id === featureId);
  if (feature === undefined || feature.kind !== 'point') {
    throw new Error(`点が見つかりません: ${featureId}`);
  }
  return feature;
}

/** 点の絶対座標の式を文字列で取り出す。 */
function sourcesOf(point: SketchPointFeature): readonly [string, string, string] {
  if (point.at.mode !== 'absolute') {
    throw new Error(`絶対座標ではありません: ${point.at.mode}`);
  }
  return [point.at.x.source, point.at.y.source, point.at.z.source];
}

function shiftOrThrow(document: PartDocument, sketchId: string, featureId: string) {
  const shift = originShiftFor(document, { kind: 'sketchPoint', sketchId, featureId });
  if (shift === null) {
    throw new Error(`シフト量を式にできませんでした: ${featureId}`);
  }
  return shift;
}

describe('原点の再設定(FR-331、タスク35)', () => {
  it('選んだ点が原点になり、他の点は式のまま平行移動する', () => {
    const base = createEmptyPartDocument();
    const first = addPoint(base.sketches[0], coordinate('10 + π/2', '0', '0'));
    const second = addPoint(first.sketch, coordinate('3', '0', '0'));
    const document = replaceSketch(base, second.sketch);
    const sketchId = second.sketch.id;

    const shifted = shiftOrigin(document, shiftOrThrow(document, sketchId, first.featureId));

    // 原点にした点自身は厳密に 0(§0.a-0.25 ⑤)。
    expect(sourcesOf(pointOf(shifted, sketchId, first.featureId))).toEqual(['0', '0', '0']);
    const other = pointOf(shifted, sketchId, second.featureId);
    expect(sourcesOf(other)).toEqual(['3 - (10 + π/2)', '0', '0']);
    if (other.at.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    // 10 + π/2 = 11.5707963267948966…
    expect(other.at.x.value).toBeCloseTo(-8.5707963267949, 12);
  });

  it('整数どうしは整数の差へ簡約する', () => {
    const base = createEmptyPartDocument();
    const origin = addPoint(base.sketches[0], coordinate('2', '4', '0'));
    const other = addPoint(origin.sketch, coordinate('5', '4', '0'));
    const document = replaceSketch(base, other.sketch);
    const sketchId = other.sketch.id;

    const shifted = shiftOrigin(document, shiftOrThrow(document, sketchId, origin.featureId));
    expect(sourcesOf(pointOf(shifted, sketchId, other.featureId))).toEqual(['3', '0', '0']);
  });

  it('XZ 面のスケッチは、面内だけのシフトでは作図面が変わらない', () => {
    const base = createEmptyPartDocument();
    const added = addPoint(base.sketches[0], coordinate('10', '0', '20'), 'xz');
    const document = replaceSketch(base, added.sketch);

    // 世界の (2,0,3) は XZ 面の中で u = 2 / v = 3 のずれ。法線(−Y)方向の成分は 0。
    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('0'), z: expr('3') });
    expect(sourcesOf(pointOf(shifted, added.sketch.id, added.featureId))).toEqual([
      '8',
      '0',
      '17',
    ]);
    expect(shifted.references).toEqual([]);
    expect(pointOf(shifted, added.sketch.id, added.featureId).planeId).toBe('xz');
  });

  it('法線方向へも動くときは、作図面ごとオフセット平面へ移す(立体も一緒に動く)', () => {
    const base = createEmptyPartDocument();
    const onXz = addPoint(base.sketches[0], coordinate('10', '0', '20'), 'xz');
    const onXy = addPoint(onXz.sketch, coordinate('10', '20', '0'), 'xy');
    const document = replaceSketch(base, onXy.sketch);
    const sketchId = onXy.sketch.id;

    // 世界の (0,5,4): XZ 面の法線は −Y なので Y の 5 が、XY 面の法線は +Z なので Z の 4 が効く。
    const shifted = shiftOrigin(document, { x: expr('0'), y: expr('5'), z: expr('4') });

    // 座標は世界の 3 成分ぶん動く(剛体として動く)。
    expect(sourcesOf(pointOf(shifted, sketchId, onXz.featureId))).toEqual(['10', '-5', '16']);
    expect(sourcesOf(pointOf(shifted, sketchId, onXy.featureId))).toEqual(['10', '15', '-4']);

    // 基準面ごとに 1 枚ずつ作業平面ができ、作図面が付け替わる。
    expect(shifted.references).toHaveLength(2);
    const planeIds = shifted.references.map((feature) => feature.id);
    expect(pointOf(shifted, sketchId, onXz.featureId).planeId).toBe(planeIds[0]);
    expect(pointOf(shifted, sketchId, onXy.featureId).planeId).toBe(planeIds[1]);
    const fromXz = shifted.references[0];
    const fromXy = shifted.references[1];
    if (fromXz.kind !== 'referencePlane' || fromXz.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    if (fromXy.kind !== 'referencePlane' || fromXy.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    // 利用者が作った平面ではないので画面には出さない(参照はできる)。
    expect(fromXz.visible).toBe(false);
    expect(fromXy.visible).toBe(false);
    // XZ 面(法線 −Y)は原点が y = −5 へ動くので、法線方向のオフセットは +5。
    expect(fromXz.plane.planeId).toBe('xz');
    expect(fromXz.plane.offset.source).toBe('5');
    // XY 面(法線 +Z)は原点が z = −4 へ動くので、オフセットは −4。
    expect(fromXy.plane.planeId).toBe('xy');
    expect(fromXy.plane.offset.source).toBe('-4');
  });

  it('同じ基準面の上のスケッチは 1 枚の作業平面を共有する', () => {
    const base = createEmptyPartDocument();
    const first = addPoint(base.sketches[0], coordinate('1', '2', '0'), 'xy');
    const second = addPoint(first.sketch, coordinate('3', '4', '0'), 'xy');
    const document = replaceSketch(base, second.sketch);
    const sketchId = second.sketch.id;

    const shifted = shiftOrigin(document, { x: expr('0'), y: expr('0'), z: expr('4') });
    expect(shifted.references).toHaveLength(1);
    const planeId = shifted.references[0].id;
    expect(pointOf(shifted, sketchId, first.featureId).planeId).toBe(planeId);
    expect(pointOf(shifted, sketchId, second.featureId).planeId).toBe(planeId);
  });

  it('3D スケッチ(作図面なし)は世界の 3 成分がすべて動く', () => {
    const base = createEmptyPartDocument();
    const added = addPoint(base.sketches[0], coordinate('10', '20', '30'), FREE_WORK_PLANE_ID);
    const document = replaceSketch(base, added.sketch);

    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('5'), z: expr('3') });
    expect(sourcesOf(pointOf(shifted, added.sketch.id, added.featureId))).toEqual([
      '8',
      '15',
      '27',
    ]);
  });

  it('相対座標は書き換えない(基準の点が動くので追従する)', () => {
    const base = createEmptyPartDocument();
    const origin = addPoint(base.sketches[0], coordinate('2', '0', '0'));
    const relative: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'point', pointId: origin.featureId },
      dx: expr('10'),
      dy: expr('0'),
      dz: expr('0'),
    };
    const follower = addPoint(origin.sketch, relative);
    const document = replaceSketch(base, follower.sketch);
    const sketchId = follower.sketch.id;

    const shifted = shiftOrigin(document, shiftOrThrow(document, sketchId, origin.featureId));
    expect(pointOf(shifted, sketchId, follower.featureId).at).toBe(relative);
  });

  it('3 点で定義した作業平面の上のスケッチは書き換えない(定義点が動いて追従するため)', () => {
    const base = createEmptyPartDocument();
    const workPlane: ReferencePlaneFeature = {
      id: 'referencePlane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: {
        kind: 'threePoints',
        p1: { kind: 'point', pointId: 'point-1' },
        p2: { kind: 'point', pointId: 'point-2' },
        p3: { kind: 'point', pointId: 'point-3' },
      },
    };
    const withPlane = appendReference(base, workPlane);
    const added = addPoint(withPlane.sketches[0], coordinate('10', '20', '10'), workPlane.id);
    const document = replaceSketch(withPlane, added.sketch);

    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('5'), z: expr('3') });
    expect(sourcesOf(pointOf(shifted, added.sketch.id, added.featureId))).toEqual([
      '10',
      '20',
      '10',
    ]);
    expect(shifted.references[0]).toBe(workPlane);
  });

  it('基準面からのオフセット平面の上のスケッチは、平面ごと剛体として動く', () => {
    const base = createEmptyPartDocument();
    const workPlane: ReferencePlaneFeature = {
      id: 'referencePlane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expr('10') },
    };
    const withPlane = appendReference(base, workPlane);
    const added = addPoint(withPlane.sketches[0], coordinate('10', '20', '10'), workPlane.id);
    const document = replaceSketch(withPlane, added.sketch);

    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('5'), z: expr('3') });
    // 座標は世界の 3 成分ぶん動き、平面のオフセットも法線方向のぶんだけ動く。
    expect(sourcesOf(pointOf(shifted, added.sketch.id, added.featureId))).toEqual([
      '8',
      '15',
      '7',
    ]);
    const moved = shifted.references[0];
    if (moved.kind !== 'referencePlane' || moved.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    expect(moved.plane.offset.source).toBe('7');
    // 既にある平面が動くので、新しい平面は増えない。
    expect(shifted.references).toHaveLength(1);
  });

  it('ワールド原点を基準にした相対座標も動く(原点そのものが動くため)', () => {
    const base = createEmptyPartDocument();
    const fromOrigin = addPoint(base.sketches[0], {
      mode: 'relative',
      base: { kind: 'origin' },
      dx: expr('10'),
      dy: expr('20'),
      dz: expr('0'),
    });
    const document = replaceSketch(base, fromOrigin.sketch);

    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('5'), z: expr('0') });
    const moved = pointOf(shifted, fromOrigin.sketch.id, fromOrigin.featureId).at;
    if (moved.mode !== 'relative') {
      throw new Error('相対座標のはず');
    }
    expect([moved.dx.source, moved.dy.source, moved.dz.source]).toEqual(['8', '15', '0']);
  });

  it('基準面からのオフセットで定義した作業平面は、法線方向のぶんだけオフセットが変わる', () => {
    const base = createEmptyPartDocument();
    const onXy: ReferencePlaneFeature = {
      id: 'referencePlane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expr('10') },
    };
    const onXz: ReferencePlaneFeature = {
      id: 'referencePlane-2',
      name: '作業平面2',
      visible: true,
      kind: 'referencePlane',
      plane: { kind: 'workPlane', planeId: 'xz', offset: expr('10') },
    };
    const document = appendReference(appendReference(base, onXy), onXz);

    const shifted = shiftOrigin(document, { x: expr('0'), y: expr('5'), z: expr('4') });
    const plane1 = shifted.references[0];
    const plane2 = shifted.references[1];
    if (plane1.kind !== 'referencePlane' || plane1.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    if (plane2.kind !== 'referencePlane' || plane2.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    // XY 面の法線は +Z。10 − 4 が整数どうしなので 6 へ簡約される。
    expect(plane1.plane.offset.source).toBe('6');
    expect(plane1.plane.offset.value).toBe(6);
    // XZ 面の法線は −Y。10 − (−5) なので 15 になる。
    expect(plane2.plane.offset.source).toBe('15');
  });

  it('式のシフトでは作業平面のオフセットも式のまま残る', () => {
    const base = createEmptyPartDocument();
    const plane: ReferencePlaneFeature = {
      id: 'referencePlane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expr('10') },
    };
    const document = appendReference(base, plane);

    const shifted = shiftOrigin(document, { x: expr('0'), y: expr('0'), z: expr('2 + π') });
    const moved = shifted.references[0];
    if (moved.kind !== 'referencePlane' || moved.plane.kind !== 'workPlane') {
      throw new Error('作業平面のはず');
    }
    expect(moved.plane.offset.source).toBe('10 - (2 + π)');
    expect(moved.plane.offset.value).toBeCloseTo(4.85840734641021, 12);
  });

  it('立体の面から離した作業平面のオフセットは変えない(面が一緒に動くため)', () => {
    const base = createEmptyPartDocument();
    const face: SubShapeRef = {
      bodyFeatureId: 'solid-1',
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    };
    const plane: ReferencePlaneFeature = {
      id: 'referencePlane-1',
      name: '作業平面1',
      visible: true,
      kind: 'referencePlane',
      plane: { kind: 'face', face, offset: expr('10') },
    };
    const document = appendReference(base, plane);

    const shifted = shiftOrigin(document, { x: expr('0'), y: expr('0'), z: expr('4') });
    expect(shifted.references[0]).toBe(plane);
  });

  it('座標の式で定義した基準点は動き、頂点で定義した基準点は動かない', () => {
    const base = createEmptyPartDocument();
    const byCoordinate: ReferencePointFeature = {
      id: 'referencePoint-1',
      name: '基準点1',
      visible: true,
      kind: 'referencePoint',
      definition: { kind: 'coordinate', at: coordinate('10', '20', '30') },
    };
    const byVertex: ReferencePointFeature = {
      id: 'referencePoint-2',
      name: '基準点2',
      visible: true,
      kind: 'referencePoint',
      definition: {
        kind: 'vertex',
        vertex: {
          bodyFeatureId: 'solid-1',
          index: 2,
          fingerprint: { kind: 'vertex', position: [1, 2, 3] },
        },
      },
    };
    const document = appendReference(appendReference(base, byCoordinate), byVertex);

    const shifted = shiftOrigin(document, { x: expr('2'), y: expr('5'), z: expr('3') });
    const moved = shifted.references[0];
    if (moved.kind !== 'referencePoint' || moved.definition.kind !== 'coordinate') {
      throw new Error('座標で定義した基準点のはず');
    }
    if (moved.definition.at.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect([
      moved.definition.at.x.source,
      moved.definition.at.y.source,
      moved.definition.at.z.source,
    ]).toEqual(['8', '15', '27']);
    expect(shifted.references[1]).toBe(byVertex);
  });

  it('原点を戻すと元の値へ戻る(往復)', () => {
    const base = createEmptyPartDocument();
    const zero = addPoint(base.sketches[0], coordinate('0', '0', '0'));
    const three = addPoint(zero.sketch, coordinate('3', '0', '0'));
    const far = addPoint(three.sketch, coordinate('10 + π/2', '0', '0'));
    const document = replaceSketch(base, far.sketch);
    const sketchId = far.sketch.id;

    const away = shiftOrigin(document, shiftOrThrow(document, sketchId, far.featureId));
    expect(sourcesOf(pointOf(away, sketchId, zero.featureId))).toEqual([
      '0 - (10 + π/2)',
      '0',
      '0',
    ]);

    // もう一度、元の原点だった点を選んで戻す。式は入れ子で残り、値が元へ戻る。
    const back = shiftOrigin(away, shiftOrThrow(away, sketchId, zero.featureId));
    const restored = pointOf(back, sketchId, three.featureId);
    expect(sourcesOf(restored)[0]).toBe('(3 - (10 + π/2)) - (0 - (10 + π/2))');
    if (restored.at.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(restored.at.x.value).toBeCloseTo(3, 12);
    // 2 回目に原点にした点は 0 になる。
    expect(sourcesOf(pointOf(back, sketchId, zero.featureId))).toEqual(['0', '0', '0']);
  });
});

describe('シフト量の作り方(タスク35 ③)', () => {
  it('絶対座標の点は式そのものをシフト量にする', () => {
    const base = createEmptyPartDocument();
    const added = addPoint(base.sketches[0], coordinate('10 + π/2', '2/4', '0'));
    const document = replaceSketch(base, added.sketch);

    const shift = shiftOrThrow(document, added.sketch.id, added.featureId);
    expect([shift.x.source, shift.y.source, shift.z.source]).toEqual(['10 + π/2', '2/4', '0']);
  });

  it('相対座標の点は「基準の式 + ずれの式」へまとめる', () => {
    const base = createEmptyPartDocument();
    const anchor = addPoint(base.sketches[0], coordinate('10 + π/2', '0', '0'));
    const relative = addPoint(anchor.sketch, {
      mode: 'relative',
      base: { kind: 'point', pointId: anchor.featureId },
      dx: expr('5'),
      dy: expr('0'),
      dz: expr('0'),
    });
    const document = replaceSketch(base, relative.sketch);

    const shift = shiftOrThrow(document, relative.sketch.id, relative.featureId);
    expect(shift.x.source).toBe('(10 + π/2) + 5');
    expect(shift.x.value).toBeCloseTo(16.5707963267949, 12);
    // ずれが 0 の成分は基準の式のまま(括弧を増やさない)。
    expect(shift.y.source).toBe('0');
  });

  it('極座標や式にできない基準は null を返し、呼び出し側が座標へ後退できる', () => {
    const base = createEmptyPartDocument();
    const polar = addPoint(base.sketches[0], {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: expr('10'),
      azimuth: expr('45'),
      elevation: expr('0'),
    });
    const document = replaceSketch(base, polar.sketch);

    expect(
      originShiftFor(document, {
        kind: 'sketchPoint',
        sketchId: polar.sketch.id,
        featureId: polar.featureId,
      }),
    ).toBeNull();
    // 頂点などの式を持たない点は解決済みの座標から作る。
    const fallback = originShiftFromPosition([7.0710678118654755, 7.0710678118654755, 0]);
    expect(fallback.x.source).toBe('7.0710678118654755');
    expect(fallback.x.value).toBe(7.0710678118654755);
    expect(
      originShiftFor(document, { kind: 'position', position: [1.5, 0, 0] })?.x.source,
    ).toBe('1.5');
  });

  it('座標の式で定義した基準点からもシフト量を作れる', () => {
    const base = createEmptyPartDocument();
    const reference: ReferencePointFeature = {
      id: 'referencePoint-1',
      name: '基準点1',
      visible: true,
      kind: 'referencePoint',
      definition: { kind: 'coordinate', at: coordinate('1/2', '0', '0') },
    };
    const document = appendReference(base, reference);

    const shift = originShiftFor(document, {
      kind: 'referencePoint',
      featureId: reference.id,
    });
    expect(shift?.x.source).toBe('1/2');
  });
});

/** 40×30 の面・穴・ばねを持つ文書。原点を動かしても形が変わらないことを確かめる。 */
function createSolidFixture(): {
  readonly document: PartDocument;
  readonly sketchId: string;
  readonly centerFeatureId: string;
} {
  const base = createEmptyPartDocument();
  let sketch = base.sketches[0];
  const cornerIds: string[] = [];
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
  ]) {
    const added = addPoint(sketch, absoluteCoordinate(x, y, 0));
    sketch = added.sketch;
    cornerIds.push(added.featureId);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: 'xy',
    kind: 'face',
    boundary: cornerIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  const center = addPoint(sketch, absoluteCoordinate(10, 10, 0));
  sketch = center.sketch;
  const springOrigin = addPoint(sketch, absoluteCoordinate(30, 20, 0));
  sketch = springOrigin.sketch;

  const extrude: ExtrudeFeature = {
    id: 'solid-1',
    name: '押し出し1',
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: sketch.id, faceFeatureId: face.id },
    distance: expr('10'),
    reversed: false,
    symmetric: false,
  };
  const hole: HoleFeature = {
    id: 'solid-2',
    name: '穴1',
    suppressed: false,
    kind: 'hole',
    targetFeatureId: extrude.id,
    face: {
      bodyFeatureId: extrude.id,
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    },
    centers: [{ sketchId: sketch.id, pointFeatureId: center.featureId }],
    diameter: expr('6'),
    depth: { kind: 'through' },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
  };
  const spring: SpringFeature = {
    id: 'solid-3',
    name: 'ばね1',
    suppressed: false,
    kind: 'spring',
    origin: { sketchId: sketch.id, pointFeatureId: springOrigin.featureId },
    axis: { kind: 'world', axis: 'z' },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
    length: expr('20'),
    pitch: expr('5'),
    turns: expr('4'),
    derived: 'length',
    coilDiameter: expr('20'),
    wireDiameter: expr('2'),
    handedness: 'right',
  };
  const withSketch = replaceSketch(base, sketch);
  const document = appendSolid(
    appendSolid(appendSolid(withSketch, extrude), hole),
    spring,
  );
  return { document, sketchId: sketch.id, centerFeatureId: center.featureId };
}

function planOf(document: PartDocument, index: number): SolidStepPlan {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  return resolved.steps[index].plan;
}

function translated(position: Vec3, by: Vec3): Vec3 {
  return [position[0] + by[0], position[1] + by[1], position[2] + by[2]];
}

describe('穴とばねのある文書で形が変わらない(FR-331)', () => {
  it('立体は平行移動するだけで、寸法は 1 つも変わらない', () => {
    const fixture = createSolidFixture();
    const shift = shiftOrThrow(fixture.document, fixture.sketchId, fixture.centerFeatureId);
    const shifted = shiftOrigin(fixture.document, shift);
    const by: Vec3 = [-10, -10, 0];

    const beforeExtrude = planOf(fixture.document, 0);
    const afterExtrude = planOf(shifted, 0);
    if (beforeExtrude.kind !== 'extrude' || afterExtrude.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(afterExtrude.distance).toBe(beforeExtrude.distance);
    expect(afterExtrude.direction).toEqual(beforeExtrude.direction);
    expect(afterExtrude.profile.length).toBe(beforeExtrude.profile.length);
    for (let index = 0; index < beforeExtrude.profile.length; index += 1) {
      const before = beforeExtrude.profile[index];
      const after = afterExtrude.profile[index];
      if (before.kind !== 'segment' || after.kind !== 'segment') {
        throw new Error('線分のはず');
      }
      expect(after.from).toEqual(translated(before.from, by));
      expect(after.to).toEqual(translated(before.to, by));
    }

    const beforeHole = planOf(fixture.document, 1);
    const afterHole = planOf(shifted, 1);
    if (beforeHole.kind !== 'hole' || afterHole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(afterHole.diameter).toBe(beforeHole.diameter);
    expect(afterHole.depth).toBe(beforeHole.depth);
    expect(afterHole.centers).toEqual(beforeHole.centers.map((center) => translated(center, by)));
    // 穴の中心に選んだ点を原点にしたので、中心はちょうど原点に来る。
    expect(afterHole.centers[0]).toEqual([0, 0, 0]);

    const beforeSpring = planOf(fixture.document, 2);
    const afterSpring = planOf(shifted, 2);
    if (beforeSpring.kind !== 'spring' || afterSpring.kind !== 'spring') {
      throw new Error('ばねのはず');
    }
    expect(afterSpring.origin).toEqual(translated(beforeSpring.origin, by));
    expect(afterSpring.direction).toEqual(beforeSpring.direction);
    expect(afterSpring.coilDiameter).toBe(beforeSpring.coilDiameter);
    expect(afterSpring.wireDiameter).toBe(beforeSpring.wireDiameter);
    expect(afterSpring.pitch).toBe(beforeSpring.pitch);
    expect(afterSpring.turns).toBe(beforeSpring.turns);
  });
});

/** 断面の頂点(線分の始点)を順に取り出す。 */
function profilePoints(plan: SolidStepPlan): readonly Vec3[] {
  if (plan.kind !== 'extrude') {
    throw new Error('押し出しのはず');
  }
  return plan.profile.map((curve) => {
    if (curve.kind !== 'segment') {
      throw new Error('線分のはず');
    }
    return curve.from;
  });
}

/** 平面多角形の面積(ニューウェルの式)。どの平面に乗っていても正しく求まる。 */
function polygonArea(points: readonly Vec3[]): number {
  let sum: Vec3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum = [
      sum[0] + (current[1] * next[2] - current[2] * next[1]),
      sum[1] + (current[2] * next[0] - current[0] * next[2]),
      sum[2] + (current[0] * next[1] - current[1] * next[0]),
    ];
  }
  return Math.hypot(sum[0], sum[1], sum[2]) / 2;
}

function polygonCentroid(points: readonly Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>(
    (total, point) => [total[0] + point[0], total[1] + point[1], total[2] + point[2]],
    [0, 0, 0],
  );
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

/** 押し出し 1 段の体積(断面積 × 長さ)と重心の代表点。 */
function bodyMeasure(plan: SolidStepPlan): { readonly volume: number; readonly centroid: Vec3 } {
  if (plan.kind !== 'extrude') {
    throw new Error('押し出しのはず');
  }
  const points = profilePoints(plan);
  return { volume: polygonArea(points) * plan.distance, centroid: polygonCentroid(points) };
}

/** XY 面の上に 2 枚の面を持ち、それぞれを押し出した文書。 */
function createTwoBodyFixture(): {
  readonly document: PartDocument;
  readonly sketchId: string;
  readonly cornerFeatureId: string;
} {
  const base = createEmptyPartDocument();
  let sketch = base.sketches[0];
  const faceRefs: SketchFaceRef[] = [];
  const firstIds: string[] = [];
  for (const corners of [
    [
      [0, 0, 0],
      [40, 0, 0],
      [40, 30, 0],
      [0, 30, 0],
    ],
    [
      [10, 10, 10],
      [30, 10, 10],
      [30, 25, 10],
      [10, 25, 10],
    ],
  ]) {
    const pointIds: string[] = [];
    for (const [x, y, z] of corners) {
      const added = addPoint(sketch, absoluteCoordinate(x, y, z));
      sketch = added.sketch;
      pointIds.push(added.featureId);
    }
    if (firstIds.length === 0) {
      firstIds.push(...pointIds);
    }
    const face: SketchFaceFeature = {
      id: nextFeatureId(sketch, 'face'),
      name: nextFeatureName(sketch, 'face'),
      planeId: 'xy',
      kind: 'face',
      boundary: pointIds.map((featureId) => ({ featureId })),
      color: DEFAULT_FACE_COLOR,
    };
    sketch = appendFeature(sketch, face);
    faceRefs.push({ sketchId: sketch.id, faceFeatureId: face.id });
  }
  const extrudeA: ExtrudeFeature = {
    id: 'solid-1',
    name: '押し出し1',
    suppressed: false,
    kind: 'extrude',
    profile: faceRefs[0],
    distance: expr('5'),
    reversed: false,
    symmetric: false,
  };
  const extrudeB: ExtrudeFeature = { ...extrudeA, id: 'solid-2', name: '押し出し2', profile: faceRefs[1] };
  const withSketch = replaceSketch(base, sketch);
  return {
    document: appendSolid(appendSolid(withSketch, extrudeA), extrudeB),
    sketchId: sketch.id,
    cornerFeatureId: firstIds[0],
  };
}

describe('原点を変えても立体どうしの位置関係が変わらない(統括の差し戻し ③)', () => {
  it('2 つの押し出しの体積と重心の差が不変', () => {
    const fixture = createTwoBodyFixture();
    // 法線方向(Z)の成分を持つ点を原点にする。作図面ごと動く経路を通す。
    const shift = originShiftFor(fixture.document, {
      kind: 'coordinate',
      at: coordinate('10', '10', '10'),
    });
    if (shift === null) {
      throw new Error('シフト量を式にできませんでした');
    }
    const shifted = shiftOrigin(fixture.document, shift);

    const beforeA = bodyMeasure(planOf(fixture.document, 0));
    const beforeB = bodyMeasure(planOf(fixture.document, 1));
    const afterA = bodyMeasure(planOf(shifted, 0));
    const afterB = bodyMeasure(planOf(shifted, 1));

    // 体積(断面積 × 長さ)はどちらも変わらない。
    expect(afterA.volume).toBeCloseTo(beforeA.volume, 9);
    expect(afterB.volume).toBeCloseTo(beforeB.volume, 9);
    // 2 つの立体の重心の差(相対位置)も変わらない。
    for (let axis = 0; axis < 3; axis += 1) {
      expect(afterB.centroid[axis] - afterA.centroid[axis]).toBeCloseTo(
        beforeB.centroid[axis] - beforeA.centroid[axis],
        9,
      );
      // 全体は選んだ点のぶんだけ平行移動している(剛体移動)。
      expect(afterA.centroid[axis]).toBeCloseTo(beforeA.centroid[axis] - 10, 9);
    }
    // 選んだ点(10,10,10)はちょうど原点へ来る。
    expect(afterB.centroid).toEqual(polygonCentroid(profilePoints(planOf(shifted, 1))));
  });
});
