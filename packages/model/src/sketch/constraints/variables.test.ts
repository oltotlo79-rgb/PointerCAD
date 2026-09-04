import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import { FREE_WORK_PLANE_ID, WORK_PLANES, type WorkPlane } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFeature,
  SketchPointFeature,
} from '../types.js';
import {
  canonicalPointKey,
  collectVariables,
  constraintPointKey,
  countDegreesOfFreedom,
  curveEndpointKeys,
  featureIdOfPointKey,
  MAX_CONSTRAINT_VARIABLES,
  pointComponentKey,
  pointValueAt,
  radiusComponentKey,
  radiusValueAt,
  variableComponentKey,
  type ConstraintVariable,
  type VariableSet,
} from './variables.js';
import {
  CONSTRAINT_EQUATION_COUNTS,
  constraintTargets,
  SKETCH_CONSTRAINT_KINDS,
  sketchConstraints,
  type SketchConstraint,
} from './types.js';

function documentOf(features: SketchFeature[], constraints: SketchConstraint[] = []): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features, constraints };
}

/** 式で書かれた座標(数値リテラル 1 つではないので定数として読まれる)。 */
function expression(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

function lineOf(
  id: string,
  from: CoordinateInput,
  to: CoordinateInput,
  planeId = 'xy',
): SketchFeature {
  return { id, kind: 'line', name: id, planeId, from, to, construction: false };
}

function pointOf(id: string, at: CoordinateInput, planeId = 'xy'): SketchPointFeature {
  return { id, kind: 'point', name: id, planeId, at };
}

/** 拘束を無視した解決から変数を切り出す(タスク8 が組み立てる 3 段の①と②の入口)。 */
function variablesOf(document: SketchDocument, plane: WorkPlane = WORK_PLANES.xy): VariableSet {
  return collectVariables(document, resolveSketch(document), plane);
}

/** 変数の並びを読みやすい文字列にする(順序の検査に使う)。 */
function keysOf(set: VariableSet): string[] {
  return set.variables.map((variable: ConstraintVariable) => variableComponentKey(variable));
}

describe('拘束の型(FR-313、P4b タスク4)', () => {
  it('種類は 14 で、寸法 4 種と幾何 9 種に「固定」を足したもの', () => {
    expect(SKETCH_CONSTRAINT_KINDS).toHaveLength(14);
    // 寸法拘束 4 種(FR-313 の注記)。
    expect(SKETCH_CONSTRAINT_KINDS).toEqual(
      expect.arrayContaining(['distance', 'angle', 'radius', 'diameter']),
    );
    // 幾何拘束 9 種。
    expect(SKETCH_CONSTRAINT_KINDS).toEqual(
      expect.arrayContaining([
        'coincident',
        'horizontal',
        'vertical',
        'parallel',
        'perpendicular',
        'tangent',
        'concentric',
        'equal',
        'symmetric',
      ]),
    );
    // ソルバーの基準になる「固定」(§0.a-0.2)。
    expect(SKETCH_CONSTRAINT_KINDS).toContain('fix');
    // 網羅表と式の数の表の鍵が一致する(片方だけに種類が増えることを防ぐ)。
    expect(Object.keys(CONSTRAINT_EQUATION_COUNTS).sort()).toEqual(
      [...SKETCH_CONSTRAINT_KINDS].sort(),
    );
  });

  it('拘束ごとの式の数は §2.2 の表のとおり(固定だけ 0 本)', () => {
    expect(CONSTRAINT_EQUATION_COUNTS).toEqual({
      coincident: 2,
      horizontal: 1,
      vertical: 1,
      parallel: 1,
      perpendicular: 1,
      tangent: 1,
      concentric: 2,
      equal: 1,
      symmetric: 2,
      // 固定は式を足さず変数を 2 つ減らす。ここで 2 本と数えると自由度を二重に引く。
      fix: 0,
      distance: 1,
      angle: 1,
      radius: 1,
      diameter: 1,
    });
  });

  it('指し先の並べ方は種類ごとに決まる(対称の軸も曲線の指し先として並べる)', () => {
    const symmetric: SketchConstraint = {
      id: 'c1',
      name: '対称1',
      kind: 'symmetric',
      a: { kind: 'point', pointId: 'point-1' },
      b: { kind: 'point', pointId: 'point-2' },
      axis: { featureId: 'line-3' },
    };
    expect(constraintTargets(symmetric)).toEqual([
      { kind: 'point', pointId: 'point-1' },
      { kind: 'point', pointId: 'point-2' },
      { kind: 'curve', element: { featureId: 'line-3' } },
    ]);

    const radius: SketchConstraint = {
      id: 'c2',
      name: '半径1',
      kind: 'radius',
      target: { kind: 'curve', element: { featureId: 'arc-1' } },
      size: num(8),
    };
    expect(constraintTargets(radius)).toEqual([{ kind: 'curve', element: { featureId: 'arc-1' } }]);
  });

  it('拘束の欄が無い文書は「拘束なし」として読む(版 4 までのファイルを読めるため)', () => {
    const legacy: SketchDocument = { id: 'sketch-1', name: 'スケッチ1', features: [] };
    expect(sketchConstraints(legacy)).toEqual([]);
    expect(sketchConstraints(documentOf([], []))).toEqual([]);
  });
});

describe('変数の切り出し(§2.2)', () => {
  it('線分 1 本(両端とも数値リテラルの絶対座標)は変数 4 個', () => {
    const document = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0)),
    ]);
    const set = variablesOf(document);
    // 平面上の点 2 つ × (u, v) = 4。
    expect(set.variables).toHaveLength(4);
    expect(keysOf(set)).toEqual([
      'line-1:start.u',
      'line-1:start.v',
      'line-1:end.u',
      'line-1:end.v',
    ]);
    expect(set.initial).toEqual([0, 0, 7, 4]);
    expect(set.frozen.size).toBe(0);
  });

  it('式で書かれた座標は定数(frozen に expression)', () => {
    const document = documentOf([
      lineOf(
        'line-1',
        { mode: 'absolute', x: expression('10 + 0', 10), y: num(0), z: num(0) },
        absoluteCoordinate(7, 4, 0),
      ),
    ]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(2);
    expect(keysOf(set)).toEqual(['line-1:end.u', 'line-1:end.v']);
    expect(set.frozen.get('line-1:start')).toBe('expression');
    // 定数としては読める(残差が使う)。
    expect(set.constants.get('line-1:start.u')).toBe(10);
    expect(set.constants.get('line-1:start.v')).toBe(0);
  });

  it('「固定」拘束の付いた点は変数から外れる(frozen に fixed)', () => {
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
      [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
        },
      ],
    );
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(2);
    expect(keysOf(set)).toEqual(['line-1:end.u', 'line-1:end.v']);
    expect(set.frozen.get('line-1:start')).toBe('fixed');
  });

  it('「固定」で曲線ごと指すと、その要素の点も半径も止まる', () => {
    const document = documentOf(
      [
        {
          id: 'arc-1',
          kind: 'arc',
          name: '円弧1',
          planeId: 'xy',
          center: absoluteCoordinate(0, 0, 0),
          radius: num(5),
          startAngle: num(0),
          endAngle: num(90),
          construction: false,
        },
      ],
      [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'curve', element: { featureId: 'arc-1' } },
        },
      ],
    );
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect(set.frozen.get('arc-1:center')).toBe('fixed');
    expect(set.frozen.get('arc-1.r')).toBe('fixed');
  });

  it('相対座標の点は変数にしない(基準が動けば追従するため。frozen に derived)', () => {
    const document = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), {
        mode: 'relative',
        base: { kind: 'previous' },
        dx: num(7),
        dy: num(4),
        dz: num(0),
      }),
    ]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(2);
    expect(keysOf(set)).toEqual(['line-1:start.u', 'line-1:start.v']);
    expect(set.frozen.get('line-1:end')).toBe('derived');
    expect(set.constants.get('line-1:end.u')).toBe(7);
    expect(set.constants.get('line-1:end.v')).toBe(4);
  });

  it('円弧は中心 2 +半径+端点 4 の 7 個で、端点が円周の上にある暗黙の式が 2 本立つ', () => {
    // 統括の決定(2026-09-04): 角度を変数にせず端点を変数にする(§0.a-0.6 の趣旨)。
    const document = documentOf([
      {
        id: 'arc-1',
        kind: 'arc',
        name: '円弧1',
        planeId: 'xy',
        center: absoluteCoordinate(2, 3, 0),
        radius: num(5),
        startAngle: num(0),
        endAngle: num(90),
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual([
      'arc-1:center.u',
      'arc-1:center.v',
      'arc-1.r',
      'arc-1:start.u',
      'arc-1:start.v',
      'arc-1:end.u',
      'arc-1:end.v',
    ]);
    // 角度 0 の端点は中心 +(半径, 0)、角度 90 は中心 +(0, 半径)。
    // cos(90°) は厳密な 0 にならない(実測 6.1e-17)ので、端点は許容誤差つきで見る。
    [2, 3, 5, 7, 3, 2, 8].forEach((expected, column) => {
      expect(set.initial[column]).toBeCloseTo(expected, 12);
    });
    expect(set.frozen.size).toBe(0);
    expect(set.implicit).toEqual([
      { featureId: 'arc-1', pointKey: 'arc-1:start', centerKey: 'arc-1:center' },
      { featureId: 'arc-1', pointKey: 'arc-1:end', centerKey: 'arc-1:center' },
    ]);
    // 変数 7 − 暗黙の式 2 = 自由度 5(中心 2 + 半径 1 + 端点の角度 2)。
    expect(countDegreesOfFreedom(set, [])).toEqual({
      variables: 7,
      equations: 2,
      implicit: 2,
      remaining: 5,
      excess: 0,
      dangling: [],
    });
  });

  it('全周の円は端点を持たないので中心 2 +半径の 3 個(暗黙の式も立たない)', () => {
    const document = documentOf([
      {
        id: 'arc-1',
        kind: 'arc',
        name: '円1',
        planeId: 'xy',
        center: absoluteCoordinate(2, 3, 0),
        radius: num(5),
        startAngle: num(0),
        endAngle: num(360),
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual(['arc-1:center.u', 'arc-1:center.v', 'arc-1.r']);
    // 始点と終点が同じ点なので、変数にすると 1 つの点を 2 回動かすことになる。
    expect(set.frozen.get('arc-1:start')).toBe('derived');
    expect(set.frozen.get('arc-1:end')).toBe('derived');
    expect(set.implicit).toEqual([]);
    expect(countDegreesOfFreedom(set, []).remaining).toBe(3);
  });

  it('固定した円弧は暗黙の式も数えない(動かせる数が 1 つも無いため)', () => {
    const document = documentOf(
      [
        {
          id: 'arc-1',
          kind: 'arc',
          name: '円弧1',
          planeId: 'xy',
          center: absoluteCoordinate(0, 0, 0),
          radius: num(5),
          startAngle: num(0),
          endAngle: num(90),
          construction: false,
        },
      ],
      [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'curve', element: { featureId: 'arc-1' } },
        },
      ],
    );
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect(set.frozen.get('arc-1:start')).toBe('fixed');
    expect(set.implicit).toEqual([]);
    expect(countDegreesOfFreedom(set, sketchConstraints(document))).toEqual({
      variables: 0,
      equations: 0,
      implicit: 0,
      remaining: 0,
      excess: 0,
      dangling: [],
    });
  });

  it('式で書かれた半径は定数', () => {
    const document = documentOf([
      {
        id: 'arc-1',
        kind: 'arc',
        name: '円弧1',
        planeId: 'xy',
        center: absoluteCoordinate(0, 0, 0),
        radius: expression('2 * 3', 6),
        startAngle: num(0),
        endAngle: num(360),
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual(['arc-1:center.u', 'arc-1:center.v']);
    expect(set.frozen.get('arc-1.r')).toBe('expression');
    expect(set.constants.get('arc-1.r')).toBe(6);
  });

  it('楕円は中心 2 個+長半径+短半径の 4 個', () => {
    const document = documentOf([
      {
        id: 'ellipse-1',
        kind: 'ellipse',
        name: '楕円1',
        planeId: 'xy',
        center: absoluteCoordinate(1, 2, 0),
        majorRadius: num(10),
        minorRadius: num(4),
        rotation: num(0),
        startAngle: num(0),
        endAngle: num(360),
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual([
      'ellipse-1:center.u',
      'ellipse-1:center.v',
      'ellipse-1.rmajor',
      'ellipse-1.rminor',
    ]);
    expect(set.initial).toEqual([1, 2, 10, 4]);
  });

  it('スプラインの点は 1 つずつ変数になり、端点の鍵は先頭・末尾の別名になる', () => {
    const document = documentOf([
      {
        id: 'spline-1',
        kind: 'spline',
        name: 'スプライン1',
        planeId: 'xy',
        mode: 'interpolate',
        points: [
          absoluteCoordinate(0, 0, 0),
          absoluteCoordinate(5, 5, 0),
          absoluteCoordinate(10, 0, 0),
        ],
        closed: false,
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual([
      'spline-1#0.u',
      'spline-1#0.v',
      'spline-1#1.u',
      'spline-1#1.v',
      'spline-1#2.u',
      'spline-1#2.v',
    ]);
    // 端点を指した拘束は、同じ点(先頭・末尾)へ寄せて読む。
    expect(canonicalPointKey(set, 'spline-1:start')).toBe('spline-1#0');
    expect(canonicalPointKey(set, 'spline-1:end')).toBe('spline-1#2');
  });

  it('点列の 5 点は変数にしない(基準+間隔+個数から導かれるため)', () => {
    const document = documentOf([
      {
        id: 'pointArray-1',
        kind: 'pointArray',
        name: '点列1',
        planeId: 'xy',
        layout: {
          kind: 'linear',
          base: absoluteCoordinate(0, 0, 0),
          azimuth: num(0),
          spacing: num(10),
          count: num(5),
        },
      },
    ]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect([...set.frozen.entries()]).toEqual([
      ['pointArray-1#0', 'derived'],
      ['pointArray-1#1', 'derived'],
      ['pointArray-1#2', 'derived'],
      ['pointArray-1#3', 'derived'],
      ['pointArray-1#4', 'derived'],
    ]);
    expect(set.constants.get('pointArray-1#4.u')).toBe(40);
  });

  it('矩形・複製・オフセットのような複数曲線のフィーチャーは端点だけを定数として持つ', () => {
    const document = documentOf([
      {
        id: 'rectangle-1',
        kind: 'rectangle',
        name: '矩形1',
        planeId: 'xy',
        corner1: absoluteCoordinate(0, 0, 0),
        corner2: absoluteCoordinate(40, 30, 0),
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect(set.frozen.get('rectangle-1:start')).toBe('derived');
    expect(set.frozen.get('rectangle-1:end')).toBe('derived');
    expect(set.elementFeatureIds.has('rectangle-1')).toBe(true);
  });

  it('正多角形は中心も定数として持つ(同心拘束の相手にできる)', () => {
    const document = documentOf([
      {
        id: 'polygon-1',
        kind: 'polygon',
        name: '正多角形1',
        planeId: 'xy',
        center: absoluteCoordinate(3, 4, 0),
        sides: num(6),
        radius: num(10),
        radiusMode: 'circumscribed',
        construction: false,
      },
    ]);
    const set = variablesOf(document);
    expect(set.frozen.get('polygon-1:center')).toBe('derived');
    // 正多角形の頂点の平均は中心そのもの。
    expect(set.constants.get('polygon-1:center.u')).toBeCloseTo(3, 9);
    expect(set.constants.get('polygon-1:center.v')).toBeCloseTo(4, 9);
  });

  it('3D スケッチ(planeId が free)には変数を作らない(§0.a-0.3)', () => {
    const document = documentOf([
      lineOf(
        'line-1',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(7, 4, 3),
        FREE_WORK_PLANE_ID,
      ),
    ]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect(set.frozen.get('line-1:start')).toBe('derived');
  });

  it('別の作図面の要素と、面から浮いた点は変数にしない', () => {
    const document = documentOf([
      // XZ 面のスケッチの要素は、XY 面の (u, v) では表せない。
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 0, 4), 'xz'),
      // 作図面は XY だが Z を打って面から浮かせた点。動かすと Z が消えるので定数。
      pointOf('point-2', absoluteCoordinate(1, 2, 5)),
    ]);
    const set = variablesOf(document, WORK_PLANES.xy);
    expect(set.variables).toHaveLength(0);
    expect(set.frozen.get('line-1:start')).toBe('derived');
    expect(set.frozen.get('point-2')).toBe('derived');
  });

  it('解決できなかったフィーチャーは変数にも材料にもならない(FR-504)', () => {
    const document = documentOf([
      // 長さ 0 の線分は degenerate で解決できない。
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(0, 0, 0)),
      lineOf('line-2', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0)),
    ]);
    const set = variablesOf(document);
    expect(keysOf(set)).toEqual([
      'line-2:start.u',
      'line-2:start.v',
      'line-2:end.u',
      'line-2:end.v',
    ]);
    expect(set.elementFeatureIds.has('line-1')).toBe(false);
  });
});

describe('変数の並び(決定性。§2.2)', () => {
  it('履歴順 → start / end → u, v の決め打ちで並ぶ', () => {
    const document = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)),
      lineOf('line-2', absoluteCoordinate(10, 0, 0), absoluteCoordinate(10, 10, 0)),
    ]);
    expect(keysOf(variablesOf(document))).toEqual([
      'line-1:start.u',
      'line-1:start.v',
      'line-1:end.u',
      'line-1:end.v',
      'line-2:start.u',
      'line-2:start.v',
      'line-2:end.u',
      'line-2:end.v',
    ]);
  });

  it('同じ文書から 10 回集めても同じ並びになる', () => {
    const document = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)),
      {
        id: 'arc-2',
        kind: 'arc',
        name: '円弧2',
        planeId: 'xy',
        center: absoluteCoordinate(0, 0, 0),
        radius: num(5),
        startAngle: num(0),
        endAngle: num(180),
        construction: false,
      },
    ]);
    const first = keysOf(variablesOf(document));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(keysOf(variablesOf(document))).toEqual(first);
    }
  });
});

describe('初期値は作図面の上の (u, v)(worldToPlane)', () => {
  it('XY 面の (3, 4, 0) は [3, 4]', () => {
    const document = documentOf([pointOf('point-1', absoluteCoordinate(3, 4, 0))]);
    expect(variablesOf(document, WORK_PLANES.xy).initial).toEqual([3, 4]);
  });

  it('XZ 面の (3, 0, 4) は [3, 4](第1軸 X・第2軸 Z)', () => {
    const document = documentOf([pointOf('point-1', absoluteCoordinate(3, 0, 4), 'xz')]);
    expect(variablesOf(document, WORK_PLANES.xz).initial).toEqual([3, 4]);
  });

  it('YZ 面の (0, 3, 4) は [3, 4](第1軸 Y・第2軸 Z)', () => {
    const document = documentOf([pointOf('point-1', absoluteCoordinate(0, 3, 4), 'yz')]);
    expect(variablesOf(document, WORK_PLANES.yz).initial).toEqual([3, 4]);
  });
});

describe('変数の数え上げの上限(§2.2)', () => {
  it('上限は 400(点 200 個ぶん)', () => {
    expect(MAX_CONSTRAINT_VARIABLES).toBe(400);
  });

  it('点 201 個は変数 402 個(上限を超えても切り捨てずに数える。判定はタスク7)', () => {
    const features: SketchFeature[] = [];
    for (let n = 0; n < 201; n += 1) {
      features.push(pointOf(`point-${n}`, absoluteCoordinate(n, 0, 0)));
    }
    const set = variablesOf(documentOf(features));
    expect(set.variables).toHaveLength(402);
    expect(set.variables.length).toBeGreaterThan(MAX_CONSTRAINT_VARIABLES);
  });
});

describe('値の読み取り(残差が使う対応表)', () => {
  const document = documentOf([
    lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0)),
    {
      id: 'arc-2',
      kind: 'arc',
      name: '円弧2',
      planeId: 'xy',
      center: absoluteCoordinate(1, 1, 0),
      radius: expression('2 + 3', 5),
      startAngle: num(0),
      endAngle: num(360),
      construction: false,
    },
  ]);
  const set = variablesOf(document);

  it('変数は現在値 x から、定数は constants から読む', () => {
    const x = [1, 2, 3, 4];
    expect(pointValueAt(set, x, 'line-1:start')).toEqual([1, 2]);
    expect(pointValueAt(set, x, 'line-1:end')).toEqual([3, 4]);
    // 半径は式なので定数。x を変えても動かない。
    expect(radiusValueAt(set, x, 'arc-2', 'radius')).toBe(5);
  });

  it('変数の鍵と列の番号が対応表で引ける', () => {
    expect(set.index.get(pointComponentKey('line-1:start', 'u'))).toBe(0);
    expect(set.index.get(pointComponentKey('line-1:end', 'v'))).toBe(3);
    expect(set.index.has(radiusComponentKey('arc-2', 'radius'))).toBe(false);
  });

  it('在らない点は null', () => {
    expect(pointValueAt(set, [0, 0, 0, 0], 'line-9:start')).toBeNull();
    expect(radiusValueAt(set, [0, 0, 0, 0], 'arc-9', 'radius')).toBeNull();
  });

  it('曲線の両端の鍵を引ける', () => {
    expect(curveEndpointKeys(set, 'line-1')).toEqual(['line-1:start', 'line-1:end']);
    expect(curveEndpointKeys(set, 'line-9')).toBeNull();
  });

  it('拘束の指し先を点の鍵に直せる(曲線を指していれば null)', () => {
    expect(constraintPointKey(set, { kind: 'vertex', featureId: 'line-1', vertex: 'end' })).toBe(
      'line-1:end',
    );
    expect(constraintPointKey(set, { kind: 'point', pointId: 'line-1:start' })).toBe(
      'line-1:start',
    );
    expect(
      constraintPointKey(set, { kind: 'curve', element: { featureId: 'line-1' } }),
    ).toBeNull();
    expect(constraintPointKey(set, { kind: 'point', pointId: 'point-9' })).toBeNull();
  });

  it('点の鍵からフィーチャーの id を取り出せる', () => {
    expect(featureIdOfPointKey('line-1:start')).toBe('line-1');
    expect(featureIdOfPointKey('pointArray-2#3')).toBe('pointArray-2');
    expect(featureIdOfPointKey('point-4')).toBe('point-4');
  });
});

describe('自由度の数え方(FR-313「足りない拘束の数を示し」)', () => {
  const line = lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0));
  const horizontal: SketchConstraint = {
    id: 'c-h',
    name: '水平1',
    kind: 'horizontal',
    target: { kind: 'curve', element: { featureId: 'line-1' } },
  };
  const length10: SketchConstraint = {
    id: 'c-d',
    name: '距離1',
    kind: 'distance',
    a: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
    b: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
    length: num(10),
  };
  const fixStart: SketchConstraint = {
    id: 'c-f',
    name: '固定1',
    kind: 'fix',
    target: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
  };

  function countOf(constraints: SketchConstraint[]): ReturnType<typeof countDegreesOfFreedom> {
    const document = documentOf([line], constraints);
    return countDegreesOfFreedom(variablesOf(document), constraints);
  }

  it('拘束なしの線分 1 本は 4', () => {
    expect(countOf([])).toEqual({
      variables: 4,
      equations: 0,
      implicit: 0,
      remaining: 4,
      excess: 0,
      dangling: [],
    });
  });

  it('水平を付けると 3(4 − 1)', () => {
    expect(countOf([horizontal]).remaining).toBe(3);
  });

  it('水平+長さ 10 で 2(平行移動のぶんが残る)', () => {
    expect(countOf([horizontal, length10])).toEqual({
      variables: 4,
      equations: 2,
      implicit: 0,
      remaining: 2,
      excess: 0,
      dangling: [],
    });
  });

  it('さらに始点を固定すると 0(固定は変数を 2 つ減らす)', () => {
    expect(countOf([horizontal, length10, fixStart])).toEqual({
      variables: 2,
      equations: 2,
      implicit: 0,
      remaining: 0,
      excess: 0,
      dangling: [],
    });
  });

  it('付けすぎは負にせず excess で別に数える', () => {
    const many: SketchConstraint[] = [
      horizontal,
      length10,
      fixStart,
      { ...length10, id: 'c-d2', name: '距離2' },
      {
        id: 'c-v',
        name: '垂直1',
        kind: 'vertical',
        target: { kind: 'curve', element: { featureId: 'line-1' } },
      },
    ];
    expect(countOf(many)).toEqual({
      variables: 2,
      equations: 4,
      implicit: 0,
      remaining: 0,
      excess: 2,
      dangling: [],
    });
  });

  it('消えた要素を指す拘束は式を数えず dangling に入れる(FR-504)', () => {
    const dangling: SketchConstraint = {
      id: 'c-x',
      name: '水平2',
      kind: 'horizontal',
      target: { kind: 'curve', element: { featureId: 'line-9' } },
    };
    expect(countOf([horizontal, dangling])).toEqual({
      variables: 4,
      equations: 1,
      implicit: 0,
      remaining: 3,
      excess: 0,
      dangling: ['c-x'],
    });
  });

  it('円 1 つは 3(中心 2 + 半径)、半径拘束を付けると 2', () => {
    const circle: SketchFeature = {
      id: 'arc-1',
      kind: 'arc',
      name: '円1',
      planeId: 'xy',
      center: absoluteCoordinate(0, 0, 0),
      radius: num(5),
      startAngle: num(0),
      endAngle: num(360),
      construction: false,
    };
    const radius: SketchConstraint = {
      id: 'c-r',
      name: '半径1',
      kind: 'radius',
      target: { kind: 'curve', element: { featureId: 'arc-1' } },
      size: num(8),
    };
    expect(countDegreesOfFreedom(variablesOf(documentOf([circle])), []).remaining).toBe(3);
    expect(
      countDegreesOfFreedom(variablesOf(documentOf([circle], [radius])), [radius]).remaining,
    ).toBe(2);
  });

  it('両端が式で書かれた線分は自由度 0(変数が無く、拘束の式だけが残る)', () => {
    const written = lineOf(
      'line-1',
      { mode: 'absolute', x: expression('5 + 5', 10), y: num(0), z: num(0) },
      { mode: 'absolute', x: expression('20 / 1', 20), y: num(4), z: num(0) },
    );
    const document = documentOf([written], [horizontal]);
    const set = variablesOf(document);
    expect(set.variables).toHaveLength(0);
    expect(countDegreesOfFreedom(set, [horizontal])).toEqual({
      variables: 0,
      equations: 1,
      implicit: 0,
      remaining: 0,
      excess: 1,
      dangling: [],
    });
  });
});
