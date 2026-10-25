import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry } from '../../kernelBridge.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { HoleFeature, PartDocument, ThreadHoleFeature } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { threadMinorDiameter } from '../../thread/metricThread.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { releaseRigidGroup } from '../rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument, Mate, Placement } from '../types.js';
import type { FaceResolution, FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import { commitBoltedJoint, previewBoltedJoint, type BoltedJointChoices } from './boltedJointCommand.js';
import {
  commitBoltedJointEdit, findBoltedJointRecord, previewBoltedJointEdit, withBoltedJointRecord,
  type BoltedJointCatalogChoices, type BoltedJointUserChoices,
} from './boltedJointEdit.js';
import type { BoltedJointPlan } from './types.js';

/*
 * Editing a committed flat bolted joint (EX-06). Fixture: a private copy of boltedJointCommand.test.ts (9e28ceec):
 * plate A z -10..0 with a 9 mm through hole at (20, 10); plate B with an M8 blind tapped hole (drill 20, thread 16),
 * placed tilted at (100, 0, 0) and pulled to (20, 10, 0) by the first commit.
 * Expected values are hand-derived from the table values the existing tests already use (M8 b1 22, plain washer
 * M8 t 1.6): no washer -> grip 10, engagement 12, bottom clearance 2: 22 <= L <= 24 -> 22 from [20, 22, 24, 30];
 * one plain washer under the head -> grip 11.6: 23.6 <= L <= 25.6 -> 24.
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

function partRefOf(component: AssemblyComponent): string {
  return component.source.kind === 'part' ? component.source.partRef : '';
}

const WALL_FEATURES: Readonly<Record<string, string>> = { plateA: 'hole-1', plateB: 'threadHole-1' };

/** The face geometry is given in each part's own frame (as the kernel reports it), so it does not follow placement. */
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

const CATALOG: BoltedJointCatalogChoices = {
  lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [20, 22, 24, 30], basis: 'perDiameterEvidence',
    verified: true, source: 'test fixture (not a JIS value)' }],
};
const ORIGINAL: BoltedJointUserChoices = { dimensionSeries: 'annexJA', engagement: 12, blindBottomClearance: 2, headWashers: [], nutWashers: [] };
const WITH_WASHER: BoltedJointUserChoices = { ...ORIGINAL, headWashers: ['plainWasher'] };

function planned(result: { readonly ok: true; readonly plan: BoltedJointPlan } | { readonly ok: false }): BoltedJointPlan {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.plan;
}

/**
 * Plates A, B and an unrelated part C (with a mate to A), then the joint committed exactly as the store will.
 * The mate must hold as written: a plane distance is signed along b's normal (dot(pointA - pointB, normalB) - value),
 * and the origin xz plane's normal is (0, -1, 0) (mateTargets.ts originTarget, WORK_PLANES). C therefore sits at
 * y = -100: dot((0, -100, 0) - (0, 0, 0), (0, -1, 0)) = 100 = the distance, residual 0. (At y = +100 the projection
 * is -100 and the mate is violated by 200 before any bolt, so every preview was refused as existingConstraintConflict.)
 */
function fastened(): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 0, 0], [0, 0, 0, 1]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: placement([100, 0, 0], [0, HALF, 0, HALF]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, -100, 0], [0, 0, 0, 1]) }));
  const mate: Mate = { id: 'mate-1', name: 'keep', kind: 'distance', suppressed: false, flipped: false, value: value(100),
    a: { kind: 'origin', componentId: 'component-3', element: 'xz' }, b: { kind: 'origin', componentId: 'component-1', element: 'xz' } };
  document = { ...document, mates: [mate] };
  const choices: BoltedJointChoices = { ...ORIGINAL, ...CATALOG };
  const plan = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, choices));
  const committed = commitBoltedJoint(context(document), PICK_A, PICK_B, choices, plan);
  if (!committed.ok) throw new Error(JSON.stringify(committed.rejections));
  return withBoltedJointRecord(committed.document, PICK_A, PICK_B, choices, committed.componentIds);
}

function z(document: AssemblyDocument, id: string): number {
  return document.components.find((component) => component.id === id)?.placement.position[2]?.value ?? NaN;
}

describe('EX-06 editing a committed bolted joint', () => {
  it('the first commit records only the picks, the user choices and the generated part', () => {
    const document = fastened();
    // M8 x 22 bolt, no washer: one generated part (component-4).
    expect(document.components.map((component) => component.id)).toEqual(['component-1', 'component-2', 'component-3', 'component-4']);
    expect(document.boltedJoints).toEqual([{ id: 'bolted-joint-1', first: PICK_A, second: PICK_B, choices: ORIGINAL,
      componentIds: ['component-4'] }]);
    const bolt = document.components[3];
    expect(bolt?.source.kind === 'standardPart' ? [bolt.source.catalog, bolt.source.options.length] : null).toEqual(['hexBolt', '22']);
  });

  it('an unrelated mate that does not hold as written is still refused before any bolt is planned', () => {
    // The guard the fixture must respect: existingConstraints is not weakened. C at y = +100 violates mate-1 by 200.
    let document = createAssemblyDocument('組立1');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 0, 0], [0, 0, 0, 1]) }));
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: placement([100, 0, 0], [0, HALF, 0, HALF]) }));
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 100, 0], [0, 0, 0, 1]) }));
    const mate: Mate = { id: 'mate-1', name: 'keep', kind: 'distance', suppressed: false, flipped: false, value: value(100),
      a: { kind: 'origin', componentId: 'component-3', element: 'xz' }, b: { kind: 'origin', componentId: 'component-1', element: 'xz' } };
    const preview = previewBoltedJoint(context({ ...document, mates: [mate] }), PICK_A, PICK_B, { ...ORIGINAL, ...CATALOG });
    expect(preview).toEqual({ ok: false, rejections: [{ code: 'existingConstraintConflict', detail: { constraintId: 'mate-1' } }] });
  });

  it('adding a head washer replaces the hardware in one new document and keeps plates, mates, groups and order', () => {
    const document = fastened();
    const before = JSON.stringify(document);
    const preview = previewBoltedJointEdit(context(document), 'bolted-joint-1', WITH_WASHER, CATALOG);
    const plan = planned(preview);
    expect([plan.boltLength, plan.gripLength]).toEqual([24, 11.6]);
    const result = commitBoltedJointEdit(context(document), 'bolted-joint-1', WITH_WASHER, CATALOG, plan);
    if (!result.ok) throw new Error(JSON.stringify(result));
    // The original document is not touched (Undo keeps it as the previous snapshot).
    expect(JSON.stringify(document)).toBe(before);
    const edited = result.document;
    // The old bolt (component-4) is gone; the washer and the new bolt are new parts after the unrelated part.
    expect(edited.components.map((component) => component.id)).toEqual(['component-1', 'component-2', 'component-3', 'component-5', 'component-6']);
    expect(edited.components.slice(0, 3)).toEqual(document.components.slice(0, 3));
    const sources = edited.components.slice(3).map((component) => component.source.kind === 'standardPart'
      ? [component.source.catalog, component.source.size, component.source.options.length ?? null] : null);
    expect(sources).toEqual([['plainWasher', 'M8', null], ['hexBolt', 'M8', '24']]);
    // Washer on plate A's outer face z -10; the bolt bearing on top of it at z -11.6 (hand-derived, A's hole axis +Z).
    expect(z(edited, 'component-5')).toBeCloseTo(-10, 9);
    expect(z(edited, 'component-6')).toBeCloseTo(-11.6, 9);
    expect(edited.mates).toEqual(document.mates);
    const group = document.components[0]?.rigidGroupId;
    expect(edited.components.map((component) => component.rigidGroupId)).toEqual([group, group, undefined, group, group]);
    expect(edited.boltedJoints).toEqual([{ id: 'bolted-joint-1', first: PICK_A, second: PICK_B, choices: WITH_WASHER,
      componentIds: ['component-5', 'component-6'] }]);
    // Editing back to the original choices gives a 22 mm bolt again (the record is the only input).
    const back = commitBoltedJointEdit(context(edited), 'bolted-joint-1', ORIGINAL, CATALOG,
      planned(previewBoltedJointEdit(context(edited), 'bolted-joint-1', ORIGINAL, CATALOG)));
    if (!back.ok) throw new Error(JSON.stringify(back));
    expect(back.document.components.slice(3).map((component) => component.source.kind === 'standardPart'
      ? component.source.options.length : null)).toEqual(['22']);
  });

  it('an edit the planner refuses changes nothing and names the planner reason', () => {
    const document = fastened();
    // Engagement 15 > usable 16 - 2 = 14.
    const preview = previewBoltedJointEdit(context(document), 'bolted-joint-1', { ...WITH_WASHER, engagement: 15 }, CATALOG);
    expect(preview.ok ? null : [preview.reason, preview.rejections.map((entry) => entry.code)]).toEqual(['planRejected', ['blindBottoming']]);
    const stale = planned(previewBoltedJointEdit(context(document), 'bolted-joint-1', WITH_WASHER, CATALOG));
    const result = commitBoltedJointEdit(context(document), 'bolted-joint-1', { ...WITH_WASHER, engagement: 15 }, CATALOG, stale);
    expect(result.ok).toBe(false);
    expect(result.document).toBe(document);
  });

  it('a commit whose plan differs from the preview (the user changed a field in between) is refused', () => {
    const document = fastened();
    const previewed = planned(previewBoltedJointEdit(context(document), 'bolted-joint-1', WITH_WASHER, CATALOG));
    const result = commitBoltedJointEdit(context(document), 'bolted-joint-1', ORIGINAL, CATALOG, previewed);
    expect(result.ok ? null : [result.reason, result.rejections.map((entry) => entry.code)]).toEqual(['planRejected', ['staleSource']]);
    expect(result.document).toBe(document);
  });

  it('no record, released group, constrained or missing hardware: explicit reason, document unchanged', () => {
    const document = fastened();
    const originalBefore = JSON.stringify(document);
    const reason = (changed: AssemblyDocument) => {
      const preview = previewBoltedJointEdit(context(changed), 'bolted-joint-1', WITH_WASHER, CATALOG);
      return preview.ok ? 'ok' : preview.reason;
    };
    // A joint made before records existed (or picked through a modeled thread group) has no record.
    const { boltedJoints: _records, ...legacy } = document;
    expect(_records).toHaveLength(1);
    expect(reason(legacy)).toBe('jointRecordMissing');
    // Public release deliberately removes the record as well as group membership, but keeps the hardware and poses.
    const group = document.components[0]?.rigidGroupId ?? '';
    const released = releaseRigidGroup(document, group);
    expect(released.boltedJoints).toEqual([]);
    expect(released.components.map((component) => [component.id, component.placement]))
      .toEqual(document.components.map((component) => [component.id, component.placement]));
    expect(released.components.every((component) => component.rigidGroupId === undefined)).toBe(true);
    expect(reason(released)).toBe('jointRecordMissing');
    // A retained record whose bolt is no longer in the group is a different, still-invalid state.
    const orphaned: AssemblyDocument = { ...document, components: document.components.map((component) =>
      component.id === 'component-4' ? { ...component, rigidGroupId: undefined } : component) };
    expect(orphaned.boltedJoints).toBe(document.boltedJoints);
    expect(reason(orphaned)).toBe('jointPartsChanged');
    // A user mate on the generated bolt would be dropped by replacing it.
    const boltMate: Mate = { id: 'mate-2', name: 'on bolt', kind: 'distance', suppressed: false, flipped: false, value: value(0),
      a: { kind: 'origin', componentId: 'component-4', element: 'xy' }, b: { kind: 'origin', componentId: 'component-3', element: 'xy' } };
    const constrained: AssemblyDocument = { ...document, mates: [...document.mates, boltMate] };
    expect(reason(constrained)).toBe('jointPartsConstrained');
    // Missing hardware with its provenance record retained must not become a missing-record refusal.
    const missingHardware: AssemblyDocument = { ...document,
      components: document.components.filter((component) => component.id !== 'component-4') };
    expect(missingHardware.boltedJoints).toBe(document.boltedJoints);
    expect(reason(missingHardware)).toBe('jointPartsChanged');
    // An empty hardware-id loop must not pass the every(intact) check vacuously.
    const emptyHardware: AssemblyDocument = { ...document,
      boltedJoints: document.boltedJoints?.map((record) => ({ ...record, componentIds: [] })) };
    expect(reason(emptyHardware)).toBe('jointPartsChanged');
    const previewed = planned(previewBoltedJointEdit(context(document), 'bolted-joint-1', WITH_WASHER, CATALOG));
    for (const { changed, expectedReason } of [
      { changed: legacy, expectedReason: 'jointRecordMissing' },
      { changed: released, expectedReason: 'jointRecordMissing' },
      { changed: orphaned, expectedReason: 'jointPartsChanged' },
      { changed: constrained, expectedReason: 'jointPartsConstrained' },
      { changed: missingHardware, expectedReason: 'jointPartsChanged' },
      { changed: emptyHardware, expectedReason: 'jointPartsChanged' },
    ]) {
      const before = JSON.stringify(changed);
      expect(previewBoltedJointEdit(context(changed), 'bolted-joint-1', WITH_WASHER, CATALOG))
        .toEqual({ ok: false, reason: expectedReason, rejections: [] });
      const result = commitBoltedJointEdit(context(changed), 'bolted-joint-1', WITH_WASHER, CATALOG, previewed);
      expect(result).toEqual({ ok: false, document: changed, reason: expectedReason, rejections: [] });
      expect(result.document).toBe(changed);
      expect(JSON.stringify(changed)).toBe(before);
    }
    expect(JSON.stringify(document)).toBe(originalBefore);
    expect(findBoltedJointRecord(document, 'bolted-joint-9')).toBeUndefined();
  });
});
