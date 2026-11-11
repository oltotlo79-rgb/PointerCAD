import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry } from '../../kernelBridge.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { HoleFeature, PartDocument, ThreadHoleFeature } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { threadMinorDiameter } from '../../thread/metricThread.js';
import { addComponent, createComponentFor, setComponentSuppressed, setFixed } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { joinRigidGroup } from '../rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument, Mate, Placement } from '../types.js';
import type { FaceResolution, FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import { commitBoltedJoint, previewBoltedJoint, type BoltedJointChoices } from './boltedJointCommand.js';
import type { BoltedJointPlan, BoltedJointPlanResult } from './types.js';

/*
 * EX-06 "changed ownership/constraints": after the preview, a change of which part may move (fixed flags, a rigid group
 * joined, suppression) or a new constraint on the moving part must refuse the commit and return the very document
 * it was given (no partial insertion). The fixture is a private copy of boltedJointCommand.test.ts (9e28ceec):
 * plate A with a 9 mm through hole at (20, 10), plate B with an M8 blind tapped hole, B tilted at (100, 0, 0).
 * Expectations are refusals and document identity, not values recomputed by the planner.
 */

const HALF = Math.SQRT1_2;
const DRILL = threadMinorDiameter(8, 1.25);
const REVISIONS = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);

function ref(bodyFeatureId: string, index: number): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

function value(n: number) { return expressionValueFromNumber(n); }

function plateA(): PartDocument {
  const hole: HoleFeature = {
    id: 'hole-1', name: '穴1', suppressed: false, kind: 'hole', targetFeatureId: 'extrude-1', face: ref('extrude-1', 0),
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }], diameter: value(9), depth: { kind: 'through' },
    tiltAngle: value(0), tiltAzimuth: value(0),
  };
  return appendSolid(createEmptyPartDocument(), hole);
}

function plateB(): PartDocument {
  const hole: ThreadHoleFeature = {
    id: 'threadHole-1', name: 'ねじ穴1', suppressed: false, kind: 'threadHole', targetFeatureId: 'extrude-1',
    face: ref('extrude-1', 0), centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }], designation: 'M8',
    series: 'coarse', pitch: value(1.25), drillDiameter: value(DRILL), depth: { kind: 'blind', depth: value(20) },
    threadLength: value(16), representation: 'simplified', tiltAngle: value(0), tiltAzimuth: value(0),
  };
  return appendSolid(createEmptyPartDocument(), hole);
}

function cylinder(center: Vec3, radius: number, length: number): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'cylinder', area: 2 * Math.PI * radius * length, position: center,
    axis: [0, 0, 1], axisOrigin: center, cylinderSpan: [-length / 2, length / 2], radius };
}

function plane(position: Vec3): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'plane', area: 400, position, axis: [0, 0, 1], radius: null };
}

const FACES: Readonly<Record<string, Readonly<Record<number, MateSubShapeGeometry>>>> = {
  plateA: { 1: cylinder([20, 10, -5], 4.5, 10), 2: plane([20, 10, 0]) },
  plateB: { 1: cylinder([0, 0, 10], DRILL / 2, 20), 2: plane([0, 0, 0]) },
};

function placement(position: Vec3, rotation: readonly [number, number, number, number]): Placement {
  return { position: [value(position[0]), value(position[1]), value(position[2])], rotation };
}

const TILTED_B = placement([100, 0, 0], [0, HALF, 0, HALF]);

function assembly(): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 0, 0], [0, 0, 0, 1]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: TILTED_B }));
  // A third, unrelated part far away (component-3) that a later edit may group with plate B.
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 100, 0], [0, 0, 0, 1]) }));
}

function partRefOf(component: AssemblyComponent): string {
  return component.source.kind === 'part' ? component.source.partRef : '';
}

const WALL_FEATURES: Readonly<Record<string, string>> = { plateA: 'hole-1', plateB: 'threadHole-1' };

function context(document: AssemblyDocument): FasteningGeometryContext {
  return {
    document, partRevisions: REVISIONS,
    partDocument: (component) => (partRefOf(component) === 'plateA' ? plateA() : partRefOf(component) === 'plateB' ? plateB() : null),
    resolveFace: (component, reference): FaceResolution => {
      const geometry = FACES[partRefOf(component)]?.[reference.index];
      if (geometry === undefined) return { status: 'missing' };
      const featureId = reference.index === 1 ? WALL_FEATURES[partRefOf(component)] : undefined;
      return { status: 'matched', geometry, wall: featureId === undefined ? { status: 'unnamed' } : { status: 'hole', origin: {
        kind: 'hole-face', featureId, center: { sketchId: 'sketch-1', producer: { kind: 'point', featureId: 'point-1' } },
        placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } };
    },
  };
}

const PICK_A: FasteningHolePick = { componentId: 'component-1', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) };
const PICK_B: FasteningHolePick = { componentId: 'component-2', holeFeatureId: 'threadHole-1', holeFace: ref('threadHole-1', 1), matingFace: ref('threadHole-1', 2) };

const CHOICES: BoltedJointChoices = {
  dimensionSeries: 'annexJA', engagement: 12, blindBottomClearance: 2, headWashers: [], nutWashers: [],
  lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [20, 22, 30], basis: 'perDiameterEvidence',
    verified: true, source: 'test fixture (not a JIS value)' }],
};

function planned(result: BoltedJointPlanResult): BoltedJointPlan {
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

/** The commit is refused and hands back exactly the changed document: nothing added, nothing moved. */
function expectAtomicRefusal(changed: AssemblyDocument, previewed: BoltedJointPlan): string[] {
  const before = JSON.stringify(changed);
  const result = commitBoltedJoint(context(changed), PICK_A, PICK_B, CHOICES, previewed);
  expect(result.ok).toBe(false);
  expect(result.document).toBe(changed);
  expect(JSON.stringify(changed)).toBe(before);
  expect(result.document.components).toHaveLength(3);
  return result.ok ? [] : result.rejections.map((entry) => entry.code);
}

describe('EX-06 ownership and constraint changes between preview and commit', () => {
  const document = assembly();
  const previewed = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, CHOICES));

  it('the preview moves only plate B (plate A is the fixed first part, component-3 is unrelated)', () => {
    expect(document.components.map((component) => component.fixed)).toEqual([true, false, false]);
    expect(previewed.alignment.movedComponentIds).toEqual(['component-2']);
  });

  it('swapping which plate is fixed after the preview refuses: the other plate would move', () => {
    const swapped = setFixed(setFixed(document, 'component-1', false), 'component-2', true);
    expect(expectAtomicRefusal(swapped, previewed)).toEqual(['staleSource']);
  });

  it('grouping plate B with another part after the preview refuses: the group would move with it', () => {
    const grouped = joinRigidGroup(document, ['component-2', 'component-3']);
    expect(grouped.components.map((component) => component.rigidGroupId)).toEqual([undefined, 'fastening-1', 'fastening-1']);
    expect(expectAtomicRefusal(grouped, previewed)).toEqual(['staleSource']);
  });

  it('suppressing plate B after the preview refuses', () => {
    const suppressed = setComponentSuppressed(document, 'component-2', true);
    expect(expectAtomicRefusal(suppressed, previewed).length).toBeGreaterThan(0);
  });

  it('a conflicting mate added on the moving plate after the preview refuses with the constraint reason', () => {
    // Distance 10 between the two plates' origin XY planes cannot hold once B is pulled into contact (cf. the
    // existing distance-0 acceptance in boltedJointCommand.test.ts).
    const mate: Mate = { id: 'mate-1', name: 'distance', kind: 'distance', suppressed: false, flipped: false, value: value(10),
      a: { kind: 'origin', componentId: 'component-2', element: 'xy' },
      b: { kind: 'origin', componentId: 'component-1', element: 'xy' } };
    const constrained = { ...document, mates: [mate] };
    expect(expectAtomicRefusal(constrained, previewed)).toEqual(['existingConstraintConflict']);
  });
});
