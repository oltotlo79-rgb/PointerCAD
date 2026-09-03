import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendFeature,
  createEmptyPartDocument,
  DEFAULT_FACE_COLOR,
  DEFAULT_SEW_TOLERANCE_MM,
  liveBodyIds,
  replaceSketch,
  type PartDocument,
  type SketchDocument,
  type SketchFaceRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';
import {
  commitBoolean,
  commitBooleanFromSelection,
  commitExtrude,
  commitRevolve,
  commitSew,
  commitSolidInput,
  DEFAULT_EXTRUDE_DISTANCE,
  DEFAULT_REVOLVE_ANGLE,
  DEFAULT_REVOLVE_AXIS,
  DEFAULT_SEW_TOLERANCE,
  selectedBodyPair,
  selectedFaceRef,
  selectedFaceRefs,
  selectedLineRef,
  solidToolReadiness,
} from './solidCommands.js';

const SKETCH_ID = 'sketch-1';

/** 面フィーチャーを 1 枚だけ持つスケッチを作る。座標の妥当性は solidCommands の対象外。 */
function addFace(sketch: SketchDocument, id: string, name: string = id): SketchDocument {
  return appendFeature(sketch, {
    id,
    name,
    planeId: 'xy',
    kind: 'face',
    boundary: [],
    color: DEFAULT_FACE_COLOR,
  });
}

/** 線分フィーチャーを 1 本だけ持つスケッチへ足す(面でない要素の対照用)。 */
function addLine(sketch: SketchDocument, id: string, name: string = id): SketchDocument {
  return appendFeature(sketch, {
    id,
    name,
    planeId: 'xy',
    kind: 'line',
    from: { mode: 'absolute', x: expressionValueFromNumber(0), y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) },
    to: { mode: 'absolute', x: expressionValueFromNumber(10), y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) },
  });
}

/** 面を 0 枚以上持つ部品文書を作る。ソリッドの履歴は空。 */
function documentWithFaces(faceIds: readonly string[]): PartDocument {
  const base = createEmptyPartDocument();
  let sketch = base.sketches[0];
  for (const id of faceIds) {
    sketch = addFace(sketch, id);
  }
  return replaceSketch(base, sketch);
}

function faceRef(faceFeatureId: string): SketchFaceRef {
  return { sketchId: SKETCH_ID, faceFeatureId };
}

const DISTANCE_10 = expressionValueFromNumber(10);
const ANGLE_360 = expressionValueFromNumber(360);
const TOLERANCE_DEFAULT = expressionValueFromNumber(DEFAULT_SEW_TOLERANCE_MM);

describe('選択から面フィーチャーの参照を拾う(FR-401、FR-402)', () => {
  it('面が選ばれていれば参照を返す', () => {
    const document = documentWithFaces(['face-1']);
    expect(selectedFaceRef(document, ['face-1'])).toEqual({ ok: true, ref: faceRef('face-1') });
  });

  it('先頭の面 1 枚を使う(複数選んでも先頭)', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(selectedFaceRef(document, ['face-2', 'face-1'])).toEqual({
      ok: true,
      ref: faceRef('face-2'),
    });
  });

  it('面でない要素は読み飛ばして次を探す(判別は文書を引いて行う)', () => {
    const base = createEmptyPartDocument();
    const sketch = addFace(addLine(base.sketches[0], 'line-1'), 'face-1');
    const document = replaceSketch(base, sketch);
    expect(selectedFaceRef(document, ['line-1', 'face-1'])).toEqual({
      ok: true,
      ref: faceRef('face-1'),
    });
  });

  it('面が無ければ noFace', () => {
    const empty = createEmptyPartDocument();
    expect(selectedFaceRef(empty, [])).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
    const base = createEmptyPartDocument();
    const withLine = replaceSketch(base, addLine(base.sketches[0], 'line-1'));
    expect(selectedFaceRef(withLine, ['line-1'])).toEqual({
      ok: false,
      reasonKey: 'solidError.noFace',
    });
  });
});

describe('選択から縫合用の面参照を拾う(FR-403)', () => {
  it('2 枚以上ならそのまま順に返す', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(selectedFaceRefs(document, ['face-1', 'face-2'])).toEqual({
      ok: true,
      refs: [faceRef('face-1'), faceRef('face-2')],
    });
  });

  it('選んだ順を保つ', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(selectedFaceRefs(document, ['face-2', 'face-1'])).toEqual({
      ok: true,
      refs: [faceRef('face-2'), faceRef('face-1')],
    });
  });

  it('1 枚未満なら needTwoFaces', () => {
    const document = documentWithFaces(['face-1']);
    expect(selectedFaceRefs(document, [])).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoFaces',
    });
    expect(selectedFaceRefs(document, ['face-1'])).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoFaces',
    });
  });
});

describe('選択からブーリアンの対象・相手を決める(§0.a-0.6)', () => {
  const LIVE = ['extrude-1', 'extrude-2', 'extrude-3'];

  it('先に選んだものが対象、後(Shift)が相手', () => {
    expect(selectedBodyPair(['extrude-2', 'extrude-1'], LIVE)).toEqual({
      ok: true,
      targetFeatureId: 'extrude-2',
      toolFeatureId: 'extrude-1',
    });
  });

  it('面などボディでない選択は無視して数える', () => {
    expect(selectedBodyPair(['face-1', 'extrude-1', 'extrude-2'], LIVE)).toEqual({
      ok: true,
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'extrude-2',
    });
  });

  it('ボディの選択が 2 つでなければ needTwoBodies', () => {
    expect(selectedBodyPair(['extrude-1'], LIVE)).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoBodies',
    });
    expect(selectedBodyPair([], LIVE)).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoBodies',
    });
    expect(selectedBodyPair(['extrude-1', 'extrude-2', 'extrude-3'], LIVE)).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoBodies',
    });
  });
});

describe('commitExtrude(FR-401)', () => {
  it('面を渡すと押し出し 1 が履歴へ積まれる', () => {
    const document = documentWithFaces(['face-1']);
    const outcome = commitExtrude(document, {
      profile: faceRef('face-1'),
      distance: DISTANCE_10,
      reversed: false,
      symmetric: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids).toHaveLength(1);
    const feature = outcome.document.solids[0];
    expect(feature.id).toBe(outcome.featureId);
    expect(feature.name).toBe('押し出し1');
    expect(feature.kind === 'extrude' ? feature.distance.source : '').toBe('10');
    expect(feature.kind === 'extrude' ? feature.profile : null).toEqual(faceRef('face-1'));
    // 元の文書は変わらない(不変)。
    expect(document.solids).toHaveLength(0);
  });

  it('2 回押し出すと名前も id も重ならない', () => {
    const document = documentWithFaces(['face-1']);
    const first = commitExtrude(document, {
      profile: faceRef('face-1'),
      distance: DISTANCE_10,
      reversed: false,
      symmetric: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = commitExtrude(first.document, {
      profile: faceRef('face-1'),
      distance: DISTANCE_10,
      reversed: true,
      symmetric: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.document.solids.map((feature) => feature.name)).toEqual([
      '押し出し1',
      '押し出し2',
    ]);
    expect(second.document.solids.map((feature) => feature.id)).toEqual([
      'extrude-1',
      'extrude-2',
    ]);
  });

  it('参照先の面が無ければ noFace で断り、文書を変えない', () => {
    const document = documentWithFaces([]);
    const outcome = commitExtrude(document, {
      profile: faceRef('face-1'),
      distance: DISTANCE_10,
      reversed: false,
      symmetric: false,
    });
    expect(outcome).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
    expect(document.solids).toHaveLength(0);
  });

  it('sketchId が違っていても noFace', () => {
    const document = documentWithFaces(['face-1']);
    const outcome = commitExtrude(document, {
      profile: { sketchId: 'sketch-does-not-exist', faceFeatureId: 'face-1' },
      distance: DISTANCE_10,
      reversed: false,
      symmetric: false,
    });
    expect(outcome).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
  });
});

describe('commitRevolve(FR-402)', () => {
  it('面と軸を渡すと回転 1 が積まれる', () => {
    const document = documentWithFaces(['face-1']);
    const outcome = commitRevolve(document, {
      profile: faceRef('face-1'),
      axis: { kind: 'world', axis: 'z' },
      angle: ANGLE_360,
      reversed: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids).toHaveLength(1);
    const feature = outcome.document.solids[0];
    expect(feature.name).toBe('回転1');
    expect(feature.kind === 'revolve' ? feature.axis : null).toEqual({ kind: 'world', axis: 'z' });
    expect(feature.kind === 'revolve' ? feature.angle.value : null).toBe(360);
  });

  it('参照先の面が無ければ noFace', () => {
    const document = documentWithFaces([]);
    const outcome = commitRevolve(document, {
      profile: faceRef('face-1'),
      axis: { kind: 'world', axis: 'z' },
      angle: ANGLE_360,
      reversed: false,
    });
    expect(outcome).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
  });
});

describe('commitSew(FR-403)', () => {
  it('面 2 枚で縫合 1 が積まれる', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    const outcome = commitSew(document, {
      faces: [faceRef('face-1'), faceRef('face-2')],
      tolerance: TOLERANCE_DEFAULT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.solids[0];
    expect(feature.name).toBe('縫合1');
    expect(feature.kind === 'sew' ? feature.faces : []).toEqual([
      faceRef('face-1'),
      faceRef('face-2'),
    ]);
    expect(feature.kind === 'sew' ? feature.tolerance.value : null).toBe(DEFAULT_SEW_TOLERANCE_MM);
  });

  it('面が 2 枚未満なら needTwoFaces', () => {
    const document = documentWithFaces(['face-1']);
    expect(
      commitSew(document, { faces: [faceRef('face-1')], tolerance: TOLERANCE_DEFAULT }),
    ).toEqual({ ok: false, reasonKey: 'solidError.needTwoFaces' });
    expect(commitSew(document, { faces: [], tolerance: TOLERANCE_DEFAULT })).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoFaces',
    });
  });

  it('渡した面の参照先が無ければ noFace', () => {
    const document = documentWithFaces(['face-1']);
    expect(
      commitSew(document, {
        faces: [faceRef('face-1'), faceRef('face-missing')],
        tolerance: TOLERANCE_DEFAULT,
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.noFace' });
  });
});

describe('commitBoolean(FR-404、§0.a-0.5)', () => {
  /** 押し出しを 2 つ作って生きたボディを 2 つ用意する。 */
  function documentWithTwoBodies(): PartDocument {
    const withFace = documentWithFaces(['face-1']);
    const first = commitExtrude(withFace, {
      profile: faceRef('face-1'),
      distance: DISTANCE_10,
      reversed: false,
      symmetric: false,
    });
    if (!first.ok) {
      throw new Error('準備に失敗しました');
    }
    const second = commitExtrude(first.document, {
      profile: faceRef('face-1'),
      distance: expressionValueFromNumber(5),
      reversed: false,
      symmetric: false,
    });
    if (!second.ok) {
      throw new Error('準備に失敗しました');
    }
    return second.document;
  }

  it('和・差・積で名前の連番が演算ごとに分かれる', () => {
    const document = documentWithTwoBodies();
    expect(liveBodyIds(document)).toEqual(['extrude-1', 'extrude-2']);

    const union = commitBoolean(document, {
      operation: 'union',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'extrude-2',
    });
    expect(union.ok).toBe(true);
    if (!union.ok) {
      return;
    }
    const feature = union.document.solids[union.document.solids.length - 1];
    expect(feature.name).toBe('和1');
    expect(feature.kind === 'boolean' ? feature.targetFeatureId : '').toBe('extrude-1');
    expect(feature.kind === 'boolean' ? feature.toolFeatureId : '').toBe('extrude-2');

    const subtract = commitBoolean(document, {
      operation: 'subtract',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'extrude-2',
    });
    expect(subtract.ok && subtract.document.solids[subtract.document.solids.length - 1].name).toBe(
      '差1',
    );
  });

  it('対象・相手が liveBodyIds に無ければ noBody', () => {
    const document = documentWithTwoBodies();
    expect(
      commitBoolean(document, {
        operation: 'union',
        targetFeatureId: 'extrude-does-not-exist',
        toolFeatureId: 'extrude-2',
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.noBody' });
    expect(
      commitBoolean(document, {
        operation: 'union',
        targetFeatureId: 'extrude-1',
        toolFeatureId: 'extrude-does-not-exist',
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.noBody' });
  });

  it('消費済み(生きていない)ボディを指定しても noBody', () => {
    const document = documentWithTwoBodies();
    const union = commitBoolean(document, {
      operation: 'union',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'extrude-2',
    });
    if (!union.ok) {
      throw new Error('準備に失敗しました');
    }
    // extrude-1 と extrude-2 は union に消費され、もう生きていない。
    expect(liveBodyIds(union.document)).toEqual([union.featureId]);
    expect(
      commitBoolean(union.document, {
        operation: 'subtract',
        targetFeatureId: 'extrude-1',
        toolFeatureId: union.featureId,
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.noBody' });
  });

  it('同じボディを対象・相手にすると sameBody', () => {
    const document = documentWithTwoBodies();
    expect(
      commitBoolean(document, {
        operation: 'union',
        targetFeatureId: 'extrude-1',
        toolFeatureId: 'extrude-1',
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.sameBody' });
  });
});

describe('既定値(§0.a-0.8、§0.a-0.9、§0.a-0.7)', () => {
  it('押し出し距離は 10mm、回転角度は 360°、軸は Z、縫合の許容量は DEFAULT_SEW_TOLERANCE_MM', () => {
    expect(DEFAULT_EXTRUDE_DISTANCE.value).toBe(10);
    expect(DEFAULT_REVOLVE_ANGLE.value).toBe(360);
    expect(DEFAULT_REVOLVE_AXIS).toEqual({ kind: 'world', axis: 'z' });
    expect(DEFAULT_SEW_TOLERANCE.value).toBe(DEFAULT_SEW_TOLERANCE_MM);
  });
});

/** 面 1 枚と線分 1 本を持つ部品文書。回転軸の選択肢を試すのに使う。 */
function documentWithFaceAndLine(): PartDocument {
  const base = createEmptyPartDocument();
  return replaceSketch(base, addLine(addFace(base.sketches[0], 'face-1'), 'line-1'));
}

/** 押し出しを 2 つ作って生きたボディを 2 つ用意する(ブーリアンの準備)。 */
function documentWithTwoLiveBodies(): PartDocument {
  const withFace = documentWithFaces(['face-1']);
  const first = commitExtrude(withFace, {
    profile: faceRef('face-1'),
    distance: DISTANCE_10,
    reversed: false,
    symmetric: false,
  });
  if (!first.ok) {
    throw new Error('準備に失敗しました');
  }
  const second = commitExtrude(first.document, {
    profile: faceRef('face-1'),
    distance: expressionValueFromNumber(5),
    reversed: false,
    symmetric: false,
  });
  if (!second.ok) {
    throw new Error('準備に失敗しました');
  }
  return second.document;
}

describe('選択から回転軸の線分を拾う(§0.a-0.9)', () => {
  it('線分が選ばれていれば参照を返す', () => {
    const document = documentWithFaceAndLine();
    expect(selectedLineRef(document, ['line-1'])).toEqual({
      sketchId: SKETCH_ID,
      lineFeatureId: 'line-1',
    });
  });

  it('面などが混ざっていても線分だけを拾う', () => {
    const document = documentWithFaceAndLine();
    expect(selectedLineRef(document, ['face-1', 'line-1'])).toEqual({
      sketchId: SKETCH_ID,
      lineFeatureId: 'line-1',
    });
  });

  it('線分が選ばれていなければ undefined(失敗ではない)', () => {
    const document = documentWithFaceAndLine();
    expect(selectedLineRef(document, ['face-1'])).toBeUndefined();
    expect(selectedLineRef(document, [])).toBeUndefined();
  });
});

describe('solidToolReadiness(NFR-UX-5、6 種すべて)', () => {
  it('押し出し・回転は面が 1 枚選ばれていれば押せる', () => {
    const document = documentWithFaces(['face-1']);
    expect(solidToolReadiness(document, ['face-1'], 'extrude')).toEqual({
      ready: true,
      reasonKey: null,
    });
    expect(solidToolReadiness(document, ['face-1'], 'revolve')).toEqual({
      ready: true,
      reasonKey: null,
    });
  });

  it('押し出し・回転は面が無ければ noFace で押せない', () => {
    const document = documentWithFaces(['face-1']);
    expect(solidToolReadiness(document, [], 'extrude')).toEqual({
      ready: false,
      reasonKey: 'solidError.noFace',
    });
    expect(solidToolReadiness(document, [], 'revolve')).toEqual({
      ready: false,
      reasonKey: 'solidError.noFace',
    });
  });

  it('縫合は面が 2 枚以上選ばれていれば押せる', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(solidToolReadiness(document, ['face-1', 'face-2'], 'sew')).toEqual({
      ready: true,
      reasonKey: null,
    });
  });

  it('縫合は面が 1 枚だけなら needTwoFaces で押せない', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(solidToolReadiness(document, ['face-1'], 'sew')).toEqual({
      ready: false,
      reasonKey: 'solidError.needTwoFaces',
    });
  });

  it('和・差・積は生きた立体が 2 つ選ばれていれば押せる', () => {
    const document = documentWithTwoLiveBodies();
    const selection = ['extrude-1', 'extrude-2'];
    for (const tool of ['union', 'subtract', 'intersect'] as const) {
      expect(solidToolReadiness(document, selection, tool), tool).toEqual({
        ready: true,
        reasonKey: null,
      });
    }
  });

  it('和・差・積は立体が 1 つだけなら needTwoBodies で押せない', () => {
    const document = documentWithTwoLiveBodies();
    for (const tool of ['union', 'subtract', 'intersect'] as const) {
      expect(solidToolReadiness(document, ['extrude-1'], tool), tool).toEqual({
        ready: false,
        reasonKey: 'solidError.needTwoBodies',
      });
    }
  });

  it('面だけを選んでいるときの和・差・積は needTwoBodies(立体と面を取り違えない)', () => {
    const document = documentWithTwoLiveBodies();
    expect(solidToolReadiness(document, ['face-1'], 'union')).toEqual({
      ready: false,
      reasonKey: 'solidError.needTwoBodies',
    });
  });

  // P3 タスク24 が SolidToolId へ足した加工6種+ばね。本実装はタスク25・25b・28 が担当する。
  // ここでは型を網羅するだけの最小の枝(notYetAvailable)が動くことだけを確かめる。
  it('加工6種+ばねはまだ使えないので notYetAvailable', () => {
    const document = documentWithFaces(['face-1']);
    for (const tool of [
      'hole',
      'threadHole',
      'fillet',
      'chamfer',
      'linearPattern',
      'circularPattern',
      'spring',
    ] as const) {
      expect(solidToolReadiness(document, [], tool), tool).toEqual({
        ready: false,
        reasonKey: 'solidError.notYetAvailable',
      });
    }
  });
});

describe('commitSolidInput(その場入力の確定から作る)', () => {
  /** 押し出しの確定結果。値とつまみだけを差し替えて使う。 */
  function extrudeCommit(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
    return {
      kind: 'solid',
      tool: 'extrude',
      step: 'extrudeDistance',
      values: { distance: expressionValueFromNumber(25) },
      flags: { reversed: false, symmetric: false },
      ...overrides,
    };
  }

  it('押し出しは選択の面と入れた距離・つまみで作る', () => {
    const document = documentWithFaces(['face-1']);
    const outcome = commitSolidInput(
      document,
      ['face-1'],
      extrudeCommit({ flags: { reversed: true, symmetric: true } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.solids[0];
    expect(feature.kind === 'extrude' ? feature.distance.value : null).toBe(25);
    expect(feature.kind === 'extrude' ? feature.reversed : null).toBe(true);
    expect(feature.kind === 'extrude' ? feature.symmetric : null).toBe(true);
    expect(feature.kind === 'extrude' ? feature.profile : null).toEqual(faceRef('face-1'));
  });

  it('値もつまみも無ければ既定値で作る(NFR-UX-4)', () => {
    const document = documentWithFaces(['face-1']);
    const outcome = commitSolidInput(document, ['face-1'], {
      kind: 'solid',
      tool: 'extrude',
      step: 'extrudeDistance',
      values: {},
      flags: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.solids[0];
    expect(feature.kind === 'extrude' ? feature.distance.value : null).toBe(
      DEFAULT_EXTRUDE_DISTANCE.value,
    );
    expect(feature.kind === 'extrude' ? feature.reversed : null).toBe(false);
    expect(feature.kind === 'extrude' ? feature.symmetric : null).toBe(false);
  });

  it('回転は軸をそのまま使い、軸が無ければ既定の Z 軸で作る(§0.a-0.9)', () => {
    const document = documentWithFaceAndLine();
    const line = { kind: 'line', line: { sketchId: SKETCH_ID, lineFeatureId: 'line-1' } } as const;
    const withAxis = commitSolidInput(document, ['face-1'], {
      kind: 'solid',
      tool: 'revolve',
      step: 'revolveAngle',
      values: { angle: expressionValueFromNumber(90) },
      flags: { reversed: false },
      axis: line,
    });
    expect(withAxis.ok && withAxis.document.solids[0].kind === 'revolve').toBe(true);
    if (withAxis.ok) {
      const feature = withAxis.document.solids[0];
      expect(feature.kind === 'revolve' ? feature.axis : null).toEqual(line);
      expect(feature.kind === 'revolve' ? feature.angle.value : null).toBe(90);
    }

    const withoutAxis = commitSolidInput(document, ['face-1'], {
      kind: 'solid',
      tool: 'revolve',
      step: 'revolveAngle',
      values: {},
      flags: {},
    });
    expect(withoutAxis.ok).toBe(true);
    if (withoutAxis.ok) {
      const feature = withoutAxis.document.solids[0];
      expect(feature.kind === 'revolve' ? feature.axis : null).toEqual(DEFAULT_REVOLVE_AXIS);
      expect(feature.kind === 'revolve' ? feature.angle.value : null).toBe(
        DEFAULT_REVOLVE_ANGLE.value,
      );
    }
  });

  it('縫合は選んだ面をすべて使う', () => {
    const document = documentWithFaces(['face-1', 'face-2', 'face-3']);
    const outcome = commitSolidInput(document, ['face-1', 'face-2', 'face-3'], {
      kind: 'solid',
      tool: 'sew',
      step: 'sewTolerance',
      values: {},
      flags: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.solids[0];
    expect(feature.kind === 'sew' ? feature.faces.length : 0).toBe(3);
    expect(feature.kind === 'sew' ? feature.tolerance.value : null).toBe(
      DEFAULT_SEW_TOLERANCE.value,
    );
  });

  it('選択が足りなければ理由を返し、文書を変えない', () => {
    const document = documentWithFaces(['face-1']);
    expect(commitSolidInput(document, [], extrudeCommit())).toEqual({
      ok: false,
      reasonKey: 'solidError.noFace',
    });
    expect(
      commitSolidInput(document, ['face-1'], {
        kind: 'solid',
        tool: 'sew',
        step: 'sewTolerance',
        values: {},
        flags: {},
      }),
    ).toEqual({ ok: false, reasonKey: 'solidError.needTwoFaces' });
    expect(document.solids).toHaveLength(0);
  });
});

describe('commitBooleanFromSelection(§0.a-0.6)', () => {
  it('先に選んだ立体が「もと」、後が「組み合わせる方」になる', () => {
    const document = documentWithTwoLiveBodies();
    const outcome = commitBooleanFromSelection(
      document,
      ['extrude-2', 'extrude-1'],
      'subtract',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.solids[outcome.document.solids.length - 1];
    expect(feature.name).toBe('差1');
    expect(feature.kind === 'boolean' ? feature.targetFeatureId : '').toBe('extrude-2');
    expect(feature.kind === 'boolean' ? feature.toolFeatureId : '').toBe('extrude-1');
  });

  it('立体が 2 つ選ばれていなければ needTwoBodies で断り、文書を変えない', () => {
    const document = documentWithTwoLiveBodies();
    expect(commitBooleanFromSelection(document, ['extrude-1'], 'union')).toEqual({
      ok: false,
      reasonKey: 'solidError.needTwoBodies',
    });
    expect(document.solids).toHaveLength(2);
  });

  it('作った立体は消費した 2 つに代わって生きたボディになる(§0.a-0.5)', () => {
    const document = documentWithTwoLiveBodies();
    const outcome = commitBooleanFromSelection(document, ['extrude-1', 'extrude-2'], 'union');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(liveBodyIds(outcome.document)).toEqual([outcome.featureId]);
  });
});

describe('断る理由の文言は ja.json から引く(NFR-MA-5)', () => {
  it('solidError.* のキーが実在し、空文字でない', () => {
    for (const key of [
      'solidError.noFace',
      'solidError.noBody',
      'solidError.needTwoBodies',
      'solidError.needTwoFaces',
      'solidError.sameBody',
      'solidError.notYetAvailable',
    ] as const) {
      expect(MESSAGE_KEYS).toContain(key);
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });
});
