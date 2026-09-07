import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addVec3, type Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import {
  applyPlacementToPoint, IDENTITY_PLACEMENT, quaternionFromAxisAngle, rotateVector,
  type RigidPlacement,
} from '../placementMath.js';
import type { AssemblyComponent, Mate, MateKind } from '../types.js';
import type { MateResidualTarget, MateResidualTargetPair } from './mateResiduals.js';
import { collectMateVariables } from './mateVariables.js';
import { applyMateIncrements, solveMates } from './solveMates.js';

function component(id: string, fixed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'box' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false };
}
function mate(id: string, kind: MateKind = 'coincident', a = 'moving', b = 'ground', value = 0): Mate {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
    b: { kind: 'origin', componentId: b, element: 'origin' },
    value: expressionValueFromNumber(value), flipped: false, suppressed: false };
}
function plane(point: Vec3, direction: Vec3 = [0, 0, 1]): MateResidualTarget {
  return { point, direction, kind: 'plane', radius: null };
}
function point(position: Vec3): MateResidualTarget {
  return { point: position, direction: null, kind: 'point', radius: null };
}
function axis(position: Vec3, direction: Vec3 = [0, 0, 1]): MateResidualTarget {
  return { point: position, axisOrigin: position, direction, kind: 'cylinder', radius: 5 };
}
function at(position: Vec3): RigidPlacement { return { ...IDENTITY_PLACEMENT, position }; }
function boxes(offset = 0, flipped = false) {
  const m = { ...mate('m', 'coincident', 'moving', 'ground', offset), flipped };
  const assembly = { ...createAssemblyDocument('箱'), components: [component('ground', true), component('moving')], mates: [m] };
  const placements = new Map([['ground', IDENTITY_PLACEMENT], ['moving', at([0, 0, 50])]]);
  const targets = new Map<string, MateResidualTargetPair>([['m', { a: plane([0, 0, 50], [0, 0, -1]), b: plane([0, 0, 20]) }]]);
  return { assembly, placements, targets };
}
function movingPlacement(result: ReturnType<typeof solveMates>, id = 'moving'): RigidPlacement {
  const placement = result.placements.get(id);
  if (placement === undefined) throw new Error(`配置が無い: ${id}`);
  return placement;
}

describe('P7タスク15の検証表', () => {
  it.each([[0, 20], [5, 25]])('箱20³の上面と下面、オフセット%dでZ=%d', (offset, expected) => {
    const { assembly, placements, targets } = boxes(offset);
    const result = solveMates(assembly, targets, placements);
    expect(movingPlacement(result).position[2]).toBeCloseTo(expected, 10);
    expect(result.converged).toBe(true);
    expect(result.maxResidual).toBeLessThan(1e-9);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.iterations).toBeLessThanOrEqual(8);
    expect(result.diagnosis.components[0].rank).toBe(3);
    expect(result.diagnosis.components[0].remainingDegreesOfFreedom).toBe(3);
    expect(result.placements.get('ground')).toEqual(IDENTITY_PLACEMENT);
    expect(placements.get('moving')?.position).toEqual([0, 0, 50]);
  });
  it('裏返すと下面の向きが逆になる', () => {
    const { assembly, placements, targets } = boxes(0, true);
    const result = solveMates(assembly, targets, placements);
    const direction = rotateVector(movingPlacement(result).rotation, [0, 0, -1]);
    expect(direction[2]).toBeCloseTo(1, 12);
    expect(result.branchViolations).toEqual([]);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(8);
    expect(result.diagnosis.components[0].result?.trace[0].linearSolver).toBe('branch');
  });
  it('同心で軸が1e-9以内に一致し、軸方向と軸まわりの回転は自由', () => {
    const rotation = quaternionFromAxisAngle([0, 0, 1], 0.7);
    const assembly = { ...createAssemblyDocument('穴'), components: [component('ground', true), component('moving')],
      mates: [mate('axis', 'concentric')] };
    const placements = new Map([['ground', IDENTITY_PLACEMENT], ['moving', { position: [5, 8, 17] as const, rotation }]]);
    const targets = new Map([['axis', { a: axis([5, 8, 17]), b: axis([0, 0, 0]) }]]);
    const result = solveMates(assembly, targets, placements);
    const solved = movingPlacement(result);
    expect(Math.hypot(solved.position[0], solved.position[1])).toBeLessThan(1e-9);
    expect(solved.position[2]).toBe(17);
    expect(solved.rotation).toEqual(rotation);
    expect(result.diagnosis.components[0].remainingDegreesOfFreedom).toBe(2);
    expect(result.converged).toBe(true);
  });
  it('傾いた円柱も軸方向が一致する', () => {
    const rotation = quaternionFromAxisAngle([1, 0, 0], 0.2);
    const assembly = { ...createAssemblyDocument('穴'), components: [component('ground', true), component('moving')],
      mates: [mate('axis', 'concentric')] };
    const placements = new Map([['ground', IDENTITY_PLACEMENT], ['moving', { position: [2, 3, 17] as const, rotation }]]);
    const targets = new Map([['axis', { a: axis([2, 3, 17], rotateVector(rotation, [0, 0, 1])), b: axis([0, 0, 0]) }]]);
    const result = solveMates(assembly, targets, placements);
    const direction = rotateVector(movingPlacement(result).rotation, [0, 0, 1]);
    expect(Math.hypot(direction[0], direction[1])).toBeLessThan(1e-9);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(8);
  });
  it('同じ入力の2回はMapの内容まで完全一致する', () => {
    const { assembly, placements, targets } = boxes(5, true);
    expect(solveMates(assembly, targets, placements).placements).toEqual(solveMates(assembly, targets, placements).placements);
  });
  it('合致0本で全配置が完全に不変', () => {
    const { assembly, placements } = boxes();
    const result = solveMates({ ...assembly, mates: [] }, new Map(), placements);
    expect(result.placements).toEqual(placements);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
  });
  it('距離10と12は投げず、未収束の候補として返す', () => {
    const { assembly, placements, targets } = boxes();
    const pair = targets.get('m');
    if (pair === undefined) throw new Error('検査用対象が無い');
    const result = solveMates({ ...assembly, mates: [mate('a', 'distance', 'moving', 'ground', 10), mate('b', 'distance', 'moving', 'ground', 12)] },
      new Map([['a', pair], ['b', pair]]), placements);
    expect(result.converged).toBe(false);
    expect(result.diagnosis.status).toBe('suspectedConflict');
    expect(movingPlacement(result).position[2]).toBeCloseTo(31, 8);
    expect(result.diagnosis.constantConflicts).toEqual([]);
  });
  it('四元数は長さ1(1e-12)かつw>=0、並進は回転で回さない', () => {
    const variables = collectMateVariables({ ...createAssemblyDocument('回転'), components: [component('moving')] });
    const placement: RigidPlacement = { position: [100, 200, 300], rotation: [0, 0, 0, -2] };
    const result = applyMateIncrements(new Map([['moving', placement]]), variables, [1, 2, 3, 0, 0, 4]);
    expect(result.get('moving')?.position).toEqual([101, 202, 303]);
    const q = result.get('moving')?.rotation ?? [];
    expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(1e-12);
    expect(q[3]).toBeGreaterThanOrEqual(0);
    expect(placement.position).toEqual([100, 200, 300]);
  });
});

describe('成分・gauge・上限・診断', () => {
  it('独立な未固定成分2つはそれぞれ先頭を固定し、gaugeを12除く', () => {
    const assembly = { ...createAssemblyDocument('独立'), components: ['a', 'b', 'c', 'd'].map((id) => component(id)),
      mates: [mate('ab', 'coincident', 'a', 'b'), mate('cd', 'coincident', 'c', 'd')] };
    const placements = new Map([['a', at([0, 0, 0])], ['b', at([3, 4, 5])], ['c', at([100, 0, 0])], ['d', at([105, 6, 7])]]);
    const targets = new Map([['ab', { a: point([0, 0, 0]), b: point([3, 4, 5]) }],
      ['cd', { a: point([100, 0, 0]), b: point([105, 6, 7]) }]]);
    const result = solveMates(assembly, targets, placements);
    expect(result.diagnosis.components).toHaveLength(2);
    expect(result.diagnosis.components.map((c) => c.gauge.removed)).toEqual([6, 6]);
    expect(result.placements.get('a')).toEqual(placements.get('a'));
    expect(result.placements.get('c')).toEqual(placements.get('c'));
    expect(movingPlacement(result, 'b').position[0]).toBeCloseTo(0, 10);
    expect(movingPlacement(result, 'd').position[0]).toBeCloseTo(100, 10);
    const changed = new Map(targets);
    changed.set('cd', { a: point([110, 0, 0]), b: point([105, 6, 7]) });
    expect(solveMates(assembly, changed, placements).placements.get('b')).toEqual(result.placements.get('b'));
  });
  it('同じ固定部品を介する可動部品は独立に分ける', () => {
    const fixture = boxes();
    const assembly = { ...fixture.assembly, components: [...fixture.assembly.components, component('other')],
      mates: [...fixture.assembly.mates, mate('other')] };
    const second = { ...assembly.mates[1], a: { kind: 'origin' as const, componentId: 'other', element: 'origin' as const } };
    const placements = new Map(fixture.placements).set('other', at([0, 0, 70]));
    const targets = new Map(fixture.targets).set('other', { a: plane([0, 0, 70]), b: plane([0, 0, 20]) });
    const result = solveMates({ ...assembly, mates: [assembly.mates[0], second] }, targets, placements);
    expect(result.diagnosis.components.map((c) => c.componentIds)).toEqual([['moving'], ['other']]);
    expect(result.diagnosis.components.every((c) => c.gauge.kind === 'fixed')).toBe(true);
  });
  it.each(['origin', 'driver'] as const)('上流で姿勢固定済みの%sをgaugeとして認識する', (kind) => {
    const { assembly, placements, targets } = boxes();
    const result = solveMates({ ...assembly, components: assembly.components.map((c) => ({ ...c, fixed: false })) }, targets, placements,
      { anchors: new Map([['ground', kind]]) });
    expect(result.diagnosis.components[0].gauge.kind).toBe(kind);
    expect(result.diagnosis.components[0].gauge.removed).toBe(0);
    expect(result.placements.get('ground')).toEqual(placements.get('ground'));
    expect(result.converged).toBe(true);
  });
  it('全体606変数は解かず全配置を返す', () => {
    const components = Array.from({ length: 101 }, (_, i) => component(String(i)));
    const assembly = { ...createAssemblyDocument('上限'), components };
    const placements = new Map(components.map((c) => [c.id, at([Number(c.id), 0, 0])]));
    const result = solveMates(assembly, new Map(), placements);
    expect(result.converged).toBe(false);
    expect(result.diagnosis.status).toBe('variableLimit');
    expect(result.diagnosis.limits[0]).toMatchObject({ scope: 'assembly', variables: 606, maximum: 600 });
    expect(result.placements).toEqual(placements);
    expect(result.iterations).toBe(0);
  });
  it('全体600変数の境界は許可する', () => {
    const components = Array.from({ length: 100 }, (_, i) => component(String(i)));
    const result = solveMates({ ...createAssemblyDocument('境界'), components }, new Map(),
      new Map(components.map((c) => [c.id, IDENTITY_PLACEMENT])));
    expect(result.diagnosis.limits).toEqual([]);
    expect(result.converged).toBe(true);
  });
  it('全体上限を超えても固定同士の矛盾は診断する', () => {
    const { assembly, targets, placements } = boxes();
    const extra = Array.from({ length: 101 }, (_, i) => component(String(i)));
    const result = solveMates({ ...assembly, components: [
      ...assembly.components.map((c) => ({ ...c, fixed: true })), ...extra,
    ] }, targets, new Map([...placements, ...extra.map((c) => [c.id, IDENTITY_PLACEMENT] as const)]));
    expect(result.diagnosis.limits[0].scope).toBe('assembly');
    expect(result.diagnosis.constantConflicts).toEqual(['m']);
    expect(result.diagnosis.status).toBe('provenConstantConflict');
    expect(result.iterations).toBe(0);
  });
  it('成分別上限は全体の上限とは別に判定し超過成分を保持する', () => {
    const { assembly, placements, targets } = boxes();
    const result = solveMates(assembly, targets, placements, { maxComponentVariables: 5 });
    expect(result.diagnosis.limits).toEqual([{ scope: 'component', componentIds: ['moving'], variables: 6, maximum: 5 }]);
    expect(result.placements).toEqual(placements);
    expect(result.diagnosis.components[0].rank).toBeNull();
  });
  it('固定同士の定数矛盾を残差と診断に残す', () => {
    const { assembly, placements, targets } = boxes();
    const result = solveMates({ ...assembly, components: assembly.components.map((c) => ({ ...c, fixed: true })) }, targets, placements);
    expect(result.diagnosis.status).toBe('provenConstantConflict');
    expect(result.diagnosis.constantConflicts).toEqual(['m']);
    expect(result.maxResidual).toBeCloseTo(0.3, 12);
    expect(result.diagnosis.components[0].rows.map((row) => row.mateId)).toEqual(['m', 'm', 'm']);
    expect(result.placements).toEqual(placements);
  });
  it('固定同士で行ゼロの誤分岐も証明済み矛盾とする', () => {
    const { assembly, placements } = boxes(0, true);
    const targets = new Map([['m', { a: plane([0, 0, 20], [0, 0, -1]), b: plane([0, 0, 20]) }]]);
    const result = solveMates({ ...assembly, components: assembly.components.map((c) => ({ ...c, fixed: true })) }, targets, placements);
    expect(result.residualNorm).toBe(0);
    expect(result.branchViolations).toEqual(['m']);
    expect(result.converged).toBe(false);
    expect(result.diagnosis.status).toBe('provenConstantConflict');
  });
  it('反復上限と時間上限を診断へ返す', () => {
    const { assembly, placements, targets } = boxes();
    expect(solveMates(assembly, targets, placements, { maxIterations: 1 }).diagnosis.status).toBe('iterationLimit');
    expect(solveMates(assembly, targets, placements, { maxTimeMs: 0 }).diagnosis.status).toBe('iterationLimit');
  });
  it('幾何の欠落を収束とせずskippedに残す', () => {
    const { assembly, placements } = boxes();
    const result = solveMates(assembly, new Map(), placements);
    expect(result.diagnosis.status).toBe('stalled');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('dangling');
  });
  it('抑制した合致は失敗とせず配置を保つ', () => {
    const { assembly, placements } = boxes();
    const result = solveMates({ ...assembly, mates: assembly.mates.map((m) => ({ ...m, suppressed: true })) }, new Map(), placements);
    expect(result.converged).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.placements).toEqual(placements);
  });
  it('抑制部品を固定の代わりにして他の部品を動かさない', () => {
    const { assembly, placements, targets } = boxes();
    const result = solveMates({ ...assembly, components: assembly.components.map((c) => ({ ...c, suppressed: c.id === 'ground' })) }, targets, placements);
    expect(result.converged).toBe(false);
    expect(result.skipped[0].reason).toBe('dangling');
    expect(result.placements).toEqual(placements);
  });
  it('非表示の部品は解く', () => {
    const { assembly, placements, targets } = boxes();
    const result = solveMates({ ...assembly, components: assembly.components.map((c) => ({ ...c, visible: false })) }, targets, placements);
    expect(movingPlacement(result).position[2]).toBeCloseTo(20, 10);
  });
  it('重複する面合致はrankを二重に数えない', () => {
    const { assembly, placements, targets } = boxes();
    const pair = targets.get('m');
    if (pair === undefined) throw new Error('対象が無い');
    const result = solveMates({ ...assembly, mates: [...assembly.mates, { ...assembly.mates[0], id: 'copy' }] },
      new Map(targets).set('copy', pair), placements);
    expect(result.converged).toBe(true);
    expect(result.diagnosis.components[0].rank).toBe(3);
  });
  it('大きな世界座標でも元の点間の距離が一致する', () => {
    const { assembly, placements, targets } = boxes(5);
    const shift: Vec3 = [1e8, -1e8, 1e8];
    const shifted = new Map([...placements].map(([id, p]) => [id, { ...p, position: addVec3(p.position, shift) }]));
    const pair = targets.get('m');
    if (pair === undefined) throw new Error('対象が無い');
    const result = solveMates(assembly, new Map([['m', { a: { ...pair.a, point: addVec3(pair.a.point, shift) },
      b: { ...pair.b, point: addVec3(pair.b.point, shift) } }]]), shifted);
    expect(result.converged).toBe(true);
    expect(movingPlacement(result).position[2]).toBe(1e8 + 25);
  });
  it('角度の許容をradで評価する', () => {
    const assembly = { ...createAssemblyDocument('角度'), components: [component('ground', true), component('moving')],
      mates: [mate('angle', 'angle', 'moving', 'ground', 60)] };
    const rotation = quaternionFromAxisAngle([0, 1, 0], 0.5);
    const placements = new Map([['ground', IDENTITY_PLACEMENT], ['moving', { ...IDENTITY_PLACEMENT, rotation }]]);
    const targets = new Map([['angle', { a: plane([0, 0, 0], rotateVector(rotation, [0, 0, 1])), b: plane([0, 0, 0]) }]]);
    const result = solveMates(assembly, targets, placements);
    const n = rotateVector(movingPlacement(result).rotation, [0, 0, 1]);
    expect(Math.abs(Math.acos(n[2]) - Math.PI / 3)).toBeLessThan(1e-9);
    expect(result.converged).toBe(true);
  });
  it('L₀=1でも長さ行を方向行と取り違えない', () => {
    const { assembly, placements, targets } = boxes(5);
    const result = solveMates(assembly, targets, placements, { characteristicLength: 1, lengthTolerance: 1e-10, angleTolerance: 1e-8 });
    expect(Math.abs(applyPlacementToPoint(movingPlacement(result), [0, 0, 0])[2] - 25)).toBeLessThan(1e-10);
    expect(result.converged).toBe(true);
  });
  it('円筒と平面の接線は方向と距離の両方を満たす', () => {
    const rotation = quaternionFromAxisAngle([0, 1, 0], 0.2);
    const assembly = { ...createAssemblyDocument('接線'), components: [component('ground', true), component('moving')],
      mates: [mate('tangent', 'tangent')] };
    const placements = new Map([['ground', IDENTITY_PLACEMENT], ['moving', { position: [8, 0, 0] as const, rotation }]]);
    const targets = new Map([['tangent', { a: axis([8, 0, 0], rotateVector(rotation, [0, 0, 1])),
      b: plane([0, 0, 0], [1, 0, 0]) }]]);
    const result = solveMates(assembly, targets, placements);
    const solved = movingPlacement(result);
    expect(Math.abs(rotateVector(solved.rotation, [0, 0, 1])[0])).toBeLessThan(1e-9);
    expect(Math.abs(solved.position[0] - 5)).toBeLessThan(1e-9);
    expect(result.diagnosis.components[0].rank).toBe(2);
    expect(result.converged).toBe(true);
  });
});
