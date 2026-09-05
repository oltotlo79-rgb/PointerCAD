import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  createEmptySketchDocument,
} from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  SketchDocument,
  SketchFaceFeature,
  SketchProjectedCurveFeature,
} from '../sketch/types.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { resolvePart } from './resolvePart.js';
import {
  buildTimeline,
  canMoveHistoryItem,
  dependenciesOf,
  documentUpTo,
  historyDependencies,
  insertPositionAt,
  moveHistoryItem,
  reorderTimeline,
  timelineIndexOf,
} from './timelineOrder.js';
import type {
  BooleanFeature,
  ExtrudeFeature,
  FilletFeature,
  HoleFeature,
  PartDocument,
  ReferenceFeature,
  SketchFaceRef,
  SketchPointRef,
  SolidFeature,
} from './types.js';

const ev = expressionValueFromNumber;

/** 作業平面1(基準の XY 面をそのまま使う)。スケッチはこの上に乗る。 */
const WORK_PLANE: ReferenceFeature = {
  id: 'referencePlane-1',
  kind: 'referencePlane',
  name: '作業平面1',
  visible: true,
  plane: { kind: 'workPlane', planeId: 'xy', offset: ev(0) },
};

/** 40×30 の箱の上の面(押し出し 10 のあと)。resolvePart.test.ts の検算表と同じ値。 */
function topFaceRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
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
}

/** 穴の口の丸い辺(R 面取りの対象)。半径 3、中心 (10,10,10)。 */
function holeEdgeRef(bodyFeatureId: string): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'edge',
      curveKind: 'circle',
      length: 2 * Math.PI * 3,
      position: [10, 10, 10],
      axis: [0, 0, 1],
      radius: 3,
    },
  };
}

function addPoints(
  sketch: SketchDocument,
  coordinates: readonly (readonly [number, number, number])[],
  planeId: string,
): { readonly sketch: SketchDocument; readonly pointIds: readonly string[] } {
  let current = sketch;
  const pointIds: string[] = [];
  for (const [x, y, z] of coordinates) {
    const point = { ...createPointFeature(current, absoluteCoordinate(x, y, z)), planeId };
    current = appendFeature(current, point);
    pointIds.push(point.id);
  }
  return { sketch: current, pointIds };
}

function addFace(
  sketch: SketchDocument,
  faceId: string,
  boundary: readonly string[],
  planeId: string,
): SketchDocument {
  const face: SketchFaceFeature = {
    id: faceId,
    name: faceId,
    planeId,
    kind: 'face',
    boundary: boundary.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  return appendFeature(sketch, face);
}

interface Fixture {
  readonly document: PartDocument;
  readonly faceA: SketchFaceRef;
  readonly faceB: SketchFaceRef;
  readonly holeCenter: SketchPointRef;
}

/**
 * 計画書 タスク9 の例と同じ文書を作る。
 * 作業平面1 → スケッチ1(その上の面)→ 押し出し1 → 穴1 → R面取り1 → 押し出し2。
 *
 * スケッチ1 の要素の作図面は作業平面1 なので、スケッチ1 を使う立体はすべて
 * 作業平面1 に依存する(帯の中の「立体 → スケッチ → 基準ジオメトリ」の経路)。
 */
function createFixture(): Fixture {
  const base = createEmptyPartDocument();
  const planeId = WORK_PLANE.id;
  const cornersA = addPoints(
    base.sketches[0],
    [
      [0, 0, 0],
      [40, 0, 0],
      [40, 30, 0],
      [0, 30, 0],
    ],
    planeId,
  );
  const withFaceA = addFace(cornersA.sketch, 'face-a', cornersA.pointIds, planeId);
  const cornersB = addPoints(
    withFaceA,
    [
      [0, 0, 10],
      [40, 0, 10],
      [40, 30, 10],
      [0, 30, 10],
    ],
    planeId,
  );
  const withFaceB = addFace(cornersB.sketch, 'face-b', cornersB.pointIds, planeId);
  const center = addPoints(withFaceB, [[10, 10, 0]], planeId);
  const sketch = center.sketch;
  const sketchId = sketch.id;

  const extrude1: ExtrudeFeature = {
    id: 'extrude-1',
    name: '押し出し1',
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId, faceFeatureId: 'face-a' },
    distance: ev(10),
    reversed: false,
    symmetric: false,
  };
  const hole1: HoleFeature = {
    id: 'hole-1',
    name: '穴1',
    suppressed: false,
    kind: 'hole',
    targetFeatureId: 'extrude-1',
    face: topFaceRef('extrude-1'),
    centers: [{ sketchId, pointFeatureId: center.pointIds[0] }],
    diameter: ev(6),
    depth: { kind: 'through' },
    tiltAngle: ev(0),
    tiltAzimuth: ev(0),
  };
  const fillet1: FilletFeature = {
    id: 'fillet-1',
    name: 'R面取り1',
    suppressed: false,
    kind: 'fillet',
    targetFeatureId: 'hole-1',
    targets: [holeEdgeRef('hole-1')],
    radius: ev(1),
  };
  const extrude2: ExtrudeFeature = {
    id: 'extrude-2',
    name: '押し出し2',
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId, faceFeatureId: 'face-b' },
    distance: ev(5),
    reversed: false,
    symmetric: false,
  };

  return {
    document: {
      ...base,
      sketches: [sketch],
      activeSketchId: sketchId,
      references: [WORK_PLANE],
      solids: [extrude1, hole1, fillet1, extrude2],
    },
    faceA: { sketchId, faceFeatureId: 'face-a' },
    faceB: { sketchId, faceFeatureId: 'face-b' },
    holeCenter: { sketchId, pointFeatureId: center.pointIds[0] },
  };
}

function featureIds(document: PartDocument): readonly string[] {
  return buildTimeline(document).map((entry) => entry.featureId);
}

describe('タイムラインの帯(FR-507)', () => {
  it('references(順)→ solids(順)の 1 本の通しで並ぶ', () => {
    const entries = buildTimeline(createFixture().document);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(entries.map((entry) => entry.section)).toEqual([
      'reference',
      'solid',
      'solid',
      'solid',
      'solid',
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      '作業平面1',
      '押し出し1',
      '穴1',
      'R面取り1',
      '押し出し2',
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'referencePlane',
      'extrude',
      'hole',
      'fillet',
      'extrude',
    ]);
  });

  it('抑制された段も帯に出る(FR-503。抑制は削除ではない)', () => {
    const fixture = createFixture();
    const document: PartDocument = {
      ...fixture.document,
      solids: fixture.document.solids.map((feature) =>
        feature.id === 'extrude-2' ? { ...feature, suppressed: true } : feature,
      ),
    };
    const entries = buildTimeline(document);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.suppressed)).toEqual([false, false, false, false, true]);
  });

  it('基準ジオメトリは抑制の欄を持たないので常に false', () => {
    const entries = buildTimeline(createFixture().document);
    expect(entries[0].suppressed).toBe(false);
  });

  it('timelineIndexOf は帯の通し番号を返し、無いものは null', () => {
    const { document } = createFixture();
    expect(timelineIndexOf(document, 'referencePlane-1')).toBe(0);
    expect(timelineIndexOf(document, 'hole-1')).toBe(2);
    expect(timelineIndexOf(document, 'extrude-404')).toBeNull();
  });

  it('空の文書の帯は 0 件', () => {
    expect(buildTimeline(createEmptyPartDocument())).toHaveLength(0);
  });
});

describe('履歴の依存グラフ(FR-507、FR-504)', () => {
  it('R面取り1 は対象にした穴1 だけに依存する', () => {
    // 対象(consumedTargetsOf)も辺の指紋(SubShapeRef.bodyFeatureId)も同じ穴1 を指す。
    expect(dependenciesOf(createFixture().document, 'fillet-1')).toEqual(['hole-1']);
  });

  it('穴1 は対象の押し出し1 と、中心の点が乗る作業平面1 に依存する', () => {
    // 対象 = 押し出し1(消費)、穴をあける面の指紋も押し出し1。
    // 中心はスケッチ1 の点で、スケッチ1 の要素の作図面が作業平面1 なので作業平面1 も要る。
    expect(dependenciesOf(createFixture().document, 'hole-1')).toEqual([
      'extrude-1',
      'referencePlane-1',
    ]);
  });

  it('押し出し2 は輪郭のスケッチが乗る作業平面1 だけに依存する', () => {
    expect(dependenciesOf(createFixture().document, 'extrude-2')).toEqual(['referencePlane-1']);
  });

  it('作業平面1 は基準の XY 面から作られているので何にも依存しない', () => {
    expect(dependenciesOf(createFixture().document, 'referencePlane-1')).toEqual([]);
  });

  it('historyDependencies は帯の全項目ぶんの表を返す', () => {
    const graph = historyDependencies(createFixture().document);
    expect([...graph.keys()].sort()).toEqual(
      ['extrude-1', 'extrude-2', 'fillet-1', 'hole-1', 'referencePlane-1'].sort(),
    );
  });

  it('履歴に無い id の依存は空', () => {
    expect(dependenciesOf(createFixture().document, 'extrude-404')).toEqual([]);
  });

  it('ブーリアンは対象と相手の両方に依存する', () => {
    const document = booleanDocument();
    expect(dependenciesOf(document, 'boolean-1')).toEqual(['extrude-1', 'extrude-2']);
  });

  it('立体 → スケッチ → 立体(投影)の経路もたどる', () => {
    const document = projectionDocument();
    // 押し出し3 が使うスケッチ2 は押し出し1 を投影しているので、押し出し1 に依存する。
    expect(dependenciesOf(document, 'extrude-3')).toEqual(['extrude-1']);
  });

  it('回転軸が基準軸を指していれば、その基準軸に依存する', () => {
    const document = revolveOnReferenceAxisDocument();
    expect(dependenciesOf(document, 'revolve-1')).toEqual(['referenceAxis-1']);
  });

  it('基準平面が立体の面から作られていれば、その立体に依存する', () => {
    const document = planeOnFaceDocument();
    expect(dependenciesOf(document, 'referencePlane-2')).toEqual(['extrude-1']);
  });
});

/** 押し出し1 + 押し出し2 → ブーリアン(和)。 */
function booleanDocument(): PartDocument {
  const fixture = createFixture();
  const boolean1: BooleanFeature = {
    id: 'boolean-1',
    name: '和1',
    suppressed: false,
    kind: 'boolean',
    operation: 'union',
    targetFeatureId: 'extrude-1',
    toolFeatureId: 'extrude-2',
  };
  const extrude1 = fixture.document.solids[0];
  const extrude2 = fixture.document.solids[3];
  return { ...fixture.document, references: [], solids: [extrude1, extrude2, boolean1] };
}

/** 押し出し1 → スケッチ2(押し出し1 を投影)→ 押し出し3。 */
function projectionDocument(): PartDocument {
  const fixture = createFixture();
  const projected: SketchProjectedCurveFeature = {
    id: 'projectedCurve-1',
    name: '投影1',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'projectedCurve',
    source: topFaceRef('extrude-1'),
    construction: false,
  };
  const sketch2: SketchDocument = addFace(
    appendFeature({ ...createEmptySketchDocument(), id: 'sketch-2', name: 'スケッチ2' }, projected),
    'face-c',
    ['projectedCurve-1'],
    DEFAULT_WORK_PLANE_ID,
  );
  const extrude3: ExtrudeFeature = {
    id: 'extrude-3',
    name: '押し出し3',
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-2', faceFeatureId: 'face-c' },
    distance: ev(4),
    reversed: false,
    symmetric: false,
  };
  return {
    ...fixture.document,
    sketches: [fixture.document.sketches[0], sketch2],
    references: [],
    solids: [fixture.document.solids[0], extrude3],
  };
}

/** 基準軸1 → 回転1(その軸まわり)。 */
function revolveOnReferenceAxisDocument(): PartDocument {
  const fixture = createFixture();
  const axis: ReferenceFeature = {
    id: 'referenceAxis-1',
    kind: 'referenceAxis',
    name: '基準軸1',
    visible: true,
    definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'origin' } },
  };
  const revolve: SolidFeature = {
    id: 'revolve-1',
    name: '回転1',
    suppressed: false,
    kind: 'revolve',
    profile: { sketchId: fixture.faceA.sketchId, faceFeatureId: 'face-a' },
    axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
    angle: ev(360),
    reversed: false,
  };
  // スケッチの作図面を基準の XY 面へ戻し、依存を基準軸1 だけにする。
  const sketch: SketchDocument = {
    ...fixture.document.sketches[0],
    features: fixture.document.sketches[0].features.map((feature) => ({
      ...feature,
      planeId: DEFAULT_WORK_PLANE_ID,
    })),
  };
  return { ...fixture.document, sketches: [sketch], references: [axis], solids: [revolve] };
}

/** 押し出し1 → 作業平面2(押し出し1 の上の面から)。基準ジオメトリが立体に依存する形。 */
function planeOnFaceDocument(): PartDocument {
  const fixture = createFixture();
  const plane2: ReferenceFeature = {
    id: 'referencePlane-2',
    kind: 'referencePlane',
    name: '作業平面2',
    visible: true,
    plane: { kind: 'face', face: topFaceRef('extrude-1'), offset: ev(0) },
  };
  const sketch: SketchDocument = {
    ...fixture.document.sketches[0],
    features: fixture.document.sketches[0].features.map((feature) => ({
      ...feature,
      planeId: DEFAULT_WORK_PLANE_ID,
    })),
  };
  return {
    ...fixture.document,
    sketches: [sketch],
    references: [plane2],
    solids: [fixture.document.solids[0]],
  };
}

describe('並べ替えの妥当性(FR-507、FR-504)', () => {
  it('穴1 を R面取り1 の後ろへは動かせない(R面取り1 が穴1 を使っている)', () => {
    const { document } = createFixture();
    const outcome = reorderTimeline(document, 2, 3);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('fillet-1');
    expect(outcome.reason).toContain('R面取り1');
    expect(outcome.reason).toContain('穴1');
  });

  it('押し出し2 は穴1 の前へ動かせる(独立している)', () => {
    const { document } = createFixture();
    const outcome = reorderTimeline(document, 4, 2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(featureIds(outcome.document)).toEqual([
      'referencePlane-1',
      'extrude-1',
      'extrude-2',
      'hole-1',
      'fillet-1',
    ]);
    // 元の文書は変わらない(純関数)。
    expect(featureIds(document)).toEqual([
      'referencePlane-1',
      'extrude-1',
      'hole-1',
      'fillet-1',
      'extrude-2',
    ]);
  });

  it('押し出し1 を押し出し2 の後ろへは動かせない(穴1 が押し出し1 を使っている)', () => {
    const { document } = createFixture();
    const outcome = reorderTimeline(document, 1, 4);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('hole-1');
    expect(outcome.reason).toContain('押し出し1');
  });

  it('作業平面1 を押し出し1 の後ろへは動かせない(スケッチ1 がその上にある)', () => {
    const { document } = createFixture();
    const outcome = reorderTimeline(document, 0, 1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('extrude-1');
    expect(outcome.reason).toContain('作業平面1');
  });

  it('ブーリアンの相手をブーリアンの後ろへは動かせない', () => {
    const document = booleanDocument();
    const outcome = reorderTimeline(document, 1, 2);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('boolean-1');
    expect(outcome.reason).toContain('押し出し2');
  });

  it('投影のもとより前へは、その投影を使う立体を動かせない(立体 → スケッチ → 立体)', () => {
    const document = projectionDocument();
    const outcome = reorderTimeline(document, 1, 0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('extrude-3');
    expect(outcome.reason).toContain('押し出し1');
  });

  it('同じ位置への移動は文書をそのまま返す(形状キャッシュの鍵を変えない)', () => {
    const { document } = createFixture();
    const outcome = reorderTimeline(document, 2, 2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document).toBe(document);
  });

  it('帯の外の位置は理由つきで断る', () => {
    const { document } = createFixture();
    const outside = reorderTimeline(document, 1, 5);
    expect(outside.ok).toBe(false);
    if (outside.ok) {
      return;
    }
    expect(outside.blockingFeatureId).toBe('extrude-1');
    const missing = reorderTimeline(document, -1, 0);
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      return;
    }
    expect(missing.blockingFeatureId).toBe('');
  });

  it('立体は基準ジオメトリの区間へは動かせない(配列が別のため)', () => {
    // 依存が 1 つも無い立体でも、基準ジオメトリの区間へは入れない。
    const document = independentSectionsDocument();
    const outcome = reorderTimeline(document, 1, 0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('extrude-1');
    expect(outcome.reason).toContain('基準ジオメトリ');
  });

  it('基準ジオメトリは立体の区間へは動かせない', () => {
    const document = independentSectionsDocument();
    const outcome = reorderTimeline(document, 0, 1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.blockingFeatureId).toBe('referencePoint-1');
    expect(outcome.reason).toContain('立体');
  });

  it('基準ジオメトリどうしは並べ替えられる', () => {
    const document = twoReferencesDocument();
    const outcome = reorderTimeline(document, 1, 0);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(featureIds(outcome.document)).toEqual([
      'referencePoint-2',
      'referencePoint-1',
      'extrude-1',
    ]);
  });

  it('canMoveHistoryItem は文書を作らずに可否だけを返す', () => {
    const { document } = createFixture();
    expect(canMoveHistoryItem(document, 'extrude-2', 2)).toEqual({ ok: true });
    const refused = canMoveHistoryItem(document, 'hole-1', 3);
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.blockingFeatureId).toBe('fillet-1');
  });

  it('moveHistoryItem は id で同じ並べ替えを行う', () => {
    const { document } = createFixture();
    const byId = moveHistoryItem(document, 'extrude-2', 2);
    const byIndex = reorderTimeline(document, 4, 2);
    expect(byId.ok).toBe(true);
    expect(byIndex.ok).toBe(true);
    if (!byId.ok || !byIndex.ok) {
      return;
    }
    expect(featureIds(byId.document)).toEqual(featureIds(byIndex.document));
  });

  it('履歴に無い id は動かせない', () => {
    const { document } = createFixture();
    const moved = moveHistoryItem(document, 'extrude-404', 0);
    expect(moved.ok).toBe(false);
    const check = canMoveHistoryItem(document, 'extrude-404', 0);
    expect(check.ok).toBe(false);
  });

  it('100 フィーチャーの並べ替えの判定が 20ms 以内', () => {
    const document = chainDocument(100);
    expect(buildTimeline(document)).toHaveLength(100);
    const started = performance.now();
    const outcome = reorderTimeline(document, 99, 50);
    const elapsedMs = performance.now() - started;
    expect(outcome.ok).toBe(false);
    console.log(`[実測] 100 フィーチャーの並べ替えの判定: ${elapsedMs.toFixed(3)}ms`);
    expect(elapsedMs).toBeLessThan(20);
  });
});

/** 基準点1(座標だけ)と押し出し1(基準の XY 面のスケッチ)。互いに依存しない。 */
function independentSectionsDocument(): PartDocument {
  const fixture = createFixture();
  const point: ReferenceFeature = {
    id: 'referencePoint-1',
    kind: 'referencePoint',
    name: '基準点1',
    visible: true,
    definition: { kind: 'coordinate', at: absoluteCoordinate(1, 2, 3) },
  };
  const sketch: SketchDocument = {
    ...fixture.document.sketches[0],
    features: fixture.document.sketches[0].features.map((feature) => ({
      ...feature,
      planeId: DEFAULT_WORK_PLANE_ID,
    })),
  };
  return {
    ...fixture.document,
    sketches: [sketch],
    references: [point],
    solids: [fixture.document.solids[0]],
  };
}

function twoReferencesDocument(): PartDocument {
  const base = independentSectionsDocument();
  const point2: ReferenceFeature = {
    id: 'referencePoint-2',
    kind: 'referencePoint',
    name: '基準点2',
    visible: true,
    definition: { kind: 'coordinate', at: absoluteCoordinate(4, 5, 6) },
  };
  return { ...base, references: [base.references[0], point2] };
}

/** 押し出し1 のあとに R 面取りを count-1 段つないだ文書(性能の検査用)。 */
function chainDocument(count: number): PartDocument {
  const base = independentSectionsDocument();
  const solids: SolidFeature[] = [base.solids[0]];
  for (let index = 1; index < count; index += 1) {
    const previous = solids[index - 1];
    solids.push({
      id: `fillet-${index}`,
      name: `R面取り${index}`,
      suppressed: false,
      kind: 'fillet',
      targetFeatureId: previous.id,
      targets: [holeEdgeRef(previous.id)],
      radius: ev(0.5),
    });
  }
  return { ...base, references: [], solids };
}

describe('途中までの文書(FR-506、ロールバック)', () => {
  it('つまみを 2(穴1)に置くと基準1 件・立体2 件になる', () => {
    const { document } = createFixture();
    const cut = documentUpTo(document, 2);
    expect(cut.references).toHaveLength(1);
    expect(cut.solids.map((feature) => feature.id)).toEqual(['extrude-1', 'hole-1']);
  });

  it('つまみが末尾(null)なら文書そのものを返す', () => {
    const { document } = createFixture();
    expect(documentUpTo(document, null)).toBe(document);
    // 通し番号で末尾を指したときも複製を作らない。
    expect(documentUpTo(document, 4)).toBe(document);
  });

  it('つまみを 0(作業平面1)に置くと立体は 0 件になる', () => {
    const { document } = createFixture();
    const cut = documentUpTo(document, 0);
    expect(cut.references).toHaveLength(1);
    expect(cut.solids).toHaveLength(0);
  });

  it('切った文書のフィーチャーは複製しない(形状キャッシュの鍵を変えない)', () => {
    const { document } = createFixture();
    const cut = documentUpTo(document, 2);
    expect(cut.solids[0]).toBe(document.solids[0]);
    expect(cut.solids[1]).toBe(document.solids[1]);
    expect(cut.references[0]).toBe(document.references[0]);
    expect(cut.sketches).toBe(document.sketches);
    expect(cut.parameters).toBe(document.parameters);
  });

  it('抑制された段も 1 件として数えて切る(帯の見た目と揃える)', () => {
    const fixture = createFixture();
    const document: PartDocument = {
      ...fixture.document,
      solids: fixture.document.solids.map((feature) =>
        feature.id === 'hole-1' ? { ...feature, suppressed: true } : feature,
      ),
    };
    const cut = documentUpTo(document, 2);
    expect(cut.solids.map((feature) => feature.id)).toEqual(['extrude-1', 'hole-1']);
  });

  it('resolvePart の結果が途中までになる(穴1 の段が消える)', () => {
    const { document } = createFixture();
    const full = resolvePart(document);
    expect(full.steps.map((step) => step.featureId)).toEqual([
      'extrude-1',
      'hole-1',
      'fillet-1',
      'extrude-2',
    ]);
    const cut = resolvePart(documentUpTo(document, 1));
    expect(cut.steps.map((step) => step.featureId)).toEqual(['extrude-1']);
    expect(cut.errors).toEqual([]);
  });

  it('切っても前半の段の鍵は変わらない(巻き戻しで作り直しにならない)', () => {
    const { document } = createFixture();
    const full = resolvePart(document);
    const cut = resolvePart(documentUpTo(document, 2));
    expect(cut.steps.map((step) => step.key)).toEqual(
      full.steps.slice(0, 2).map((step) => step.key),
    );
  });

  it('つまみが履歴より前(-1)なら何も残らない', () => {
    const { document } = createFixture();
    const cut = documentUpTo(document, -1);
    expect(cut.references).toHaveLength(0);
    expect(cut.solids).toHaveLength(0);
  });
});

describe('途中への差し込み位置(FR-507)', () => {
  it('つまみが 2(穴1)のとき、新しい立体は solids の 2 番目へ入る', () => {
    expect(insertPositionAt(createFixture().document, 2, 'solid')).toBe(2);
  });

  it('つまみが末尾(null)なら末尾へ入る', () => {
    const { document } = createFixture();
    expect(insertPositionAt(document, null, 'solid')).toBe(4);
    expect(insertPositionAt(document, null, 'reference')).toBe(1);
  });

  it('つまみが基準ジオメトリの区間にあるとき、立体は先頭へ入る', () => {
    const { document } = createFixture();
    expect(insertPositionAt(document, 0, 'solid')).toBe(0);
    expect(insertPositionAt(document, 0, 'reference')).toBe(1);
  });

  it('つまみが立体の区間にあるとき、基準ジオメトリは末尾へ入る', () => {
    expect(insertPositionAt(createFixture().document, 3, 'reference')).toBe(1);
  });

  it('つまみが履歴より前(-1)なら先頭へ入る', () => {
    const { document } = createFixture();
    expect(insertPositionAt(document, -1, 'solid')).toBe(0);
    expect(insertPositionAt(document, -1, 'reference')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 球面上の点(FR-431、P5 タスク19)
// ---------------------------------------------------------------------------

describe('球面上の点の依存(FR-431)', () => {
  /** 球1 と、その球面上の点を原点にした基準点1 を持つ部品文書。 */
  function sphereGridDocument(): PartDocument {
    const sphere: SolidFeature = {
      id: 'primitive-1',
      name: '球1',
      suppressed: false,
      kind: 'primitive',
      origin: {
        kind: 'coordinate',
        value: { mode: 'absolute', x: ev(0), y: ev(0), z: ev(0) },
      },
      axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'sphere', radius: ev(10) },
    };
    const point: ReferenceFeature = {
      id: 'referencePoint-1',
      kind: 'referencePoint',
      name: '基準点1',
      visible: true,
      definition: {
        kind: 'coordinate',
        at: {
          mode: 'relative',
          base: {
            kind: 'sphereGrid',
            sphereFeatureId: 'primitive-1',
            latitude: ev(30),
            longitude: ev(45),
          },
          dx: ev(0),
          dy: ev(0),
          dz: ev(0),
        },
      },
    };
    return { ...createEmptyPartDocument(), references: [point], solids: [sphere] };
  }

  it('球面上の点は球のフィーチャーに依存する(球を変えれば点も作り直す)', () => {
    expect(dependenciesOf(sphereGridDocument(), 'referencePoint-1')).toEqual(['primitive-1']);
  });

  it('球が履歴に無ければ依存は増えない(消えた球は依存の材料にしない)', () => {
    const document: PartDocument = { ...sphereGridDocument(), solids: [] };
    expect(dependenciesOf(document, 'referencePoint-1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 「消費しないが上流を指す」種類の依存(P5 タスク45)
//
// ミラー(FR-419)・曲面の `face`(FR-428)・罫線面の立体の面(FR-430)・押し出しの
// 「選んだ面まで」(FR-415)・基本形状の頂点(FR-429)は、対象を消費しないので
// `consumedTargetsOf` には現れない。それでも上流の立体が変われば形が変わるので、
// **並べ替えで上流より前へ動かせてはいけない**(docs/報告記録.md 2026-09-05 19:38)。
// ---------------------------------------------------------------------------

describe('消費しないが上流を指す種類の依存(P5 タスク45)', () => {
  /** 箱 1 つ(押し出し1)と、それを指す立体 1 つを持つ文書。 */
  function withUpstream(feature: SolidFeature): PartDocument {
    const fixture = createFixture();
    const extrude1 = fixture.document.solids[0];
    return { ...fixture.document, solids: [extrude1, feature] };
  }

  it('ミラーは、消費しない対象の立体に依存する', () => {
    const mirror: SolidFeature = {
      id: 'mirror-1',
      name: 'ミラー1',
      suppressed: false,
      kind: 'mirror',
      targetFeatureId: 'extrude-1',
      plane: { kind: 'workPlane', planeId: 'xy' },
    };
    expect(dependenciesOf(withUpstream(mirror), 'mirror-1')).toEqual(['extrude-1']);
  });

  it('ミラーは対象より前へ動かせない(並べ替えの判定、FR-507)', () => {
    const mirror: SolidFeature = {
      id: 'mirror-1',
      name: 'ミラー1',
      suppressed: false,
      kind: 'mirror',
      targetFeatureId: 'extrude-1',
      plane: { kind: 'face', face: topFaceRef('extrude-1') },
    };
    // 帯は 作業平面1(0)→ 押し出し1(1)→ ミラー1(2)。ミラーを 1 へ動かすと対象より前になる。
    const refused = canMoveHistoryItem(withUpstream(mirror), 'mirror-1', 1);
    expect(refused.ok).toBe(false);
  });

  it('曲面は、面を借りるだけの立体にも依存する(§0.a-0.45)', () => {
    const surface: SolidFeature = {
      id: 'surface-1',
      name: '曲面1',
      suppressed: false,
      kind: 'surface',
      operation: {
        kind: 'face',
        targetFeatureId: 'extrude-1',
        face: topFaceRef('extrude-1'),
      },
    };
    expect(dependenciesOf(withUpstream(surface), 'surface-1')).toEqual(['extrude-1']);
  });

  it('罫線面は、輪郭を借りた立体の面に依存する(§0.a-0.27)', () => {
    const fixture = createFixture();
    const ruled: SolidFeature = {
      id: 'ruled-1',
      name: '面をつなぐ1',
      suppressed: false,
      kind: 'ruled',
      first: { kind: 'solidFace', ref: topFaceRef('extrude-1') },
      second: { kind: 'sketchFace', ref: fixture.faceB },
      twist: ev(0),
      sphereSegments: 48,
    };
    // 断面の並び順に数えるので、スケッチの面(作業平面1)が先、立体の面が後になる。
    expect(dependenciesOf(withUpstream(ruled), 'ruled-1')).toEqual([
      'referencePlane-1',
      'extrude-1',
    ]);
  });

  it('押し出しの「選んだ面まで」は、その面を持つ立体に依存する(FR-415)', () => {
    const fixture = createFixture();
    const extrude2: SolidFeature = {
      id: 'extrude-2',
      name: '押し出し2',
      suppressed: false,
      kind: 'extrude',
      profile: fixture.faceB,
      distance: ev(5),
      reversed: false,
      symmetric: false,
      end: { kind: 'toFace', face: topFaceRef('extrude-1') },
    };
    // 輪郭のスケッチが乗る作業平面1 と、面を借りた押し出し1 の 2 つ。
    expect(dependenciesOf(withUpstream(extrude2), 'extrude-2')).toEqual([
      'referencePlane-1',
      'extrude-1',
    ]);
  });

  it('基本形状は、中心にした頂点を持つ立体に依存する(§0.a-0.19)', () => {
    const primitive: SolidFeature = {
      id: 'primitive-1',
      name: '球1',
      suppressed: false,
      kind: 'primitive',
      origin: {
        kind: 'vertex',
        ref: {
          bodyFeatureId: 'extrude-1',
          index: 2,
          fingerprint: { kind: 'vertex', position: [40, 30, 10] },
        },
      },
      axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'sphere', radius: ev(5) },
    };
    expect(dependenciesOf(withUpstream(primitive), 'primitive-1')).toEqual(['extrude-1']);
  });

  it('抜き勾配・移動/回転・拡大縮小は対象 1 つに依存する(消費するので二重にはしない)', () => {
    const draft: SolidFeature = {
      id: 'draft-1',
      name: '抜き勾配1',
      suppressed: false,
      kind: 'draft',
      targetFeatureId: 'extrude-1',
      faces: [topFaceRef('extrude-1')],
      neutralFace: topFaceRef('extrude-1'),
      angle: ev(3),
      reversed: false,
    };
    const transform: SolidFeature = {
      id: 'transform-1',
      name: '移動/回転1',
      suppressed: false,
      kind: 'transform',
      targetFeatureId: 'extrude-1',
      translation: [ev(10), ev(0), ev(0)],
      rotationAxis: null,
      rotationAngle: ev(0),
    };
    const scale: SolidFeature = {
      id: 'scale-1',
      name: '拡大縮小1',
      suppressed: false,
      kind: 'scale',
      targetFeatureId: 'extrude-1',
      origin: { kind: 'origin' },
      factor: { kind: 'uniform', value: ev(2) },
    };
    expect(dependenciesOf(withUpstream(draft), 'draft-1')).toEqual(['extrude-1']);
    expect(dependenciesOf(withUpstream(transform), 'transform-1')).toEqual(['extrude-1']);
    expect(dependenciesOf(withUpstream(scale), 'scale-1')).toEqual(['extrude-1']);
  });
});
