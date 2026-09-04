import {
  createEmptySketchDocument,
  DEFAULT_FACE_COLOR,
  FREE_WORK_PLANE_ID,
  resolveSketch,
  WORK_PLANES,
  type SketchDocument,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t } from '../i18n/t.js';
import {
  commitNumericInput,
  createNumericInput,
  reduceNumericInput,
  type CoordinateMode,
  type NumericInputCommit,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type SketchToolId,
} from './numericInput.js';
import {
  boundaryElementKind,
  commitFace,
  commitSketchInput,
  commitSubShapePoint,
  continueFrom,
  freeArcOrientationOf,
  subShapeCoordinate,
  toElementRef,
  type CommitContext,
} from './sketchCommands.js';

/** 欄へ数字を打ってから決定する。ポップアップと同じ道筋を通す。 */
function commitOf(state: NumericInputState, sources: readonly string[]): NumericInputCommit {
  let filled = state;
  sources.forEach((source, index) => {
    filled = reduceNumericInput(filled, { type: 'edit', index, source });
  });
  const transition = commitNumericInput(filled);
  if (transition.kind !== 'committed') {
    throw new Error(`確定できませんでした: ${transition.kind}`);
  }
  return transition.commit;
}

function contextOf(overrides: Partial<CommitContext> = {}): CommitContext {
  return {
    document: createEmptySketchDocument(),
    planeId: 'xy',
    plane: WORK_PLANES.xy,
    chaining: false,
    pendingStart: null,
    ...overrides,
  };
}

/** 道具の 1 段階を決めて履歴へ反映する。段階をまたぐ検査を短く書くための小道具。 */
function step(
  context: CommitContext,
  toolId: SketchToolId,
  inputStep: NumericInputStep,
  mode: CoordinateMode,
  sources: readonly string[],
): CommitContext {
  const outcome = commitSketchInput(
    commitOf(createNumericInput(toolId, inputStep, mode), sources),
    context,
  );
  return { ...context, document: outcome.document, pendingStart: outcome.pendingStart };
}

/** 絶対座標の始点と終点で線分を 1 本作る。 */
function lineThrough(
  context: CommitContext,
  from: readonly [string, string, string],
  to: readonly [string, string, string],
): CommitContext {
  return step(
    step(context, 'line', 'lineStart', 'absolute', from),
    'line',
    'lineEnd',
    'absolute',
    to,
  );
}

function featureIds(document: SketchDocument): string[] {
  return document.features.map((feature) => feature.id);
}

describe('数値入力の結果から履歴を作る(FR-301〜309)', () => {
  it('点列の 1 点は `featureId#n`、それ以外はフィーチャーそのものを指す', () => {
    expect(toElementRef('pa1#2')).toEqual({ featureId: 'pa1', index: 2 });
    expect(toElementRef('point-1')).toEqual({ featureId: 'point-1' });
  });

  it('円弧と点列の欄は「半径・開始角・終了角」「角度・間隔・個数」の順に並ぶ', () => {
    // 欄の値は並び順で読むので、順番が変わったらこの検査で気づけるようにする。
    expect(createNumericInput('arc', 'arcShape').fields.map((field) => field.key)).toEqual([
      'radius',
      'startAngle',
      'endAngle',
    ]);
    expect(
      createNumericInput('pointArray', 'pointArrayShape').fields.map((field) => field.key),
    ).toEqual(['azimuth', 'spacing', 'count']);
  });

  it('点を作ると履歴が 1 つ増え、式も評価値も残る(FR-202、FR-301)', () => {
    const outcome = commitSketchInput(
      commitOf(createNumericInput('point', 'point'), ['1', '2+3', '4']),
      contextOf(),
    );
    expect(outcome.document.features).toHaveLength(1);
    expect(outcome.pendingStart).toBeNull();
    const resolved = resolveSketch(outcome.document);
    expect(resolved.points[0].position).toEqual([1, 5, 4]);
    expect(resolved.errors).toEqual([]);
    const feature = outcome.document.features[0];
    // 式そのものが履歴に残っている(FR-202)。
    expect(feature.kind === 'point' && feature.at.mode === 'absolute' ? feature.at.y.source : '')
      .toBe('2+3');
  });

  it('線分は始点→終点の 2 段階で 1 本になる(FR-304)', () => {
    const first = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf(),
    );
    // 始点だけでは履歴へ積まない。
    expect(first.document.features).toHaveLength(0);
    expect(first.pendingStart).not.toBeNull();

    const second = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ document: first.document, pendingStart: first.pendingStart }),
    );
    const resolved = resolveSketch(second.document);
    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0].from).toEqual([0, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 0, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('続けてかくなら、次の線は直前の線の終点から始まる(FR-307)', () => {
    const start = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf({ chaining: true }),
    );
    const first = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ chaining: true, document: start.document, pendingStart: start.pendingStart }),
    );
    // 次の基準は「作ったばかりの線分の終点」を名指しする。
    expect(first.pendingStart).toEqual(continueFrom(featureIds(first.document)[0]));

    const second = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['0', '10', '0']),
      contextOf({ chaining: true, document: first.document, pendingStart: first.pendingStart }),
    );
    const resolved = resolveSketch(second.document);
    expect(resolved.segments).toHaveLength(2);
    // 2 本目は 1 本目の終点 (10,0,0) から、そこから +Y に 10。
    expect(resolved.segments[1].from).toEqual([10, 0, 0]);
    expect(resolved.segments[1].to).toEqual([10, 10, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('続けてかくが切なら、次の基準を持ち越さない', () => {
    const start = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf(),
    );
    const line = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ document: start.document, pendingStart: start.pendingStart }),
    );
    expect(line.pendingStart).toBeNull();
  });

  it('円弧は中心→形の 2 段階(FR-305)、点列は基準点→並べ方(FR-308)', () => {
    const arc = step(
      step(contextOf(), 'arc', 'arcCenter', 'absolute', ['0', '0', '0']),
      'arc',
      'arcShape',
      'absolute',
      ['10', '0', '360'],
    );
    const resolvedArc = resolveSketch(arc.document);
    expect(resolvedArc.arcs).toHaveLength(1);
    expect(resolvedArc.arcs[0].radius).toBe(10);
    expect(arc.pendingStart).toBeNull();

    const array = step(
      step(contextOf(), 'pointArray', 'pointArrayBase', 'absolute', ['0', '0', '0']),
      'pointArray',
      'pointArrayShape',
      'absolute',
      ['0', '10', '4'],
    );
    const resolvedArray = resolveSketch(array.document);
    expect(resolvedArray.points).toHaveLength(4);
    expect(resolvedArray.points[3].id).toBe(`${featureIds(array.document)[0]}#3`);
    expect(array.pendingStart).toBeNull();
  });

  it('前半を決めていないのに後半が来たら、壊れた形を作らずに何もしない', () => {
    const outcome = commitSketchInput(
      commitOf(createNumericInput('arc', 'arcShape'), ['10', '0', '90']),
      contextOf(),
    );
    expect(outcome.document.features).toEqual([]);
    expect(outcome.pendingStart).toBeNull();
  });
});

describe('選んだ要素から面を張る(FR-309、FR-310)', () => {
  it('要素が点か線かを見分ける', () => {
    const points = step(contextOf(), 'point', 'point', 'absolute', ['0', '0', '0']);
    const withLine = lineThrough(points, ['0', '0', '0'], ['10', '0', '0']);
    const resolved = resolveSketch(withLine.document);
    const [pointId, lineId] = featureIds(withLine.document);
    expect(boundaryElementKind(resolved, pointId)).toBe('point');
    expect(boundaryElementKind(resolved, lineId)).toBe('curve');
    expect(boundaryElementKind(resolved, 'このidはない')).toBe('unknown');
  });

  it('点を 3 つ選ぶと面が張れる。既定の色が付く(FR-310)', () => {
    let context = contextOf();
    for (const at of [['0', '0', '0'], ['10', '0', '0'], ['10', '10', '0']]) {
      context = step(context, 'point', 'point', 'absolute', at);
    }
    const outcome = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].color).toBe(DEFAULT_FACE_COLOR);
    expect(resolved.errors).toEqual([]);
  });

  it('線を順に選んでも面が張れる。選んだ順がそのまま境界の順になる', () => {
    let context = lineThrough(contextOf(), ['0', '0', '0'], ['10', '0', '0']);
    context = lineThrough(context, ['10', '0', '0'], ['10', '10', '0']);
    context = lineThrough(context, ['10', '10', '0'], ['0', '0', '0']);
    const ids = featureIds(context.document);
    const outcome = commitFace(context.document, resolveSketch(context.document), 'xy', ids);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const face = outcome.document.features[outcome.document.features.length - 1];
    expect(face.kind === 'face' ? face.boundary : []).toEqual(
      ids.map((featureId) => ({ featureId })),
    );
    expect(resolveSketch(outcome.document).faces).toHaveLength(1);
  });

  it('点と線をまぜた選択は理由を返して断る(§0.a-0.13)', () => {
    const withPoint = step(contextOf(), 'point', 'point', 'absolute', ['0', '0', '0']);
    const context = lineThrough(withPoint, ['0', '0', '0'], ['10', '0', '0']);
    const outcome = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    expect(outcome).toEqual({ ok: false, reasonKey: 'face.error.mixedBoundary' });
    // 断ったときは履歴を変えない。
    expect(context.document.features).toHaveLength(2);
  });

  it('選択なし・点が足りない・面そのものの選択も理由を返して断る', () => {
    const empty = createEmptySketchDocument();
    expect(commitFace(empty, resolveSketch(empty), 'xy', [])).toEqual({
      ok: false,
      reasonKey: 'face.error.emptySelection',
    });

    let context = contextOf();
    for (const at of [['0', '0', '0'], ['10', '0', '0'], ['10', '10', '0']]) {
      context = step(context, 'point', 'point', 'absolute', at);
    }
    expect(
      commitFace(
        context.document,
        resolveSketch(context.document),
        'xy',
        featureIds(context.document).slice(0, 2),
      ),
    ).toEqual({ ok: false, reasonKey: 'face.error.tooFewPoints' });

    const withFace = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    if (!withFace.ok) {
      throw new Error('面を張れませんでした');
    }
    const faceId = featureIds(withFace.document)[3];
    expect(
      commitFace(withFace.document, resolveSketch(withFace.document), 'xy', [faceId]),
    ).toEqual({ ok: false, reasonKey: 'face.error.unsupportedElement' });
  });

  it('断る理由の文言は ja.json から引く(NFR-MA-5)', () => {
    for (const key of [
      'face.error.emptySelection',
      'face.error.mixedBoundary',
      'face.error.tooFewPoints',
      'face.error.unsupportedElement',
    ] as const) {
      expect(MESSAGE_KEYS).toContain(key);
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });
});

describe('新しい図形の段は shapeCommands.ts へ渡す(P4 タスク12)', () => {
  /** 新しい図形は欄の値を名前で引くので、確定した段の状態も一緒に渡す。 */
  function shapeStep(
    context: CommitContext,
    toolId: NumericInputToolId,
    inputStep: NumericInputStep,
    sources: readonly string[],
  ): CommitContext {
    const state = createNumericInput(toolId, inputStep);
    let filled = state;
    sources.forEach((source, index) => {
      filled = reduceNumericInput(filled, { type: 'edit', index, source });
    });
    const transition = commitNumericInput(filled);
    if (transition.kind !== 'committed') {
      throw new Error(`確定できませんでした: ${transition.kind}`);
    }
    const outcome = commitSketchInput(transition.commit, {
      ...context,
      input: transition.state,
    });
    return {
      ...context,
      document: outcome.document,
      pendingStart: outcome.pendingStart,
      shapeDraft: outcome.shapeDraft,
    };
  }

  it('円の 2 段が通ると円弧(全周)が 1 つ積まれる(FR-326)', () => {
    let context = contextOf();
    context = shapeStep(context, 'circle', 'circleCenter', ['0', '0', '0']);
    expect(context.document.features).toHaveLength(0);
    context = shapeStep(context, 'circle', 'circleRadius', ['10']);
    const feature = context.document.features[0];
    if (feature === undefined || feature.kind !== 'arc') {
      throw new Error('円弧ではありません');
    }
    expect(feature.endAngle.value).toBe(360);
  });

  it('矩形は 2 点目で 1 つ積まれる(FR-314)', () => {
    let context = contextOf();
    context = shapeStep(context, 'rectangle', 'rectangleCorner1', ['0', '0', '0']);
    context = shapeStep(context, 'rectangle', 'rectangleCorner2', ['40', '30', '0']);
    expect(context.document.features.map((feature) => feature.kind)).toEqual(['rectangle']);
  });

  it('点列の直線状は P1 のまま sketchCommands.ts が積む(FR-308)', () => {
    let context = contextOf();
    context = step(context, 'pointArray', 'pointArrayBase', 'absolute', ['0', '0', '0']);
    context = step(context, 'pointArray', 'pointArrayShape', 'absolute', ['0', '10', '3']);
    const feature = context.document.features[0];
    if (feature === undefined || feature.kind !== 'pointArray') {
      throw new Error('点列ではありません');
    }
    expect(feature.layout.kind).toBe('linear');
  });

  it('新しい図形はどれも面の囲みに使える曲線として数える(FR-309、FR-314〜318)', () => {
    let context = contextOf();
    context = shapeStep(context, 'rectangle', 'rectangleCorner1', ['0', '0', '0']);
    context = shapeStep(context, 'rectangle', 'rectangleCorner2', ['40', '30', '0']);
    context = shapeStep(context, 'ellipse', 'ellipseCenter', ['100', '0', '0']);
    context = shapeStep(context, 'ellipse', 'ellipseShape', ['20', '10']);
    context = shapeStep(context, 'ellipse', 'ellipseAngles', ['0']);
    context = shapeStep(context, 'spline', 'splinePoint', ['200', '0', '0']);
    context = shapeStep(context, 'spline', 'splinePoint', ['210', '10', '0']);
    context = shapeStep(context, 'spline', 'splinePoint', ['220', '0', '0']);
    context = shapeStep(context, 'spline', 'splineShape', []);

    const resolved = resolveSketch(context.document);
    for (const id of featureIds(context.document)) {
      expect(boundaryElementKind(resolved, id), id).toBe('curve');
    }
  });

  it('断りは outcome.rejection に載り、履歴は変わらない(NFR-UX-5)', () => {
    let context = contextOf();
    context = shapeStep(context, 'spline', 'splinePoint', ['0', '0', '0']);
    const state = createNumericInput('spline', 'splineShape');
    const transition = commitNumericInput(state);
    if (transition.kind !== 'committed') {
      throw new Error('確定できませんでした');
    }
    const outcome = commitSketchInput(transition.commit, {
      ...context,
      input: transition.state,
    });
    expect(outcome.rejection).not.toBeNull();
    expect(outcome.document.features).toHaveLength(0);
  });
});

describe('3D スケッチ(作図面なし、FR-330、タスク14)', () => {
  /** 箱の角(5,5,5)を指す頂点の参照。指紋は選んだ瞬間の位置を持つ(タスク10)。 */
  function vertexRef(position: readonly [number, number, number]): SubShapeRef {
    return {
      bodyFeatureId: 'extrude-1',
      index: 3,
      fingerprint: { kind: 'vertex', position },
    };
  }

  it('頂点の参照から、その頂点に付く点の指定ができる', () => {
    const coordinate = subShapeCoordinate(vertexRef([5, 5, 5]));
    expect(coordinate.mode).toBe('relative');
    if (coordinate.mode !== 'relative') {
      return;
    }
    expect(coordinate.base).toEqual({ kind: 'subShape', ref: vertexRef([5, 5, 5]) });
    // ずれは 0。頂点そのものの位置になる。
    expect([coordinate.dx.value, coordinate.dy.value, coordinate.dz.value]).toEqual([0, 0, 0]);
  });

  it('commitSubShapePoint は点フィーチャーを 1 つ積み、頂点の位置に解決される', () => {
    const document = commitSubShapePoint(
      createEmptySketchDocument(),
      FREE_WORK_PLANE_ID,
      vertexRef([5, 5, 5]),
    );
    expect(document.features).toHaveLength(1);
    const feature = document.features[0];
    expect(feature.kind).toBe('point');
    expect(feature.planeId).toBe(FREE_WORK_PLANE_ID);
    const resolved = resolveSketch(document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.points[0].position).toEqual([5, 5, 5]);
  });

  it('元の文書は変わらない(履歴は不変、FR-502)', () => {
    const before = createEmptySketchDocument();
    commitSubShapePoint(before, FREE_WORK_PLANE_ID, vertexRef([1, 2, 3]));
    expect(before.features).toHaveLength(0);
  });

  it('頂点 3 つを結んだ点から面を張れる(FR-330 の「頂点から面」)', () => {
    let document = createEmptySketchDocument();
    for (const position of [[0, 0, 0], [10, 0, 0], [0, 10, 0]] as const) {
      document = commitSubShapePoint(document, FREE_WORK_PLANE_ID, vertexRef(position));
    }
    const resolved = resolveSketch(document);
    const outcome = commitFace(
      document,
      resolved,
      FREE_WORK_PLANE_ID,
      resolved.points.map((point) => point.id),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(resolveSketch(outcome.document).faces).toHaveLength(1);
  });

  it('3D スケッチの円弧には、押していた面から作った向きが付く', () => {
    // 押していた面を「YZ と同じ向き(法線 +X)」にすると、円弧はその面の上に乗る。
    const plane = WORK_PLANES.yz;
    let context = contextOf({ planeId: FREE_WORK_PLANE_ID, plane });
    context = step(context, 'arc', 'arcCenter', 'absolute', ['0', '0', '0']);
    context = step(context, 'arc', 'arcShape', 'absolute', ['10', '0', '90']);
    const arc = context.document.features[0];
    expect(arc.kind).toBe('arc');
    if (arc.kind !== 'arc') {
      return;
    }
    expect(arc.freeOrientation).toBeDefined();
    const resolved = resolveSketch(context.document);
    expect(resolved.errors).toEqual([]);
    // 法線が +X なので、円弧の全ての点の x は 0 のまま。
    expect(resolved.arcs[0].normal).toEqual(plane.normal);
  });

  it('作図面のあるスケッチの円弧には向きを付けない(model が作図面から借りる)', () => {
    let context = contextOf();
    context = step(context, 'arc', 'arcCenter', 'absolute', ['0', '0', '0']);
    context = step(context, 'arc', 'arcShape', 'absolute', ['10', '0', '90']);
    const arc = context.document.features[0];
    if (arc.kind !== 'arc') {
      throw new Error('円弧が積まれていません');
    }
    expect(arc.freeOrientation).toBeUndefined();
  });

  it('作図面から借りた向きと同じ組を作る(freeArcOrientationOf)', () => {
    const orientation = freeArcOrientationOf(WORK_PLANES.xz);
    expect(orientation.normal.mode).toBe('absolute');
    if (orientation.normal.mode !== 'absolute' || orientation.xAxis.mode !== 'absolute') {
      return;
    }
    expect([
      orientation.normal.x.value,
      orientation.normal.y.value,
      orientation.normal.z.value,
    ]).toEqual([...WORK_PLANES.xz.normal]);
    expect([
      orientation.xAxis.x.value,
      orientation.xAxis.y.value,
      orientation.xAxis.z.value,
    ]).toEqual([...WORK_PLANES.xz.axisU]);
  });
});

describe('3D スケッチで頂点どうしを結ぶ線分(FR-330、タスク14)', () => {
  function vertexAt(position: readonly [number, number, number]): SubShapeRef {
    return { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'vertex', position } };
  }

  /** 頂点を押して座標を決めた 1 段(`attachSketchInteraction` の頂点の経路と同じ形)。 */
  function vertexStep(
    context: CommitContext,
    inputStep: NumericInputStep,
    ref: SubShapeRef,
  ): CommitContext {
    const state = reduceNumericInput(
      reduceNumericInput(createNumericInput('line', inputStep), {
        type: 'setMode',
        mode: 'relative',
      }),
      { type: 'setValues', values: [0, 0, 0] },
    );
    const transition = commitNumericInput(state, { base: { kind: 'subShape', ref } });
    if (transition.kind !== 'committed') {
      throw new Error(`確定できませんでした: ${transition.kind}`);
    }
    const outcome = commitSketchInput(transition.commit, context);
    return { ...context, document: outcome.document, pendingStart: outcome.pendingStart };
  }

  it('始点と終点を頂点で決めた線分が、その 2 頂点を結ぶ', () => {
    let context = contextOf({ planeId: FREE_WORK_PLANE_ID });
    context = vertexStep(context, 'lineStart', vertexAt([0, 0, 10]));
    context = vertexStep(context, 'lineEnd', vertexAt([40, 0, 10]));
    const resolved = resolveSketch(context.document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0].from).toEqual([0, 0, 10]);
    // 終点の基準を「直前の点」へ置き換えてしまうと、ここが (0,0,10) になり長さ 0 で断られる。
    expect(resolved.segments[0].to).toEqual([40, 0, 10]);
  });

  it('数値で打った終点は、これまでどおり自分の始点からのずれになる(FR-307)', () => {
    let context = contextOf();
    context = step(context, 'line', 'lineStart', 'absolute', ['0', '0', '0']);
    context = step(context, 'line', 'lineEnd', 'relative', ['10', '0', '0']);
    const resolved = resolveSketch(context.document);
    expect(resolved.segments[0].from).toEqual([0, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 0, 0]);
  });
});
