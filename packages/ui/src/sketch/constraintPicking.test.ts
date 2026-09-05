/**
 * 拘束の道具の当たり判定と指し先の決め方の検査
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13、FR-313、NFR-UX-1)。
 *
 * 画面(3D)は撮影で確かめるので、ここでは純関数だけを見る。ワールド → 画面の写し方は
 * 検査用の単純な写像(x, y をそのまま画素にする)を渡す(`pickMath.test.ts` と同じ流儀)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  resolveSketch,
  SKETCH_CONSTRAINT_KINDS,
  type CoordinateInput,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  CONSTRAINT_MARK_RADIUS_PIXELS,
  CONSTRAINT_PICK_RADIUS_PIXELS,
  CONSTRAINT_TARGET_COUNTS,
  constraintMarkAt,
  constraintMarksOf,
  constraintTargetCount,
  MARK_POINT_LIFT_PIXELS,
  MARK_SPREAD_PIXELS,
  orderConstraintTargets,
  pickConstraintTarget,
  sameConstraintTarget,
  sketchVertices,
  toggleConstraintTarget,
  vertexAt,
  type ConstraintMark,
} from './constraintPicking.js';
import type { ConstraintAnchor, ConstraintSummary } from './constraintSummary.js';
import type { ProjectToScreen } from './snapMath.js';

/** 作図面(XY)の x, y をそのまま画素にする写し方。奥行きは捨てる。 */
const project: ProjectToScreen = (point: Vec3) => [point[0], point[1]];

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

/** (0,0)–(100,0) の線分と、中心 (200,0)・半径 20 の円。 */
function scene(): ResolvedSketch {
  let document = lineFeature(
    createEmptySketchDocument(),
    'line-1',
    '線分1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(100, 0, 0),
  );
  document = appendFeature(document, {
    id: 'arc-1',
    name: '円1',
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(200, 0, 0),
    radius: expressionValueFromNumber(20),
    startAngle: expressionValueFromNumber(0),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
  document = appendFeature(document, {
    id: 'point-1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(50, 60, 0),
  });
  return resolveSketch(document);
}

describe('端点・中心の当たり判定(統括の決定 2026-09-05)', () => {
  it('線分は両端、円は中心と両端を指せる', () => {
    const vertices = sketchVertices(scene());
    const keys = vertices.map((vertex) => `${vertex.featureId}:${vertex.vertex}`);
    expect(keys).toContain('line-1:start');
    expect(keys).toContain('line-1:end');
    expect(keys).toContain('arc-1:center');
    expect(keys).toContain('arc-1:start');
    // 点フィーチャーは端点ではなく `point` の指し先になるので、ここには入らない。
    expect(keys.some((key) => key.startsWith('point-1'))).toBe(false);
  });

  it('判定半径は 12 画素(吸着と同じ)。外側では拾わない', () => {
    expect(CONSTRAINT_PICK_RADIUS_PIXELS).toBe(12);
    const resolved = scene();
    expect(vertexAt(resolved, project, [11, 0])?.vertex).toBe('start');
    expect(vertexAt(resolved, project, [13, 0])).toBeNull();
  });

  it('近いほうの端点を採る', () => {
    const resolved = scene();
    expect(vertexAt(resolved, project, [95, 0])?.vertex).toBe('end');
    expect(vertexAt(resolved, project, [4, 0])?.vertex).toBe('start');
  });
});

describe('押した場所が指すもの(FR-313)', () => {
  it('線分の端を押すと端点、真ん中を押すと線そのもの', () => {
    const resolved = scene();
    const end = pickConstraintTarget(resolved, project, [100, 2]);
    expect(end?.target).toEqual({ kind: 'vertex', featureId: 'line-1', vertex: 'end' });
    expect(end?.elementId).toBe('line-1');
    const middle = pickConstraintTarget(resolved, project, [50, 0]);
    expect(middle?.target).toEqual({ kind: 'curve', element: { featureId: 'line-1' } });
    expect(middle?.vertex).toBeNull();
  });

  it('円の中心を押すと中心、縁を押すと円そのもの', () => {
    const resolved = scene();
    expect(pickConstraintTarget(resolved, project, [200, 0])?.target).toEqual({
      kind: 'vertex',
      featureId: 'arc-1',
      vertex: 'center',
    });
    expect(pickConstraintTarget(resolved, project, [180, 0])?.target).toEqual({
      kind: 'curve',
      element: { featureId: 'arc-1' },
    });
  });

  it('点フィーチャーを押すと点の指し先になる', () => {
    expect(pickConstraintTarget(scene(), project, [50, 60])?.target).toEqual({
      kind: 'point',
      pointId: 'point-1',
    });
  });

  it('何も無いところは null(押しても何も起きない場所がある)', () => {
    expect(pickConstraintTarget(scene(), project, [500, 500])).toBeNull();
  });
});

describe('種類ごとに要る指し先の数', () => {
  it('14 種すべてに数がある', () => {
    expect(Object.keys(CONSTRAINT_TARGET_COUNTS).sort()).toEqual([...SKETCH_CONSTRAINT_KINDS].sort());
  });

  it('点 2 つ・線 1 本・対称 3 つ', () => {
    expect(constraintTargetCount('coincident')).toBe(2);
    expect(constraintTargetCount('horizontal')).toBe(1);
    expect(constraintTargetCount('symmetric')).toBe(3);
    expect(constraintTargetCount('fix')).toBe(1);
  });
});

describe('押した順を種類の並びへ直す', () => {
  const resolved = scene();
  const line = { kind: 'curve', element: { featureId: 'line-1' } } as const;
  const circle = { kind: 'curve', element: { featureId: 'arc-1' } } as const;
  const pointA = { kind: 'point', pointId: 'point-1' } as const;
  const pointB = { kind: 'vertex', featureId: 'line-1', vertex: 'start' } as const;

  it('接線は円を先に押しても「線分 → 円」に直る', () => {
    expect(orderConstraintTargets('tangent', [circle, line], resolved)).toEqual([line, circle]);
    expect(orderConstraintTargets('tangent', [line, circle], resolved)).toEqual([line, circle]);
  });

  it('対称は軸の線を先に押しても「点・点 → 軸」に直る', () => {
    expect(orderConstraintTargets('symmetric', [line, pointA, pointB], resolved)).toEqual([
      pointA,
      pointB,
      line,
    ]);
  });

  it('角度は押した順のまま(1 本目から 2 本目へ測るので順序に意味がある)', () => {
    const second = { kind: 'curve', element: { featureId: 'arc-1' } } as const;
    expect(orderConstraintTargets('angle', [second, line], resolved)).toEqual([second, line]);
  });
});

describe('押した相手の積み方(NFR-UX-1)', () => {
  const first = { kind: 'point', pointId: 'point-1' } as const;
  const second = { kind: 'vertex', featureId: 'line-1', vertex: 'end' } as const;

  it('押すたびに末尾へ足す', () => {
    expect(toggleConstraintTarget([], first)).toEqual([first]);
    expect(toggleConstraintTarget([first], second)).toEqual([first, second]);
  });

  it('同じところをもう一度押すと外れる(選び直せる)', () => {
    expect(toggleConstraintTarget([first, second], first)).toEqual([second]);
  });

  it('同じ指し先かどうかは種類と鍵で決める', () => {
    expect(sameConstraintTarget(first, { kind: 'point', pointId: 'point-1' })).toBe(true);
    expect(sameConstraintTarget(second, { kind: 'vertex', featureId: 'line-1', vertex: 'start' })).toBe(
      false,
    );
    expect(sameConstraintTarget(first, second)).toBe(false);
  });
});

describe('印の当たり判定(描画・当たり判定・選択の 3 つをそろえる)', () => {
  /** 印を置く場所。既定は「点ではない場所」(線分の中点)なので上へは逃げない。 */
  function anchorAt(position: Vec3, onPoint = false): ConstraintAnchor {
    return { position, onPoint };
  }

  function summaryWith(id: string, anchors: readonly ConstraintAnchor[]): ConstraintSummary {
    return {
      id,
      kind: 'perpendicular',
      label: `直角${id}`,
      detail: '線分1 と 線分2',
      symbol: '⊥',
      value: null,
      valueText: null,
      anchors,
      state: 'ok',
      stateMessage: null,
    };
  }

  it('一覧の行を、指し先の数だけの印へ開く', () => {
    const marks = constraintMarksOf([
      summaryWith('c1', [anchorAt([0, 0, 0]), anchorAt([10, 0, 0])]),
      summaryWith('c2', []),
    ]);
    expect(marks.map((mark) => mark.constraintId)).toEqual(['c1', 'c1']);
    expect(marks[0].symbol).toBe('⊥');
    // 別々の場所なのでずらさない。
    expect(marks.map((mark) => mark.offset)).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('同じ場所に重なった印は横に 18px ずつ並ぶ(利用者の決定③、タスク22b)', () => {
    const marks = constraintMarksOf([
      summaryWith('c1', [anchorAt([5, 0, 0])]),
      summaryWith('c2', [anchorAt([5, 0, 0])]),
      summaryWith('c3', [anchorAt([5, 0, 0])]),
    ]);
    // 3 個なら中央ぞろえで −18 / 0 / +18。
    expect(marks.map((mark) => mark.offset[0])).toEqual([-18, 0, 18]);
    expect(MARK_SPREAD_PIXELS).toBe(18);
  });

  it('点に付く印は点から 14px 上へ逃げる(掴みと競合させない、t14 の申し送り)', () => {
    const marks = constraintMarksOf([summaryWith('c1', [anchorAt([5, 0, 0], true)])]);
    expect(marks[0].offset).toEqual([0, -14]);
    expect(MARK_POINT_LIFT_PIXELS).toBe(14);
  });

  it('ずらした印は、ずらした先で当たり判定する(描画と当たり判定をそろえる)', () => {
    const marks = constraintMarksOf([summaryWith('c1', [anchorAt([0, 0, 0], true)])]);
    // 画面へ写した (0, 0) ではなく、14px 上の (0, −14) で当たる。
    expect(constraintMarkAt(marks, project, [0, 0])).toBeNull();
    expect(constraintMarkAt(marks, project, [0, -14])).toBe('c1');
  });

  it('押した場所にある印を返す。判定半径の外なら null', () => {
    const marks: readonly ConstraintMark[] = [
      { constraintId: 'c1', symbol: '⊥', state: 'ok', position: [0, 0, 0], offset: [0, 0] },
      { constraintId: 'c2', symbol: '∥', state: 'ok', position: [40, 0, 0], offset: [0, 0] },
    ];
    expect(constraintMarkAt(marks, project, [3, 3])).toBe('c1');
    expect(constraintMarkAt(marks, project, [41, 0])).toBe('c2');
    expect(constraintMarkAt(marks, project, [20, 0])).toBeNull();
    expect(CONSTRAINT_MARK_RADIUS_PIXELS).toBe(9);
  });

  it('重なっているときは近いほうを選ぶ', () => {
    const marks: readonly ConstraintMark[] = [
      { constraintId: 'far', symbol: '=', state: 'ok', position: [6, 0, 0], offset: [0, 0] },
      { constraintId: 'near', symbol: '=', state: 'ok', position: [1, 0, 0], offset: [0, 0] },
    ];
    expect(constraintMarkAt(marks, project, [0, 0])).toBe('near');
  });
});
