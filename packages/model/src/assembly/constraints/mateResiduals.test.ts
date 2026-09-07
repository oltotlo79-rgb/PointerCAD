import { expressionValueFromNumber } from '@pointercad/expression';
import { afterAll, describe, expect, it } from 'vitest';

import type { LinearizedRow } from '../../sketch/constraints/solve.js';
import { scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import {
  applyPlacementToDirection, applyPlacementToPoint, IDENTITY_PLACEMENT,
  exponentialMap, multiplyQuaternion, quaternionFromAxisAngle, type RigidPlacement,
} from '../placementMath.js';
import type { AssemblyComponent, Mate, MateKind } from '../types.js';
import {
  buildMateResidualReport, buildMateResiduals, prepareMateResiduals,
  MATE_ANGLE_REFUSAL_MESSAGE, MATE_DISTANCE_REFUSAL_MESSAGE,
  type MateResidualInput, type MateResidualPreparationInput, type MateResidualTarget,
} from './mateResiduals.js';
import { collectMateVariables } from './mateVariables.js';

const O: Vec3 = [0, 0, 0];
const Z: Vec3 = [0, 0, 1];
function point(p: Vec3 = O): MateResidualTarget {
  return { kind: 'point', point: p, direction: null, radius: null };
}
function plane(p: Vec3 = O, n: Vec3 = Z): MateResidualTarget {
  return { kind: 'plane', point: p, direction: n, radius: null };
}
function cylinder(origin: Vec3 = O, axis: Vec3 = Z, radius = 2): MateResidualTarget {
  return { kind: 'cylinder', point: origin, axisOrigin: origin, direction: axis, radius };
}
function component(id: string, fixed: boolean): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false };
}
function mate(kind: MateKind, value = 0, flipped = false): Mate {
  return { id: 'mate-1', name: '合致1', kind,
    a: { kind: 'origin', componentId: 'a', element: 'origin' },
    b: { kind: 'origin', componentId: 'b', element: 'origin' },
    value: expressionValueFromNumber(value), flipped, suppressed: false };
}
function preparation(m: Mate, a: MateResidualTarget, b: MateResidualTarget,
  placements: ReadonlyMap<string, RigidPlacement> = new Map([['a', IDENTITY_PLACEMENT], ['b', IDENTITY_PLACEMENT]]),
): MateResidualPreparationInput {
  return { mates: [m], targets: new Map([[m.id, { a, b }]]), placements };
}
function prepared(source: MateResidualPreparationInput, fixedA = false, fixedB = false): MateResidualInput {
  const report = prepareMateResiduals(source);
  expect(report.skipped).toEqual([]);
  return { mates: report.mates, placements: source.placements,
    variableSet: collectMateVariables({ ...createAssemblyDocument('組'),
      components: [component('a', fixedA), component('b', fixedB)] }),
    characteristicLength: 1 };
}
function input(kind: MateKind, a = plane(), b = plane(), value = 0, flipped = false): MateResidualInput {
  return prepared(preparation(mate(kind, value, flipped), a, b));
}
function values(input: MateResidualInput): readonly number[] {
  const report = buildMateResidualReport(input);
  expect(report.skipped).toEqual([]);
  return report.rows.map((r) => r.value);
}

describe('平行と一致(P7の検証表、L₀=1mmで生の値を照合)', () => {
  it('平行は2本', () => expect(values(input('parallel'))).toEqual([0, 0]));
  it('一致済みの面は3本とも0', () => expect(values(input('coincident'))).toEqual([0, 0, 0]));
  it('面が5mm離れていると3本目は5', () => {
    expect(values(input('coincident', plane([0, 0, 5])))).toEqual([0, 0, 5]);
  });
  it('オフセット5mmで3本目が0', () => {
    expect(values(input('coincident', plane([0, 0, 5]), plane(), 5))).toEqual([0, 0, 0]);
  });
  it('90°違うと平行の2行は1と0', () => {
    expect(values(input('parallel', plane(O, [0, 1, 0])))).toEqual([1, 0]);
  });
  it('点同士の一致は差の3成分', () => {
    expect(values(input('coincident', point([2, 3, 5]), point([1, 1, 1])))).toEqual([1, 2, 4]);
  });
  it('点と面の一致は1本', () => {
    expect(values(input('coincident', point([2, 3, 5])))).toEqual([5]);
  });
  it('面を先に選んだ点-面も同じ1本', () => {
    expect(values(input('coincident', plane(), point([2, 3, 5])))).toEqual([5]);
  });
  it('固定だけで合致が無ければ0本', () => {
    const base = prepared(preparation(mate('parallel'), plane(), plane()), true, true);
    expect(base.variableSet.variables).toHaveLength(0);
    expect(buildMateResiduals({ ...base, mates: [] })).toEqual([]);
  });
  it('固定同士の矛盾の行は残し、gradientだけ空にする', () => {
    const base = prepared(preparation(mate('coincident'), plane([0, 0, 5]), plane()), true, true);
    expect(values(base)).toEqual([0, 0, 5]);
    expect(buildMateResiduals(base).every((r) => r.gradient.size === 0)).toBe(true);
  });
  it('固定部品の列を出さない', () => {
    const base = prepared(preparation(mate('coincident'), plane([2, 3, 5]), plane()), true);
    const rows = buildMateResiduals(base);
    for (const row of rows) for (const column of row.gradient.keys()) {
      expect(base.variableSet.componentOf(column)).toBe('b');
    }
  });
  it('部品の配置原点からの腕を微分する', () => {
    const placements = new Map<string, RigidPlacement>([
      ['a', { ...IDENTITY_PLACEMENT, position: [100, 200, 300] }], ['b', IDENTITY_PLACEMENT],
    ]);
    const base = prepared(preparation(mate('coincident'), point([102, 203, 305]), point(), placements));
    const row = buildMateResiduals(base)[2];
    expect(row.gradient.get(3)).toBe(3);
    expect(row.gradient.get(4)).toBe(-2);
  });
  it('既存LinearizedRowへ構造的に渡せてmateIdも持つ', () => {
    const rows = buildMateResiduals(input('parallel'));
    const linear: readonly LinearizedRow[] = rows;
    expect(linear).toHaveLength(2);
    expect(rows.every((r) => r.mateId === 'mate-1')).toBe(true);
  });
});

describe('同心・距離・角度・接線', () => {
  it('同心は4本、軸方向のずれは残さない', () => {
    expect(values(input('concentric', cylinder([0, 0, 5]), cylinder()))).toEqual([0, 0, 0, 0]);
  });
  it('同心は横方向の2成分を残す', () => {
    expect(values(input('concentric', cylinder([3, 4, 5]), cylinder()))).toEqual([0, 0, 4, 3]);
  });
  it('円筒の重心を解析軸の原点と混同しない', () => {
    expect(values(input('concentric', { ...cylinder(), point: [70, 80, 90] }, cylinder()))).toEqual([0, 0, 0, 0]);
  });
  it('円錐等のaxis入力もaxisOriginを使う', () => {
    const axis: MateResidualTarget = { kind: 'axis', point: [8, 9, 10], direction: Z,
      axisOrigin: [0, 0, 2], radius: null };
    expect(values(input('concentric', axis, cylinder()))).toEqual([0, 0, 0, 0]);
  });
  it('点-点距離はノルムから指定距離を引く1本', () => {
    expect(values(input('distance', point([3, 4, 0]), point(), 2))).toEqual([3]);
  });
  it('点-点距離の裏返しは距離の大きさを変えない', () => {
    expect(values(input('distance', point([3, 4, 0]), point(), 2, true))).toEqual([3]);
  });
  it('点-面距離は指定距離を引く1本', () => {
    expect(values(input('distance', point([3, 4, 5]), plane(), 2))).toEqual([3]);
  });
  it('面-点の選択順をそろえる', () => {
    expect(values(input('distance', plane(), point([3, 4, 5]), 2))).toEqual([3]);
  });
  it('面-面距離は指定距離を引く1本', () => {
    expect(values(input('distance', plane([3, 4, 5]), plane(), 2))).toEqual([3]);
  });
  it('裏返した距離は負側の面で0', () => {
    expect(values(input('distance', plane([3, 4, -5]), plane(), 5, true))).toEqual([0]);
  });
  it('指定60°、いま60°の角度残差は0', () => {
    const rows = values(input('angle', plane(O, [Math.sqrt(3) / 2, 0, 0.5]), plane(), 60));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeCloseTo(0, 15);
  });
  it('指定60°、いま90°は−0.5', () => {
    expect(values(input('angle', plane(O, [1, 0, 0]), plane(), 60))[0]).toBeCloseTo(-0.5, 15);
  });
  it('接線は向きと距離の2本', () => {
    expect(values(input('tangent', cylinder([0, 0, 2], [1, 0, 0])))).toEqual([0, 0]);
  });
  it('平面へ傾いた円筒は高さが合っていても1本目が非ゼロ', () => {
    expect(values(input('tangent', cylinder([0, 0, 2], [Math.sqrt(3) / 2, 0, 0.5])))[0]).toBeCloseTo(0.5, 15);
  });
  it('接線でも面重心を使わない', () => {
    expect(values(input('tangent', { ...cylinder([0, 0, 2], [1, 0, 0]), point: [9, 9, 9] }))).toEqual([0, 0]);
  });
  it('平面→円筒の選択順でも接線は同じ', () => {
    expect(values(input('tangent', plane(), cylinder([0, 0, 2], [1, 0, 0])))).toEqual([0, 0]);
  });
  it('初期の接線の負側を追跡し、trialで符号を取り直さない', () => {
    const base = input('tangent', cylinder([0, 0, -2], [1, 0, 0]));
    expect(values(base)).toEqual([0, 0]);
    const increments = base.variableSet.initial.map(() => 0);
    increments[2] = 4;
    expect(values({ ...base, increments })).toEqual([0, 4]);
    expect(base.mates[0].tangentSide).toBe(-1);
  });
  it('接線の明示反転は初期に選んだ側を反転する', () => {
    const base = input('tangent', cylinder([0, 0, -2], [1, 0, 0]), plane(), 0, true);
    expect(base.mates[0].tangentSide).toBe(1);
    expect(values(base)).toEqual([0, -4]);
  });
});

interface DifferenceCase {
  readonly name: string;
  readonly kind: MateKind;
  readonly a: MateResidualTarget;
  readonly b: MateResidualTarget;
  readonly value: number;
  readonly rowCount: number;
}
const directionA: Vec3 = [2, 3, 5];
const directionB: Vec3 = [-3, 4, 2];
const anchorA: Vec3 = [2, -3, 4];
const anchorB: Vec3 = [-5, 7, -2];
const differenceCases: readonly DifferenceCase[] = [
  { name: 'parallel', kind: 'parallel', a: plane(anchorA, directionA), b: plane(anchorB, directionB), value: 0, rowCount: 2 },
  { name: 'coincident-plane', kind: 'coincident', a: plane(anchorA, directionA), b: plane(anchorB, directionB), value: 2, rowCount: 3 },
  { name: 'coincident-point', kind: 'coincident', a: point(anchorA), b: point(anchorB), value: 0, rowCount: 3 },
  { name: 'coincident-point-plane', kind: 'coincident', a: point(anchorA), b: plane(anchorB, directionB), value: 0, rowCount: 1 },
  { name: 'concentric', kind: 'concentric', a: cylinder(anchorA, directionA), b: cylinder(anchorB, directionB), value: 0, rowCount: 4 },
  { name: 'distance-point', kind: 'distance', a: point(anchorA), b: point(anchorB), value: 2, rowCount: 1 },
  { name: 'distance-plane', kind: 'distance', a: plane(anchorA, directionA), b: plane(anchorB, directionB), value: 2, rowCount: 1 },
  { name: 'distance-point-plane', kind: 'distance', a: point(anchorA), b: plane(anchorB, directionB), value: 2, rowCount: 1 },
  { name: 'angle', kind: 'angle', a: plane(anchorA, directionA), b: plane(anchorB, directionB), value: 60, rowCount: 1 },
  { name: 'tangent', kind: 'tangent', a: cylinder(anchorA, directionA), b: plane(anchorB, directionB), value: 0, rowCount: 2 },
];

/** 固定した5配置。位置はL₀倍、角度はrad。乱数を使わない。 */
const configurations = [
  { length: 1, translationA: [0, 0, 0], translationB: [0, 0, 0], angleA: 0, angleB: 0, trial: 0 },
  { length: 0.01, translationA: [2, -5, 3], translationB: [-4, 1, 8], angleA: 0.3, angleB: -0.7, trial: 1e-8 },
  { length: 100, translationA: [4, -2, 1], translationB: [-2, 3, 5], angleA: 1.1, angleB: -0.4, trial: 1 },
  { length: 10000, translationA: [-1, 2, 4], translationB: [5, -4, 1], angleA: -1.4, angleB: 0.8, trial: 0.5 },
  { length: 10, translationA: [3, 1, -5], translationB: [2, -3, 4], angleA: 2.4, angleB: -1.7, trial: -1.2 },
] as const;

function worldTarget(local: MateResidualTarget, placement: RigidPlacement, length: number): MateResidualTarget {
  return { ...local,
    point: applyPlacementToPoint(placement, scaleVec3(local.point, length)),
    direction: local.direction === null ? null : applyPlacementToDirection(placement, local.direction),
    radius: local.radius === null ? null : local.radius * length,
    ...(local.axisOrigin === undefined ? {} : {
      axisOrigin: applyPlacementToPoint(placement, scaleVec3(local.axisOrigin, length)),
    }),
  };
}

const measurements = new Map<string, { absolute: number; relative: number; combined: number; comparisons: number }>();

describe('解析ヤコビアンと中心差分(6種・全派生、固定5配置、2種のh)', () => {
  for (const sample of differenceCases) {
    configurations.forEach((configuration, index) => {
      for (const stepMode of ['fixed', 'scaled'] as const) {
        it(`${sample.name} 配置${index + 1} ${stepMode}`, () => {
          const length = configuration.length;
          const pa: RigidPlacement = { position: scaleVec3(configuration.translationA, length),
            rotation: quaternionFromAxisAngle([2, -1, 3], configuration.angleA) };
          const pb: RigidPlacement = { position: scaleVec3(configuration.translationB, length),
            rotation: quaternionFromAxisAngle([-1, 4, 2], configuration.angleB) };
          const placements = new Map([['a', pa], ['b', pb]]);
          const m = mate(sample.kind, sample.value * (sample.kind === 'angle' ? 1 : length));
          const base = prepared(preparation(m, worldTarget(sample.a, pa, length), worldTarget(sample.b, pb, length), placements));
          const trial = [0.02 * length, -0.01 * length, 0.03 * length, 0.17, -0.12, 0.09,
            -0.05 * length, 0.04 * length, -0.02 * length, -0.1, 0.08, 0.16].map((v) => v * configuration.trial);
          const evaluation = { ...base, characteristicLength: length, increments: trial };
          const analytic = buildMateResidualReport(evaluation);
          expect(analytic.skipped).toEqual([]);
          expect(analytic.rows).toHaveLength(sample.rowCount);
          expect(analytic.rows.every((r) => r.gradient.size <= 12)).toBe(true);
          const metricKey = `${sample.kind}/${stepMode}`;
          const metric = measurements.get(metricKey) ?? { absolute: 0, relative: 0, combined: 0, comparisons: 0 };
          for (let column = 0; column < trial.length; column++) {
            const position = column < 6 ? pa.position : pb.position;
            const h = stepMode === 'fixed' ? 1e-7 : 1e-6 * (column % 6 < 3
              ? Math.max(length, Math.abs(position[column % 6]), Math.abs(trial[column])) : 1);
            const plus = [...trial];
            const minus = [...trial];
            plus[column] += h;
            minus[column] -= h;
            const upper = values({ ...evaluation, increments: plus });
            const lower = values({ ...evaluation, increments: minus });
            expect(upper).toHaveLength(sample.rowCount);
            expect(lower).toHaveLength(sample.rowCount);
            analytic.rows.forEach((row, rowIndex) => {
              const actual = row.gradient.get(column) ?? 0;
              const difference = (upper[rowIndex] - lower[rowIndex]) / (2 * h);
              const absolute = Math.abs(actual - difference);
              const magnitude = Math.max(Math.abs(actual), Math.abs(difference));
              const budget = 1e-8 + 1e-6 * magnitude;
              expect(absolute, `row=${rowIndex}, column=${column}, h=${h}`).toBeLessThanOrEqual(budget);
              metric.absolute = Math.max(metric.absolute, absolute);
              // 小さな導関数は絶対誤差で判定し、相対値の集計から除く。
              if (magnitude >= 0.1) metric.relative = Math.max(metric.relative, absolute / magnitude);
              metric.combined = Math.max(metric.combined, absolute / budget);
              metric.comparisons++;
            });
          }
          expect(metric.relative).toBeLessThanOrEqual(1e-6);
          measurements.set(metricKey, metric);
        });
      }
    });
  }
  afterAll(() => {
    for (const [key, metric] of measurements) {
      console.info(`MATE_DIFFERENCE ${key} ${JSON.stringify(metric)}`);
    }
  });
});

describe('断り・尺度・試行の純粋性', () => {
  it.each([0, 0.1, 0.499, 0.5, 1, 179, 179.5, 180])('角度%s°を正本の文言で断る', (angle) => {
    const report = prepareMateResiduals(preparation(mate('angle', angle), plane(), plane()));
    expect(report.mates).toEqual([]);
    expect(report.skipped).toEqual([{ mateId: 'mate-1', reason: 'angleNearParallel', message: MATE_ANGLE_REFUSAL_MESSAGE }]);
  });
  it.each([1.001, 90, 178.999])('許容範囲の角度%s°は受ける', (angle) => {
    expect(prepareMateResiduals(preparation(mate('angle', angle), plane(), plane())).skipped).toEqual([]);
  });
  it('距離−1を正本の文言で断る', () => {
    const report = prepareMateResiduals(preparation(mate('distance', -1), point(), plane()));
    expect(report.mates).toEqual([]);
    expect(report.skipped).toEqual([{ mateId: 'mate-1', reason: 'negativeDistance', message: MATE_DISTANCE_REFUSAL_MESSAGE }]);
  });
  it('法線ゼロを理由つきで断る', () => {
    const report = prepareMateResiduals(preparation(mate('parallel'), plane(O, O), plane()));
    expect(report.mates).toEqual([]);
    expect(report.skipped[0].reason).toBe('degenerate');
    expect(report.skipped[0].message.length).toBeGreaterThan(0);
  });
  it('軸が定義できなければ理由つきで断る', () => {
    const report = prepareMateResiduals(preparation(mate('concentric'), cylinder(O, O), cylinder()));
    expect(report.mates).toEqual([]);
    expect(report.skipped[0].message).toBe('この形からは軸が決まりません。');
  });
  it('解析軸の原点が無ければ面重心へ後退せず断る', () => {
    const target: MateResidualTarget = { kind: 'cylinder', point: [2, 3, 4], direction: Z, radius: 2 };
    const report = prepareMateResiduals(preparation(mate('concentric'), target, cylinder()));
    expect(report.mates).toEqual([]);
    expect(report.skipped[0].reason).toBe('missingAxis');
  });
  it.each([0, -1, NaN, Infinity])('不正な円筒半径%sを断る', (radius) => {
    expect(prepareMateResiduals(preparation(mate('tangent'), cylinder(O, Z, radius), plane())).skipped[0].reason).toBe('degenerate');
  });
  it('有限でない点を断る', () => {
    expect(prepareMateResiduals(preparation(mate('coincident'), point([NaN, 0, 0]), point())).skipped[0].reason).toBe('degenerate');
  });
  it('平面を同心の対象にしない', () => {
    expect(prepareMateResiduals(preparation(mate('concentric'), plane(), cylinder())).skipped[0].reason).toBe('unsupportedTarget');
  });
  it('点-点距離の微分不能な重なりを断る', () => {
    const report = buildMateResidualReport(input('distance', point(), point(), 2));
    expect(report.rows).toEqual([]);
    expect(report.skipped[0].reason).toBe('degenerate');
  });
  it('参照切れは理由を返す', () => {
    const base = preparation(mate('parallel'), plane(), plane());
    expect(prepareMateResiduals({ ...base, targets: new Map() }).skipped[0].reason).toBe('dangling');
  });
  it('受理済み配置の欠落も理由を返す', () => {
    expect(buildMateResidualReport({ ...input('parallel'), placements: new Map() }).skipped[0].reason).toBe('dangling');
  });
  it('抑制は対象がなくても式も断りも出さない', () => {
    expect(prepareMateResiduals({ mates: [{ ...mate('parallel'), suppressed: true }], targets: new Map(), placements: new Map() }))
      .toEqual({ mates: [], skipped: [] });
  });
  it('値が数でなければ0で代用しない', () => {
    const m: Mate = { ...mate('distance'), value: { source: 'missing', value: NaN, display: 'missing' } };
    expect(prepareMateResiduals(preparation(m, point(), plane())).skipped[0].reason).toBe('invalidValue');
  });
  it('アセンブリのパラメータ表から値を評価する', () => {
    const m: Mate = { ...mate('distance'), value: { source: 'gap', value: 3, display: '3' } };
    const base = preparation(m, point([0, 0, 5]), plane());
    const report = prepareMateResiduals({ ...base, parameters: new Map([['gap', 5]]) });
    expect(report.skipped).toEqual([]);
    expect(report.mates[0].value).toBe(5);
  });
  it('既定L₀=100で長さだけを無次元化する', () => {
    const base = input('coincident', plane([0, 0, 5], [0, 1, 0]));
    const { characteristicLength, ...defaultInput } = base;
    expect(characteristicLength).toBe(1);
    const rows = buildMateResiduals(defaultInput);
    expect(rows.map((r) => r.scale)).toEqual([1, 1, 0.01]);
    expect(rows.map((r) => r.value)).toEqual([1, 0, 0.05]);
    expect(rows[2].gradient.get(2)).toBe(0.01);
  });
  it('長さ残差とヤコビアンへ同じ倍率を掛ける', () => {
    const base = input('coincident', plane([2, 3, 5]));
    const raw = buildMateResiduals(base);
    const scaled = buildMateResiduals({ ...base, characteristicLength: 250 });
    expect(scaled[2].value).toBe(raw[2].value / 250);
    for (const [column, value] of raw[2].gradient) {
      expect(scaled[2].gradient.get(column)).toBe(value / 250);
    }
    expect(scaled.slice(0, 2)).toEqual(raw.slice(0, 2));
  });
  it.each([0, -1, NaN, Infinity])('不正なL₀=%sを断る', (characteristicLength) => {
    const report = buildMateResidualReport({ ...input('parallel'), characteristicLength });
    expect(report.rows).toEqual([]);
    expect(report.skipped[0].reason).toBe('invalidScale');
  });
  it('増分の列数違いを断る', () => {
    expect(buildMateResidualReport({ ...input('parallel'), increments: [0] }).skipped[0].reason).toBe('invalidIncrement');
  });
  it('有限でない増分を断る', () => {
    const base = input('parallel');
    const increments = base.variableSet.initial.map(() => Infinity);
    expect(buildMateResidualReport({ ...base, increments }).skipped[0].reason).toBe('invalidIncrement');
  });
  it('平行の相手が回ればt/sも一緒に回る', () => {
    const base = input('parallel');
    const increments = [0, 0, 0, 0.4, 0.2, -0.3, 0, 0, 0, 0.4, 0.2, -0.3];
    for (const value of values({ ...base, increments })) expect(value).toBeCloseTo(0, 14);
  });
  it('同心の共通回転も横方向の残差を作らない', () => {
    const base = input('concentric', cylinder([0, 0, 5]), cylinder());
    const increments = [0, 0, 0, 0.4, 0.2, -0.3, 0, 0, 0, 0.4, 0.2, -0.3];
    for (const value of values({ ...base, increments })) expect(value).toBeCloseTo(0, 14);
  });
  it('初期の反平行の分岐も選択できる', () => {
    const base = input('parallel', plane(O, [0, 0, -1]));
    expect(base.mates[0].alignmentSign).toBe(-1);
    expect(buildMateResidualReport(base).branchViolations).toEqual([]);
  });
  it('反対のゼロ点は残差の行を残して分岐違反を返す', () => {
    const base = input('parallel');
    const increments = [0, 0, 0, Math.PI, 0, 0, 0, 0, 0, 0, 0, 0];
    const report = buildMateResidualReport({ ...base, increments });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].value).toBeCloseTo(0, 14);
    expect(report.branchViolations).toEqual(['mate-1']);
    expect(base.mates[0].alignmentSign).toBe(1);
  });
  it('明示の反転は選ぶ分岐を変える', () => {
    const base = input('parallel', plane(), plane(), 0, true);
    expect(base.mates[0].alignmentSign).toBe(-1);
    expect(buildMateResidualReport(base).branchViolations).toEqual(['mate-1']);
  });
  it('棄却したtrialの後も基準・増分・局所幾何は不変で同じ行を返す', () => {
    const base = input('coincident', plane([2, 3, 5]));
    const before = structuredClone({ mates: base.mates, placements: base.placements });
    const zero = buildMateResidualReport(base);
    const increments = Object.freeze([0.2, 0.1, -0.4, 0.3, -0.2, 0.1, -0.3, 0.2, 0.1, -0.1, 0.3, 0.4]);
    const first = buildMateResidualReport({ ...base, increments });
    buildMateResidualReport({ ...base, increments: increments.map((v) => -v) });
    expect(buildMateResidualReport({ ...base, increments })).toEqual(first);
    expect(buildMateResidualReport(base)).toEqual(zero);
    expect({ mates: base.mates, placements: base.placements }).toEqual(before);
  });
  it('呼び手が受理して基準を更新した零増分の値はtrialと一致する', () => {
    const base = input('coincident', plane([2, 3, 5]));
    const delta: Vec3 = [0.2, -0.3, 0.4];
    const omega: Vec3 = [0.3, -0.2, 0.1];
    const trial = values({ ...base, increments: [...delta, ...omega, 0, 0, 0, 0, 0, 0] });
    const placements = new Map(base.placements);
    placements.set('a', { position: delta,
      rotation: multiplyQuaternion(exponentialMap(omega), IDENTITY_PLACEMENT.rotation) });
    const accepted = values({ ...base, placements });
    accepted.forEach((value, index) => expect(value).toBeCloseTo(trial[index], 14));
    expect(base.placements.get('a')).toEqual(IDENTITY_PLACEMENT);
  });
});
