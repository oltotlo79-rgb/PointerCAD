import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  sketchConstraints,
  SKETCH_CONSTRAINT_KINDS,
  type ConstraintDiagnosis,
  type CoordinateInput,
  type FrozenReason,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  commitConstraintFromSelection,
  constraintContextOf,
  type ConstraintContext,
} from './constraintCommands.js';
import {
  constraintKindSymbol,
  constraintSummary,
  describeConstraintTarget,
  summarizeConstraints,
} from './constraintSummary.js';

/* --- 検査に使う文書 ------------------------------------------------------ */

function lineFeature(
  document: SketchDocument,
  id: string,
  name: string,
  from: CoordinateInput,
  to: CoordinateInput,
): SketchDocument {
  return appendFeature(document, {
    id,
    name,
    planeId: 'xy',
    kind: 'line',
    from,
    to,
    construction: false,
  });
}

/** 直角に交わる 2 本。 */
function twoLines(): SketchDocument {
  const first = lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(10, 0, 0),
  );
  return lineFeature(
    first,
    'line-2',
    '線分2',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(0, 10, 0),
  );
}

function twoPoints(): SketchDocument {
  let document = appendFeature(createEmptySketchDocument(), {
    id: 'point-1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(2, 3, 0),
  });
  document = appendFeature(document, {
    id: 'point-2',
    name: '点2',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(8, 3, 0),
  });
  return document;
}

function oneCircle(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'arc-1',
    name: '円1',
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(4, 5, 0),
    radius: expressionValueFromNumber(7),
    startAngle: expressionValueFromNumber(0),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
}

function added(
  document: SketchDocument,
  kind: Parameters<typeof commitConstraintFromSelection>[1],
  selection: readonly string[],
): SketchDocument {
  const outcome = commitConstraintFromSelection(document, kind, selection);
  if (!outcome.ok) {
    throw new Error(`拘束を足せなかった: ${outcome.reason}`);
  }
  return outcome.document;
}

/**
 * 状態の写し取りだけを確かめるための診断。model の `diagnoseConstraints` を呼ぶと
 * 「どの拘束が冗長になるか」まで model の実装に頼ることになるので、ここでは
 * 写し取りの規則(冗長より矛盾が先、材料切れが最優先)だけを固定する。
 */
function diagnosisWith(patch: {
  readonly redundant?: readonly string[];
  readonly conflicting?: readonly string[];
  readonly dangling?: readonly string[];
}): ConstraintDiagnosis {
  return {
    variables: 4,
    equations: 1,
    rank: 1,
    degreesOfFreedom: 3,
    excess: 0,
    redundant: patch.redundant ?? [],
    conflicting: patch.conflicting ?? [],
    dangling: patch.dangling ?? [],
    frozen: new Map<string, FrozenReason>(),
    redundantDetails: [],
    conflictDetails: [],
    skipped: [],
    tooMany: false,
    maxResidual: 0,
    satisfied: true,
    messages: [],
    summary: '',
  };
}

/* --- 一覧の 1 行 --------------------------------------------------------- */

describe('constraintSummary(一覧の 1 行。FR-501 と同じ流儀)', () => {
  it('名前・対象の名前・記号が並ぶ', () => {
    const document = added(twoLines(), 'perpendicular', ['line-1', 'line-2']);
    const summary = constraintSummary(sketchConstraints(document)[0], document);
    expect(summary.label).toBe('直角1');
    expect(summary.detail).toBe('線分1 と 線分2');
    expect(summary.symbol).toBe('⊥');
    expect(summary.kind).toBe('perpendicular');
    expect(summary.value).toBeNull();
    expect(summary.valueText).toBeNull();
  });

  it('距離拘束は値を単位つきで出す', () => {
    const document = added(twoPoints(), 'distance', ['point-1', 'point-2']);
    const summary = constraintSummary(sketchConstraints(document)[0], document);
    expect(summary.value?.value).toBe(6);
    expect(summary.valueText).toBe('6 mm');
    expect(summary.detail).toBe('点1 と 点2');
  });

  it('角度は度の記号を空白なしで付ける', () => {
    const document = added(twoLines(), 'angle', ['line-1', 'line-2']);
    expect(constraintSummary(sketchConstraints(document)[0], document).valueText).toBe('90°');
  });

  it('線分 1 本の距離拘束は両端を指していると読める', () => {
    const document = added(twoLines(), 'distance', ['line-1']);
    expect(constraintSummary(sketchConstraints(document)[0], document).detail).toBe(
      '線分1 / 始点 と 線分1 / 終点',
    );
  });

  it('半径拘束は円の名前と値を出す', () => {
    const document = added(oneCircle(), 'radius', ['arc-1']);
    const summary = constraintSummary(sketchConstraints(document)[0], document);
    expect(summary.label).toBe('半径1');
    expect(summary.detail).toBe('円1');
    expect(summary.valueText).toBe('7 mm');
    expect(summary.symbol).toBe('R');
  });

  it('対称は軸を分けて添える', () => {
    const document = added(
      lineFeature(
        twoPoints(),
        'line-1',
        '線分1',
        absoluteCoordinate(5, -5, 0),
        absoluteCoordinate(5, 5, 0),
      ),
      'symmetric',
      ['point-1', 'point-2', 'line-1'],
    );
    expect(constraintSummary(sketchConstraints(document)[0], document).detail).toBe(
      '点1 と 点2 と 軸: 線分1',
    );
  });

  it('消えた要素を指していたら名前の代わりに断りを出す', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const without: SketchDocument = {
      ...document,
      features: document.features.filter((feature) => feature.id !== 'line-2'),
    };
    expect(constraintSummary(sketchConstraints(without)[0], without).detail).toBe(
      '線分1 と (消えた要素)',
    );
  });
});

/* --- 印の位置 ------------------------------------------------------------ */

describe('印を置く場所(anchors)', () => {
  /*
    P4b タスク22b で `anchors` の要素は「位置 + そこに点があるか」の組になった
    (点に付く印は掴みと競合するので画面上で上へ逃がす。`constraintPicking.ts`)。
    位置の期待値は変えず、`onPoint` の欄が増えたぶんだけ書き方を追随させる。
  */
  it('水平拘束の印は線分の中点 1 つ(点ではないので逃がさない)', () => {
    const document = added(twoLines(), 'horizontal', ['line-1']);
    const summary = constraintSummary(sketchConstraints(document)[0], document);
    expect(summary.anchors).toEqual([{ position: [5, 0, 0], onPoint: false }]);
  });

  it('平行拘束の印は 2 本の線分の中点', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    expect(constraintSummary(sketchConstraints(document)[0], document).anchors).toEqual([
      { position: [5, 0, 0], onPoint: false },
      { position: [0, 5, 0], onPoint: false },
    ]);
  });

  it('一致拘束の印は 1 つだけ', () => {
    const document = added(twoPoints(), 'coincident', ['point-1', 'point-2']);
    expect(constraintSummary(sketchConstraints(document)[0], document).anchors).toHaveLength(1);
  });

  it('半径拘束の印は円の中心', () => {
    const document = added(oneCircle(), 'radius', ['arc-1']);
    // 中心はスケッチの点なので `onPoint` が立つ(印は点の 14px 上へ逃げる)。
    expect(constraintSummary(sketchConstraints(document)[0], document).anchors).toEqual([
      { position: [4, 5, 0], onPoint: true },
    ]);
  });

  it('要素が消えていれば印は置かない', () => {
    const document = added(twoLines(), 'horizontal', ['line-1']);
    const without: SketchDocument = {
      ...document,
      features: document.features.filter((feature) => feature.id !== 'line-1'),
    };
    expect(constraintSummary(sketchConstraints(without)[0], without).anchors).toEqual([]);
  });
});

/* --- 状態(診断の写し取り) --------------------------------------------- */

describe('一覧の状態(矛盾・冗長・材料切れ)', () => {
  function firstSummary(document: SketchDocument, diagnosis: ConstraintDiagnosis | null) {
    return constraintSummary(sketchConstraints(document)[0], document, diagnosis);
  }

  it('診断が無ければ、材料がそろっているものは ok', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const summary = firstSummary(document, null);
    expect(summary.state).toBe('ok');
    expect(summary.stateMessage).toBeNull();
  });

  it('診断が無くても、指している要素が消えていれば材料切れになる', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const without: SketchDocument = {
      ...document,
      features: document.features.filter((feature) => feature.id !== 'line-2'),
    };
    expect(firstSummary(without, null).state).toBe('dangling');
  });

  it('矛盾している拘束は理由つきで赤くできる', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    const summary = firstSummary(document, diagnosisWith({ conflicting: [id] }));
    expect(summary.state).toBe('conflicting');
    expect(summary.stateMessage).toBe('同時に成り立ちません');
  });

  it('重なっている拘束は冗長として出す', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    expect(firstSummary(document, diagnosisWith({ redundant: [id] })).state).toBe('redundant');
  });

  it('冗長と矛盾の両方に入っていたら矛盾を先に出す', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    expect(
      firstSummary(document, diagnosisWith({ redundant: [id], conflicting: [id] })).state,
    ).toBe('conflicting');
  });

  it('材料切れは矛盾より先に出す', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    expect(
      firstSummary(document, diagnosisWith({ conflicting: [id], dangling: [id] })).state,
    ).toBe('dangling');
  });
});

/* --- 一覧全体 ------------------------------------------------------------ */

describe('summarizeConstraints(一覧パネル)', () => {
  it('保存されている順のまま並ぶ', () => {
    const first = added(twoLines(), 'horizontal', ['line-1']);
    const second = added(first, 'vertical', ['line-2']);
    expect(summarizeConstraints(second).map((summary) => summary.label)).toEqual([
      '水平1',
      '垂直1',
    ]);
  });

  it('拘束が 1 つも無ければ空', () => {
    expect(summarizeConstraints(twoLines())).toEqual([]);
  });

  it('材料を渡しても同じ結果になる(解決を 1 回で済ませる)', () => {
    const document = added(twoLines(), 'horizontal', ['line-1']);
    const context: ConstraintContext = constraintContextOf(document);
    expect(summarizeConstraints(document, null, context)).toEqual(summarizeConstraints(document));
  });

  it('14 種すべてに記号がある', () => {
    for (const kind of SKETCH_CONSTRAINT_KINDS) {
      expect(constraintKindSymbol(kind).length, kind).toBeGreaterThan(0);
    }
  });
});

/* --- 指し先の読み方 ------------------------------------------------------ */

describe('describeConstraintTarget', () => {
  it('曲線はフィーチャーの名前をそのまま出す', () => {
    expect(
      describeConstraintTarget(twoLines(), { kind: 'curve', element: { featureId: 'line-2' } }),
    ).toBe('線分2');
  });

  it('端点は「名前 / 始点」と出す', () => {
    expect(
      describeConstraintTarget(twoLines(), {
        kind: 'vertex',
        featureId: 'line-1',
        vertex: 'center',
      }),
    ).toBe('線分1 / 中心');
  });

  it('n 番目の点は番号を添える', () => {
    expect(describeConstraintTarget(twoPoints(), { kind: 'point', pointId: 'point-1#2' })).toBe(
      '点1 / 3番目',
    );
  });

  it('n 番目の曲線も番号を添える', () => {
    expect(
      describeConstraintTarget(twoLines(), {
        kind: 'curve',
        element: { featureId: 'line-1', index: 1 },
      }),
    ).toBe('線分1 / 2番目');
  });
});
