import { expressionValueFromNumber as num } from '@pointercad/expression';
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import { WORK_PLANES, type WorkPlane } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchElementRef,
  SketchFeature,
} from '../types.js';
import {
  buildResidualReport,
  buildResiduals,
  implicitEquationId,
  isImplicitConstraintId,
  type ResidualRow,
} from './residuals.js';
import type { ConstraintTarget, SketchConstraint } from './types.js';
import { collectVariables, type VariableSet } from './variables.js';

// --- 文書の組み立て -------------------------------------------------------

function documentOf(
  features: SketchFeature[],
  constraints: SketchConstraint[] = [],
): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features, constraints };
}

function lineOf(id: string, from: CoordinateInput, to: CoordinateInput): SketchFeature {
  return { id, kind: 'line', name: id, planeId: 'xy', from, to, construction: false };
}

/** 作図面 XY 上の線分(作図面の (u, v) がそのまま世界の (x, y) になる)。 */
function segmentOf(
  id: string,
  fromU: number,
  fromV: number,
  toU: number,
  toV: number,
): SketchFeature {
  return lineOf(id, absoluteCoordinate(fromU, fromV, 0), absoluteCoordinate(toU, toV, 0));
}

function pointOf(id: string, u: number, v: number): SketchFeature {
  return { id, kind: 'point', name: id, planeId: 'xy', at: absoluteCoordinate(u, v, 0) };
}

/**
 * 円弧。既定(0°→360°)は全周の円で、端点を持たないので暗黙の式が立たない。
 * 開始角と終了角を渡すと円弧になり、端点 2 つが変数になって暗黙の式が 2 本立つ。
 */
function arcOf(
  id: string,
  centerU: number,
  centerV: number,
  radius: number,
  startAngle = 0,
  endAngle = 360,
): SketchFeature {
  return {
    id,
    kind: 'arc',
    name: id,
    planeId: 'xy',
    center: absoluteCoordinate(centerU, centerV, 0),
    radius: num(radius),
    startAngle: num(startAngle),
    endAngle: num(endAngle),
    construction: false,
  };
}

function variablesOf(document: SketchDocument, plane: WorkPlane = WORK_PLANES.xy): VariableSet {
  return collectVariables(document, resolveSketch(document), plane);
}

// --- 指し先の書き方 -------------------------------------------------------

function curveTarget(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

function pointTarget(pointId: string): ConstraintTarget {
  return { kind: 'point', pointId };
}

function elementRef(featureId: string): SketchElementRef {
  return { featureId };
}

// --- 検査の道具 -----------------------------------------------------------

function columnOf(variableSet: VariableSet, key: string): number {
  const column = variableSet.index.get(key);
  if (column === undefined) {
    throw new Error(`変数がありません: ${key}`);
  }
  return column;
}

/** その変数についての偏微分(項が無ければ 0)。 */
function slopeOf(variableSet: VariableSet, row: ResidualRow, key: string): number {
  return row.gradient.get(columnOf(variableSet, key)) ?? 0;
}

function valuesOf(rows: readonly ResidualRow[]): number[] {
  return rows.map((row) => row.value);
}

/** その拘束が出した行だけを取り出す(円弧の暗黙の式を混ぜない)。 */
function rowsOf(
  constraint: SketchConstraint,
  variableSet: VariableSet,
  x: readonly number[],
): readonly ResidualRow[] {
  return buildResiduals([constraint], variableSet, x).filter(
    (row) => row.constraintId === constraint.id,
  );
}

/**
 * 解析式の偏微分を中心差分(h = 1e-6)と突き合わせる。
 * 中心差分の誤差は打ち切りが h² ≒ 1e-12、丸めが eps/h ≒ 1e-10 なので、
 * 相対 1e-6 の許容量は実装の誤り(符号違い・項の抜け)だけを捕まえる大きさになる。
 */
const FINITE_DIFFERENCE_STEP = 1e-6;

function expectGradientMatchesFiniteDifference(
  constraints: readonly SketchConstraint[],
  variableSet: VariableSet,
  x: readonly number[],
): void {
  const rows = buildResiduals(constraints, variableSet, x);
  expect(rows.length).toBeGreaterThan(0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let column = 0; column < x.length; column += 1) {
      const forward = [...x];
      forward[column] += FINITE_DIFFERENCE_STEP;
      const backward = [...x];
      backward[column] -= FINITE_DIFFERENCE_STEP;
      const numeric =
        (buildResiduals(constraints, variableSet, forward)[rowIndex].value -
          buildResiduals(constraints, variableSet, backward)[rowIndex].value) /
        (2 * FINITE_DIFFERENCE_STEP);
      const analytic = rows[rowIndex].gradient.get(column) ?? 0;
      expect(Number.isNaN(analytic)).toBe(false);
      expect(Math.abs(numeric - analytic)).toBeLessThanOrEqual(
        1e-6 * Math.max(1, Math.abs(analytic)),
      );
    }
  }
}

// --- 残差の値(計画書 タスク5 の表) --------------------------------------

describe('残差の値(FR-313、P4b タスク5)', () => {
  it('一致: 2 点の差 2 本(p=(3,4)、q=(7,1) で [−4, 3])', () => {
    const document = documentOf([pointOf('point-1', 3, 4), pointOf('point-2', 7, 1)]);
    const set = variablesOf(document);
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '一致1',
      kind: 'coincident',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(valuesOf(rows)).toEqual([-4, 3]);
    expect(slopeOf(set, rows[0], 'point-1.u')).toBe(1);
    expect(slopeOf(set, rows[0], 'point-2.u')).toBe(-1);
    expect(slopeOf(set, rows[1], 'point-1.v')).toBe(1);
    expect(slopeOf(set, rows[1], 'point-2.v')).toBe(-1);
  });

  it('水平: 作図面の第 2 軸の差(線分 (0,0)–(7,4) で −4)', () => {
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '水平1',
      kind: 'horizontal',
      target: curveTarget('line-1'),
    };
    expect(valuesOf(rowsOf(constraint, set, set.initial))).toEqual([-4]);
  });

  it('垂直: 作図面の第 1 軸の差(線分 (0,0)–(7,4) で −7)', () => {
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '垂直1',
      kind: 'vertical',
      target: curveTarget('line-1'),
    };
    expect(valuesOf(rowsOf(constraint, set, set.initial))).toEqual([-7]);
  });

  it('平行: 単位ベクトルの外積(û1=(1,0)、û2=(0.6,0.8) で 0.8)', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), segmentOf('line-2', 0, 0, 6, 8)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '平行1',
      kind: 'parallel',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeCloseTo(0.8, 12);
  });

  it('直角: 単位ベクトルの内積(同じ 2 本で 0.6)', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), segmentOf('line-2', 0, 0, 6, 8)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '直角1',
      kind: 'perpendicular',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    };
    expect(rowsOf(constraint, set, set.initial)[0].value).toBeCloseTo(0.6, 12);
  });

  it('接線: 中心から直線までの符号つき距離 − 半径(10 − 5 = 5)', () => {
    const set = variablesOf(
      documentOf([arcOf('circle-1', 0, 0, 5), segmentOf('line-1', 0, 10, 10, 10)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '接線1',
      kind: 'tangent',
      line: curveTarget('line-1'),
      circle: curveTarget('circle-1'),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows[0].value).toBeCloseTo(5, 12);
    expect(slopeOf(set, rows[0], 'circle-1.r')).toBe(-1);
  });

  it('同心: 中心の差 2 本(c1=(0,0)、c2=(3,4) で [−3, −4])', () => {
    const set = variablesOf(documentOf([arcOf('circle-1', 0, 0, 5), arcOf('circle-2', 3, 4, 7)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '同心1',
      kind: 'concentric',
      a: curveTarget('circle-1'),
      b: curveTarget('circle-2'),
    };
    expect(valuesOf(rowsOf(constraint, set, set.initial))).toEqual([-3, -4]);
  });

  it('等しい(線分): 長さの差(10 − 6 = 4)', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), segmentOf('line-2', 0, 0, 0, 6)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '等しい1',
      kind: 'equal',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    };
    expect(rowsOf(constraint, set, set.initial)[0].value).toBeCloseTo(4, 12);
  });

  it('等しい(円): 半径の差(3 − 7 = −4)', () => {
    const set = variablesOf(documentOf([arcOf('circle-1', 0, 0, 3), arcOf('circle-2', 20, 0, 7)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '等しい1',
      kind: 'equal',
      a: curveTarget('circle-1'),
      b: curveTarget('circle-2'),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows[0].value).toBeCloseTo(-4, 12);
    expect(slopeOf(set, rows[0], 'circle-1.r')).toBe(1);
    expect(slopeOf(set, rows[0], 'circle-2.r')).toBe(-1);
  });

  it('対称: 中点の軸からの距離と、結ぶ線と軸の内積([−3, 0])', () => {
    // p=(2,3)、q=(2,−9)、軸=(0,0)–(10,0)。中点 (2,−3) の軸からの符号つき距離 −3、
    // 結ぶ線 (0,12) と軸の向き (1,0) の内積 0。
    const set = variablesOf(
      documentOf([
        pointOf('point-1', 2, 3),
        pointOf('point-2', 2, -9),
        segmentOf('line-1', 0, 0, 10, 0),
      ]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '対称1',
      kind: 'symmetric',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      axis: elementRef('line-1'),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBeCloseTo(-3, 12);
    expect(rows[1].value).toBeCloseTo(0, 12);
  });

  it('距離: 2 点の間の長さ − 目標値(5 − 10 = −5)', () => {
    const set = variablesOf(documentOf([pointOf('point-1', 0, 0), pointOf('point-2', 3, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '距離1',
      kind: 'distance',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      length: num(10),
    };
    expect(rowsOf(constraint, set, set.initial)[0].value).toBeCloseTo(-5, 12);
  });

  it('角度: dot·sinθ − cross·cosθ(û1=(1,0)、û2=(0,1)、θ=30° で −√3/2)', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), segmentOf('line-2', 0, 0, 0, 10)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '角度1',
      kind: 'angle',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
      angle: num(30),
    };
    expect(rowsOf(constraint, set, set.initial)[0].value).toBeCloseTo(-0.866025403784, 12);
  });

  it('半径: 半径 − 目標値(3 − 8 = −5)', () => {
    const set = variablesOf(documentOf([arcOf('circle-1', 0, 0, 3)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '半径1',
      kind: 'radius',
      target: curveTarget('circle-1'),
      size: num(8),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows[0].value).toBeCloseTo(-5, 12);
    expect(slopeOf(set, rows[0], 'circle-1.r')).toBe(1);
  });

  it('直径: 半径の 2 倍 − 目標値(2·3 − 20 = −14)', () => {
    const set = variablesOf(documentOf([arcOf('circle-1', 0, 0, 3)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '直径1',
      kind: 'diameter',
      target: curveTarget('circle-1'),
      size: num(20),
    };
    const rows = rowsOf(constraint, set, set.initial);
    expect(rows[0].value).toBeCloseTo(-14, 12);
    expect(slopeOf(set, rows[0], 'circle-1.r')).toBe(2);
  });

  it('固定は式を 1 本も出さない(変数を減らす道具なので)', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '固定1',
        kind: 'fix',
        target: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
      },
    ];
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4)], constraints));
    const report = buildResidualReport(constraints, set, set.initial);
    expect(report.rows).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
  });

  it('円弧の端点は「円周の上にある」暗黙の式 2 本を持ち、そのままなら残差 0', () => {
    const set = variablesOf(documentOf([arcOf('arc-1', 0, 0, 5, 0, 90)]));
    expect(set.implicit).toHaveLength(2);
    const rows = buildResiduals([], set, set.initial);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => isImplicitConstraintId(row.constraintId))).toBe(true);
    expect(Math.abs(rows[0].value)).toBeLessThan(1e-12);
    expect(Math.abs(rows[1].value)).toBeLessThan(1e-12);
    expect(rows[0].constraintId).toBe(implicitEquationId(set.implicit[0]));
    // 半径を増やせば端点は円周の内側に取り残される(残差は −1 の傾きで動く)。
    expect(slopeOf(set, rows[0], 'arc-1.r')).toBe(-1);
  });

  it('全周の円には暗黙の式が立たない(端点を持たないため)', () => {
    const set = variablesOf(documentOf([arcOf('circle-1', 0, 0, 5)]));
    expect(set.implicit).toHaveLength(0);
    expect(buildResiduals([], set, set.initial)).toHaveLength(0);
  });

  it('残差が 0 の配置ではすべての残差が 0(水平・距離・半径をちょうど満たす形)', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c1', name: '水平1', kind: 'horizontal', target: curveTarget('line-1') },
      {
        id: 'c2',
        name: '距離1',
        kind: 'distance',
        a: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
        b: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
        length: num(10),
      },
      { id: 'c3', name: '半径1', kind: 'radius', target: curveTarget('circle-1'), size: num(8) },
    ];
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), arcOf('circle-1', 30, 0, 8)], constraints),
    );
    const rows = buildResiduals(constraints, set, set.initial);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Math.abs(row.value)).toBeLessThan(1e-12);
    }
  });
});

// --- 偏微分 vs 中心差分 ---------------------------------------------------

/**
 * 14 種すべてと円弧の暗黙の式を 1 つの文書の上で確かめる。
 * 点・線分・円・円弧をすべて自由にしてあるので、どの拘束にも勾配の項が出る。
 * 線分は軸に沿わせない(軸に沿うと勾配の項がたまたま 0 になり、抜けを見逃す)。
 */
function allShapesDocument(constraints: SketchConstraint[] = []): SketchDocument {
  return documentOf(
    [
      pointOf('point-1', 3, 4),
      pointOf('point-2', 7, 1),
      pointOf('point-3', -5, -5),
      segmentOf('line-1', 0, 0, 6, 8),
      segmentOf('line-2', 1, 2, 9, 4),
      arcOf('circle-1', 2, 3, 5),
      arcOf('circle-2', 11, -4, 7),
      arcOf('arc-1', 20, 0, 4, 0, 90),
    ],
    constraints,
  );
}

/** 14 種を 1 つずつ。id は重ならないようにしてあるので、まとめて渡すこともできる。 */
const GRADIENT_CASES: readonly (readonly [string, SketchConstraint])[] = [
  [
    '一致',
    {
      id: 'k1',
      name: '一致1',
      kind: 'coincident',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
    },
  ],
  ['水平', { id: 'k2', name: '水平1', kind: 'horizontal', target: curveTarget('line-1') }],
  ['垂直', { id: 'k3', name: '垂直1', kind: 'vertical', target: curveTarget('line-1') }],
  [
    '平行',
    { id: 'k4', name: '平行1', kind: 'parallel', a: curveTarget('line-1'), b: curveTarget('line-2') },
  ],
  [
    '直角',
    {
      id: 'k5',
      name: '直角1',
      kind: 'perpendicular',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    },
  ],
  [
    '接線',
    {
      id: 'k6',
      name: '接線1',
      kind: 'tangent',
      line: curveTarget('line-1'),
      circle: curveTarget('circle-1'),
    },
  ],
  [
    '同心',
    {
      id: 'k7',
      name: '同心1',
      kind: 'concentric',
      a: curveTarget('circle-1'),
      b: curveTarget('circle-2'),
    },
  ],
  [
    '等しい(線分)',
    { id: 'k8', name: '等しい1', kind: 'equal', a: curveTarget('line-1'), b: curveTarget('line-2') },
  ],
  [
    '等しい(円)',
    {
      id: 'k9',
      name: '等しい2',
      kind: 'equal',
      a: curveTarget('circle-1'),
      b: curveTarget('circle-2'),
    },
  ],
  [
    '対称',
    {
      id: 'k10',
      name: '対称1',
      kind: 'symmetric',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      axis: elementRef('line-1'),
    },
  ],
  [
    '距離',
    {
      id: 'k11',
      name: '距離1',
      kind: 'distance',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      length: num(10),
    },
  ],
  [
    '角度',
    {
      id: 'k12',
      name: '角度1',
      kind: 'angle',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
      angle: num(30),
    },
  ],
  [
    '半径',
    { id: 'k13', name: '半径1', kind: 'radius', target: curveTarget('circle-1'), size: num(8) },
  ],
  [
    '直径',
    { id: 'k14', name: '直径1', kind: 'diameter', target: curveTarget('circle-1'), size: num(20) },
  ],
  [
    '固定(式は出ないが、円弧の暗黙の式は残る)',
    { id: 'k15', name: '固定1', kind: 'fix', target: pointTarget('point-3') },
  ],
];

const ALL_KIND_CONSTRAINTS: readonly SketchConstraint[] = GRADIENT_CASES.map(
  ([, constraint]) => constraint,
);

describe('偏微分は中心差分と一致する(h = 1e-6、相対 1e-6 以下)', () => {
  for (const [label, constraint] of GRADIENT_CASES) {
    it(label, () => {
      // 「固定」は変数を減らすので、変数の切り出しの段から拘束を渡す。
      const set = variablesOf(allShapesDocument([constraint]));
      expectGradientMatchesFiniteDifference([constraint], set, set.initial);
    });
  }

  it('初期値から離れた x でも一致する(反復の途中を模した位置)', () => {
    const set = variablesOf(allShapesDocument());
    // 反復の途中では変数が初期値から動く。並びは決め打ちなので、番号で少しずつずらす。
    const moved = set.initial.map((value, column) => value + 0.37 * (column % 5) - 0.11);
    for (const constraint of ALL_KIND_CONSTRAINTS) {
      expectGradientMatchesFiniteDifference([constraint], set, moved);
    }
  });

  it('14 種をまとめて渡しても各行の偏微分が一致する', () => {
    const set = variablesOf(allShapesDocument([...ALL_KIND_CONSTRAINTS]));
    expectGradientMatchesFiniteDifference(ALL_KIND_CONSTRAINTS, set, set.initial);
  });
});

// --- 縮退(特異点) -------------------------------------------------------

/** 線分 line-2 の終点を始点へ重ねた x(長さ 0 の線分)。 */
function collapsedLine(set: VariableSet): number[] {
  const x = [...set.initial];
  x[columnOf(set, 'line-2:end.u')] = x[columnOf(set, 'line-2:start.u')];
  x[columnOf(set, 'line-2:end.v')] = x[columnOf(set, 'line-2:start.v')];
  return x;
}

describe('縮退では残差を作らず、日本語の理由を返す(NaN を出さない)', () => {
  it('長さ 0 の線分に平行拘束は断る', () => {
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '平行1',
      kind: 'parallel',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    };
    const set = variablesOf(allShapesDocument([constraint]));
    const report = buildResidualReport([constraint], set, collapsedLine(set));
    expect(report.rows.some((row) => row.constraintId === 'c1')).toBe(false);
    expect(report.skipped[0]).toMatchObject({ constraintId: 'c1', reason: 'degenerate' });
    expect(report.skipped[0].message).toContain('平行1');
  });

  it('長さ 0 の線分に直角拘束・角度拘束・等しい拘束も断る', () => {
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '直角1',
        kind: 'perpendicular',
        a: curveTarget('line-1'),
        b: curveTarget('line-2'),
      },
      {
        id: 'c2',
        name: '角度1',
        kind: 'angle',
        a: curveTarget('line-1'),
        b: curveTarget('line-2'),
        angle: num(30),
      },
      { id: 'c3', name: '等しい1', kind: 'equal', a: curveTarget('line-1'), b: curveTarget('line-2') },
    ];
    const set = variablesOf(allShapesDocument(constraints));
    const report = buildResidualReport(constraints, set, collapsedLine(set));
    expect(report.skipped.map((entry) => entry.constraintId)).toEqual(['c1', 'c2', 'c3']);
    expect(report.skipped.every((entry) => entry.reason === 'degenerate')).toBe(true);
  });

  it('長さ 0 の軸に対称拘束は断る', () => {
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '対称1',
      kind: 'symmetric',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      axis: elementRef('line-2'),
    };
    const set = variablesOf(allShapesDocument([constraint]));
    const report = buildResidualReport([constraint], set, collapsedLine(set));
    expect(report.skipped[0]).toMatchObject({ constraintId: 'c1', reason: 'degenerate' });
  });

  it('半径 0 の円に接線拘束は断る', () => {
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '接線1',
      kind: 'tangent',
      line: curveTarget('line-1'),
      circle: curveTarget('circle-1'),
    };
    const set = variablesOf(allShapesDocument([constraint]));
    const x = [...set.initial];
    x[columnOf(set, 'circle-1.r')] = 0;
    const report = buildResidualReport([constraint], set, x);
    expect(report.rows.some((row) => row.constraintId === 'c1')).toBe(false);
    expect(report.skipped[0]).toMatchObject({ constraintId: 'c1', reason: 'degenerate' });
  });

  it('重なった 2 点に距離拘束は断る(どちらへ離すか決められない)', () => {
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '距離1',
      kind: 'distance',
      a: pointTarget('point-1'),
      b: pointTarget('point-2'),
      length: num(10),
    };
    const set = variablesOf(allShapesDocument([constraint]));
    const x = [...set.initial];
    x[columnOf(set, 'point-2.u')] = x[columnOf(set, 'point-1.u')];
    x[columnOf(set, 'point-2.v')] = x[columnOf(set, 'point-1.v')];
    const report = buildResidualReport([constraint], set, x);
    expect(report.rows.some((row) => row.constraintId === 'c1')).toBe(false);
    expect(report.skipped[0].reason).toBe('degenerate');
  });

  it('中心と端点が重なった円弧の暗黙の式は断る(円弧の側の言葉で)', () => {
    const set = variablesOf(documentOf([arcOf('arc-1', 0, 0, 5, 0, 90)]));
    const x = [...set.initial];
    x[columnOf(set, 'arc-1:start.u')] = x[columnOf(set, 'arc-1:center.u')];
    x[columnOf(set, 'arc-1:start.v')] = x[columnOf(set, 'arc-1:center.v')];
    const report = buildResidualReport([], set, x);
    // 端点 2 つのうち、重ねた側だけが断られる。
    expect(report.rows).toHaveLength(1);
    expect(report.skipped[0].reason).toBe('degenerate');
    expect(report.skipped[0].message).toContain('arc-1');
  });

  it('水平・垂直は長さ 0 の線分でも断らない(単位ベクトルを作らないため)', () => {
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '水平1',
      kind: 'horizontal',
      target: curveTarget('line-2'),
    };
    const set = variablesOf(allShapesDocument([constraint]));
    const report = buildResidualReport([constraint], set, collapsedLine(set));
    expect(report.skipped).toHaveLength(0);
    expect(report.rows.find((row) => row.constraintId === 'c1')?.value).toBe(0);
  });

  it('縮退した配置でも残差・勾配に NaN を出さない(14 種を一度に)', () => {
    const set = variablesOf(allShapesDocument([...ALL_KIND_CONSTRAINTS]));
    const x = [...set.initial];
    // 線分 2 本を潰し、円の半径を 0 にし、2 点を重ねる。
    for (const featureId of ['line-1', 'line-2']) {
      x[columnOf(set, `${featureId}:end.u`)] = x[columnOf(set, `${featureId}:start.u`)];
      x[columnOf(set, `${featureId}:end.v`)] = x[columnOf(set, `${featureId}:start.v`)];
    }
    x[columnOf(set, 'circle-1.r')] = 0;
    x[columnOf(set, 'point-2.u')] = x[columnOf(set, 'point-1.u')];
    x[columnOf(set, 'point-2.v')] = x[columnOf(set, 'point-1.v')];
    const report = buildResidualReport(ALL_KIND_CONSTRAINTS, set, x);
    for (const row of report.rows) {
      expect(Number.isFinite(row.value)).toBe(true);
      for (const coefficient of row.gradient.values()) {
        expect(Number.isFinite(coefficient)).toBe(true);
      }
    }
    expect(report.skipped.length).toBeGreaterThan(0);
    for (const entry of report.skipped) {
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });
});

// --- 材料が足りない・組み合わせ違い ---------------------------------------

describe('材料が足りない拘束は残差を作らず、理由を返す(FR-504)', () => {
  it('消された要素を指す拘束は「材料が足りない」として返す', () => {
    const set = variablesOf(documentOf([pointOf('point-1', 3, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '一致1',
      kind: 'coincident',
      a: pointTarget('point-1'),
      b: pointTarget('point-9'),
    };
    const report = buildResidualReport([constraint], set, set.initial);
    expect(report.rows).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ constraintId: 'c1', reason: 'dangling' });
    expect(report.skipped[0].message).toContain('一致1');
  });

  it('消された要素を指す拘束があっても、他の拘束は正しく式になる', () => {
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4), pointOf('point-1', 3, 4)]));
    const constraints: SketchConstraint[] = [
      {
        id: 'c1',
        name: '一致1',
        kind: 'coincident',
        a: pointTarget('point-1'),
        b: pointTarget('point-9'),
      },
      { id: 'c2', name: '水平1', kind: 'horizontal', target: curveTarget('line-1') },
    ];
    const report = buildResidualReport(constraints, set, set.initial);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ constraintId: 'c2', value: -4 });
    expect(report.skipped).toHaveLength(1);
  });

  it('曲線そのものを指した一致拘束は組み合わせ違いで断る', () => {
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4), pointOf('point-1', 3, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '一致1',
      kind: 'coincident',
      a: curveTarget('line-1'),
      b: pointTarget('point-1'),
    };
    const report = buildResidualReport([constraint], set, set.initial);
    expect(report.skipped[0].reason).toBe('unsupportedTarget');
  });

  it('円に平行拘束、線分に半径拘束は組み合わせ違いで断る', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 7, 4), arcOf('circle-1', 0, 0, 5)]),
    );
    const constraints: SketchConstraint[] = [
      { id: 'c1', name: '平行1', kind: 'parallel', a: curveTarget('line-1'), b: curveTarget('circle-1') },
      { id: 'c2', name: '半径1', kind: 'radius', target: curveTarget('line-1'), size: num(8) },
    ];
    const report = buildResidualReport(constraints, set, set.initial);
    expect(report.rows).toHaveLength(0);
    expect(report.skipped.map((entry) => entry.reason)).toEqual([
      'unsupportedTarget',
      'unsupportedTarget',
    ]);
  });
});

// --- 疎な行・並び・決定性 -------------------------------------------------

describe('行の形と並び', () => {
  it('水平拘束の勾配は 2 項だけ(0 の項を入れない)', () => {
    const set = variablesOf(documentOf([segmentOf('line-1', 0, 0, 7, 4)]));
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '水平1',
      kind: 'horizontal',
      target: curveTarget('line-1'),
    };
    const row = rowsOf(constraint, set, set.initial)[0];
    expect(row.gradient.size).toBe(2);
    expect(slopeOf(set, row, 'line-1:start.v')).toBe(1);
    expect(slopeOf(set, row, 'line-1:end.v')).toBe(-1);
  });

  it('直角拘束の勾配は 2 本の線分の 4 点 × 2 = 8 項まで', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 6, 8), segmentOf('line-2', 1, 2, 9, 4)]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '直角1',
      kind: 'perpendicular',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
    };
    const row = rowsOf(constraint, set, set.initial)[0];
    expect(row.gradient.size).toBeLessThanOrEqual(8);
    // 軸に沿っていない 2 本なら 8 項すべてが 0 でない。
    expect(row.gradient.size).toBe(8);
  });

  it('定数の点(式で書かれた座標)には勾配の項を作らない', () => {
    const set = variablesOf(
      documentOf([
        lineOf(
          'line-1',
          { mode: 'absolute', x: { source: '0 + 0', value: 0, display: '0' }, y: num(0), z: num(0) },
          absoluteCoordinate(7, 4, 0),
        ),
      ]),
    );
    const constraint: SketchConstraint = {
      id: 'c1',
      name: '水平1',
      kind: 'horizontal',
      target: curveTarget('line-1'),
    };
    const row = rowsOf(constraint, set, set.initial)[0];
    // 始点は式なので定数。残る項は終点の v だけ。
    expect(row.gradient.size).toBe(1);
    expect(row.value).toBe(-4);
    expect(slopeOf(set, row, 'line-1:end.v')).toBe(-1);
  });

  it('角度 0° と 180° は同じ 2 本でも別の残差になる', () => {
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 10, 0), segmentOf('line-2', 0, 0, 0, 10)]),
    );
    const zero: SketchConstraint = {
      id: 'c1',
      name: '角度1',
      kind: 'angle',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
      angle: num(0),
    };
    const half: SketchConstraint = {
      id: 'c2',
      name: '角度2',
      kind: 'angle',
      a: curveTarget('line-1'),
      b: curveTarget('line-2'),
      angle: num(180),
    };
    // cross = 1、dot = 0 なので θ=0 は −cross、θ=180 は +cross。
    expect(rowsOf(zero, set, set.initial)[0].value).toBeCloseTo(-1, 12);
    expect(rowsOf(half, set, set.initial)[0].value).toBeCloseTo(1, 12);
  });

  it('行の並びは「利用者の拘束の順 → 円弧の暗黙の式」', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c1', name: '水平1', kind: 'horizontal', target: curveTarget('line-1') },
      { id: 'c2', name: '垂直1', kind: 'vertical', target: curveTarget('line-1') },
    ];
    const set = variablesOf(
      documentOf([segmentOf('line-1', 0, 0, 7, 4), arcOf('arc-1', 20, 0, 4, 0, 90)], constraints),
    );
    const rows = buildResiduals(constraints, set, set.initial);
    expect(rows.map((row) => row.constraintId)).toEqual([
      'c1',
      'c2',
      implicitEquationId(set.implicit[0]),
      implicitEquationId(set.implicit[1]),
    ]);
  });

  it('同じ入力からは何度でも同じ行が出る(決定性)', () => {
    const set = variablesOf(allShapesDocument([...ALL_KIND_CONSTRAINTS]));
    const first = buildResiduals(ALL_KIND_CONSTRAINTS, set, set.initial);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = buildResiduals(ALL_KIND_CONSTRAINTS, set, set.initial);
      expect(again.map((row) => row.constraintId)).toEqual(first.map((row) => row.constraintId));
      expect(valuesOf(again)).toEqual(valuesOf(first));
      expect(again.map((row) => [...row.gradient.entries()])).toEqual(
        first.map((row) => [...row.gradient.entries()]),
      );
    }
  });

  it('buildResiduals は buildResidualReport の行だけを返す', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c1', name: '水平1', kind: 'horizontal', target: curveTarget('line-1') },
    ];
    const set = variablesOf(allShapesDocument(constraints));
    expect(buildResiduals(constraints, set, set.initial)).toEqual(
      buildResidualReport(constraints, set, set.initial).rows,
    );
  });

  it('暗黙の式の id は接頭辞で見分けられる(利用者の拘束の id と混ざらない)', () => {
    const set = variablesOf(documentOf([arcOf('arc-1', 0, 0, 5, 0, 90)]));
    expect(isImplicitConstraintId(implicitEquationId(set.implicit[0]))).toBe(true);
    expect(isImplicitConstraintId('c1')).toBe(false);
  });
});

// --- 性能 -----------------------------------------------------------------

describe('性能(§2.9。ドラッグ中は毎フレーム回る)', () => {
  it('変数 400・拘束 200 のヤコビアンを 1 回組み立てる所要を測る', () => {
    const features: SketchFeature[] = [];
    const constraints: SketchConstraint[] = [];
    for (let order = 0; order < 100; order += 1) {
      features.push(segmentOf(`line-${order}`, order * 3, 0, order * 3 + 2, 1));
      constraints.push({
        id: `h${order}`,
        name: `水平${order}`,
        kind: 'horizontal',
        target: curveTarget(`line-${order}`),
      });
      constraints.push({
        id: `p${order}`,
        name: `平行${order}`,
        kind: 'parallel',
        a: curveTarget(`line-${order}`),
        b: curveTarget(`line-${(order + 1) % 100}`),
      });
    }
    const set = variablesOf(documentOf(features, constraints));
    expect(set.variables).toHaveLength(400);

    // 1 回目は暖機を含むので、測る前に一度回す。
    buildResiduals(constraints, set, set.initial);
    const started = performance.now();
    const rows = buildResiduals(constraints, set, set.initial);
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(200);
    console.log(`[実測] 変数 400・拘束 200 のヤコビアン 1 回: ${elapsed.toFixed(3)}ms`);
    // 目標は 5ms。ここでの上限は「桁が変わる退化」を捕まえるための緩い網で、
    // 並列の検査中の CPU 競合で落ちないようにしてある(rules/06-過去の失敗と対策.md 10.3)。
    expectWithinBudget(elapsed, 200, '変数 400・拘束 200 のヤコビアン 1 回');
  });
});
