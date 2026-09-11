import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  findFeature,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import type { AxisSpec, PlaneSpec } from '../geometry/planeSpec.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { SketchDocument, SketchFaceFeature, SketchLineFeature } from '../sketch/types.js';
import { DEFAULT_THREAD_DESIGNATION, threadMinorDiameter } from '../thread/metricThread.js';
import {
  addSketch,
  appendReference,
  appendSolid,
  consumedBodyIds,
  consumedTargetsOf,
  createEmptyPartDocument,
  createPrimitiveFeature,
  createSketchFor,
  DEFAULT_BOX_SIZE_MM,
  DEFAULT_COUNTERBORE_DEPTH_MM,
  DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES,
  DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_CUT_KEEP,
  DEFAULT_DRAFT_ANGLE_DEGREES,
  DEFAULT_EMBOSS_HEIGHT_MM,
  DEFAULT_EMBOSS_RAISED,
  DEFAULT_EXTRUDE_END,
  DEFAULT_EXTRUDE_THICKNESS_MM,
  DEFAULT_HOLE_ENTRY,
  DEFAULT_MIRROR_PLANE_ID,
  DEFAULT_RIB_EXTEND_TO_BODY,
  DEFAULT_RIB_SIDE,
  DEFAULT_RIB_THICKNESS_MM,
  DEFAULT_SCALE_FACTOR,
  DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM,
  DEFAULT_SWEEP_FRENET,
  DEFAULT_TAPER_ANGLE_DEGREES,
  DEFAULT_THICKNESS_SIDE,
  DEFAULT_THREAD_SHAFT_FROM_END,
  DEFAULT_THREAD_SHAFT_LENGTH_MM,
  DEFAULT_THREAD_SHAFT_MODELED,
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
  DEFAULT_TRANSLATION_MM,
  extrudeShapingOf,
  holeEntryOf,
  MAX_DRAFT_ANGLE_DEGREES,
  MAX_SCALE,
  MAX_TAPER_ANGLE_DEGREES,
  MIN_SCALE,
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_CONE_BOTTOM_RADIUS_MM,
  DEFAULT_CONE_HEIGHT_MM,
  DEFAULT_CONE_TOP_RADIUS_MM,
  DEFAULT_CYLINDER_HEIGHT_MM,
  DEFAULT_CYLINDER_RADIUS_MM,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM,
  DEFAULT_PRIMITIVE_AXIS,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  DEFAULT_RULED_TWIST,
  DEFAULT_SEW_TOLERANCE_MM,
  DEFAULT_SPHERE_RADIUS_MM,
  DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM,
  DEFAULT_SPRING_TURNS,
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
  DEFAULT_TORUS_MAJOR_RADIUS_MM,
  DEFAULT_TORUS_MINOR_RADIUS_MM,
  defaultPrimitiveOrigin,
  defaultPrimitiveShape,
  findReference,
  findSketch,
  findSolid,
  isMachiningFeature,
  isPatternSource,
  liveBodyIds,
  MAX_PATTERN_COUNT,
  MAX_SPRING_TURNS,
  nextReferenceId,
  nextReferenceName,
  nextSketchId,
  nextSketchName,
  nextSolidId,
  nextSolidName,
  PART_SCHEMA_VERSION,
  REFERENCE_LABELS,
  removeReference,
  removeSketch,
  removeSolid,
  replaceReference,
  replaceSketch,
  replaceSolid,
  RULED_SPHERE_SEGMENT_CHOICES,
  setActiveSketch,
  SOLID_FEATURE_KINDS,
  SOLID_LABELS,
} from './createPartDocument.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ChamferFeature,
  CutFeature,
  DraftFeature,
  EmbossFeature,
  MirrorFeature,
  RibFeature,
  ScaleFeature,
  SurfaceFeature,
  SurfaceOperation,
  SweepFeature,
  ThreadShaftFeature,
  TransformFeature,
  ExtrudeFeature,
  FilletFeature,
  HoleFeature,
  PartDocument,
  PatternFeature,
  PrimitiveShapeKind,
  ReferenceFeature,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SketchPointRef,
  SolidFeature,
  SolidFeatureKind,
  SolidOrigin,
  SpringFeature,
  SubShapeRef,
  ThreadHoleFeature,
} from './types.js';

/** テストの中で式を書くための補助。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

/** 前提が崩れたら黙って進まずに落とす(テストの誤りと実装の誤りを分けるため)。 */
function activeSketch(document: PartDocument): SketchDocument {
  const sketch = findSketch(document, document.activeSketchId);
  if (sketch === undefined) {
    throw new Error('テストの前提が壊れている: activeSketchId のスケッチが無い');
  }
  return sketch;
}

/**
 * 40×30 の面を1枚だけ持つ部品文書を作る。押し出し・回転の断面に使う。
 * スケッチ側のフィーチャーは P1 の関数だけで組み立てる(面の作成関数はまだ無い)。
 */
function documentWithFace(): { document: PartDocument; faceRef: SketchFaceRef } {
  const base = createEmptyPartDocument();
  let sketch = activeSketch(base);
  const cornerIds: string[] = [];
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
  ]) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
    sketch = appendFeature(sketch, point);
    cornerIds.push(point.id);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: cornerIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  return {
    document: replaceSketch(base, sketch),
    faceRef: { sketchId: sketch.id, faceFeatureId: face.id },
  };
}

/** 回転軸に使える線分を、いま編集中のスケッチへ足す。 */
function addAxisLine(document: PartDocument): { document: PartDocument; lineRef: SketchLineRef } {
  const sketch = activeSketch(document);
  const line: SketchLineFeature = {
    id: nextFeatureId(sketch, 'line'),
    name: nextFeatureName(sketch, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(0, 30, 0),
    construction: false,
  };
  const next = appendFeature(sketch, line);
  return {
    document: replaceSketch(document, next),
    lineRef: { sketchId: next.id, lineFeatureId: line.id },
  };
}

function buildExtrude(
  document: PartDocument,
  profile: SketchFaceRef,
  distance = '5*2',
): ExtrudeFeature {
  return {
    id: nextSolidId(document, 'extrude'),
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile,
    distance: expr(distance),
    reversed: false,
    symmetric: false,
  };
}

function buildRevolve(document: PartDocument, profile: SketchFaceRef): RevolveFeature {
  return {
    id: nextSolidId(document, 'revolve'),
    name: nextSolidName(document, 'revolve'),
    suppressed: false,
    kind: 'revolve',
    profile,
    axis: { kind: 'world', axis: 'z' },
    angle: expr('360'),
    reversed: false,
  };
}

function buildSew(document: PartDocument, faces: readonly SketchFaceRef[]): SewFeature {
  return {
    id: nextSolidId(document, 'sew'),
    name: nextSolidName(document, 'sew'),
    suppressed: false,
    kind: 'sew',
    faces,
    tolerance: expr(String(DEFAULT_SEW_TOLERANCE_MM)),
  };
}

function buildBoolean(
  document: PartDocument,
  operation: BooleanOperation,
  targetFeatureId: string,
  toolFeatureId: string,
): BooleanFeature {
  return {
    id: nextSolidId(document, operation),
    name: nextSolidName(document, operation),
    suppressed: false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
}

/** 押し出し2つと、その2つを消費する差を持つ文書(消費の判定の土台)。 */
function documentWithSubtract(): {
  document: PartDocument;
  target: ExtrudeFeature;
  tool: ExtrudeFeature;
  subtract: BooleanFeature;
} {
  const { document: withFace, faceRef } = documentWithFace();
  const target = buildExtrude(withFace, faceRef);
  const afterTarget = appendSolid(withFace, target);
  const tool = buildExtrude(afterTarget, faceRef, '4');
  const afterTool = appendSolid(afterTarget, tool);
  const subtract = buildBoolean(afterTool, 'subtract', target.id, tool.id);
  return { document: appendSolid(afterTool, subtract), target, tool, subtract };
}

/** 面の指紋(P3 §2.2.3 の検算表と同じ箱: 40×30 を Z へ10押し出した上面)。 */
function faceRefOf(bodyFeatureId: string, index = 0): SubShapeRef {
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

/** 辺の指紋(上の箱の手前下の辺)。 */
function edgeRefOf(bodyFeatureId: string, index = 0): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [20, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

/** documentWithFace が作る最初の点(point-1)への参照。穴の中心とばねの始点に使う。 */
function firstPointRef(document: PartDocument): SketchPointRef {
  return { sketchId: document.activeSketchId, pointFeatureId: 'point-1' };
}

function buildHole(document: PartDocument, targetFeatureId: string): HoleFeature {
  return {
    id: nextSolidId(document, 'hole'),
    name: nextSolidName(document, 'hole'),
    suppressed: false,
    kind: 'hole',
    targetFeatureId,
    face: faceRefOf(targetFeatureId),
    centers: [firstPointRef(document)],
    diameter: expr(String(DEFAULT_HOLE_DIAMETER_MM)),
    depth: { kind: 'through' },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
  };
}

function buildThreadHole(document: PartDocument, targetFeatureId: string): ThreadHoleFeature {
  return {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId,
    face: faceRefOf(targetFeatureId),
    centers: [firstPointRef(document)],
    designation: DEFAULT_THREAD_DESIGNATION,
    series: 'coarse',
    pitch: expr('1'),
    drillDiameter: expr(String(threadMinorDiameter(6, 1))),
    depth: { kind: 'blind', depth: expr(String(DEFAULT_HOLE_DEPTH_MM)) },
    threadLength: expr('8'),
    representation: 'simplified',
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
  };
}

function buildFillet(document: PartDocument, targetFeatureId: string): FilletFeature {
  return {
    id: nextSolidId(document, 'fillet'),
    name: nextSolidName(document, 'fillet'),
    suppressed: false,
    kind: 'fillet',
    targetFeatureId,
    targets: [edgeRefOf(targetFeatureId, 2)],
    radius: expr(String(DEFAULT_FILLET_RADIUS_MM)),
  };
}

function buildChamfer(document: PartDocument, targetFeatureId: string): ChamferFeature {
  return {
    id: nextSolidId(document, 'chamfer'),
    name: nextSolidName(document, 'chamfer'),
    suppressed: false,
    kind: 'chamfer',
    targetFeatureId,
    targets: [edgeRefOf(targetFeatureId, 2)],
    size: { kind: 'equal', distance: expr(String(DEFAULT_CHAMFER_DISTANCE_MM)) },
    swapReferenceFace: false,
  };
}

function buildLinearPattern(document: PartDocument, sourceFeatureId: string): PatternFeature {
  return {
    id: nextSolidId(document, 'linearPattern'),
    name: nextSolidName(document, 'linearPattern'),
    suppressed: false,
    kind: 'pattern',
    sourceFeatureId,
    placement: {
      kind: 'linear',
      direction: { kind: 'world', axis: 'x' },
      spacing: expr(String(DEFAULT_PATTERN_SPACING_MM)),
      count: expr(String(DEFAULT_PATTERN_COUNT)),
      symmetric: false,
    },
  };
}

function buildCircularPattern(document: PartDocument, sourceFeatureId: string): PatternFeature {
  return {
    id: nextSolidId(document, 'circularPattern'),
    name: nextSolidName(document, 'circularPattern'),
    suppressed: false,
    kind: 'pattern',
    sourceFeatureId,
    placement: {
      kind: 'circular',
      axis: { kind: 'world', axis: 'z' },
      angle: expr('360'),
      count: expr(String(DEFAULT_CIRCULAR_PATTERN_COUNT)),
      fullCircle: true,
    },
  };
}

function buildSpring(document: PartDocument): SpringFeature {
  return {
    id: nextSolidId(document, 'spring'),
    name: nextSolidName(document, 'spring'),
    suppressed: false,
    kind: 'spring',
    origin: firstPointRef(document),
    axis: { kind: 'world', axis: 'z' },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
    length: expr(String(DEFAULT_SPRING_PITCH_MM * DEFAULT_SPRING_TURNS)),
    pitch: expr(String(DEFAULT_SPRING_PITCH_MM)),
    turns: expr(String(DEFAULT_SPRING_TURNS)),
    derived: 'length',
    coilDiameter: expr(String(DEFAULT_SPRING_COIL_DIAMETER_MM)),
    wireDiameter: expr(String(DEFAULT_SPRING_WIRE_DIAMETER_MM)),
    handedness: 'right',
  };
}

/** 「40×30 を押し出した立体に貫通穴を1つあけた」文書(加工の消費の判定の土台)。 */
function documentWithHole(): {
  document: PartDocument;
  extrude: ExtrudeFeature;
  hole: HoleFeature;
} {
  const { document: withFace, faceRef } = documentWithFace();
  const extrude = buildExtrude(withFace, faceRef);
  const afterExtrude = appendSolid(withFace, extrude);
  const hole = buildHole(afterExtrude, extrude.id);
  return { document: appendSolid(afterExtrude, hole), extrude, hole };
}

describe('部品文書の生成(要件§8、FR-501)', () => {
  it('空の部品は、空のスケッチを1本だけ持ちソリッドは無い', () => {
    const document = createEmptyPartDocument();
    expect(document.id).toBe('part-1');
    expect(document.name).toBe('部品1');
    expect(document.sketches).toHaveLength(1);
    expect(document.sketches[0].features).toEqual([]);
    expect(document.solids).toEqual([]);
  });

  it('空の部品の外観の割り当ては空(FR-1106〜1110、P5 タスク5)', () => {
    expect(createEmptyPartDocument().appearance.entries).toEqual([]);
  });

  // P4 タスク31・§0.a-0.24 で版 4 へ上げ、P4b タスク21・§0.a-0.17(案 A)で版 5 へ上げ、
  // P5 タスク5・§0.a-0.15 で版 6 へ上げ、P6 タスク21・§0.a-0.55 で版 7 へ上げた
  // (io 側 PCAD_SCHEMA_VERSION と同じ値を保つ)。これは仕様変更であり、期待値の緩和ではない。
  // P8 タスク3で版 9 へ上げた(封筒に `kind: 'drawing'` を足したため。
  // 部品とアセンブリで版の系列を分けない)。P8-60/62/64では名前付き視点・構成を足して版10へ上げる。
  it('保存形式の版は 10(P8 タスク60・62・64)', () => {
    expect(PART_SCHEMA_VERSION).toBe(12);
    expect(createEmptyPartDocument().schemaVersion).toBe(PART_SCHEMA_VERSION);
  });

  it('activeSketchId は実在するスケッチを指す(§0.a-0.4)', () => {
    const document = createEmptyPartDocument();
    expect(document.activeSketchId).toBe(document.sketches[0].id);
    expect(findSketch(document, document.activeSketchId)).toBe(document.sketches[0]);
    expect(findSketch(document, 'no-such-sketch')).toBeUndefined();
  });
});

describe('スケッチの追加と差し替え(不変、FR-505 の土台)', () => {
  it('足しても元の文書は変わらず、末尾へ並ぶ', () => {
    const before = createEmptyPartDocument();
    const added: SketchDocument = { id: 'sketch-2', name: 'スケッチ2', features: [] };
    const after = addSketch(before, added);
    expect(before.sketches).toHaveLength(1);
    expect(after.sketches).toHaveLength(2);
    expect(after.sketches[1]).toBe(added);
    expect(after.activeSketchId).toBe(before.activeSketchId);
  });

  it('同じ id のスケッチは足さない(id の一意性)', () => {
    const document = createEmptyPartDocument();
    const duplicate: SketchDocument = { id: document.activeSketchId, name: '別名', features: [] };
    expect(addSketch(document, duplicate)).toBe(document);
  });

  it('差し替えは該当 id だけを入れ替え、無い id なら元の文書のまま', () => {
    const { document } = documentWithFace();
    expect(activeSketch(document).features).toHaveLength(5);
    const emptied: SketchDocument = { ...activeSketch(document), features: [] };
    const after = replaceSketch(document, emptied);
    expect(activeSketch(after).features).toEqual([]);
    expect(activeSketch(document).features).toHaveLength(5);
    const stranger: SketchDocument = { id: 'sketch-9', name: 'よそ者', features: [] };
    expect(replaceSketch(document, stranger)).toBe(document);
  });

  it('編集中のスケッチは実在する id にだけ切り替わる', () => {
    const document = addSketch(createEmptyPartDocument(), {
      id: 'sketch-2',
      name: 'スケッチ2',
      features: [],
    });
    expect(setActiveSketch(document, 'sketch-2').activeSketchId).toBe('sketch-2');
    expect(setActiveSketch(document, 'no-such-sketch')).toBe(document);
  });
});

describe('ソリッドフィーチャーの履歴操作(FR-501、FR-503)', () => {
  it('足しても元の文書は変わらず、履歴の順序が保たれる', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildRevolve(afterFirst, faceRef);
    const afterSecond = appendSolid(afterFirst, second);
    expect(withFace.solids).toHaveLength(0);
    expect(afterFirst.solids).toHaveLength(1);
    expect(afterSecond.solids.map((solid) => solid.id)).toEqual([first.id, second.id]);
  });

  it('同じ id のフィーチャーは足さない(ボディの id が重ならない)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const feature = buildExtrude(withFace, faceRef);
    const added = appendSolid(withFace, feature);
    expect(appendSolid(added, feature)).toBe(added);
  });

  it('種類が混ざっても id は一意', () => {
    const { document: withFace, faceRef } = documentWithFace();
    let document = withFace;
    const extrude = buildExtrude(document, faceRef);
    document = appendSolid(document, extrude);
    document = appendSolid(document, buildRevolve(document, faceRef));
    document = appendSolid(document, buildSew(document, [faceRef, faceRef]));
    const union = buildBoolean(document, 'union', extrude.id, extrude.id);
    document = appendSolid(document, union);
    const ids = document.solids.map((solid) => solid.id);
    expect(ids).toEqual(['extrude-1', 'revolve-1', 'sew-1', 'union-1']);
    expect(new Set(ids).size).toBe(4);
  });

  it('差し替えは対象だけを変え、並び順は変わらない(抑制・改名もこれで行う)', () => {
    const { document, target, subtract } = documentWithSubtract();
    const suppressed: SolidFeature = { ...target, suppressed: true, name: '押し出し(止め)' };
    const after = replaceSolid(document, target.id, suppressed);
    expect(after.solids.map((solid) => solid.id)).toEqual(
      document.solids.map((solid) => solid.id),
    );
    expect(findSolid(after, target.id)).toEqual(suppressed);
    expect(findSolid(after, subtract.id)).toEqual(subtract);
    expect(findSolid(document, target.id)).toEqual(target);
    expect(replaceSolid(document, 'no-such-solid', suppressed)).toBe(document);
  });

  it('取り除いても残りの並びは変わらず、無い id なら元の文書のまま', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const after = removeSolid(document, tool.id);
    expect(after.solids.map((solid) => solid.id)).toEqual([target.id, subtract.id]);
    expect(findSolid(after, tool.id)).toBeUndefined();
    expect(document.solids).toHaveLength(3);
    expect(removeSolid(document, 'no-such-solid')).toBe(document);
  });

  it('参照先を取り除いてもブーリアンは履歴に残る(解決のときに失敗させる、FR-504)', () => {
    const { document, target, subtract } = documentWithSubtract();
    const after = removeSolid(document, target.id);
    const remaining = findSolid(after, subtract.id);
    expect(remaining).toEqual(subtract);
    expect(remaining?.kind).toBe('boolean');
    if (remaining?.kind === 'boolean') {
      // 参照は id のままで、消えた相手を指し続ける(FR-311、FR-502)。
      expect(findSolid(after, remaining.targetFeatureId)).toBeUndefined();
    }
  });
});

describe('名前と id の採番(§0.a-0.19、FR-501)', () => {
  it('同じ種類の既存の最大連番+1(削除しても重ならない)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    expect(nextSolidName(withFace, 'extrude')).toBe('押し出し1');
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildExtrude(afterFirst, faceRef);
    const afterSecond = appendSolid(afterFirst, second);
    expect([first.name, second.name]).toEqual(['押し出し1', '押し出し2']);
    expect(nextSolidName(afterSecond, 'extrude')).toBe('押し出し3');
    expect(nextSolidId(afterSecond, 'extrude')).toBe('extrude-3');
    // 押し出し1 を消しても、残る 押し出し2 の次は 押し出し3。
    const removed = removeSolid(afterSecond, first.id);
    expect(nextSolidName(removed, 'extrude')).toBe('押し出し3');
    expect(nextSolidId(removed, 'extrude')).toBe('extrude-3');
    // 全部消せば 1 に戻る(重複する相手がいない)。
    const emptied = removeSolid(removed, second.id);
    expect(nextSolidName(emptied, 'extrude')).toBe('押し出し1');
    expect(nextSolidId(emptied, 'extrude')).toBe('extrude-1');
  });

  it('種類ごとに独立して数え、ブーリアンは演算ごとに別の連番', () => {
    const { document, target, tool } = documentWithSubtract();
    expect(SOLID_LABELS).toEqual({
      sheetBase: '板金基板',
      sheetFlange: 'フランジ',
  sheetBend: '指定線で曲げる',
  sheetRelief: '曲げリリーフ',
      extrude: '押し出し',
      revolve: '回転',
      sew: '縫合',
      union: '和',
      subtract: '差',
      intersect: '積',
      hole: '穴',
      threadHole: 'ねじ穴',
      fillet: 'R面取り',
      chamfer: 'C面取り',
      linearPattern: '直線パターン',
      circularPattern: '円形パターン',
      spring: 'ばね',
      sphere: '球',
      box: '箱',
      cylinder: '円柱',
      cone: '円錐',
      torus: 'トーラス',
      ruled: '面をつなぐ',
      loft: 'ロフト',
      // P5 の Should 群(§2.11、タスク43)。9 種 + 点パターン。
      draft: '抜き勾配',
      mirror: 'ミラー',
      transform: '移動・回転',
      scale: '拡大縮小',
      sweep: 'スイープ',
      rib: 'リブ',
      emboss: 'エンボス',
      threadShaft: '外ねじ',
      surface: '曲面',
      pointPattern: '点パターン',
      // P5 の Could 群のうちタスク46 が前倒しした 1 種(FR-418、§2.12)。
      shell: 'くり抜き',
      // 平面による切断(FR-432、§2.9b、タスク27c)。
      cut: '切断',
      // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
      importedSolid: '読み込んだ形',
      importedMesh: '読み込んだ三角形の形',
    });
    expect(findSolid(document, 'subtract-1')?.name).toBe('差1');
    expect(nextSolidName(document, 'subtract')).toBe('差2');
    expect(nextSolidName(document, 'union')).toBe('和1');
    expect(nextSolidName(document, 'intersect')).toBe('積1');
    expect(nextSolidName(document, 'revolve')).toBe('回転1');
    expect(nextSolidName(document, 'sew')).toBe('縫合1');
    expect(nextSolidName(document, 'extrude')).toBe('押し出し3');
    expect(buildBoolean(document, 'union', target.id, tool.id).id).toBe('union-1');
  });
});

describe('ソリッドフィーチャーの型(FR-202、FR-311)', () => {
  it('全パラメータは式と評価値のペアで、断面は id で参照する', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    expect(extrude.distance.source).toBe('5*2');
    expect(extrude.distance.value).toBe(10);
    expect(extrude.reversed).toBe(false);
    expect(extrude.symmetric).toBe(false);
    // 参照先が実在する(座標は複製しない)。
    const sketch = findSketch(withFace, extrude.profile.sketchId);
    expect(sketch).toBeDefined();
    expect(sketch === undefined ? undefined : findFeature(sketch, extrude.profile.faceFeatureId))
      .toBeDefined();
  });

  it('縫合の既定の許容量は 0.01 mm で、面を2枚以上並べる(§0.a-0.7)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    expect(DEFAULT_SEW_TOLERANCE_MM).toBe(0.01);
    const sew = buildSew(withFace, [faceRef, faceRef]);
    expect(sew.tolerance.value).toBe(0.01);
    expect(sew.faces).toHaveLength(2);
    expect(sew.faces.every((face) => face.sketchId === withFace.activeSketchId)).toBe(true);
  });

  it('回転軸はワールドの軸かスケッチの線分の2通り(§0.a-0.9)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const revolve = buildRevolve(withFace, faceRef);
    expect(revolve.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(revolve.angle.value).toBe(360);

    const { document, lineRef } = addAxisLine(withFace);
    const onLine: RevolveFeature = { ...revolve, axis: { kind: 'line', line: lineRef } };
    expect(onLine.axis.kind).toBe('line');
    if (onLine.axis.kind === 'line') {
      const sketch = findSketch(document, onLine.axis.line.sketchId);
      expect(sketch).toBeDefined();
      const line =
        sketch === undefined ? undefined : findFeature(sketch, onLine.axis.line.lineFeatureId);
      expect(line?.kind).toBe('line');
    }
  });
});

describe('ボディの消費と、いま画面に出るボディ(§0.a-0.5)', () => {
  it('ブーリアンは対象と相手を消費し、自分だけが残る', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    expect([...consumedBodyIds(document)].sort()).toEqual([target.id, tool.id].sort());
    expect(liveBodyIds(document)).toEqual([subtract.id]);
  });

  it('ブーリアンが無ければ何も消費されず、履歴順に全部残る', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildRevolve(afterFirst, faceRef);
    const document = appendSolid(afterFirst, second);
    expect(consumedBodyIds(document).size).toBe(0);
    expect(liveBodyIds(document)).toEqual([first.id, second.id]);
  });

  it('抑制したフィーチャーはボディを作らず、抑制したブーリアンは何も消費しない(FR-503)', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const suppressedBoolean = replaceSolid(document, subtract.id, {
      ...subtract,
      suppressed: true,
    });
    expect(consumedBodyIds(suppressedBoolean).size).toBe(0);
    expect(liveBodyIds(suppressedBoolean)).toEqual([target.id, tool.id]);

    const suppressedTool = replaceSolid(document, tool.id, { ...tool, suppressed: true });
    // 抑制された相手はボディが無いので消費されない(解決のときに missingBody になる)。
    expect([...consumedBodyIds(suppressedTool)]).toEqual([target.id]);
    expect(liveBodyIds(suppressedTool)).toEqual([subtract.id]);
  });

  it('消えた参照先は消費に数えず、ブーリアン自身は残る(FR-504)', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const after = removeSolid(document, target.id);
    expect([...consumedBodyIds(after)]).toEqual([tool.id]);
    expect(liveBodyIds(after)).toEqual([subtract.id]);
  });

  it('履歴で自分より後ろのボディは消費できない(前方参照は無効)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildExtrude(afterFirst, faceRef, '4');
    const later = buildExtrude(appendSolid(afterFirst, second), faceRef, '6');
    // まだ足していない later を参照するブーリアンを、later より前に置く。
    const union = buildBoolean(afterFirst, 'union', first.id, later.id);
    const document = appendSolid(appendSolid(afterFirst, union), later);
    expect([...consumedBodyIds(document)]).toEqual([first.id]);
    expect(liveBodyIds(document)).toEqual([union.id, later.id]);
  });
});

describe('加工フィーチャーとばねの名前・id の採番(P3 タスク13、FR-501)', () => {
  it('種類ごとの既定名は38個(従来34 + 板金の4種類)', () => {
    // P5 タスク15 で基本形状5種(球・箱・円柱・円錐・トーラス)が増えて 13 → 18 になり、
    // タスク25 で面をつなぐ(FR-430)・ロフト(FR-410)が増えて 18 → 20 になった。
    // タスク43 で Should 群 9 種と点パターン(FR-425)が増えて 20 → 30 になり、
    // タスク46 でくり抜き(FR-418、§2.12)が増えて 30 → 31 になり、
    // タスク27c で平面による切断(FR-432、§2.9b)が増えて 31 → 32 になり、
    // P6 タスク20 で読み込んだ形のベースボディ 2 種(FR-802、§2.8)が増えて 32 → 34 になった。
    // P10の板金基板・フランジ・指定線曲げを含む。全キーの一致は上の独立した表で検査する。
    expect(Object.keys(SOLID_LABELS)).toHaveLength(38);
    expect(SOLID_LABELS.hole).toBe('穴');
    expect(SOLID_LABELS.threadHole).toBe('ねじ穴');
    expect(SOLID_LABELS.spring).toBe('ばね');
    expect(SOLID_LABELS.sphere).toBe('球');
    expect(SOLID_LABELS.torus).toBe('トーラス');
    expect(SOLID_LABELS.ruled).toBe('面をつなぐ');
    expect(SOLID_LABELS.loft).toBe('ロフト');
    expect(SOLID_LABELS.draft).toBe('抜き勾配');
    expect(SOLID_LABELS.threadShaft).toBe('外ねじ');
    expect(SOLID_LABELS.pointPattern).toBe('点パターン');
    expect(SOLID_LABELS.shell).toBe('くり抜き');
    expect(SOLID_LABELS.cut).toBe('切断');
    expect(SOLID_LABELS.importedSolid).toBe('読み込んだ形');
    expect(SOLID_LABELS.importedMesh).toBe('読み込んだ三角形の形');
  });

  it('穴は同じ種類の最大連番+1で数え、1つ消しても番号は戻らない', () => {
    const { document: withHole, extrude } = documentWithHole();
    const second = buildHole(withHole, extrude.id);
    const afterSecond = appendSolid(withHole, second);
    expect(afterSecond.solids.map((solid) => solid.name)).toEqual(['押し出し1', '穴1', '穴2']);
    expect(nextSolidName(afterSecond, 'hole')).toBe('穴3');
    const removed = removeSolid(afterSecond, 'hole-1');
    expect(nextSolidName(removed, 'hole')).toBe('穴3');
    expect(nextSolidId(removed, 'hole')).toBe('hole-3');
  });

  it('ねじ穴の id は threadHole-1 から始まる', () => {
    const { document, extrude } = documentWithHole();
    expect(nextSolidId(document, 'threadHole')).toBe('threadHole-1');
    const thread = buildThreadHole(document, extrude.id);
    expect(thread.id).toBe('threadHole-1');
    expect(thread.name).toBe('ねじ穴1');
    expect(nextSolidId(appendSolid(document, thread), 'threadHole')).toBe('threadHole-2');
  });

  it('ばねが2つあれば次は ばね3(§0.a-0.36)', () => {
    const { document: withFace } = documentWithFace();
    const first = buildSpring(withFace);
    const afterFirst = appendSolid(withFace, first);
    const second = buildSpring(afterFirst);
    const document = appendSolid(afterFirst, second);
    expect([first.name, second.name]).toEqual(['ばね1', 'ばね2']);
    expect(nextSolidName(document, 'spring')).toBe('ばね3');
    expect(nextSolidId(document, 'spring')).toBe('spring-3');
  });

  it('パターンは配置ごと(直線 / 円形)に別の連番で数える(§2.3 と同じ考え方)', () => {
    const { document: withHole, hole } = documentWithHole();
    const linear = buildLinearPattern(withHole, hole.id);
    const afterLinear = appendSolid(withHole, linear);
    const circular = buildCircularPattern(afterLinear, hole.id);
    expect(linear.id).toBe('linearPattern-1');
    expect(linear.name).toBe('直線パターン1');
    expect(circular.id).toBe('circularPattern-1');
    expect(circular.name).toBe('円形パターン1');
    expect(nextSolidName(appendSolid(afterLinear, circular), 'linearPattern')).toBe(
      '直線パターン2',
    );
  });

  it('R 面取り・C 面取りの名前と id', () => {
    const { document, extrude } = documentWithHole();
    const fillet = buildFillet(document, extrude.id);
    const chamfer = buildChamfer(appendSolid(document, fillet), extrude.id);
    expect([fillet.id, fillet.name]).toEqual(['fillet-1', 'R面取り1']);
    expect([chamfer.id, chamfer.name]).toEqual(['chamfer-1', 'C面取り1']);
  });

  it('同じ id の加工フィーチャーは足さず、元の文書がそのまま返る', () => {
    const { document, hole } = documentWithHole();
    expect(appendSolid(document, hole)).toBe(document);
    expect(document.solids).toHaveLength(2);
  });
});

describe('加工フィーチャーとばねの型(P3 §2.4 / §2.6 / §2.7 / §2.7b、FR-202)', () => {
  it('穴は面の指紋・中心の点・径・深さを持ち、数値はすべて式と評価値の組', () => {
    const { hole } = documentWithHole();
    expect(hole.face.bodyFeatureId).toBe('extrude-1');
    expect(hole.face.fingerprint.kind).toBe('face');
    expect(hole.centers).toHaveLength(1);
    expect(hole.centers[0].pointFeatureId).toBe('point-1');
    expect(hole.diameter.source).toBe('6');
    expect(hole.diameter.value).toBe(DEFAULT_HOLE_DIAMETER_MM);
    expect(hole.depth).toEqual({ kind: 'through' });
    expect(hole.tiltAngle.value).toBe(0);
    expect(hole.tiltAzimuth.value).toBe(0);
  });

  it('止まり穴は深さを式で持つ(貫通の長さは保存しない、§0.a-0.12)', () => {
    const { document, extrude } = documentWithHole();
    const blind: HoleFeature = {
      ...buildHole(document, extrude.id),
      depth: { kind: 'blind', depth: expr('4+1') },
    };
    expect(blind.depth.kind).toBe('blind');
    if (blind.depth.kind === 'blind') {
      expect(blind.depth.depth.source).toBe('4+1');
      expect(blind.depth.depth.value).toBe(5);
    }
  });

  it('ねじ穴は呼び・系列・ピッチ・下穴径を持ち、下穴径の既定はめねじ内径 D1(§0.a-0.14)', () => {
    const { document, extrude } = documentWithHole();
    const thread = buildThreadHole(document, extrude.id);
    expect(thread.designation).toBe('M6');
    expect(thread.series).toBe('coarse');
    expect(thread.pitch.value).toBe(1);
    expect(thread.drillDiameter.value).toBeCloseTo(4.917468, 6);
    expect(thread.representation).toBe('simplified');
    const modeled: ThreadHoleFeature = { ...thread, representation: 'modeled' };
    expect(modeled.representation).toBe('modeled');
  });

  it('C 面取りの大きさは等距離・2距離・距離+角度の3通り(FR-408)', () => {
    const { document, extrude } = documentWithHole();
    const equal = buildChamfer(document, extrude.id);
    expect(equal.size).toEqual({
      kind: 'equal',
      distance: expr(String(DEFAULT_CHAMFER_DISTANCE_MM)),
    });
    const twoDistances: ChamferFeature = {
      ...equal,
      size: { kind: 'twoDistances', distance1: expr('1'), distance2: expr('2') },
    };
    const distanceAngle: ChamferFeature = {
      ...equal,
      size: {
        kind: 'distanceAngle',
        distance: expr('1'),
        angle: expr(String(DEFAULT_CHAMFER_ANGLE_DEGREES)),
      },
    };
    expect(twoDistances.size.kind).toBe('twoDistances');
    expect(distanceAngle.size.kind).toBe('distanceAngle');
    if (distanceAngle.size.kind === 'distanceAngle') {
      expect(distanceAngle.size.angle.value).toBe(45);
    }
    expect(equal.swapReferenceFace).toBe(false);
  });

  it('R 面取りは辺・頂点をまとめて指せる(§0.a-0.17)', () => {
    const { document, extrude } = documentWithHole();
    const fillet = buildFillet(document, extrude.id);
    const withVertex: FilletFeature = {
      ...fillet,
      targets: [
        ...fillet.targets,
        { bodyFeatureId: extrude.id, index: 5, fingerprint: { kind: 'vertex', position: [0, 0, 0] } },
      ],
    };
    expect(withVertex.targets.map((target) => target.fingerprint.kind)).toEqual(['edge', 'vertex']);
    expect(fillet.radius.value).toBe(DEFAULT_FILLET_RADIUS_MM);
  });

  it('パターンの向き・軸は回転軸と同じ形を流用する(§0.a-0.21)', () => {
    const { document: withHole, hole } = documentWithHole();
    const { document, lineRef } = addAxisLine(withHole);
    const linear = buildLinearPattern(document, hole.id);
    expect(linear.placement.kind).toBe('linear');
    if (linear.placement.kind === 'linear') {
      expect(linear.placement.direction).toEqual({ kind: 'world', axis: 'x' });
      expect(linear.placement.spacing.value).toBe(DEFAULT_PATTERN_SPACING_MM);
      expect(linear.placement.count.value).toBe(DEFAULT_PATTERN_COUNT);
      expect(linear.placement.symmetric).toBe(false);
    }
    const onLine: PatternFeature = {
      ...linear,
      placement: {
        kind: 'linear',
        direction: { kind: 'line', line: lineRef },
        spacing: expr('20'),
        count: expr('3'),
        symmetric: true,
      },
    };
    expect(onLine.placement.kind === 'linear' && onLine.placement.direction.kind).toBe('line');
    const circular = buildCircularPattern(document, hole.id);
    expect(circular.placement.kind).toBe('circular');
    if (circular.placement.kind === 'circular') {
      expect(circular.placement.fullCircle).toBe(true);
      expect(circular.placement.count.value).toBe(DEFAULT_CIRCULAR_PATTERN_COUNT);
    }
  });

  it('ばねは始点の点参照・軸・傾き・3つの寸法・巻き方向を持つ(FR-414)', () => {
    const { document } = documentWithFace();
    const spring = buildSpring(document);
    expect(spring.origin.pointFeatureId).toBe('point-1');
    expect(spring.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(spring.tiltAngle.value).toBe(0);
    expect(spring.tiltAzimuth.value).toBe(0);
    expect(spring.pitch.value).toBe(DEFAULT_SPRING_PITCH_MM);
    expect(spring.turns.value).toBe(DEFAULT_SPRING_TURNS);
    // 全長 = ピッチ × 巻数(線径のぶんは含まない、§0.a-0.30)。
    expect(spring.length.value).toBe(DEFAULT_SPRING_PITCH_MM * DEFAULT_SPRING_TURNS);
    expect(spring.coilDiameter.value).toBe(DEFAULT_SPRING_COIL_DIAMETER_MM);
    expect(spring.wireDiameter.value).toBe(DEFAULT_SPRING_WIRE_DIAMETER_MM);
    expect(spring.derived).toBe('length');
    expect(spring.handedness).toBe('right');
    const left: SpringFeature = { ...spring, derived: 'turns', handedness: 'left' };
    expect([left.derived, left.handedness]).toEqual(['turns', 'left']);
  });

  it('既定値と上限は計画書の数値のまま(§0.a-0.21、§0.a-0.30、§0.a-0.35)', () => {
    expect(DEFAULT_HOLE_DIAMETER_MM).toBe(6);
    expect(DEFAULT_HOLE_DEPTH_MM).toBe(10);
    expect(DEFAULT_FILLET_RADIUS_MM).toBe(2);
    expect(DEFAULT_CHAMFER_DISTANCE_MM).toBe(1);
    expect(DEFAULT_CHAMFER_ANGLE_DEGREES).toBe(45);
    expect(DEFAULT_PATTERN_SPACING_MM).toBe(20);
    expect(DEFAULT_PATTERN_COUNT).toBe(3);
    expect(DEFAULT_CIRCULAR_PATTERN_COUNT).toBe(4);
    expect(MAX_PATTERN_COUNT).toBe(100);
    expect(DEFAULT_SPRING_COIL_DIAMETER_MM).toBe(20);
    expect(DEFAULT_SPRING_WIRE_DIAMETER_MM).toBe(2);
    expect(DEFAULT_SPRING_PITCH_MM).toBe(5);
    expect(DEFAULT_SPRING_TURNS).toBe(4);
    expect(MAX_SPRING_TURNS).toBe(200);
  });
});

describe('加工・パターン・ばねの消費の判定(§0.a-0.5、§0.a-0.20、§0.a-0.36)', () => {
  it('consumedTargetsOf は種類ごとに消費するボディを返す', () => {
    const { document: withHole, extrude, hole } = documentWithHole();
    const { document: withFace, faceRef } = documentWithFace();
    const revolve = buildRevolve(withFace, faceRef);
    const sew = buildSew(withFace, [faceRef, faceRef]);
    const boolean = buildBoolean(withHole, 'subtract', extrude.id, hole.id);
    expect(consumedTargetsOf(extrude)).toEqual([]);
    expect(consumedTargetsOf(revolve)).toEqual([]);
    expect(consumedTargetsOf(sew)).toEqual([]);
    expect(consumedTargetsOf(boolean)).toEqual([extrude.id, hole.id]);
    expect(consumedTargetsOf(hole)).toEqual([extrude.id]);
    expect(consumedTargetsOf(buildThreadHole(withHole, extrude.id))).toEqual([extrude.id]);
    expect(consumedTargetsOf(buildFillet(withHole, extrude.id))).toEqual([extrude.id]);
    expect(consumedTargetsOf(buildChamfer(withHole, extrude.id))).toEqual([extrude.id]);
    expect(consumedTargetsOf(buildLinearPattern(withHole, hole.id))).toEqual([hole.id]);
    expect(consumedTargetsOf(buildCircularPattern(withHole, hole.id))).toEqual([hole.id]);
  });

  it('ばねは何も消費しない(「作る」フィーチャー、§0.a-0.36)', () => {
    const { document: withFace } = documentWithFace();
    expect(consumedTargetsOf(buildSpring(withFace))).toEqual([]);
    expect(isMachiningFeature(buildSpring(withFace))).toBe(false);
    expect(isPatternSource(buildSpring(withFace))).toBe(false);
  });

  it('isMachiningFeature は対象を1つ取る種類だけ真(ブーリアンは2つ取るので偽)', () => {
    const { document: withHole, extrude, hole } = documentWithHole();
    const { document: withFace, faceRef } = documentWithFace();
    expect(isMachiningFeature(extrude)).toBe(false);
    expect(isMachiningFeature(buildRevolve(withFace, faceRef))).toBe(false);
    expect(isMachiningFeature(buildSew(withFace, [faceRef, faceRef]))).toBe(false);
    expect(isMachiningFeature(buildBoolean(withHole, 'union', extrude.id, hole.id))).toBe(false);
    expect(isMachiningFeature(hole)).toBe(true);
    expect(isMachiningFeature(buildThreadHole(withHole, extrude.id))).toBe(true);
    expect(isMachiningFeature(buildFillet(withHole, extrude.id))).toBe(true);
    expect(isMachiningFeature(buildChamfer(withHole, extrude.id))).toBe(true);
    expect(isMachiningFeature(buildLinearPattern(withHole, hole.id))).toBe(true);
  });

  it('パターンの対象にできるのは穴とねじ穴だけ(§0.a-0.20)', () => {
    const { document: withHole, extrude, hole } = documentWithHole();
    expect(isPatternSource(hole)).toBe(true);
    expect(isPatternSource(buildThreadHole(withHole, extrude.id))).toBe(true);
    expect(isPatternSource(extrude)).toBe(false);
    expect(isPatternSource(buildFillet(withHole, extrude.id))).toBe(false);
    expect(isPatternSource(buildChamfer(withHole, extrude.id))).toBe(false);
    expect(isPatternSource(buildLinearPattern(withHole, hole.id))).toBe(false);
  });

  it('穴は対象の押し出しを消費し、穴だけが残る', () => {
    const { document, extrude, hole } = documentWithHole();
    expect([...consumedBodyIds(document)]).toEqual([extrude.id]);
    expect(liveBodyIds(document)).toEqual([hole.id]);
  });

  it('穴を並べたパターンは穴を消費し、パターンだけが残る', () => {
    const { document: withHole, hole } = documentWithHole();
    const pattern = buildLinearPattern(withHole, hole.id);
    const document = appendSolid(withHole, pattern);
    expect([...consumedBodyIds(document)].sort()).toEqual(['extrude-1', hole.id].sort());
    expect(liveBodyIds(document)).toEqual(['linearPattern-1']);
  });

  it('R 面取り・C 面取りも対象のボディを消費して自分のボディを作る', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const fillet = buildFillet(afterExtrude, extrude.id);
    const afterFillet = appendSolid(afterExtrude, fillet);
    const chamfer = buildChamfer(afterFillet, fillet.id);
    const document = appendSolid(afterFillet, chamfer);
    expect([...consumedBodyIds(document)].sort()).toEqual([extrude.id, fillet.id].sort());
    expect(liveBodyIds(document)).toEqual([chamfer.id]);
  });

  it('抑制した穴は何も消費せず、もとの押し出しが画面に戻る(FR-503)', () => {
    const { document, extrude, hole } = documentWithHole();
    const suppressed = replaceSolid(document, hole.id, { ...hole, suppressed: true });
    expect(consumedBodyIds(suppressed).size).toBe(0);
    expect(liveBodyIds(suppressed)).toEqual([extrude.id]);
    // 元の文書は変わらない(不変)。
    expect(liveBodyIds(document)).toEqual([hole.id]);
  });

  it('ばねは押し出しと並んで両方が画面に出る(§0.a-0.36)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const spring = buildSpring(afterExtrude);
    const document = appendSolid(afterExtrude, spring);
    expect(consumedBodyIds(document).size).toBe(0);
    expect(liveBodyIds(document)).toEqual([extrude.id, spring.id]);
  });

  it('参照先を取り除いても加工フィーチャーは履歴に残る(解決のときに失敗させる、FR-504)', () => {
    const { document, extrude, hole } = documentWithHole();
    const after = removeSolid(document, extrude.id);
    expect(findSolid(after, hole.id)).toEqual(hole);
    expect(consumedBodyIds(after).size).toBe(0);
    expect(liveBodyIds(after)).toEqual([hole.id]);
  });

  it('履歴で自分より後ろのボディは加工でも消費できない(前方参照は無効)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const later = buildExtrude(afterFirst, faceRef, '4');
    // まだ足していない later を対象にする穴を、later より前に置く。
    const hole = buildHole(afterFirst, later.id);
    const document = appendSolid(appendSolid(afterFirst, hole), later);
    expect(consumedBodyIds(document).size).toBe(0);
    expect(liveBodyIds(document)).toEqual([first.id, hole.id, later.id]);
  });
});

describe('基準ジオメトリの履歴操作(FR-328、FR-329、タスク9)', () => {
  /** 作業平面 1 枚を作る(既定名・既定 id で)。 */
  function planeFeature(id: string, name: string): ReferenceFeature {
    return {
      id,
      kind: 'referencePlane',
      name,
      visible: true,
      plane: {
        kind: 'workPlane',
        planeId: 'xy',
        offset: { source: '10', value: 10, display: '10' },
      },
    };
  }

  it('起動時の部品は基準ジオメトリを持たない(NFR-UX-6)', () => {
    expect(createEmptyPartDocument().references).toEqual([]);
  });

  it('足す・見つける・差し替える・取り除く(元の文書は変えない)', () => {
    const base = createEmptyPartDocument();
    const added = appendReference(base, planeFeature('referencePlane-1', '作業平面1'));
    expect(base.references).toEqual([]);
    expect(added.references).toHaveLength(1);
    expect(findReference(added, 'referencePlane-1')?.name).toBe('作業平面1');

    const renamed = replaceReference(added, 'referencePlane-1', {
      ...planeFeature('referencePlane-1', '天板の面'),
      visible: false,
    });
    expect(findReference(renamed, 'referencePlane-1')?.name).toBe('天板の面');
    expect(findReference(renamed, 'referencePlane-1')?.visible).toBe(false);

    const removed = removeReference(renamed, 'referencePlane-1');
    expect(removed.references).toEqual([]);
    // 見つからない id は元の文書をそのまま返す。
    expect(replaceReference(removed, 'referencePlane-1', planeFeature('referencePlane-1', 'x'))).toBe(
      removed,
    );
    expect(removeReference(removed, 'referencePlane-1')).toBe(removed);
  });

  it('同じ id は足せない(作業平面の id は作図面の id でもあるため)', () => {
    const base = appendReference(createEmptyPartDocument(), planeFeature('referencePlane-1', '作業平面1'));
    expect(appendReference(base, planeFeature('referencePlane-1', '別の名前'))).toBe(base);
  });

  it('種類ごとの連番で id と名前を作る(ソリッドと同じ方式)', () => {
    const base = createEmptyPartDocument();
    expect(nextReferenceId(base, 'referencePlane')).toBe('referencePlane-1');
    expect(nextReferenceName(base, 'referencePlane')).toBe('作業平面1');
    expect(nextReferenceName(base, 'referenceAxis')).toBe('基準軸1');
    expect(nextReferenceName(base, 'referencePoint')).toBe('基準点1');
    expect(nextReferenceName(base, 'referenceCoordinateSystem')).toBe('座標系1');
    const added = appendReference(base, planeFeature('referencePlane-1', '作業平面1'));
    expect(nextReferenceId(added, 'referencePlane')).toBe('referencePlane-2');
    expect(nextReferenceName(added, 'referencePlane')).toBe('作業平面2');
    // 種類が違えば連番は独立する。
    expect(nextReferenceName(added, 'referenceAxis')).toBe('基準軸1');
  });

  it('種類ごとの既定名は 4 種そろっている', () => {
    expect(Object.keys(REFERENCE_LABELS).sort()).toEqual([
      'referenceAxis',
      'referenceCoordinateSystem',
      'referencePlane',
      'referencePoint',
    ]);
  });
});

describe('複数のスケッチ(P4 仕上げ (g)、FR-501、FR-503)', () => {
  it('採番は連番で、途中を消しても残ったものと重ならない', () => {
    const base = createEmptyPartDocument();
    expect(nextSketchId(base)).toBe('sketch-2');
    expect(nextSketchName(base)).toBe('スケッチ2');

    const two = addSketch(base, createSketchFor(base));
    expect(two.sketches.map((sketch) => sketch.id)).toEqual(['sketch-1', 'sketch-2']);
    expect(two.sketches.map((sketch) => sketch.name)).toEqual(['スケッチ1', 'スケッチ2']);
    // 足しただけでは編集中のスケッチは変わらない(切り替えは setActiveSketch)。
    expect(two.activeSketchId).toBe('sketch-1');

    const three = addSketch(two, createSketchFor(two));
    const withoutFirst = removeSketch(three, 'sketch-1');
    expect(nextSketchId(withoutFirst)).toBe('sketch-4');
    expect(nextSketchName(withoutFirst)).toBe('スケッチ4');
  });

  it('編集中のスケッチを消したら残りの先頭へ移る', () => {
    const base = createEmptyPartDocument();
    const two = addSketch(base, createSketchFor(base));
    const active = setActiveSketch(two, 'sketch-2');
    expect(active.activeSketchId).toBe('sketch-2');

    const removed = removeSketch(active, 'sketch-2');
    expect(removed.sketches.map((sketch) => sketch.id)).toEqual(['sketch-1']);
    expect(removed.activeSketchId).toBe('sketch-1');
  });

  it('最後の 1 本は消さない(作図する場所が無くなるため)', () => {
    const base = createEmptyPartDocument();
    expect(removeSketch(base, 'sketch-1')).toBe(base);
    // 見つからない id も元の文書をそのまま返す。
    expect(removeSketch(base, 'sketch-9')).toBe(base);
  });

  it('編集中でないスケッチを消しても編集中はそのまま', () => {
    const base = createEmptyPartDocument();
    const two = addSketch(base, createSketchFor(base));
    const removed = removeSketch(two, 'sketch-2');
    expect(removed.activeSketchId).toBe('sketch-1');
    expect(removed.sketches).toHaveLength(1);
  });
});

describe('基本形状(FR-429、P5 タスク15)', () => {
  /** 5種すべてを1つずつ。並びは `PrimitiveShapeKind` の union と同じ。 */
  const ALL_SHAPE_KINDS: readonly PrimitiveShapeKind[] = [
    'sphere',
    'box',
    'cylinder',
    'cone',
    'torus',
  ];

  it('5種の既定の寸法が計画書 §2.7.1 の表と一致する', () => {
    expect(defaultPrimitiveShape('sphere')).toEqual({
      kind: 'sphere',
      radius: expr(String(DEFAULT_SPHERE_RADIUS_MM)),
    });
    expect(defaultPrimitiveShape('box')).toEqual({
      kind: 'box',
      sizeX: expr(String(DEFAULT_BOX_SIZE_MM)),
      sizeY: expr(String(DEFAULT_BOX_SIZE_MM)),
      sizeZ: expr(String(DEFAULT_BOX_SIZE_MM)),
    });
    expect(defaultPrimitiveShape('cylinder')).toEqual({
      kind: 'cylinder',
      radius: expr(String(DEFAULT_CYLINDER_RADIUS_MM)),
      height: expr(String(DEFAULT_CYLINDER_HEIGHT_MM)),
    });
    expect(defaultPrimitiveShape('cone')).toEqual({
      kind: 'cone',
      bottomRadius: expr(String(DEFAULT_CONE_BOTTOM_RADIUS_MM)),
      topRadius: expr(String(DEFAULT_CONE_TOP_RADIUS_MM)),
      height: expr(String(DEFAULT_CONE_HEIGHT_MM)),
    });
    expect(defaultPrimitiveShape('torus')).toEqual({
      kind: 'torus',
      majorRadius: expr(String(DEFAULT_TORUS_MAJOR_RADIUS_MM)),
      minorRadius: expr(String(DEFAULT_TORUS_MINOR_RADIUS_MM)),
    });
  });

  it('既定の数は 球10 / 箱20 / 円柱10・20 / 円錐10・0・20 / トーラス20・5(§0.a-0.16)', () => {
    expect([
      DEFAULT_SPHERE_RADIUS_MM,
      DEFAULT_BOX_SIZE_MM,
      DEFAULT_CYLINDER_RADIUS_MM,
      DEFAULT_CYLINDER_HEIGHT_MM,
      DEFAULT_CONE_BOTTOM_RADIUS_MM,
      DEFAULT_CONE_TOP_RADIUS_MM,
      DEFAULT_CONE_HEIGHT_MM,
      DEFAULT_TORUS_MAJOR_RADIUS_MM,
      DEFAULT_TORUS_MINOR_RADIUS_MM,
    ]).toEqual([10, 20, 10, 20, 10, 0, 20, 20, 5]);
    // 管の半径は主半径より小さい(同じ以上だと自己交差してカーネルが断る)。
    expect(DEFAULT_TORUS_MINOR_RADIUS_MM).toBeLessThan(DEFAULT_TORUS_MAJOR_RADIUS_MM);
  });

  it('何も選ばずに置くと、原点の絶対座標と Z 軸になる(NFR-UX-4)', () => {
    const origin = defaultPrimitiveOrigin();
    expect(origin.kind).toBe('coordinate');
    if (origin.kind !== 'coordinate') {
      throw new Error('テストの前提が壊れている: 既定の基準点は座標の式');
    }
    expect(origin.value.mode).toBe('absolute');
    const sphere = createPrimitiveFeature(createEmptyPartDocument(), 'sphere');
    expect(sphere.axis).toEqual(DEFAULT_PRIMITIVE_AXIS);
    expect(sphere.axis).toEqual({ kind: 'world', axis: 'z' });
  });

  it('id と名前は形ごとの連番になる(「球1」「箱1」…、§0.a-0.19)', () => {
    const base = createEmptyPartDocument();
    const sphere = createPrimitiveFeature(base, 'sphere');
    expect(sphere.id).toBe('sphere-1');
    expect(sphere.name).toBe('球1');

    const withSphere = appendSolid(base, sphere);
    // 別の形は別の連番。同じ形は続きの番号。
    expect(createPrimitiveFeature(withSphere, 'box').id).toBe('box-1');
    expect(createPrimitiveFeature(withSphere, 'box').name).toBe('箱1');
    expect(createPrimitiveFeature(withSphere, 'sphere').id).toBe('sphere-2');
    expect(createPrimitiveFeature(withSphere, 'sphere').name).toBe('球2');
  });

  it('5種とも kind は primitive で、何も消費せず、加工でもパターンのもとでもない', () => {
    let document = createEmptyPartDocument();
    for (const kind of ALL_SHAPE_KINDS) {
      const feature = createPrimitiveFeature(document, kind);
      expect(feature.kind).toBe('primitive');
      expect(feature.shape.kind).toBe(kind);
      expect(consumedTargetsOf(feature)).toEqual([]);
      expect(isMachiningFeature(feature)).toBe(false);
      expect(isPatternSource(feature)).toBe(false);
      document = appendSolid(document, feature);
    }
    expect(document.solids).toHaveLength(5);
    expect(liveBodyIds(document)).toEqual(['sphere-1', 'box-1', 'cylinder-1', 'cone-1', 'torus-1']);
  });

  it('基準点がスケッチの点でも立体の頂点でも、何も消費しない(§0.a-0.19)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);

    const vertexRef: SubShapeRef = {
      bodyFeatureId: extrude.id,
      index: 0,
      fingerprint: { kind: 'vertex', position: [0, 0, 0] },
    };
    const onVertex = createPrimitiveFeature(document, 'sphere', {
      kind: 'vertex',
      ref: vertexRef,
    });
    const onPoint = createPrimitiveFeature(document, 'box', {
      kind: 'sketchPoint',
      ref: { sketchId: document.activeSketchId, pointFeatureId: 'point-1' },
    });
    expect(consumedTargetsOf(onVertex)).toEqual([]);
    expect(consumedTargetsOf(onPoint)).toEqual([]);

    // 頂点を貸した押し出しは消費されないので、両方が画面に残る(結果は2ボディ)。
    const both = appendSolid(appendSolid(document, onVertex), onPoint);
    expect([...consumedBodyIds(both)]).toEqual([]);
    expect(liveBodyIds(both)).toEqual([extrude.id, onVertex.id, onPoint.id]);
  });

  it('抑制した基本形状はボディを作らない(FR-503)', () => {
    const base = createEmptyPartDocument();
    const sphere = createPrimitiveFeature(base, 'sphere');
    const document = appendSolid(base, { ...sphere, suppressed: true });
    expect(liveBodyIds(document)).toEqual([]);
  });
});

describe('基本形状を足したあとの立体フィーチャーの種類(FR-501)', () => {
  it('板金基板・フランジを含む30種で、数え漏れは型検査で落ちる', () => {
    /*
      `Record<SolidFeatureKind, true>` にしておくと、種類を足したのにこの表を直し忘れた
      ときに**型検査で落ちる**(kernel の `SolidStepSpec` の数え方と同じ手)。
      数は P2 の4種 + P3 の加工5種・ばね + P5 の基本形状1種 + P5 の面をつなぐ・ロフト = 13 に、
      P5 の Should 群 9 種(§2.11、タスク43)を足して 22、さらに Could 群のうち
      タスク46 が前倒しした くり抜き(FR-418、§2.12)を足して 23、
      平面による切断(FR-432、§2.9b、タスク27c)を足して 24、
      読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)を足して 26。
      **この検査は「数え漏れを型で止める」仕掛けなので、種類が増えたら数も一緒に増やす**
      (期待値を緩めているのではなく、仕掛けが働いた結果を写し取っている)。
    */
    const kinds: Readonly<Record<SolidFeatureKind, true>> = {
      sheetBase: true,
      sheetFlange: true,
      sheetBend: true,
      sheetRelief: true,
      extrude: true,
      revolve: true,
      sew: true,
      boolean: true,
      hole: true,
      threadHole: true,
      fillet: true,
      chamfer: true,
      pattern: true,
      spring: true,
      primitive: true,
      ruled: true,
      loft: true,
      draft: true,
      mirror: true,
      transform: true,
      scale: true,
      sweep: true,
      rib: true,
      emboss: true,
      threadShaft: true,
      surface: true,
      shell: true,
      cut: true,
      importedSolid: true,
      importedMesh: true,
    };
    expect(Object.keys(kinds)).toHaveLength(30);
  });

  it(
    'SOLID_FEATURE_KINDS(実行時の一覧、P10板金を含む)は30種を重複なく持ち、' +
      '上のテストで手で数え上げた表(SolidFeatureKind そのものの網羅の確かめ)と同じ集合になる',
    () => {
      expect(SOLID_FEATURE_KINDS).toHaveLength(30);
      expect(new Set(SOLID_FEATURE_KINDS).size).toBe(30);
      const kinds: Readonly<Record<SolidFeatureKind, true>> = {
        sheetBase: true,
        sheetFlange: true,
      sheetBend: true,
      sheetRelief: true,
        extrude: true,
        revolve: true,
        sew: true,
        boolean: true,
        hole: true,
        threadHole: true,
        fillet: true,
        chamfer: true,
        pattern: true,
        spring: true,
        primitive: true,
        ruled: true,
        loft: true,
        draft: true,
        mirror: true,
        transform: true,
        scale: true,
        sweep: true,
        rib: true,
        emboss: true,
        threadShaft: true,
        surface: true,
        shell: true,
        cut: true,
        importedSolid: true,
        importedMesh: true,
      };
      expect(new Set(SOLID_FEATURE_KINDS)).toEqual(new Set(Object.keys(kinds)));
    },
  );

  it('基本形状に基準点と向きを渡すと、そのまま入る', () => {
    const document = createEmptyPartDocument();
    const origin: SolidOrigin = {
      kind: 'coordinate',
      value: absoluteCoordinate(5, 10, 15),
    };
    const axis: AxisSpec = { kind: 'world', axis: 'x' };
    const cylinder = createPrimitiveFeature(document, 'cylinder', origin, axis);
    expect(cylinder.origin).toEqual(origin);
    expect(cylinder.axis).toEqual(axis);
    expect(cylinder.shape).toEqual(defaultPrimitiveShape('cylinder'));
  });

  it('基本形状も履歴の足す・差し替える・取り除くがそのまま効く(FR-503)', () => {
    const base = createEmptyPartDocument();
    const torus = createPrimitiveFeature(base, 'torus');
    const added = appendSolid(base, torus);
    expect(findSolid(added, 'torus-1')?.name).toBe('トーラス1');

    // 同じ id を2度足しても増えない(id はボディの識別子、§0.a-0.5)。
    expect(appendSolid(added, torus)).toBe(added);

    const renamed = replaceSolid(added, torus.id, { ...torus, name: '外周のトーラス' });
    expect(findSolid(renamed, 'torus-1')?.name).toBe('外周のトーラス');

    expect(removeSolid(renamed, 'torus-1').solids).toHaveLength(0);
  });

  it('基本形状はブーリアンの対象になり、消費されると画面から消える(§0.a-0.19)', () => {
    const base = createEmptyPartDocument();
    const sphere = createPrimitiveFeature(base, 'sphere');
    const withSphere = appendSolid(base, sphere);
    const box = createPrimitiveFeature(withSphere, 'box');
    const withBox = appendSolid(withSphere, box);
    const subtract = buildBoolean(withBox, 'subtract', sphere.id, box.id);
    const document = appendSolid(withBox, subtract);

    expect(consumedTargetsOf(subtract)).toEqual([sphere.id, box.id]);
    expect([...consumedBodyIds(document)]).toEqual([sphere.id, box.id]);
    expect(liveBodyIds(document)).toEqual([subtract.id]);
  });
});

describe('面をつなぐ・ロフト(FR-430、FR-410、P5 タスク25)の既定', () => {
  it('ねじれの補正の既定は 0(§0.a-0.28)', () => {
    // 0 なら ThruSections に任せたそのままの対応になる(稜線をずらさない)。
    expect(DEFAULT_RULED_TWIST).toBe(0);
  });

  it('球の点の数は 24 / 48 / 72 の 3 択で、既定はいちばん軽い 24(§0.a-0.74)', () => {
    expect(RULED_SPHERE_SEGMENT_CHOICES).toEqual([24, 48, 72]);
    expect(DEFAULT_RULED_SPHERE_SEGMENTS).toBe(24);
    // 既定は必ず選択肢の中にある(io の妥当性検査と UI の選択肢が同じ表を見るため)。
    expect(RULED_SPHERE_SEGMENT_CHOICES).toContain(DEFAULT_RULED_SPHERE_SEGMENTS);
  });
});

// ---------------------------------------------------------------------------
// P5 の Should 群(FR-401、FR-409、FR-415、FR-417、FR-419〜425、FR-427、FR-428。
// P5 計画書 §2.11、タスク43)。**型と履歴の振る舞いだけ**を確かめる(解決は t45・t46)。
// ---------------------------------------------------------------------------

/** 抜き勾配(FR-417)。上面を中立面にして側面を傾ける。 */
function buildDraft(document: PartDocument, targetFeatureId: string): DraftFeature {
  return {
    id: nextSolidId(document, 'draft'),
    name: nextSolidName(document, 'draft'),
    suppressed: false,
    kind: 'draft',
    targetFeatureId,
    faces: [faceRefOf(targetFeatureId, 1), faceRefOf(targetFeatureId, 2)],
    neutralFace: faceRefOf(targetFeatureId),
    angle: expr(String(DEFAULT_DRAFT_ANGLE_DEGREES)),
    reversed: false,
  };
}

/** ミラー(FR-419)。基準の XY 面に映す。**対象を消費しない。** */
function buildMirror(document: PartDocument, targetFeatureId: string): MirrorFeature {
  return {
    id: nextSolidId(document, 'mirror'),
    name: nextSolidName(document, 'mirror'),
    suppressed: false,
    kind: 'mirror',
    targetFeatureId,
    plane: { kind: 'workPlane', planeId: DEFAULT_MIRROR_PLANE_ID },
  };
}

/** 移動/回転(FR-424)。**対象を消費する。** */
function buildTransform(document: PartDocument, targetFeatureId: string): TransformFeature {
  return {
    id: nextSolidId(document, 'transform'),
    name: nextSolidName(document, 'transform'),
    suppressed: false,
    kind: 'transform',
    targetFeatureId,
    translation: [expr('10'), expr('0'), expr('0')],
    rotationAxis: { kind: 'world', axis: 'z' },
    rotationAngle: expr(String(DEFAULT_TRANSFORM_ROTATION_DEGREES)),
  };
}

/** 拡大縮小(FR-424)。**対象を消費する。** */
function buildScale(document: PartDocument, targetFeatureId: string): ScaleFeature {
  return {
    id: nextSolidId(document, 'scale'),
    name: nextSolidName(document, 'scale'),
    suppressed: false,
    kind: 'scale',
    targetFeatureId,
    origin: { kind: 'origin' },
    factor: { kind: 'uniform', value: expr(String(DEFAULT_SCALE_FACTOR)) },
  };
}

/** スイープ(FR-409)。対象を取らない「作る」種類。 */
function buildSweep(document: PartDocument, profile: SketchFaceRef): SweepFeature {
  return {
    id: nextSolidId(document, 'sweep'),
    name: nextSolidName(document, 'sweep'),
    suppressed: false,
    kind: 'sweep',
    profile,
    path: { sketchId: profile.sketchId, curveIds: ['line-1'] },
    frenet: DEFAULT_SWEEP_FRENET,
  };
}

/** リブ(FR-420)。**対象を消費する。** */
function buildRib(document: PartDocument, targetFeatureId: string): RibFeature {
  return {
    id: nextSolidId(document, 'rib'),
    name: nextSolidName(document, 'rib'),
    suppressed: false,
    kind: 'rib',
    targetFeatureId,
    profile: { sketchId: document.activeSketchId, curveIds: ['line-1'] },
    thickness: expr(String(DEFAULT_RIB_THICKNESS_MM)),
    side: DEFAULT_RIB_SIDE,
    extendToBody: DEFAULT_RIB_EXTEND_TO_BODY,
  };
}

/** エンボス(FR-421)。**対象を消費する。** */
function buildEmboss(
  document: PartDocument,
  targetFeatureId: string,
  profile: SketchFaceRef,
): EmbossFeature {
  return {
    id: nextSolidId(document, 'emboss'),
    name: nextSolidName(document, 'emboss'),
    suppressed: false,
    kind: 'emboss',
    targetFeatureId,
    face: faceRefOf(targetFeatureId),
    profile,
    height: expr(String(DEFAULT_EMBOSS_HEIGHT_MM)),
    raised: DEFAULT_EMBOSS_RAISED,
  };
}

/** 外ねじ(FR-423)。**対象を消費する。** */
function buildThreadShaft(document: PartDocument, targetFeatureId: string): ThreadShaftFeature {
  return {
    id: nextSolidId(document, 'threadShaft'),
    name: nextSolidName(document, 'threadShaft'),
    suppressed: false,
    kind: 'threadShaft',
    targetFeatureId,
    face: faceRefOf(targetFeatureId),
    nominal: DEFAULT_THREAD_DESIGNATION,
    series: 'coarse',
    pitch: expr('1'),
    length: expr(String(DEFAULT_THREAD_SHAFT_LENGTH_MM)),
    fromEnd: DEFAULT_THREAD_SHAFT_FROM_END,
    modeled: DEFAULT_THREAD_SHAFT_MODELED,
  };
}

/** 曲面(FR-428)。作り方は 5 種のいずれか。**どれも対象を消費しない。** */
function buildSurface(document: PartDocument, operation: SurfaceOperation): SurfaceFeature {
  return {
    id: nextSolidId(document, 'surface'),
    name: nextSolidName(document, 'surface'),
    suppressed: false,
    kind: 'surface',
    operation,
  };
}

/** 平らな面 1 枚を張る曲面(いちばん短い作り方。検査の中で何度も使う)。 */
function planarSurfaceOperation(document: PartDocument): SurfaceOperation {
  return { kind: 'planar', profile: { sketchId: document.activeSketchId, curveIds: ['line-1'] } };
}

describe('Should 群の消費・加工・パターンの対象(P5 §2.11、タスク43)', () => {
  it('抜き勾配・移動/回転・拡大縮小・リブ・エンボス・外ねじは対象1つを消費する', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);
    for (const feature of [
      buildDraft(document, extrude.id),
      buildTransform(document, extrude.id),
      buildScale(document, extrude.id),
      buildRib(document, extrude.id),
      buildEmboss(document, extrude.id, faceRef),
      buildThreadShaft(document, extrude.id),
    ]) {
      expect(consumedTargetsOf(feature)).toEqual([extrude.id]);
    }
  });

  it('ミラー・スイープ・曲面は何も消費しない(§0.a-0.36、§0.a-0.45)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);
    // ミラーは対象を**指す**が消費しない。曲面の `face` も面を借りるだけで消費しない。
    expect(consumedTargetsOf(buildMirror(document, extrude.id))).toEqual([]);
    expect(consumedTargetsOf(buildSweep(document, faceRef))).toEqual([]);
    const borrowed = buildSurface(document, {
      kind: 'face',
      targetFeatureId: extrude.id,
      face: faceRefOf(extrude.id),
    });
    expect(consumedTargetsOf(borrowed)).toEqual([]);
  });

  it('加工に数えるのは抜き勾配・リブ・エンボス・外ねじの4種だけ', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);
    expect(isMachiningFeature(buildDraft(document, extrude.id))).toBe(true);
    expect(isMachiningFeature(buildRib(document, extrude.id))).toBe(true);
    expect(isMachiningFeature(buildEmboss(document, extrude.id, faceRef))).toBe(true);
    expect(isMachiningFeature(buildThreadShaft(document, extrude.id))).toBe(true);
    // 移動/回転・拡大縮小は対象を消費するが、形は変えないので加工には数えない。
    expect(isMachiningFeature(buildTransform(document, extrude.id))).toBe(false);
    expect(isMachiningFeature(buildScale(document, extrude.id))).toBe(false);
    expect(isMachiningFeature(buildMirror(document, extrude.id))).toBe(false);
    expect(isMachiningFeature(buildSweep(document, faceRef))).toBe(false);
    expect(isMachiningFeature(buildSurface(document, planarSurfaceOperation(document)))).toBe(
      false,
    );
  });

  it('新しい種類はどれもパターンの対象にならない(§0.a-0.42)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);
    const features: readonly SolidFeature[] = [
      buildDraft(document, extrude.id),
      buildMirror(document, extrude.id),
      buildTransform(document, extrude.id),
      buildScale(document, extrude.id),
      buildSweep(document, faceRef),
      buildRib(document, extrude.id),
      buildEmboss(document, extrude.id, faceRef),
      buildThreadShaft(document, extrude.id),
      buildSurface(document, planarSurfaceOperation(document)),
    ];
    for (const feature of features) {
      expect(isPatternSource(feature)).toBe(false);
    }
  });

  it('ミラーは元と鏡像の両方が画面に残る(§0.a-0.36)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const mirror = buildMirror(afterExtrude, extrude.id);
    const document = appendSolid(afterExtrude, mirror);
    expect([...consumedBodyIds(document)]).toEqual([]);
    expect(liveBodyIds(document)).toEqual([extrude.id, mirror.id]);
  });

  it('移動/回転は元が消えて動かした立体だけが残る(§0.a-0.41)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const moved = buildTransform(afterExtrude, extrude.id);
    const document = appendSolid(afterExtrude, moved);
    expect([...consumedBodyIds(document)]).toEqual([extrude.id]);
    expect(liveBodyIds(document)).toEqual([moved.id]);
  });

  it('id と名前は種類ごとの連番で採る(§0.a-0.19、FR-501)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const document = appendSolid(withFace, extrude);
    expect(buildDraft(document, extrude.id).name).toBe('抜き勾配1');
    expect(buildMirror(document, extrude.id).id).toBe('mirror-1');
    expect(buildThreadShaft(document, extrude.id).name).toBe('外ねじ1');
    expect(nextSolidName(document, 'pointPattern')).toBe('点パターン1');
  });
});

describe('Should 群の既定値と上限(P5 §2.15、§0.a-0.72、タスク43)', () => {
  it('押し出しの省略した欄は既定で埋まり、両側の押し出しは両側のまま読める(FR-415)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    // 版 6 までのファイルの押し出し(足した 5 欄を 1 つも持たない)。
    expect(extrudeShapingOf(extrude)).toEqual({
      end: { kind: 'distance' },
      taperAngle: expr('0'),
      taperOutward: false,
      thickness: null,
      thicknessSide: DEFAULT_THICKNESS_SIDE,
    });
    // `symmetric: true` の古い押し出しは、終端を一律 distance にすると片側へ変わってしまう。
    expect(extrudeShapingOf({ ...extrude, symmetric: true }).end).toEqual({ kind: 'symmetric' });
    // 欄がある文書はその値がそのまま返る(既定で上書きしない)。
    const tapered: ExtrudeFeature = {
      ...extrude,
      end: { kind: 'toNext' },
      taperAngle: expr('5'),
      taperOutward: true,
      thickness: expr('2'),
      thicknessSide: 'both',
    };
    expect(extrudeShapingOf(tapered)).toEqual({
      end: { kind: 'toNext' },
      taperAngle: expr('5'),
      taperOutward: true,
      thickness: expr('2'),
      thicknessSide: 'both',
    });
  });

  it('穴・ねじ穴の入口の既定は「広げない」(FR-422、§0.a-0.39)', () => {
    const { document, extrude } = documentWithHole();
    const hole = buildHole(document, extrude.id);
    const threadHole = buildThreadHole(document, extrude.id);
    expect(holeEntryOf(hole)).toEqual({ kind: 'plain' });
    expect(holeEntryOf(threadHole)).toEqual({ kind: 'plain' });
    expect(DEFAULT_HOLE_ENTRY).toEqual({ kind: 'plain' });
    // ざぐりを入れた穴はその値が返る。
    const counterbored = holeEntryOf({
      ...hole,
      entry: { kind: 'counterbore', diameter: expr('11'), depth: expr('4') },
    });
    expect(counterbored.kind).toBe('counterbore');
  });

  it('抜き勾配の上限は 60 度で、既定はその範囲に入る(§0.a-0.72)', () => {
    // 計画書タスク43 の手順5 は 89 だったが、統括の決定 §0.a-0.72 が 60 に狭めた。
    expect(MAX_DRAFT_ANGLE_DEGREES).toBe(60);
    expect(DEFAULT_DRAFT_ANGLE_DEGREES).toBeGreaterThan(0);
    expect(DEFAULT_DRAFT_ANGLE_DEGREES).toBeLessThanOrEqual(MAX_DRAFT_ANGLE_DEGREES);
  });

  it('押し出しの傾きの上限は抜き勾配と同じ 60 度で、既定 0 は範囲内(FR-401)', () => {
    expect(MAX_TAPER_ANGLE_DEGREES).toBe(MAX_DRAFT_ANGLE_DEGREES);
    expect(DEFAULT_TAPER_ANGLE_DEGREES).toBe(0);
    expect(DEFAULT_TAPER_ANGLE_DEGREES).toBeLessThanOrEqual(MAX_TAPER_ANGLE_DEGREES);
  });

  it('拡大縮小の倍率は 0.001〜1000 で、既定はその範囲に入る(FR-424)', () => {
    expect(MIN_SCALE).toBe(0.001);
    expect(MAX_SCALE).toBe(1000);
    expect(DEFAULT_SCALE_FACTOR).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(DEFAULT_SCALE_FACTOR).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('寸法の既定はどれも 0 より大きい(NFR-UX-4「押しただけで意味のある形」)', () => {
    for (const value of [
      DEFAULT_COUNTERBORE_DIAMETER_MM,
      DEFAULT_COUNTERBORE_DEPTH_MM,
      DEFAULT_COUNTERSINK_DIAMETER_MM,
      DEFAULT_COUNTERSINK_ANGLE_DEGREES,
      DEFAULT_RIB_THICKNESS_MM,
      DEFAULT_EMBOSS_HEIGHT_MM,
      DEFAULT_THREAD_SHAFT_LENGTH_MM,
      DEFAULT_EXTRUDE_THICKNESS_MM,
      DEFAULT_SURFACE_DISTANCE_MM,
      DEFAULT_SURFACE_ANGLE_DEGREES,
    ]) {
      expect(value).toBeGreaterThan(0);
    }
    // ざぐり・皿もみの径は穴の径より大きくないと入口が広がらない。
    expect(DEFAULT_COUNTERBORE_DIAMETER_MM).toBeGreaterThan(DEFAULT_HOLE_DIAMETER_MM);
    expect(DEFAULT_COUNTERSINK_DIAMETER_MM).toBeGreaterThan(DEFAULT_HOLE_DIAMETER_MM);
    // 皿もみの開き角は 180 度より小さい(でないと円錐にならない)。
    expect(DEFAULT_COUNTERSINK_ANGLE_DEGREES).toBeLessThan(180);
    // 曲面の回転は 360 度以下。
    expect(DEFAULT_SURFACE_ANGLE_DEGREES).toBeLessThanOrEqual(360);
  });

  it('つまみの既定は「作ったときにいちばん驚かない」側(§2.15 の段の表)', () => {
    expect(DEFAULT_EXTRUDE_END).toEqual({ kind: 'distance' });
    expect(DEFAULT_THICKNESS_SIDE).toBe('inner');
    expect(DEFAULT_RIB_SIDE).toBe('both');
    expect(DEFAULT_RIB_EXTEND_TO_BODY).toBe(true);
    // 彫る(false)が既定。浮き出すのはつまみを入れたとき。
    expect(DEFAULT_EMBOSS_RAISED).toBe(false);
    // 実らせんは 1 本で数秒かかるので、既定は簡略表示(§0.a-0.15)。
    expect(DEFAULT_THREAD_SHAFT_MODELED).toBe(false);
    expect(DEFAULT_THREAD_SHAFT_FROM_END).toBe('first');
    expect(DEFAULT_SWEEP_FRENET).toBe(false);
    expect(DEFAULT_TRANSFORM_ROTATION_DEGREES).toBe(0);
    expect(DEFAULT_TRANSLATION_MM).toBe(0);
    // 鏡の既定は基準の 3 面のうち XY。
    expect(DEFAULT_MIRROR_PLANE_ID).toBe('xy');
  });
});

describe('点の集まりへ複製(FR-425、§0.a-0.42、タスク43)', () => {
  it('点集合パターンは対象の穴を消費し、パターンの対象にはならない', () => {
    const { document, hole } = documentWithHole();
    const pattern: PatternFeature = {
      id: nextSolidId(document, 'pointPattern'),
      name: nextSolidName(document, 'pointPattern'),
      suppressed: false,
      kind: 'pattern',
      sourceFeatureId: hole.id,
      placement: {
        kind: 'points',
        points: [
          { kind: 'point', pointId: 'point-1' },
          { kind: 'point', pointId: 'point-2' },
        ],
      },
    };
    expect(consumedTargetsOf(pattern)).toEqual([hole.id]);
    // パターンそのものは工具ではないので、もとにはできない(§0.a-0.20)。
    expect(isPatternSource(pattern)).toBe(false);
    expect(isMachiningFeature(pattern)).toBe(true);
    expect(liveBodyIds(appendSolid(document, pattern))).toEqual([pattern.id]);
  });
});

describe('平面による切断の消費と名前(FR-432、§0.a-0.58、P5 タスク27c)', () => {
  const PLANE: PlaneSpec = {
    kind: 'workPlane',
    planeId: 'xy',
    offset: expressionValueFromNumber(5),
  };

  function cut(id: string, targetFeatureId: string, pairedWith: string | null = null): CutFeature {
    return {
      id,
      name: id,
      suppressed: false,
      kind: 'cut',
      targetFeatureId,
      plane: PLANE,
      keep: pairedWith === null ? DEFAULT_CUT_KEEP : 'negative',
      pairedWith,
    };
  }

  it('切断は対象1つを消費する加工で、パターンの対象にはできない', () => {
    const feature = cut('cut-1', 'extrude-1');
    expect(consumedTargetsOf(feature)).toEqual(['extrude-1']);
    expect(isMachiningFeature(feature)).toBe(true);
    expect(isPatternSource(feature)).toBe(false);
  });

  it('残す側の既定は法線の側(§0.a-0.57)', () => {
    expect(DEFAULT_CUT_KEEP).toBe('positive');
  });

  it('対になった 2 つの切断は対象を 1 度だけ数え、2 つとも画面に残る(§0.a-0.58)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const first = appendSolid(afterExtrude, cut('cut-1', extrude.id));
    const document = appendSolid(first, cut('cut-2', extrude.id, 'cut-1'));
    expect([...consumedBodyIds(document)]).toEqual([extrude.id]);
    expect(liveBodyIds(document)).toEqual(['cut-1', 'cut-2']);
  });

  it('対の片方を抑制すると、残ったほうだけが対象を消費する(FR-503)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    const first = appendSolid(afterExtrude, cut('cut-1', extrude.id));
    const both = appendSolid(first, cut('cut-2', extrude.id, 'cut-1'));
    const document = replaceSolid(both, 'cut-2', {
      ...cut('cut-2', extrude.id, 'cut-1'),
      suppressed: true,
    });
    expect([...consumedBodyIds(document)]).toEqual([extrude.id]);
    expect(liveBodyIds(document)).toEqual(['cut-1']);
  });

  it('切断の名前と id は種類ごとの連番になる(「切断1」「切断2」)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    const afterExtrude = appendSolid(withFace, extrude);
    expect(nextSolidName(afterExtrude, 'cut')).toBe('切断1');
    expect(nextSolidId(afterExtrude, 'cut')).toBe('cut-1');
    const document = appendSolid(afterExtrude, {
      ...cut('cut-1', extrude.id),
      name: '切断1',
    });
    expect(nextSolidName(document, 'cut')).toBe('切断2');
    expect(nextSolidId(document, 'cut')).toBe('cut-2');
  });
});
