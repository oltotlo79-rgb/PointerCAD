/**
 * 立体の要約と書き戻し(計画書 docs/plans/P2-ソリッド基礎.md タスク22 手順2)。
 *
 * ツリーとプロパティが表に出す形を、DOM を使わずにここで固定する(§0.a-0.8)。
 * `as` による強制変換を1つも使わずに書けることも、この検査で担保する。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  replaceSketch,
  type BooleanFeature,
  type ChamferFeature,
  type ExtrudeFeature,
  type FilletFeature,
  type HoleFeature,
  type PartDocument,
  type PartRecomputeError,
  type PatternFeature,
  type ReferenceFeature,
  type RevolveFeature,
  type SewFeature,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchPointFeature,
  type SolidFeature,
  type SpringFeature,
  type SubShapeRef,
  type ThreadHoleFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  buildReferenceSection,
  buildSketchGroups,
  buildTreeSections,
  formatVolume,
  missingValueKey,
  partErrorMessage,
  renameReference,
  renameSketch,
  renameSolid,
  selectionKindLabelKeys,
  setReferenceField,
  setReferenceVisible,
  setSolidAxis,
  setSolidChoice,
  setSolidDepthKind,
  setSolidField,
  setSolidSuppressed,
  setSolidToggle,
  SOLID_KIND_LABEL_KEYS,
  solidForSelection,
  solidKindOf,
  summarizeReference,
  summarizeSolid,
  WORLD_AXIS_CHOICES,
} from './solidSummary.js';

const FACE: SketchFaceFeature = {
  id: 'face-1',
  name: '面1',
  planeId: 'xy',
  kind: 'face',
  boundary: [{ featureId: 'line-1' }, { featureId: 'line-2' }, { featureId: 'line-3' }],
  color: '#7aa2f7',
};

const OTHER_FACE: SketchFaceFeature = { ...FACE, id: 'face-2', name: '面2' };

const AXIS_LINE: SketchLineFeature = {
  id: 'line-9',
  name: '線分9',
  planeId: 'xy',
  kind: 'line',
  from: {
    mode: 'absolute',
    x: expressionValueFromNumber(0),
    y: expressionValueFromNumber(0),
    z: expressionValueFromNumber(0),
  },
  to: {
    mode: 'absolute',
    x: expressionValueFromNumber(0),
    y: expressionValueFromNumber(10),
    z: expressionValueFromNumber(0),
  },
  construction: false,
};

const EXTRUDE: ExtrudeFeature = {
  id: 'extrude-1',
  name: '押し出し1',
  suppressed: false,
  kind: 'extrude',
  profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
  distance: expressionValueFromNumber(10),
  reversed: false,
  symmetric: false,
};

const REVOLVE: RevolveFeature = {
  id: 'revolve-1',
  name: '回転1',
  suppressed: false,
  kind: 'revolve',
  profile: { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
  axis: { kind: 'world', axis: 'z' },
  angle: expressionValueFromNumber(360),
  reversed: false,
};

const SEW: SewFeature = {
  id: 'sew-1',
  name: '縫合1',
  suppressed: false,
  kind: 'sew',
  faces: [
    { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
  ],
  tolerance: expressionValueFromNumber(0.01),
};

const SUBTRACT: BooleanFeature = {
  id: 'subtract-1',
  name: '差1',
  suppressed: false,
  kind: 'boolean',
  operation: 'subtract',
  targetFeatureId: 'extrude-1',
  toolFeatureId: 'revolve-1',
};

/** 「押し出し1」(extrude-1)の面・辺への参照(P3 タスク27、指紋の中身は判定に使わない値)。 */
function faceRef(index: number): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 100,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function edgeRef(index: number): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 10,
      position: [0, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

const HOLE_BLIND: HoleFeature = {
  id: 'hole-1',
  name: '穴1',
  suppressed: false,
  kind: 'hole',
  targetFeatureId: 'extrude-1',
  face: faceRef(0),
  centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
  diameter: expressionValueFromNumber(6),
  depth: { kind: 'blind', depth: expressionValueFromNumber(10) },
  tiltAngle: expressionValueFromNumber(0),
  tiltAzimuth: expressionValueFromNumber(0),
};

const HOLE_THROUGH: HoleFeature = {
  ...HOLE_BLIND,
  id: 'hole-2',
  name: '穴2',
  depth: { kind: 'through' },
};

const THREAD_HOLE: ThreadHoleFeature = {
  id: 'threadHole-1',
  name: 'ねじ穴1',
  suppressed: false,
  kind: 'threadHole',
  targetFeatureId: 'extrude-1',
  face: faceRef(0),
  centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
  designation: 'M6',
  series: 'coarse',
  pitch: expressionValueFromNumber(1),
  drillDiameter: expressionValueFromNumber(4.917468),
  depth: { kind: 'through' },
  threadLength: expressionValueFromNumber(10),
  representation: 'simplified',
  tiltAngle: expressionValueFromNumber(0),
  tiltAzimuth: expressionValueFromNumber(0),
};

const FILLET: FilletFeature = {
  id: 'fillet-1',
  name: 'R面取り1',
  suppressed: false,
  kind: 'fillet',
  targetFeatureId: 'extrude-1',
  targets: [edgeRef(0), edgeRef(1), edgeRef(2), edgeRef(3)],
  radius: expressionValueFromNumber(2),
};

const CHAMFER_EQUAL: ChamferFeature = {
  id: 'chamfer-1',
  name: 'C面取り1',
  suppressed: false,
  kind: 'chamfer',
  targetFeatureId: 'extrude-1',
  targets: [edgeRef(0)],
  size: { kind: 'equal', distance: expressionValueFromNumber(1) },
  swapReferenceFace: false,
};

const CHAMFER_TWO: ChamferFeature = {
  ...CHAMFER_EQUAL,
  id: 'chamfer-2',
  name: 'C面取り2',
  size: {
    kind: 'twoDistances',
    distance1: expressionValueFromNumber(1),
    distance2: expressionValueFromNumber(2),
  },
  swapReferenceFace: true,
};

const CHAMFER_ANGLE: ChamferFeature = {
  ...CHAMFER_EQUAL,
  id: 'chamfer-3',
  name: 'C面取り3',
  size: { kind: 'distanceAngle', distance: expressionValueFromNumber(1), angle: expressionValueFromNumber(45) },
};

const LINEAR_PATTERN: PatternFeature = {
  id: 'linearPattern-1',
  name: '直線パターン1',
  suppressed: false,
  kind: 'pattern',
  sourceFeatureId: 'hole-1',
  placement: {
    kind: 'linear',
    direction: { kind: 'world', axis: 'x' },
    spacing: expressionValueFromNumber(20),
    count: expressionValueFromNumber(3),
    symmetric: false,
  },
};

const CIRCULAR_PATTERN: PatternFeature = {
  id: 'circularPattern-1',
  name: '円形パターン1',
  suppressed: false,
  kind: 'pattern',
  sourceFeatureId: 'hole-1',
  placement: {
    kind: 'circular',
    axis: { kind: 'world', axis: 'z' },
    angle: expressionValueFromNumber(360),
    count: expressionValueFromNumber(4),
    fullCircle: true,
  },
};

const CIRCULAR_PATTERN_PARTIAL: PatternFeature = {
  ...CIRCULAR_PATTERN,
  id: 'circularPattern-2',
  name: '円形パターン2',
  placement: {
    kind: 'circular',
    axis: { kind: 'world', axis: 'z' },
    angle: expressionValueFromNumber(180),
    count: expressionValueFromNumber(3),
    fullCircle: false,
  },
};

/** 面 2 枚と軸に使う線分 1 本を持つ部品に、渡された立体を並べたもの。 */
function documentWith(...solids: readonly SolidFeature[]): PartDocument {
  const empty = createEmptyPartDocument();
  const sketch = appendFeature(
    appendFeature(appendFeature(empty.sketches[0], FACE), OTHER_FACE),
    AXIS_LINE,
  );
  return solids.reduce<PartDocument>(
    (document, solid) => appendSolid(document, solid),
    replaceSketch(empty, sketch),
  );
}

/** ばねの始点にする点(P3 タスク29b、§0.a-0.29)。原点 (0,0,0)。 */
const SPRING_ORIGIN_POINT: SketchPointFeature = {
  id: 'point-1',
  name: '点1',
  planeId: 'xy',
  kind: 'point',
  at: {
    mode: 'absolute',
    x: expressionValueFromNumber(0),
    y: expressionValueFromNumber(0),
    z: expressionValueFromNumber(0),
  },
};

/**
 * `documentWith` に、ばねの始点にする点(point-1)も加えたもの。既存の多くの検査が
 * `documentWith` のスケッチ行数(面2枚+線分1本)をそのまま数えているため、
 * 点を足すのはばね専用のこの関数に限る(既存の検査を1つも変えない)。
 */
function documentWithSpringPoint(...solids: readonly SolidFeature[]): PartDocument {
  const base = documentWith(...solids);
  const sketch = appendFeature(base.sketches[0], SPRING_ORIGIN_POINT);
  return replaceSketch(base, sketch);
}

/** ばね(FR-414、§0.a-0.29〜0.36)。既定値(§0.a-0.30)。derived は 'length'。 */
const SPRING: SpringFeature = {
  id: 'spring-1',
  name: 'ばね1',
  suppressed: false,
  kind: 'spring',
  origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
  axis: { kind: 'world', axis: 'z' },
  tiltAngle: expressionValueFromNumber(0),
  tiltAzimuth: expressionValueFromNumber(0),
  length: expressionValueFromNumber(20),
  pitch: expressionValueFromNumber(5),
  turns: expressionValueFromNumber(4),
  derived: 'length',
  coilDiameter: expressionValueFromNumber(20),
  wireDiameter: expressionValueFromNumber(2),
  handedness: 'right',
};

describe('summarizeSolid(FR-501、FR-502)', () => {
  it('押し出しは距離 1 欄・つまみ 2 つ・もとの面の名前を返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE), EXTRUDE);
    expect(summary.featureId).toBe('extrude-1');
    expect(summary.name).toBe('押し出し1');
    expect(summary.kindLabelKey).toBe('toolbar.solid.extrude');
    expect(summary.fields.map((field) => field.key)).toEqual(['distance']);
    expect(summary.fields[0].value.display).toBe('10');
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['reversed', 'symmetric']);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.profile', name: 'スケッチ1 / 面1', elementId: 'face-1' },
    ]);
    expect(summary.axis).toBeNull();
  });

  it('回転は角度の欄と回転軸を返す', () => {
    const summary = summarizeSolid(documentWith(REVOLVE), REVOLVE);
    expect(summary.fields.map((field) => field.key)).toEqual(['angle']);
    expect(summary.fields[0].unit).toBe('degree');
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['reversed']);
    expect(summary.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(summary.references[0].name).toBe('スケッチ1 / 面2');
  });

  it('線分を軸にした回転は、線分の名前を読み取り専用で返す', () => {
    const feature: RevolveFeature = {
      ...REVOLVE,
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-9' } },
    };
    expect(summarizeSolid(documentWith(feature), feature).axis).toEqual({
      kind: 'line',
      name: '線分9',
      elementId: 'line-9',
    });
  });

  it('縫合は許容量の欄とつないだ面の数だけの参照を返す', () => {
    const summary = summarizeSolid(documentWith(SEW), SEW);
    expect(summary.fields.map((field) => field.key)).toEqual(['tolerance']);
    expect(summary.toggles).toEqual([]);
    expect(summary.references.map((reference) => reference.name)).toEqual([
      'スケッチ1 / 面1',
      'スケッチ1 / 面2',
    ]);
  });

  it('ブーリアンは欄を持たず、2 つの立体の名前を返す(種類は演算の名前)', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, REVOLVE, SUBTRACT), SUBTRACT);
    expect(summary.fields).toEqual([]);
    expect(summary.toggles).toEqual([]);
    expect(summary.kindLabelKey).toBe('toolbar.solid.subtract');
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.target', name: '押し出し1', elementId: 'extrude-1' },
      { labelKey: 'propertyPanel.tool', name: '回転1', elementId: 'revolve-1' },
    ]);
  });

  it('参照先が消えていても止めず、id を出して選べないことを示す(FR-504)', () => {
    const orphan: BooleanFeature = { ...SUBTRACT, toolFeatureId: 'sew-9' };
    const summary = summarizeSolid(documentWith(EXTRUDE, orphan), orphan);
    expect(summary.references[1]).toEqual({
      labelKey: 'propertyPanel.tool',
      name: 'sew-9',
      elementId: null,
    });
  });

  it('もとの面が消えていても止めず、面の id を出す(FR-504)', () => {
    const empty = createEmptyPartDocument();
    const summary = summarizeSolid(appendSolid(empty, EXTRUDE), EXTRUDE);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.profile', name: 'face-1', elementId: null },
    ]);
  });

  it('ブーリアンに消費された立体は consumed になる(§0.a-0.5)', () => {
    const document = documentWith(EXTRUDE, REVOLVE, SUBTRACT);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(true);
    expect(summarizeSolid(document, SUBTRACT).consumed).toBe(false);
  });

  it('失敗したブーリアンは何も取り込まない(画面に出ているのに統合済みと出さない)', () => {
    const document = documentWith(EXTRUDE, REVOLVE, SUBTRACT);
    const errors: readonly PartRecomputeError[] = [
      { featureId: 'subtract-1', code: 'missingBody', message: 'もとの立体が見つかりません' },
    ];
    expect(summarizeSolid(document, EXTRUDE, errors).consumed).toBe(false);
    expect(summarizeSolid(document, REVOLVE, errors).consumed).toBe(false);
  });

  it('抑制した立体は suppressed になる(FR-503)', () => {
    const suppressed = setSolidSuppressed(EXTRUDE, true);
    expect(summarizeSolid(documentWith(suppressed), suppressed).suppressed).toBe(true);
  });
});

describe('書き戻し(FR-311、元のフィーチャーを変えない)', () => {
  it('setSolidField は対象の欄だけを変え、式そのものを保つ(FR-202)', () => {
    const next = setSolidField(EXTRUDE, 'distance', {
      source: '5*2',
      value: 10,
      display: '10',
    });
    expect(next).not.toBe(EXTRUDE);
    expect(next.kind === 'extrude' ? next.distance.source : null).toBe('5*2');
    expect(EXTRUDE.distance.source).toBe('10');
  });

  it('setSolidField は持たない欄なら同じものを返す', () => {
    expect(setSolidField(EXTRUDE, 'angle', expressionValueFromNumber(90))).toBe(EXTRUDE);
    expect(setSolidField(SUBTRACT, 'distance', expressionValueFromNumber(1))).toBe(SUBTRACT);
  });

  it('setSolidToggle を 2 回で元へ戻る', () => {
    const once = setSolidToggle(EXTRUDE, 'symmetric', true);
    const twice = setSolidToggle(once, 'symmetric', false);
    expect(once.kind === 'extrude' ? once.symmetric : null).toBe(true);
    expect(twice).toEqual(EXTRUDE);
    expect(EXTRUDE.symmetric).toBe(false);
  });

  it('setSolidToggle は持たないつまみなら同じものを返す', () => {
    expect(setSolidToggle(REVOLVE, 'symmetric', true)).toBe(REVOLVE);
    expect(setSolidToggle(SEW, 'reversed', true)).toBe(SEW);
  });

  it('setSolidAxis は回転の軸だけを変える(§0.a-0.9)', () => {
    const next = setSolidAxis(REVOLVE, 'x');
    expect(next.kind === 'revolve' ? next.axis : null).toEqual({ kind: 'world', axis: 'x' });
    expect(REVOLVE.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(setSolidAxis(EXTRUDE, 'x')).toBe(EXTRUDE);
  });

  it('setSolidSuppressed は値が同じなら同じものを返す(FR-503)', () => {
    expect(setSolidSuppressed(EXTRUDE, false)).toBe(EXTRUDE);
    expect(setSolidSuppressed(EXTRUDE, true).suppressed).toBe(true);
    expect(EXTRUDE.suppressed).toBe(false);
  });

  it('renameSolid は前後の空白を落とし、空の名前は受け付けない(FR-503)', () => {
    expect(renameSolid(EXTRUDE, '  台座  ').name).toBe('台座');
    expect(renameSolid(EXTRUDE, '   ')).toBe(EXTRUDE);
    expect(renameSolid(EXTRUDE, '押し出し1')).toBe(EXTRUDE);
  });
});

describe('選択とプロパティの橋渡し', () => {
  it('solidForSelection は立体を選んでいるときだけ返す', () => {
    const document = documentWith(EXTRUDE);
    expect(solidForSelection(document, ['extrude-1'])?.name).toBe('押し出し1');
    expect(solidForSelection(document, ['face-1'])).toBeNull();
    expect(solidForSelection(document, [])).toBeNull();
  });

  it('selectionKindLabelKeys はスケッチと立体をまぜても種類を重複なく返す', () => {
    const document = documentWith(EXTRUDE, REVOLVE);
    expect(
      selectionKindLabelKeys(document, ['face-1', 'face-2', 'extrude-1', 'revolve-1', 'unknown']),
    ).toEqual([
      'toolbar.tool.face',
      'toolbar.solid.extrude',
      'toolbar.solid.revolve',
    ]);
  });

  it('solidKindOf はブーリアンを演算ごとに分ける(名前の連番と同じ粒度)', () => {
    expect(solidKindOf(EXTRUDE)).toBe('extrude');
    expect(solidKindOf(SUBTRACT)).toBe('subtract');
    expect(SOLID_KIND_LABEL_KEYS[solidKindOf(SUBTRACT)]).toBe('toolbar.solid.subtract');
  });

  it('missingValueKey は抑制・統合・失敗で違う理由を返す(NFR-UX-5)', () => {
    const document = documentWith(EXTRUDE, REVOLVE, SUBTRACT);
    const suppressed = setSolidSuppressed(EXTRUDE, true);
    expect(missingValueKey(summarizeSolid(documentWith(suppressed), suppressed))).toBe(
      'featureTree.suppressed',
    );
    expect(missingValueKey(summarizeSolid(document, EXTRUDE))).toBe('featureTree.consumed');
    expect(missingValueKey(summarizeSolid(document, SUBTRACT))).toBe('propertyPanel.notComputed');
  });

  it('partErrorMessage はその id の理由だけを返す(FR-504)', () => {
    const errors: readonly PartRecomputeError[] = [
      { featureId: 'extrude-1', code: 'invalidValue', message: '厚みが出ませんでした' },
    ];
    expect(partErrorMessage(errors, 'extrude-1')).toBe('厚みが出ませんでした');
    expect(partErrorMessage(errors, 'revolve-1')).toBeNull();
  });

  it('formatVolume は指数表記にしない', () => {
    expect(formatVolume(6000)).toBe('6000');
    expect(formatVolume(0.5)).toBe('0.5');
  });

  it('回転軸の選択肢は X / Y / Z の 3 つ', () => {
    expect(WORLD_AXIS_CHOICES.map((choice) => choice.axis)).toEqual(['x', 'y', 'z']);
  });
});

describe('buildTreeSections(FR-501、FR-503、FR-504)', () => {
  it('スケッチの節とソリッドの節の 2 つを返す', () => {
    const sections = buildTreeSections(documentWith(EXTRUDE), 'sketch-1', [], []);
    expect(sections.map((section) => section.key)).toEqual(['sketch', 'solid']);
    expect(sections.map((section) => section.titleKey)).toEqual([
      'featureTree.sketchGroup',
      'featureTree.solidGroup',
    ]);
    expect(sections[0].rows.map((row) => row.name)).toEqual(['面1', '面2', '線分9']);
    expect(sections[1].rows.map((row) => row.name)).toEqual(['押し出し1']);
  });

  it('立体が無くても節は 2 つ返し、行だけが空になる(NFR-UX-6)', () => {
    const sections = buildTreeSections(createEmptyPartDocument(), 'sketch-1', [], []);
    expect(sections).toHaveLength(2);
    expect(sections[0].rows).toEqual([]);
    expect(sections[1].rows).toEqual([]);
  });

  it('行の種類は絵と名前を決める粒度で入る(ブーリアンは演算ごと)', () => {
    const sections = buildTreeSections(documentWith(EXTRUDE, REVOLVE, SUBTRACT), 'sketch-1', [], []);
    expect(sections[1].rows.map((row) => row.kind)).toEqual(['extrude', 'revolve', 'subtract']);
    expect(sections[0].rows.map((row) => row.kind)).toEqual(['face', 'face', 'line']);
  });

  it('失敗している行だけに理由が付く(FR-504)', () => {
    const sections = buildTreeSections(
      documentWith(EXTRUDE, REVOLVE),
      'sketch-1',
      [{ featureId: 'face-1', code: 'invalidValue', message: '式が読めません' }],
      [{ featureId: 'revolve-1', code: 'invalidValue', message: '回しても厚みが出ませんでした' }],
    );
    expect(sections[0].rows.map((row) => row.hasError)).toEqual([true, false, false]);
    expect(sections[0].rows[0].errorMessage).toBe('式が読めません');
    expect(sections[1].rows.map((row) => row.hasError)).toEqual([false, true]);
    expect(sections[1].rows[1].errorMessage).toBe('回しても厚みが出ませんでした');
  });

  it('抑制した行と消費された行に印が付く(FR-503、§0.a-0.5)', () => {
    const suppressed = setSolidSuppressed(REVOLVE, true);
    const sections = buildTreeSections(
      documentWith(EXTRUDE, suppressed, SUBTRACT),
      'sketch-1',
      [],
      [],
    );
    expect(sections[1].rows.map((row) => row.suppressed)).toEqual([false, true, false]);
    // 抑制中の回転は消費されない。押し出しだけが差に取り込まれる。
    expect(sections[1].rows.map((row) => row.consumed)).toEqual([true, false, false]);
  });

  it('ブーリアンが失敗した行では、取り込まれた印を出さない(FR-504)', () => {
    const sections = buildTreeSections(
      documentWith(EXTRUDE, REVOLVE, SUBTRACT),
      'sketch-1',
      [],
      [{ featureId: 'subtract-1', code: 'missingBody', message: '組み合わせる立体がありません' }],
    );
    expect(sections[1].rows.map((row) => row.consumed)).toEqual([false, false, false]);
    expect(sections[1].rows.map((row) => row.hasError)).toEqual([false, false, true]);
  });

  it('編集中のスケッチが見つからないときは先頭のスケッチを並べる', () => {
    const sections = buildTreeSections(documentWith(EXTRUDE), 'sketch-9', [], []);
    expect(sections[0].rows.map((row) => row.name)).toEqual(['面1', '面2', '線分9']);
  });

  it('穴の行はソリッド節に並び、種類名は道具名を指す(featureTree.unsupportedKind の暫定を解消、§0.a-0.23)', () => {
    const sections = buildTreeSections(documentWith(EXTRUDE, HOLE_BLIND), 'sketch-1', [], []);
    const holeRow = sections[1].rows.find((row) => row.id === 'hole-1');
    expect(holeRow?.kind).toBe('hole');
    expect(holeRow?.kindLabelKey).toBe('toolbar.machining.hole');
  });

  it('パターンに消費された穴は「統合済み」になる(§0.a-0.20)', () => {
    const sections = buildTreeSections(
      documentWith(EXTRUDE, HOLE_BLIND, LINEAR_PATTERN),
      'sketch-1',
      [],
      [],
    );
    const holeRow = sections[1].rows.find((row) => row.id === 'hole-1');
    expect(holeRow?.consumed).toBe(true);
  });

  it('missingSubShape で失敗した加工フィーチャーは、その行だけ hasError になる(§0.a-0.5)', () => {
    const sections = buildTreeSections(
      documentWith(EXTRUDE, FILLET),
      'sketch-1',
      [],
      [{ featureId: 'fillet-1', code: 'missingSubShape', message: '丸める辺が選ばれていません。' }],
    );
    const filletRow = sections[1].rows.find((row) => row.id === 'fillet-1');
    expect(filletRow?.hasError).toBe(true);
    expect(filletRow?.errorMessage).toBe('丸める辺が選ばれていません。');
    const extrudeRow = sections[1].rows.find((row) => row.id === 'extrude-1');
    expect(extrudeRow?.hasError).toBe(false);
  });

  it('ばねの行はソリッド節に並び、「統合済み」にならない(§0.a-0.36、タスク29b)', () => {
    const sections = buildTreeSections(documentWithSpringPoint(SPRING), 'sketch-1', [], []);
    const springRow = sections[1].rows.find((row) => row.id === 'spring-1');
    expect(springRow?.kind).toBe('spring');
    expect(springRow?.kindLabelKey).toBe('toolbar.solid.spring');
    expect(springRow?.consumed).toBe(false);
  });
});

describe('summarizeSolid(加工6種、計画書 docs/plans/P3-加工フィーチャー.md タスク27)', () => {
  it('穴(止まり)は直径・深さ・傾き・傾ける向きの欄、深さの種類の選択肢、選んだ面・中心の点の数を返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, HOLE_BLIND), HOLE_BLIND);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'diameter',
      'depth',
      'tiltAngle',
      'tiltAzimuth',
    ]);
    expect(summary.choices).toEqual([
      {
        key: 'depthKind',
        labelKey: 'propertyPanel.depth',
        value: 'blind',
        options: [
          { value: 'through', labelKey: 'propertyPanel.through' },
          { value: 'blind', labelKey: 'propertyPanel.blind' },
        ],
      },
    ]);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.selectedFaces', count: 1 },
      { labelKey: 'propertyPanel.centerPoints', count: 1 },
    ]);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.targetBody', name: '押し出し1', elementId: 'extrude-1' },
    ]);
  });

  it('貫通の穴は深さの欄が出ない', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, HOLE_THROUGH), HOLE_THROUGH);
    expect(summary.fields.map((field) => field.key)).toEqual(['diameter', 'tiltAngle', 'tiltAzimuth']);
    expect(summary.choices[0].value).toBe('through');
  });

  it('ねじ穴(貫通)は呼び・種類・見せ方・深さの種類の選択肢と、ピッチ・下穴径・ねじ部の長さ・傾き・傾ける向きの欄を返す(§0.a-0.13、0.14、タスク28)', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, THREAD_HOLE), THREAD_HOLE);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'pitch',
      'drillDiameter',
      'threadLength',
      'tiltAngle',
      'tiltAzimuth',
    ]);
    expect(summary.choices.map((choice) => choice.key)).toEqual([
      'depthKind',
      'threadDesignation',
      'threadSeries',
      'threadRepresentation',
    ]);
    expect(summary.choices[0].value).toBe('through');
    expect(summary.choices[1].value).toBe('M6');
    expect(summary.choices[2].value).toBe('coarse');
    expect(summary.choices[3].value).toBe('simplified');
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.selectedFaces', count: 1 },
      { labelKey: 'propertyPanel.centerPoints', count: 1 },
    ]);
  });

  it('ねじ穴(止まり)は深さの欄も返し、深さの種類の選択肢の値が blind になる(タスク28)', () => {
    const threadHoleBlind: ThreadHoleFeature = {
      ...THREAD_HOLE,
      id: 'threadHole-2',
      name: 'ねじ穴2',
      depth: { kind: 'blind', depth: expressionValueFromNumber(12) },
    };
    const summary = summarizeSolid(documentWith(EXTRUDE, threadHoleBlind), threadHoleBlind);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'pitch',
      'drillDiameter',
      'threadLength',
      'depth',
      'tiltAngle',
      'tiltAzimuth',
    ]);
    expect(summary.choices[0].value).toBe('blind');
  });

  it('R面取りは半径の欄と、選んだ辺の数を返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, FILLET), FILLET);
    expect(summary.fields.map((field) => field.key)).toEqual(['radius']);
    expect(summary.toggles).toEqual([]);
    expect(summary.subShapeCounts).toEqual([{ labelKey: 'propertyPanel.selectedEdges', count: 4 }]);
  });

  it('C面取り(2つの距離)は距離・距離2の欄と、基準面を入れ替えるつまみを返す(§0.a-0.18)', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, CHAMFER_TWO), CHAMFER_TWO);
    expect(summary.fields.map((field) => field.key)).toEqual(['chamferDistance', 'chamferDistance2']);
    expect(summary.choices[0].value).toBe('twoDistances');
    expect(summary.toggles).toEqual([
      { key: 'swapReferenceFace', labelKey: 'propertyPanel.swapReferenceFace', value: true },
    ]);
  });

  it('C面取り(距離と角度)は距離・角度の欄と、基準面を入れ替えるつまみを返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, CHAMFER_ANGLE), CHAMFER_ANGLE);
    expect(summary.fields.map((field) => field.key)).toEqual(['chamferDistance', 'chamferAngle']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['swapReferenceFace']);
  });

  it('C面取り(等距離)は距離だけの欄で、基準面を入れ替えるつまみを持たない(等距離では効かない、§0.a-0.18)', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, CHAMFER_EQUAL), CHAMFER_EQUAL);
    expect(summary.fields.map((field) => field.key)).toEqual(['chamferDistance']);
    expect(summary.toggles).toEqual([]);
  });

  it('直線パターンは間隔・個数の欄、向きの選択肢、両側への欄を返す', () => {
    const document = documentWith(EXTRUDE, HOLE_BLIND, LINEAR_PATTERN);
    const summary = summarizeSolid(document, LINEAR_PATTERN);
    expect(summary.fields.map((field) => field.key)).toEqual(['spacing', 'count']);
    expect(summary.choices).toEqual([
      {
        key: 'patternDirection',
        labelKey: 'numericInput.choice.patternDirection',
        value: 'x',
        options: [
          { value: 'x', labelKey: 'numericInput.axis.x' },
          { value: 'y', labelKey: 'numericInput.axis.y' },
          { value: 'z', labelKey: 'numericInput.axis.z' },
        ],
      },
    ]);
    expect(summary.toggles).toEqual([
      { key: 'patternSymmetric', labelKey: 'numericInput.toggle.patternSymmetric', value: false },
    ]);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.patternSource', name: '穴1', elementId: 'hole-1' },
    ]);
    expect(summary.subShapeCounts).toEqual([]);
  });

  it('円形パターン(全周)は角度の欄が出ない(NFR-UX-4)', () => {
    const document = documentWith(EXTRUDE, HOLE_BLIND, CIRCULAR_PATTERN);
    const summary = summarizeSolid(document, CIRCULAR_PATTERN);
    expect(summary.fields.map((field) => field.key)).toEqual(['count']);
    expect(summary.choices[0].labelKey).toBe('numericInput.axisGroupLabel');
    expect(summary.toggles).toEqual([
      { key: 'fullCircle', labelKey: 'numericInput.toggle.fullCircle', value: true },
    ]);
  });

  it('円形パターン(全周でない)は角度・個数の欄を返す', () => {
    const document = documentWith(EXTRUDE, HOLE_BLIND, CIRCULAR_PATTERN_PARTIAL);
    const summary = summarizeSolid(document, CIRCULAR_PATTERN_PARTIAL);
    expect(summary.fields.map((field) => field.key)).toEqual(['patternAngle', 'count']);
    expect(summary.toggles).toEqual([
      { key: 'fullCircle', labelKey: 'numericInput.toggle.fullCircle', value: false },
    ]);
  });

  it('SOLID_KIND_LABEL_KEYS は加工6種+ばねも正式なキーを持つ(旧タスク22の暫定 featureTree.unsupportedKind を解消)', () => {
    expect(SOLID_KIND_LABEL_KEYS.hole).toBe('toolbar.machining.hole');
    expect(SOLID_KIND_LABEL_KEYS.threadHole).toBe('toolbar.machining.threadHole');
    expect(SOLID_KIND_LABEL_KEYS.fillet).toBe('toolbar.machining.fillet');
    expect(SOLID_KIND_LABEL_KEYS.chamfer).toBe('toolbar.machining.chamfer');
    expect(SOLID_KIND_LABEL_KEYS.linearPattern).toBe('toolbar.machining.linearPattern');
    expect(SOLID_KIND_LABEL_KEYS.circularPattern).toBe('toolbar.machining.circularPattern');
    expect(SOLID_KIND_LABEL_KEYS.spring).toBe('toolbar.solid.spring');
  });
});

describe('summarizeSolid(ばね、計画書 docs/plans/P3-加工フィーチャー.md タスク29b、§0.a-0.29〜0.36)', () => {
  it('derived が全長のとき、全長だけ読み取り専用になる(§0.a-0.30)', () => {
    const summary = summarizeSolid(documentWithSpringPoint(SPRING), SPRING);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'coilDiameter',
      'wireDiameter',
      'springPitch',
      'springTurns',
      'springLength',
    ]);
    expect(summary.fields.map((field) => field.readOnly)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(summary.fields[4].value.display).toBe('20');
  });

  it('derived がピッチのとき、ピッチだけ読み取り専用になる', () => {
    const feature: SpringFeature = { ...SPRING, derived: 'pitch' };
    const summary = summarizeSolid(documentWithSpringPoint(feature), feature);
    expect(summary.fields.map((field) => field.readOnly)).toEqual([false, false, true, false, false]);
  });

  it('derived が巻数のとき、巻数だけ読み取り専用になる', () => {
    const feature: SpringFeature = { ...SPRING, derived: 'turns' };
    const summary = summarizeSolid(documentWithSpringPoint(feature), feature);
    expect(summary.fields.map((field) => field.readOnly)).toEqual([false, false, false, true, false]);
  });

  it('choices は軸・巻き方向・求める値の3つを返す', () => {
    const summary = summarizeSolid(documentWithSpringPoint(SPRING), SPRING);
    expect(summary.choices.map((choice) => choice.key)).toEqual([
      'springAxis',
      'springHandedness',
      'springDerived',
    ]);
    expect(summary.choices[0]).toEqual({
      key: 'springAxis',
      labelKey: 'propertyPanel.springAxis',
      value: 'z',
      options: [
        { value: 'x', labelKey: 'numericInput.axis.x' },
        { value: 'y', labelKey: 'numericInput.axis.y' },
        { value: 'z', labelKey: 'numericInput.axis.z' },
      ],
    });
    expect(summary.choices[1]).toEqual({
      key: 'springHandedness',
      labelKey: 'propertyPanel.springHandedness',
      value: 'right',
      options: [
        { value: 'right', labelKey: 'numericInput.springHandedness.right' },
        { value: 'left', labelKey: 'numericInput.springHandedness.left' },
      ],
    });
    expect(summary.choices[2]).toEqual({
      key: 'springDerived',
      labelKey: 'propertyPanel.springDerived',
      value: 'length',
      options: [
        { value: 'length', labelKey: 'numericInput.springDerived.length' },
        { value: 'pitch', labelKey: 'numericInput.springDerived.pitch' },
        { value: 'turns', labelKey: 'numericInput.springDerived.turns' },
      ],
    });
  });

  it('線分を軸にしたばねは、線分の名前を選択肢に足す(直線パターンの向きと同じ作り)', () => {
    const feature: SpringFeature = {
      ...SPRING,
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-9' } },
    };
    const summary = summarizeSolid(documentWithSpringPoint(feature), feature);
    expect(summary.choices[0].value).toBe('line');
    expect(summary.choices[0].options).toContainEqual({ value: 'line', label: '線分9' });
  });

  it('参照は始点の点1つを返す(FR-502)', () => {
    const summary = summarizeSolid(documentWithSpringPoint(SPRING), SPRING);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.springOrigin', name: '点1', elementId: 'point-1' },
    ]);
  });

  it('始点の点が消えていても止めず、id を出す(FR-504)', () => {
    const summary = summarizeSolid(documentWith(SPRING), SPRING);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.springOrigin', name: 'point-1', elementId: null },
    ]);
  });

  it('対象を消費しないので subShapeCounts は空、つまみも持たない(§0.a-0.36)', () => {
    const summary = summarizeSolid(documentWithSpringPoint(SPRING), SPRING);
    expect(summary.subShapeCounts).toEqual([]);
    expect(summary.toggles).toEqual([]);
  });

  it('回転軸(axis)は使わない。軸は choices の springAxis で持つ', () => {
    const summary = summarizeSolid(documentWithSpringPoint(SPRING), SPRING);
    expect(summary.axis).toBeNull();
  });
});

describe('setSolidField(加工6種、FR-311)', () => {
  it('穴の直径・傾き・傾ける向きを書き戻し、元は変えない', () => {
    const next = setSolidField(HOLE_BLIND, 'diameter', expressionValueFromNumber(8));
    expect(next).not.toBe(HOLE_BLIND);
    expect(next.kind === 'hole' ? next.diameter.value : null).toBe(8);
    expect(HOLE_BLIND.diameter.value).toBe(6);
    const tilted = setSolidField(HOLE_BLIND, 'tiltAngle', expressionValueFromNumber(15));
    expect(tilted.kind === 'hole' ? tilted.tiltAngle.value : null).toBe(15);
  });

  it('止まり穴の深さを書き戻す。貫通の穴は深さを持たないので変わらない', () => {
    const next = setSolidField(HOLE_BLIND, 'depth', expressionValueFromNumber(20));
    expect(next.kind === 'hole' && next.depth.kind === 'blind' ? next.depth.depth.value : null).toBe(
      20,
    );
    expect(setSolidField(HOLE_THROUGH, 'depth', expressionValueFromNumber(20))).toBe(HOLE_THROUGH);
  });

  it('ねじ穴のピッチ・下穴径・ねじ部の長さを書き戻す', () => {
    const next = setSolidField(THREAD_HOLE, 'threadLength', expressionValueFromNumber(15));
    expect(next.kind === 'threadHole' ? next.threadLength.value : null).toBe(15);
    expect(THREAD_HOLE.threadLength.value).toBe(10);
  });

  it('ねじ穴の傾き・傾ける向きを書き戻す(タスク28)', () => {
    const tilted = setSolidField(THREAD_HOLE, 'tiltAngle', expressionValueFromNumber(10));
    expect(tilted.kind === 'threadHole' ? tilted.tiltAngle.value : null).toBe(10);
    const azimuth = setSolidField(THREAD_HOLE, 'tiltAzimuth', expressionValueFromNumber(45));
    expect(azimuth.kind === 'threadHole' ? azimuth.tiltAzimuth.value : null).toBe(45);
  });

  it('止まりのねじ穴の深さを書き戻す。貫通のねじ穴は深さを持たないので変わらない(タスク28)', () => {
    const threadHoleBlind: ThreadHoleFeature = {
      ...THREAD_HOLE,
      id: 'threadHole-2',
      depth: { kind: 'blind', depth: expressionValueFromNumber(12) },
    };
    const next = setSolidField(threadHoleBlind, 'depth', expressionValueFromNumber(20));
    expect(
      next.kind === 'threadHole' && next.depth.kind === 'blind' ? next.depth.depth.value : null,
    ).toBe(20);
    expect(setSolidField(THREAD_HOLE, 'depth', expressionValueFromNumber(20))).toBe(THREAD_HOLE);
  });

  it('R面取りの半径を書き戻す', () => {
    const next = setSolidField(FILLET, 'radius', expressionValueFromNumber(3));
    expect(next.kind === 'fillet' ? next.radius.value : null).toBe(3);
  });

  it('C面取りは決め方ごとに対応する欄だけを書き戻す', () => {
    const distance2 = setSolidField(CHAMFER_TWO, 'chamferDistance2', expressionValueFromNumber(5));
    expect(
      distance2.kind === 'chamfer' && distance2.size.kind === 'twoDistances'
        ? distance2.size.distance2.value
        : null,
    ).toBe(5);
    // 等距離のときは distance2 を持たないので、その欄への書き戻しは何も変えない。
    expect(setSolidField(CHAMFER_EQUAL, 'chamferDistance2', expressionValueFromNumber(5))).toBe(
      CHAMFER_EQUAL,
    );
    const angled = setSolidField(CHAMFER_ANGLE, 'chamferAngle', expressionValueFromNumber(30));
    expect(
      angled.kind === 'chamfer' && angled.size.kind === 'distanceAngle'
        ? angled.size.angle.value
        : null,
    ).toBe(30);
  });

  it('直線パターンの間隔・個数、円形パターンの角度・個数を書き戻す', () => {
    const spaced = setSolidField(LINEAR_PATTERN, 'spacing', expressionValueFromNumber(30));
    expect(
      spaced.kind === 'pattern' && spaced.placement.kind === 'linear'
        ? spaced.placement.spacing.value
        : null,
    ).toBe(30);
    const angled = setSolidField(CIRCULAR_PATTERN_PARTIAL, 'patternAngle', expressionValueFromNumber(90));
    expect(
      angled.kind === 'pattern' && angled.placement.kind === 'circular'
        ? angled.placement.angle.value
        : null,
    ).toBe(90);
  });

  it('持たない欄なら同じものを返す', () => {
    expect(setSolidField(HOLE_BLIND, 'radius', expressionValueFromNumber(1))).toBe(HOLE_BLIND);
    expect(setSolidField(FILLET, 'diameter', expressionValueFromNumber(1))).toBe(FILLET);
    expect(setSolidField(LINEAR_PATTERN, 'patternAngle', expressionValueFromNumber(1))).toBe(
      LINEAR_PATTERN,
    );
  });
});

describe('setSolidToggle(加工6種)', () => {
  it('C面取りの基準面を入れ替えるつまみを切り替える(§0.a-0.18)', () => {
    const next = setSolidToggle(CHAMFER_EQUAL, 'swapReferenceFace', true);
    expect(next.kind === 'chamfer' ? next.swapReferenceFace : null).toBe(true);
    expect(CHAMFER_EQUAL.swapReferenceFace).toBe(false);
  });

  it('直線パターンの両側へ、円形パターンの全周を切り替える', () => {
    const symmetric = setSolidToggle(LINEAR_PATTERN, 'patternSymmetric', true);
    expect(
      symmetric.kind === 'pattern' && symmetric.placement.kind === 'linear'
        ? symmetric.placement.symmetric
        : null,
    ).toBe(true);
    const fullCircle = setSolidToggle(CIRCULAR_PATTERN_PARTIAL, 'fullCircle', true);
    expect(
      fullCircle.kind === 'pattern' && fullCircle.placement.kind === 'circular'
        ? fullCircle.placement.fullCircle
        : null,
    ).toBe(true);
  });

  it('種類に合わないつまみは同じものを返す', () => {
    expect(setSolidToggle(FILLET, 'swapReferenceFace', true)).toBe(FILLET);
    expect(setSolidToggle(LINEAR_PATTERN, 'fullCircle', true)).toBe(LINEAR_PATTERN);
    expect(setSolidToggle(CIRCULAR_PATTERN, 'patternSymmetric', true)).toBe(CIRCULAR_PATTERN);
  });
});

describe('setSolidChoice / setSolidDepthKind(FR-406、§0.a-0.18)', () => {
  it("setSolidChoice('threadDesignation', 'M10') は呼び・ピッチ・下穴径を一緒に変える(FR-406)", () => {
    const next = setSolidChoice(THREAD_HOLE, 'threadDesignation', 'M10');
    expect(next.kind === 'threadHole' ? next.designation : null).toBe('M10');
    expect(next.kind === 'threadHole' ? next.pitch.value : null).toBe(1.5);
    expect(next.kind === 'threadHole' ? next.drillDiameter.value : null).toBeCloseTo(
      8.376202368,
      9,
    );
    expect(THREAD_HOLE.designation).toBe('M6');
  });

  it("setSolidChoice('threadSeries', 'fine') はいまの呼びのままピッチ・下穴径を細目で組み直す", () => {
    const next = setSolidChoice(THREAD_HOLE, 'threadSeries', 'fine');
    expect(next.kind === 'threadHole' ? next.series : null).toBe('fine');
    expect(next.kind === 'threadHole' ? next.designation : null).toBe('M6');
    expect(next.kind === 'threadHole' ? next.pitch.value : null).toBe(0.75);
  });

  it("setSolidChoice('threadRepresentation', 'modeled') は見せ方だけを変える", () => {
    const next = setSolidChoice(THREAD_HOLE, 'threadRepresentation', 'modeled');
    expect(next.kind === 'threadHole' ? next.representation : null).toBe('modeled');
    expect(THREAD_HOLE.representation).toBe('simplified');
  });

  it('見つからない呼びは受け付けず、元のまま返す', () => {
    expect(setSolidChoice(THREAD_HOLE, 'threadDesignation', 'M999')).toBe(THREAD_HOLE);
  });

  it("setSolidChoice('chamferMode', ...) は距離を引き継いで決め方を切り替える(§0.a-0.18)", () => {
    const toTwoDistances = setSolidChoice(CHAMFER_EQUAL, 'chamferMode', 'twoDistances');
    expect(
      toTwoDistances.kind === 'chamfer' && toTwoDistances.size.kind === 'twoDistances'
        ? toTwoDistances.size.distance1.value
        : null,
    ).toBe(1);
    const toEqual = setSolidChoice(CHAMFER_TWO, 'chamferMode', 'equal');
    expect(
      toEqual.kind === 'chamfer' && toEqual.size.kind === 'equal' ? toEqual.size.distance.value : null,
    ).toBe(1);
  });

  it("setSolidChoice('patternDirection', 'y') は直線の向き・円形の軸をどちらも変える", () => {
    const linear = setSolidChoice(LINEAR_PATTERN, 'patternDirection', 'y');
    expect(
      linear.kind === 'pattern' && linear.placement.kind === 'linear'
        ? linear.placement.direction
        : null,
    ).toEqual({ kind: 'world', axis: 'y' });
    const circular = setSolidChoice(CIRCULAR_PATTERN, 'patternDirection', 'y');
    expect(
      circular.kind === 'pattern' && circular.placement.kind === 'circular'
        ? circular.placement.axis
        : null,
    ).toEqual({ kind: 'world', axis: 'y' });
  });

  it("setSolidDepthKind('blind') は貫通の穴を既定の深さ(DEFAULT_HOLE_DEPTH_MM)の止まり穴にする", () => {
    const next = setSolidDepthKind(HOLE_THROUGH, 'blind');
    expect(
      next.kind === 'hole' && next.depth.kind === 'blind' ? next.depth.depth.value : null,
    ).toBe(10);
  });

  it("setSolidChoice('depthKind', 'blind') はねじ穴でも効く(穴と同じ setSolidDepthKind を使う、タスク28)", () => {
    const next = setSolidChoice(THREAD_HOLE, 'depthKind', 'blind');
    expect(
      next.kind === 'threadHole' && next.depth.kind === 'blind' ? next.depth.depth.value : null,
    ).toBe(10);
  });

  it("setSolidDepthKind('through') → 'blind' は既定値に戻る(前の止まりの値を覚えない)", () => {
    const custom: HoleFeature = {
      ...HOLE_BLIND,
      depth: { kind: 'blind', depth: expressionValueFromNumber(99) },
    };
    const through = setSolidDepthKind(custom, 'through');
    expect(through.kind === 'hole' ? through.depth.kind : null).toBe('through');
    const backToBlind = setSolidDepthKind(through, 'blind');
    expect(
      backToBlind.kind === 'hole' && backToBlind.depth.kind === 'blind'
        ? backToBlind.depth.depth.value
        : null,
    ).toBe(10);
  });

  it('穴・ねじ穴・面取り・パターン以外、または妥当でない値は同じものを返す', () => {
    expect(setSolidChoice(EXTRUDE, 'depthKind', 'blind')).toBe(EXTRUDE);
    expect(setSolidDepthKind(EXTRUDE, 'blind')).toBe(EXTRUDE);
    expect(setSolidChoice(FILLET, 'chamferMode', 'equal')).toBe(FILLET);
    expect(setSolidChoice(HOLE_BLIND, 'depthKind', 'diagonal')).toBe(HOLE_BLIND);
  });
});

describe('ばねの書き戻し(FR-311、FR-202、§0.a-0.30、§0.a-0.33、計画書タスク29b)', () => {
  it('setSolidField はコイル径・線径を独立して書き換える。全長・ピッチ・巻数は変わらない', () => {
    const next = setSolidField(SPRING, 'coilDiameter', { source: '25', value: 25, display: '25' });
    expect(next).not.toBe(SPRING);
    expect(next.kind === 'spring' ? next.coilDiameter.source : null).toBe('25');
    expect(next.kind === 'spring' ? next.pitch : null).toBe(SPRING.pitch);
    expect(next.kind === 'spring' ? next.turns : null).toBe(SPRING.turns);
    expect(next.kind === 'spring' ? next.length : null).toBe(SPRING.length);
    expect(SPRING.coilDiameter.value).toBe(20);

    const wire = setSolidField(SPRING, 'wireDiameter', { source: '3', value: 3, display: '3' });
    expect(wire.kind === 'spring' ? wire.wireDiameter.value : null).toBe(3);
    expect(SPRING.wireDiameter.value).toBe(2);
  });

  it(
    'derived が全長のとき、巻数を書き換えると全長がその場で計算し直される' +
      '(NFR-UX-4。計画書タスク30 のE2E「巻数を8に書き換えると全長が40になる」の土台)',
    () => {
      const next = setSolidField(SPRING, 'springTurns', { source: '8', value: 8, display: '8' });
      expect(next.kind === 'spring' ? next.turns.value : null).toBe(8);
      expect(next.kind === 'spring' ? next.length.value : null).toBe(40);
      expect(next.kind === 'spring' ? next.length.source : null).toBe('5*8');
    },
  );

  it('derived が全長のとき、ピッチを書き換えても同じように全長が計算し直される', () => {
    const next = setSolidField(SPRING, 'springPitch', { source: '10', value: 10, display: '10' });
    expect(next.kind === 'spring' ? next.pitch.value : null).toBe(10);
    expect(next.kind === 'spring' ? next.length.value : null).toBe(40);
    expect(next.kind === 'spring' ? next.length.source : null).toBe('10*4');
  });

  it('derived の欄(読み取り専用)への setSolidField は何も変えない', () => {
    expect(
      setSolidField(SPRING, 'springLength', { source: '99', value: 99, display: '99' }),
    ).toBe(SPRING);
    const pitchDerived: SpringFeature = { ...SPRING, derived: 'pitch' };
    expect(
      setSolidField(pitchDerived, 'springPitch', { source: '99', value: 99, display: '99' }),
    ).toBe(pitchDerived);
    const turnsDerived: SpringFeature = { ...SPRING, derived: 'turns' };
    expect(
      setSolidField(turnsDerived, 'springTurns', { source: '99', value: 99, display: '99' }),
    ).toBe(turnsDerived);
  });

  it("setSolidChoice('springDerived', 'pitch') はピッチを全長・巻数から計算し直す(全長20・巻数4)", () => {
    const next = setSolidChoice(SPRING, 'springDerived', 'pitch');
    expect(next.kind === 'spring' ? next.derived : null).toBe('pitch');
    expect(next.kind === 'spring' ? next.pitch.value : null).toBe(5);
    expect(next.kind === 'spring' ? next.pitch.source : null).toBe('20/4');
  });

  it("setSolidChoice('springDerived', 'turns') は巻数を全長・ピッチから計算し直す(全長20・ピッチ5)", () => {
    const next = setSolidChoice(SPRING, 'springDerived', 'turns');
    expect(next.kind === 'spring' ? next.derived : null).toBe('turns');
    expect(next.kind === 'spring' ? next.turns.value : null).toBe(4);
    expect(next.kind === 'spring' ? next.turns.source : null).toBe('20/5');
  });

  it("setSolidChoice('springHandedness', 'left') は巻き方向だけを変える。元のフィーチャーは変わらない(§0.a-0.33)", () => {
    const next = setSolidChoice(SPRING, 'springHandedness', 'left');
    expect(next.kind === 'spring' ? next.handedness : null).toBe('left');
    expect(next).not.toBe(SPRING);
    expect(SPRING.handedness).toBe('right');
  });

  it("setSolidChoice('springAxis', 'x') はワールドの X/Y/Z へ変える(§0.a-0.29)", () => {
    const next = setSolidChoice(SPRING, 'springAxis', 'x');
    expect(next.kind === 'spring' ? next.axis : null).toEqual({ kind: 'world', axis: 'x' });
  });

  it('ばね以外、または妥当でない値は同じものを返す', () => {
    expect(setSolidChoice(EXTRUDE, 'springHandedness', 'left')).toBe(EXTRUDE);
    expect(setSolidChoice(SPRING, 'springHandedness', 'sideways')).toBe(SPRING);
    expect(setSolidChoice(SPRING, 'springAxis', 'w')).toBe(SPRING);
    expect(setSolidChoice(SPRING, 'springDerived', 'width')).toBe(SPRING);
    expect(setSolidField(EXTRUDE, 'coilDiameter', expressionValueFromNumber(1))).toBe(EXTRUDE);
  });
});

/* ---------------------------------------------------------------------------
 * 基準ジオメトリ(FR-328、FR-329。P4 タスク33)
 * ------------------------------------------------------------------------- */

const OFFSET_PLANE: ReferenceFeature = {
  id: 'referencePlane-1',
  name: '作業平面1',
  visible: true,
  kind: 'referencePlane',
  plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(25) },
};

const HELPER_POINT: ReferenceFeature = {
  id: 'referencePoint-2',
  name: '基準点2',
  // 平面を決めるためだけに置いた点(`appendCoordinatePoints` が作る)。
  visible: false,
  kind: 'referencePoint',
  definition: {
    kind: 'coordinate',
    at: {
      mode: 'absolute',
      x: expressionValueFromNumber(1),
      y: expressionValueFromNumber(2),
      z: expressionValueFromNumber(3),
    },
  },
};

const REFERENCE_AXIS: ReferenceFeature = {
  id: 'referenceAxis-3',
  name: '基準軸3',
  visible: true,
  kind: 'referenceAxis',
  definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'previous' } },
};

function documentWithReferences(...references: readonly ReferenceFeature[]): PartDocument {
  return { ...createEmptyPartDocument(), references };
}

describe('buildReferenceSection(FR-328、FR-329、FR-501)', () => {
  it('基準の節を履歴順に返し、見出しは「基準」になる', () => {
    const section = buildReferenceSection(
      documentWithReferences(OFFSET_PLANE, HELPER_POINT, REFERENCE_AXIS),
    );
    expect(section.key).toBe('reference');
    expect(section.titleKey).toBe('featureTree.referenceGroup');
    expect(section.rows.map((row) => row.name)).toEqual(['作業平面1', '基準点2', '基準軸3']);
    expect(section.rows.map((row) => row.kind)).toEqual([
      'referencePlane',
      'referencePoint',
      'referenceAxis',
    ]);
  });

  it('画面に出していない基準は行を消さず「補助」の印を立てる(FR-503 の操作を残すため)', () => {
    const section = buildReferenceSection(documentWithReferences(OFFSET_PLANE, HELPER_POINT));
    expect(section.rows.map((row) => row.hidden)).toEqual([false, true]);
  });

  it('決まらなかった基準はその行だけが赤い印になる(FR-504)', () => {
    const section = buildReferenceSection(documentWithReferences(OFFSET_PLANE, REFERENCE_AXIS), [
      { featureId: 'referenceAxis-3', code: 'missingPoint', message: '基準の点がありません。' },
    ]);
    expect(section.rows.map((row) => row.hasError)).toEqual([false, true]);
    expect(section.rows[1].errorMessage).toBe('基準の点がありません。');
  });

  it('基準が 1 つも無いときは行が空の節を返す(NFR-UX-6)', () => {
    expect(buildReferenceSection(createEmptyPartDocument()).rows).toEqual([]);
  });
});

describe('summarizeReference(基準ジオメトリのプロパティ、FR-328、FR-329)', () => {
  it('基準面からのオフセットは距離の欄を式のまま出す(FR-202)', () => {
    const summary = summarizeReference(OFFSET_PLANE);
    // 種類の名前は決め方に依らず「作業平面」。決め方は definitionLabelKey が別に持つ。
    expect(summary.kindLabelKey).toBe('propertyPanel.kind.referencePlane');
    expect(summary.definitionLabelKey).toBe('propertyPanel.planeSpec.workPlane');
    expect(summary.fields.map((item) => item.key)).toEqual(['planeOffset']);
    expect(summary.fields[0].value.value).toBe(25);
    expect(summary.fields[0].unit).toBe('mm');
  });

  it('オフセットの欄を直すと、平面の決め方だけが差し替わる', () => {
    const next = setReferenceField(OFFSET_PLANE, 'planeOffset', expressionValueFromNumber(60));
    if (next.kind !== 'referencePlane' || next.plane.kind !== 'workPlane') {
      throw new Error('作業平面が返るはず');
    }
    expect(next.plane.offset.value).toBe(60);
    expect(next.plane.planeId).toBe('xy');
    expect(next.name).toBe('作業平面1');
  });

  it('座標で置いた基準点は位置の欄を持ち、他の決め方は持たない', () => {
    expect(summarizeReference(HELPER_POINT).coordinate?.fields.map((item) => item.path)).toEqual([
      'at.x',
      'at.y',
      'at.z',
    ]);
    expect(summarizeReference(REFERENCE_AXIS).coordinate).toBeNull();
    expect(summarizeReference(REFERENCE_AXIS).definitionLabelKey).toBe(
      'numericInput.referenceAxisKind.twoPoints',
    );
  });

  it('表示・非表示と名前は元を変えずに差し替える(FR-329、FR-503)', () => {
    const shown = setReferenceVisible(HELPER_POINT, true);
    expect(shown.visible).toBe(true);
    expect(HELPER_POINT.visible).toBe(false);
    // 同じ値なら同じものを返す(無駄な再計算を起こさない)。
    expect(setReferenceVisible(HELPER_POINT, false)).toBe(HELPER_POINT);
    expect(renameReference(HELPER_POINT, ' 天板の基準 ').name).toBe('天板の基準');
    expect(renameReference(HELPER_POINT, '   ')).toBe(HELPER_POINT);
  });
});

describe('buildSketchGroups(P4 仕上げ (g)、FR-501、FR-503)', () => {
  /** 面 1 枚だけを持つ 2 本目のスケッチを足す。id は 1 本目とわざと重ねる。 */
  function withSecondSketch(document: PartDocument, activeSketchId: string): PartDocument {
    const second = appendFeature({ id: 'sketch-2', name: 'スケッチ2', features: [] }, FACE);
    return { ...document, sketches: [document.sketches[0], second], activeSketchId };
  }

  it('文書内の全スケッチを名前と要素の行にして返す', () => {
    const groups = buildSketchGroups(withSecondSketch(documentWith(EXTRUDE), 'sketch-1'));
    expect(groups.map((group) => group.sketchId)).toEqual(['sketch-1', 'sketch-2']);
    expect(groups.map((group) => group.name)).toEqual(['スケッチ1', 'スケッチ2']);
    expect(groups[0].rows.map((row) => row.name)).toEqual(['面1', '面2', '線分9']);
    expect(groups[1].rows.map((row) => row.name)).toEqual(['面1']);
  });

  it('編集中のスケッチだけ active が真になる', () => {
    expect(
      buildSketchGroups(withSecondSketch(documentWith(EXTRUDE), 'sketch-2')).map(
        (group) => group.active,
      ),
    ).toEqual([false, true]);
  });

  it('失敗の理由は編集中のスケッチの行にだけ付く(同じ id の他のスケッチへ移さない)', () => {
    const errors = [
      { featureId: 'face-1', code: 'invalidValue', message: '式が読めません' },
    ] as const;
    const groups = buildSketchGroups(
      withSecondSketch(documentWith(EXTRUDE), 'sketch-1'),
      errors,
    );
    expect(groups[0].rows[0].errorMessage).toBe('式が読めません');
    // スケッチ 2 にも face-1 はあるが、こちらは編集中ではないので理由を付けない。
    expect(groups[1].rows[0].errorMessage).toBeNull();
  });

  it('立体が使っているスケッチだけ inUse が真になる(FR-504)', () => {
    // EXTRUDE の断面は sketch-1 の face-1(定数 EXTRUDE のとおり)。
    const groups = buildSketchGroups(withSecondSketch(documentWith(EXTRUDE), 'sketch-1'));
    expect(groups.map((group) => group.inUse)).toEqual([true, false]);
    // 立体が 1 つも無ければどのスケッチも使われていない。
    expect(
      buildSketchGroups(withSecondSketch(createEmptyPartDocument(), 'sketch-1')).map(
        (group) => group.inUse,
      ),
    ).toEqual([false, false]);
  });

  it('スケッチが 1 本だけなら 1 つだけ返し、buildTreeSections と同じ行になる', () => {
    const document = documentWith(EXTRUDE);
    const groups = buildSketchGroups(document);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toEqual(buildTreeSections(document, 'sketch-1', [], [])[0].rows);
  });
});

describe('renameSketch(FR-503)', () => {
  it('名前を変えた新しいスケッチを作る', () => {
    const sketch = createEmptyPartDocument().sketches[0];
    expect(renameSketch(sketch, '下描き').name).toBe('下描き');
    // 元は変えない。
    expect(sketch.name).toBe('スケッチ1');
  });

  it('空白だけの名前と同じ名前は元のまま返す', () => {
    const sketch = createEmptyPartDocument().sketches[0];
    expect(renameSketch(sketch, '   ')).toBe(sketch);
    expect(renameSketch(sketch, 'スケッチ1')).toBe(sketch);
  });
});
