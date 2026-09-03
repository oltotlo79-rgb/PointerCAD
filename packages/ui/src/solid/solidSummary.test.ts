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
  type ExtrudeFeature,
  type PartDocument,
  type PartRecomputeError,
  type RevolveFeature,
  type SewFeature,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SolidFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  buildTreeSections,
  formatVolume,
  missingValueKey,
  partErrorMessage,
  renameSolid,
  selectionKindLabelKeys,
  setSolidAxis,
  setSolidField,
  setSolidSuppressed,
  setSolidToggle,
  SOLID_KIND_LABEL_KEYS,
  solidForSelection,
  solidKindOf,
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
});
