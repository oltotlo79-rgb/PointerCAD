import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addVec3, type Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import {
  applyPlacementToPoint, IDENTITY_PLACEMENT, quaternionFromAxisAngle, rotateVector,
  type RigidPlacement,
} from '../placementMath.js';
import type { AssemblyComponent, Joint, JointKind, Mate, MateKind } from '../types.js';
import type { JointFrame, JointFramePair } from '../joints/jointFrames.js';
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

const JOINT_FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function jointEntry(id: string, kind: JointKind = 'ball', a = 'moving', b = 'ground'): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
    b: { kind: 'origin', componentId: b, element: 'origin' }, minValue: null, maxValue: null, suppressed: false };
}
function jointFixture(kind: JointKind = 'ball') {
  return { assembly: { ...createAssemblyDocument('joint'), components: [component('ground', true), component('moving')],
    joints: [jointEntry('j', kind)] }, targets: new Map<string, MateResidualTargetPair>(),
  placements: new Map<string, RigidPlacement>([['ground', IDENTITY_PLACEMENT], ['moving', IDENTITY_PLACEMENT]]),
  frames: new Map<string, JointFramePair>([['j', { a: JOINT_FRAME, b: JOINT_FRAME }]]) };
}

describe('P7-19 jointとmateの同一ソルバー・同一診断', () => {
  it.each([['revolute', 5, 1], ['slider', 5, 1], ['cylindrical', 4, 2], ['ball', 3, 3]] as const)('%sの並進と傾きを解き%d行・DOF%dで診断する', (kind, count, dof) => {
    const data = jointFixture(kind);
    data.placements.set('moving', { position: [2, 3, 4], rotation: quaternionFromAxisAngle([1, 2, 3], 0.2) });
    const before = structuredClone(data);
    const outcome = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    const diagnosis = diagnoseMates(data.assembly, outcome);
    expect(outcome.converged).toBe(true);
    expect(outcome.iterations).toBeGreaterThan(0);
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.rows).toEqual([]);
    expect(diagnosis.jointRows).toHaveLength(count);
    expect(diagnosis.jointRows?.every((row) => row.satisfied)).toBe(true);
    expect(diagnosis.components[0].rank).toBe(count);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(dof);
    expect(outcome.diagnosis.components[0].linearization?.rowSources).toEqual(Array.from({ length: count }, () => ({ kind: 'joint', id: 'j' })));
    expect(outcome.placements.get('ground')).toEqual(IDENTITY_PLACEMENT);
    expect(data).toEqual(before);
  });
  it('πのsliderを偽収束せず解析回転誤差で解く', () => {
    const data = jointFixture('slider');
    data.placements.set('moving', { ...IDENTITY_PLACEMENT, rotation: [0, 0, 1, 0] });
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    expect(Math.abs(movingPlacement(result).rotation[2])).toBeLessThan(5e-10);
    expect(diagnoseMates(data.assembly, result).jointRows?.every((r) => r.satisfied)).toBe(true);
  });
  it.each(['revolute', 'cylindrical'] as const)('%sの逆軸を取り付け点を保つ半回転で直す', (kind) => {
    const data = jointFixture(kind);
    data.frames.set('j', { a: { ...JOINT_FRAME, origin: [100, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
      b: { ...JOINT_FRAME, origin: [100, 0, 0] } });
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(true);
    expect(result.jointBranchViolations).toEqual([]);
    expect(result.diagnosis.components[0].result?.trace[0].linearSolver).toBe('branch');
    expect(applyPlacementToPoint(movingPlacement(result), [100, 0, 0])).toEqual([100, 0, 0]);
  });
  it('明示Mapなしは旧unsupported、空MapはmissingFrame', () => {
    const data = jointFixture();
    const old = solveMates(data.assembly, data.targets, data.placements);
    const opted = solveMates(data.assembly, data.targets, data.placements, { jointFrames: new Map() });
    expect(old.diagnosis.unsupportedJointIds).toEqual(['j']);
    expect(old.skippedJoints).toEqual([]);
    expect(opted.diagnosis.unsupportedJointIds).toEqual([]);
    expect(opted.skippedJoints?.map((r) => r.reason)).toEqual(['missingFrame']);
    expect(old.converged).toBe(false);
    expect(opted.converged).toBe(false);
    expect(diagnoseMates(data.assembly, opted).messages).toContainEqual({ code: 'skippedTarget', severity: 'warning',
      mateIds: [], jointIds: ['j'], text: 'ジョイントの取り付け位置と向きがまだ指定されていません。' });
  });
  it('固定同士のjoint残差は構造的矛盾、mateのIDへ混ぜない', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, fixed: true })) };
    data.placements.set('moving', at([0, 0, 2]));
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    const diagnosis = diagnoseMates(assembly, result);
    expect(result.diagnosis.status).toBe('provenConstantConflict');
    expect(result.diagnosis.constantConflicts).toEqual([]);
    expect(diagnosis.provenConflictJointIds).toEqual(['j']);
    expect(diagnosis.jointRows?.every((row) => row.dependency === 'noVariable')).toBe(true);
    expect(diagnosis.messages.filter((m) => m.code === 'provenConstantConflict')[0].jointIds).toEqual(['j']);
    expect(result.placements).toEqual(data.placements);
  });
  it('固定両端の逆軸は零残差でも証明済みの矛盾', () => {
    const data = jointFixture('revolute');
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, fixed: true })) };
    data.frames.set('j', { a: { ...JOINT_FRAME, y: [0, -1, 0], z: [0, 0, -1] }, b: JOINT_FRAME });
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.maxResidual).toBe(0);
    expect(result.diagnosis.constantJointConflicts).toEqual(['j']);
    expect(diagnoseMates(assembly, result).constraintCauseCandidates).toEqual([
      { constraint: { kind: 'joint', id: 'j' }, kind: 'provenConflict', normalizedResidual: 0 },
    ]);
  });
  it('mateとjointが同じIDでも行・冗長・原因を区別する', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, mates: [mate('j')] };
    data.targets.set('j', { a: point([0, 0, 0]), b: point([0, 0, 0]) });
    const outcome = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    const diagnosis = diagnoseMates(assembly, outcome);
    expect(outcome.converged).toBe(true);
    expect(diagnosis.rows).toHaveLength(3);
    expect(diagnosis.jointRows).toHaveLength(3);
    expect(diagnosis.components[0].rank).toBe(3);
    expect(diagnosis.redundantMateIds).toEqual([]);
    expect(diagnosis.redundantJointIds).toEqual(['j']);
    expect(diagnosis.redundantRowCount).toBe(3);
    expect(outcome.diagnosis.components[0].linearization?.rowSources).toEqual([
      ...Array.from({ length: 3 }, () => ({ kind: 'mate', id: 'j' })), ...Array.from({ length: 3 }, () => ({ kind: 'joint', id: 'j' })),
    ]);
  });
  it('5条件の原因候補はmate/joint合計で3件、証明・残差比・文書順を守る', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, fixed: true })),
      mates: [mate('same'), mate('m2')], joints: [jointEntry('same'), jointEntry('j2'), jointEntry('j3')] };
    const targets = new Map([['same', { a: point([0, 0, 1]), b: point([0, 0, 0]) }],
      ['m2', { a: point([0, 0, 2]), b: point([0, 0, 0]) }]]);
    const frames = new Map([['same', { a: { ...JOINT_FRAME, origin: [0, 0, 3] as const }, b: JOINT_FRAME }],
      ['j2', { a: { ...JOINT_FRAME, origin: [0, 0, 2] as const }, b: JOINT_FRAME }],
      ['j3', { a: { ...JOINT_FRAME, origin: [0, 0, 2] as const }, b: JOINT_FRAME }]]);
    const diagnosis = diagnoseMates(assembly, solveMates(assembly, targets, data.placements, { jointFrames: frames }));
    expect(diagnosis.constraintCauseCandidates?.map((c) => c.constraint)).toEqual([
      { kind: 'joint', id: 'same' }, { kind: 'mate', id: 'm2' }, { kind: 'joint', id: 'j2' },
    ]);
    expect(diagnosis.causeCandidates.map((c) => c.mateId)).toEqual(['m2']);
    expect(diagnosis.messages.filter((m) => m.code === 'provenConstantConflict')).toHaveLength(3);
    expect(diagnosis.provenConflictMateIds).toEqual(['same', 'm2']);
    expect(diagnosis.provenConflictJointIds).toEqual(['same', 'j2', 'j3']);
  });
  it('joint同士の完全重複は後続jointの全行を従属として示す', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, joints: [jointEntry('first'), jointEntry('second')] };
    const frames = new Map(assembly.joints.map((j) => [j.id, { a: JOINT_FRAME, b: JOINT_FRAME }]));
    const diagnosis = diagnoseMates(assembly, solveMates(assembly, data.targets, data.placements, { jointFrames: frames }));
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.components[0].rank).toBe(3);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(3);
    expect(diagnosis.jointRows?.map((r) => r.dependency)).toEqual([
      'independent', 'independent', 'independent', 'dependent', 'dependent', 'dependent',
    ]);
    expect(diagnosis.redundantJointIds).toEqual(['second']);
    expect(diagnosis.redundantRowCount).toBe(3);
  });
  it('面mateとballの一部の従属をjoint全体の冗長と誤報しない', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, mates: [mate('plane')] };
    data.targets.set('plane', { a: plane([0, 0, 0]), b: plane([0, 0, 0]) });
    const diagnosis = diagnoseMates(assembly, solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames }));
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.components[0].rank).toBe(5);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(1);
    expect(diagnosis.rows.map((r) => r.dependency)).toEqual(['independent', 'independent', 'independent']);
    expect(diagnosis.jointRows?.map((r) => r.dependency)).toEqual(['independent', 'independent', 'dependent']);
    expect(diagnosis.redundantJointIds).toEqual([]);
    expect(diagnosis.redundantMateIds).toEqual([]);
    expect(diagnosis.redundantRowCount).toBe(1);
  });
  it('5条件で証明を優先し、疑いと未解決は残差比・同率の文書順で絞る', () => {
    const ground = component('ground', true);
    const proof = jointEntry('proof', 'ball', 'ground', 'fixed');
    const suspectJoints = [jointEntry('suspect-a', 'ball', 'suspect'), jointEntry('suspect-b', 'ball', 'suspect')];
    const unresolvedJoints = [jointEntry('unresolved-b', 'ball', 'unresolved'), jointEntry('unresolved-a', 'ball', 'unresolved')];
    const proofAssembly = { ...createAssemblyDocument('proof'), components: [ground, component('fixed', true)], joints: [proof] };
    const suspectAssembly = { ...createAssemblyDocument('suspect'), components: [ground, component('suspect')], joints: suspectJoints };
    const unresolvedAssembly = { ...createAssemblyDocument('unresolved'), components: [ground, component('unresolved')], joints: unresolvedJoints };
    const frames = new Map<string, JointFramePair>([
      ['proof', { a: { ...JOINT_FRAME, origin: [1e-8, 0, 0] }, b: JOINT_FRAME }],
      ['suspect-a', { a: JOINT_FRAME, b: JOINT_FRAME }],
      ['suspect-b', { a: JOINT_FRAME, b: { ...JOINT_FRAME, origin: [2, 0, 0] } }],
      ...unresolvedJoints.map((j): [string, JointFramePair] => [j.id, { a: JOINT_FRAME, b: { ...JOINT_FRAME, origin: [1000, 0, 0] } }]),
    ]);
    const initial = new Map([['ground', IDENTITY_PLACEMENT], ['fixed', IDENTITY_PLACEMENT],
      ['suspect', at([3, 0, 0])], ['unresolved', IDENTITY_PLACEMENT]]);
    // 異なる停止状態を、実ソルバーの結果と実snapshotから組み合わせる。架空の行やJacobianは作らない。
    const proofResult = solveMates(proofAssembly, new Map(), initial, { jointFrames: frames });
    const suspectResult = solveMates(suspectAssembly, new Map(), initial, { jointFrames: frames });
    const unresolvedResult = solveMates(unresolvedAssembly, new Map(), initial, { jointFrames: frames, maxIterations: 0 });
    expect([proofResult.diagnosis.status, suspectResult.diagnosis.status, unresolvedResult.diagnosis.status])
      .toEqual(['provenConstantConflict', 'suspectedConflict', 'iterationLimit']);
    const assembly = { ...proofAssembly, components: [ground, component('fixed', true), component('suspect'), component('unresolved')],
      joints: [unresolvedJoints[0], proof, suspectJoints[0], unresolvedJoints[1], suspectJoints[1]] };
    const outcome: SolveMatesOutcome = { ...suspectResult, diagnosis: { ...proofResult.diagnosis,
      components: [...proofResult.diagnosis.components, ...suspectResult.diagnosis.components, ...unresolvedResult.diagnosis.components] } };
    const diagnosis = diagnoseMates(assembly, outcome);
    expect(diagnosis.provenConflictJointIds).toEqual(['proof']);
    expect(diagnosis.suspectedConflictJointIds).toEqual(['suspect-a', 'suspect-b']);
    expect(diagnosis.unresolvedJointIds).toEqual(['unresolved-b', 'unresolved-a']);
    expect(diagnosis.constraintCauseCandidates?.map((c) => [c.constraint.id, c.kind])).toEqual([
      ['proof', 'provenConflict'], ['unresolved-b', 'unresolved'], ['unresolved-a', 'unresolved'],
    ]);
    expect(diagnosis.constraintCauseCandidates?.[1].normalizedResidual).toBe(diagnosis.constraintCauseCandidates?.[2].normalizedResidual);
    expect(diagnosis.causeCandidates).toEqual([]);
  });
  it('浮いた2成分はそれぞれgauge6で、全体から一度だけ引かない', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: ['a', 'b', 'c', 'd'].map((id) => component(id)),
      joints: [jointEntry('ab', 'ball', 'a', 'b'), jointEntry('cd', 'slider', 'c', 'd')] };
    const placements = new Map(assembly.components.map((c) => [c.id, IDENTITY_PLACEMENT]));
    const frames = new Map(assembly.joints.map((j) => [j.id, { a: JOINT_FRAME, b: JOINT_FRAME }]));
    const result = solveMates(assembly, data.targets, placements, { jointFrames: frames });
    expect(result.diagnosis.components.map((c) => c.gauge.removed)).toEqual([6, 6]);
    expect(diagnoseMates(assembly, result).remainingDegreesOfFreedom).toBe(4);
  });
  it('mateとjointを跨ぐ連鎖が同じ成分で追従する', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: [...data.assembly.components, component('other')],
      mates: [mate('point', 'coincident', 'other', 'moving')],
      joints: [...data.assembly.joints, jointEntry('slide', 'slider', 'other', 'moving')] };
    data.placements.set('moving', at([2, 3, 4]));
    data.placements.set('other', at([5, 6, 7]));
    data.targets.set('point', { a: point([5, 6, 7]), b: point([2, 3, 4]) });
    data.frames.set('slide', { a: JOINT_FRAME, b: JOINT_FRAME });
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(true);
    expect(result.diagnosis.components).toHaveLength(1);
    expect(result.diagnosis.components[0].componentIds).toEqual(['moving', 'other']);
    expect(Math.hypot(...movingPlacement(result).position)).toBeLessThan(1e-9);
    expect(Math.hypot(...movingPlacement(result, 'other').position)).toBeLessThan(1e-9);
    expect(diagnoseMates(assembly, result).complete).toBe(true);
  });
  it('同IDのmateとjointの分岐を内部keyを漏らさず区別する', () => {
    const data = jointFixture('revolute');
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, fixed: true })), mates: [mate('j')] };
    data.targets.set('j', { a: point([0, 0, 0]), b: point([0, 0, 0]) });
    data.frames.set('j', { a: { ...JOINT_FRAME, y: [0, -1, 0], z: [0, 0, -1] }, b: JOINT_FRAME });
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.branchViolations).toEqual([]);
    expect(result.jointBranchViolations).toEqual(['j']);
    expect(result.diagnosis.components[0].result?.evaluation.branchViolations).toEqual([]);
    expect(result.diagnosis.components[0].constraintBranchViolations).toEqual([{ kind: 'joint', id: 'j' }]);
    expect(result.diagnosis.constantConflicts).toEqual([]);
    expect(result.diagnosis.constantJointConflicts).toEqual(['j']);
  });
  it.each(['origin', 'driver'] as const)('明示%sの6自由度anchorを成分ごとに扱う', (kind) => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, fixed: false })) };
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames, anchors: new Map([['ground', kind]]) });
    expect(result.diagnosis.components[0].gauge).toEqual({ kind, componentId: 'ground', removed: 0 });
    expect(result.diagnosis.components[0].variables).toBe(6);
  });
  it('hiddenは解き、suppressed jointはframeなしで外す', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, visible: false })),
      joints: [...data.assembly.joints, { ...jointEntry('suppressed'), suppressed: true }] };
    data.placements.set('moving', at([1, 2, 3]));
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(true);
    expect(result.skippedJoints).toEqual([]);
    expect(result.diagnosis.components[0].jointIds).toEqual(['j']);
    expect(Math.hypot(...movingPlacement(result).position)).toBeLessThan(1e-9);
  });
  it('抑制された部品を指すjointはdanglingを報告する', () => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: data.assembly.components.map((c) => ({ ...c, suppressed: c.id === 'moving' })) };
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.skippedJoints?.[0].reason).toBe('dangling');
    expect(result.converged).toBe(false);
  });
  it('joint成分上限はgauge前の変数数で判定してrank不明を保つ', () => {
    const data = jointFixture();
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames, maxComponentVariables: 5 });
    expect(result.diagnosis.status).toBe('variableLimit');
    expect(result.diagnosis.components[0].rank).toBeNull();
    expect(diagnoseMates(data.assembly, result).jointRows?.every((row) => row.dependency === 'unknown')).toBe(true);
    expect(result.placements).toEqual(data.placements);
  });
  it.each([100, 101])('%d可動部品の600/606全体上限をjoint追加でも変えない', (count) => {
    const data = jointFixture();
    const assembly = { ...data.assembly, components: [component('ground', true), ...Array.from({ length: count }, (_, i) => component(String(i)))],
      joints: [jointEntry('j', 'ball', '0')] };
    const placements = new Map(assembly.components.map((c) => [c.id, IDENTITY_PLACEMENT]));
    const result = solveMates(assembly, data.targets, placements, { jointFrames: data.frames });
    expect(result.diagnosis.limits.some((l) => l.scope === 'assembly')).toBe(count === 101);
    expect(result.converged).toBe(count === 100);
  });
  it.each(['missing', 'swapped'] as const)('混在snapshotのrowSourcesが%sなら分類を不明にする', (damage) => {
    const data = jointFixture();
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    const damaged: SolveMatesOutcome = { ...result, diagnosis: { ...result.diagnosis,
      components: result.diagnosis.components.map((c) => ({ ...c, linearization: c.linearization == null ? null
        : { ...c.linearization, rowSources: damage === 'missing' ? undefined
          : c.linearization.rowSources?.map((ref) => ({ ...ref, kind: 'mate' as const })) } })) } };
    const diagnosis = diagnoseMates(data.assembly, damaged);
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.jointRows?.every((row) => row.dependency === 'unknown' && row.satisfied === null)).toBe(true);
    expect(diagnosis.components[0].rank).toBe(3);
  });
  it('可動範囲はこの段階の残差でclampしない', () => {
    const data = jointFixture('slider');
    const assembly = { ...data.assembly, joints: [{ ...data.assembly.joints[0], minValue: expressionValueFromNumber(10), maxValue: expressionValueFromNumber(20) }] };
    const result = solveMates(assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(true);
    expect(movingPlacement(result).position[2]).toBe(0);
  });
  it.each(['iterations', 'time'] as const)('%s打切りをjointの証明済み矛盾と誤報しない', (limit) => {
    const data = jointFixture();
    data.placements.set('moving', at([1, 2, 3]));
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames,
      ...(limit === 'iterations' ? { maxIterations: 0 } : { maxTimeMs: 0, now: () => 0 }) });
    expect(result.diagnosis.status).toBe('iterationLimit');
    expect(result.diagnosis.constantJointConflicts).toEqual([]);
    expect(diagnoseMates(data.assembly, result).provenConflictJointIds).toEqual([]);
  });
  it.each([1e-3, 1, 1e6])('L=%dの尺度をsolve/診断で共有する', (length) => {
    const data = jointFixture();
    data.placements.set('moving', at([length * 0.01, length * 0.02, 0]));
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames, characteristicLength: length });
    expect(result.converged).toBe(true);
    expect(Math.hypot(...movingPlacement(result).position)).toBeLessThan(1e-9);
    expect(diagnoseMates(data.assembly, result).jointRows?.every((row) => row.satisfied)).toBe(true);
  });
  it.each([1e-3, 1, 1e6])('全長さ・frame原点・L・長さ許容を%d倍しても分類/rank/DOFが同じ', (scale) => {
    const scaled = (v: Vec3): Vec3 => [v[0] * scale, v[1] * scale, v[2] * scale];
    const data = jointFixture();
    const assembly = { ...data.assembly, joints: [jointEntry('ball'), jointEntry('slider', 'slider')] };
    const frames = new Map(assembly.joints.map((j) => [j.id, {
      a: { ...JOINT_FRAME, origin: scaled([3, 4, 5]) }, b: { ...JOINT_FRAME, origin: scaled([10, 20, 30]) },
    }]));
    const placements = new Map<string, RigidPlacement>([
      ['ground', { ...IDENTITY_PLACEMENT, position: scaled([100, 200, 300]) }],
      ['moving', { position: scaled([108, 214, 328]), rotation: quaternionFromAxisAngle([1, 2, 3], 0.1) }],
    ]);
    const result = solveMates(assembly, data.targets, placements, { jointFrames: frames,
      characteristicLength: 100 * scale, lengthTolerance: 1e-9 * scale, angleTolerance: 1e-9 });
    const diagnosis = diagnoseMates(assembly, result);
    expect({ converged: diagnosis.converged, complete: diagnosis.complete, rank: diagnosis.components[0].rank,
      dof: diagnosis.remainingDegreesOfFreedom, redundant: diagnosis.redundantJointIds,
      proven: diagnosis.provenConflictJointIds, suspected: diagnosis.suspectedConflictJointIds, unresolved: diagnosis.unresolvedJointIds })
      .toEqual({ converged: true, complete: true, rank: 6, dof: 0, redundant: [], proven: [], suspected: [], unresolved: [] });
    expect(diagnosis.jointRows).toHaveLength(8);
    expect(diagnosis.jointRows?.every((row) => row.satisfied)).toBe(true);
    const snapshot = result.diagnosis.components[0].linearization;
    result.diagnosis.components[0].jointRows?.forEach((row, index) => {
      const expected = row.measure === 'length' ? (1e-9 * scale) / (100 * scale) : 1e-9;
      expect(snapshot?.rowTolerances[index]).toBeCloseTo(expected, 20);
    });
    const position = movingPlacement(result).position;
    for (const [axis, value] of [107, 216, 325].entries()) expect(Math.abs(position[axis] / scale - value)).toBeLessThan(1e-9);
  });
  it.each(['short-rotation', 'overflow-norm', 'empty-origin', 'sparse-position'] as const)('%sで偽収束せず元配置を保持する', (kind) => {
    const data = jointFixture('slider');
    const position: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number, number] = [1, 0, 0, 1];
    if (kind === 'short-rotation') rotation.splice(1, 3);
    if (kind === 'overflow-norm') rotation.fill(1e308);
    if (kind === 'sparse-position') Reflect.deleteProperty(position, '1');
    if (kind === 'empty-origin') {
      const origin: [number, number, number] = [0, 0, 0];
      origin.splice(0, 3);
      data.frames.set('j', { a: { ...JOINT_FRAME, origin }, b: JOINT_FRAME });
    }
    data.placements.set('moving', { position, rotation });
    const before = structuredClone(data.placements);
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    expect(result.converged).toBe(false);
    expect(result.diagnosis.status).toBe('stalled');
    expect(result.diagnosis.unsupportedJointIds).toEqual([]);
    expect(result.skippedJoints?.map((r) => r.reason)).toEqual(['invalidFrame']);
    expect(diagnoseMates(data.assembly, result).complete).toBe(false);
    expect(result.placements).toEqual(before);
    expect(data.placements).toEqual(before);
  });
  it('20回とMap逆順で配置・trace・診断が完全一致する', () => {
    const data = jointFixture('slider');
    data.placements.set('moving', { position: [2, 3, 4], rotation: quaternionFromAxisAngle([1, 2, 3], 0.2) });
    const result = solveMates(data.assembly, data.targets, data.placements, { jointFrames: data.frames });
    const diagnosis = diagnoseMates(data.assembly, result);
    for (let i = 0; i < 20; i += 1) {
      const repeated = solveMates(data.assembly, data.targets, new Map([...data.placements].reverse()), { jointFrames: new Map([...data.frames].reverse()) });
      expect(repeated).toEqual(result);
      expect(diagnoseMates(data.assembly, repeated)).toEqual(diagnosis);
    }
  });
});

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
