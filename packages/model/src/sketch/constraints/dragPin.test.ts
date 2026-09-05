import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import { FREE_WORK_PLANE_ID, WORK_PLANES, type WorkPlane, type WorkPlaneId } from '../planeMath.js';
import type { CoordinateInput, ResolvedSketch, SketchDocument, SketchFeature } from '../types.js';
import { distanceVec3, type Vec3 } from '../vec3.js';
import {
  resolveConstrainedSketch,
  type ConstrainedSketch,
  type ConstrainedSolveOptions,
} from './solveSketch.js';
import type { ConstraintTarget, SketchConstraint } from './types.js';

/**
 * 引っぱりの口(FR-313「要素を動かすと条件を保ったまま追従」、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク14)の検査。
 *
 * **軟らかい目標+拘束優先**(§0.a 追記 3、2026-09-05 の統括の決定)で解くので、
 * 「拘束を先に満たしたうえで、残った自由度のぶんだけポインタへ寄る」ことを固定する。
 * 期待値は計画書の検証表をそのまま写さず、**担当が実測して測り直した**(食い違いは
 * それぞれの検査の注釈に理由を書いてある)。
 */

function documentOf(
  features: SketchFeature[],
  constraints: SketchConstraint[] = [],
): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features, constraints };
}

function lineOf(
  id: string,
  from: CoordinateInput,
  to: CoordinateInput,
  planeId: WorkPlaneId = 'xy',
): SketchFeature {
  return { id, kind: 'line', name: id, planeId, from, to, construction: false };
}

function atVertex(featureId: string, vertex: 'start' | 'end' | 'center'): ConstraintTarget {
  return { kind: 'vertex', featureId, vertex };
}

function atCurve(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

function fixAt(id: string, target: ConstraintTarget): SketchConstraint {
  return { id, name: id, kind: 'fix', target };
}

function horizontalOn(id: string, featureId: string): SketchConstraint {
  return { id, name: id, kind: 'horizontal', target: atCurve(featureId) };
}

function distanceBetween(
  id: string,
  a: ConstraintTarget,
  b: ConstraintTarget,
  length: ExpressionValue,
): SketchConstraint {
  return { id, name: id, kind: 'distance', a, b, length };
}

/** 引っぱりの目標を 1 点だけ渡す。 */
function pinnedAt(pointKey: string, u: number, v: number): ConstrainedSolveOptions {
  return { pinned: new Map([[pointKey, [u, v] as const]]) };
}

function solvedAt(constrained: ConstrainedSketch, pointKey: string): Vec3 {
  const found = constrained.solution.get(pointKey);
  if (found === undefined) {
    throw new Error(`点 ${pointKey} が解かれていません`);
  }
  return found;
}

function segmentOf(
  resolved: ResolvedSketch,
  featureId: string,
): { readonly from: Vec3; readonly to: Vec3 } {
  const found = resolved.segments.find((segment) => segment.featureId === featureId);
  if (found === undefined) {
    throw new Error(`線分 ${featureId} が解決されていません`);
  }
  return found;
}

function expectVec3(actual: Vec3, expected: Vec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
  expect(actual[2]).toBeCloseTo(expected[2], 6);
}

/** 水平拘束だけを付けた (0,0)–(10,0) の線分。 */
function horizontalLine(): SketchDocument {
  return documentOf(
    [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0))],
    [horizontalOn('h-1', 'line-1')],
  );
}

describe('引っぱると拘束を保ったまま追従する(FR-313、タスク14)', () => {
  it('水平拘束の線分の終点を斜めに引くと、水平を保ったまま線分ごと縦へ動く', () => {
    /*
      **計画書の検証表 1 行目「終点が (14, 0)、始点は動かない」は成り立たない**
      (2026-09-05 の実測で担当が測り直した)。水平拘束は「両端の v が等しい」という
      1 本の式なので、終点だけを v = 6 へ寄せると始点も v = 6 へ付いてくるほかない。
      始点を v = 0 に留めたまま終点を (14, 6) へ置く形は、水平拘束を破らない限り存在しない。
      横方向は拘束が何も言っていないので、終点の u だけが 14 になり始点の u は 0 のまま。
    */
    const constrained = resolveConstrainedSketch(
      horizontalLine(),
      {},
      pinnedAt('line-1:end', 14, 6),
    );
    const start = solvedAt(constrained, 'line-1:start');
    const end = solvedAt(constrained, 'line-1:end');
    expect(end[0]).toBeCloseTo(14, 6);
    expect(end[1]).toBeCloseTo(6, 6);
    // 始点の横位置は動かない(引っぱりが何も言っていない向きは動かさない)。
    expect(start[0]).toBeCloseTo(0, 6);
    // 水平が保たれている(2 点の v が等しい)。
    expect(start[1]).toBeCloseTo(end[1], 6);
  });

  it('同じ線分の始点を引くと、終点は縦だけが付いてくる', () => {
    const constrained = resolveConstrainedSketch(
      horizontalLine(),
      {},
      pinnedAt('line-1:start', -3, 5),
    );
    const start = solvedAt(constrained, 'line-1:start');
    const end = solvedAt(constrained, 'line-1:end');
    expect(start[0]).toBeCloseTo(-3, 6);
    expect(start[1]).toBeCloseTo(5, 6);
    // 横は拘束が何も言っていないので終点の u は 10 のまま。縦だけが水平拘束で付いてくる。
    expect(end[0]).toBeCloseTo(10, 6);
    expect(end[1]).toBeCloseTo(5, 6);
  });

  it('水平+長さ 10 の線分の終点を (30, 6) へ引くと、線分ごと平行移動する(長さは 10 のまま)', () => {
    /*
      計画書の検証表 3 行目は「終点が (10,0) のまま、始点が (20,0) へ動く…担当が実測して
      固定する」だった。**実測(2026-09-05)は「線分ごと (20,6)–(30,6) へ動く」。**
      長さ 10 と水平の 2 本は線分を平行移動させれば両方とも満たせるので、引っぱった終点は
      目標へちょうど届き、始点はその 10mm 手前へ付いてくる。
    */
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0))],
      [
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
      ],
    );
    const constrained = resolveConstrainedSketch(document, {}, pinnedAt('line-1:end', 30, 6));
    const start = solvedAt(constrained, 'line-1:start');
    const end = solvedAt(constrained, 'line-1:end');
    expectVec3(end, [30, 6, 0]);
    expectVec3(start, [20, 6, 0]);
    expect(distanceVec3(start, end)).toBeCloseTo(10, 6);
  });

  it('始点を固定した長さ 10 の線分の端点は、届かない目標でも円周の上を回って最も近い所へ行く', () => {
    /*
      **拘束が先、引っぱりが後**(§0.a 追記 3)が最もはっきり出る場合。始点が固定されて
      長さも決まっているので、端点は半径 10 の円の上しか動けない。真上の (0, 30) を指すと、
      端点は円周を 90° 回って (0, 10) へ着く。重み付きの釣り合いなので長さはきっちり 10 では
      なく 2e-3mm ほど伸びるが、これは引っぱっている最中の見た目だけで、離して解き直せば
      消える(`DRAG_PIN_WEIGHT` の注釈)。
    */
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0))],
      [
        fixAt('fix-1', atVertex('line-1', 'start')),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
      ],
    );
    const constrained = resolveConstrainedSketch(document, {}, pinnedAt('line-1:end', 0, 30));
    const end = solvedAt(constrained, 'line-1:end');
    expect(end[0]).toBeCloseTo(0, 2);
    expect(end[1]).toBeCloseTo(10, 2);
    expect(Math.hypot(end[0], end[1])).toBeCloseTo(10, 2);
    // 固定した始点は動かない(変数ではないので解の表にも現れない)。
    expect(constrained.solution.has('line-1:start')).toBe(false);
  });

  it('引っぱりは診断に数えない(矛盾として報告しない)', () => {
    const constrained = resolveConstrainedSketch(
      horizontalLine(),
      {},
      pinnedAt('line-1:end', 14, 6),
    );
    expect(constrained.diagnosis).toBeNull();
    expect(constrained.errors).toEqual([]);
  });

  it('式で書かれた座標は引っぱっても動かない(FR-202 が勝つ)', () => {
    const document = documentOf(
      [
        lineOf(
          'line-1',
          {
            mode: 'absolute',
            x: { source: '5 + 5', value: 10, display: '10' },
            y: num(0),
            z: num(0),
          },
          absoluteCoordinate(20, 0, 0),
        ),
      ],
      [horizontalOn('h-1', 'line-1')],
    );
    const constrained = resolveConstrainedSketch(document, {}, pinnedAt('line-1:start', 30, 9));
    expect(constrained.variableSet?.frozen.get('line-1:start')).toBe('expression');
    // 引っぱった先ではなく、式が言う (10, 0) のまま。
    expectVec3(segmentOf(constrained.resolved, 'line-1').from, [10, 0, 0]);
  });

  it('「固定」拘束の付いた点は引っぱっても動かない', () => {
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0))],
      [fixAt('fix-1', atVertex('line-1', 'start')), horizontalOn('h-1', 'line-1')],
    );
    const constrained = resolveConstrainedSketch(document, {}, pinnedAt('line-1:start', 30, 9));
    expect(constrained.variableSet?.frozen.get('line-1:start')).toBe('fixed');
    expectVec3(segmentOf(constrained.resolved, 'line-1').from, [0, 0, 0]);
  });

  it('拘束が 0 個のスケッチでも引っぱれる(連立は解かない)', () => {
    const plain = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)),
      lineOf('line-2', absoluteCoordinate(0, 5, 0), absoluteCoordinate(10, 5, 0)),
    ]);
    const constrained = resolveConstrainedSketch(plain, {}, pinnedAt('line-1:end', 4, 8));
    // 反復は 1 度も回っていない(拘束を使わない文書の所要を落とさない)。
    expect(constrained.outcome).toBeNull();
    expect(constrained.diagnosis).toBeNull();
    // 引っぱった点だけが動き、他の点は 1 つも上書きされない。
    expect([...constrained.solution.keys()]).toEqual(['line-1:end']);
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [4, 8, 0]);
    expectVec3(segmentOf(constrained.resolved, 'line-1').from, [0, 0, 0]);
    expectVec3(segmentOf(constrained.resolved, 'line-2').from, [0, 5, 0]);
  });

  it('動かせない点だけを引っぱっても、形は変わらず例外も出ない', () => {
    const plain = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)),
    ]);
    // 実在しない点の鍵。黙って落として何もしない。
    const constrained = resolveConstrainedSketch(plain, {}, pinnedAt('line-9:end', 4, 8));
    expect(constrained.solution.size).toBe(0);
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [10, 0, 0]);
  });

  it('3D スケッチを引っぱっても例外を投げず、断りも出さない', () => {
    const free = documentOf([
      lineOf(
        'line-1',
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 0, 0),
        FREE_WORK_PLANE_ID,
      ),
    ]);
    const constrained = resolveConstrainedSketch(free, {}, pinnedAt('line-1:end', 4, 8));
    expect(constrained.errors).toEqual([]);
    expect(constrained.solution.size).toBe(0);
  });

  it('文書は 1 か所も書き換えない(引っぱっている間は履歴が伸びない)', () => {
    const document = horizontalLine();
    const before = document.features[0];
    resolveConstrainedSketch(document, {}, pinnedAt('line-1:end', 14, 6));
    expect(document.features[0]).toBe(before);
  });

  it('同じ引っぱりからは必ず同じ形になる(決定性)', () => {
    const first = resolveConstrainedSketch(horizontalLine(), {}, pinnedAt('line-1:end', 14, 6));
    const second = resolveConstrainedSketch(horizontalLine(), {}, pinnedAt('line-1:end', 14, 6));
    expect([...second.solution]).toEqual([...first.solution]);
  });

  it('拘束が 0 個のときは、引っぱっていても解決が 2 回で済む', () => {
    // 線分 2 本 → 1 回の解決につき作図面を 2 回引く。①と③で 4 回 + 面を決める 1 回 = 5 回。
    // 拘束があるときと同じ回数だが、②の連立は 1 度も解いていない(1 つ上の検査)。
    let calls = 0;
    const plain = documentOf([
      lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)),
      lineOf('line-2', absoluteCoordinate(0, 5, 0), absoluteCoordinate(10, 5, 0)),
    ]);
    resolveConstrainedSketch(
      plain,
      {
        workPlane: (planeId): WorkPlane | null => {
          calls += 1;
          return planeId === 'xy' ? WORK_PLANES.xy : null;
        },
      },
      pinnedAt('line-1:end', 4, 8),
    );
    expect(calls).toBe(5);
  });

  it('引っぱりの 1 コマの所要を測る(拘束 51 件・変数 100 個、NFR-PF-1)', () => {
    const features: SketchFeature[] = [];
    const constraints: SketchConstraint[] = [];
    for (let index = 0; index < 25; index += 1) {
      const id = `line-${index}`;
      features.push(
        lineOf(id, absoluteCoordinate(index * 3, 0, 0), absoluteCoordinate(index * 3 + 7, 4, 0)),
      );
      constraints.push(horizontalOn(`h-${index}`, id));
      constraints.push(
        distanceBetween(`d-${index}`, atVertex(id, 'start'), atVertex(id, 'end'), num(10)),
      );
    }
    // 引っぱりが拘束とぶつかる形にして、最悪に近い所要を測る(始点を 1 つ固定する)。
    constraints.push(fixAt('fix-1', atVertex('line-3', 'start')));
    const document = documentOf(features, constraints);
    const samples: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      const started = performance.now();
      const solved = resolveConstrainedSketch(
        document,
        {},
        pinnedAt('line-3:end', 40 + frame * 0.3, 26),
      );
      samples.push(performance.now() - started);
      expect(solved.solution.size).toBeGreaterThan(0);
    }
    samples.sort((a, b) => a - b);
    // 上限では判定しない(並列作業中の CPU 競合で境界値が揺れるため。rules/06 の 10.3)。
    console.log(
      `[実測] 引っぱりの 1 コマ(拘束 51 件・変数 100 個): 中央値 ${samples[15].toFixed(2)}ms / 最悪 ${samples[29].toFixed(2)}ms`,
    );
    expect(Number.isFinite(samples[15])).toBe(true);
  });
});
