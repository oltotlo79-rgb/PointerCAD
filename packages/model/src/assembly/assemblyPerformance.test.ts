/** P7 §2.13-1/2・§1.5-11。予算は20ms/300ms/2倍、厳密判定は統括の静かな窓。 */
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import { addVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { addComponent, createComponentFor } from './assemblyEdit.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { buildStandardPart, createStandardPartSource } from './standard/buildStandardPart.js';
import { buildMateResidualReport, prepareMateResiduals, type MateResidualTargetPair } from './constraints/mateResiduals.js';
import { applyMateIncrements, diagnoseMates, prepareMateDrag, solveDrivenJoint, solveMateDrag, solveMates } from './constraints/solveMates.js';
import { solveRigid, type RigidSolveInput } from './constraints/solveRigid.js';
import { collectMateVariables } from './constraints/mateVariables.js';
import {
  applyPlacementToPoint, IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement,
} from './placementMath.js';
import type { AssemblyComponent, Joint, JointKind, Mate } from './types.js';
import type { JointFrame, JointFramePair } from './joints/jointFrames.js';
import { buildJointResidualReport, prepareJointResiduals } from './joints/jointResiduals.js';

describe('P7-20 20部品の一時joint drive', () => {
  it('単一連結成分114変数を最大5反復で駆動し、全体中央値16ms以内', () => {
    const frame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const components: AssemblyComponent[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: String(i),
      source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: i === 0, visible: true, suppressed: false }));
    const joints: Joint[] = Array.from({ length: 19 }, (_, i) => ({ id: `drive-${i}`, name: `drive-${i}`, kind: 'slider',
      a: { kind: 'origin', componentId: String(i + 1), element: 'origin' },
      b: { kind: 'origin', componentId: String(i), element: 'origin' }, minValue: null, maxValue: null, suppressed: false }));
    const assembly = { ...createAssemblyDocument('20部品drive'), components, joints };
    const placements = new Map(components.map((c) => [c.id, IDENTITY_PLACEMENT]));
    const jointFrames = new Map(joints.map((j) => [j.id, { a: frame, b: frame }]));
    const targets = new Map<string, MateResidualTargetPair>();
    const request = { jointId: 'drive-0', coordinate: 'translation' as const, value: 15 };
    const run = () => solveDrivenJoint(assembly, targets, placements, request, { jointFrames, maxIterations: 5 });
    const check = (result: ReturnType<typeof run>) => {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(Math.abs(result.actual - 15)).toBeLessThan(1e-9);
      expect(result.outcome.iterations).toBeLessThanOrEqual(5);
      expect(result.outcome.diagnosis.components).toHaveLength(1);
      expect(result.outcome.diagnosis.components[0].variables).toBe(114);
      expect(result.outcome.diagnosis.components[0].jointRows).toHaveLength(95);
      expect(result.outcome.diagnosis.components[0].remainingDegreesOfFreedom).toBe(19);
    };
    expect(assembly.components).toHaveLength(20);
    expect(assembly.joints).toHaveLength(19);
    for (let i = 0; i < 3; i += 1) check(run());
    const samples: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const start = performance.now();
      const result = run();
      samples.push(performance.now() - start);
      check(result);
    }
    const medianMs = [...samples].sort((a, b) => a - b)[3];
    console.log('[P7-20 20part drive median]', JSON.stringify({ components: 20, joints: 19, variables: 114,
      maximumIterations: 5, warmups: 3, samples, medianMs, budgetMs: 16 }));
    expectWithinBudget(medianMs, 16, 'P7-20 20部品のjoint drive');
    expect([...placements.values()].every((placement) => placement === IDENTITY_PLACEMENT)).toBe(true);
  });
});

function fixture(groupCount = 1) {
  const size = 50 / groupCount;
  const components: AssemblyComponent[] = [];
  const placements = new Map<string, RigidPlacement>();
  const desired = new Map<string, Vec3>();
  for (let i = 0; i < 50; i += 1) {
    const id = String(i);
    const fixed = i % size === 0;
    const position: Vec3 = [(i % size) * 20, Math.floor(i / size) * 100, 0];
    desired.set(id, position);
    components.push({ id, name: id, source: { kind: 'part', partRef: 'box' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false });
    placements.set(id, fixed ? { ...IDENTITY_PLACEMENT, position } : {
      position: addVec3(position, [Math.sin(i) * 0.1, Math.cos(i) * 0.1, (i % 3) * 0.05]),
      rotation: quaternionFromAxisAngle([1, 2, 3], Math.sin(i) * 0.001),
    });
  }
  const mates: Mate[] = [];
  const targets = new Map<string, MateResidualTargetPair>();
  for (let group = 0; group < groupCount; group += 1) {
    for (let k = 0; k < 150 / groupCount; k += 1) {
      const layer = Math.floor(k / size);
      const a = String(group * size + k % size);
      const b = String(group * size + (k % size + 1 + layer * 7) % size);
      const id = `${group}:${k}`;
      const pa = placements.get(a);
      const pb = placements.get(b);
      const da = desired.get(a);
      const db = desired.get(b);
      if (pa === undefined || pb === undefined || da === undefined || db === undefined) throw new Error('検査用の配置が無い');
      const pin: Vec3 = layer === 0 ? [0, 0, 0] : layer === 1 ? [0, 10, 0] : [0, 0, 10];
      const world = addVec3(da, pin);
      mates.push({ id, name: id, kind: 'coincident', suppressed: false, flipped: false,
        a: { kind: 'origin', componentId: a, element: 'origin' },
        b: { kind: 'origin', componentId: b, element: 'origin' } });
      targets.set(id, {
        a: { kind: 'point', direction: null, radius: null, point: applyPlacementToPoint(pa, pin) },
        b: { kind: 'point', direction: null, radius: null, point: applyPlacementToPoint(pb, subVec3(world, db)) },
      });
    }
  }
  return { assembly: { ...createAssemblyDocument('性能'), components, mates }, placements, targets };
}

/** 同じ幾何・初期値・尺度・固定を使って、一括と分割の線形解法の費用だけを比較する。 */
function driver(data: ReturnType<typeof fixture>, group?: number): RigidSolveInput<ReadonlyMap<string, RigidPlacement>> {
  const ids = group === undefined ? null : new Set(data.assembly.components
    .slice(group * 25, group * 25 + 25).map((component) => component.id));
  const assembly = { ...data.assembly, components: data.assembly.components.filter((component) => ids === null || ids.has(component.id)),
    mates: data.assembly.mates.filter((mate) => ids === null || ids.has(mate.a.componentId)) };
  const variables = collectMateVariables(assembly);
  const prepared = prepareMateResiduals({ mates: assembly.mates, targets: data.targets, placements: data.placements });
  expect(prepared.skipped).toEqual([]);
  return { initial: data.placements,
    variables: variables.variables.map((variable) => variable.axis.startsWith('t') ? 'length' : 'angle'),
    retract: (base, increments) => applyMateIncrements(base, variables, increments),
    evaluate: (base, increments) => {
      const report = buildMateResidualReport({ mates: prepared.mates, placements: base, variableSet: variables, increments,
        characteristicLength: 100 });
      return { rows: report.rows.map((row) => ({ ...row, unit: 'length' as const })),
        branchViolations: report.branchViolations, valid: report.skipped.length === 0 };
    }, options: { maxIterations: 1, characteristicLength: 100 } };
}

/** JITを暖め、7回の中央値。準備/検査のexpectは測定区間の外。 */
function median(action: () => void, warmups = 3): number {
  for (let i = 0; i < warmups; i += 1) action();
  const times: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    action();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[3];
}

/**
 * 相対比較は同じ時間帯で測る。一括の測定を終えてから分割を測ると、短い負荷変動を
 * 解法の差と取り違える。ABBA順で各16回暖め、各32回の中央値を比べる。
 * 両方式の先行/後行回数を等しくし、測定値の除外や合否による再試行はしない。
 */
function pairedMedians(first: () => void, second: () => void, now = () => performance.now()) {
  for (let warmup = 0; warmup < 8; warmup += 1) {
    first(); second(); second(); first();
  }
  const firstTimes: number[] = [];
  const secondTimes: number[] = [];
  const sample = (action: () => void, times: number[]): void => {
    const start = now();
    action();
    times.push(now() - start);
  };
  for (let round = 0; round < 16; round += 1) {
    sample(first, firstTimes); sample(second, secondTimes);
    sample(second, secondTimes); sample(first, firstTimes);
  }
  const middle = (times: readonly number[]): number => {
    const sorted = [...times].sort((a, b) => a - b);
    return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  };
  return { first: middle(firstTimes), second: middle(secondTimes), firstTimes, secondTimes };
}

describe('相対性能の測定', () => {
  it.each([[8, 10], [10, 8]] as const)('負荷が単調増加しても真の所要差 %i / %i を保つ', (firstCost, secondCost) => {
    let clock = 0;
    let calls = 0;
    const action = (cost: number): void => { calls += 1; clock += cost + calls / 10; };
    const measured = pairedMedians(() => action(firstCost), () => action(secondCost), () => clock);
    expect(measured.first - measured.second).toBeCloseTo(firstCost - secondCost, 10);
    expect(measured.firstTimes).toHaveLength(32);
    expect(measured.secondTimes).toHaveLength(32);
    expect(calls).toBe(96);
  });
});

describe('P7-32 規格部品を1つ置く性能', () => {
  const cases = [
    ['六角ボルト M8', 'hexBolt', 'M8', { length: '30' }],
    ['六角ナット M8', 'hexNut', 'M8', {}],
    ['平座金 M8', 'plainWasher', 'M8', {}],
    ['ばね座金 M8', 'springWasher', 'M8', {}],
    ['六角穴付きボルト M8', 'socketHeadCapScrew', 'M8', { length: '30' }],
    ['十字穴付きなべ小ねじ M8', 'panHeadScrew', 'M8', { length: '30' }],
    ['深溝玉軸受 6000', 'deepGrooveBallBearing', '6000', {}],
    ['等辺山形鋼 L50×50×6', 'equalAngle', 'L 50×50×6', { length: '1000' }],
  ] as const;

  it.each(cases)('%sは500ms以内', (label, catalog, size, options) => {
    let placed = createAssemblyDocument('規格部品性能');
    const elapsed = median(() => {
      const part = buildStandardPart(catalog, size, options);
      if (part === null) throw new Error(`${label}を組めません。`);
      const assembly = createAssemblyDocument('規格部品性能');
      placed = addComponent(assembly, createComponentFor(
        assembly, createStandardPartSource(catalog, size, options), { partName: part.name },
      ));
    });
    expect(placed.components).toHaveLength(1);
    console.log(`[P7-32性能] ${label}: ${elapsed.toFixed(3)} ms / 500 ms`);
    expectWithinBudget(elapsed, 500, `規格部品を置く: ${label}`);
  });
});

describe('合致の性能(P7、50部品/150合致)', () => {
  it('最終solve結果の診断は200ms以内', () => {
    const data = fixture();
    const solved = solveMates(data.assembly, data.targets, data.placements);
    const diagnosis = diagnoseMates(data.assembly, solved);
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.converged).toBe(true);
    expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
    expect(diagnosis.rows).toHaveLength(450);
    const elapsed = median(() => { diagnoseMates(data.assembly, solved); });
    console.log(`[P7性能] 診断50部品150合致: ${elapsed.toFixed(3)} ms / 200 ms`);
    expectWithinBudget(elapsed, 200, '合致診断50部品150合致');
  });
  it('解き直しと表示用診断を合わせて500ms以内', () => {
    const data = fixture();
    const calculate = () => diagnoseMates(data.assembly, solveMates(data.assembly, data.targets, data.placements));
    expect(calculate().complete).toBe(true);
    const elapsed = median(() => { calculate(); }, 1);
    console.log(`[P7性能] 解き直しと診断50部品150合致: ${elapsed.toFixed(3)} ms / 500 ms`);
    expectWithinBudget(elapsed, 500, '合致解き直しと診断50部品150合致');
  });
  it('1反復は20ms以内', () => {
    const data = fixture();
    const input = driver(data);
    expect(data.assembly.components).toHaveLength(50);
    expect(data.assembly.mates).toHaveLength(150);
    expect(input.variables).toHaveLength(294);
    const check = solveRigid(input);
    expect(check.iterations).toBe(1);
    expect(check.trace.some((entry) => entry.accepted)).toBe(true);
    const elapsed = median(() => { solveRigid(input); });
    console.log(`[P7性能] 1反復50部品150合致: ${elapsed.toFixed(3)} ms / 20 ms`);
    expectWithinBudget(elapsed, 20, '合致1反復50部品150合致');
  });
  it('準備・成分分割・rank診断を含む解き直しは300ms以内', () => {
    const data = fixture();
    const check = solveMates(data.assembly, data.targets, data.placements);
    expect(check.converged).toBe(true);
    expect(check.maxResidual).toBeLessThan(1e-9);
    expect(check.iterations).toBeGreaterThanOrEqual(1);
    expect(check.iterations).toBeLessThanOrEqual(8);
    const elapsed = median(() => { solveMates(data.assembly, data.targets, data.placements); }, 1);
    console.log(`[P7性能] 解き直し50部品150合致: ${elapsed.toFixed(3)} ms / 300 ms (${check.iterations}反復)`);
    expectWithinBudget(elapsed, 300, '合致解き直し50部品150合致');
  });
  it('同じ50部品を25部品ずつ2成分で解いても一括より遅くない(比は記録)', () => {
    const data = fixture(2);
    const whole = driver(data);
    const first = driver(data, 0);
    const second = driver(data, 1);
    expect(first.variables.length + second.variables.length).toBe(whole.variables.length);
    const one = solveRigid(whole);
    const a = solveRigid(first);
    const b = solveRigid(second);
    expect(one.iterations).toBe(1);
    expect(a.iterations).toBe(1);
    expect(b.iterations).toBe(1);
    expect(Math.abs(one.residualNorm - Math.hypot(a.residualNorm, b.residualNorm))).toBeLessThan(1e-9);
    const measured = pairedMedians(() => { solveRigid(whole); }, () => { solveRigid(first); solveRigid(second); });
    const unsplit = measured.first;
    const split = measured.second;
    console.log('[P7性能] 成分分割の全測定値(ms):', JSON.stringify({ unsplit: measured.firstTimes, split: measured.secondTimes }));
    console.log(`[P7性能] 成分分割: 一括 ${unsplit.toFixed(3)} ms / 分割 ${split.toFixed(3)} ms = ${(unsplit / split).toFixed(3)} 倍 (見積もり 2 倍、実測を記録)`);
    expectWithinBudget(split, unsplit, '25部品×2成分は50部品一括より遅くない');
  });
});

/** 既知の整合姿勢から局所frameを作り、初期姿勢だけ摂動する。50/150/575は固定。 */
function jointFixture() {
  const base = fixture();
  const joints: Joint[] = [];
  const frames = new Map<string, JointFramePair>();
  const frame = (origin: Vec3): JointFrame => ({ origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  for (let k = 0; k < 150; k += 1) {
    const layer = Math.floor(k / 50), i = k % 50, j = (i + 1 + layer * 7) % 50;
    const a = String(i), b = String(j), id = `joint:${k}`;
    const kind: JointKind = k < 75 ? 'ball' : k < 100 ? 'revolute' : k < 125 ? 'slider' : 'cylindrical';
    const pin: Vec3 = layer === 0 ? [0, 0, 0] : layer === 1 ? [0, 10, 0] : [0, 0, 10];
    joints.push({ id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
      b: { kind: 'origin', componentId: b, element: 'origin' }, minValue: null, maxValue: null, suppressed: false });
    frames.set(id, { a: frame(pin), b: frame(addVec3(pin, [(i - j) * 20, 0, 0])) });
  }
  return { assembly: { ...base.assembly, mates: [], joints }, placements: base.placements, frames };
}

function jointDriver(data: ReturnType<typeof jointFixture>): RigidSolveInput<ReadonlyMap<string, RigidPlacement>> {
  const variableSet = collectMateVariables(data.assembly);
  const prepared = prepareJointResiduals({ joints: data.assembly.joints, frames: data.frames, placements: data.placements });
  expect(prepared.skipped).toEqual([]);
  return { initial: data.placements, variables: variableSet.variables.map((v) => v.axis.startsWith('t') ? 'length' : 'angle'),
    retract: (base, step) => applyMateIncrements(base, variableSet, step),
    evaluate: (base, increments) => {
      const report = buildJointResidualReport({ joints: prepared.joints, placements: base, variableSet, increments, characteristicLength: 100 });
      return { rows: report.rows.map((row) => ({ ...row, unit: row.measure === 'length' ? 'length' as const : 'angle' as const,
        ...(row.measure === 'rotation' ? { tolerance: 1e-9 } : {}) })), valid: report.skipped.length === 0, branchViolations: report.branchViolations };
    }, options: { maxIterations: 1, characteristicLength: 100 } };
}

/** 全7sampleを保持し、sampleごとの結果の検査は計測区間の後で行う。 */
function jointMedian<T>(action: () => T, check: (outcome: T) => void) {
  for (let i = 0; i < 3; i += 1) action();
  const samples: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    const outcome = action();
    samples.push(performance.now() - start);
    check(outcome);
  }
  return { samples, median: [...samples].sort((a, b) => a - b)[3] };
}

describe('P7-19の混在joint性能(50部品/150joint/575行)', () => {
  it('1反復は20ms以内', () => {
    const data = jointFixture(), input = jointDriver(data);
    expect(data.assembly.components).toHaveLength(50);
    expect(data.assembly.components.filter((c) => c.fixed)).toHaveLength(1);
    expect(data.assembly.joints).toHaveLength(150);
    expect(['ball', 'revolute', 'slider', 'cylindrical'].map((kind) => data.assembly.joints.filter((j) => j.kind === kind).length)).toEqual([75, 25, 25, 25]);
    expect(input.variables).toHaveLength(294);
    const measured = jointMedian(() => solveRigid(input), (result) => {
      expect(result.iterations).toBe(1);
      expect(result.evaluation.rows).toHaveLength(575);
      expect(result.trace.some((entry) => entry.accepted)).toBe(true);
    });
    console.log('[P7-19性能] 1反復/20ms', JSON.stringify(measured));
    expectWithinBudget(measured.median, 20, 'joint1反復50部品150条件575行');
  });
  it('準備・成分分割・rankを含むsolveは300ms以内', () => {
    const data = jointFixture();
    const measured = jointMedian(() => solveMates(data.assembly, new Map(), data.placements, { jointFrames: data.frames }), (outcome) => {
      expect(outcome.converged).toBe(true);
      expect(outcome.diagnosis.components).toHaveLength(1);
      expect(outcome.diagnosis.components[0].rank).toBe(294);
      expect(outcome.diagnosis.components[0].jointRows).toHaveLength(575);
      expect(outcome.iterations).toBeGreaterThanOrEqual(1);
      expect(outcome.iterations).toBeLessThanOrEqual(8);
    });
    console.log('[P7-19性能] solve/300ms', JSON.stringify(measured));
    expectWithinBudget(measured.median, 300, 'joint解き直し50部品150条件575行');
  });
  it('最終snapshotの診断は200ms以内', () => {
    const data = jointFixture();
    const outcome = solveMates(data.assembly, new Map(), data.placements, { jointFrames: data.frames });
    expect(outcome.converged).toBe(true);
    const measured = jointMedian(() => diagnoseMates(data.assembly, outcome), (diagnosis) => {
      expect(diagnosis.complete).toBe(true);
      expect(diagnosis.jointRows).toHaveLength(575);
      expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
    });
    console.log('[P7-19性能] 診断/200ms', JSON.stringify(measured));
    expectWithinBudget(measured.median, 200, 'joint診断50部品150条件575行');
  });
  it('solveと表示用診断の合計は500ms以内', () => {
    const data = jointFixture();
    const measured = jointMedian(() => diagnoseMates(data.assembly,
      solveMates(data.assembly, new Map(), data.placements, { jointFrames: data.frames })), (diagnosis) => {
      expect(diagnosis.converged).toBe(true);
      expect(diagnosis.complete).toBe(true);
      expect(diagnosis.remainingDegreesOfFreedom).toBe(0);
      expect(diagnosis.jointRows?.every((r) => r.satisfied)).toBe(true);
    });
    console.log('[P7-19性能] solve+診断/500ms', JSON.stringify(measured));
    expectWithinBudget(measured.median, 500, 'joint解き直しと診断50部品150条件575行');
  });
});

/** Real movable components: planar translation, floating group, and offset cylindrical rotation. */
function dragFixture(mode: 'fixed' | 'floating' | 'rotation', normal = false, count = 20, spacing = 20, angle = 0.02) {
  const components = Array.from({ length: count }, (_, index): AssemblyComponent => ({ id: String(index), name: String(index),
    source: { kind: 'part', partRef: 'box' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: index === 0 && mode !== 'floating', visible: true, suppressed: false }));
  const placements = new Map<string, RigidPlacement>(components.map((c, index) => [c.id, {
    ...IDENTITY_PLACEMENT, position: mode === 'rotation' ? [10, 0, index * spacing] : [index * spacing, 0, 0],
  }]));
  const mates: Mate[] = [];
  const targets = new Map<string, MateResidualTargetPair>();
  for (let i = 1; i < count; i += 1) {
    const id = String(i);
    mates.push({ id, name: id, kind: mode === 'rotation' ? 'concentric' : 'coincident',
      a: { kind: 'origin', componentId: String(i), element: 'origin' },
      b: { kind: 'origin', componentId: String(i - 1), element: 'origin' }, flipped: false, suppressed: false });
    targets.set(id, mode === 'rotation' ? {
      a: { kind: 'cylinder', point: [1, 2, 3], axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 10 },
      b: { kind: 'cylinder', point: [4, 5, 6], axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 10 },
    } : {
      a: { kind: 'plane', point: [i * spacing / 2, 0, 0], direction: [0, 0, -1], radius: null },
      b: { kind: 'plane', point: [i * spacing / 2, 0, 0], direction: [0, 0, 1], radius: null },
    });
  }
  const target: Vec3 = mode === 'rotation' ? [10 * Math.cos(angle), 10 * Math.sin(angle), (count - 1) * spacing + 10]
    : [(count - 1) * spacing + 10, 2, normal || mode === 'floating' ? 10 : 0];
  return { assembly: { ...createAssemblyDocument('20 component drag'), components, mates }, placements, targets, target };
}

describe('P7-18 20部品の一時位置目標（通常測定、UIのFPSとは別）', () => {
  it.each([0.1, 100, 1e5])('L=%s: 2/5/10/20部品×基点距離×回転量で5反復hard成立と実移動を固定する', (characteristicLength) => {
    const measurements: unknown[] = [];
    for (const count of [2, 5, 10, 20]) {
      for (const spacing of [1, 20, 100]) {
        for (const mode of ['fixed', 'floating', 'rotation'] as const) {
          for (const angle of mode === 'rotation' ? [0.001, 0.02, 0.1] : [0]) {
            const data = dragFixture(mode, mode === 'fixed', count, spacing, angle);
            const id = String(count - 1);
            const ready = prepareMateDrag(data.assembly, data.targets, data.placements, id, { characteristicLength });
            if (!ready.ok) throw new Error(ready.reason);
            const result = solveMateDrag(ready.drag, data.target, { phase: 'frame' });
            const label = JSON.stringify({ characteristicLength, count, spacing, mode, angle });
            const after = result.placements.get(id), before = data.placements.get(id);
            expect.soft(result.hardSatisfied, label).toBe(true);
            expect.soft(result.counts.totalIterations, label).toBeLessThanOrEqual(5);
            expect.soft(after?.position, label).not.toEqual(before?.position);
            measurements.push({ characteristicLength, count, spacing, mode, angle, stop: result.stop, counts: result.counts,
              moved: JSON.stringify(after?.position) !== JSON.stringify(before?.position),
              lastProjection: result.trace.filter((entry) => entry.phase === 'projection').at(-1)?.record });
          }
        }
      }
    }
    console.log('[P7-18 lever sweep]', JSON.stringify(measurements));
  });
  it.each([
    ['fixed', false], ['fixed', true], ['floating', false], ['rotation', false],
  ] as const)('%s normal=%s: 選別・pin・soft/hard・overlayを16ms以内', (mode, normal) => {
    const data = dragFixture(mode, normal);
    const calculate = () => {
      const preparation = prepareMateDrag(data.assembly, data.targets, data.placements, '19');
      if (!preparation.ok) throw new Error(preparation.reason);
      const outcome = solveMateDrag(preparation.drag, data.target, { phase: 'frame' });
      // This is the model overlay consumed by 18b. Include copying every changed component.
      return { outcome, overlay: new Map(outcome.placements) };
    };
    const counts: unknown[] = [];
    const measured = jointMedian(calculate, ({ outcome, overlay }) => {
      expect(outcome.hardSatisfied).toBe(true);
      expect(outcome.counts.totalIterations).toBeGreaterThan(0);
      expect(outcome.counts.totalIterations).toBeLessThanOrEqual(5);
      // The damped drag system must stay on the bounded normal-equation path by default.
      // Falling back to an augmented QR matrix here regresses a 20-part frame past 16ms.
      expect(outcome.counts.qrFallbacks).toBe(0);
      // At most one rejected soft trial plus one solve per bounded iteration.
      expect(outcome.counts.linearTrials).toBeLessThanOrEqual(6);
      expect(outcome.variableCount).toBe(mode === 'floating' ? 120 : 114);
      const before = data.placements.get('19'), after = overlay.get('19');
      if (before === undefined || after === undefined) throw new Error('missing performance placement');
      expect(after.position).not.toEqual(before.position);
      expect(outcome.driverSquaredError).toBeLessThan(data.target.reduce((sum, value, axis) => sum + (value - before.position[axis]) ** 2, 0));
      if (mode === 'fixed') expect(Math.abs(after.position[2])).toBeLessThan(1e-9);
      if (mode === 'rotation') expect(after.rotation).not.toEqual(before.rotation);
      counts.push(outcome.counts);
    });
    console.log('[P7-18性能] 20部品frame/16ms', JSON.stringify({ mode, normal, ...measured, maximum: Math.max(...measured.samples), counts }));
    expectWithinBudget(measured.median, 16, `20部品drag ${mode} normal=${normal}`);
  });
});
