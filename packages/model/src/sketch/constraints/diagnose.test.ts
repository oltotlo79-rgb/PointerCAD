import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import { WORK_PLANES, type WorkPlane } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type { CoordinateInput, SketchDocument, SketchFeature } from '../types.js';
import {
  CONFLICT_REPORT_LIMIT,
  CONSTRAINT_TOO_MANY_MESSAGE,
  diagnoseConstraints,
  remainingMessage,
  type ConstraintDiagnosis,
} from './diagnose.js';
import { buildResiduals, type ResidualRow } from './residuals.js';
import { matrixRank, solveLevenbergMarquardt } from './solve.js';
import { sketchConstraints, type ConstraintTarget, type SketchConstraint } from './types.js';
import { collectVariables, MAX_CONSTRAINT_VARIABLES, type VariableSet } from './variables.js';
import { expectWithinBudget } from '../../testUtils/perfBudget.js';

/**
 * タスク7 の検査。**期待値はすべて手で導ける形にしてある。**
 *
 * - 自由度は「変数の数 − 階数」。変数の数は `variables.ts` の並び(点 1 つ = 2、半径 = 1)、
 *   階数は「重なりを差し引いた、効いている式の本数」。
 * - 冗長は「足しても階数が増えない行」、矛盾は「そのうえで残差の食い違いが残る行」。
 *
 * 手で数えにくい矩形は、担当が実測した階数を期待値として固定し、導出をコメントに書く
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク7 手順3)。
 */

function documentOf(
  features: SketchFeature[],
  constraints: SketchConstraint[] = [],
): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features, constraints };
}

/** 式で書かれた値(数値リテラル 1 つではないので定数として読まれる。§0.a-0.2)。 */
function expression(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

/** 式で書かれた絶対座標(変数にならない点を作る)。 */
function expressionCoordinate(x: number, y: number): CoordinateInput {
  return {
    mode: 'absolute',
    x: expression(`${x} + 0`, x),
    y: expression(`${y} + 0`, y),
    z: num(0),
  };
}

function lineOf(id: string, from: CoordinateInput, to: CoordinateInput): SketchFeature {
  return { id, kind: 'line', name: id, planeId: 'xy', from, to, construction: false };
}

function arcOf(
  id: string,
  center: CoordinateInput,
  radius: ExpressionValue,
  startAngle: number,
  endAngle: number,
): SketchFeature {
  return {
    id,
    kind: 'arc',
    name: id,
    planeId: 'xy',
    center,
    radius,
    startAngle: num(startAngle),
    endAngle: num(endAngle),
    construction: false,
  };
}

/** 曲線そのものを指す。 */
function atCurve(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

/** 端点・中心を指す。 */
function atVertex(featureId: string, vertex: 'start' | 'end' | 'center'): ConstraintTarget {
  return { kind: 'vertex', featureId, vertex };
}

/** 点フィーチャー・点列の n 番目を指す。 */
function atPoint(pointId: string): ConstraintTarget {
  return { kind: 'point', pointId };
}

function variablesOf(document: SketchDocument, plane: WorkPlane = WORK_PLANES.xy): VariableSet {
  return collectVariables(document, resolveSketch(document), plane);
}

interface Diagnosed {
  readonly set: VariableSet;
  readonly rows: readonly ResidualRow[];
  readonly diagnosis: ConstraintDiagnosis;
  readonly converged: boolean;
}

/**
 * 3 段の解決の②(連立を解く)まで進めてから診断する。**診断には解いた後の x を渡す**
 * (初期値のまま渡すと、まだ解いていないだけの残差を矛盾と読み違える)。
 */
function diagnoseOf(document: SketchDocument, plane: WorkPlane = WORK_PLANES.xy): Diagnosed {
  const set = variablesOf(document, plane);
  const constraints = sketchConstraints(document);
  const outcome = solveLevenbergMarquardt(set.initial, (x) => buildResiduals(constraints, set, x));
  return {
    set,
    rows: buildResiduals(constraints, set, outcome.x),
    diagnosis: diagnoseConstraints(constraints, set, outcome.x),
    converged: outcome.converged,
  };
}

/** 残差の行から密なヤコビアンを作る(階数の突き合わせに使う)。 */
function denseJacobian(rows: readonly ResidualRow[], columns: number): number[][] {
  return rows.map((row) => {
    const dense = new Array<number>(columns).fill(0);
    for (const [column, value] of row.gradient) {
      dense[column] += value;
    }
    return dense;
  });
}

/* ------------------------------------------------------------------ *
 * 1. 自由度(FR-313「足りない拘束の数を示し」)
 * ------------------------------------------------------------------ */

describe('自由度(FR-313、P4b タスク7)', () => {
  const freeLine = (): SketchFeature =>
    lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0));

  it('拘束の無い線分 1 本は自由度 4(点 2 つ × 2)', () => {
    const { diagnosis } = diagnoseOf(documentOf([freeLine()]));
    expect(diagnosis.variables).toBe(4);
    expect(diagnosis.equations).toBe(0);
    expect(diagnosis.rank).toBe(0);
    expect(diagnosis.degreesOfFreedom).toBe(4);
    expect(diagnosis.messages[0].text).toBe('あと 4 か所決まっていません');
  });

  it('水平を足すと自由度 3(4 − 1)', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [freeLine()],
        [{ id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') }],
      ),
    );
    expect(diagnosis.rank).toBe(1);
    expect(diagnosis.degreesOfFreedom).toBe(3);
    expect(diagnosis.redundant).toEqual([]);
    expect(diagnosis.conflicting).toEqual([]);
  });

  it('水平+長さ 10 で自由度 2(4 − 2)', () => {
    const { diagnosis, converged } = diagnoseOf(
      documentOf(
        [freeLine()],
        [
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          {
            id: 'c2',
            name: '距離1',
            kind: 'distance',
            a: atVertex('line-1', 'start'),
            b: atVertex('line-1', 'end'),
            length: num(10),
          },
        ],
      ),
    );
    expect(converged).toBe(true);
    expect(diagnosis.rank).toBe(2);
    expect(diagnosis.degreesOfFreedom).toBe(2);
    expect(diagnosis.satisfied).toBe(true);
  });

  it('さらに始点を固定した点へ一致させると自由度 0(すべて決まりました)', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [
          { id: 'point-1', kind: 'point', name: '点1', planeId: 'xy', at: absoluteCoordinate(0, 0, 0) },
          freeLine(),
        ],
        [
          { id: 'c0', name: '固定1', kind: 'fix', target: atPoint('point-1') },
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          {
            id: 'c2',
            name: '距離1',
            kind: 'distance',
            a: atVertex('line-1', 'start'),
            b: atVertex('line-1', 'end'),
            length: num(10),
          },
          {
            id: 'c3',
            name: '一致1',
            kind: 'coincident',
            a: atVertex('line-1', 'start'),
            b: atPoint('point-1'),
          },
        ],
      ),
    );
    // 変数は線分の 4 個だけ(固定した点は変数から外れる)。式は 1 + 1 + 2 = 4 本。
    expect(diagnosis.variables).toBe(4);
    expect(diagnosis.equations).toBe(4);
    expect(diagnosis.rank).toBe(4);
    expect(diagnosis.degreesOfFreedom).toBe(0);
    expect(diagnosis.messages[0].text).toBe('すべて決まりました');
    expect(diagnosis.summary).toBe('すべて決まりました。');
  });

  it('全周の円は自由度 3(中心 2 + 半径 1)、半径拘束を足すと 2', () => {
    const circle = arcOf('arc-1', absoluteCoordinate(0, 0, 0), num(5), 0, 360);
    const bare = diagnoseOf(documentOf([circle]));
    expect(bare.diagnosis.variables).toBe(3);
    // 全周の円は端点を持たない(始点と終点が同じ点)ので暗黙の式が立たない。
    expect(bare.diagnosis.equations).toBe(0);
    expect(bare.diagnosis.degreesOfFreedom).toBe(3);

    const sized = diagnoseOf(
      documentOf(
        [circle],
        [
          {
            id: 'c1',
            name: '半径1',
            kind: 'radius',
            target: atCurve('arc-1'),
            size: num(8),
          },
        ],
      ),
    );
    expect(sized.diagnosis.rank).toBe(1);
    expect(sized.diagnosis.degreesOfFreedom).toBe(2);
  });

  it('円弧は変数 7 に暗黙の式 2 本で自由度 5(中心 2 + 半径 + 開始角 + 終了角)', () => {
    const { diagnosis } = diagnoseOf(
      documentOf([arcOf('arc-1', absoluteCoordinate(2, 3, 0), num(5), 0, 90)]),
    );
    expect(diagnosis.variables).toBe(7);
    // 利用者の拘束は 0 でも、円弧 1 本につき「端点が円周の上にある」式が 2 本立つ。
    expect(diagnosis.equations).toBe(2);
    expect(diagnosis.rank).toBe(2);
    expect(diagnosis.degreesOfFreedom).toBe(5);
    // 暗黙の式は利用者へ見せない(付けた覚えのない拘束を指さない)。
    expect(diagnosis.redundant).toEqual([]);
    expect(diagnosis.conflicting).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 矩形(手で数えにくい例。実測した階数を固定する)
 * ------------------------------------------------------------------ */

/**
 * 40 × 30 の枠。線分 4 本をつないだだけの状態は変数 16(端点 8 個 × 2)。
 * 一致 4 つ(8 本)で角がつながり、動かせるのは角 4 つ = 8 個ぶんになる。
 */
function rectangle(extra: SketchConstraint[] = []): SketchDocument {
  return documentOf(
    [
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(40, 0, 0)),
      lineOf('line-2', absoluteCoordinate(40, 0, 0), absoluteCoordinate(40, 30, 0)),
      lineOf('line-3', absoluteCoordinate(40, 30, 0), absoluteCoordinate(0, 30, 0)),
      lineOf('line-4', absoluteCoordinate(0, 30, 0), absoluteCoordinate(0, 0, 0)),
    ],
    [
      {
        id: 'j1',
        name: '一致1',
        kind: 'coincident',
        a: atVertex('line-1', 'end'),
        b: atVertex('line-2', 'start'),
      },
      {
        id: 'j2',
        name: '一致2',
        kind: 'coincident',
        a: atVertex('line-2', 'end'),
        b: atVertex('line-3', 'start'),
      },
      {
        id: 'j3',
        name: '一致3',
        kind: 'coincident',
        a: atVertex('line-3', 'end'),
        b: atVertex('line-4', 'start'),
      },
      {
        id: 'j4',
        name: '一致4',
        kind: 'coincident',
        a: atVertex('line-4', 'end'),
        b: atVertex('line-1', 'start'),
      },
      { id: 'h1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
      { id: 'h2', name: '水平2', kind: 'horizontal', target: atCurve('line-3') },
      { id: 'v1', name: '垂直1', kind: 'vertical', target: atCurve('line-2') },
      { id: 'v2', name: '垂直2', kind: 'vertical', target: atCurve('line-4') },
      ...extra,
    ],
  );
}

const equalSides: SketchConstraint = {
  id: 'e1',
  name: '等しい1',
  kind: 'equal',
  a: atCurve('line-1'),
  b: atCurve('line-2'),
};

const bottomLength: SketchConstraint = {
  id: 'd1',
  name: '距離1',
  kind: 'distance',
  a: atVertex('line-1', 'start'),
  b: atVertex('line-1', 'end'),
  length: num(40),
};

describe('矩形の自由度(実測して固定した値。P4b タスク7 手順3)', () => {
  it('一致 4 + 水平 2 + 垂直 2 で自由度 4(位置 2 + 幅 + 高さ)', () => {
    const { diagnosis } = diagnoseOf(rectangle());
    expect(diagnosis.variables).toBe(16);
    expect(diagnosis.equations).toBe(12);
    // 一致 8 本は独立(4 組の端点を結ぶ)。角 4 つ = 8 個の動かせる数が残り、
    // そこへ水平 2 本(A.v = B.v、C.v = D.v)と垂直 2 本(B.u = C.u、D.u = A.u)が
    // それぞれ独立に効くので階数は 8 + 4 = 12。
    expect(diagnosis.rank).toBe(12);
    expect(diagnosis.degreesOfFreedom).toBe(4);
    expect(diagnosis.redundant).toEqual([]);
    expect(diagnosis.conflicting).toEqual([]);
  });

  it('等しい+距離を足すと自由度 2(平面内の平行移動だけが残る)', () => {
    const { diagnosis, converged } = diagnoseOf(rectangle([equalSides, bottomLength]));
    expect(converged).toBe(true);
    expect(diagnosis.equations).toBe(14);
    expect(diagnosis.rank).toBe(14);
    expect(diagnosis.degreesOfFreedom).toBe(2);
    expect(diagnosis.messages[0].text).toBe('あと 2 か所決まっていません');
  });

  it('さらに角を 1 つ固定すると自由度 0', () => {
    const { diagnosis } = diagnoseOf(
      rectangle([
        equalSides,
        bottomLength,
        { id: 'f1', name: '固定1', kind: 'fix', target: atVertex('line-1', 'start') },
      ]),
    );
    // 固定は式を足さず変数を 2 つ減らす(16 → 14)。式は 14 本のまま。
    expect(diagnosis.variables).toBe(14);
    expect(diagnosis.equations).toBe(14);
    expect(diagnosis.rank).toBe(14);
    expect(diagnosis.degreesOfFreedom).toBe(0);
    expect(diagnosis.conflicting).toEqual([]);
  });

  it('階数の数え方が `matrixRank`(ハウスホルダー QR)と一致する', () => {
    for (const document of [rectangle(), rectangle([equalSides, bottomLength])]) {
      const { set, rows, diagnosis } = diagnoseOf(document);
      expect(diagnosis.rank).toBe(matrixRank(denseJacobian(rows, set.variables.length), set.variables.length));
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 足しすぎ(冗長)
 * ------------------------------------------------------------------ */

describe('足しすぎ(冗長)の見分け方', () => {
  const line = (): SketchFeature =>
    lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0));

  const lengthConstraint = (id: string, name: string, length: number): SketchConstraint => ({
    id,
    name,
    kind: 'distance',
    a: atVertex('line-1', 'start'),
    b: atVertex('line-1', 'end'),
    length: num(length),
  });

  it('同じ線分に長さ 10 を 2 つ付けると、2 つ目が冗長(矛盾はしない)', () => {
    const { diagnosis, converged } = diagnoseOf(
      documentOf([line()], [lengthConstraint('c1', '距離1', 10), lengthConstraint('c2', '距離2', 10)]),
    );
    expect(converged).toBe(true);
    expect(diagnosis.equations).toBe(2);
    // 2 本目は 1 本目とまったく同じ行なので階数が増えない。
    expect(diagnosis.rank).toBe(1);
    expect(diagnosis.degreesOfFreedom).toBe(3);
    expect(diagnosis.redundant).toEqual(['c2']);
    expect(diagnosis.excess).toBe(1);
    expect(diagnosis.conflicting).toEqual([]);
    expect(diagnosis.redundantDetails[0].reason).toBe('duplicate');
    expect(diagnosis.redundantDetails[0].dependsOn).toEqual(['c1']);
    expect(diagnosis.redundantDetails[0].message).toBe(
      '距離2 は、ほかの拘束(距離1)ですでに決まっています。',
    );
  });

  it('付けすぎの件数は「あと N か所」とは別に数える', () => {
    const { diagnosis } = diagnoseOf(
      documentOf([line()], [lengthConstraint('c1', '距離1', 10), lengthConstraint('c2', '距離2', 10)]),
    );
    expect(diagnosis.degreesOfFreedom).toBe(3);
    expect(diagnosis.excess).toBe(1);
    expect(diagnosis.messages.map((message) => message.kind)).toContain('excess');
    const excess = diagnosis.messages.find((message) => message.kind === 'excess');
    expect(excess?.text).toBe('付けすぎの拘束が 1 件あります');
    expect(diagnosis.summary).toBe('あと 3 か所決まっていません。付けすぎの拘束が 1 件あります。');
  });

  it('同じ線分に水平を 2 つ付けると 2 つ目が冗長', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [line()],
        [
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          { id: 'c2', name: '水平2', kind: 'horizontal', target: atCurve('line-1') },
        ],
      ),
    );
    expect(diagnosis.rank).toBe(1);
    expect(diagnosis.degreesOfFreedom).toBe(3);
    expect(diagnosis.redundant).toEqual(['c2']);
    expect(diagnosis.conflicting).toEqual([]);
  });

  it('動かせない要素だけを指す拘束は「形に効かない」冗長として出す', () => {
    // 両端が式で書かれた線分(変数 0 個)は、もともと水平なので残差も 0。
    const { diagnosis } = diagnoseOf(
      documentOf(
        [lineOf('line-1', expressionCoordinate(0, 5), expressionCoordinate(10, 5))],
        [{ id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') }],
      ),
    );
    expect(diagnosis.variables).toBe(0);
    expect(diagnosis.degreesOfFreedom).toBe(0);
    expect(diagnosis.redundant).toEqual(['c1']);
    expect(diagnosis.redundantDetails[0].reason).toBe('noVariable');
    expect(diagnosis.redundantDetails[0].message).toBe(
      '水平1 が指している要素は動かせないので、この拘束は形に効きません。',
    );
    expect(diagnosis.conflicting).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 矛盾
 * ------------------------------------------------------------------ */

describe('矛盾(同時には成り立たない)の見分け方', () => {
  const line = (): SketchFeature =>
    lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0));

  const lengthConstraint = (id: string, name: string, length: number): SketchConstraint => ({
    id,
    name,
    kind: 'distance',
    a: atVertex('line-1', 'start'),
    b: atVertex('line-1', 'end'),
    length: num(length),
  });

  it('長さ 10 と長さ 12 は冗長かつ矛盾(原因は 2 件)', () => {
    const { diagnosis, converged } = diagnoseOf(
      documentOf([line()], [lengthConstraint('c1', '距離1', 10), lengthConstraint('c2', '距離2', 12)]),
    );
    expect(converged).toBe(false);
    // 行は同じ(階数 1 < 行数 2)なのに、残差の側は 2 だけ食い違う。
    expect(diagnosis.rank).toBe(1);
    expect(diagnosis.conflicting).toEqual(['c2', 'c1']);
    // 階数を増やさない行なので「足しすぎ」にも数える(計画書 §2.2 の表)。
    expect(diagnosis.redundant).toEqual(['c2']);
    expect(diagnosis.excess).toBe(1);
    expect(diagnosis.conflictDetails[0].message).toBe('距離2 と 距離1 は同時には成り立ちません。');
    expect(diagnosis.satisfied).toBe(false);
    // 矛盾している拘束については、助言が食い違わないよう矛盾の 1 文だけを出す。
    expect(diagnosis.messages.filter((message) => message.kind === 'redundant')).toEqual([]);
    expect(diagnosis.summary).toBe(
      '同時に成り立たない拘束が 2 件あります。付けすぎの拘束が 1 件あります。',
    );
  });

  it('両端が式で書かれた線分に水平を付けると、動かせないので矛盾', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [lineOf('line-1', expressionCoordinate(0, 0), expressionCoordinate(10, 5))],
        [{ id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') }],
      ),
    );
    expect(diagnosis.variables).toBe(0);
    expect(diagnosis.degreesOfFreedom).toBe(0);
    expect(diagnosis.frozen.get('line-1:start')).toBe('expression');
    expect(diagnosis.frozen.get('line-1:end')).toBe('expression');
    expect(diagnosis.conflicting).toEqual(['c1']);
    expect(diagnosis.conflictDetails[0].message).toBe('水平1 は、いまの形では成り立ちません。');
    // 動かせる数を 1 つも含まない行も階数を増やさないので「足しすぎ」に数える。
    expect(diagnosis.redundant).toEqual(['c1']);
    expect(diagnosis.redundantDetails[0].reason).toBe('noVariable');
  });

  it('両端が動かせない線分の水平+垂直は 2 件とも矛盾になる', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [lineOf('line-1', expressionCoordinate(0, 0), expressionCoordinate(10, 5))],
        [
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          { id: 'c2', name: '垂直1', kind: 'vertical', target: atCurve('line-1') },
        ],
      ),
    );
    expect(diagnosis.conflicting).toEqual(['c1', 'c2']);
    expect(diagnosis.redundant).toEqual(['c1', 'c2']);
  });

  it('両端が動く線分の水平+垂直は矛盾しない(2 点が重なれば両方成り立つ)', () => {
    // 計画書の表は「階数 2 = 行数 2 だが解が無い」としていたが、実測すると解がある。
    // 水平は pv = qv、垂直は pu = qu で、2 点が重なった長さ 0 の線分がその解になる。
    // 行は独立(階数 2)、残差は 0 まで落ちるので、冗長でも矛盾でもない。
    const { diagnosis, converged } = diagnoseOf(
      documentOf(
        [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
        [
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          { id: 'c2', name: '垂直1', kind: 'vertical', target: atCurve('line-1') },
        ],
      ),
    );
    expect(converged).toBe(true);
    expect(diagnosis.rank).toBe(2);
    expect(diagnosis.degreesOfFreedom).toBe(2);
    expect(diagnosis.conflicting).toEqual([]);
    expect(diagnosis.redundant).toEqual([]);
  });

  it('離れた 2 点から同じ距離 10 を要求すると、原因の 2 件を指す', () => {
    // p = (0, 0) と r = (30, 0) の両方から距離 10 の点は無い(円が交わらない)。
    const { diagnosis, converged } = diagnoseOf(
      documentOf(
        [
          { id: 'p', kind: 'point', name: '点1', planeId: 'xy', at: expressionCoordinate(0, 0) },
          { id: 'r', kind: 'point', name: '点2', planeId: 'xy', at: expressionCoordinate(30, 0) },
          { id: 'q', kind: 'point', name: '点3', planeId: 'xy', at: absoluteCoordinate(15, 1, 0) },
        ],
        [
          {
            id: 'c1',
            name: '距離1',
            kind: 'distance',
            a: atPoint('p'),
            b: atPoint('q'),
            length: num(10),
          },
          {
            id: 'c2',
            name: '距離2',
            kind: 'distance',
            a: atPoint('r'),
            b: atPoint('q'),
            length: num(10),
          },
        ],
      ),
    );
    expect(converged).toBe(false);
    expect(diagnosis.conflicting).toHaveLength(2);
    expect(diagnosis.conflicting).toEqual(expect.arrayContaining(['c1', 'c2']));
  });

  it('解けていない x を渡すと、残差の大きい拘束を原因として挙げる(上限 3 件)', () => {
    // 診断は「解いた後の x」を前提にする(§落とし穴)。まだ解いていない初期値を渡した場合、
    // 行が全部独立でも残差が残るので、大きい順に最大 3 件を原因として挙げる安全網が働く。
    const document = documentOf(
      [
        lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0)),
        lineOf('line-2', absoluteCoordinate(0, 20, 0), absoluteCoordinate(9, 20, 0)),
      ],
      [
        {
          id: 'c1',
          name: '距離1',
          kind: 'distance',
          a: atVertex('line-1', 'start'),
          b: atVertex('line-1', 'end'),
          length: num(100),
        },
        {
          id: 'c2',
          name: '距離2',
          kind: 'distance',
          a: atVertex('line-2', 'start'),
          b: atVertex('line-2', 'end'),
          length: num(50),
        },
      ],
    );
    const set = variablesOf(document);
    const constraints = sketchConstraints(document);
    const diagnosis = diagnoseConstraints(constraints, set, set.initial);
    expect(diagnosis.satisfied).toBe(false);
    // 残差は 8 − 100 = −92 と 9 − 50 = −41。大きい順に並ぶ。
    expect(diagnosis.conflicting).toEqual(['c1', 'c2']);
    expect(diagnosis.conflicting.length).toBeLessThanOrEqual(CONFLICT_REPORT_LIMIT);
    // 解けば矛盾は消える。
    expect(diagnoseOf(document).diagnosis.conflicting).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 材料が足りない・多すぎる
 * ------------------------------------------------------------------ */

describe('材料が足りない拘束と、要素が多すぎる場合', () => {
  it('消えた要素を指す拘束は dangling に入り、ほかの拘束は正しく解ける(FR-504)', () => {
    const { diagnosis, converged } = diagnoseOf(
      documentOf(
        [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
        [
          { id: 'c1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
          { id: 'c2', name: '水平2', kind: 'horizontal', target: atCurve('line-9') },
        ],
      ),
    );
    expect(converged).toBe(true);
    expect(diagnosis.dangling).toEqual(['c2']);
    expect(diagnosis.equations).toBe(1);
    expect(diagnosis.degreesOfFreedom).toBe(3);
    // タスク5 の `skipped` の理由は「残差を作れなかった理由」なので、水平のように向きを
    // 読む拘束では「要素が無い」と「組み合わせ違い」の区別が付かず `unsupportedTarget` になる。
    // 材料が足りるかどうかは指し先そのものを見る `countDegreesOfFreedom` を正本にする。
    expect(diagnosis.skipped[0].reason).toBe('unsupportedTarget');
    expect(diagnosis.messages.some((message) => message.kind === 'skipped')).toBe(true);
  });

  it('消えた点を指す一致拘束は skipped の理由も dangling になる', () => {
    const { diagnosis } = diagnoseOf(
      documentOf(
        [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
        [
          {
            id: 'c1',
            name: '一致1',
            kind: 'coincident',
            a: atVertex('line-1', 'start'),
            b: atPoint('point-9'),
          },
        ],
      ),
    );
    expect(diagnosis.dangling).toEqual(['c1']);
    expect(diagnosis.skipped[0].reason).toBe('dangling');
    expect(diagnosis.equations).toBe(0);
    expect(diagnosis.degreesOfFreedom).toBe(4);
  });

  it('変数が上限を超えたら診断せずに断る', () => {
    const features: SketchFeature[] = [];
    for (let i = 0; i < 101; i += 1) {
      features.push(
        lineOf(`line-${i}`, absoluteCoordinate(i, 0, 0), absoluteCoordinate(i, 10, 0)),
      );
    }
    const set = variablesOf(documentOf(features));
    expect(set.variables.length).toBe(404);
    expect(set.variables.length).toBeGreaterThan(MAX_CONSTRAINT_VARIABLES);
    const diagnosis = diagnoseConstraints([], set, set.initial);
    expect(diagnosis.tooMany).toBe(true);
    expect(diagnosis.equations).toBe(0);
    expect(diagnosis.summary).toBe(CONSTRAINT_TOO_MANY_MESSAGE);
    expect(diagnosis.messages).toEqual([
      { kind: 'tooMany', text: CONSTRAINT_TOO_MANY_MESSAGE, constraintIds: [] },
    ]);
    expect(CONSTRAINT_TOO_MANY_MESSAGE).toBe(
      '拘束を付けられる要素が多すぎます(上限 200 点)。スケッチを分けてください。',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 6. 文言と決定性
 * ------------------------------------------------------------------ */

describe('画面へ出す文言と決定性', () => {
  it('「あと N か所決まっていません」と「すべて決まりました」を使い分ける', () => {
    expect(remainingMessage(3)).toBe('あと 3 か所決まっていません');
    expect(remainingMessage(1)).toBe('あと 1 か所決まっていません');
    expect(remainingMessage(0)).toBe('すべて決まりました');
  });

  it('同じ文書からは 10 回とも同じ診断になる', () => {
    const document = rectangle([equalSides, bottomLength]);
    const first = JSON.stringify(diagnoseOf(document).diagnosis.messages);
    for (let i = 0; i < 9; i += 1) {
      expect(JSON.stringify(diagnoseOf(document).diagnosis.messages)).toBe(first);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. 性能(§2.9)
 * ------------------------------------------------------------------ */

describe('診断の速さ(§2.9)', () => {
  it('変数 400・拘束 200 の診断 1 回が 30ms 以内で終わる', () => {
    const features: SketchFeature[] = [];
    const constraints: SketchConstraint[] = [];
    for (let i = 0; i < 100; i += 1) {
      features.push(
        lineOf(`line-${i}`, absoluteCoordinate(i * 20, 0, 0), absoluteCoordinate(i * 20 + 10, 1, 0)),
      );
      constraints.push({
        id: `h${i}`,
        name: `水平${i}`,
        kind: 'horizontal',
        target: atCurve(`line-${i}`),
      });
      constraints.push({
        id: `d${i}`,
        name: `距離${i}`,
        kind: 'distance',
        a: atVertex(`line-${i}`, 'start'),
        b: atVertex(`line-${i}`, 'end'),
        length: num(10),
      });
    }
    const document = documentOf(features, constraints);
    const set = variablesOf(document);
    expect(set.variables.length).toBe(400);
    expect(constraints.length).toBe(200);

    diagnoseConstraints(constraints, set, set.initial); // 温め(JIT)
    const startedAt = performance.now();
    const diagnosis = diagnoseConstraints(constraints, set, set.initial);
    const elapsedMs = performance.now() - startedAt;
    console.log(`拘束の診断(変数 400・拘束 200): ${elapsedMs.toFixed(2)} ms(目安 30 ms)`);
    expect(diagnosis.equations).toBe(200);
    expect(diagnosis.rank).toBe(200);
    expect(diagnosis.degreesOfFreedom).toBe(200);
    expectWithinBudget(elapsedMs, 30, '変数 400・拘束 200 の診断');
  });

  it('全部が重なった変数 400・拘束 400(冗長の内訳を出す最悪の場合)でも 30ms 以内', () => {
    // 冗長な行は「先行の独立な行の線形結合」を組み立てるぶんだけ余分に計算するので、
    // 全部の拘束が重複している場合が最も重い(計画書 §2.2 の落とし穴)。
    const features: SketchFeature[] = [];
    const constraints: SketchConstraint[] = [];
    for (let i = 0; i < 100; i += 1) {
      features.push(
        lineOf(`line-${i}`, absoluteCoordinate(i * 20, 0, 0), absoluteCoordinate(i * 20 + 10, 1, 0)),
      );
      for (const suffix of ['a', 'b']) {
        constraints.push({
          id: `h${i}${suffix}`,
          name: `水平${i}${suffix}`,
          kind: 'horizontal',
          target: atCurve(`line-${i}`),
        });
        constraints.push({
          id: `d${i}${suffix}`,
          name: `距離${i}${suffix}`,
          kind: 'distance',
          a: atVertex(`line-${i}`, 'start'),
          b: atVertex(`line-${i}`, 'end'),
          length: num(10),
        });
      }
    }
    const document = documentOf(features, constraints);
    const set = variablesOf(document);
    expect(set.variables.length).toBe(400);
    expect(constraints.length).toBe(400);

    diagnoseConstraints(constraints, set, set.initial); // 温め(JIT)
    const startedAt = performance.now();
    const diagnosis = diagnoseConstraints(constraints, set, set.initial);
    const elapsedMs = performance.now() - startedAt;
    console.log(`拘束の診断(変数 400・拘束 400、全部が重複): ${elapsedMs.toFixed(2)} ms(目安 30 ms)`);
    expect(diagnosis.rank).toBe(200);
    expect(diagnosis.excess).toBe(200);
    expectWithinBudget(elapsedMs, 30, '変数 400・拘束 400(全部が重複)の診断');
  });
});
