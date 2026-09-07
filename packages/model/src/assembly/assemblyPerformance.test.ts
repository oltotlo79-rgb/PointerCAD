/** P7 §2.13-1/2・§1.5-11。予算は20ms/300ms/2倍、厳密判定は統括の静かな窓。 */
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import { addVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { buildMateResidualReport, prepareMateResiduals, type MateResidualTargetPair } from './constraints/mateResiduals.js';
import { applyMateIncrements, solveMates } from './constraints/solveMates.js';
import { solveRigid, type RigidSolveInput } from './constraints/solveRigid.js';
import { collectMateVariables } from './constraints/mateVariables.js';
import {
  applyPlacementToPoint, IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement,
} from './placementMath.js';
import type { AssemblyComponent, Mate } from './types.js';

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

describe('合致の性能(P7、50部品/150合致)', () => {
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
  it('同じ50部品を25部品ずつ2成分で解くと2倍以上速い', () => {
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
    const unsplit = median(() => { solveRigid(whole); });
    const split = median(() => { solveRigid(first); solveRigid(second); });
    console.log(`[P7性能] 成分分割: 一括 ${unsplit.toFixed(3)} ms / 分割 ${split.toFixed(3)} ms = ${(unsplit / split).toFixed(3)} 倍 (必要2倍)`);
    expectWithinBudget(split, unsplit / 2, '25部品×2成分は50部品一括の半分以内');
  });
});
