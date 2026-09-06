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
  DEFAULT_COUNTERBORE_DEPTH_MM,
  DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES,
  DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_EXTRUDE_THICKNESS_MM,
  DEFAULT_FILLET_RADIUS_END_MM,
  extrudeShapingOf,
  filletRadiusOf,
  holeEntryOf,
  MAX_DRAFT_ANGLE_DEGREES,
  MAX_SCALE,
  MAX_TAPER_ANGLE_DEGREES,
  MIN_SCALE,
  replaceSketch,
  type BooleanFeature,
  type ChamferFeature,
  // 平面による切断(FR-432、P5 タスク27c)。
  type CutFeature,
  type DraftFeature,
  type EmbossFeature,
  type ExtrudeFeature,
  type FilletFeature,
  type HoleFeature,
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
  type ImportedMeshFeature,
  type ImportedSolidFeature,
  type LoftFeature,
  type MirrorFeature,
  type PartDocument,
  type PartRecomputeError,
  type PatternFeature,
  type PrimitiveFeature,
  type ReferenceFeature,
  type RevolveFeature,
  type RibFeature,
  type RuledFeature,
  type ScaleFeature,
  type SewFeature,
  // くり抜き(FR-418、P5 タスク46)。
  type ShellFeature,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchPointFeature,
  type SolidFeature,
  type SpringFeature,
  type SubShapeRef,
  type SurfaceFeature,
  type SweepFeature,
  type ThreadHoleFeature,
  type ThreadShaftFeature,
  type TransformFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t } from '../i18n/t.js';

import {
  AREA_UNIT_KEYS,
  buildReferenceSection,
  buildSketchGroups,
  buildTreeSections,
  formatArea,
  formatVolume,
  missingValueKey,
  partErrorMessage,
  PLANE_SPEC_LABEL_KEYS,
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
  VOLUME_UNIT_KEYS,
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
  it('押し出しは距離・側面の傾きの欄、つまみ 3 つ、終わり方の選択肢、もとの面の名前を返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE), EXTRUDE);
    expect(summary.featureId).toBe('extrude-1');
    expect(summary.name).toBe('押し出し1');
    expect(summary.kindLabelKey).toBe('toolbar.solid.extrude');
    // 薄板にしていないので厚みの欄は出ない(効かない欄を出さない。NFR-UX-2)。
    expect(summary.fields.map((field) => field.key)).toEqual(['distance', 'taperAngle']);
    expect(summary.fields[0].value.display).toBe('10');
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual([
      'reversed',
      'taperOutward',
      'thinWalled',
    ]);
    // 「両側へ」は P2 のつまみではなく終わり方の選択肢で選ぶ(タスク52、NFR-UX-1)。
    expect(summary.choices.map((choice) => choice.key)).toEqual(['extrudeEnd']);
    expect(summary.choices[0].value).toBe('distance');
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
    const once = setSolidToggle(EXTRUDE, 'reversed', true);
    const twice = setSolidToggle(once, 'reversed', false);
    expect(once.kind === 'extrude' ? once.reversed : null).toBe(true);
    expect(twice).toEqual(EXTRUDE);
    expect(EXTRUDE.reversed).toBe(false);
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

  it('mm を渡しても既存の文言と 1 文字も変わらない(FR-811、P6 タスク3)', () => {
    expect(formatVolume(6000, 'mm')).toBe(formatVolume(6000));
    expect(formatVolume(8000, 'mm')).toBe('8000');
    expect(formatArea(1200, 'mm')).toBe('1200');
    expect(t(VOLUME_UNIT_KEYS.mm)).toBe('mm³');
    expect(t(AREA_UNIT_KEYS.mm)).toBe('mm²');
  });

  it('inch では in³ / in² へ換算して小数 3 桁で出す(FR-811、P6 §2.9)', () => {
    /*
     * 20mm の立方体の体積 8000mm³ を inch で読むと `(20/25.4)³` in³。
     * `20/25.4 = 0.7874015748031497`、その 3 乗は `0.48818995275785837` なので、
     * 小数 3 桁(model の `INCH_DISPLAY_DIGITS`。0.001in ≒ 0.0254mm)で `0.488`。
     * 計画書 §2.9 の表にある `0.48828125` は誤りで、担当が計算し直した値がこれである。
     */
    expect(formatVolume(8000, 'inch')).toBe('0.488');
    // 1 inch の立方体(25.4³ = 16387.064 mm³)はちょうど 1 in³。
    expect(formatVolume(16387.064, 'inch')).toBe('1.000');
    // 面積は 2 乗で換算する(1 in² = 25.4² = 645.16 mm²)。体積の 3 乗と取り違えない。
    expect(formatArea(645.16, 'inch')).toBe('1.000');
    expect(formatArea(1200, 'inch')).toBe('1.860');
    expect(t(VOLUME_UNIT_KEYS.inch)).toBe('in³');
    expect(t(AREA_UNIT_KEYS.inch)).toBe('in²');
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
      // 入口(ざぐり・皿もみ、FR-422。タスク52)。省略は「広げない」。
      {
        key: 'holeEntry',
        labelKey: 'propertyPanel.holeEntry',
        value: 'plain',
        options: [
          { value: 'plain', labelKey: 'numericInput.holeEntry.plain' },
          { value: 'counterbore', labelKey: 'numericInput.holeEntry.counterbore' },
          { value: 'countersink', labelKey: 'numericInput.holeEntry.countersink' },
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
      'holeEntry',
      'threadDesignation',
      'threadSeries',
      'threadRepresentation',
    ]);
    expect(summary.choices[0].value).toBe('through');
    expect(summary.choices[1].value).toBe('plain');
    expect(summary.choices[2].value).toBe('M6');
    expect(summary.choices[3].value).toBe('coarse');
    expect(summary.choices[4].value).toBe('simplified');
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

  it('R面取りは半径の欄と、選んだ辺の数、可変半径のつまみを返す', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, FILLET), FILLET);
    expect(summary.fields.map((field) => field.key)).toEqual(['radius']);
    // 一定半径なので「終わりを別の半径に」は切(FR-426、タスク55)。
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['variableRadius']);
    expect(summary.toggles[0].value).toBe(false);
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

  it(
    'ピッチにパラメータ名を書いても variables を渡せば全長が正しく計算される' +
      '(P4b タスク22a-(1)、板厚=3・巻数4 → 全長12)',
    () => {
      const variables = new Map([['板厚', 3]]);
      const next = setSolidField(
        SPRING,
        'springPitch',
        { source: '板厚', value: 0, display: '0' },
        variables,
      );
      expect(next.kind === 'spring' ? next.pitch.source : null).toBe('板厚');
      expect(next.kind === 'spring' ? next.length.source : null).toBe('板厚*4');
      expect(next.kind === 'spring' ? next.length.value : null).toBe(12);
    },
  );

  it('variables を渡さなければ、変数名のピッチは読めず全長は 0(止めずに警告する、FR-504)', () => {
    const next = setSolidField(SPRING, 'springPitch', { source: '板厚', value: 0, display: '0' });
    expect(next.kind === 'spring' ? next.length.value : null).toBe(0);
  });

  it(
    "setSolidChoice('springDerived', 'pitch') も variables を渡せば、全長にパラメータ名があっても計算できる" +
      '(P4b タスク22a-(1))',
    () => {
      const variables = new Map([['全長', 20]]);
      const withVariable: SpringFeature = {
        ...SPRING,
        length: { source: '全長', value: 0, display: '0' },
      };
      const next = setSolidChoice(withVariable, 'springDerived', 'pitch', variables);
      expect(next.kind === 'spring' ? next.pitch.source : null).toBe('全長/4');
      expect(next.kind === 'spring' ? next.pitch.value : null).toBe(5);
    },
  );

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

  it('編集中でないスケッチの行にも、そのスケッチ自身の id が付く(選択 → 属するスケッチ、P4 仕上げ (h))', () => {
    // 編集中(activeSketchId)はスケッチ1。木はスケッチ2の行を「スケッチ2」の親の下に置くので、
    // id が両方のスケッチに重なっていても(この文書では `face-1`)、押した行がどちらの
    // `group.sketchId` の配下かで取り違えずに済む(FeatureTree.tsx の activateRowSketch が
    // この group.sketchId をそのまま使う。2026-09-04 E2E タスク34 で発見)。
    const groups = buildSketchGroups(withSecondSketch(documentWith(EXTRUDE), 'sketch-1'));
    expect(groups[0].sketchId).toBe('sketch-1');
    expect(groups[0].rows.map((row) => row.id)).toContain('face-1');
    expect(groups[1].sketchId).toBe('sketch-2');
    expect(groups[1].rows.map((row) => row.id)).toContain('face-1');
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

describe('面をつなぐ・ロフトの要約(FR-430、FR-410、P5 タスク27)', () => {
  /** つなぐ相手にする球(FR-429)。名前は「球1」。 */
  const SPHERE: PrimitiveFeature = {
    id: 'sphere-1',
    name: '球1',
    suppressed: false,
    kind: 'primitive',
    origin: {
      kind: 'coordinate',
      value: {
        mode: 'absolute',
        x: expressionValueFromNumber(0),
        y: expressionValueFromNumber(0),
        z: expressionValueFromNumber(30),
      },
    },
    axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'sphere', radius: expressionValueFromNumber(10) },
  };

  const RULED: RuledFeature = {
    id: 'ruled-1',
    name: '面をつなぐ1',
    suppressed: false,
    kind: 'ruled',
    first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
    second: { kind: 'sphere', sphereFeatureId: 'sphere-1' },
    twist: expressionValueFromNumber(0),
    sphereSegments: 24,
  };

  const LOFT: LoftFeature = {
    id: 'loft-1',
    name: 'ロフト1',
    suppressed: false,
    kind: 'loft',
    sections: [
      { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
      { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-2' } },
      { kind: 'solidFace', ref: faceRef(0) },
    ],
    twist: expressionValueFromNumber(0),
  };

  it('面をつなぐは「スケッチ1の面 → 球1」を参照として返す', () => {
    const summary = summarizeSolid(documentWith(SPHERE, RULED), RULED);
    expect(summary.name).toBe('面をつなぐ1');
    expect(summary.kindLabelKey).toBe('toolbar.solid.ruled');
    /*
      タスク25 はここを `fields: []`(欄を 1 つも出さない最小の枝)で固定していた。
      タスク27 で本実装になり、ねじれ 1 欄が出る(欄を出すのがこのタスクの仕事なので、
      置き換えるのが正しい。期待値を緩めたのではない)。
    */
    expect(summary.fields.map((field) => field.key)).toEqual(['ruledTwist']);
    expect(summary.references.map((reference) => reference.name)).toEqual([
      'スケッチ1 / 面1',
      '球1',
    ]);
    // 元の球は消費されない(§0.a-0.27)ので、ツリーでも薄く出ない。
    expect(summarizeSolid(documentWith(SPHERE, RULED), SPHERE).consumed).toBe(false);
  });

  it('ロフトは断面の数だけ参照を返し、立体の面はその立体の名前になる', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE, LOFT), LOFT);
    expect(summary.kindLabelKey).toBe('toolbar.solid.loft');
    expect(summary.references.map((reference) => reference.name)).toEqual([
      'スケッチ1 / 面1',
      'スケッチ1 / 面2',
      '押し出し1',
    ]);
  });

  it('参照の見出しは 1 つ目 / 2 つ目、ロフトは全部「断面」(何番目かが読める)', () => {
    const ruled = summarizeSolid(documentWith(SPHERE, RULED), RULED);
    expect(ruled.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.ruledFirst',
      'propertyPanel.ruledSecond',
    ]);
    const loft = summarizeSolid(documentWith(EXTRUDE, LOFT), LOFT);
    expect(loft.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.loftSection',
      'propertyPanel.loftSection',
      'propertyPanel.loftSection',
    ]);
    for (const reference of [...ruled.references, ...loft.references]) {
      expect(MESSAGE_KEYS, reference.labelKey).toContain(reference.labelKey);
    }
  });

  it('なめらかさの 3 択は球を含む断面のときだけ出る(§0.a-0.87)', () => {
    // 球を含む罫線面。3 択(24 / 48 / 72)と、いまの値が出る。
    const withSphere = summarizeSolid(documentWith(SPHERE, RULED), RULED);
    expect(withSphere.choices.map((choice) => choice.key)).toEqual(['ruledSphereSegments']);
    expect(withSphere.choices[0].value).toBe('24');
    expect(withSphere.choices[0].options.map((option) => option.value)).toEqual(['24', '48', '72']);
    for (const option of withSphere.choices[0].options) {
      expect(MESSAGE_KEYS, option.value).toContain(option.labelKey);
    }
    // 球を含まない罫線面。点の数は形に効かないので欄ごと伏せる。
    const flat: RuledFeature = {
      ...RULED,
      second: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-2' } },
    };
    expect(summarizeSolid(documentWith(SPHERE, flat), flat).choices).toEqual([]);
    // ロフトには球を置けないので、そもそも選択肢を持たない。
    expect(summarizeSolid(documentWith(EXTRUDE, LOFT), LOFT).choices).toEqual([]);
  });

  it('ねじれの欄は式のまま出て、書き戻せる(FR-202、FR-502)', () => {
    const summary = summarizeSolid(documentWith(SPHERE, RULED), RULED);
    expect(summary.fields.map((field) => field.key)).toEqual(['ruledTwist']);
    expect(summary.fields[0].unit).toBe('count');
    expect(summary.fields[0].readOnly).toBe(false);
    const next = setSolidField(RULED, 'ruledTwist', {
      source: '1+1',
      value: 2,
      display: '2',
    });
    expect(next.kind === 'ruled' ? next.twist.source : null).toBe('1+1');
    // 持たない欄の名前ならそのまま返す(`setPrimitiveField` と同じ約束)。
    expect(setSolidField(RULED, 'distance', expressionValueFromNumber(1))).toBe(RULED);
    const loftNext = setSolidField(LOFT, 'ruledTwist', expressionValueFromNumber(3));
    expect(loftNext.kind === 'loft' ? loftNext.twist.value : null).toBe(3);
  });

  it('なめらかさを選び直すと点の数が変わる。3 択の外の値は捨てる', () => {
    const finer = setSolidChoice(RULED, 'ruledSphereSegments', '48');
    expect(finer.kind === 'ruled' ? finer.sphereSegments : null).toBe(48);
    expect(setSolidChoice(RULED, 'ruledSphereSegments', '96')).toBe(RULED);
    // 面をつなぐ以外のフィーチャーへ来ても何も変えない。
    expect(setSolidChoice(LOFT, 'ruledSphereSegments', '48')).toBe(LOFT);
  });
});

// ---------------------------------------------------------------------------
// P5 の Should 群(§2.11、タスク43)の最小の枝。
//
// **式の欄・つまみ・選択肢をプロパティへ出すのは タスク52** なので、ここで固定するのは
// 「木とプロパティに種類の名前と対象が出ること」と「網羅 switch が落ちていないこと」だけ。
// ---------------------------------------------------------------------------

const DRAFT: DraftFeature = {
  id: 'draft-1',
  name: '抜き勾配1',
  suppressed: false,
  kind: 'draft',
  targetFeatureId: 'extrude-1',
  faces: [faceRef(1), faceRef(2)],
  neutralFace: faceRef(0),
  angle: expressionValueFromNumber(1),
  reversed: false,
};

const MIRROR: MirrorFeature = {
  id: 'mirror-1',
  name: 'ミラー1',
  suppressed: false,
  kind: 'mirror',
  targetFeatureId: 'extrude-1',
  plane: { kind: 'workPlane', planeId: 'xy' },
};

const TRANSFORM: TransformFeature = {
  id: 'transform-1',
  name: '移動・回転1',
  suppressed: false,
  kind: 'transform',
  targetFeatureId: 'extrude-1',
  translation: [
    expressionValueFromNumber(10),
    expressionValueFromNumber(0),
    expressionValueFromNumber(0),
  ],
  rotationAxis: null,
  rotationAngle: expressionValueFromNumber(0),
};

const SCALE: ScaleFeature = {
  id: 'scale-1',
  name: '拡大縮小1',
  suppressed: false,
  kind: 'scale',
  targetFeatureId: 'extrude-1',
  origin: { kind: 'origin' },
  factor: { kind: 'uniform', value: expressionValueFromNumber(2) },
};

const SWEEP: SweepFeature = {
  id: 'sweep-1',
  name: 'スイープ1',
  suppressed: false,
  kind: 'sweep',
  profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
  path: { sketchId: 'sketch-1', curveIds: ['line-1'] },
  frenet: false,
};

const RIB: RibFeature = {
  id: 'rib-1',
  name: 'リブ1',
  suppressed: false,
  kind: 'rib',
  targetFeatureId: 'extrude-1',
  profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
  thickness: expressionValueFromNumber(3),
  side: 'both',
  extendToBody: true,
};

const EMBOSS: EmbossFeature = {
  id: 'emboss-1',
  name: 'エンボス1',
  suppressed: false,
  kind: 'emboss',
  targetFeatureId: 'extrude-1',
  face: faceRef(0),
  profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
  height: expressionValueFromNumber(1),
  raised: false,
};

const THREAD_SHAFT: ThreadShaftFeature = {
  id: 'threadShaft-1',
  name: '外ねじ1',
  suppressed: false,
  kind: 'threadShaft',
  targetFeatureId: 'extrude-1',
  face: faceRef(0),
  nominal: 'M6',
  series: 'coarse',
  pitch: expressionValueFromNumber(1),
  length: expressionValueFromNumber(20),
  fromEnd: 'first',
  modeled: false,
};

const SURFACE: SurfaceFeature = {
  id: 'surface-1',
  name: '曲面1',
  suppressed: false,
  kind: 'surface',
  operation: {
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
    distance: expressionValueFromNumber(20),
    reversed: false,
  },
};

const POINT_PATTERN: PatternFeature = {
  id: 'pointPattern-1',
  name: '点パターン1',
  suppressed: false,
  kind: 'pattern',
  sourceFeatureId: 'hole-1',
  placement: {
    kind: 'points',
    points: [
      { kind: 'point', pointId: 'point-1' },
      { kind: 'point', pointId: 'point-2' },
    ],
  },
};

describe('Should 群の要約(P5 §2.11、タスク43)', () => {
  it('種類の名前は 9 種とも道具の名前と同じ言葉になる(FR-501)', () => {
    const document = documentWith(EXTRUDE);
    const cases: readonly (readonly [SolidFeature, string])[] = [
      [DRAFT, 'toolbar.machining.draft'],
      [MIRROR, 'toolbar.solid.mirror'],
      [TRANSFORM, 'toolbar.machining.transform'],
      [SCALE, 'toolbar.machining.scale'],
      [SWEEP, 'toolbar.solid.sweep'],
      [RIB, 'toolbar.machining.rib'],
      [EMBOSS, 'toolbar.machining.emboss'],
      [THREAD_SHAFT, 'toolbar.machining.threadShaft'],
      [SURFACE, 'toolbar.solid.surface'],
    ];
    for (const [feature, labelKey] of cases) {
      const summary = summarizeSolid(appendSolid(document, feature), feature);
      expect(summary.kindLabelKey).toBe(labelKey);
      expect(summary.name).toBe(feature.name);
    }
  });

  it('抜き勾配は対象の立体と選んだ面の数を出す', () => {
    const document = appendSolid(documentWith(EXTRUDE), DRAFT);
    const summary = summarizeSolid(document, DRAFT);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.targetBody', name: '押し出し1', elementId: 'extrude-1' },
    ]);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.draftNeutralFace', count: 1 },
      { labelKey: 'propertyPanel.draftFaces', count: 2 },
    ]);
  });

  it('ミラーは対象を消費しないので、木では元も鏡像も「使われた」印にならない', () => {
    const document = appendSolid(documentWith(EXTRUDE), MIRROR);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(false);
    expect(summarizeSolid(document, MIRROR).consumed).toBe(false);
  });

  it('移動/回転は対象を消費するので、木で元が「使われた」印になる', () => {
    const document = appendSolid(documentWith(EXTRUDE), TRANSFORM);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(true);
    expect(summarizeSolid(document, TRANSFORM).consumed).toBe(false);
  });

  it('スイープは対象を取らないので、断面の名前だけを出す', () => {
    const document = appendSolid(documentWith(), SWEEP);
    expect(summarizeSolid(document, SWEEP).references).toEqual([
      { labelKey: 'propertyPanel.profile', name: 'スケッチ1 / 面1', elementId: 'face-1' },
    ]);
  });

  it('エンボスは対象の立体と輪郭の面の 2 つを出す', () => {
    const document = appendSolid(documentWith(EXTRUDE), EMBOSS);
    const summary = summarizeSolid(document, EMBOSS);
    expect(summary.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.targetBody',
      'propertyPanel.profile',
    ]);
  });

  it('点集合パターンは点パターンとして数え、並べる点の数を出す(FR-425)', () => {
    const document = appendSolid(documentWith(EXTRUDE), POINT_PATTERN);
    expect(solidKindOf(POINT_PATTERN)).toBe('pointPattern');
    const summary = summarizeSolid(document, POINT_PATTERN);
    expect(summary.kindLabelKey).toBe('toolbar.machining.pointPattern');
    expect(summary.fields).toEqual([]);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.patternPoints', count: 2 },
    ]);
  });

  it('欄をまだ持たないので、式の書き戻しは同じものを返す(欄を出すのは タスク52)', () => {
    const value = expressionValueFromNumber(9);
    for (const feature of [DRAFT, MIRROR, TRANSFORM, SCALE, SWEEP, RIB, EMBOSS, THREAD_SHAFT, SURFACE]) {
      expect(setSolidField(feature, 'distance', value)).toBe(feature);
    }
    // 点集合パターンも間隔・個数の欄を持たない。
    expect(setSolidField(POINT_PATTERN, 'count', value)).toBe(POINT_PATTERN);
  });

  it('種類の名前の表は SolidLabelKey を 1 つ残らず持つ(数え漏れを型で止める)', () => {
    // model の `SOLID_LABELS` と同じ 34 個(P2〜P5 タスク43 の 30 個 +
    // タスク46 が前倒ししたくり抜き 1 個 + タスク27c の切断 1 個 +
    // P6 タスク20 の読み込んだ形 2 個)。
    expect(Object.keys(SOLID_KIND_LABEL_KEYS)).toHaveLength(34);
    expect(SOLID_KIND_LABEL_KEYS.draft).toBe('toolbar.machining.draft');
    expect(SOLID_KIND_LABEL_KEYS.pointPattern).toBe('toolbar.machining.pointPattern');
    expect(SOLID_KIND_LABEL_KEYS.shell).toBe('toolbar.machining.shell');
    expect(SOLID_KIND_LABEL_KEYS.cut).toBe('toolbar.machining.cut');
    expect(SOLID_KIND_LABEL_KEYS.importedSolid).toBe('toolbar.solid.importedSolid');
    expect(SOLID_KIND_LABEL_KEYS.importedMesh).toBe('toolbar.solid.importedMesh');
  });
});

describe('くり抜きの要約(FR-418、§2.12、P5 タスク46)', () => {
  const SHELL: ShellFeature = {
    id: 'shell-1',
    name: 'くり抜き1',
    suppressed: false,
    kind: 'shell',
    targetFeatureId: 'extrude-1',
    openFaces: [faceRef(1)],
    thickness: expressionValueFromNumber(2),
    outward: false,
  };

  it('種類の名前は道具の名前と同じ言葉になる(FR-501)', () => {
    const document = appendSolid(documentWith(EXTRUDE), SHELL);
    const summary = summarizeSolid(document, SHELL);
    expect(summary.kind).toBe('shell');
    expect(summary.kindLabelKey).toBe('toolbar.machining.shell');
    expect(summary.name).toBe('くり抜き1');
  });

  it('対象の立体と開ける面の数を出す', () => {
    const document = appendSolid(documentWith(EXTRUDE), SHELL);
    const summary = summarizeSolid(document, SHELL);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.targetBody', name: '押し出し1', elementId: 'extrude-1' },
    ]);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.shellOpenFaces', count: 1 },
    ]);
  });

  it('開ける面が 0 枚でも要約できる(中だけが空になるくり抜き)', () => {
    const closed: ShellFeature = { ...SHELL, openFaces: [] };
    const document = appendSolid(documentWith(EXTRUDE), closed);
    expect(summarizeSolid(document, closed).subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.shellOpenFaces', count: 0 },
    ]);
  });

  it('くり抜きは対象を消費するので、木で元が「使われた」印になる', () => {
    const document = appendSolid(documentWith(EXTRUDE), SHELL);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(true);
    expect(summarizeSolid(document, SHELL).consumed).toBe(false);
  });
});

describe('切断の要約(FR-432、§2.9b、P5 タスク27c)', () => {
  const CUT: CutFeature = {
    id: 'cut-1',
    name: '切断1',
    suppressed: false,
    kind: 'cut',
    targetFeatureId: 'extrude-1',
    plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(5) },
    keep: 'positive',
    pairedWith: null,
  };

  it('木に出す種類の名前は道具の名前と同じ「切断」になる(FR-501)', () => {
    const document = appendSolid(documentWith(EXTRUDE), CUT);
    const summary = summarizeSolid(document, CUT);
    expect(solidKindOf(CUT)).toBe('cut');
    expect(summary.kind).toBe('cut');
    expect(summary.kindLabelKey).toBe('toolbar.machining.cut');
    expect(summary.name).toBe('切断1');
  });

  it('切った相手の立体と、作図面からずらす距離の欄・残す側のつまみを出す(タスク27f)', () => {
    const document = appendSolid(documentWith(EXTRUDE), CUT);
    const summary = summarizeSolid(document, CUT);
    expect(summary.references).toEqual([
      { labelKey: 'propertyPanel.targetBody', name: '押し出し1', elementId: 'extrude-1' },
    ]);
    expect(summary.fields.map((field) => field.key)).toEqual(['planeOffset']);
    expect(summary.fields[0].value.display).toBe('5');
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['cutKeepOpposite']);
    expect(summary.toggles[0].value).toBe(false);
    expect(summary.subShapeCounts).toEqual([]);
  });

  it('切断は対象を消費するので、木で元が「使われた」印になる', () => {
    const document = appendSolid(documentWith(EXTRUDE), CUT);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(true);
    expect(summarizeSolid(document, CUT).consumed).toBe(false);
  });

  it('対になった 2 つの切断は、どちらも画面に残る(§0.a-0.58)', () => {
    const paired: CutFeature = {
      ...CUT,
      id: 'cut-2',
      name: '切断2',
      keep: 'negative',
      pairedWith: 'cut-1',
    };
    const document = appendSolid(appendSolid(documentWith(EXTRUDE), CUT), paired);
    expect(summarizeSolid(document, CUT).consumed).toBe(false);
    expect(summarizeSolid(document, paired).consumed).toBe(false);
    expect(summarizeSolid(document, EXTRUDE).consumed).toBe(true);
  });

  it('欄をまだ持たないので、式の書き戻しは同じものを返す(欄を出すのは タスク27f)', () => {
    expect(setSolidField(CUT, 'distance', expressionValueFromNumber(9))).toBe(CUT);
  });
});

// ---------------------------------------------------------------------------
// P5 タスク52・27f・55: Should / Could 群と切断のプロパティ(欄・つまみ・選択肢)。
//
// 「木に種類の名前が出る」までだった枝へ、式の欄・つまみ・選択肢と書き戻しを入れた。
// **効かない欄を出さない**(NFR-UX-2)ことと、**省略できる欄は必ず model の口
// (`extrudeShapingOf` / `holeEntryOf` / `filletRadiusOf`)を通す**ことをここで固定する。
// ---------------------------------------------------------------------------

describe('押し出しの終わり方・傾き・薄板(FR-415、FR-401、FR-416。タスク52・55)', () => {
  it('終わり方を「両側へ」にすると、end と P2 からの symmetric が必ず揃う', () => {
    const next = setSolidChoice(EXTRUDE, 'extrudeEnd', 'symmetric');
    expect(next.kind === 'extrude' ? next.end : null).toEqual({ kind: 'symmetric' });
    expect(next.kind === 'extrude' ? next.symmetric : null).toBe(true);
    // 省略できる欄の読み口も同じ答えを返す(既定値をどこにも写していない)。
    expect(next.kind === 'extrude' ? extrudeShapingOf(next).end : null).toEqual({
      kind: 'symmetric',
    });
  });

  it('終わり方を「距離」へ戻すと symmetric も切へ戻る', () => {
    const both = setSolidChoice(EXTRUDE, 'extrudeEnd', 'symmetric');
    const back = setSolidChoice(both, 'extrudeEnd', 'distance');
    expect(back.kind === 'extrude' ? back.symmetric : null).toBe(false);
    expect(back.kind === 'extrude' ? back.end : null).toEqual({ kind: 'distance' });
  });

  it('終わり方に「次の面まで」を選べる', () => {
    const next = setSolidChoice(EXTRUDE, 'extrudeEnd', 'toNext');
    expect(next.kind === 'extrude' ? next.end : null).toEqual({ kind: 'toNext' });
  });

  it('「選んだ面まで」はプロパティからは選べない(面を指す操作が要る)', () => {
    expect(setSolidChoice(EXTRUDE, 'extrudeEnd', 'toFace')).toBe(EXTRUDE);
  });

  it('いま「選んだ面まで」で作られているときだけ、その選択肢が一覧に出る', () => {
    const toFace: ExtrudeFeature = { ...EXTRUDE, end: { kind: 'toFace', face: faceRef(0) } };
    const summary = summarizeSolid(documentWith(toFace), toFace);
    const choice = summary.choices.find((candidate) => candidate.key === 'extrudeEnd');
    expect(choice?.options.map((option) => option.value)).toEqual([
      'distance',
      'symmetric',
      'toFace',
      'toNext',
    ]);
    expect(choice?.value).toBe('toFace');
  });

  it('「薄板にする」を入にすると厚みの欄と厚みの側の選択肢が出る(FR-416)', () => {
    const thin = setSolidToggle(EXTRUDE, 'thinWalled', true);
    expect(thin.kind === 'extrude' ? thin.thickness?.value : null).toBe(
      DEFAULT_EXTRUDE_THICKNESS_MM,
    );
    const summary = summarizeSolid(documentWith(thin), thin);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'distance',
      'taperAngle',
      'extrudeThickness',
    ]);
    expect(summary.choices.map((choice) => choice.key)).toEqual(['extrudeEnd', 'thicknessSide']);
  });

  it('「薄板にする」を切ると厚みは null(中実)へ戻り、欄も消える', () => {
    const thin = setSolidToggle(EXTRUDE, 'thinWalled', true);
    const solid = setSolidToggle(thin, 'thinWalled', false);
    expect(solid.kind === 'extrude' ? solid.thickness : undefined).toBeNull();
    expect(summarizeSolid(documentWith(solid), solid).fields.map((field) => field.key)).toEqual([
      'distance',
      'taperAngle',
    ]);
  });

  it('中実のままでは厚みの欄も厚みの側も書き戻せない(効かない値を保存しない)', () => {
    expect(setSolidField(EXTRUDE, 'extrudeThickness', expressionValueFromNumber(2))).toBe(EXTRUDE);
    expect(setSolidChoice(EXTRUDE, 'thicknessSide', 'outer')).toBe(EXTRUDE);
  });

  it('薄板にしていれば厚みの側を選び直せる', () => {
    const thin = setSolidToggle(EXTRUDE, 'thinWalled', true);
    const outer = setSolidChoice(thin, 'thicknessSide', 'outer');
    expect(outer.kind === 'extrude' ? outer.thicknessSide : null).toBe('outer');
  });

  it('側面の傾きは式のまま書き戻せ、向きはつまみで決まる(FR-401)', () => {
    const angled = setSolidField(EXTRUDE, 'taperAngle', {
      source: '2+3',
      value: 5,
      display: '5',
    });
    expect(angled.kind === 'extrude' ? angled.taperAngle?.source : null).toBe('2+3');
    const outward = setSolidToggle(angled, 'taperOutward', true);
    expect(outward.kind === 'extrude' ? outward.taperOutward : null).toBe(true);
  });

  it('側面の傾きの欄は model の上限(60 度)を範囲として持つ(NFR-UX-5)', () => {
    const summary = summarizeSolid(documentWith(EXTRUDE), EXTRUDE);
    const taper = summary.fields.find((field) => field.key === 'taperAngle');
    expect(taper?.range).toEqual({
      min: 0,
      minInclusive: true,
      max: MAX_TAPER_ANGLE_DEGREES,
      maxInclusive: true,
    });
  });
});

describe('穴の入口(ざぐり・皿もみ、FR-422。タスク52)', () => {
  it('ざぐりを選ぶと径と深さの欄が既定で出る(§0.a-0.39)', () => {
    const bored = setSolidChoice(HOLE_THROUGH, 'holeEntry', 'counterbore');
    expect(holeEntryOf(bored.kind === 'hole' ? bored : HOLE_THROUGH)).toEqual({
      kind: 'counterbore',
      diameter: expressionValueFromNumber(DEFAULT_COUNTERBORE_DIAMETER_MM),
      depth: expressionValueFromNumber(DEFAULT_COUNTERBORE_DEPTH_MM),
    });
    const summary = summarizeSolid(documentWith(EXTRUDE, bored), bored);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'diameter',
      'tiltAngle',
      'tiltAzimuth',
      'counterboreDiameter',
      'counterboreDepth',
    ]);
  });

  it('皿もみを選ぶと頭径と開き角の欄が既定で出る', () => {
    const sunk = setSolidChoice(HOLE_THROUGH, 'holeEntry', 'countersink');
    expect(holeEntryOf(sunk.kind === 'hole' ? sunk : HOLE_THROUGH)).toEqual({
      kind: 'countersink',
      diameter: expressionValueFromNumber(DEFAULT_COUNTERSINK_DIAMETER_MM),
      angle: expressionValueFromNumber(DEFAULT_COUNTERSINK_ANGLE_DEGREES),
    });
    const summary = summarizeSolid(documentWith(EXTRUDE, sunk), sunk);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'diameter',
      'tiltAngle',
      'tiltAzimuth',
      'countersinkDiameter',
      'countersinkAngle',
    ]);
  });

  it('入口の欄は式のまま書き戻せる(FR-202)', () => {
    const bored = setSolidChoice(HOLE_THROUGH, 'holeEntry', 'counterbore');
    const wide = setSolidField(bored, 'counterboreDiameter', {
      source: '5*2',
      value: 10,
      display: '10',
    });
    expect(wide.kind === 'hole' ? holeEntryOf(wide) : null).toEqual({
      kind: 'counterbore',
      diameter: { source: '5*2', value: 10, display: '10' },
      depth: expressionValueFromNumber(DEFAULT_COUNTERBORE_DEPTH_MM),
    });
  });

  it('いまの入口の形に合わない欄は書き戻さない', () => {
    const bored = setSolidChoice(HOLE_THROUGH, 'holeEntry', 'counterbore');
    expect(setSolidField(bored, 'countersinkAngle', expressionValueFromNumber(60))).toBe(bored);
  });

  it('同じ入口を選び直しても何も変えない(既定へ戻して打った値を消さない)', () => {
    expect(setSolidChoice(HOLE_THROUGH, 'holeEntry', 'plain')).toBe(HOLE_THROUGH);
  });

  it('ねじ穴も同じ入口の欄と選択肢を持つ', () => {
    const bored = setSolidChoice(THREAD_HOLE, 'holeEntry', 'counterbore');
    const summary = summarizeSolid(documentWith(EXTRUDE, bored), bored);
    expect(summary.fields.map((field) => field.key)).toContain('counterboreDepth');
    expect(summary.choices.map((choice) => choice.key)).toContain('holeEntry');
  });
});

describe('可変半径フィレット(FR-426。タスク55)', () => {
  it('「終わりを別の半径に」を入にすると始点・終点の 2 欄になる', () => {
    const variable = setSolidToggle(FILLET, 'variableRadius', true);
    expect(variable.kind === 'fillet' ? filletRadiusOf(variable) : null).toEqual({
      kind: 'variable',
      start: expressionValueFromNumber(2),
      end: expressionValueFromNumber(DEFAULT_FILLET_RADIUS_END_MM),
    });
    const summary = summarizeSolid(documentWith(EXTRUDE, variable), variable);
    expect(summary.fields.map((field) => field.key)).toEqual(['radius', 'radiusEnd']);
  });

  it('切ると一定半径へ戻り、欄も 1 つへ戻る', () => {
    const variable = setSolidToggle(FILLET, 'variableRadius', true);
    const constant = setSolidToggle(variable, 'variableRadius', false);
    expect(constant.kind === 'fillet' ? filletRadiusOf(constant).kind : null).toBe('constant');
    expect(
      summarizeSolid(documentWith(EXTRUDE, constant), constant).fields.map((field) => field.key),
    ).toEqual(['radius']);
  });

  it('一定半径のままでは終点側の半径を書き戻せない', () => {
    expect(setSolidField(FILLET, 'radiusEnd', expressionValueFromNumber(5))).toBe(FILLET);
  });

  it('可変半径にしていれば終点側の半径を式のまま書き戻せる', () => {
    const variable = setSolidToggle(FILLET, 'variableRadius', true);
    const next = setSolidField(variable, 'radiusEnd', { source: '2*4', value: 8, display: '8' });
    expect(next.kind === 'fillet' ? next.radiusEnd?.source : null).toBe('2*4');
  });
});

describe('抜き勾配・ミラー・移動/回転・拡大縮小のプロパティ(FR-417、FR-419、FR-424。タスク52)', () => {
  it('抜き勾配は角度の欄と向きのつまみを持ち、上限は model の 60 度', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), DRAFT), DRAFT);
    expect(summary.fields.map((field) => field.key)).toEqual(['draftAngle']);
    expect(summary.fields[0].range).toEqual({
      min: 0,
      minInclusive: false,
      max: MAX_DRAFT_ANGLE_DEGREES,
      maxInclusive: true,
    });
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['reversed']);
  });

  it('抜き勾配の角度と向きを書き戻せる', () => {
    const angled = setSolidField(DRAFT, 'draftAngle', { source: '1+2', value: 3, display: '3' });
    expect(angled.kind === 'draft' ? angled.angle.source : null).toBe('1+2');
    const flipped = setSolidToggle(DRAFT, 'reversed', true);
    expect(flipped.kind === 'draft' ? flipped.reversed : null).toBe(true);
  });

  it('ミラーは鏡にする面の 3 択を持ち、選び直せる(FR-419)', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), MIRROR), MIRROR);
    const choice = summary.choices[0];
    expect(choice?.key).toBe('mirrorPlane');
    expect(choice?.value).toBe('xy');
    expect(choice?.options.map((option) => option.value)).toEqual(['xy', 'xz', 'yz']);
    const yz = setSolidChoice(MIRROR, 'mirrorPlane', 'yz');
    expect(yz.kind === 'mirror' ? yz.plane : null).toEqual({ kind: 'workPlane', planeId: 'yz' });
  });

  it('立体の面を鏡にしているときは、その 1 つだけを出す(画面で選び直すもの)', () => {
    const onFace: MirrorFeature = { ...MIRROR, plane: { kind: 'face', face: faceRef(0) } };
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), onFace), onFace);
    expect(summary.choices[0]?.options.map((option) => option.value)).toEqual(['face']);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.selectedFaces', count: 1 },
    ]);
    // 基準の 3 面は一覧に出ないので、プロパティから面の鏡を外すことはできない
    // (外したいときは道具から作り直す。回転の線分の軸・穴の面と同じ切り分け)。
    expect(summary.choices[0]?.value).toBe('face');
  });

  it('移動/回転は X・Y・Z の 3 欄を持ち、回さないときは角度の欄が出ない', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), TRANSFORM), TRANSFORM);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'translationX',
      'translationY',
      'translationZ',
    ]);
    expect(summary.choices[0]?.key).toBe('transformAxis');
    expect(summary.choices[0]?.value).toBe('none');
  });

  it('回す軸を選ぶと角度の欄が出て、書き戻せる', () => {
    const spun = setSolidChoice(TRANSFORM, 'transformAxis', 'z');
    expect(spun.kind === 'transform' ? spun.rotationAxis : null).toEqual({
      kind: 'world',
      axis: 'z',
    });
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), spun), spun);
    expect(summary.fields.map((field) => field.key)).toEqual([
      'translationX',
      'translationY',
      'translationZ',
      'rotationAngle',
    ]);
    const angled = setSolidField(spun, 'rotationAngle', { source: '45*2', value: 90, display: '90' });
    expect(angled.kind === 'transform' ? angled.rotationAngle.source : null).toBe('45*2');
  });

  it('「回さない」へ戻すと軸が null になり、角度の欄も消える', () => {
    const spun = setSolidChoice(TRANSFORM, 'transformAxis', 'z');
    const still = setSolidChoice(spun, 'transformAxis', 'none');
    expect(still.kind === 'transform' ? still.rotationAxis : undefined).toBeNull();
  });

  it('移動量は 3 欄それぞれを式のまま書き戻せる', () => {
    const moved = setSolidField(TRANSFORM, 'translationY', {
      source: '3*3',
      value: 9,
      display: '9',
    });
    expect(moved.kind === 'transform' ? moved.translation[1].source : null).toBe('3*3');
    expect(moved.kind === 'transform' ? moved.translation[0].display : null).toBe('10');
  });

  it('拡大縮小は「軸ごと」で欄が 1 つから 3 つへ増える(FR-424)', () => {
    const perAxis = setSolidToggle(SCALE, 'scalePerAxis', true);
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), perAxis), perAxis);
    expect(summary.fields.map((field) => field.key)).toEqual(['scaleX', 'scaleY', 'scaleZ']);
    // 切り替えたときは、いまの倍率をそのまま 3 つへ引き継ぐ(形が急に変わらない)。
    expect(summary.fields.every((field) => field.value.display === '2')).toBe(true);
  });

  it('倍率の欄は model の上下限を範囲として持つ', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), SCALE), SCALE);
    expect(summary.fields[0].range).toEqual({
      min: MIN_SCALE,
      minInclusive: true,
      max: MAX_SCALE,
      maxInclusive: true,
    });
  });

  it('拡大縮小は「動かさない点」を読める 1 行として出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), SCALE), SCALE);
    expect(summary.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.targetBody',
      'propertyPanel.scaleOrigin',
    ]);
    expect(summary.references[1].name).toBe('原点');
  });

  it('軸ごとの倍率をそれぞれ書き戻せる', () => {
    const perAxis = setSolidToggle(SCALE, 'scalePerAxis', true);
    const next = setSolidField(perAxis, 'scaleZ', { source: '1/2', value: 0.5, display: '0.5' });
    expect(next.kind === 'scale' && next.factor.kind === 'perAxis' ? next.factor.z.source : null).toBe(
      '1/2',
    );
    // 全体の倍率の欄は「軸ごと」では受け付けない(効かない欄を保存しない)。
    expect(setSolidField(perAxis, 'scaleFactor', expressionValueFromNumber(3))).toBe(perAxis);
  });
});

describe('スイープ・リブ・エンボス・外ねじのプロパティ(FR-409、FR-420、FR-421、FR-423。タスク52)', () => {
  it('スイープは経路の線の数と「曲がりに合わせて回す」のつまみを出す', () => {
    const document = appendSolid(documentWith(), SWEEP);
    const summary = summarizeSolid(document, SWEEP);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['sweepFrenet']);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.sweepPath', count: 1 },
    ]);
    const frenet = setSolidToggle(SWEEP, 'sweepFrenet', true);
    expect(frenet.kind === 'sweep' ? frenet.frenet : null).toBe(true);
  });

  it('リブは厚みの欄・付ける側の 3 択・伸ばすつまみを出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), RIB), RIB);
    expect(summary.fields.map((field) => field.key)).toEqual(['ribThickness']);
    expect(summary.choices[0]?.key).toBe('ribSide');
    expect(summary.choices[0]?.options.map((option) => option.value)).toEqual([
      'both',
      'positive',
      'negative',
    ]);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['ribExtendToBody']);
  });

  it('リブの厚み・側・伸ばすかを書き戻せる', () => {
    const thick = setSolidField(RIB, 'ribThickness', { source: '1+1', value: 2, display: '2' });
    expect(thick.kind === 'rib' ? thick.thickness.source : null).toBe('1+1');
    expect(setSolidChoice(RIB, 'ribSide', 'positive')).toEqual({ ...RIB, side: 'positive' });
    expect(setSolidToggle(RIB, 'ribExtendToBody', false)).toEqual({ ...RIB, extendToBody: false });
  });

  it('エンボスは高さの欄と「浮き出す」のつまみを出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), EMBOSS), EMBOSS);
    expect(summary.fields.map((field) => field.key)).toEqual(['embossHeight']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['raised']);
    expect(setSolidToggle(EMBOSS, 'raised', true)).toEqual({ ...EMBOSS, raised: true });
  });

  it('外ねじはピッチ・長さの欄と、呼び・系列・端の 3 択を出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), THREAD_SHAFT), THREAD_SHAFT);
    expect(summary.fields.map((field) => field.key)).toEqual(['pitch', 'threadLength']);
    expect(summary.choices.map((choice) => choice.key)).toEqual([
      'threadShaftNominal',
      'threadShaftSeries',
      'threadShaftFromEnd',
    ]);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['modeledThread']);
  });

  it('外ねじの呼びを変えるとピッチも規格表から入り直す(FR-406 と同じ表)', () => {
    const m10 = setSolidChoice(THREAD_SHAFT, 'threadShaftNominal', 'M10');
    expect(m10.kind === 'threadShaft' ? m10.nominal : null).toBe('M10');
    expect(m10.kind === 'threadShaft' ? m10.pitch.value : null).toBe(1.5);
  });

  it('外ねじの系列を細目にするとピッチだけが変わる', () => {
    const fine = setSolidChoice(THREAD_SHAFT, 'threadShaftSeries', 'fine');
    expect(fine.kind === 'threadShaft' ? fine.series : null).toBe('fine');
    expect(fine.kind === 'threadShaft' ? fine.pitch.value : null).toBe(0.75);
  });

  it('外ねじの切り始める端と実らせんを切り替えられる', () => {
    expect(setSolidChoice(THREAD_SHAFT, 'threadShaftFromEnd', 'last')).toEqual({
      ...THREAD_SHAFT,
      fromEnd: 'last',
    });
    expect(setSolidToggle(THREAD_SHAFT, 'modeledThread', true)).toEqual({
      ...THREAD_SHAFT,
      modeled: true,
    });
  });
});

describe('曲面のプロパティ(FR-428。タスク52)', () => {
  it('掛ける曲面は距離の欄・向きのつまみ・作り方の 3 択を出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(), SURFACE), SURFACE);
    expect(summary.fields.map((field) => field.key)).toEqual(['surfaceDistance']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['reversed']);
    expect(summary.choices[0]?.options.map((option) => option.value)).toEqual([
      'extrude',
      'revolve',
      'planar',
    ]);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.curveCount', count: 1 },
    ]);
  });

  it('同じ輪郭のまま「回す」へ作り直せる(角度の欄に入れ替わる)', () => {
    const revolved = setSolidChoice(SURFACE, 'surfaceOperation', 'revolve');
    expect(revolved.kind === 'surface' ? revolved.operation.kind : null).toBe('revolve');
    const summary = summarizeSolid(appendSolid(documentWith(), revolved), revolved);
    expect(summary.fields.map((field) => field.key)).toEqual(['surfaceAngle']);
  });

  it('「平らに張る」には式の欄が無い', () => {
    const planar = setSolidChoice(SURFACE, 'surfaceOperation', 'planar');
    const summary = summarizeSolid(appendSolid(documentWith(), planar), planar);
    expect(summary.fields).toEqual([]);
  });

  it('輪郭から作る曲面を、立体の面から作る曲面へは作り直さない(材料が違う)', () => {
    expect(setSolidChoice(SURFACE, 'surfaceOperation', 'offset')).toBe(SURFACE);
  });

  it('立体の面を写した曲面は「離す」へ作り直せ、離す距離の欄が出る', () => {
    const fromFace: SurfaceFeature = {
      ...SURFACE,
      operation: { kind: 'face', targetFeatureId: 'extrude-1', face: faceRef(0) },
    };
    const offset = setSolidChoice(fromFace, 'surfaceOperation', 'offset');
    expect(offset.kind === 'surface' ? offset.operation.kind : null).toBe('offset');
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), offset), offset);
    expect(summary.fields.map((field) => field.key)).toEqual(['surfaceOffset']);
    expect(summary.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.targetBody',
    ]);
  });

  it('つないだ曲面は「直線でつなぐ」のつまみを持つ', () => {
    const loft: SurfaceFeature = {
      ...SURFACE,
      operation: {
        kind: 'loft',
        sections: [
          { sketchId: 'sketch-1', curveIds: ['line-1'] },
          { sketchId: 'sketch-1', curveIds: ['line-2'] },
        ],
        ruled: false,
      },
    };
    const summary = summarizeSolid(appendSolid(documentWith(), loft), loft);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['surfaceRuled']);
    expect(summary.subShapeCounts).toEqual([
      { labelKey: 'propertyPanel.curveCount', count: 2 },
    ]);
    const ruled = setSolidToggle(loft, 'surfaceRuled', true);
    expect(ruled.kind === 'surface' && ruled.operation.kind === 'loft' ? ruled.operation.ruled : null).toBe(
      true,
    );
  });
});

describe('くり抜きのプロパティ(FR-418。タスク55)', () => {
  const SHELL_FEATURE: ShellFeature = {
    id: 'shell-1',
    name: 'くり抜き1',
    suppressed: false,
    kind: 'shell',
    targetFeatureId: 'extrude-1',
    openFaces: [faceRef(1)],
    thickness: expressionValueFromNumber(2),
    outward: false,
  };

  it('壁の厚さの欄と「外向き」のつまみを出す', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), SHELL_FEATURE), SHELL_FEATURE);
    expect(summary.fields.map((field) => field.key)).toEqual(['shellThickness']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['shellOutward']);
  });

  it('厚さは 0 より大きい数だけを受け付ける範囲を持つ(NFR-UX-5)', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), SHELL_FEATURE), SHELL_FEATURE);
    expect(summary.fields[0].range).toEqual({
      min: 0,
      minInclusive: false,
      max: null,
      maxInclusive: false,
    });
  });

  it('厚さと向きを書き戻せる', () => {
    const thick = setSolidField(SHELL_FEATURE, 'shellThickness', {
      source: '1+2',
      value: 3,
      display: '3',
    });
    expect(thick.kind === 'shell' ? thick.thickness.source : null).toBe('1+2');
    expect(setSolidToggle(SHELL_FEATURE, 'shellOutward', true)).toEqual({
      ...SHELL_FEATURE,
      outward: true,
    });
  });
});

describe('切断のプロパティ(FR-432。タスク27f)', () => {
  const CUT_AXIS: CutFeature = {
    id: 'cut-1',
    name: '切断1',
    suppressed: false,
    kind: 'cut',
    targetFeatureId: 'extrude-1',
    plane: {
      kind: 'pointAndAxis',
      point: { kind: 'point', pointId: 'point-1' },
      axis: { kind: 'world', axis: 'z' },
      tilt: expressionValueFromNumber(0),
      azimuth: expressionValueFromNumber(0),
    },
    keep: 'positive',
    pairedWith: null,
  };

  it('点と軸で切るときは傾き角と方位角の欄が出る(§2.9b.1)', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), CUT_AXIS), CUT_AXIS);
    expect(summary.fields.map((field) => field.key)).toEqual(['tiltAngle', 'tiltAzimuth']);
  });

  it('傾き角の欄は 0 度以上 180 度未満の範囲を持つ(断りと同じ値)', () => {
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), CUT_AXIS), CUT_AXIS);
    expect(summary.fields[0].range).toEqual({
      min: 0,
      minInclusive: true,
      max: 180,
      maxInclusive: false,
    });
  });

  it('傾き角を式のまま書き戻すと、切る面の中の式が変わる(FR-502)', () => {
    const tilted = setSolidField(CUT_AXIS, 'tiltAngle', {
      source: '15*2',
      value: 30,
      display: '30',
    });
    expect(tilted.kind === 'cut' && tilted.plane.kind === 'pointAndAxis' ? tilted.plane.tilt : null).toEqual(
      { source: '15*2', value: 30, display: '30' },
    );
    expect(CUT_AXIS.plane.kind === 'pointAndAxis' ? CUT_AXIS.plane.tilt.value : null).toBe(0);
  });

  it('3 点を通る切り方には式の欄が無い(位置は点が決める)', () => {
    const threePoints: CutFeature = {
      ...CUT_AXIS,
      plane: {
        kind: 'threePoints',
        p1: { kind: 'point', pointId: 'point-1' },
        p2: { kind: 'point', pointId: 'point-2' },
        p3: { kind: 'point', pointId: 'point-3' },
      },
    };
    const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), threePoints), threePoints);
    expect(summary.fields).toEqual([]);
  });

  it('決め方に合わない欄は書き戻さない', () => {
    expect(setSolidField(CUT_AXIS, 'planeOffset', expressionValueFromNumber(3))).toBe(CUT_AXIS);
  });

  it('「反対側を残す」で残す側が裏返る(§0.a-0.57)', () => {
    const flipped = setSolidToggle(CUT_AXIS, 'cutKeepOpposite', true);
    expect(flipped.kind === 'cut' ? flipped.keep : null).toBe('negative');
    const back = setSolidToggle(flipped, 'cutKeepOpposite', false);
    expect(back.kind === 'cut' ? back.keep : null).toBe('positive');
  });

  it('対で作られた 2 つ目は、相手への案内を参照に出す(§0.a-0.58)', () => {
    const paired: CutFeature = {
      ...CUT_AXIS,
      id: 'cut-2',
      name: '切断2',
      keep: 'negative',
      pairedWith: 'cut-1',
    };
    const document = appendSolid(appendSolid(documentWith(EXTRUDE), CUT_AXIS), paired);
    const summary = summarizeSolid(document, paired);
    expect(summary.references.map((reference) => reference.labelKey)).toEqual([
      'propertyPanel.targetBody',
      'propertyPanel.cutPaired',
    ]);
    expect(summary.references[1]).toEqual({
      labelKey: 'propertyPanel.cutPaired',
      name: '切断1',
      elementId: 'cut-1',
    });
  });
});

describe('読み込んだ形の要約(FR-802、P6 §2.8、タスク20)', () => {
  const IMPORTED_SOLID: ImportedSolidFeature = {
    id: 'imported-solid-1',
    name: '読み込んだ形1',
    suppressed: false,
    kind: 'importedSolid',
    shapeRef: 'shape-1',
    source: {
      format: 'step',
      fileName: 'bracket.step',
      unit: 'mm',
      byteLength: 20480,
    },
    bodyKind: 'solid',
  };

  const IMPORTED_MESH: ImportedMeshFeature = {
    id: 'imported-mesh-1',
    name: '読み込んだ三角形の形1',
    suppressed: false,
    kind: 'importedMesh',
    meshRef: 'mesh-1',
    source: {
      format: 'stl',
      fileName: 'scan.stl',
      unit: 'inch',
      byteLength: 102400,
    },
    triangleCount: 4820,
    volume: 12345,
  };

  it('読み込んだ形(B-rep)は、素性と種類(solid/shell)を読み取り専用の参照で出し、式の欄は1つも無い', () => {
    const document = appendSolid(documentWith(EXTRUDE), IMPORTED_SOLID);
    const summary = summarizeSolid(document, IMPORTED_SOLID);
    expect(summary.kind).toBe('importedSolid');
    expect(summary.kindLabelKey).toBe('toolbar.solid.importedSolid');
    expect(summary.fields).toEqual([]);
    expect(summary.toggles).toEqual([]);
    expect(summary.choices).toEqual([]);
    expect(summary.references).toEqual([
      {
        labelKey: 'propertyPanel.importedFileName',
        name: 'bracket.step',
        elementId: 'imported-solid-1',
      },
      { labelKey: 'propertyPanel.importedFormat', name: 'STEP', elementId: 'imported-solid-1' },
      { labelKey: 'propertyPanel.importedUnit', name: 'mm', elementId: 'imported-solid-1' },
      { labelKey: 'propertyPanel.importedSize', name: '20480', elementId: 'imported-solid-1' },
      { labelKey: 'propertyPanel.importedBodyKind', name: 'Solid', elementId: 'imported-solid-1' },
    ]);
  });

  it('読み込んだ三角形の形は、素性に加えて三角形の数と体積を出す', () => {
    const document = appendSolid(documentWith(EXTRUDE), IMPORTED_MESH);
    const summary = summarizeSolid(document, IMPORTED_MESH);
    expect(summary.kind).toBe('importedMesh');
    expect(summary.kindLabelKey).toBe('toolbar.solid.importedMesh');
    expect(summary.fields).toEqual([]);
    expect(summary.references.slice(4)).toEqual([
      { labelKey: 'propertyPanel.triangleCount', name: '4820', elementId: 'imported-mesh-1' },
      { labelKey: 'propertyPanel.volume', name: '12345', elementId: 'imported-mesh-1' },
    ]);
    // 形式・単位は STL と inch(この見本は STEP/mm の見本と違う組み合わせにしてある)。
    expect(summary.references[1]).toEqual({
      labelKey: 'propertyPanel.importedFormat',
      name: 'STL',
      elementId: 'imported-mesh-1',
    });
    expect(summary.references[2]).toEqual({
      labelKey: 'propertyPanel.importedUnit',
      name: 'inch',
      elementId: 'imported-mesh-1',
    });
  });

  it('体積を測っていない(閉じていない)三角形の形は「—」を出す', () => {
    const noVolume: ImportedMeshFeature = { ...IMPORTED_MESH, id: 'imported-mesh-2', volume: undefined };
    const document = appendSolid(documentWith(EXTRUDE), noVolume);
    const summary = summarizeSolid(document, noVolume);
    expect(summary.references.at(-1)).toEqual({
      labelKey: 'propertyPanel.volume',
      name: '—',
      elementId: 'imported-mesh-2',
    });
  });

  it('式の欄が1つも無いので、書き戻しはそのまま返す(model の rebuildSolidFeature と同じ判断)', () => {
    const value = expressionValueFromNumber(9);
    expect(setSolidField(IMPORTED_SOLID, 'distance', value)).toBe(IMPORTED_SOLID);
    expect(setSolidField(IMPORTED_MESH, 'count', value)).toBe(IMPORTED_MESH);
  });
});

describe('プロパティの節の鍵(タスク52・27f・55)', () => {
  /** 検査に出す 15 種を 1 か所に並べる(数え漏れをここで止める)。 */
  const FEATURES: readonly SolidFeature[] = [
    EXTRUDE,
    HOLE_THROUGH,
    THREAD_HOLE,
    FILLET,
    DRAFT,
    MIRROR,
    TRANSFORM,
    SCALE,
    SWEEP,
    RIB,
    EMBOSS,
    THREAD_SHAFT,
    SURFACE,
    POINT_PATTERN,
  ];

  it('種類ごとに欄の鍵が重ならない(同じ欄を 2 度出さない)', () => {
    for (const feature of FEATURES) {
      const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), feature), feature);
      const keys = summary.fields.map((field) => field.key);
      expect(new Set(keys).size, feature.kind).toBe(keys.length);
    }
  });

  it('種類ごとに選択肢の鍵・つまみの鍵も重ならない', () => {
    for (const feature of FEATURES) {
      const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), feature), feature);
      const choiceKeys = summary.choices.map((choice) => choice.key);
      const toggleKeys = summary.toggles.map((toggle) => toggle.key);
      expect(new Set(choiceKeys).size, feature.kind).toBe(choiceKeys.length);
      expect(new Set(toggleKeys).size, feature.kind).toBe(toggleKeys.length);
    }
  });

  it('欄・つまみ・選択肢の見出しはすべて ja.json にある鍵で返す(NFR-MA-5)', () => {
    for (const feature of FEATURES) {
      const summary = summarizeSolid(appendSolid(documentWith(EXTRUDE), feature), feature);
      for (const field of summary.fields) {
        expect(MESSAGE_KEYS).toContain(field.labelKey);
        expect(MESSAGE_KEYS).toContain(field.tooltipKey);
      }
      for (const toggle of summary.toggles) {
        expect(MESSAGE_KEYS).toContain(toggle.labelKey);
      }
      for (const choice of summary.choices) {
        expect(MESSAGE_KEYS).toContain(choice.labelKey);
        for (const option of choice.options) {
          if (option.labelKey !== undefined) {
            expect(MESSAGE_KEYS).toContain(option.labelKey);
          }
        }
      }
      for (const entry of summary.subShapeCounts) {
        expect(MESSAGE_KEYS).toContain(entry.labelKey);
      }
    }
  });

  it('省略できる欄を持つ文書でも、既定の欄が最初から表示される(読み口を通している)', () => {
    // `end` / `taperAngle` / `thickness` / `entry` / `radiusEnd` を 1 つも持たない見本。
    expect(summarizeSolid(documentWith(EXTRUDE), EXTRUDE).choices[0]?.value).toBe('distance');
    expect(
      summarizeSolid(documentWith(EXTRUDE, HOLE_THROUGH), HOLE_THROUGH).choices[1]?.value,
    ).toBe('plain');
    expect(
      summarizeSolid(documentWith(EXTRUDE, FILLET), FILLET).toggles[0]?.value,
    ).toBe(false);
  });

  it('切る面の決め方の名前の表は PlaneSpec を 1 つ残らず持つ(7 種)', () => {
    expect(Object.keys(PLANE_SPEC_LABEL_KEYS)).toHaveLength(7);
    for (const key of Object.values(PLANE_SPEC_LABEL_KEYS)) {
      expect(MESSAGE_KEYS).toContain(key);
    }
  });
});
