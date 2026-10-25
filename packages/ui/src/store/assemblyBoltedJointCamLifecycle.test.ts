import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { readAssemblyDocument, writeAssemblyDocument } from '@pointercad/io';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  type AssemblyComponent, type AssemblyDocument, type BoltedJointRecord, type ComponentSource,
  type CrossLevelCamCouplingDefinition, type Joint, type PartLibrary, type Placement, type PrimitiveFeature, type SubShapeRef,
} from '@pointercad/model';
import { deleteAssemblyComponents } from '../assembly/placeComponentActions.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * A saved cross-level cam and a saved flat bolted-joint record in one document, through the public delete action, the
 * store's apply (which prunes cross-level couplings on every edit) and Undo/Redo, then save and reopen (EX-06 with the
 * cam lineage). The cam is the assemblyCrossLevelCam.test.ts law (k1: cam -> A/push, R 20, e 5, r 4); the bolted joint
 * is two plates and one bolt in their own rigid group with the record a commit writes. The relations name disjoint
 * components and joints, so:
 * - deleting the unrelated `rod` keeps both relations and reports no repair;
 * - deleting the cam placement A removes k1 in the same Undo step (repair "removed") and keeps the record and the group;
 * - deleting the bolt drops only the record; the cam stays;
 * - each result survives save and reopen with the same relations.
 */

function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, extra: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed: false, visible: true, suppressed: false, ...extra };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string, max: ExpressionValue | null = null): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: max, suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
function ref(bodyFeatureId: string, index: number): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

const K1: CrossLevelCamCouplingDefinition = { id: 'k1', kind: 'crossLevelCam', camJointId: 'cam', childPath: ['A'], childJointId: 'push',
  discRadiusMm: expression('20', 20), eccentricityMm: expression('5', 5), rollerRadiusMm: expression('4', 4),
  phaseDeg: expression('0', 0), offsetMm: expression('-10', -10), direction: 1, suppressed: false };

const RECORD: BoltedJointRecord = {
  id: 'bolted-joint-1',
  first: { componentId: 'plateA', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) },
  second: { componentId: 'plateB', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) },
  choices: { dimensionSeries: 'main', minimumProtrusion: 0, headWashers: [], nutWashers: [] },
  componentIds: ['bolt'],
};

const store = () => useAppStore.getState();
let library: PartLibrary = EMPTY_PART_LIBRARY;

async function open(): Promise<AssemblyDocument> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const bolt: ComponentSource = { kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
    options: { length: '40', dimensionSeries: 'main', threadSeries: 'coarse' }, catalogRevision: 'fixture', generatorRevision: 'fixture' };
  const camChild: AssemblyDocument = { ...createAssemblyDocument('camChild'),
    components: [component('base', part, placement(0, 0, 0), { fixed: true }), component('follower', part, placement(0, 0, 0))],
    joints: [joint('push', 'slider', 'follower', 'base', expression('25', 25))] };
  library = { ...embedded.library, assemblies: new Map([['camChild', camChild]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('cam and bolt'),
    components: [component('ground', part, placement(10, 20, 0), { fixed: true }),
      component('A', { kind: 'subAssembly', assemblyRef: 'camChild' }, placement(10, 20, 0)),
      component('rod', part, placement(10, 20, 0)),
      component('plateA', part, placement(100, 0, 0), { rigidGroupId: 'rigid-1' }),
      component('plateB', part, placement(100, 0, 10), { rigidGroupId: 'rigid-1' }),
      component('bolt', bolt, placement(100, 0, -4), { rigidGroupId: 'rigid-1' })],
    joints: [joint('cam', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'rod', 'ground')],
    crossLevelCamCouplings: [K1], boltedJoints: [RECORD] };
  store().openAssembly(document, library);
  const opened = store().assembly;
  if (opened === null) throw new Error('open failed');
  return opened;
}

function reopen(document: AssemblyDocument | null): AssemblyDocument {
  if (document === null) throw new Error('document missing');
  const read = readAssemblyDocument(writeAssemblyDocument(document, { savedAt: '2026-10-19T00:00:00.000Z' }));
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}

function groups(document: AssemblyDocument | null): Record<string, string | undefined> {
  return Object.fromEntries((document?.components ?? []).map((entry) => [entry.id, entry.rigidGroupId]));
}

beforeEach(() => { resetTestStore(); });

describe('EX-06 bolted-joint record beside a saved cross-level cam in the store', () => {
  it('the opened document keeps both relations and they survive save and reopen', async () => {
    const opened = await open();
    expect(opened.crossLevelCamCouplings).toEqual([K1]);
    expect(opened.boltedJoints).toEqual([RECORD]);
    const reread = reopen(opened);
    expect(reread.crossLevelCamCouplings).toEqual([K1]);
    expect(reread.boltedJoints).toEqual([RECORD]);
  });

  it('deleting an unrelated part keeps the cam and the record and reports no repair; Undo restores the document', async () => {
    const opened = await open();
    deleteAssemblyComponents(['rod']);
    const after = store().assembly;
    expect(after?.components.map((entry) => entry.id)).toEqual(['ground', 'A', 'plateA', 'plateB', 'bolt']);
    expect(after?.crossLevelCamCouplings).toEqual([K1]);
    expect(after?.boltedJoints).toEqual([RECORD]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([]);
    store().undoAssembly();
    expect(store().assembly).toBe(opened);
  });

  it('deleting the cam placement removes the cam in the same Undo step and keeps the record and its group', async () => {
    const opened = await open();
    deleteAssemblyComponents(['A']);
    const after = store().assembly;
    expect(after?.components.map((entry) => entry.id)).toEqual(['ground', 'rod', 'plateA', 'plateB', 'bolt']);
    expect(after?.crossLevelCamCouplings ?? []).toEqual([]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([expect.objectContaining({ couplingId: 'k1', action: 'removed' })]);
    expect(after?.boltedJoints).toEqual([RECORD]);
    expect(groups(after)).toEqual({ ground: undefined, rod: undefined, plateA: 'rigid-1', plateB: 'rigid-1', bolt: 'rigid-1' });
    const reread = reopen(after);
    expect(reread.crossLevelCamCouplings ?? []).toEqual([]);
    expect(reread.boltedJoints).toEqual([RECORD]);
    store().undoAssembly();
    expect(store().assembly).toBe(opened);
    store().redoAssembly();
    expect(store().assembly?.crossLevelCamCouplings ?? []).toEqual([]);
    expect(store().assembly?.boltedJoints).toEqual([RECORD]);
  });

  it('deleting the bolt drops only the record; the cam stays and reopens', async () => {
    const opened = await open();
    deleteAssemblyComponents(['bolt']);
    const after = store().assembly;
    expect(after?.boltedJoints ?? []).toEqual([]);
    expect(after?.crossLevelCamCouplings).toEqual([K1]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([]);
    const reread = reopen(after);
    expect(reread.crossLevelCamCouplings).toEqual([K1]);
    expect(reread.boltedJoints ?? []).toEqual([]);
    store().undoAssembly();
    expect(store().assembly).toBe(opened);
  });
});
