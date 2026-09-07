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
import { applyMateIncrements, diagnoseMates, solveMates, type SolveMatesOptions, type SolveMatesOutcome } from './solveMates.js';

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

function diagnosisFixture(kind: MateKind = 'coincident', a = point([0, 0, 0]), b = point([0, 0, 0])) {
  return { assembly: { ...createAssemblyDocument('診断'), components: [component('ground', true), component('moving')],
    mates: [mate('m', kind)] }, targets: new Map([['m', { a, b }]]),
  placements: new Map([['ground', IDENTITY_PLACEMENT], ['moving', IDENTITY_PLACEMENT]]) };
}
function planeAxisFixture(normal: Vec3) {
  const opposite: Vec3 = [-normal[0], -normal[1], -normal[2]];
  const data = diagnosisFixture('coincident', plane([0, 0, 0], opposite), plane([0, 0, 0], normal));
  return { ...data, assembly: { ...data.assembly, mates: [...data.assembly.mates, mate('axis', 'concentric')] },
    targets: new Map(data.targets).set('axis', { a: axis([0, 0, 0]), b: axis([0, 0, 0]) }) };
}
function diagnoseFixture(data: ReturnType<typeof diagnosisFixture>, options: SolveMatesOptions = {}) {
  const outcome = solveMates(data.assembly, data.targets, data.placements, options);
  return { outcome, diagnosis: diagnoseMates(data.assembly, outcome) };
}

describe('P7タスク16の合致診断', () => {
  it('平面一致はrank3、あと3か所と最終残差を返す', () => {
    const data = boxes();
    const { outcome, diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components[0]).toMatchObject({ rank: 3, variables: 6, remainingDegreesOfFreedom: 3 });
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
    expect(diagnosis.messages).toContainEqual({ code: 'remainingDegreesOfFreedom', severity: 'info', mateIds: [], text: 'あと 3 か所決まっていません' });
    expect(diagnosis.rows.map((row) => row.residual)).toEqual(outcome.diagnosis.components[0].rows.map((row) => row.value));
    expect(diagnosis.rows.every((row) => row.satisfied)).toBe(true);
  });
  it('同心はrank4、軸方向と軸回転の2自由度を残す', () => {
    const { diagnosis } = diagnoseFixture(diagnosisFixture('concentric', axis([0, 0, 0]), axis([0, 0, 0])));
    expect(diagnosis.components[0].rank).toBe(4);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(2);
  });
  it('点一致はrank3、3自由度を残す', () => {
    const { diagnosis } = diagnoseFixture(diagnosisFixture());
    expect(diagnosis.components[0].rank).toBe(3);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
  });
  it('浮遊2部品の点一致は成分gauge6を一度だけ除く', () => {
    const data = diagnosisFixture();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: false }));
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components[0]).toMatchObject({ gauge: { removed: 6 }, variables: 6, rank: 3 });
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
  });
  it('独立した浮遊2組はgauge12と自由度6を成分ごとに集計する', () => {
    const data = diagnosisFixture();
    data.assembly.components = ['ground', 'moving', 'a', 'b'].map((id) => component(id));
    data.assembly.mates.push(mate('ab', 'coincident', 'a', 'b'));
    data.placements.set('a', IDENTITY_PLACEMENT).set('b', IDENTITY_PLACEMENT);
    data.targets.set('ab', { a: point([0, 0, 0]), b: point([0, 0, 0]) });
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components.map((c) => c.gauge.removed)).toEqual([6, 6]);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(6);
  });
  it('固定された成分と浮遊成分を別のgaugeで集計する', () => {
    const data = diagnosisFixture();
    data.assembly.components.push(component('a'), component('b'));
    data.assembly.mates.push(mate('ab', 'coincident', 'a', 'b'));
    data.placements.set('a', IDENTITY_PLACEMENT).set('b', IDENTITY_PLACEMENT);
    data.targets.set('ab', { a: point([0, 0, 0]), b: point([0, 0, 0]) });
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components.map((c) => c.gauge.removed)).toEqual([0, 6]);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(6);
  });
  it.each(['origin', 'driver'] as const)('上流の%s姿勢固定を再gaugeしない', (kind) => {
    const data = diagnosisFixture();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: false }));
    const { diagnosis } = diagnoseFixture(data, { anchors: new Map([['ground', kind]]) });
    expect(diagnosis.components[0]).toMatchObject({ gauge: { kind, removed: 0 }, variables: 6, rank: 3 });
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
  });
  it('component originを世界固定と誤認しない', () => {
    const data = diagnosisFixture();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: false }));
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components[0].gauge.kind).toBe('firstComponent');
  });
  it('固定部品と未接続の単独成分は現行gaugeを保持する', () => {
    const data = diagnosisFixture();
    data.assembly.mates = [];
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components[0]).toMatchObject({ gauge: { removed: 6 }, variables: 0, rank: 0 });
    expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
  });
  it('軸方向の法線を持つ面合致と同心は7行rank5になる', () => {
    const { diagnosis } = diagnoseFixture(planeAxisFixture([0, 0, 1]));
    expect(diagnosis.rows).toHaveLength(7);
    expect(diagnosis.components[0].rank).toBe(5);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(1);
  });
  it('45度傾いた法線では7行rank6、収束後にすべて決まったと表示する', () => {
    const { diagnosis } = diagnoseFixture(planeAxisFixture([Math.SQRT1_2, 0, Math.SQRT1_2]));
    expect(diagnosis.rows).toHaveLength(7);
    expect(diagnosis.components[0].rank).toBe(6);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
    expect(diagnosis.messages.some((m) => m.code === 'fullyConstrained')).toBe(true);
  });
  it('完全重複の平面合致は後続ID一つと従属3行を返す', () => {
    const data = boxes();
    data.assembly.mates.push({ ...data.assembly.mates[0], id: 'copy' });
    data.targets.set('copy', data.targets.get('m')!);
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.components[0].rank).toBe(3);
    expect(diagnosis.redundantRowCount).toBe(3);
    expect(diagnosis.redundantMateIds).toEqual(['copy']);
  });
  it('部分従属を合致丸ごとの重複と取り違えない', () => {
    const { diagnosis } = diagnoseFixture(planeAxisFixture([Math.SQRT1_2, 0, Math.SQRT1_2]));
    expect(diagnosis.redundantRowCount).toBe(1);
    expect(diagnosis.redundantMateIds).toEqual([]);
  });
  it('固定のみの充足行はnoVariableで矛盾ではない', () => {
    const data = diagnosisFixture();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: true }));
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.rows.map((r) => r.dependency)).toEqual(['noVariable', 'noVariable', 'noVariable']);
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(diagnosis.redundantMateIds).toEqual([]);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
  });
  it('固定のみの違反は既存の証明を保持し配置を変えない', () => {
    const data = boxes();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: true }));
    const { outcome, diagnosis } = diagnoseFixture(data);
    const before = structuredClone(outcome);
    expect(diagnosis.status).toBe('provenConstantConflict');
    expect(diagnosis.provenConflictMateIds).toEqual(['m']);
    expect(diagnoseMates(data.assembly, outcome).causeCandidates[0].kind).toBe('provenConflict');
    expect(outcome).toEqual(before);
    expect(outcome.placements).toEqual(data.placements);
  });
  it('残差0の定数分岐違反を証明済み候補から落とさない', () => {
    const data = boxes(0, true);
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: true }));
    data.targets.set('m', { a: plane([0, 0, 20], [0, 0, -1]), b: plane([0, 0, 20]) });
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.causeCandidates).toEqual([{ mateId: 'm', kind: 'provenConflict', normalizedResidual: 0 }]);
    expect(diagnosis.branchViolations).toEqual(['m']);
    expect(diagnosis.messages.some((m) => m.code === 'fullyConstrained')).toBe(false);
  });
  it('距離10と12は疑い2件であって証明済みではない', () => {
    const data = boxes();
    const pair = data.targets.get('m')!;
    data.assembly.mates = [mate('a', 'distance', 'moving', 'ground', 10), mate('b', 'distance', 'moving', 'ground', 12)];
    data.targets = new Map([['a', pair], ['b', pair]]);
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.status).toBe('suspectedConflict');
    expect(diagnosis.suspectedConflictMateIds).toEqual(['a', 'b']);
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(diagnosis.causeCandidates.every((c) => c.kind === 'suspectedConflict')).toBe(true);
    expect(diagnosis.messages.some((m) => m.code === 'provenConstantConflict')).toBe(false);
  });
  it('未収束成分で片方だけ充足しても合致丸ごとの冗長と表示しない', () => {
    const data = boxes();
    const pair = data.targets.get('m')!;
    data.assembly.mates = [mate('a', 'distance', 'moving', 'ground', 10), mate('b', 'distance', 'moving', 'ground', 30)];
    data.targets = new Map([['a', pair], ['b', pair]]);
    const { diagnosis } = diagnoseFixture(data, { maxIterations: 0 });
    expect(diagnosis.status).toBe('iterationLimit');
    expect(diagnosis.rows.find((row) => row.mateId === 'b')?.satisfied).toBe(true);
    expect(diagnosis.redundantRowCount).toBe(1);
    expect(diagnosis.redundantMateIds).toEqual([]);
  });
  it('反復0でrankが満ちても成功や矛盾にしない', () => {
    const data = planeAxisFixture([Math.SQRT1_2, 0, Math.SQRT1_2]);
    data.targets.set('m', { a: plane([0, 0, 1], [-Math.SQRT1_2, 0, -Math.SQRT1_2]), b: plane([0, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2]) });
    const { diagnosis } = diagnoseFixture(data, { maxIterations: 0 });
    expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
    expect(diagnosis.status).toBe('iterationLimit');
    expect(diagnosis.components[0].limit).toBe('iterations');
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(diagnosis.unresolvedMateIds).toContain('m');
    expect(diagnosis.messages.some((m) => m.code === 'fullyConstrained')).toBe(false);
  });
  it('60度を要求する平行方向の零微分は特異な停滞であって矛盾や重複ではない', () => {
    const data = diagnosisFixture('angle', plane([0, 0, 0]), plane([0, 0, 0]));
    data.assembly.mates = [mate('m', 'angle', 'moving', 'ground', 60)];
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.status).toBe('stalled');
    expect(diagnosis.rows[0].dependency).toBe('singular');
    expect(diagnosis.redundantMateIds).toEqual([]);
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(diagnosis.suspectedConflictMateIds).toEqual([]);
  });
  it('時間切れでrank未確定なら自由度をnullに保つ', () => {
    const { diagnosis } = diagnoseFixture(boxes(), { maxTimeMs: 0, now: () => 0 });
    expect(diagnosis.remainingDegreesOfFreedom).toBeNull();
    expect(diagnosis.components[0].rank).toBeNull();
    expect(diagnosis.components[0].limit).toBe('time');
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.messages.some((m) => m.code === 'timeLimit')).toBe(true);
  });
  it('606変数の全体上限でも固定同士の証明を残す', () => {
    const data = boxes();
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: true }));
    for (let i = 0; i < 101; i += 1) {
      data.assembly.components.push(component(`extra${i}`));
      data.placements.set(`extra${i}`, IDENTITY_PLACEMENT);
    }
    const { outcome, diagnosis } = diagnoseFixture(data);
    expect(diagnosis.limits[0]).toMatchObject({ scope: 'assembly', variables: 606, maximum: 600 });
    expect(diagnosis.remainingDegreesOfFreedom).toBeNull();
    expect(diagnosis.provenConflictMateIds).toEqual(['m']);
    expect(outcome.placements).toEqual(data.placements);
  });
  it('成分別上限を全体上限と別に返す', () => {
    const { diagnosis } = diagnoseFixture(boxes(), { maxComponentVariables: 5 });
    expect(diagnosis.limits).toEqual([{ scope: 'component', componentIds: ['moving'], variables: 6, maximum: 5 }]);
    expect(diagnosis.status).toBe('variableLimit');
    expect(diagnosis.remainingDegreesOfFreedom).toBeNull();
  });
  it('軸上点が無い旧幾何のmissingAxisを保持する', () => {
    const legacy: MateResidualTarget = { kind: 'cylinder', point: [1, 2, 3], direction: [0, 0, 1], radius: 5 };
    const { diagnosis } = diagnoseFixture(diagnosisFixture('concentric', legacy, axis([0, 0, 0])));
    expect(diagnosis.skipped[0].reason).toBe('missingAxis');
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.messages.some((m) => m.code === 'fullyConstrained')).toBe(false);
  });
  it('未対応jointを計算済みの自由度へ置き換えない', () => {
    const data = diagnosisFixture();
    const target = data.assembly.mates[0];
    const assembly = { ...data.assembly, joints: [{ id: 'joint', name: 'joint', kind: 'revolute' as const,
      a: target.a, b: target.b, minValue: null, maxValue: null, suppressed: false }] };
    const outcome = solveMates(assembly, data.targets, data.placements);
    const diagnosis = diagnoseMates(assembly, outcome);
    expect(diagnosis.unsupportedJointIds).toEqual(['joint']);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.status).toBe('stalled');
  });
  it.each([1e-3, 1, 1e6])('幾何と代表長と長さ許容を%g倍しても分類は同じ', (factor) => {
    const data = boxes(5 * factor);
    data.placements.set('moving', at([0, 0, 50 * factor]));
    data.targets.set('m', { a: plane([0, 0, 50 * factor], [0, 0, -1]), b: plane([0, 0, 20 * factor]) });
    const { diagnosis } = diagnoseFixture(data, { characteristicLength: 100 * factor, lengthTolerance: 1e-9 * factor });
    expect(diagnosis.status).toBe('converged');
    expect(diagnosis.components[0].rank).toBe(3);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
    expect(diagnosis.rows.every((row) => row.satisfied === true)).toBe(true);
  });
  it('同じ入力20回とtargetの逆順で結果が一致し入力を変更しない', () => {
    const data = planeAxisFixture([Math.SQRT1_2, 0, Math.SQRT1_2]);
    const before = structuredClone(data);
    const { outcome, diagnosis } = diagnoseFixture(data);
    const outcomeBefore = structuredClone(outcome);
    for (let i = 0; i < 20; i += 1) expect(diagnoseMates(data.assembly, outcome)).toEqual(diagnosis);
    expect(diagnoseFixture({ ...data, targets: new Map([...data.targets].reverse()) }).diagnosis).toEqual(diagnosis);
    expect(data).toEqual(before);
    expect(outcome).toEqual(outcomeBefore);
  });
  it('同じ残差の原因5件を文書順の一意な3件へ絞る', () => {
    const data = boxes();
    const pair = data.targets.get('m')!;
    data.assembly.components = data.assembly.components.map((c) => ({ ...c, fixed: true }));
    const ids = ['z', 'a', 'q', 'b', 'c'];
    data.assembly.mates = ids.map((id) => mate(id));
    data.targets = new Map(ids.map((id) => [id, pair]));
    const { diagnosis } = diagnoseFixture(data);
    expect(diagnosis.provenConflictMateIds).toEqual(ids);
    expect(diagnosis.causeCandidates.map((c) => c.mateId)).toEqual(ids.slice(0, 3));
    expect(diagnosis.messages.filter((m) => m.code === 'provenConstantConflict')).toHaveLength(3);
  });
  it.each(['missing', 'nonfinite', 'dimensions', 'rankMismatch'] as const)('最終線形化が%sなら診断未確定で矛盾を捏造しない', (damage) => {
    const data = diagnosisFixture();
    const { outcome } = diagnoseFixture(data);
    const source = outcome.diagnosis.components[0];
    const snapshot = source.linearization!;
    const matrix = snapshot.scaledJacobian.map((row) => [...row]);
    if (damage === 'nonfinite') matrix[0][0] = NaN;
    if (damage === 'dimensions') matrix[0].pop();
    if (damage === 'rankMismatch') for (const row of matrix) row.fill(0);
    const altered: SolveMatesOutcome = { ...outcome, diagnosis: { ...outcome.diagnosis, components: [{ ...source,
      linearization: damage === 'missing' ? undefined : { ...snapshot, scaledJacobian: matrix } }] } };
    const diagnosis = diagnoseMates(data.assembly, altered);
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.components[0].rank).toBe(source.rank);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
    expect(diagnosis.rows.every((row) => row.dependency === 'unknown')).toBe(true);
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(diagnosis.redundantMateIds).toEqual([]);
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
