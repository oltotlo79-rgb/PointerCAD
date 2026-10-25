import { expressionValueFromNumber } from '@pointercad/expression';
import { DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { IDENTITY_PLACEMENT, type RigidPlacement } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { resolveConstrainedAssembly } from '../resolveConstrainedAssembly.js';
import { createEmptyPartDocument } from '../../index.js';
import { EMPTY_PART_LIBRARY } from '../partLibrary.js';
import type { AssemblyComponent, Joint, JointKind, Mate } from '../types.js';
import type { JointFramePair } from '../joints/jointFrames.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { MateResidualTargetPair } from './mateResiduals.js';
import { matrixRank, qrDecomposition } from '../../sketch/constraints/solve.js';
import { describe, expect, it } from 'vitest';
import {
  addComponent, createAssemblyDocument, createComponentFor, resolveAssembly, type AssemblyDocument, type JointFrame,
} from '../../index.js';
import { RigidWorkSequence, runCooperative } from './cooperativeRigid.js';
import { diagnoseMates, diagnoseMatesSteps, solveMates, solveMatesSteps, solveDrivenJoint, solveDrivenJointSteps, type SolveDrivenJointOutcome, type SolveMatesOptions, type SolveMatesOutcome } from './solveMates.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from './solveRigid.js';

const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function fixture() {
  let document: AssemblyDocument = createAssemblyDocument('cooperative');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  const a = document.components[0].id, b = document.components[1].id;
  document = { ...document, joints: [{ id: 'joint-1', name: 'joint1', kind: 'revolute',
    a: { kind: 'origin', componentId: a, element: 'z' },
    b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false }] };
  const placements = resolveAssembly(document).placements;
  return {
    document, placements, targets: new Map<string, never>(),
    request: { jointId: 'joint-1', coordinate: 'angle' as const, value: 30, referenceAngle: 0 },
    options: { jointFrames: new Map([['joint-1', { a: FRAME, b: FRAME }]]) },
  };
}

function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? [...item.entries()] : item);
}

describe('task110 cooperative rigid drive steps', () => {
  it('drained with the unlimited budget never yields and equals the synchronous drive exactly', () => {
    const { document, placements, targets, request, options } = fixture();
    const expected = solveDrivenJoint(document, targets, placements, request, options);
    expect(expected.ok).toBe(true);
    const steps = solveDrivenJointSteps(document, targets, placements, request, options, UNLIMITED_RIGID_WORK);
    let points = 0;
    let next = steps.next();
    while (next.done !== true) {
      points += 1;
      next = steps.next();
    }
    expect(points).toBe(0);
    expect(next.value).toEqual(expected);
  });

  it.each(['assembly', 'factorization', 'residual'] as const)(
    'stopping at the first %s point after real progress publishes nothing and a later full run still succeeds',
    (phase) => {
      const { document, placements, targets, request, options } = fixture();
      const documentBefore = snapshot(document);
      const placementsBefore = snapshot(placements);
      const steps = solveDrivenJointSteps(document, targets, placements, request, options, { units: 1 });
      const seen: RigidWorkPoint[] = [];
      let stopped: RigidWorkPoint | null = null;
      for (let next = steps.next(); next.done !== true; next = steps.next()) {
        seen.push(next.value);
        if (next.value.phase === phase && next.value.done > 0) {
          stopped = next.value;
          break;
        }
      }
      expect(stopped).not.toBeNull();
      expect(seen.length).toBeGreaterThan(0);
      for (let index = 1; index < seen.length; index += 1) expect(seen[index].done).toBeGreaterThanOrEqual(seen[index - 1].done);
      // The abandoned generator has changed nothing outside itself: no outcome, inputs byte-identical.
      expect(snapshot(document)).toBe(documentBefore);
      expect(snapshot(placements)).toBe(placementsBefore);
      const later = solveDrivenJoint(document, targets, placements, request, options);
      expect(later.ok).toBe(true);
      expect(later).toEqual(solveDrivenJoint(fixture().document, targets, fixture().placements, request, options));
    },
  );

  it('runCooperative cancelled after one real slice settles as cancelled, never as a numerical outcome', async () => {
    const { document, placements, targets, request, options } = fixture();
    const queue: (() => void)[] = [];
    const run = runCooperative<SolveDrivenJointOutcome>(
      solveDrivenJointSteps(document, targets, placements, request, options, { units: 1 }),
      { schedule: (slice) => { queue.push(slice); }, pointsPerSlice: 1 });
    expect(queue.length).toBe(1);
    queue.shift()?.();
    expect(run.progress()).toBeGreaterThan(0);
    run.cancel();
    while (queue.length > 0) queue.shift()?.();
    const result = await run.result;
    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') expect(result.progress).toBeGreaterThan(0);
  });

  it('runCooperative run to the end completes with exactly the synchronous outcome', async () => {
    const { document, placements, targets, request, options } = fixture();
    const queue: (() => void)[] = [];
    const run = runCooperative<SolveDrivenJointOutcome>(
      solveDrivenJointSteps(document, targets, placements, request, options, { units: 1 }),
      { schedule: (slice) => { queue.push(slice); }, pointsPerSlice: 1 });
    let slices = 0;
    while (queue.length > 0) {
      slices += 1;
      queue.shift()?.();
    }
    const result = await run.result;
    expect(slices).toBeGreaterThan(1);
    expect(result).toEqual({ status: 'completed', value: solveDrivenJoint(document, targets, placements, request, options) });
  });
});

function component(id: string, fixed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'box' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false };
}
function at(position: Vec3): RigidPlacement { return { ...IDENTITY_PLACEMENT, position }; }
const JOINT_FRAME = FRAME;
function jointEntry(id: string, kind: JointKind = 'ball', a = 'moving', b = 'ground'): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
    b: { kind: 'origin', componentId: b, element: 'origin' }, minValue: null, maxValue: null, suppressed: false };
}

function initialMates(count = 1) {
  const components = [component('ground', true), ...Array.from({ length: count }, (_, i) => component(`moving-${i}`))];
  const placements = new Map(components.map((entry, i) => [entry.id, at([i * 3, i * 4, i * 5])]));
  const mates: Mate[] = components.slice(1).map((entry, i) => ({ id: `mate-${i}`, name: `mate-${i}`, kind: 'coincident',
    a: { kind: 'origin', componentId: entry.id, element: 'origin' },
    b: { kind: 'origin', componentId: 'ground', element: 'origin' }, suppressed: false, flipped: false }));
  const targets = new Map<string, MateResidualTargetPair>(mates.map((mate, i) => [mate.id, {
    a: { kind: 'point', point: [(i + 1) * 3, (i + 1) * 4, (i + 1) * 5], direction: null, radius: null },
    b: { kind: 'point', point: [0, 0, 0], direction: null, radius: null },
  }]));
  const document: AssemblyDocument = { ...createAssemblyDocument('initial mates'), components, mates };
  return { document, placements, targets };
}

function* initialSteps(f: ReturnType<typeof initialMates>, budget: RigidWorkBudget) {
  const work = new RigidWorkSequence(budget);
  const outcome = yield* work.forward(solveMatesSteps(f.document, f.targets, f.placements, {}, budget));
  const diagnosis = yield* work.forward(diagnoseMatesSteps(f.document, outcome, budget));
  return { outcome, diagnosis };
}

function monotone<T>(steps: Generator<RigidWorkPoint, T, void>): { value: T; points: RigidWorkPoint[] } {
  const points: RigidWorkPoint[] = [];
  let previous = 0;
  for (;;) {
    const next = steps.next();
    if (next.done === true) return { value: next.value, points };
    expect(next.value.done).toBeGreaterThanOrEqual(previous);
    expect(Number.isFinite(next.value.done)).toBe(true);
    previous = next.value.done;
    points.push(next.value);
    expect(points.length).toBeLessThan(1000000);
  }
}

describe('EX-12 W05 initial mates and diagnosis cooperative steps', () => {
  it.each(['converged', 'iterationLimit', 'provenConstantConflict', 'unresolved', 'redundant', 'rigidGroup'] as const)(
    '%s: synchronous and sliced results agree exactly, including residuals and diagnosis classification', kind => {
      const f = initialMates(2);
      const options: SolveMatesOptions = kind === 'iterationLimit' ? { maxIterations: 0 } : {};
      if (kind === 'provenConstantConflict') f.document = { ...f.document, components: f.document.components.map(c => ({ ...c, fixed: true })) };
      if (kind === 'unresolved') f.targets.delete('mate-0');
      if (kind === 'redundant') {
        f.document = { ...f.document, mates: [...f.document.mates, { ...f.document.mates[0], id: 'duplicate' }] };
        const pair = f.targets.get('mate-0');
        if (pair === undefined) throw new Error('missing target');
        f.targets.set('duplicate', pair);
      }
      if (kind === 'rigidGroup') {
        f.document = { ...f.document, mates: f.document.mates.slice(0, 1) };
        f.document = joinRigidGroup(f.document, ['moving-0', 'moving-1']);
      }
      const before = snapshot(f);
      const expected = solveMates(f.document, f.targets, f.placements, options);
      const stepped = monotone(solveMatesSteps(f.document, f.targets, f.placements, options, { units: 1 }));
      expect(stepped.value).toEqual(expected);
      expect(Math.abs(stepped.value.residualNorm - expected.residualNorm)).toBeLessThanOrEqual(1e-6);
      expect(stepped.points.length).toBeGreaterThan(0);
      const diagnosis = monotone(diagnoseMatesSteps(f.document, stepped.value, { units: 1 }));
      expect(diagnosis.value).toEqual(diagnoseMates(f.document, expected));
      if (kind === 'converged' || kind === 'redundant') {
        expect(expected.converged).toBe(true);
        expect(diagnosis.value.complete).toBe(true);
        for (const id of ['moving-0', 'moving-1']) for (const value of expected.placements.get(id)?.position ?? []) {
          expect(Math.abs(value)).toBeLessThan(1e-6);
        }
      }
      if (kind === 'iterationLimit') expect(diagnosis.value.status).toBe('iterationLimit');
      if (kind === 'provenConstantConflict') expect(diagnosis.value.provenConflictMateIds).toEqual(['mate-0', 'mate-1']);
      if (kind === 'unresolved') expect(diagnosis.value.complete).toBe(false);
      if (kind === 'redundant') expect(diagnosis.value.redundantMateIds).toEqual(['duplicate']);
      // The established non-cooperative QR is an independent oracle for final rank and row independence.
      expected.diagnosis.components.forEach((entry, index) => {
        const linear = entry.linearization;
        if (linear == null) return;
        expect(entry.rank).toBe(matrixRank(linear.scaledJacobian, entry.variables));
        const transpose = Array.from({ length: entry.variables }, (_, column) => linear.scaledJacobian.map(row => row[column]));
        expect(diagnosis.value.components[index].redundancyComplete).toBe(qrDecomposition(transpose, entry.rows.length).rank === entry.rank);
      });
      expect(monotone(solveMatesSteps(f.document, f.targets, f.placements, options, UNLIMITED_RIGID_WORK)).points).toEqual([]);
      expect(monotone(diagnoseMatesSteps(f.document, expected, UNLIMITED_RIGID_WORK)).points).toEqual([]);
      expect(snapshot(f)).toBe(before);
    });

  it('enumerates every solve and diagnosis checkpoint with units=1: cancellation publishes zero and preserves all inputs', async () => {
    const f = initialMates(2), before = snapshot(f);
    const trace = monotone(initialSteps(f, { units: 1 }));
    expect(new Set(trace.points.map(point => point.phase))).toEqual(new Set(['assembly', 'residual', 'factorization']));
    for (let stop = 0; stop <= trace.points.length; stop += 1) {
      const queue: (() => void)[] = [];
      const run = runCooperative(initialSteps(f, { units: 1 }), { schedule: slice => { queue.push(slice); }, pointsPerSlice: 1 });
      let publishes = 0;
      const result = run.result.then(value => { if (value.status === 'completed') publishes += 1; return value; });
      for (let point = 0; point < stop; point += 1) {
        queue.shift()?.();
        expect(run.progress()).toBe(trace.points[point].done);
      }
      run.cancel();
      while (queue.length > 0) queue.shift()?.();
      expect(await result).toEqual({ status: 'cancelled', progress: run.progress() });
      expect(publishes).toBe(0);
      expect(snapshot(f)).toBe(before);
    }
    expect(drainRigidSteps(initialSteps(f, { units: 1 }))).toEqual(trace.value);
  });

  it('keeps incomplete linearizations unproven in the cooperative diagnosis', () => {
    const f = initialMates(), outcome = solveMates(f.document, f.targets, f.placements);
    const incomplete: SolveMatesOutcome = { ...outcome, diagnosis: { ...outcome.diagnosis,
      components: outcome.diagnosis.components.map(entry => ({ ...entry, linearization: undefined })) } };
    const before = snapshot(incomplete);
    const diagnosis = drainRigidSteps(diagnoseMatesSteps(f.document, incomplete, { units: 1 }));
    expect(diagnosis).toEqual(diagnoseMates(f.document, incomplete));
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.rows.every(row => row.dependency === 'unknown')).toBe(true);
    expect(diagnosis.provenConflictMateIds).toEqual([]);
    expect(snapshot(incomplete)).toBe(before);
  });

  it('the 600-variable chain stays below 1000ms per slice with the UI units=4096 and 16-point budget', () => {
    const chain = Array.from({ length: 100 }, (_, i) => component(`c${i}`));
    const joints = chain.map((entry, i) => jointEntry(`j${i}`, 'revolute', entry.id, i === 0 ? 'ground' : `c${i - 1}`));
    const document = { ...createAssemblyDocument('600'), components: [component('ground', true), ...chain], joints };
    const placements = new Map(document.components.map(entry => [entry.id, IDENTITY_PLACEMENT]));
    const frames = new Map(joints.map(joint => [joint.id, { a: FRAME, b: FRAME }]));
    const budget = { units: 4096 }, work = new RigidWorkSequence(budget);
    function* steps() {
      const outcome = yield* work.forward(solveMatesSteps(document, new Map(), placements, { jointFrames: frames }, budget));
      const diagnosis = yield* work.forward(diagnoseMatesSteps(document, outcome, budget));
      return { outcome, diagnosis };
    }
    const generator = steps();
    let maxSliceMs = 0, slices = 0, previous = 0;
    for (;;) {
      const start = performance.now();
      let next = generator.next();
      for (let count = 1; count < 16 && next.done !== true; count += 1) {
        expect(next.value.done).toBeGreaterThanOrEqual(previous);
        previous = next.value.done;
        next = generator.next();
      }
      maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
      slices += 1;
      if (next.done === true) {
        expect(next.value.outcome.diagnosis.limits).toEqual([]);
        expect(next.value.outcome.diagnosis.components[0].variables).toBe(600);
        expect(next.value.outcome.converged).toBe(true);
        expect(next.value.diagnosis.complete).toBe(true);
        break;
      }
    }
    expect(slices).toBeGreaterThan(1);
    expect(maxSliceMs).toBeLessThanOrEqual(1000);
    console.info('W05 model slice', { slices, maxSliceMs, units: budget.units, pointsPerSlice: 16 });
  });

  it('resolves nested occurrences cooperatively with the same result and monotone progress', () => {
    const child = initialMates().document;
    const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['box', createEmptyPartDocument()]]), assemblies: new Map([['child', child]]) };
    const parent: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
      { ...component('nested'), source: { kind: 'subAssembly', assemblyRef: 'child' },
        placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [expressionValueFromNumber(10), expressionValueFromNumber(0), expressionValueFromNumber(0)] } },
    ] };
    const options = { library, subAssemblies: library.assemblies };
    const expected = resolveConstrainedAssembly(parent, new Map(), options);
    expect(expected.ok).toBe(true);
    const stepped = monotone(resolveConstrainedAssembly(parent, new Map(), options, { units: 1 }));
    expect(stepped.value).toEqual(expected);
    expect(stepped.points.length).toBeGreaterThan(2);
    expect(monotone(resolveConstrainedAssembly(parent, new Map(), options, UNLIMITED_RIGID_WORK)).points).toEqual([]);
  });
});

describe('unchanged connected-variable limit oracle', () => {
  it('つながった101可動部品のjoint鎖は606変数を群の上限600で解かない', () => {
    const chain = Array.from({ length: 101 }, (_, i) => component(`c${i}`));
    const joints = chain.map((c, i) => jointEntry(`j${i}`, 'revolute', c.id, i === 0 ? 'ground' : `c${i - 1}`));
    const assembly = { ...createAssemblyDocument('鎖'), components: [component('ground', true), ...chain], joints };
    // 原点をずらしてjointを満たさない。解かれていれば配置が動く。
    const placements = new Map(assembly.components.map((c, i) => [c.id, at([i, 2 * i, 0])]));
    const frames = new Map(joints.map((j): [string, JointFramePair] => [j.id, { a: JOINT_FRAME, b: JOINT_FRAME }]));
    const result = solveMates(assembly, new Map(), placements, { jointFrames: frames });
    expect(result.converged).toBe(false);
    expect(result.diagnosis.status).toBe('variableLimit');
    expect(result.diagnosis.limits).toEqual([{ scope: 'component', componentIds: chain.map((c) => c.id), variables: 606, maximum: 600 }]);
    expect(result.diagnosis.components.map((c) => c.componentIds)).toEqual([chain.map((c) => c.id)]);
    expect(result.placements).toEqual(placements);
    expect(result.iterations).toBe(0);
  });
});
