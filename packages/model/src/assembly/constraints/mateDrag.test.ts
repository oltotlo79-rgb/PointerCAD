import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, Mate } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { MateResidualTargetPair } from './mateResiduals.js';
import { prepareMateDrag, solveMateDrag, type MateDragOptions } from './solveMates.js';
import { mateDragRows } from './mateDrag.js';
import { rigidRowTolerance, scaledRigidJacobian } from './solveRigid.js';

function component(id: string, fixed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'box' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false };
}
function fixture(plane = false) {
  const m: Mate = { id: 'plane', name: 'plane', kind: 'coincident',
    a: { kind: 'origin', componentId: 'moving', element: 'origin' },
    b: { kind: 'origin', componentId: 'ground', element: 'origin' },
    value: expressionValueFromNumber(0), flipped: false, suppressed: false };
  const assembly = { ...createAssemblyDocument('drag'),
    components: [component('ground', true), component('moving'), component('other')],
    mates: plane ? [m] : [] };
  const placements = new Map<string, RigidPlacement>(assembly.components.map((c) => [c.id, IDENTITY_PLACEMENT]));
  const targets = new Map<string, MateResidualTargetPair>(plane ? [['plane', {
    a: { kind: 'plane', point: [0, 0, 0], direction: [0, 0, -1], radius: null },
    b: { kind: 'plane', point: [0, 0, 0], direction: [0, 0, 1], radius: null },
  }]] : []);
  return { assembly, placements, targets };
}
function prepared(plane = false, characteristicLength = 100) {
  const data = fixture(plane);
  const result = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { characteristicLength });
  if (!result.ok) throw new Error(result.reason);
  return { ...data, drag: result.drag };
}
function position(result: ReturnType<typeof solveMateDrag>): Vec3 {
  const p = result.placements.get('moving');
  if (p === undefined) throw new Error('missing moving placement');
  return p.position;
}

describe('P7-18 一時位置目標と hard 成立の契約', () => {
  it.each([0.1, 100, 1e5])('L=%s: 振幅0.01・目的係数0.0001をscaleで相殺しない', (length) => {
    const strong = mateDragRows([1, 2, 3], [0, 0, 0], [0, 1, 2], length, 1);
    const soft = mateDragRows([1, 2, 3], [0, 0, 0], [0, 1, 2], length);
    const variables = ['length', 'length', 'length'] as const;
    const strongJ = scaledRigidJacobian(strong, variables, { characteristicLength: length });
    const softJ = scaledRigidJacobian(soft, variables, { characteristicLength: length });
    soft.forEach((row, axis) => {
      expect(row.scale).toBe(strong[axis].scale);
      expect(row.value / strong[axis].value).toBeCloseTo(0.01, 14);
      expect(softJ[axis][axis] / strongJ[axis][axis]).toBeCloseTo(0.01, 14);
      expect((row.value / rigidRowTolerance(row)) ** 2 / (strong[axis].value / rigidRowTolerance(strong[axis])) ** 2).toBeCloseTo(1e-4, 16);
    });
  });
  it.each(['auto', 'normal', 'qr'] as const)('%s: hard法線10mmが微小接線改善を二乗和で隠さない', (linearSolver) => {
    for (const tangent of [1e-8, 1e-5, 0.1, 10]) {
      const data = fixture(true);
      const preparation = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { linearSolver });
      if (!preparation.ok) throw new Error(preparation.reason);
      const result = solveMateDrag(preparation.drag, [tangent, 0, 10], { phase: 'release' });
      expect(result.hardSatisfied).toBe(true);
      expect(result.committable).toBe(true);
      expect(Math.abs(position(result)[0] - tangent)).toBeLessThan(1e-9);
    }
  });
  it.each([0.1, 100, 1e5])('L=%s: 自由部品は6変数のまま5反復内で生の目標に到達する', (length) => {
    const { drag, placements } = prepared(false, length);
    const result = solveMateDrag(drag, [10, 20, 30], { phase: 'frame' });
    expect(result.stop).toBe('targetReached');
    expect(result.counts.totalIterations).toBeLessThanOrEqual(5);
    expect(result.counts.softIterations).toBeGreaterThan(0);
    expect(result.variableCount).toBe(6);
    expect(result.hardSatisfied).toBe(true);
    expect(result.driverError).toBeLessThan(1e-9);
    position(result).forEach((v, i) => expect(Math.abs(v - [10, 20, 30][i])).toBeLessThan(1e-9));
    expect(result.placements.get('moving')?.rotation).toEqual(placements.get('moving')?.rotation);
    expect(result.placements.get('other')).toEqual(placements.get('other'));
  });
  it.each([[10, 0, 0], [0, 0, 10], [10, 0, 10]] satisfies Vec3[])('平面target %j: hardを壊したsoft候補を公開しない', (x, y, z) => {
    const { drag, placements } = prepared(true);
    const result = solveMateDrag(drag, [x, y, z], { phase: 'release' });
    expect(result.hardSatisfied).toBe(true);
    expect(Math.abs(position(result)[2])).toBeLessThan(1e-9);
    expect(Math.abs(position(result)[0] - x)).toBeLessThan(1e-9);
    expect(result.committable).toBe(true);
    expect(result.stop).toBe(z === 0 ? 'targetReached' : 'stationary');
    expect(result.counts.totalIterations).toBeLessThanOrEqual(50);
    expect(result.placements.get('ground')).toEqual(placements.get('ground'));
  });
  it.each([0, 1, 2, 5])('hardあり予算%s: 射影予約と最終再評価を共通予算に含める', (maxIterations) => {
    const { drag } = prepared(true);
    const result = solveMateDrag(drag, [10, 0, 10], { phase: 'frame', maxIterations });
    expect(result.counts.totalIterations).toBeLessThanOrEqual(maxIterations);
    expect(result.counts.totalIterations).toBe(result.counts.softIterations + result.counts.projectionIterations);
    expect(result.hardSatisfied).toBe(true);
    expect(result.counts.evaluations).toBeGreaterThanOrEqual(1);
    expect(result.committable).toBe(false);
    if (maxIterations <= 1) expect(result.counts.totalIterations).toBe(0);
  });
  it('hard成立だけでは予算切れreleaseを確定しない', () => {
    const { drag } = prepared();
    const result = solveMateDrag(drag, [10, 20, 30], { phase: 'release', maxIterations: 0 });
    expect(result.hardSatisfied).toBe(true);
    expect(result.stop).toBe('iterationLimit');
    expect(result.committable).toBe(false);
  });
  it('事前cancelは追加評価・反復・確定を行わない', () => {
    const { drag, placements } = prepared();
    const result = solveMateDrag(drag, [10, 20, 30], { phase: 'release', shouldCancel: () => true });
    expect(result.stop).toBe('cancelled');
    expect(result.counts.evaluations).toBe(0);
    expect(result.counts.totalIterations).toBe(0);
    expect(result.committable).toBe(false);
    expect(result.placements).toEqual(placements);
  });
  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])('無効target %sを巨大有限値へ置換しない', (value) => {
    const { drag, placements } = prepared();
    const result = solveMateDrag(drag, [value, 0, 0], { phase: 'release' });
    expect(result.stop).toBe('invalidInput');
    expect(result.committable).toBe(false);
    expect(result.placements).toEqual(placements);
    expect(result.counts.totalIterations).toBe(0);
  });
});

describe('P7-18 境界と準備snapshot', () => {
  it.each(['auto', 'normal', 'qr'] as const)('%s: 許容境界×初期誤差×接線スケール', (linearSolver) => {
    for (const factor of [0.1, 0.5, 1, 2, 10]) {
      for (const initialFactor of [0, 0.1, 0.5, 1, 2, 10]) {
        for (const tangent of [1e-8, 1e-5, 0.1, 10]) {
          const data = fixture(true), initialZ = initialFactor * 1e-9;
          data.placements.set('moving', { ...IDENTITY_PLACEMENT, position: [0, 0, initialZ] });
          data.targets.set('plane', {
            a: { kind: 'plane', point: [0, 0, initialZ], direction: [0, 0, -1], radius: null },
            b: { kind: 'plane', point: [0, 0, 0], direction: [0, 0, 1], radius: null },
          });
          const ready = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { linearSolver });
          if (initialFactor >= 1) { expect(ready).toEqual({ ok: false, reason: 'initialUnsatisfied' }); continue; }
          if (!ready.ok) throw new Error(ready.reason);
          let warm = ready.drag.initial;
          let oldError = Infinity;
          const target: Vec3 = [tangent, 0, factor * 1e-9];
          for (let frame = 0; frame < 3; frame += 1) {
            const result = solveMateDrag(ready.drag, target, { phase: 'frame', placements: warm });
            expect(result.hardSatisfied).toBe(true);
            expect(Math.abs(position(result)[2])).toBeLessThan(1e-9);
            expect(result.driverSquaredError).toBeLessThanOrEqual(oldError);
            expect(result.counts.totalIterations).toBeLessThanOrEqual(5);
            warm = result.placements; oldError = result.driverSquaredError;
          }
          const released = solveMateDrag(ready.drag, target, { phase: 'release', placements: warm });
          expect(released.hardSatisfied).toBe(true);
          expect(released.driverSquaredError).toBeLessThanOrEqual(oldError);
          expect(Math.abs(position(released)[0] - tangent)).toBeLessThan(1e-9);
          expect(released.counts.totalIterations).toBeLessThanOrEqual(50);
        }
      }
    }
  });
  it.each(['auto', 'normal', 'qr'] as const)('%s: 10進座標sweepで自由方向と零回転列を維持する', (linearSolver) => {
    for (const length of [0.1, 100, 1e5]) {
      for (const exponent of [-20, -16, -12, -9, -8, -5, -3, 0, 3, 5]) {
        const data = fixture();
        const ready = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { linearSolver, characteristicLength: length });
        if (!ready.ok) throw new Error(ready.reason);
        const value = 10 ** exponent;
        const result = solveMateDrag(ready.drag, [value, -value, value / 2], { phase: 'frame' });
        expect(result.hardSatisfied).toBe(true);
        expect(result.stop).toBe('targetReached');
        expect(result.driverError).toBeLessThan(1e-9);
        expect(result.placements.get('moving')?.rotation).toEqual([0, 0, 0, 1]);
        expect(result.rank).toBeNull();
      }
    }
  });
  it.each([99, 100, 101])('全assembly %s部品の上限を対象1部品への切出しで迂回しない', (count) => {
    const data = fixture();
    data.assembly.components = Array.from({ length: count }, (_, index) => component(index === 0 ? 'moving' : String(index)));
    data.placements = new Map(data.assembly.components.map((c) => [c.id, IDENTITY_PLACEMENT]));
    const ready = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving');
    expect(ready.ok).toBe(count <= 100);
    if (!ready.ok) expect(ready.reason).toBe('variableLimit');
  });
  it.each([5, 6, 7])('gauge前の成分6変数と上限%sを比較する', (maximum) => {
    const data = fixture();
    const ready = prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { maxComponentVariables: maximum });
    expect(ready.ok).toBe(maximum >= 6);
  });
  it.each(['fixed', 'suppressed', 'hidden'] as const)('対象が%sなら開始しない', (state) => {
    const data = fixture();
    data.assembly.components = data.assembly.components.map((c) => c.id === 'moving'
      ? { ...c, fixed: state === 'fixed', suppressed: state === 'suppressed', visible: state !== 'hidden' } : c);
    expect(prepareMateDrag(data.assembly, data.targets, data.placements, 'moving')).toEqual({ ok: false, reason: 'unavailableComponent' });
  });
  it('無効なwarm startを成立snapshotの診断で公開しない', () => {
    const { drag } = prepared(true);
    const warm = new Map(drag.initial);
    warm.set('moving', { ...IDENTITY_PLACEMENT, position: [0, 0, 1] });
    const result = solveMateDrag(drag, [10, 0, 0], { phase: 'release', placements: warm });
    expect(result.stop).toBe('initialUnsatisfied');
    expect(result.placements).toEqual(drag.initial);
    expect(result.committable).toBe(false);
  });
  it('固定・独立部品をwarm startで動かせない', () => {
    const { drag } = prepared();
    for (const id of ['ground', 'other']) {
      const warm = new Map(drag.initial);
      warm.set(id, { ...IDENTITY_PLACEMENT, position: [1, 0, 0] });
      const result = solveMateDrag(drag, [10, 0, 0], { phase: 'release', placements: warm });
      expect(result.stop).toBe('invalidInput');
      expect(result.placements).toEqual(drag.initial);
    }
  });
  it('20回のtarget往復とMap逆順が配置・trace・停止・計数まで一致する', () => {
    const run = (reverse: boolean) => {
      const data = fixture(true);
      data.placements.set('moving', { position: [0, 0, 0], rotation: quaternionFromAxisAngle([0, 0, 1], 0.3) });
      const ready = prepareMateDrag(data.assembly, new Map(reverse ? [...data.targets].reverse() : data.targets),
        new Map(reverse ? [...data.placements].reverse() : data.placements), 'moving');
      if (!ready.ok) throw new Error(ready.reason);
      let warm = ready.drag.initial;
      return ([ [10, 3, 0], [-10, 2, 0], [2, -4, 0], [0, 0, 0] ] satisfies Vec3[]).map((target) => {
        const result = solveMateDrag(ready.drag, target, { phase: 'release', placements: warm });
        expect(result.committable).toBe(true);
        expect(result.driverError).toBeLessThan(1e-9);
        expect(result.hardSatisfied).toBe(true);
        const q = result.placements.get('moving')?.rotation;
        if (q === undefined) throw new Error('missing rotation');
        expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThanOrEqual(1e-12);
        expect(q[3]).toBeGreaterThanOrEqual(0);
        warm = result.placements;
        return result;
      });
    };
    const first = run(false);
    for (let repeat = 0; repeat < 20; repeat += 1) expect(run(repeat % 2 === 0)).toEqual(first);
  });
  it.each([0, -1, NaN, Infinity])('L/許容 %s を新APIで拒否する', (value) => {
    const data = fixture();
    for (const key of ['characteristicLength', 'lengthTolerance', 'angleTolerance']) {
      expect(prepareMateDrag(data.assembly, data.targets, data.placements, 'moving', { [key]: value })).toEqual({ ok: false, reason: 'invalidInput' });
    }
  });
  it.each([-1, 0.5, NaN, Infinity, 6])('frame反復%sは整数0〜5だけを許す', (maxIterations) => {
    const { drag } = prepared();
    expect(solveMateDrag(drag, [10, 0, 0], { phase: 'frame', maxIterations }).stop).toBe('invalidInput');
  });
  it.each([-1, NaN, Infinity])('時間上限%sを丸めず拒否する', (maxTimeMs) => {
    const { drag } = prepared();
    expect(solveMateDrag(drag, [10, 0, 0], { phase: 'frame', maxTimeMs }).stop).toBe('invalidInput');
  });
  it.each(['hole', 'inherited', 'undefined', 'nan', 'infinity'] as const)('targetの%sを拒否する', (kind) => {
    const { drag } = prepared();
    const target: [number, number, number] = [1, 2, 3];
    if (kind === 'hole' || kind === 'inherited') Reflect.deleteProperty(target, '1');
    if (kind === 'inherited') Object.setPrototypeOf(target, { 1: 2 });
    if (kind === 'undefined') Object.defineProperty(target, '1', { value: undefined });
    if (kind === 'nan') target[1] = NaN;
    if (kind === 'infinity') target[1] = Infinity;
    const result = solveMateDrag(drag, target, { phase: 'frame' });
    expect(result.stop).toBe('invalidInput');
    expect(result.placements).toEqual(drag.initial);
  });
  it.each([0, 1e-13, NaN, Infinity, Number.MAX_VALUE])('quaternion %s を恒等へのfallbackで受理しない', (value) => {
    const data = fixture();
    data.placements.set('moving', { position: [0, 0, 0], rotation: [value, value, value, value] });
    expect(prepareMateDrag(data.assembly, data.targets, data.placements, 'moving')).toEqual({ ok: false, reason: 'invalidInput' });
  });
  it('準備後の元配置・world target変更が局所snapshotへ伝染しない', () => {
    const data = prepared(true);
    const expected = solveMateDrag(data.drag, [10, 0, 0], { phase: 'release' });
    data.placements.set('moving', { ...IDENTITY_PLACEMENT, position: [50, 60, 70] });
    data.targets.clear();
    expect(solveMateDrag(data.drag, [10, 0, 0], { phase: 'release' })).toEqual(expected);
  });
  it('時間0も最終hardを確認し、途中時間切れの開始済み反復を数える', () => {
    const { drag } = prepared(true);
    const zero = solveMateDrag(drag, [10, 0, 10], { phase: 'frame', maxTimeMs: 0, now: () => 0 });
    expect(zero.stop).toBe('timeLimit');
    expect(zero.counts.totalIterations).toBe(0);
    expect(zero.counts.evaluations).toBeGreaterThanOrEqual(1);
    for (let tick = 2; tick <= 14; tick += 1) {
      let clock = 0;
      const options: MateDragOptions = { phase: 'frame', maxTimeMs: tick, now: () => clock++ };
      const result = solveMateDrag(drag, [10, 0, 10], options);
      expect(result.stop).toBe('timeLimit');
      expect(result.hardSatisfied).toBe(true);
      expect(result.committable).toBe(false);
      expect(result.counts.totalIterations).toBeLessThanOrEqual(5);
      if (tick >= 5) expect(result.counts.totalIterations).toBeGreaterThan(0);
    }
  });
  it.each(['droppedRow', 'nanGradient', 'overflowGradient', 'invalidReport'] as const)('故障注入%sで偽のhard成立を公開しない', (fault) => {
    const { drag } = prepared(true);
    let evaluations = 0;
    const injected = { ...drag, evaluate: (...args: Parameters<typeof drag.evaluate>) => {
      const result = drag.evaluate(...args);
      evaluations += 1;
      if (evaluations <= 1) return result;
      if (fault === 'droppedRow') return { ...result, rows: result.rows.slice(0, -1) };
      if (fault === 'invalidReport') return { ...result, valid: false };
      return { ...result, rows: result.rows.map((row, index) => index === 0
        ? { ...row, gradient: new Map([[0, fault === 'nanGradient' ? NaN : 1e200]]) } : row) };
    } };
    const result = solveMateDrag(injected, [10, 0, 10], { phase: 'release' });
    expect(result.stop).toBe('numericalFailure');
    expect(result.committable).toBe(false);
    expect(result.placements).toEqual(drag.initial);
  });
  it('soft途中・射影途中のcancelで候補を公開せず、追加評価を打ち切る', () => {
    const { drag } = prepared(true);
    for (const cancelAfter of [2, 3, 4, 5, 6, 7, 8]) {
      let evaluations = 0;
      const observed = { ...drag, evaluate: (...args: Parameters<typeof drag.evaluate>) => {
        evaluations += 1;
        return drag.evaluate(...args);
      } };
      const result = solveMateDrag(observed, [10, 0, 10], { phase: 'release', shouldCancel: () => evaluations >= cancelAfter });
      expect(result.stop).toBe('cancelled');
      expect(evaluations).toBe(cancelAfter);
      expect(result.committable).toBe(false);
      expect(result.hardSatisfied).toBe(true);
      expect(Math.abs(position(result)[2])).toBeLessThan(1e-9);
    }
  });
  it.each([0.1, 100, 1e5])('L=%s: pinの解析微分を3段階hで中心差分と照合する', (length) => {
    const position: Vec3 = [3, -4, 5], target: Vec3 = [10, 20, 30];
    const rows = mateDragRows(position, target, [0, 1, 2], length);
    for (const multiplier of [0.1, 1, 10]) {
      const h = length * 1e-7 * multiplier;
      for (let column = 0; column < 6; column += 1) {
        const plus: [number, number, number] = [...position], minus: [number, number, number] = [...position];
        if (column < 3) { plus[column] += h; minus[column] -= h; }
        const a = mateDragRows(plus, target, [0, 1, 2], length), b = mateDragRows(minus, target, [0, 1, 2], length);
        rows.forEach((row, index) => {
          const numerical = (a[index].value - b[index].value) / (2 * h);
          const analytic = row.gradient.get(column) ?? 0;
          expect(Math.abs(numerical - analytic)).toBeLessThanOrEqual(1e-8 + 1e-6 * Math.max(Math.abs(numerical), Math.abs(analytic)));
        });
      }
    }
  });
});
