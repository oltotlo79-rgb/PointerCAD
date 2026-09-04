import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  createEmptyPartDocument,
  type CoordinateInput,
  type PartDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { ReferenceInputCommit, ReferenceNumericInputStep } from './numericInput.js';
import {
  appendCoordinatePoints,
  commitCoordinateSystem,
  commitReferenceAxis,
  commitReferenceInput,
  commitReferencePoint,
  commitReferenceInput as runStep,
  commitWorkPlane,
  EMPTY_REFERENCE_DRAFT,
  parseAxisSpec,
  referenceAxisOptionsOf,
  resolveReferencesOf,
  resolveWorkPlaneOf,
  workPlaneEntries,
  type ReferenceCommitContext,
  type ReferenceCommitOutcome,
} from './referenceCommands.js';

/** 位置・向きの突き合わせに使う許容量。回転の丸めぶんだけ緩める。 */
const TOLERANCE = 1e-9;

function value(source: number) {
  return expressionValueFromNumber(source);
}

function at(x: number, y: number, z: number): CoordinateInput {
  return absoluteCoordinate(x, y, z);
}

function contextOf(overrides: Partial<ReferenceCommitContext> = {}): ReferenceCommitContext {
  return {
    document: createEmptyPartDocument(),
    planeId: 'xy',
    bodies: [],
    selection: [],
    draft: EMPTY_REFERENCE_DRAFT,
    ...overrides,
  };
}

function commitOf(
  step: ReferenceNumericInputStep,
  overrides: Partial<ReferenceInputCommit> = {},
): ReferenceInputCommit {
  return {
    kind: 'reference',
    tool: 'referencePlaneThreePoints',
    step,
    coordinate: null,
    mode: null,
    values: {},
    choices: {},
    ...overrides,
  };
}

/** 段をいくつか続けて流す。各段の結果の下書き・文書を次の段へ引き継ぐ。 */
function runSteps(
  context: ReferenceCommitContext,
  commits: readonly ReferenceInputCommit[],
): ReferenceCommitOutcome {
  let current = context;
  let outcome: ReferenceCommitOutcome = {
    document: context.document,
    draft: context.draft,
    rejection: null,
    featureId: null,
    createdPlaneId: null,
  };
  for (const commit of commits) {
    outcome = runStep(commit, current);
    current = { ...current, document: outcome.document, draft: outcome.draft };
  }
  return outcome;
}

/** 3 点(原点・(10,0,0)・(0,10,0))で作業平面を作るひと続き。 */
function threePointPlane(context: ReferenceCommitContext = contextOf()): ReferenceCommitOutcome {
  return runSteps(context, [
    commitOf('referencePlanePoint1', { coordinate: at(0, 0, 0), mode: 'absolute' }),
    commitOf('referencePlanePoint2', { coordinate: at(10, 0, 0), mode: 'absolute' }),
    commitOf('referencePlanePoint3', { coordinate: at(0, 10, 0), mode: 'absolute' }),
  ]);
}

function kindsOf(document: PartDocument): readonly string[] {
  return document.references.map((feature) => feature.kind);
}

describe('基準ジオメトリを 1 つ作る(FR-328、FR-329)', () => {
  it('作業平面は referencePlane として積まれ、既定で表示される', () => {
    const document = createEmptyPartDocument();
    const outcome = commitWorkPlane(document, { kind: 'workPlane', planeId: 'xy', offset: value(5) });
    const feature = outcome.document.references[0];
    expect(feature.kind).toBe('referencePlane');
    expect(feature.visible).toBe(true);
    expect(feature.id).toBe(outcome.featureId);
    expect(feature.name).toBe('作業平面1');
  });

  it('基準軸は referenceAxis として積まれる', () => {
    const outcome = commitReferenceAxis(createEmptyPartDocument(), {
      kind: 'twoPoints',
      from: { kind: 'origin' },
      to: { kind: 'origin' },
    });
    const feature = outcome.document.references[0];
    expect(feature.kind).toBe('referenceAxis');
    expect(feature.visible).toBe(true);
  });

  it('基準点は referencePoint として積まれる', () => {
    const outcome = commitReferencePoint(createEmptyPartDocument(), {
      kind: 'coordinate',
      at: at(1, 2, 3),
    });
    expect(outcome.document.references[0].kind).toBe('referencePoint');
  });

  it('座標系は referenceCoordinateSystem として積まれる', () => {
    const outcome = commitCoordinateSystem(
      createEmptyPartDocument(),
      { kind: 'origin' },
      { kind: 'world', axis: 'x' },
      { kind: 'world', axis: 'y' },
    );
    const feature = outcome.document.references[0];
    expect(feature.kind).toBe('referenceCoordinateSystem');
    expect(feature.name).toBe('座標系1');
  });

  it('元の文書は書き換えない(不変)', () => {
    const document = createEmptyPartDocument();
    commitWorkPlane(document, { kind: 'workPlane', planeId: 'xy', offset: value(1) });
    expect(document.references).toHaveLength(0);
  });
});

describe('置いた座標を基準点として積む', () => {
  it('1 点目は原点、2 点目以降は 1 つ前の基準点を基準にする', () => {
    const outcome = appendCoordinatePoints(createEmptyPartDocument(), [
      { mode: 'relative', base: { kind: 'previous' }, dx: value(1), dy: value(0), dz: value(0) },
      { mode: 'relative', base: { kind: 'previous' }, dx: value(0), dy: value(2), dz: value(0) },
    ]);
    const first = outcome.document.references[0];
    const second = outcome.document.references[1];
    expect(first.kind === 'referencePoint' && first.definition.kind === 'coordinate').toBe(true);
    if (first.kind === 'referencePoint' && first.definition.kind === 'coordinate') {
      expect(first.definition.at.mode === 'relative' && first.definition.at.base).toEqual({
        kind: 'origin',
      });
    }
    if (second.kind === 'referencePoint' && second.definition.kind === 'coordinate') {
      expect(second.definition.at.mode === 'relative' && second.definition.at.base).toEqual({
        kind: 'point',
        pointId: first.id,
      });
    }
    expect(outcome.points).toEqual([
      { kind: 'point', pointId: first.id },
      { kind: 'point', pointId: second.id },
    ]);
  });

  it('平面を決めるためだけの点は画面に出さない', () => {
    const outcome = appendCoordinatePoints(createEmptyPartDocument(), [at(0, 0, 0)]);
    expect(outcome.document.references[0].visible).toBe(false);
  });
});

describe('軸の選択肢を軸の指定へ直す', () => {
  it('x / y / z はワールドの軸になる', () => {
    expect(parseAxisSpec('y')).toEqual({ kind: 'world', axis: 'y' });
  });

  it('reference: で始まる値は文書の基準軸になる', () => {
    expect(parseAxisSpec('reference:referenceAxis-1')).toEqual({
      kind: 'reference',
      referenceFeatureId: 'referenceAxis-1',
    });
  });

  it('知らない値・id の無い値は null', () => {
    expect(parseAxisSpec('line')).toBeNull();
    expect(parseAxisSpec('reference:')).toBeNull();
    expect(parseAxisSpec(undefined)).toBeNull();
  });
});

describe('文書から一覧を作る', () => {
  it('作図面の一覧には作業平面だけが履歴の順に並ぶ', () => {
    const withAxis = commitReferenceAxis(createEmptyPartDocument(), {
      kind: 'twoPoints',
      from: { kind: 'origin' },
      to: { kind: 'origin' },
    });
    const withPlane = commitWorkPlane(withAxis.document, {
      kind: 'workPlane',
      planeId: 'xz',
      offset: value(3),
    });
    expect(workPlaneEntries(withPlane.document)).toEqual([
      { id: withPlane.featureId, name: '作業平面1', visible: true },
    ]);
  });

  it('軸の選択肢の一覧には基準軸だけが並ぶ', () => {
    const withPlane = commitWorkPlane(createEmptyPartDocument(), {
      kind: 'workPlane',
      planeId: 'xy',
      offset: value(1),
    });
    const withAxis = commitReferenceAxis(withPlane.document, {
      kind: 'twoPoints',
      from: { kind: 'origin' },
      to: { kind: 'origin' },
    });
    expect(referenceAxisOptionsOf(withAxis.document)).toEqual([
      { id: withAxis.featureId, name: '基準軸1' },
    ]);
  });
});

describe('3 点で作業平面を作る(FR-328)', () => {
  it('3 点目で平面が決まり、点と平面が同じ 1 回の変更で積まれる', () => {
    const outcome = threePointPlane();
    // 1 回の確定で 3 点 + 平面。Undo は 1 回で元へ戻る。
    expect(kindsOf(outcome.document)).toEqual([
      'referencePoint',
      'referencePoint',
      'referencePoint',
      'referencePlane',
    ]);
    expect(outcome.createdPlaneId).toBe(outcome.featureId);
    expect(outcome.rejection).toBeNull();
  });

  it('2 点目までは履歴を変えず、下書きへためる', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePlanePoint1', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referencePlanePoint2', { coordinate: at(10, 0, 0), mode: 'absolute' }),
    ]);
    expect(outcome.document.references).toHaveLength(0);
    expect(outcome.draft.points).toHaveLength(2);
  });

  it('できた平面の法線は XY と同じ向きになる', () => {
    const outcome = threePointPlane();
    const planeId = outcome.createdPlaneId;
    expect(planeId).not.toBeNull();
    const plane = resolveWorkPlaneOf(outcome.document, planeId ?? 'xy');
    expect(plane.normal[0]).toBeCloseTo(0, 9);
    expect(plane.normal[1]).toBeCloseTo(0, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
  });

  it('3 点が一直線なら日本語で断る(FR-504)', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePlanePoint1', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referencePlanePoint2', { coordinate: at(10, 0, 0), mode: 'absolute' }),
      commitOf('referencePlanePoint3', { coordinate: at(20, 0, 0), mode: 'absolute' }),
    ]);
    const errors = resolveReferencesOf(outcome.document).errors;
    expect(errors.map((error) => error.code)).toContain('collinear');
    expect(errors[0].message).toContain('一直線');
  });
});

describe('面から離した作業平面(FR-328)', () => {
  it('いまの作図面から 10mm 離すと原点が Z へ 10 動く', () => {
    const outcome = runStep(
      commitOf('referencePlaneOffset', { values: { offset: value(10) } }),
      contextOf({ draft: { points: [], choices: { planeBase: 'current' } } }),
    );
    const plane = resolveWorkPlaneOf(outcome.document, outcome.createdPlaneId ?? 'xy');
    expect(plane.origin[2]).toBeCloseTo(10, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
  });

  it('基準の 3 面を選んだときはその面が基準になる', () => {
    const outcome = runStep(
      commitOf('referencePlaneOffset', { values: { offset: value(4) } }),
      contextOf({ planeId: 'xy', draft: { points: [], choices: { planeBase: 'yz' } } }),
    );
    const plane = resolveWorkPlaneOf(outcome.document, outcome.createdPlaneId ?? 'xy');
    expect(plane.origin[0]).toBeCloseTo(4, 9);
  });

  it('「選んだ面」なのに平らな面を選んでいなければ断り、履歴を変えない(NFR-UX-5)', () => {
    const context = contextOf({ draft: { points: [], choices: { planeBase: 'face' } } });
    const outcome = runStep(
      commitOf('referencePlaneOffset', { values: { offset: value(10) } }),
      context,
    );
    expect(outcome.document).toBe(context.document);
    expect(outcome.rejection).toBe('平らな面を 1 つ選んでから決定してください。');
  });
});

describe('作図面を傾けた作業平面(FR-328)', () => {
  it('XY を X 軸まわりに 90 度傾けると法線が (0,-1,0) になる', () => {
    const outcome = runStep(
      commitOf('referencePlaneTilt', { values: { angle: value(90) } }),
      contextOf({ draft: { points: [], choices: { axis: 'x' } } }),
    );
    const plane = resolveWorkPlaneOf(outcome.document, outcome.createdPlaneId ?? 'xy');
    expect(plane.normal[0]).toBeCloseTo(0, 9);
    expect(plane.normal[1]).toBeCloseTo(-1, 9);
    expect(plane.normal[2]).toBeCloseTo(0, 9);
  });

  it('軸が選ばれていなければ断る', () => {
    const outcome = runStep(
      commitOf('referencePlaneTilt', { values: { angle: value(90) } }),
      contextOf(),
    );
    expect(outcome.rejection).toBe('軸が選ばれていません。軸を選んでから決定してください。');
  });
});

describe('点を通る作業平面(FR-328)', () => {
  it('軸に垂直を選ぶと、その点を通り軸に垂直な平面になる', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePlaneBasePoint', { coordinate: at(0, 0, 5), mode: 'absolute' }),
      commitOf('referencePlaneThrough', {
        values: { tilt: value(0), azimuth: value(0) },
        choices: { throughMode: 'axis', axis: 'z' },
      }),
    ]);
    const plane = resolveWorkPlaneOf(outcome.document, outcome.createdPlaneId ?? 'xy');
    expect(plane.origin[2]).toBeCloseTo(5, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
  });

  it('辺を基準にするのに辺を選んでいなければ断る', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePlaneBasePoint', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referencePlaneThrough', { choices: { throughMode: 'perpendicularEdge' } }),
    ]);
    expect(outcome.rejection).toBe('まっすぐな辺を 1 本選んでから決定してください。');
    expect(outcome.document.references).toHaveLength(0);
  });
});

describe('基準軸を作る(FR-329)', () => {
  it('2 点を選ぶと点を聞きに進み、まだ何も積まない', () => {
    const outcome = runStep(
      commitOf('referenceAxisKind', { choices: { axisKind: 'twoPoints' } }),
      contextOf(),
    );
    expect(outcome.document.references).toHaveLength(0);
    expect(outcome.rejection).toBeNull();
  });

  it('2 点で作った軸は 1 点目から 2 点目への向きになる', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referenceAxisKind', { choices: { axisKind: 'twoPoints' } }),
      commitOf('referenceAxisStart', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referenceAxisEnd', { coordinate: at(10, 0, 0), mode: 'absolute' }),
    ]);
    const axes = resolveReferencesOf(outcome.document).axes;
    expect(axes).toHaveLength(1);
    expect(axes[0].direction[0]).toBeCloseTo(1, 9);
    expect(Math.abs(axes[0].direction[1])).toBeLessThan(TOLERANCE);
  });

  it('辺から作るのに辺を選んでいなければ断る', () => {
    const outcome = runStep(
      commitOf('referenceAxisKind', { choices: { axisKind: 'edge' } }),
      contextOf(),
    );
    expect(outcome.rejection).toBe('まっすぐな辺を 1 本選んでから決定してください。');
  });

  it('2 面の交線を選んだのに面が 2 つ無ければ断る', () => {
    const outcome = runStep(
      commitOf('referenceAxisKind', { choices: { axisKind: 'faceIntersection' } }),
      contextOf(),
    );
    expect(outcome.rejection).toBe('平らな面を 2 つ選んでから決定してください。');
  });
});

describe('基準点を作る(FR-329)', () => {
  it('座標で決めるときは位置を聞きに進み、そこで積む', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePointKind', { choices: { pointKind: 'coordinate' } }),
      commitOf('referencePointAt', { coordinate: at(1, 2, 3), mode: 'absolute' }),
    ]);
    expect(kindsOf(outcome.document)).toEqual(['referencePoint']);
    // 座標で作った基準点は画面に出す(平面を決めるためだけの点とは違う)。
    expect(outcome.document.references[0].visible).toBe(true);
    const points = resolveReferencesOf(outcome.document).points;
    expect(points[0].position).toEqual([1, 2, 3]);
  });

  it('頂点から作るのに頂点を選んでいなければ断る', () => {
    const outcome = runStep(
      commitOf('referencePointKind', { choices: { pointKind: 'vertex' } }),
      contextOf(),
    );
    expect(outcome.rejection).toBe('頂点を 1 つ選んでから決定してください。');
  });
});

describe('基準座標系を作る(FR-329)', () => {
  it('原点と 2 軸から、第 3 軸が導かれる', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referenceCsOrigin', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referenceCsAxes', { choices: { csXAxis: 'x', csYAxis: 'y' } }),
    ]);
    const systems = resolveReferencesOf(outcome.document).coordinateSystems;
    expect(systems).toHaveLength(1);
    expect(systems[0].zAxis[2]).toBeCloseTo(1, 9);
  });

  it('軸が選ばれていなければ断る', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referenceCsOrigin', { coordinate: at(0, 0, 0), mode: 'absolute' }),
      commitOf('referenceCsAxes', {}),
    ]);
    expect(outcome.rejection).toBe('軸が選ばれていません。軸を選んでから決定してください。');
  });
});

describe('作図面を解く', () => {
  it('基準の 3 面はそのまま引ける', () => {
    expect(resolveWorkPlaneOf(createEmptyPartDocument(), 'xz').id).toBe('xz');
  });

  it('見つからない作業平面を指しても止めず、XY へ落とす(FR-504)', () => {
    expect(resolveWorkPlaneOf(createEmptyPartDocument(), 'referencePlane-9').id).toBe('xy');
  });

  it('基準ジオメトリが無い文書では失敗も出ない', () => {
    expect(resolveReferencesOf(createEmptyPartDocument())).toEqual({
      planes: [],
      axes: [],
      points: [],
      coordinateSystems: [],
      errors: [],
    });
  });

  it('後から作られた基準軸を指した平面は、理由つきで断られる(履歴順)', () => {
    // 平面を先に、軸を後に作り、平面が軸を指すよう差し替える(履歴順の違反を作る)。
    const withPlane = commitWorkPlane(createEmptyPartDocument(), {
      kind: 'tilted',
      base: 'xy',
      axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
      angle: value(30),
    });
    const withAxis = commitReferenceAxis(withPlane.document, {
      kind: 'twoPoints',
      from: { kind: 'origin' },
      to: { kind: 'origin' },
    });
    const errors = resolveReferencesOf(withAxis.document).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('後から作られた');
  });
});

describe('確定の受け口(commitReferenceInput)', () => {
  it('前の段で選んだ決め方は、次の段でも残る', () => {
    const outcome = runSteps(contextOf(), [
      commitOf('referencePointKind', { choices: { pointKind: 'coordinate' } }),
    ]);
    expect(outcome.draft.choices.pointKind).toBe('coordinate');
  });

  it('断ったときは取りかけを残さない(NFR-UX-3)', () => {
    const outcome = commitReferenceInput(
      commitOf('referenceAxisKind', { choices: { axisKind: 'edge' } }),
      contextOf({ draft: { points: [at(0, 0, 0)], choices: {} } }),
    );
    expect(outcome.draft).toEqual(EMPTY_REFERENCE_DRAFT);
  });
});
