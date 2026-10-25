import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { removeComponent } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { pruneCrossLevelCams, type CrossLevelCamCouplingDefinition } from '../joints/crossLevelCamLifecycle.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { releaseRigidGroup } from '../rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import type { BoltedJointRecord } from './boltedJointEdit.js';

/*
 * A saved cross-level cam and a saved flat bolted-joint record in the same document (EX-06 with the cam lineage).
 * The cam is the crossLevelCamLifecycle.test.ts fixture (parent: fixed `ground`, subassembly placements A on the
 * revolute `cam` and B on `spin`, `rod` on the slider `lift`; child: `base`, `follower` on the slider `push`).
 * The bolted joint is two plates and one bolt in their own rigid group, with the record the commit writes
 * (boltedJointEdit.ts withBoltedJointRecord): picks by face, the user's choices and the generated bolt id.
 * The two relations name disjoint components and joints, so each lifecycle step must change only its own one:
 * - an unrelated delete (`rod`) keeps both, and the cam prune returns the same document;
 * - deleting the bolt drops only the record; releasing the bolt group drops only the record;
 * - deleting the cam's placement A drops joint `cam`, and the prune that every applied edit runs removes cam k1 while
 *   keeping the same record array and the bolt group's owners;
 * - suppressing the cam joint suspends k1 and keeps the record.
 */

function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, extra: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed: false, visible: true, suppressed: false, ...extra };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: kind === 'slider' ? { ...expressionValueFromNumber(25), source: '25' } : null, suppressed: false };
}
const num = (value: number): ExpressionValue => expressionValueFromNumber(value);

function ref(bodyFeatureId: string, index: number): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

const CAM: CrossLevelCamCouplingDefinition = { id: 'k1', kind: 'crossLevelCam', camJointId: 'cam', childPath: ['A'], childJointId: 'push',
  discRadiusMm: num(20), eccentricityMm: num(5), rollerRadiusMm: num(4), phaseDeg: num(30), offsetMm: num(-10),
  direction: -1, suppressed: false };

const RECORD: BoltedJointRecord = {
  id: 'bolted-joint-1',
  first: { componentId: 'plateA', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) },
  second: { componentId: 'plateB', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) },
  choices: { dimensionSeries: 'main', minimumProtrusion: 0, headWashers: [], nutWashers: [] },
  componentIds: ['bolt'],
};

async function fixture() {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const bolt: ComponentSource = { kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
    options: { length: '40', dimensionSeries: 'main', threadSeries: 'coarse' }, catalogRevision: 'fixture', generatorRevision: 'fixture' };
  const child: AssemblyDocument = { ...createAssemblyDocument('cam child'),
    components: [component('base', part, placement(0, 0, 0), { fixed: true }), component('follower', part, placement(0, 0, 0))],
    joints: [joint('push', 'slider', 'follower', 'base')] };
  const subAssemblies = new Map([['child', child]]);
  const document: AssemblyDocument = { ...createAssemblyDocument('cam and bolt'),
    components: [component('ground', part, placement(10, 20, 0), { fixed: true }),
      component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
      component('rod', part, placement(10, 20, 0)),
      component('plateA', part, placement(100, 0, 0), { rigidGroupId: 'rigid-1' }),
      component('plateB', part, placement(100, 0, 10), { rigidGroupId: 'rigid-1' }),
      component('bolt', bolt, placement(100, 0, -4), { rigidGroupId: 'rigid-1' })],
    joints: [joint('cam', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'rod', 'ground')],
    crossLevelCamCouplings: [CAM], boltedJoints: [RECORD] };
  return { document, subAssemblies };
}

function groups(document: AssemblyDocument): Record<string, string | undefined> {
  return Object.fromEntries(document.components.map((entry) => [entry.id, entry.rigidGroupId]));
}

describe('EX-06 bolted-joint record beside a saved cross-level cam', () => {
  it('the fixture is admitted as is: the prune that every applied edit runs returns the same document', async () => {
    const { document, subAssemblies } = await fixture();
    const pruned = pruneCrossLevelCams(document, subAssemblies);
    expect(pruned.repairs).toEqual([]);
    expect(pruned.document).toBe(document);
  });

  it('an unrelated delete keeps the cam and the record (same definitions) and needs no prune', async () => {
    const { document, subAssemblies } = await fixture();
    const edited = removeComponent(document, 'rod');
    expect(edited.components.map((entry) => entry.id)).toEqual(['ground', 'A', 'plateA', 'plateB', 'bolt']);
    expect(edited.joints.map((entry) => entry.id)).toEqual(['cam']);
    expect(edited.crossLevelCamCouplings).toBe(document.crossLevelCamCouplings);
    expect(edited.boltedJoints).toEqual([RECORD]);
    expect(edited.boltedJoints?.[0]).toBe(RECORD);
    expect(groups(edited)).toEqual({ ground: undefined, A: undefined, plateA: 'rigid-1', plateB: 'rigid-1', bolt: 'rigid-1' });
    const pruned = pruneCrossLevelCams(edited, subAssemblies);
    expect(pruned.repairs).toEqual([]);
    expect(pruned.document).toBe(edited);
  });

  it('deleting the bolt or releasing its group drops only the record; the cam stays untouched', async () => {
    const { document, subAssemblies } = await fixture();
    const withoutBolt = removeComponent(document, 'bolt');
    expect(withoutBolt.boltedJoints).toEqual([]);
    expect(withoutBolt.crossLevelCamCouplings).toBe(document.crossLevelCamCouplings);
    expect(withoutBolt.joints.map((entry) => entry.id)).toEqual(['cam', 'lift']);
    expect(pruneCrossLevelCams(withoutBolt, subAssemblies).document).toBe(withoutBolt);
    const released = releaseRigidGroup(document, 'rigid-1');
    expect(released.boltedJoints).toEqual([]);
    expect(released.crossLevelCamCouplings).toBe(document.crossLevelCamCouplings);
    expect(released.components.every((entry) => entry.rigidGroupId === undefined)).toBe(true);
    expect(pruneCrossLevelCams(released, subAssemblies).document).toBe(released);
  });

  it('deleting the cam placement removes the cam in the prune and keeps the record and the bolt group owners', async () => {
    const { document, subAssemblies } = await fixture();
    const edited = removeComponent(document, 'A');
    // removeComponent drops the joint on A, not the cam definition (that is the prune's job).
    expect(edited.joints.map((entry) => entry.id)).toEqual(['lift']);
    expect(edited.crossLevelCamCouplings).toEqual([CAM]);
    const pruned = pruneCrossLevelCams(edited, subAssemblies);
    expect(pruned.repairs).toHaveLength(1);
    expect(pruned.repairs[0]).toMatchObject({ couplingId: 'k1', action: 'removed' });
    expect(pruned.document.crossLevelCamCouplings).toEqual([]);
    expect(pruned.document.boltedJoints).toBe(edited.boltedJoints);
    expect(pruned.document.boltedJoints?.[0]).toBe(RECORD);
    expect(groups(pruned.document)).toEqual({ ground: undefined, rod: undefined, plateA: 'rigid-1', plateB: 'rigid-1', bolt: 'rigid-1' });
  });

  it('suppressing the cam joint suspends the cam and keeps the record', async () => {
    const { document, subAssemblies } = await fixture();
    const suppressed = { ...document, joints: document.joints.map((entry) => entry.id === 'cam' ? { ...entry, suppressed: true } : entry) };
    const pruned = pruneCrossLevelCams(suppressed, subAssemblies);
    expect(pruned.repairs).toEqual([{ couplingId: 'k1', code: 'missing-parent-joint', action: 'suspended' }]);
    expect(pruned.document.crossLevelCamCouplings?.map((entry) => [entry.id, entry.suppressed])).toEqual([['k1', true]]);
    expect(pruned.document.boltedJoints).toBe(document.boltedJoints);
    expect(pruned.document.components).toBe(document.components);
  });
});
