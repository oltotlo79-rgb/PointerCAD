import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { runCooperative } from '../constraints/cooperativeRigid.js';
import { drainRigidSteps } from '../constraints/solveRigid.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import type { Quaternion, RigidPlacement } from '../placementMath.js';
import { MAX_SUB_ASSEMBLY_DEPTH, resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import { solveSubAssemblyJointDrive, solveSubAssemblyJointDriveSteps } from './subAssemblyJointDrive.js';
import { resolveSubAssemblyOccurrenceSteps } from './subAssemblyJointDrive.js';
import { expectBoundedDrivePreparation, expectDrivePlacements, observeDriveItems } from './jointDriveSteps.testSupport.js';

/*
 * Flexible subassembly drive: one child assembly (fixed base + free arm on a slider along the origin z axes) placed
 * twice. Expected positions are written by hand from the placements: A turns the child 90 degrees about z at
 * (10, 20, 0), B lifts it to (0, 0, 10); a slider value t puts the arm at the occurrence origin + t along its z axis
 * (r141 sign: (a.origin - b.origin) . b.z with a = member, b = anchor), which is world +z for both placements.
 */
const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function slider(id: string, element: 'z' | 'origin' = 'z'): Joint {
  return { id, name: id, kind: 'slider', a: { kind: 'origin', componentId: 'arm', element },
    b: { kind: 'origin', componentId: 'base', element }, minValue: null, maxValue: null, suppressed: false };
}
function view(source: JointOccurrenceInputs): JointOccurrenceView {
  return { source, resolved: resolveAssembly(source.document, { library: source.library, subAssemblies: source.subAssemblies }) };
}

async function fixture(childJoint: Joint = slider('child-slide')) {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-10-19T00:00:00.000Z' });
  const child: AssemblyDocument = { ...createAssemblyDocument('flexible child'),
    components: [component('base', { kind: 'part', partRef: embedded.partRef }, placement(0, 0, 0), true),
      component('arm', { kind: 'part', partRef: embedded.partRef })],
    joints: [childJoint] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0, TURN_Z)),
    component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(0, 0, 10)),
  ] };
  const inputs: JointOccurrenceInputs = { document, library, subAssemblies };
  return { inputs, solved: view(inputs), child };
}

const position = (placements: ReadonlyMap<string, RigidPlacement> | undefined, id: string): readonly number[] =>
  placements?.get(id)?.position ?? [Number.NaN, Number.NaN, Number.NaN];
function expectPosition(actual: readonly number[], expected: readonly [number, number, number]): void {
  expected.forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value, 9));
}

describe('flexible subassembly joint drive per occurrence', () => {
  it('bounds occurrence scans and child constraint preparation instead of filtering the whole document in one step', async () => {
    const f = await fixture(slider('child-slide', 'origin'));
    const original = f.inputs.document.components[0];
    if (original === undefined) throw new Error('missing occurrence');
    const components = observeDriveItems([...Array.from({ length: 96 }, (_, index) =>
      ({ ...original, id: `inactive-${String(index)}`, suppressed: true })), ...f.inputs.document.components]);
    const document = { ...f.inputs.document, components: components.items };
    const inputs = { ...f.inputs, document };
    const solved = view(inputs);
    const found = expectBoundedDrivePreparation(resolveSubAssemblyOccurrenceSteps(inputs, solved, ['A'], { units: 3 }), components, 3);
    expect(found.ok).toBe(true);

    const joints = observeDriveItems([...Array.from({ length: 96 }, (_, index) =>
      ({ ...slider(`inactive-joint-${String(index)}`), suppressed: true })), ...f.child.joints]);
    const child = { ...f.child, joints: joints.items };
    const subAssemblies = new Map([['child', child]]);
    const childInputs = { ...f.inputs, subAssemblies, library: { ...f.inputs.library, assemblies: subAssemblies } };
    const childInput = { inputs: childInputs, view: view(childInputs), path: ['A'],
      request: { jointId: 'child-slide', coordinate: 'translation' as const, value: 9 } };
    const refused = expectBoundedDrivePreparation(solveSubAssemblyJointDriveSteps(childInput, { units: 3 }), joints, 3);
    expect(refused).toEqual({ ok: false, code: 'unsupported-geometry', index: 0 });
  });

  it('keeps all placement axes at several budgets and never yields with unlimited synchronous work', async () => {
    const f = await fixture();
    for (const path of [['A'], ['B']]) {
      const input = { inputs: f.inputs, view: f.solved, path,
        request: { jointId: 'child-slide', coordinate: 'translation' as const, value: -7 } };
      const expected = solveSubAssemblyJointDrive(input);
      if (!expected.ok) throw new Error(`refused ${expected.code}`);
      for (const units of [1, 13, 512]) {
        const actual = drainRigidSteps(solveSubAssemblyJointDriveSteps(input, { units }));
        if (!actual.ok) throw new Error(`refused ${actual.code}`);
        expectDrivePlacements(actual.placements, expected.placements);
        expect(actual).toEqual(expected);
      }
      expect(solveSubAssemblyJointDriveSteps(input, { units: Number.POSITIVE_INFINITY }).next())
        .toEqual({ done: true, value: expected });
    }
  });

  it('drains the same placements and cancels before, within and after the child without publishing or mutation', async () => {
    const f = await fixture();
    const initial = f.solved.resolved.subAssemblies?.get('A')?.resolved.placements;
    if (initial === undefined) throw new Error('missing child');
    const input = { inputs: f.inputs, view: f.solved, path: ['A'], initial,
      request: { jointId: 'child-slide', coordinate: 'translation' as const, value: 9 } };
    const before = structuredClone(f);
    const expected = solveSubAssemblyJointDrive(input);
    expect(expected.ok).toBe(true);
    const budget = { units: 1 };
    const trace = solveSubAssemblyJointDriveSteps(input, budget);
    let points = 0, previous = 0;
    for (;;) {
      const next = trace.next();
      if (next.done === true) { expect(next.value).toEqual(expected); break; }
      expect(next.value.done).toBeGreaterThanOrEqual(previous);
      previous = next.value.done;
      expect(Number.isFinite(previous)).toBe(true);
      points += 1;
      expect(points).toBeLessThan(10000);
    }
    expect(points).toBeGreaterThan(2);
    expect(drainRigidSteps(solveSubAssemblyJointDriveSteps(input, { units: 1 }))).toEqual(expected);
    for (let stop = 0; stop <= points; stop += 1) {
      const queue: (() => void)[] = [];
      const run = runCooperative(solveSubAssemblyJointDriveSteps(input, budget),
        { pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
      let published = 0;
      const result = run.result.then(value => { if (value.status === 'completed') published += 1; return value; });
      for (let point = 0; point < stop; point += 1) queue.shift()?.();
      run.cancel();
      // A late queued slice must not resume the discarded child solve.
      while (queue.length > 0) queue.shift()?.();
      expect(await result).toEqual({ status: 'cancelled', progress: run.progress() });
      expect(published).toBe(0);
      expect(f).toEqual(before);
    }
  });

  it('moves the child arm inside one placement only, keeps the parent transform and never edits a document', async () => {
    const f = await fixture();
    const before = [JSON.stringify(f.inputs.document), JSON.stringify(f.child)];
    const a = solveSubAssemblyJointDrive({ inputs: f.inputs, view: f.solved, path: ['A'],
      request: { jointId: 'child-slide', coordinate: 'translation', value: 5 } });
    if (!a.ok) throw new Error(`refused ${a.code}`);
    expect(a.occurrenceKey).toBe(JSON.stringify(['A']));
    expect(a.childDocument).toBe(f.child);
    expectPosition(position(a.placements, 'arm'), [10, 20, 5]);
    expectPosition(position(a.placements, 'base'), [10, 20, 0]);
    // The child keeps the occurrence's rotation (parent transform) on both parts.
    for (const id of ['base', 'arm']) {
      a.placements.get(id)?.rotation.forEach((value, axis) => expect(value).toBeCloseTo(TURN_Z[axis] ?? Number.NaN, 9));
    }
    expect([JSON.stringify(f.inputs.document), JSON.stringify(f.child)]).toEqual(before);
    // The other placement of the same child is untouched by A's drive.
    expectPosition(position(f.solved.resolved.subAssemblies?.get('B')?.resolved.placements, 'arm'), [0, 0, 10]);
  });

  it('keeps independent values for repeated placements and continues from the shown placements', async () => {
    const f = await fixture();
    const a = solveSubAssemblyJointDrive({ inputs: f.inputs, view: f.solved, path: ['A'],
      request: { jointId: 'child-slide', coordinate: 'translation', value: 5 } });
    const b = solveSubAssemblyJointDrive({ inputs: f.inputs, view: f.solved, path: ['B'],
      request: { jointId: 'child-slide', coordinate: 'translation', value: 7 } });
    if (!a.ok || !b.ok) throw new Error('both placements must drive');
    expect(a.occurrenceKey).not.toBe(b.occurrenceKey);
    expectPosition(position(b.placements, 'arm'), [0, 0, 17]);
    expectPosition(position(a.placements, 'arm'), [10, 20, 5]);
    const again = solveSubAssemblyJointDrive({ inputs: f.inputs, view: f.solved, path: ['A'], initial: a.placements,
      request: { jointId: 'child-slide', coordinate: 'translation', value: 9 } });
    if (!again.ok) throw new Error(`refused ${again.code}`);
    expectPosition(position(again.placements, 'arm'), [10, 20, 9]);
    expectPosition(position(again.placements, 'base'), [10, 20, 0]);
    expectPosition(position(b.placements, 'arm'), [0, 0, 17]);
  });

  it('refuses invalid, stale, non-subassembly, deep, partial and unsupported requests with their codes', async () => {
    const f = await fixture();
    const request = { jointId: 'child-slide', coordinate: 'translation' as const, value: 5 };
    const drive = (path: readonly string[], extra: Partial<Parameters<typeof solveSubAssemblyJointDrive>[0]> = {}) => {
      const result = solveSubAssemblyJointDrive({ inputs: f.inputs, view: f.solved, path, request, ...extra });
      return result.ok ? 'ok' : `${result.code}@${String(result.index)}`;
    };
    expect(drive([])).toBe('invalid-path@0');
    expect(drive(['missing'])).toBe('missing-component@0');
    expect(drive(['A', 'base'])).toBe('not-subassembly@1');
    expect(drive(['A'], { inputs: { ...f.inputs, subAssemblies: new Map(f.inputs.subAssemblies) } })).toBe('stale-view@0');
    expect(drive(Array.from({ length: MAX_SUB_ASSEMBLY_DEPTH + 1 }, () => 'A'))).toBe(`depth-exceeded@${String(MAX_SUB_ASSEMBLY_DEPTH)}`);
    expect(drive(['A'], { request: { ...request, jointId: 'no-such-joint' } })).toBe('missing-joint@0');
    const partial = new Map([...(f.solved.resolved.subAssemblies?.get('A')?.resolved.placements ?? new Map<string, RigidPlacement>())]
      .filter(([id]) => id !== 'arm'));
    expect(drive(['A'], { initial: partial })).toBe('inconsistent-tree@0');
    const pointOnly = await fixture(slider('child-slide', 'origin'));
    const refused = solveSubAssemblyJointDrive({ inputs: pointOnly.inputs, view: pointOnly.solved, path: ['A'], request });
    expect(refused.ok ? 'ok' : refused.code).toBe('unsupported-geometry');
  });

  it('refuses a cyclic child reference instead of driving a partially resolved tree', async () => {
    const f = await fixture();
    const cyclic: AssemblyDocument = { ...f.child, components: [...f.child.components,
      component('loop', { kind: 'subAssembly', assemblyRef: 'child' })] };
    const subAssemblies = new Map([['child', cyclic]]);
    const inputs: JointOccurrenceInputs = { ...f.inputs, library: { ...f.inputs.library, assemblies: subAssemblies }, subAssemblies };
    const solved = view(inputs);
    expect(solved.resolved.errors.some(error => error.code === 'subAssemblyCycle')).toBe(true);
    const result = solveSubAssemblyJointDrive({ inputs, view: solved, path: ['A', 'loop'],
      request: { jointId: 'child-slide', coordinate: 'translation', value: 5 } });
    expect(result.ok ? 'ok' : result.code).toBe('unresolved-view');
  });
});
