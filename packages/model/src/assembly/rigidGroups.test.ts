import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from './assemblyEdit.js';
import { diagnoseMates, solveMates } from './constraints/solveMates.js';
import { buildMateResidualReport, prepareMateResiduals, type MateResidualTargetPair } from './constraints/mateResiduals.js';
import { collapseSolveInput } from './constraints/rigidGroupSolve.js';
import { buildJointResidualReport, prepareJointResiduals } from './joints/jointResiduals.js';
import { jointFramePairFromTargets } from './joints/jointFrames.js';
import { collectMateVariables } from './constraints/mateVariables.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import { applyPlacementToDirection, applyPlacementToPoint, composePlacement, type RigidPlacement } from './placementMath.js';
import { collapseRigidGroups, joinRigidGroup, relativePlacement } from './rigidGroups.js';
import type { AssemblyDocument, Joint, Mate, Placement } from './types.js';
import type { Vec3 } from '../sketch/vec3.js';

const HALF = Math.SQRT1_2;

function placement(position: Vec3, rotation: readonly [number, number, number, number]): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

function rigid(document: AssemblyDocument): Map<string, RigidPlacement> {
  return new Map(document.components.map((component) => [component.id, {
    position: [component.placement.position[0].value, component.placement.position[1].value, component.placement.position[2].value],
    rotation: component.placement.rotation,
  }]));
}

/** 固定の部品F(component-1)と、組にした G(component-2)・M(component-3)。M の原点を F の原点へ一致させる。 */
function fixture(): { readonly document: AssemblyDocument; readonly targets: Map<string, MateResidualTargetPair> } {
  let document = createAssemblyDocument('組立1');
  const parts: readonly (readonly [string, Placement])[] = [
    ['f', placement([0, 0, 0], [0, 0, 0, 1])],
    ['g', placement([30, 0, 0], [0, 0, 0, 1])],
    ['m', placement([40, 5, 0], [0, 0, HALF, HALF])],
  ];
  for (const [partRef, where] of parts) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }, { placement: where }));
  }
  document = joinRigidGroup(document, ['component-2', 'component-3']);
  const mate: Mate = { id: 'mate-1', name: '一致1', kind: 'coincident', flipped: false, suppressed: false,
    a: { kind: 'origin', componentId: 'component-3', element: 'origin' },
    b: { kind: 'origin', componentId: 'component-1', element: 'origin' } };
  document = { ...document, mates: [mate] };
  const targets = new Map<string, MateResidualTargetPair>([['mate-1', {
    a: { kind: 'point', point: [40, 5, 0], direction: null, radius: null },
    b: { kind: 'point', point: [0, 0, 0], direction: null, radius: null },
  }]]);
  return { document, targets };
}

describe('互いに固定した組の畳み込み', () => {
  it('組の無い旧い文書は畳まない', () => {
    let document = createAssemblyDocument('組立1');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, {}));
    expect(collapseRigidGroups(document, rigid(document))).toBeNull();
  });

  it('組を代表へ畳み、外部と内部の合致をともに残して代表を指す', () => {
    const { document } = fixture();
    const internal: Mate = { id: 'mate-2', name: '一致2', kind: 'coincident', flipped: false, suppressed: false,
      a: { kind: 'origin', componentId: 'component-2', element: 'origin' },
      b: { kind: 'origin', componentId: 'component-3', element: 'origin' } };
    const collapse = collapseRigidGroups({ ...document, mates: [...document.mates, internal] }, rigid(document));
    expect(collapse?.document.components.map((component) => component.id)).toEqual(['component-1', 'component-2']);
    expect(collapse?.document.mates.map((mate) => [mate.id, mate.a.componentId, mate.b.componentId]))
      .toEqual([['mate-1', 'component-2', 'component-1'], ['mate-2', 'component-2', 'component-2']]);
    expect([...collapse?.anchorOf ?? []]).toEqual([['component-3', 'component-2']]);
  });
});

describe('組を 1 つの剛体として解く', () => {
  it('外部へ連結した可動組の内部mate/jointは定数で、移動回転しても残差と診断を保つ', () => {
    const { document, targets } = fixture();
    const initial = rigid(document);
    const internal: Mate = { id: 'mate-internal', name: 'distance', kind: 'distance', flipped: false, suppressed: false,
      a: { kind: 'origin', componentId: 'component-2', element: 'xy' },
      b: { kind: 'origin', componentId: 'component-3', element: 'xy' }, value: expressionValueFromNumber(0) };
    const internalPair: MateResidualTargetPair = {
      a: { kind: 'plane', point: [30, 0, 0], direction: [0, 0, 1], radius: null },
      b: { kind: 'plane', point: [40, 5, 0], direction: [0, 0, 1], radius: null },
    };
    const joint: Joint = { id: 'joint-internal', name: 'ball', kind: 'ball', suppressed: false, minValue: null, maxValue: null,
      a: { kind: 'origin', componentId: 'component-2', element: 'origin' },
      b: { kind: 'origin', componentId: 'component-3', element: 'origin' } };
    const jointPair: MateResidualTargetPair = {
      a: { kind: 'point', point: [30, 0, 0], direction: null, radius: null },
      b: { kind: 'point', point: [30, 0, 0], direction: null, radius: null },
    };
    const frames = jointFramePairFromTargets(joint, jointPair, initial);
    if (frames === null) throw new Error('missing joint frames');
    const allTargets = new Map([...targets, [internal.id, internalPair] as const]);
    const source = { ...document, mates: [...document.mates, internal], joints: [joint] };
    const options = { jointFrames: new Map([[joint.id, frames]]) };
    const collapsed = collapseSolveInput(source, initial, options);
    if (collapsed === null) throw new Error('missing collapse');
    const variableSet = collectMateVariables(collapsed.assembly);
    expect(variableSet.columnOf('component-2', 'tx')).not.toBeNull();
    const prepared = prepareMateResiduals({ mates: collapsed.assembly.mates, targets: allTargets, placements: collapsed.initial });
    const preparedJoints = prepareJointResiduals({ joints: collapsed.assembly.joints,
      frames: collapsed.options.jointFrames, placements: collapsed.initial });
    const movedBy: RigidPlacement = { position: [7, -4, 9], rotation: [HALF, 0, 0, HALF] };
    const moved = new Map([...collapsed.initial].map(([id, place]) => [id, composePlacement(movedBy, place)] as const));
    for (const places of [collapsed.initial, moved]) {
      const report = buildMateResidualReport({ mates: prepared.mates, placements: places, variableSet });
      const rows = report.rows.filter((row) => row.mateId === internal.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBeCloseTo(0, 12);
      expect([...rows[0]?.gradient.values() ?? []].every((entry) => Math.abs(entry) < 1e-12)).toBe(true);
      const jointReport = buildJointResidualReport({ joints: preparedJoints.joints, placements: places, variableSet });
      expect(jointReport.rows).toHaveLength(3);
      jointReport.rows.forEach((row) => {
        expect(row.value).toBeCloseTo(0, 12);
        expect([...row.gradient.values()].every((entry) => Math.abs(entry) < 1e-12)).toBe(true);
      });
    }
    expect(solveMates(source, allTargets, initial, options).converged).toBe(true);
    const conflicting = { ...source, mates: [...document.mates, { ...internal, value: expressionValueFromNumber(10) }] };
    const bad = solveMates(conflicting, allTargets, initial, options);
    expect(bad.converged).toBe(false);
    expect(bad.diagnosis.constantConflicts).toContain(internal.id);
    const badFrames = { ...frames, b: { ...frames.b, origin: [frames.b.origin[0], frames.b.origin[1], frames.b.origin[2] + 1] as const } };
    const badJoint = solveMates(source, allTargets, initial, { jointFrames: new Map([[joint.id, badFrames]]) });
    expect(badJoint.converged).toBe(false);
    expect(badJoint.diagnosis.constantJointConflicts).toContain(joint.id);
    const rotatedTargets = new Map([...allTargets].map(([id, pair]) => [id, {
      a: { ...pair.a, point: applyPlacementToPoint(movedBy, pair.a.point),
        direction: pair.a.direction === null ? null : applyPlacementToDirection(movedBy, pair.a.direction) },
      b: { ...pair.b, point: applyPlacementToPoint(movedBy, pair.b.point),
        direction: pair.b.direction === null ? null : applyPlacementToDirection(movedBy, pair.b.direction) },
    }] as const));
    const rotatedInitial = new Map([...initial].map(([id, place]) => [id, composePlacement(movedBy, place)] as const));
    expect(solveMates(conflicting, rotatedTargets, rotatedInitial, options).diagnosis.constantConflicts).toContain(internal.id);
  });

  it('内部拘束の代表の同じ列は相殺し、適合0と不適合10を診断から消さない', () => {
    const { document } = fixture();
    const initial = rigid(document);
    const internal: Mate = { id: 'mate-internal', name: 'distance', kind: 'distance', flipped: false, suppressed: false,
      a: { kind: 'origin', componentId: 'component-2', element: 'xy' },
      b: { kind: 'origin', componentId: 'component-3', element: 'xy' }, value: expressionValueFromNumber(0) };
    const targets = new Map<string, MateResidualTargetPair>([[internal.id, {
      a: { kind: 'plane', point: [30, 0, 0], direction: [0, 0, 1], radius: null },
      b: { kind: 'plane', point: [40, 5, 0], direction: [0, 0, 1], radius: null },
    }]]);
    const source = { ...document, mates: [internal] };
    const collapse = collapseRigidGroups(source, initial);
    if (collapse === null) throw new Error('missing collapse');
    const prepared = prepareMateResiduals({ mates: collapse.document.mates, targets, placements: initial });
    expect(prepared.skipped).toEqual([]);
    const report = buildMateResidualReport({ mates: prepared.mates, placements: initial,
      variableSet: collectMateVariables(collapse.document) });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.value).toBe(0);
    expect([...report.rows[0]?.gradient.values() ?? []].every((value) => Math.abs(value) < 1e-12)).toBe(true);
    const good = solveMates(source, targets, initial);
    expect(good.converged).toBe(true);
    expect(diagnoseMates(source, good).rows.map((row) => row.mateId)).toContain(internal.id);
    const conflicting = { ...source, mates: [{ ...internal, value: expressionValueFromNumber(10) }] };
    const bad = solveMates(conflicting, targets, initial);
    expect(bad.converged).toBe(false);
    expect(diagnoseMates(conflicting, bad).rows.map((row) => row.mateId)).toContain(internal.id);
    expect(bad.diagnosis.constantConflicts).toContain(internal.id);
  });

  it('M の原点を F の原点へ合わせ、G と M の相対姿勢は変えず、F は動かさない', () => {
    const { document, targets } = fixture();
    const initial = rigid(document);
    const g0 = initial.get('component-2');
    const m0 = initial.get('component-3');
    if (g0 === undefined || m0 === undefined) throw new Error('fixture');
    const before = relativePlacement(g0, m0);
    const outcome = solveMates(document, targets, initial);
    expect(outcome.converged).toBe(true);
    const g = outcome.placements.get('component-2');
    const m = outcome.placements.get('component-3');
    if (g === undefined || m === undefined) throw new Error('missing placements');
    m.position.forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-6));
    const after = relativePlacement(g, m);
    after.position.forEach((value, index) => expect(value).toBeCloseTo(before.position[index] ?? NaN, 9));
    after.rotation.forEach((value, index) => expect(value).toBeCloseTo(before.rotation[index] ?? NaN, 12));
    expect(outcome.placements.get('component-1')).toEqual(initial.get('component-1'));
  });
});
