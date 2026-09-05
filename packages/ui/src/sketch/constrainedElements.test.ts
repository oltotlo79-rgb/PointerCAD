/**
 * 「完全に決まった要素」の見分け(FR-313、利用者の決定②、タスク22b)の検査。
 *
 * 決まっていないものを決まったように見せない(控えめな判定)ことを固定する。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  collectVariables,
  createEmptySketchDocument,
  diagnoseConstraints,
  resolveSketch,
  WORK_PLANES,
  type CoordinateInput,
  type SketchConstraint,
  type SketchDocument,
  type VariableSet,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { fullyConstrainedFeatureIds, isShapedByOwnNumbers } from './constrainedElements.js';

const num = expressionValueFromNumber;

/** 式で書かれた値(数値リテラル 1 つではないので変数にならない)。 */
function expression(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

/** 式で書いた座標。 */
function expressionCoordinate(x: readonly [string, number], y: readonly [string, number]): CoordinateInput {
  return {
    mode: 'absolute',
    x: expression(x[0], x[1]),
    y: expression(y[0], y[1]),
    z: num(0),
  };
}

function lineOf(
  document: SketchDocument,
  id: string,
  from: CoordinateInput,
  to: CoordinateInput,
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from,
    to,
    construction: false,
  });
}

function variablesOf(document: SketchDocument): VariableSet {
  return collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
}

function withConstraints(
  document: SketchDocument,
  constraints: readonly SketchConstraint[],
): SketchDocument {
  return { ...document, constraints };
}

describe('isShapedByOwnNumbers', () => {
  it('自分の数で形が決まる 5 種だけを受ける(規則から作られる要素は外す)', () => {
    for (const kind of ['point', 'line', 'arc', 'ellipse', 'spline'] as const) {
      expect(isShapedByOwnNumbers(kind), kind).toBe(true);
    }
    for (const kind of [
      'rectangle',
      'polygon',
      'slot',
      'pointArray',
      'offset',
      'copy',
      'projectedCurve',
      'planeSection',
      'face',
    ] as const) {
      expect(isShapedByOwnNumbers(kind), kind).toBe(false);
    }
  });
});

describe('fullyConstrainedFeatureIds', () => {
  it('作図面が決まらない(3D スケッチ)ときは空', () => {
    const document = lineOf(
      createEmptySketchDocument(),
      'line-1',
      absoluteCoordinate(0, 0, 0),
      absoluteCoordinate(10, 0, 0),
    );
    expect(fullyConstrainedFeatureIds(document, null, null).size).toBe(0);
  });

  it('拘束の無いふつうの線分は決まっていない(既定色のまま)', () => {
    const document = lineOf(
      createEmptySketchDocument(),
      'line-1',
      absoluteCoordinate(0, 0, 0),
      absoluteCoordinate(10, 0, 0),
    );
    const decided = fullyConstrainedFeatureIds(document, variablesOf(document), null);
    expect(decided.has('line-1')).toBe(false);
  });

  it('両端とも式で書いた線分は、拘束が 1 つも無くても決まっている', () => {
    const document = lineOf(
      createEmptySketchDocument(),
      'line-1',
      expressionCoordinate(['0 + 0', 0], ['0 + 0', 0]),
      expressionCoordinate(['4 + 6', 10], ['0 + 0', 0]),
    );
    const set = variablesOf(document);
    // 式で書いた座標は変数にならない(model の規約)。
    expect(set.variables).toHaveLength(0);
    expect(fullyConstrainedFeatureIds(document, set, null).has('line-1')).toBe(true);
  });

  it('「固定」で留めた線分は決まっている', () => {
    const document = withConstraints(
      lineOf(
        createEmptySketchDocument(),
        'line-1',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 0, 0),
      ),
      [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'curve', element: { featureId: 'line-1' } },
        },
      ],
    );
    const set = variablesOf(document);
    const diagnosis = diagnoseConstraints(
      document.constraints ?? [],
      set,
      set.initial,
    );
    expect(fullyConstrainedFeatureIds(document, set, diagnosis).has('line-1')).toBe(true);
  });

  it('残りの自由度が 0 になったら、変数を持つ要素も決まっている', () => {
    /*
      両端を固定した線分に、もう 1 本を一致・一致で貼り付ければ全体の自由度は 0 になる。
      ここでは簡単に「線分 1 本の両端を固定」で 0 を作り、判定 (b) が働くことだけを見る。
    */
    const document = withConstraints(
      lineOf(
        createEmptySketchDocument(),
        'line-1',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 0, 0),
      ),
      [
        {
          id: 'fix-1',
          name: '固定1',
          kind: 'fix',
          target: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
        },
        {
          id: 'fix-2',
          name: '固定2',
          kind: 'fix',
          target: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
        },
      ],
    );
    const set = variablesOf(document);
    const diagnosis = diagnoseConstraints(document.constraints ?? [], set, set.initial);
    expect(diagnosis.degreesOfFreedom).toBe(0);
    expect(fullyConstrainedFeatureIds(document, set, diagnosis).has('line-1')).toBe(true);
  });

  it('規則から作られる要素(矩形)は、変数を持たなくても決まったとは言わない', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'rect-1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(10, 5, 0),
      construction: false,
    });
    const set = variablesOf(document);
    expect(fullyConstrainedFeatureIds(document, set, null).has('rect-1')).toBe(false);
  });
});
