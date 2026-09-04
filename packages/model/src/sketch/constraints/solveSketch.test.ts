import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import {
  distanceToPlane,
  FREE_WORK_PLANE_ID,
  planeToWorld,
  WORK_PLANES,
  type WorkPlane,
  type WorkPlaneId,
} from '../planeMath.js';
import { resolveSketch, type SketchResolveOptions } from '../resolveSketch.js';
import type {
  CoordinateInput,
  ResolvedSketch,
  SketchDocument,
  SketchFeature,
} from '../types.js';
import { crossVec3, distanceVec3, normalizeVec3, type Vec3 } from '../vec3.js';
import {
  CONSTRAINT_FREE_SKETCH_MESSAGE,
  resolveConstrainedSketch,
  type ConstrainedSketch,
} from './solveSketch.js';
import type { ConstraintTarget, SketchConstraint } from './types.js';
import { MAX_CONSTRAINT_VARIABLES } from './variables.js';

/**
 * タスク8 の検査。**3 段の解決(① 拘束を無視した解決 → ② 連立を解く → ③ 解を差し込んで
 * 解決し直す)が、スケッチ単体でも部品文書の経路でも効くことを固定する。**
 *
 * 期待値はすべて手で導ける形にしてある(計画書 docs/plans/P4b-スケッチの仕上げ.md
 * 「タスク8」の検証表)。座標の比較は `CONSTRAINT_TOLERANCE`(1e-9)より 1 桁緩い
 * 1e-8 で行う(倍精度の丸めが最後の 1 桁に出るため)。
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

function pointOf(id: string, at: CoordinateInput, planeId: WorkPlaneId = 'xy'): SketchFeature {
  return { id, kind: 'point', name: id, planeId, at };
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

function atVertex(featureId: string, vertex: 'start' | 'end' | 'center'): ConstraintTarget {
  return { kind: 'vertex', featureId, vertex };
}

function atCurve(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

function atPoint(pointId: string): ConstraintTarget {
  return { kind: 'point', pointId };
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

function coincidentOf(id: string, a: ConstraintTarget, b: ConstraintTarget): SketchConstraint {
  return { id, name: id, kind: 'coincident', a, b };
}

function radiusOf(id: string, featureId: string, size: ExpressionValue): SketchConstraint {
  return { id, name: id, kind: 'radius', target: atCurve(featureId), size };
}

/** 線分 1 本を「始点固定・水平・長さ 10」で解く定番の文書(検証表の 2 行目)。 */
function horizontalTenDocument(): SketchDocument {
  return documentOf(
    [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
    [
      fixAt('fix-1', atVertex('line-1', 'start')),
      horizontalOn('h-1', 'line-1'),
      distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
    ],
  );
}

function segmentOf(resolved: ResolvedSketch, featureId: string): {
  readonly from: Vec3;
  readonly to: Vec3;
} {
  const found = resolved.segments.find((segment) => segment.featureId === featureId);
  if (found === undefined) {
    throw new Error(`線分 ${featureId} が解決されていません`);
  }
  return found;
}

function expectVec3(actual: Vec3, expected: Vec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 8);
  expect(actual[1]).toBeCloseTo(expected[1], 8);
  expect(actual[2]).toBeCloseTo(expected[2], 8);
}

describe('拘束が 0 個のスケッチ(既存の文書の据え置き)', () => {
  const plain = documentOf([
    lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0)),
    lineOf('line-2', absoluteCoordinate(7, 4, 0), absoluteCoordinate(9, 1, 0)),
  ]);

  it('結果が resolveSketch と完全に一致する', () => {
    const constrained = resolveConstrainedSketch(plain);
    expect(constrained.resolved).toEqual(resolveSketch(plain));
  });

  it('診断も解も持たない(余分な計算をしていない)', () => {
    const constrained = resolveConstrainedSketch(plain);
    expect(constrained.diagnosis).toBeNull();
    expect(constrained.variableSet).toBeNull();
    expect(constrained.outcome).toBeNull();
    expect(constrained.errors).toEqual([]);
    expect(constrained.solution.size).toBe(0);
    expect(constrained.radiusSolution.size).toBe(0);
  });

  it('作図面を引く回数が resolveSketch 1 回ぶんで済む', () => {
    // 解決は「作図面のあるフィーチャー 1 つにつき 1 回」作図面を引く(`resolveSketch`)。
    // 線分 2 本なので 1 回の解決で 2 回。拘束が無ければ解決は 1 回だけ。
    let calls = 0;
    const options: SketchResolveOptions = {
      workPlane: (planeId): WorkPlane | null => {
        calls += 1;
        return planeId === 'xy' ? WORK_PLANES.xy : null;
      },
    };
    resolveConstrainedSketch(plain, options);
    expect(calls).toBe(2);
  });

  it('拘束があるときだけ解決が 2 回になる', () => {
    // 3 段の解決なので ①2 回 + スケッチの作図面を決める 1 回 + ③2 回 = 5 回。
    let calls = 0;
    const options: SketchResolveOptions = {
      workPlane: (planeId): WorkPlane | null => {
        calls += 1;
        return planeId === 'xy' ? WORK_PLANES.xy : null;
      },
    };
    const constrained = documentOf(plain.features.slice(), [horizontalOn('h-1', 'line-1')]);
    resolveConstrainedSketch(constrained, options);
    expect(calls).toBe(5);
  });
});

describe('解いた座標が解決結果へ反映される(FR-313)', () => {
  it('水平+長さ 10(始点は固定)で終点が (10, 0, 0) になる', () => {
    const constrained = resolveConstrainedSketch(horizontalTenDocument());
    const segment = segmentOf(constrained.resolved, 'line-1');
    expectVec3(segment.from, [0, 0, 0]);
    expectVec3(segment.to, [10, 0, 0]);
    expect(constrained.outcome?.converged).toBe(true);
    expect(constrained.errors).toEqual([]);
  });

  it('自由度 0 と診断され、断りが 1 件も出ない', () => {
    const constrained = resolveConstrainedSketch(horizontalTenDocument());
    expect(constrained.diagnosis?.degreesOfFreedom).toBe(0);
    expect(constrained.diagnosis?.conflicting).toEqual([]);
    expect(constrained.diagnosis?.redundant).toEqual([]);
  });

  it('解いた終点を基準にした相対座標の点が (10, 5, 0) まで動く', () => {
    const base = horizontalTenDocument();
    const follower = pointOf('point-1', {
      mode: 'relative',
      base: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      dx: num(0),
      dy: num(5),
      dz: num(0),
    });
    const document = documentOf([...base.features, follower], [...(base.constraints ?? [])]);
    const constrained = resolveConstrainedSketch(document);
    const point = constrained.resolved.points.find((entry) => entry.id === 'point-1');
    expect(point).toBeDefined();
    expectVec3(point?.position ?? [0, 0, 0], [10, 5, 0]);
  });

  it('半径拘束で円弧の半径が 3 から 8 になる', () => {
    const document = documentOf(
      [arcOf('arc-1', absoluteCoordinate(0, 0, 0), num(3), 0, 90)],
      [fixAt('fix-1', atVertex('arc-1', 'center')), radiusOf('r-1', 'arc-1', num(8))],
    );
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.resolved.arcs[0].radius).toBeCloseTo(8, 8);
    expectVec3(constrained.resolved.arcs[0].center, [0, 0, 0]);
  });

  it('円弧の端点を点へ一致させると、開始角が逆算されて端点がその点に来る', () => {
    // 中心 (0,0)・半径 5 の四分円の始点(角度 0 = (5,0))を、(0,-5) の点へ一致させる。
    // 端点は変数なので、動いた端点から開始角(−90 度)が逆算される(`variables.ts` の約束)。
    const document = documentOf(
      [
        arcOf('arc-1', absoluteCoordinate(0, 0, 0), num(5), 0, 90),
        pointOf('point-1', absoluteCoordinate(0, -5, 0)),
      ],
      [
        fixAt('fix-1', atVertex('arc-1', 'center')),
        fixAt('fix-2', atPoint('point-1')),
        radiusOf('r-1', 'arc-1', num(5)),
        coincidentOf('c-1', atVertex('arc-1', 'start'), atPoint('point-1')),
      ],
    );
    const constrained = resolveConstrainedSketch(document);
    const arc = constrained.resolved.arcs[0];
    expect(arc.radius).toBeCloseTo(5, 8);
    expect(arc.startAngle).toBeCloseTo(-Math.PI / 2, 8);
    // 終点(角度 90 度 = (0,5))は動かない。掃く向きも正のまま。
    expect(arc.endAngle).toBeGreaterThan(arc.startAngle);
  });

  it('同じ文書からは必ず同じ解になる(決定性)', () => {
    const document = horizontalTenDocument();
    const first = resolveConstrainedSketch(document);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(resolveConstrainedSketch(document).resolved).toEqual(first.resolved);
    }
  });
});

describe('作図面の中で解く(§0.a-0.3)', () => {
  it('XZ 面のスケッチの水平は、世界の Y ではなく面の第 1 軸(X)に沿う', () => {
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 0, 4), 'xz')],
      [
        fixAt('fix-1', atVertex('line-1', 'start')),
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
      ],
    );
    const constrained = resolveConstrainedSketch(document);
    // XZ 面は axisU = (1,0,0)、axisV = (0,0,1)。水平は v(= z)がそろうこと。
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [10, 0, 0]);
  });

  it('傾いた任意平面の上でも長さが 10 になり、点は面の上に乗る', () => {
    const normal = normalizeVec3([1, 1, 1]);
    const axisU = normalizeVec3([1, -1, 0]);
    const axisV = normalizeVec3(crossVec3(normal, axisU));
    const tilted: WorkPlane = { id: 'tilted', origin: [0, 0, 0], axisU, axisV, normal };
    const start = planeToWorld(tilted, 0, 0);
    const end = planeToWorld(tilted, 7, 4);
    const document = documentOf(
      [
        lineOf(
          'line-1',
          absoluteCoordinate(start[0], start[1], start[2]),
          absoluteCoordinate(end[0], end[1], end[2]),
          'tilted',
        ),
      ],
      [
        fixAt('fix-1', atVertex('line-1', 'start')),
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
      ],
    );
    const constrained = resolveConstrainedSketch(document, {
      workPlane: (planeId) => (planeId === 'tilted' ? tilted : null),
    });
    const segment = segmentOf(constrained.resolved, 'line-1');
    const length = distanceVec3(segment.from, segment.to);
    expect(length).toBeCloseTo(10, 9);
    expect(distanceToPlane(tilted, segment.from)).toBeLessThan(1e-9);
    expect(distanceToPlane(tilted, segment.to)).toBeLessThan(1e-9);
  });

  it('3D スケッチに拘束を足した文書は断り、形は拘束を無視したまま', () => {
    const document = documentOf(
      [
        lineOf(
          'line-1',
          absoluteCoordinate(0, 0, 0),
          absoluteCoordinate(7, 4, 0),
          FREE_WORK_PLANE_ID,
        ),
      ],
      [horizontalOn('h-1', 'line-1')],
    );
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.errors).toHaveLength(1);
    expect(constrained.errors[0].message).toBe(CONSTRAINT_FREE_SKETCH_MESSAGE);
    expect(constrained.diagnosis).toBeNull();
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [7, 4, 0]);
  });
});

describe('解けないときも止めずに理由を出す(FR-504、NFR-RE-1)', () => {
  it('長さ 10 と長さ 12 を同じ線分に付けると constraintConflict が 1 件出る', () => {
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
      [
        fixAt('fix-1', atVertex('line-1', 'start')),
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
        distanceBetween('d-2', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(12)),
      ],
    );
    const constrained = resolveConstrainedSketch(document);
    const conflicts = constrained.errors.filter((entry) => entry.code === 'constraintConflict');
    expect(conflicts).toHaveLength(1);
    expect(constrained.diagnosis?.conflicting.length).toBeGreaterThan(0);
    // 形は最後に得られた x のまま描かれる(例外を投げない)。
    expect(constrained.resolved.segments).toHaveLength(1);
  });

  it('消えた要素を指す拘束は材料不足として断り、残りの拘束は解ける', () => {
    const document = documentOf(
      [lineOf('line-1', absoluteCoordinate(0, 0, 0), absoluteCoordinate(7, 4, 0))],
      [
        fixAt('fix-1', atVertex('line-1', 'start')),
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
        horizontalOn('h-2', 'line-9'),
      ],
    );
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.diagnosis?.dangling).toEqual(['h-2']);
    expect(constrained.errors.some((entry) => entry.featureId === 'h-2')).toBe(true);
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [10, 0, 0]);
  });

  it('変数が上限を超えたら解かずに constraintTooMany を返し、形は拘束を無視したまま', () => {
    // 点 1 つ = 変数 2 つ。201 点で 402 個になり、上限 400 を超える。
    const features: SketchFeature[] = [];
    for (let index = 0; index < MAX_CONSTRAINT_VARIABLES / 2 + 1; index += 1) {
      features.push(pointOf(`point-${index}`, absoluteCoordinate(index, 0, 0)));
    }
    const document = documentOf(features, [
      coincidentOf('c-1', atPoint('point-0'), atPoint('point-1')),
    ]);
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.diagnosis?.tooMany).toBe(true);
    expect(constrained.errors).toHaveLength(1);
    expect(constrained.errors[0].code).toBe('constraintTooMany');
    expect(constrained.outcome).toBeNull();
    // 拘束を無視した形(2 点は重ならない)。
    expectVec3(constrained.resolved.points[1].position, [1, 0, 0]);
  });
});

describe('タスク14(引っぱると追従)が使う口', () => {
  it('解けた座標と変数の一覧を返す(書き戻しと「なぜ動かないか」の材料)', () => {
    const constrained = resolveConstrainedSketch(horizontalTenDocument());
    // 動かせるのは終点だけ(始点は「固定」拘束で変数から外れている)。
    expect([...constrained.solution.keys()]).toEqual(['line-1:end']);
    expectVec3(constrained.solution.get('line-1:end') ?? [0, 0, 0], [10, 0, 0]);
    expect(constrained.variableSet?.frozen.get('line-1:start')).toBe('fixed');
  });

  it('式で書かれた座標は変数にならず、理由が読める', () => {
    const document = documentOf(
      [
        lineOf('line-1', {
          mode: 'absolute',
          x: { source: '0 + 0', value: 0, display: '0' },
          y: { source: '0 + 0', value: 0, display: '0' },
          z: num(0),
        }, absoluteCoordinate(7, 4, 0)),
      ],
      [
        horizontalOn('h-1', 'line-1'),
        distanceBetween('d-1', atVertex('line-1', 'start'), atVertex('line-1', 'end'), num(10)),
      ],
    );
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.variableSet?.frozen.get('line-1:start')).toBe('expression');
    expectVec3(segmentOf(constrained.resolved, 'line-1').from, [0, 0, 0]);
    expectVec3(segmentOf(constrained.resolved, 'line-1').to, [10, 0, 0]);
  });

  it('半径の解は radiusComponentKey の鍵で引ける', () => {
    const document = documentOf(
      [arcOf('arc-1', absoluteCoordinate(0, 0, 0), num(3), 0, 90)],
      [fixAt('fix-1', atVertex('arc-1', 'center')), radiusOf('r-1', 'arc-1', num(8))],
    );
    const constrained = resolveConstrainedSketch(document);
    expect(constrained.radiusSolution.get('arc-1.r')).toBeCloseTo(8, 8);
  });
});

describe('所要(NFR-PF-2 の内側であることの実測)', () => {
  it('拘束 50 件のスケッチを 1 回解く所要を測る', () => {
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
    const document = documentOf(features, constraints);
    const started = performance.now();
    const constrained: ConstrainedSketch = resolveConstrainedSketch(document);
    const elapsed = performance.now() - started;
    expect(constrained.outcome?.converged).toBe(true);
    expect(constrained.diagnosis?.conflicting).toEqual([]);
    // 上限では判定しない(並列作業中の CPU 競合で境界値が揺れるため。rules/06 の 10.3)。
    // 実測値は報告へ載せる。
    console.log(`[実測] 拘束 50 件・変数 100 個の解決 1 回: ${elapsed.toFixed(1)}ms`);
    expect(Number.isFinite(elapsed)).toBe(true);
  });
});
