import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
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
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM,
  DEFAULT_SEW_TOLERANCE_MM,
  DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM,
  DEFAULT_SPRING_TURNS,
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
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
  nextSolidId,
  nextSolidName,
  PART_SCHEMA_VERSION,
  REFERENCE_LABELS,
  removeReference,
  removeSolid,
  replaceReference,
  replaceSketch,
  replaceSolid,
  setActiveSketch,
  SOLID_LABELS,
} from './createPartDocument.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ChamferFeature,
  ExtrudeFeature,
  FilletFeature,
  HoleFeature,
  PartDocument,
  PatternFeature,
  ReferenceFeature,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SketchPointRef,
  SolidFeature,
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

  it('保存形式の版は 3(§0.a-0.3、§0.a-0.22)', () => {
    expect(PART_SCHEMA_VERSION).toBe(3);
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
  it('種類ごとの既定名は13個(既存6 + 加工6 + ばね1)', () => {
    expect(Object.keys(SOLID_LABELS)).toHaveLength(13);
    expect(SOLID_LABELS.hole).toBe('穴');
    expect(SOLID_LABELS.threadHole).toBe('ねじ穴');
    expect(SOLID_LABELS.spring).toBe('ばね');
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
