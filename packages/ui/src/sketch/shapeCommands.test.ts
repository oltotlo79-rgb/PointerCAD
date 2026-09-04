import { expressionValueFromNumber } from '@pointercad/expression';
import {
  createEmptySketchDocument,
  curveEnd,
  curveStart,
  distanceVec3,
  resolveSketch,
  WORK_PLANES,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  chooseNumericInput,
  commitNumericInput,
  createNumericInput,
  reduceNumericInput,
  toggleNumericInput,
  type NumericChoiceKey,
  type NumericInputCommit,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type NumericToggleKey,
} from './numericInput.js';
import {
  arcCenterFromTwoPointsAndRadius,
  commitCircle,
  commitCircularPointArray,
  commitEllipse,
  commitGridPointArray,
  commitPolygon,
  commitRectangle,
  commitShapeInput,
  commitSlot,
  commitSpline,
  commitTwoPointArc,
  EMPTY_SHAPE_DRAFT,
  resolveShapePoints,
  twoPointArcGeometry,
  type ShapeCommitContext,
} from './shapeCommands.js';

const XY = WORK_PLANES.xy;

/** 位置の突き合わせに使う許容量(mm)。角度から座標へ戻すので丸めのぶんだけ緩める。 */
const POSITION_TOLERANCE_MM = 1e-9;

function value(source: number) {
  return expressionValueFromNumber(source);
}

function contextOf(overrides: Partial<ShapeCommitContext> = {}): ShapeCommitContext {
  return {
    document: createEmptySketchDocument(),
    planeId: 'xy',
    plane: XY,
    pendingStart: null,
    draft: EMPTY_SHAPE_DRAFT,
    input: null,
    ...overrides,
  };
}

/** ポップアップの一段ぶん。欄へ打ってから、つまみ・選択肢を動かして決定する。 */
interface StepOptions {
  readonly toggles?: readonly NumericToggleKey[];
  readonly choices?: readonly { readonly key: NumericChoiceKey; readonly value: string }[];
}

function decide(
  toolId: NumericInputToolId,
  step: NumericInputStep,
  sources: readonly string[],
  options: StepOptions = {},
): { readonly commit: NumericInputCommit; readonly state: NumericInputState } {
  let filled = createNumericInput(toolId, step);
  // 選択肢は欄の並びを変える(点列の並べ方)ので、欄へ打つ前に選ぶ。
  for (const choice of options.choices ?? []) {
    filled = chooseNumericInput(filled, choice.key, choice.value);
  }
  sources.forEach((source, index) => {
    filled = reduceNumericInput(filled, { type: 'edit', index, source });
  });
  for (const key of options.toggles ?? []) {
    filled = toggleNumericInput(filled, key);
  }
  const transition = commitNumericInput(filled);
  if (transition.kind !== 'committed') {
    throw new Error(`確定できませんでした: ${transition.kind}`);
  }
  return { commit: transition.commit, state: transition.state };
}

/** 一段を決めて、その結果を次の段の文脈にする(ポップアップ→AppShell と同じ道筋)。 */
function stepShape(
  context: ShapeCommitContext,
  toolId: NumericInputToolId,
  step: NumericInputStep,
  sources: readonly string[],
  options: StepOptions = {},
): ShapeCommitContext {
  const decided = decide(toolId, step, sources, options);
  const outcome = commitShapeInput(decided.commit, { ...context, input: decided.state });
  return {
    ...context,
    document: outcome.document,
    pendingStart: outcome.pendingStart,
    draft: outcome.draft,
    input: null,
  };
}

/** 一段を決めて、断りの理由まで取り出す。 */
function rejectionOf(
  context: ShapeCommitContext,
  toolId: NumericInputToolId,
  step: NumericInputStep,
  sources: readonly string[],
  options: StepOptions = {},
): string | null {
  const decided = decide(toolId, step, sources, options);
  return commitShapeInput(decided.commit, { ...context, input: decided.state }).rejection;
}

function kindsOf(document: SketchDocument): readonly string[] {
  return document.features.map((feature) => feature.kind);
}

describe('新しい図形を履歴へ積む(FR-314〜318、FR-326、FR-327)', () => {
  it('円は全周(0°〜360°)の円弧として積む', () => {
    const document = commitCircle(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      value(10),
    );
    const feature = document.features[0];
    expect(feature.kind).toBe('arc');
    if (feature.kind !== 'arc') {
      throw new Error('円弧ではありません');
    }
    expect(feature.startAngle.value).toBe(0);
    expect(feature.endAngle.value).toBe(360);
    expect(feature.construction).toBe(false);
  });

  it('矩形は対角 2 点をそのまま持ち、名前は「矩形1」になる', () => {
    const document = commitRectangle(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      { mode: 'absolute', x: value(40), y: value(30), z: value(0) },
    );
    const feature = document.features[0];
    expect(feature.kind).toBe('rectangle');
    expect(feature.name).toBe('矩形1');
  });

  it('矩形の 2 点目が相対なら、基準を「直前の点」(= 1 点目)にそろえる', () => {
    const document = commitRectangle(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      {
        mode: 'relative',
        base: { kind: 'origin' },
        dx: value(40),
        dy: value(30),
        dz: value(0),
      },
    );
    const feature = document.features[0];
    if (feature.kind !== 'rectangle' || feature.corner2.mode !== 'relative') {
      throw new Error('矩形の 2 点目が相対ではありません');
    }
    expect(feature.corner2.base).toEqual({ kind: 'previous' });
  });

  it('正多角形は辺数と半径の測り方を持つ', () => {
    const document = commitPolygon(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      value(6),
      value(10),
      'circumscribed',
    );
    const feature = document.features[0];
    if (feature.kind !== 'polygon') {
      throw new Error('正多角形ではありません');
    }
    expect(feature.sides.value).toBe(6);
    expect(feature.radiusMode).toBe('circumscribed');
    expect(feature.name).toBe('正多角形1');
  });

  it('長穴は 2 つの中心と幅を持つ', () => {
    const document = commitSlot(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      { mode: 'absolute', x: value(30), y: value(0), z: value(0) },
      value(10),
    );
    const feature = document.features[0];
    if (feature.kind !== 'slot') {
      throw new Error('長穴ではありません');
    }
    expect(feature.width.value).toBe(10);
  });

  it('楕円は長半径・短半径・傾き・角度を持つ', () => {
    const document = commitEllipse(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      value(20),
      value(10),
      value(0),
      value(0),
      value(360),
    );
    const feature = document.features[0];
    if (feature.kind !== 'ellipse') {
      throw new Error('楕円ではありません');
    }
    expect(feature.majorRadius.value).toBe(20);
    expect(feature.minorRadius.value).toBe(10);
    expect(feature.endAngle.value).toBe(360);
  });

  it('スプラインは制御点方式と閉じるかを持つ', () => {
    const points = [0, 10, 20].map((x) => ({
      mode: 'absolute' as const,
      x: value(x),
      y: value(0),
      z: value(0),
    }));
    const document = commitSpline(createEmptySketchDocument(), 'xy', 'control', points, true);
    const feature = document.features[0];
    if (feature.kind !== 'spline') {
      throw new Error('スプラインではありません');
    }
    expect(feature.mode).toBe('control');
    expect(feature.closed).toBe(true);
    expect(feature.points).toHaveLength(3);
  });

  it('円周上の点列は layout が circular になる', () => {
    const document = commitCircularPointArray(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      value(10),
      value(6),
    );
    const feature = document.features[0];
    if (feature.kind !== 'pointArray') {
      throw new Error('点列ではありません');
    }
    expect(feature.layout.kind).toBe('circular');
  });

  it('格子状の点列は layout が grid で、行 0°・列 90° を持つ', () => {
    const document = commitGridPointArray(
      createEmptySketchDocument(),
      'xy',
      { mode: 'absolute', x: value(0), y: value(0), z: value(0) },
      value(0),
      value(10),
      value(3),
      value(90),
      value(10),
      value(3),
    );
    const feature = document.features[0];
    if (feature.kind !== 'pointArray' || feature.layout.kind !== 'grid') {
      throw new Error('格子状の点列ではありません');
    }
    expect(feature.layout.rowAzimuth.value).toBe(0);
    expect(feature.layout.colAzimuth.value).toBe(90);
  });
});

describe('2 点+半径の円弧の中心(FR-326、§0.a-0.18)', () => {
  it('左へふくらむときは中点から進む向きの右へ寄る', () => {
    const center = arcCenterFromTwoPointsAndRadius(XY, [0, 0, 0], [10, 0, 0], 10, 'left');
    expect(center).not.toBeNull();
    // 半弦 5、√(10² − 5²) = 8.660254037844386。
    expect(center?.[0]).toBeCloseTo(5, 9);
    expect(center?.[1]).toBeCloseTo(-8.660254037844386, 9);
    expect(center?.[2]).toBeCloseTo(0, 9);
  });

  it('右へふくらむときは反対側へ寄る', () => {
    const center = arcCenterFromTwoPointsAndRadius(XY, [0, 0, 0], [10, 0, 0], 10, 'right');
    expect(center?.[1]).toBeCloseTo(8.660254037844386, 9);
  });

  it('半径が弦の半分と同じなら中点が中心になる(半円)', () => {
    const center = arcCenterFromTwoPointsAndRadius(XY, [0, 0, 0], [10, 0, 0], 5, 'left');
    expect(center?.[0]).toBeCloseTo(5, 9);
    expect(center?.[1]).toBeCloseTo(0, 9);
  });

  it('半径が弦の半分より小さいと中心が求まらない', () => {
    expect(arcCenterFromTwoPointsAndRadius(XY, [0, 0, 0], [30, 0, 0], 10, 'left')).toBeNull();
  });

  it('角度は必ず開始角より終了角が大きくなる(反時計回りにそろえる)', () => {
    const left = twoPointArcGeometry(XY, [0, 0, 0], [10, 0, 0], 10, 'left');
    const right = twoPointArcGeometry(XY, [0, 0, 0], [10, 0, 0], 10, 'right');
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left?.startAngleDegrees).toBeLessThan(left?.endAngleDegrees ?? 0);
    expect(right?.startAngleDegrees).toBeLessThan(right?.endAngleDegrees ?? 0);
  });

  it('弧の開きは 180 度以下(短いほうの弧になる)', () => {
    const geometry = twoPointArcGeometry(XY, [0, 0, 0], [10, 0, 0], 10, 'left');
    const sweep = (geometry?.endAngleDegrees ?? 0) - (geometry?.startAngleDegrees ?? 0);
    expect(sweep).toBeCloseTo(60, 9);
  });
});

describe('2 点+半径の円弧を履歴へ積む', () => {
  const start = { mode: 'absolute' as const, x: value(0), y: value(0), z: value(0) };
  const end = { mode: 'absolute' as const, x: value(10), y: value(0), z: value(0) };

  it('円弧の両端がクリックした 2 点に一致する', () => {
    const outcome = commitTwoPointArc(
      createEmptySketchDocument(),
      'xy',
      XY,
      start,
      end,
      value(10),
      'left',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const arc = resolveSketch(outcome.document).arcs[0];
    const ends = [curveStart(arc), curveEnd(arc)];
    const nearStart = ends.some((point) => distanceVec3(point, [0, 0, 0]) < POSITION_TOLERANCE_MM);
    const nearEnd = ends.some((point) => distanceVec3(point, [10, 0, 0]) < POSITION_TOLERANCE_MM);
    expect(nearStart && nearEnd).toBe(true);
  });

  it('ふくらむ向きで円弧の中心が入れ替わる', () => {
    const left = commitTwoPointArc(
      createEmptySketchDocument(),
      'xy',
      XY,
      start,
      end,
      value(10),
      'left',
    );
    const right = commitTwoPointArc(
      createEmptySketchDocument(),
      'xy',
      XY,
      start,
      end,
      value(10),
      'right',
    );
    if (!left.ok || !right.ok) {
      throw new Error('円弧を作れませんでした');
    }
    expect(resolveSketch(left.document).arcs[0].center[1]).toBeLessThan(0);
    expect(resolveSketch(right.document).arcs[0].center[1]).toBeGreaterThan(0);
  });

  it('半径が足りないときは履歴を変えずに理由を返す', () => {
    const document = createEmptySketchDocument();
    const outcome = commitTwoPointArc(
      document,
      'xy',
      XY,
      start,
      { mode: 'absolute', x: value(30), y: value(0), z: value(0) },
      value(10),
      'left',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain('半径');
  });
});

describe('まだ履歴に無い点の位置を求める', () => {
  it('2 点目の相対指定は 1 点目からのずれとして解ける', () => {
    const positions = resolveShapePoints(createEmptySketchDocument(), 'xy', [
      { mode: 'absolute', x: value(5), y: value(5), z: value(0) },
      {
        mode: 'relative',
        base: { kind: 'previous' },
        dx: value(10),
        dy: value(0),
        dz: value(0),
      },
    ]);
    expect(positions).not.toBeNull();
    expect(positions?.[1]).toEqual([15, 5, 0]);
  });

  it('位置を求めるために足した点は文書に残らない', () => {
    const document = createEmptySketchDocument();
    resolveShapePoints(document, 'xy', [
      { mode: 'absolute', x: value(1), y: value(2), z: value(3) },
    ]);
    expect(document.features).toHaveLength(0);
  });
});

describe('段をたどって図形を作る(その場数値入力からの通し)', () => {
  it('円: 中心 → 半径 の 2 段で 1 つ積む', () => {
    let context = contextOf();
    context = stepShape(context, 'circle', 'circleCenter', ['0', '0', '0']);
    expect(context.document.features).toHaveLength(0);
    context = stepShape(context, 'circle', 'circleRadius', ['12']);
    expect(kindsOf(context.document)).toEqual(['arc']);
    expect(context.draft.points).toHaveLength(0);
  });

  it('矩形: 2 点目で 1 つ積む', () => {
    let context = contextOf();
    context = stepShape(context, 'rectangle', 'rectangleCorner1', ['0', '0', '0']);
    context = stepShape(context, 'rectangle', 'rectangleCorner2', ['40', '30', '0']);
    expect(kindsOf(context.document)).toEqual(['rectangle']);
  });

  it('正多角形: 内接を選ぶとその測り方で積む', () => {
    let context = contextOf();
    context = stepShape(context, 'polygon', 'polygonCenter', ['0', '0', '0']);
    context = stepShape(context, 'polygon', 'polygonShape', ['6', '10'], {
      choices: [{ key: 'polygonRadiusMode', value: 'inscribed' }],
    });
    const feature = context.document.features[0];
    if (feature.kind !== 'polygon') {
      throw new Error('正多角形ではありません');
    }
    expect(feature.radiusMode).toBe('inscribed');
  });

  it('長穴: 2 中心 → 幅 の 3 段で 1 つ積む', () => {
    let context = contextOf();
    context = stepShape(context, 'slot', 'slotCenter1', ['0', '0', '0']);
    context = stepShape(context, 'slot', 'slotCenter2', ['30', '0', '0']);
    expect(context.document.features).toHaveLength(0);
    context = stepShape(context, 'slot', 'slotShape', ['10']);
    expect(kindsOf(context.document)).toEqual(['slot']);
  });

  it('楕円: 「一部だけ」が切なら傾きの段で全周の楕円を積む', () => {
    let context = contextOf();
    context = stepShape(context, 'ellipse', 'ellipseCenter', ['0', '0', '0']);
    context = stepShape(context, 'ellipse', 'ellipseShape', ['20', '10']);
    context = stepShape(context, 'ellipse', 'ellipseAngles', ['0']);
    const feature = context.document.features[0];
    if (feature.kind !== 'ellipse') {
      throw new Error('楕円ではありません');
    }
    expect(feature.startAngle.value).toBe(0);
    expect(feature.endAngle.value).toBe(360);
  });

  it('楕円: 「一部だけ」が入なら角度の段まで待ってから積む', () => {
    let context = contextOf();
    context = stepShape(context, 'ellipse', 'ellipseCenter', ['0', '0', '0']);
    context = stepShape(context, 'ellipse', 'ellipseShape', ['20', '10']);
    context = stepShape(context, 'ellipse', 'ellipseAngles', ['30'], {
      toggles: ['ellipseArc'],
    });
    expect(context.document.features).toHaveLength(0);
    context = stepShape(context, 'ellipse', 'ellipseArcAngles', ['0', '180']);
    const feature = context.document.features[0];
    if (feature.kind !== 'ellipse') {
      throw new Error('楕円ではありません');
    }
    expect(feature.rotation.value).toBe(30);
    expect(feature.endAngle.value).toBe(180);
  });

  it('楕円: 傾きの段で入れた「構築線にする」が角度の段まで持ち越される(FR-320)', () => {
    let context = contextOf();
    context = stepShape(context, 'ellipse', 'ellipseCenter', ['0', '0', '0']);
    context = stepShape(context, 'ellipse', 'ellipseShape', ['20', '10']);
    context = stepShape(context, 'ellipse', 'ellipseAngles', ['0'], {
      toggles: ['ellipseArc', 'construction'],
    });
    context = stepShape(context, 'ellipse', 'ellipseArcAngles', ['0', '180']);
    const feature = context.document.features[0];
    if (feature.kind !== 'ellipse') {
      throw new Error('楕円ではありません');
    }
    expect(feature.construction).toBe(true);
  });

  it('スプライン: 点を 3 つ置いてから決め方の段で 1 本積む', () => {
    let context = contextOf();
    context = stepShape(context, 'spline', 'splinePoint', ['0', '0', '0']);
    context = stepShape(context, 'spline', 'splinePoint', ['10', '10', '0']);
    context = stepShape(context, 'spline', 'splinePoint', ['20', '0', '0']);
    expect(context.draft.points).toHaveLength(3);
    context = stepShape(context, 'spline', 'splineShape', []);
    const feature = context.document.features[0];
    if (feature.kind !== 'spline') {
      throw new Error('スプラインではありません');
    }
    expect(feature.points).toHaveLength(3);
    expect(feature.mode).toBe('interpolate');
    expect(feature.closed).toBe(false);
  });

  it('スプライン: 「閉じる」と「制御点」を選んで積める', () => {
    let context = contextOf();
    context = stepShape(context, 'spline', 'splinePoint', ['0', '0', '0']);
    context = stepShape(context, 'spline', 'splinePoint', ['10', '10', '0']);
    context = stepShape(context, 'spline', 'splinePoint', ['20', '0', '0']);
    context = stepShape(context, 'spline', 'splineShape', [], {
      choices: [{ key: 'splineMode', value: 'control' }],
      toggles: ['splineClosed'],
    });
    const feature = context.document.features[0];
    if (feature.kind !== 'spline') {
      throw new Error('スプラインではありません');
    }
    expect(feature.mode).toBe('control');
    expect(feature.closed).toBe(true);
  });

  it('スプライン: 点が足りないときは履歴を変えずに理由を返す', () => {
    let context = contextOf();
    context = stepShape(context, 'spline', 'splinePoint', ['0', '0', '0']);
    const reason = rejectionOf(context, 'spline', 'splineShape', []);
    expect(reason).toContain('2 個以上');
    expect(context.document.features).toHaveLength(0);
  });

  it('2 点+半径の円弧: 3 段で 1 つ積む', () => {
    let context = contextOf();
    context = stepShape(context, 'twoPointArc', 'twoPointArcStart', ['0', '0', '0']);
    context = stepShape(context, 'twoPointArc', 'twoPointArcEnd', ['10', '0', '0']);
    context = stepShape(context, 'twoPointArc', 'twoPointArcRadius', ['10']);
    expect(kindsOf(context.document)).toEqual(['arc']);
  });

  it('2 点+半径の円弧: 半径が足りないと理由が返り、履歴は変わらない', () => {
    let context = contextOf();
    context = stepShape(context, 'twoPointArc', 'twoPointArcStart', ['0', '0', '0']);
    context = stepShape(context, 'twoPointArc', 'twoPointArcEnd', ['30', '0', '0']);
    const reason = rejectionOf(context, 'twoPointArc', 'twoPointArcRadius', ['10']);
    expect(reason).not.toBeNull();
    expect(context.document.features).toHaveLength(0);
  });

  it('点列: 円周を選ぶと半径と個数で積む(FR-327)', () => {
    const base = { mode: 'absolute' as const, x: value(0), y: value(0), z: value(0) };
    const context = contextOf({ pendingStart: base });
    const decided = decide('pointArray', 'pointArrayShape', ['10', '6'], {
      choices: [{ key: 'pointArrayLayout', value: 'circular' }],
    });
    const outcome = commitShapeInput(decided.commit, { ...context, input: decided.state });
    const feature = outcome.document.features[0];
    if (feature.kind !== 'pointArray') {
      throw new Error('点列ではありません');
    }
    expect(feature.layout.kind).toBe('circular');
  });

  it('点列: 格子は行の段を持ち越して列の段で積む(FR-327)', () => {
    const base = { mode: 'absolute' as const, x: value(0), y: value(0), z: value(0) };
    let context = contextOf({ pendingStart: base });
    context = stepShape(context, 'pointArray', 'pointArrayShape', ['10', '4'], {
      choices: [{ key: 'pointArrayLayout', value: 'grid' }],
    });
    expect(context.document.features).toHaveLength(0);
    context = stepShape(context, 'pointArray', 'pointArrayGridColumns', ['20', '3']);
    const feature = context.document.features[0];
    if (feature.kind !== 'pointArray' || feature.layout.kind !== 'grid') {
      throw new Error('格子状の点列ではありません');
    }
    expect(feature.layout.rowCount.value).toBe(4);
    expect(feature.layout.colCount.value).toBe(3);
  });

  it('段の状態が無ければ履歴を変えない', () => {
    const decided = decide('circle', 'circleRadius', ['10']);
    const outcome = commitShapeInput(decided.commit, contextOf());
    expect(outcome.document.features).toHaveLength(0);
    expect(outcome.rejection).toBeNull();
  });

  it('図形を積み終えると下書きと取りかけが空へ戻る', () => {
    let context = contextOf();
    context = stepShape(context, 'rectangle', 'rectangleCorner1', ['0', '0', '0']);
    context = stepShape(context, 'rectangle', 'rectangleCorner2', ['40', '30', '0']);
    expect(context.draft).toEqual(EMPTY_SHAPE_DRAFT);
    expect(context.pendingStart).toBeNull();
  });

  it('1 点目を置き直すと前の下書きを引きずらない', () => {
    let context = contextOf();
    context = stepShape(context, 'slot', 'slotCenter1', ['0', '0', '0']);
    context = stepShape(context, 'slot', 'slotCenter2', ['30', '0', '0']);
    context = stepShape(context, 'slot', 'slotCenter1', ['5', '5', '0']);
    expect(context.draft.points).toHaveLength(1);
  });
});
