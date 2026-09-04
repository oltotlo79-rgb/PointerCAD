import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  FREE_WORK_PLANE_ID,
  resolveConstrainedSketch,
  sketchConstraints,
  type CoordinateInput,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  applicableConstraintKinds,
  commitAddConstraint,
  commitConstraintFromSelection,
  commitRemoveConstraint,
  commitRemoveConstraints,
  commitSetConstraintValue,
  constraintContextOf,
  constraintCountOf,
  constraintKindLabel,
  constraintNeedsValue,
  constraintReadiness,
  constraintsReferencing,
  constraintValueUnit,
  CONSTRAINT_KIND_ORDER,
} from './constraintCommands.js';

/* --- 検査に使う文書 ------------------------------------------------------ */

function lineFeature(
  document: SketchDocument,
  id: string,
  name: string,
  from: CoordinateInput,
  to: CoordinateInput,
  construction = false,
): SketchDocument {
  return appendFeature(document, { id, name, planeId: 'xy', kind: 'line', from, to, construction });
}

/** 横 10mm の線分 1 本(両端とも数値リテラル = 動かせる)。 */
function oneLine(): SketchDocument {
  return lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(10, 0, 0),
  );
}

/** 直角に交わる 2 本(1 本目は X 方向、2 本目は Y 方向)。 */
function twoLines(): SketchDocument {
  return lineFeature(
    oneLine(),
    'line-2',
    '線分2',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(0, 10, 0),
  );
}

/** 3-4-5 の直角三角形の斜辺になる線分(長さを測るための文書)。 */
function slantedLine(): SketchDocument {
  return lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(3, 4, 0),
  );
}

function arcFeature(
  document: SketchDocument,
  id: string,
  name: string,
  center: CoordinateInput,
  radius: number,
): SketchDocument {
  return appendFeature(document, {
    id,
    name,
    planeId: 'xy',
    kind: 'arc',
    center,
    radius: expressionValueFromNumber(radius),
    startAngle: expressionValueFromNumber(0),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
}

/** 半径 7 の円 1 つ。 */
function oneCircle(): SketchDocument {
  return arcFeature(createEmptySketchDocument(), 'arc-1', '円1', absoluteCoordinate(0, 0, 0), 7);
}

/** 半径 7 と半径 3 の円 2 つ。 */
function twoCircles(): SketchDocument {
  return arcFeature(oneCircle(), 'arc-2', '円2', absoluteCoordinate(30, 0, 0), 3);
}

/** 点 2 つ。 */
function twoPoints(): SketchDocument {
  let document = appendFeature(createEmptySketchDocument(), {
    id: 'point-1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(0, 0, 0),
  });
  document = appendFeature(document, {
    id: 'point-2',
    name: '点2',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(5, 0, 0),
  });
  return document;
}

/** 式で書かれた座標(数値リテラル 1 つではないので、ソルバーは定数として読む)。 */
function expressionCoordinate(x: number, y: number): CoordinateInput {
  return {
    mode: 'absolute',
    x: { source: `${String(x)} + 0`, value: x, display: String(x) },
    y: { source: `${String(y)} + 0`, value: y, display: String(y) },
    z: expressionValueFromNumber(0),
  };
}

/** 両端とも式で書かれた線分(動かせる数が 1 つも無い)。 */
function frozenLine(): SketchDocument {
  return lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    expressionCoordinate(0, 0),
    expressionCoordinate(10, 0),
  );
}

/** 矩形(1 フィーチャーが 4 本の曲線を生む)。 */
function rectangleDocument(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'rect-1',
    name: '矩形1',
    planeId: 'xy',
    kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0),
    corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  });
}

/** 3D スケッチ(作図面を持たない)の線分。 */
function freeSketchDocument(): SketchDocument {
  return lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(10, 0, 0),
  );
}

function toFreeSketch(document: SketchDocument): SketchDocument {
  return {
    ...document,
    features: document.features.map((feature) => ({ ...feature, planeId: FREE_WORK_PLANE_ID })),
  };
}

/** 足せたことを前提に文書を取り出す(検査の見通しのため)。 */
function added(
  document: SketchDocument,
  kind: Parameters<typeof commitConstraintFromSelection>[1],
  selection: readonly string[],
  value?: ExpressionValue,
): SketchDocument {
  const outcome = commitConstraintFromSelection(document, kind, selection, value);
  if (!outcome.ok) {
    throw new Error(`拘束を足せなかった: ${outcome.reason}`);
  }
  return outcome.document;
}

/* --- 下見(ツールバーの入り切り) ---------------------------------------- */

describe('constraintReadiness(選択から付けられるかを見る。NFR-UX-5)', () => {
  it('線分 2 本を選んで直角は付けられる', () => {
    const readiness = constraintReadiness(twoLines(), ['line-1', 'line-2'], 'perpendicular');
    expect(readiness.ready).toBe(true);
    expect(readiness.message).toBeNull();
    expect(readiness.targets).toHaveLength(2);
  });

  it('線分 1 本だけでは直角を付けられず、理由が出る', () => {
    const readiness = constraintReadiness(twoLines(), ['line-1'], 'perpendicular');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('needTwoLines');
    expect(readiness.message).toBe('線を 2 本選んでください。');
  });

  it('線分 1 本だけでは平行も付けられない', () => {
    expect(constraintReadiness(twoLines(), ['line-1'], 'parallel').reason).toBe('needTwoLines');
  });

  it('円 2 つを選んで「等しい」は付けられる', () => {
    expect(constraintReadiness(twoCircles(), ['arc-1', 'arc-2'], 'equal').ready).toBe(true);
  });

  it('線分 1 本と円 1 つでは「等しい」を付けられない', () => {
    const document = arcFeature(oneLine(), 'arc-1', '円1', absoluteCoordinate(30, 0, 0), 7);
    const readiness = constraintReadiness(document, ['line-1', 'arc-1'], 'equal');
    expect(readiness.reason).toBe('needTwoSameKind');
    expect(readiness.message).toBe('同じ種類のものを 2 つ選んでください(線 2 本、または円 2 つ)。');
  });

  it('何も選ばずに水平を押すと理由が出る(押したら必ず何かが起きる)', () => {
    const readiness = constraintReadiness(oneLine(), [], 'horizontal');
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toBe('線を 1 本選んでください。');
  });

  it('接線は「線分+円」でも「円+線分」でも付けられる(順序は不問)', () => {
    const document = arcFeature(oneLine(), 'arc-1', '円1', absoluteCoordinate(5, 20, 0), 3);
    expect(constraintReadiness(document, ['line-1', 'arc-1'], 'tangent').ready).toBe(true);
    expect(constraintReadiness(document, ['arc-1', 'line-1'], 'tangent').ready).toBe(true);
  });

  it('同心は円 2 つのときだけ付けられる', () => {
    expect(constraintReadiness(twoCircles(), ['arc-1', 'arc-2'], 'concentric').ready).toBe(true);
    expect(constraintReadiness(twoCircles(), ['arc-1'], 'concentric').reason).toBe('needTwoCircles');
  });

  it('対称は点 2 つと軸の線 1 本で付けられる', () => {
    const document = lineFeature(
      twoPoints(),
      'line-1',
      '線分1',
      absoluteCoordinate(2.5, -5, 0),
      absoluteCoordinate(2.5, 5, 0),
    );
    expect(
      constraintReadiness(document, ['point-1', 'point-2', 'line-1'], 'symmetric').ready,
    ).toBe(true);
    expect(constraintReadiness(document, ['point-1', 'point-2'], 'symmetric').reason).toBe(
      'needSymmetric',
    );
  });

  it('構築線にも拘束を付けられる(FR-320 の構築線は対称の基準や当たり取りに使う)', () => {
    const document = lineFeature(
      createEmptySketchDocument(),
      'line-1',
      '線分1',
      absoluteCoordinate(0, 0, 0),
      absoluteCoordinate(10, 2, 0),
      true,
    );
    expect(constraintReadiness(document, ['line-1'], 'horizontal').ready).toBe(true);
  });

  it('3D スケッチの要素には拘束を付けられない(§0.a-0.3)', () => {
    const readiness = constraintReadiness(toFreeSketch(freeSketchDocument()), ['line-1'], 'horizontal');
    expect(readiness.reason).toBe('freeSketch');
    expect(readiness.message).toBe('3D スケッチでは拘束を使えません。作図面の上のスケッチで使ってください。');
  });

  it('別のスケッチの要素を選んでいたら断る', () => {
    const readiness = constraintReadiness(oneLine(), ['line-1', 'line-9'], 'parallel');
    expect(readiness.reason).toBe('otherSketch');
  });

  it('矩形のように 1 つで何本もの曲線になる要素には付けられない', () => {
    expect(constraintReadiness(rectangleDocument(), ['rect-1'], 'horizontal').reason).toBe(
      'unsupportedElement',
    );
  });

  it('両端が式で書かれた線分は、拘束を付けても動かないので断る(§0.a-0.2)', () => {
    const readiness = constraintReadiness(frozenLine(), ['line-1'], 'horizontal');
    expect(readiness.reason).toBe('allFrozen');
  });

  it('固定した線分には、もう向きの拘束を付けられない', () => {
    const document = added(oneLine(), 'fix', ['line-1']);
    expect(constraintReadiness(document, ['line-1'], 'horizontal').reason).toBe('allFrozen');
  });

  it('同じ拘束を 2 度は付けられない', () => {
    const document = added(twoLines(), 'perpendicular', ['line-1', 'line-2']);
    expect(constraintReadiness(document, ['line-1', 'line-2'], 'perpendicular').reason).toBe(
      'duplicate',
    );
  });

  it('選ぶ順を入れ替えただけの拘束も「同じ拘束」として断る', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    expect(constraintReadiness(document, ['line-2', 'line-1'], 'parallel').reason).toBe('duplicate');
  });
});

/* --- 既定値は「いま測った値」(NFR-UX-4) -------------------------------- */

describe('寸法拘束の既定値(いまの形から測る)', () => {
  it('線分 (0,0)-(3,4) の距離の既定値は 5', () => {
    const readiness = constraintReadiness(slantedLine(), ['line-1'], 'distance');
    expect(readiness.ready).toBe(true);
    expect(readiness.defaultValue?.value).toBe(5);
    expect(readiness.defaultValue?.source).toBe('5');
  });

  it('点 2 つの距離の既定値も測った値になる', () => {
    expect(
      constraintReadiness(twoPoints(), ['point-1', 'point-2'], 'distance').defaultValue?.value,
    ).toBe(5);
  });

  it('半径 7 の円の直径の既定値は 14、半径の既定値は 7', () => {
    expect(constraintReadiness(oneCircle(), ['arc-1'], 'diameter').defaultValue?.value).toBe(14);
    expect(constraintReadiness(oneCircle(), ['arc-1'], 'radius').defaultValue?.value).toBe(7);
  });

  it('X 方向と Y 方向の線分の角度の既定値は 90', () => {
    expect(
      constraintReadiness(twoLines(), ['line-1', 'line-2'], 'angle').defaultValue?.value,
    ).toBe(90);
  });

  it('角度は符号つきで測る(選ぶ順を入れ替えると −90)', () => {
    expect(
      constraintReadiness(twoLines(), ['line-2', 'line-1'], 'angle').defaultValue?.value,
    ).toBe(-90);
  });

  it('数値を聞かない拘束の既定値は無い', () => {
    expect(constraintReadiness(oneLine(), ['line-1'], 'horizontal').defaultValue).toBeNull();
    expect(constraintNeedsValue('horizontal')).toBe(false);
    expect(constraintNeedsValue('distance')).toBe(true);
  });

  it('欄の単位は長さが mm、角度が度', () => {
    expect(constraintValueUnit('distance')).toBe('mm');
    expect(constraintValueUnit('radius')).toBe('mm');
    expect(constraintValueUnit('angle')).toBe('degree');
    expect(constraintValueUnit('parallel')).toBeNull();
  });
});

/* --- 付けられる拘束の一覧 ------------------------------------------------ */

describe('applicableConstraintKinds(ツールバーの活性)', () => {
  it('線分 2 本のときは平行・直角・等しい・固定・角度が並ぶ', () => {
    expect(applicableConstraintKinds(twoLines(), ['line-1', 'line-2'])).toEqual([
      'parallel',
      'perpendicular',
      'equal',
      'fix',
      'angle',
    ]);
  });

  it('線分 1 本のときは水平・垂直・固定・距離が並ぶ', () => {
    expect(applicableConstraintKinds(oneLine(), ['line-1'])).toEqual([
      'horizontal',
      'vertical',
      'fix',
      'distance',
    ]);
  });

  it('円 1 つのときは固定・半径・直径が並ぶ', () => {
    expect(applicableConstraintKinds(oneCircle(), ['arc-1'])).toEqual(['fix', 'radius', 'diameter']);
  });

  it('何も選んでいなければ 1 つも並ばない', () => {
    expect(applicableConstraintKinds(twoLines(), [])).toEqual([]);
  });

  it('一覧の並びは 14 種の決め打ちの順', () => {
    expect(CONSTRAINT_KIND_ORDER).toHaveLength(14);
    expect(CONSTRAINT_KIND_ORDER[0]).toBe('coincident');
    expect(CONSTRAINT_KIND_ORDER[13]).toBe('diameter');
  });
});

/* --- 拘束を付ける -------------------------------------------------------- */

describe('commitAddConstraint / commitConstraintFromSelection', () => {
  it('付けた拘束の名前は「直角1」、2 つ目は「直角2」', () => {
    const first = added(twoLines(), 'perpendicular', ['line-1', 'line-2']);
    expect(sketchConstraints(first)[0].name).toBe('直角1');
    const document = lineFeature(
      first,
      'line-3',
      '線分3',
      absoluteCoordinate(0, 20, 0),
      absoluteCoordinate(10, 20, 0),
    );
    const second = added(document, 'perpendicular', ['line-1', 'line-3']);
    expect(sketchConstraints(second).map((constraint) => constraint.name)).toEqual([
      '直角1',
      '直角2',
    ]);
  });

  it('見出しは ja.json から引く(「直角」)', () => {
    expect(constraintKindLabel('perpendicular')).toBe('直角');
    expect(constraintKindLabel('fix')).toBe('固定');
  });

  it('元の文書は書き換えない(不変)', () => {
    const document = twoLines();
    const outcome = commitConstraintFromSelection(document, 'parallel', ['line-1', 'line-2']);
    expect(outcome.ok).toBe(true);
    expect(constraintCountOf(document)).toBe(0);
    expect(constraintCountOf(outcome.ok ? outcome.document : document)).toBe(1);
  });

  it('「固定」は選んだ要素の数だけ足す(「固定1」「固定2」)', () => {
    const outcome = commitConstraintFromSelection(twoLines(), 'fix', ['line-1', 'line-2']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.constraintIds).toHaveLength(2);
    expect(sketchConstraints(outcome.document).map((constraint) => constraint.name)).toEqual([
      '固定1',
      '固定2',
    ]);
    expect(outcome.constraintId).toBe(outcome.constraintIds[0]);
  });

  it('距離拘束は既定値(いま測った値)のまま足せる', () => {
    const document = added(slantedLine(), 'distance', ['line-1']);
    const constraint = sketchConstraints(document)[0];
    expect(constraint.kind).toBe('distance');
    expect(constraint.kind === 'distance' ? constraint.length.value : null).toBe(5);
  });

  it('距離拘束の値には式(パラメータの名前)を書ける', () => {
    const width: ExpressionValue = { source: '幅', value: 12, display: '12' };
    const document = added(slantedLine(), 'distance', ['line-1'], width);
    const constraint = sketchConstraints(document)[0];
    expect(constraint.kind === 'distance' ? constraint.length.source : null).toBe('幅');
  });

  it('長さ 0 の距離は断る', () => {
    const outcome = commitConstraintFromSelection(
      slantedLine(),
      'distance',
      ['line-1'],
      expressionValueFromNumber(0),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('invalidSize');
  });

  it('指し先の形が合わない呼び出しは断る(選択を通さない道)', () => {
    const outcome = commitAddConstraint(twoLines(), 'perpendicular', [
      { kind: 'curve', element: { featureId: 'line-1' } },
    ]);
    expect(outcome.ok ? null : outcome.reason).toBe('needTwoLines');
  });

  it('材料の無いスケッチには付けられない', () => {
    const outcome = commitAddConstraint(createEmptySketchDocument(), 'horizontal', [
      { kind: 'curve', element: { featureId: 'line-1' } },
    ]);
    expect(outcome.ok ? null : outcome.reason).toBe('freeSketch');
  });
});

/* --- 拘束を消す・値を書き換える ----------------------------------------- */

describe('commitRemoveConstraint / commitSetConstraintValue', () => {
  it('拘束を 1 つ消せる', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    const outcome = commitRemoveConstraint(document, id);
    expect(outcome.ok).toBe(true);
    expect(constraintCountOf(outcome.ok ? outcome.document : document)).toBe(0);
  });

  it('無い拘束を消そうとしたら断る', () => {
    const outcome = commitRemoveConstraint(oneLine(), 'constraint-9');
    expect(outcome.ok ? null : outcome.reason).toBe('notFound');
  });

  it('まとめて消せる', () => {
    const document = added(twoLines(), 'fix', ['line-1', 'line-2']);
    const ids = sketchConstraints(document).map((constraint) => constraint.id);
    const outcome = commitRemoveConstraints(document, ids);
    expect(constraintCountOf(outcome.ok ? outcome.document : document)).toBe(0);
  });

  it('寸法拘束の値を書き換えられる', () => {
    const document = added(slantedLine(), 'distance', ['line-1']);
    const id = sketchConstraints(document)[0].id;
    const outcome = commitSetConstraintValue(document, id, expressionValueFromNumber(12));
    expect(outcome.ok).toBe(true);
    const constraint = sketchConstraints(outcome.ok ? outcome.document : document)[0];
    expect(constraint.kind === 'distance' ? constraint.length.value : null).toBe(12);
  });

  it('0 以下の長さへは書き換えられない', () => {
    const document = added(slantedLine(), 'distance', ['line-1']);
    const id = sketchConstraints(document)[0].id;
    const outcome = commitSetConstraintValue(document, id, expressionValueFromNumber(-1));
    expect(outcome.ok ? null : outcome.reason).toBe('invalidSize');
  });

  it('数値を持たない拘束の値は書き換えられない', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    const id = sketchConstraints(document)[0].id;
    const outcome = commitSetConstraintValue(document, id, expressionValueFromNumber(1));
    expect(outcome.ok ? null : outcome.reason).toBe('notDimensional');
  });

  it('無い拘束の値は書き換えられない', () => {
    const outcome = commitSetConstraintValue(oneLine(), 'constraint-9', expressionValueFromNumber(1));
    expect(outcome.ok ? null : outcome.reason).toBe('notFound');
  });

  it('その要素を指している拘束を数えられる', () => {
    const document = added(twoLines(), 'parallel', ['line-1', 'line-2']);
    expect(constraintsReferencing(document, 'line-1')).toHaveLength(1);
    expect(constraintsReferencing(document, 'line-9')).toHaveLength(0);
  });
});

/* --- 付けた拘束が実際に効くこと(model の 3 段の解決と噛み合う) --------- */

describe('付けた拘束を解くと形が整う(FR-313)', () => {
  it('水平拘束を付けると線分が作図面の中で水平になる', () => {
    const document = added(
      lineFeature(
        createEmptySketchDocument(),
        'line-1',
        '線分1',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(7, 4, 0),
      ),
      'horizontal',
      ['line-1'],
    );
    const segment = resolveConstrainedSketch(document).resolved.segments[0];
    expect(Math.abs(segment.from[1] - segment.to[1])).toBeLessThan(1e-9);
  });

  it('直角拘束を付けると 2 本が直交する', () => {
    const document = added(
      lineFeature(
        oneLine(),
        'line-2',
        '線分2',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(3, 10, 0),
      ),
      'perpendicular',
      ['line-1', 'line-2'],
    );
    const { segments } = resolveConstrainedSketch(document).resolved;
    const first = segments[0];
    const second = segments[1];
    const dot =
      (first.to[0] - first.from[0]) * (second.to[0] - second.from[0]) +
      (first.to[1] - first.from[1]) * (second.to[1] - second.from[1]);
    expect(Math.abs(dot)).toBeLessThan(1e-6);
  });

  it('既定値のまま距離拘束を付けても形は変わらない(Enter 連打で意味のある結果)', () => {
    const document = added(slantedLine(), 'distance', ['line-1']);
    const segment = resolveConstrainedSketch(document).resolved.segments[0];
    expect(segment.to[0]).toBeCloseTo(3, 9);
    expect(segment.to[1]).toBeCloseTo(4, 9);
  });

  it('半径拘束を付けると円の半径が変わる', () => {
    const document = added(oneCircle(), 'radius', ['arc-1'], expressionValueFromNumber(12));
    expect(resolveConstrainedSketch(document).resolved.arcs[0].radius).toBeCloseTo(12, 9);
  });

  it('矛盾する拘束(平行と直角)は止めずに付き、理由が診断に出る(FR-504)', () => {
    const parallel = commitConstraintFromSelection(twoLines(), 'parallel', ['line-1', 'line-2']);
    expect(parallel.ok).toBe(true);
    if (!parallel.ok) {
      return;
    }
    const both = commitConstraintFromSelection(parallel.document, 'perpendicular', [
      'line-1',
      'line-2',
    ]);
    // 付ける前に断らない(§0.a に決定が無いので「止めずに警告する」を採る)。
    expect(both.ok).toBe(true);
    if (!both.ok) {
      return;
    }
    const outcome = resolveConstrainedSketch(both.document);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.diagnosis?.satisfied).toBe(false);
  });
});

/* --- 材料の作り直しを省ける ---------------------------------------------- */

describe('constraintContextOf(判定と測定の材料)', () => {
  it('作図面と動かせる数を返す(線分 1 本なら 4 つ)', () => {
    const context = constraintContextOf(oneLine());
    expect(context.plane?.id).toBe('xy');
    expect(context.variableSet?.variables).toHaveLength(4);
  });

  it('3D スケッチだけの文書では作図面が無い', () => {
    const context = constraintContextOf(toFreeSketch(freeSketchDocument()));
    expect(context.plane).toBeNull();
    expect(context.variableSet).toBeNull();
  });

  it('作った材料を渡しても同じ判定になる', () => {
    const document = twoLines();
    const context = constraintContextOf(document);
    expect(constraintReadiness(document, ['line-1', 'line-2'], 'parallel', context).ready).toBe(
      true,
    );
  });
});
