import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  createSubShapeReference, emptyEmbeddedPartAttachments, partKeyOf, resolveAssembly, threadMinorDiameter,
  type AssemblyDocument, type HoleFeature, type Mate, type MateTarget, type OriginBinding, type PartDocument,
  type PartLibrary, type SolidBody, type SolidFaceEntry, type SubShapeRef, type ThreadHoleFeature,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

/*
 * Refusing to edit a bolted joint that cannot be rebuilt from its record (EX-06), through the real store and menu.
 * The fixture is the same as edit-r1 boltedJointEditStore.test.ts (7454425e): plate A 28 mm with a 9 mm through hole,
 * plate B with an M8 blind tapped hole (drill 20, thread 16); created with engagement 12 and bottom clearance 2 -> M8 x 40.
 *
 * - recordless: a document read from a file saved before records existed has the same parts and group but no
 *   `boltedJoints`. Selecting its bolt and opening the tool must say why it cannot be edited (jointRecordMissing)
 *   instead of silently starting a new joint, and nothing is committed. (Fails on edit-r1 alone: the preview is null.)
 * - constrained: a saved file with a user mate on the generated bolt keeps the record, but replacing the bolt would drop
 *   the mate, so the edit preview is jointPartsConstrained and nothing is committed.
 * - a plate of the recordless joint is not hardware: opening the tool on it starts an ordinary new joint (no issue).
 */

const value = expressionValueFromNumber;
const DRILL = threadMinorDiameter(8, 1.25);

function wall(featureId: string, index: number): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'hole-face', featureId, center: { sketchId: 'centers', producer: { kind: 'point', featureId: `${featureId}-center` } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall',
  } } };
}

function cylinder(index: number, x: number, z: number, radius: number, length: number): SolidFaceEntry {
  return { index, surfaceKind: 'cylinder', area: 2 * Math.PI * radius * length, centroid: [x, 0, z],
    axis: [0, 0, 1], axisOrigin: [x, 0, z], cylinderSpan: [-length / 2, length / 2], cylinderExterior: false,
    radius, triangleOffset: 0, triangleCount: 0 };
}

function body(featureId: string, faces: readonly SolidFaceEntry[], bindings: readonly OriginBinding[]): SolidBody {
  return { featureId, bodyKind: 'solid', volume: 1000, isValid: true, faces: [...faces, {
    index: 2, surfaceKind: 'plane', area: 1000, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
    triangleOffset: 0, triangleCount: 0,
  }], edges: [], vertices: [], threadMarks: [], mesh: { positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), edgePositions: new Float32Array(0), triangleCount: 0 },
  origins: { version: 1, state: 'tracked', bindings: [...bindings, { state: 'unique', current: { kind: 'face', index: 2 },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'plate', role: 'top' } } }] } };
}

function reference(current: SolidBody, index: number): SubShapeRef {
  const found = createSubShapeReference(current, 'face', index);
  if (found === null) throw new Error(`Missing test face ${index}`);
  return found;
}

function fixtures() {
  const first = body('final-a', [cylinder(1, 20, -14, 4.5, 28)], [wall('hole-left', 1)]);
  const second = body('final-b', [cylinder(1, 0, 10, DRILL / 2, 20)], [wall('thread-b', 1)]);
  const hole: HoleFeature = { id: 'hole-left', name: 'hole-left', suppressed: false, kind: 'hole',
    targetFeatureId: 'plate', face: reference(first, 2), centers: [{ sketchId: 'centers', pointFeatureId: 'hole-left-center' }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
  const thread: ThreadHoleFeature = { id: 'thread-b', name: 'M8', suppressed: false, kind: 'threadHole',
    targetFeatureId: 'plate', face: reference(second, 2), centers: [{ sketchId: 'centers', pointFeatureId: 'thread-b-center' }],
    designation: 'M8', series: 'coarse', pitch: value(1.25), drillDiameter: value(DRILL), depth: { kind: 'blind', depth: value(20) },
    threadLength: value(16), representation: 'simplified', tiltAngle: value(0), tiltAzimuth: value(0) };
  const parts = new Map<string, PartDocument>([['plate-a', appendSolid(createEmptyPartDocument(), hole)],
    ['plate-b', appendSolid(createEmptyPartDocument(), thread)]]);
  const library: PartLibrary = { parts, attachments: new Map([...parts.keys()].map(ref => [ref, emptyEmbeddedPartAttachments()])),
    partFiles: [...parts.keys()].map(ref => ({ ref, fileName: `${ref}.pcad`, path: `${ref}.pcad`, contentHash: `revision-${ref}`,
      attachmentsDigest: 'empty', importedAt: '2026-10-01T00:00:00Z' })) };
  let document = createAssemblyDocument('締結を直せない');
  for (const partRef of parts.keys()) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  const keyA = partKeyOf({ kind: 'part', partRef: 'plate-a' });
  const keyB = partKeyOf({ kind: 'part', partRef: 'plate-b' });
  const view: AssemblyView = { sourceDocument: document, resolved: { ...resolveAssembly(document),
    partKeys: new Map([['component-1', keyA], ['component-2', keyB]]) },
  bodies: new Map([[keyA, [first]], [keyB, [second]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
  const pick = (componentId: string, current: SolidBody, index: number): MateTarget =>
    ({ kind: 'subShape', componentId, ref: reference(current, index) });
  const picks = [pick('component-1', first, 1), pick('component-1', first, 2), pick('component-2', second, 1), pick('component-2', second, 2)];
  return { document, library, view, picks };
}

function republish(view: AssemblyView): void {
  const current = useAppStore.getState().assembly;
  if (current === null) throw new Error('assembly missing');
  useAppStore.setState({ assemblyView: { ...view, sourceDocument: current }, isComputing: false });
}

/** Creates the joint through the store, then returns it with the library and view used to reopen variants of it. */
function created(): { readonly document: AssemblyDocument; readonly library: PartLibrary; readonly view: AssemblyView } {
  const { document, library, view, picks } = fixtures();
  useAppStore.getState().openAssembly(document, library);
  republish(view);
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  for (const target of picks) expect(useAppStore.getState().pickBoltedJointFace(target)).toBe(true);
  useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12', bottomClearanceSource: '2' });
  expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
  const joint = useAppStore.getState().assembly;
  if (joint === null) throw new Error('commit failed');
  return { document: joint, library, view };
}

/** Opens a document as a file would (fresh history), publishes its shapes, and selects one component. */
function reopen(document: AssemblyDocument, library: PartLibrary, view: AssemblyView, selected: string): AssemblyDocument {
  useAppStore.getState().openAssembly(document, library);
  republish(view);
  useAppStore.getState().setSelection([selected]);
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('open failed');
  return opened;
}

function boltOf(document: AssemblyDocument): string {
  const bolt = document.components.find((component) => component.source.kind === 'standardPart'
    && component.source.catalog === 'hexBolt');
  if (bolt === undefined) throw new Error('bolt missing');
  return bolt.id;
}

beforeEach(() => { resetTestStore(); });

describe('EX-06 edit refusal for joints that cannot be rebuilt', () => {
  it('a recordless joint (saved before records existed): the menu on its bolt explains, commits nothing, and keeps history', () => {
    const { document, library, view } = created();
    expect(document.boltedJoints).toHaveLength(1);
    const { boltedJoints: _records, ...legacy } = document;
    expect(_records).toHaveLength(1);
    // Same fastened group as the created joint: the plates and the bolt share one rigid group.
    const groups = new Set(legacy.components.map((component) => component.rigidGroupId));
    expect(groups.size).toBe(1);
    expect([...groups][0]).not.toBeUndefined();
    const opened = reopen(legacy, library, view, boltOf(legacy));
    const undo = useAppStore.getState().assemblyUndoStack;
    chooseAssemblyBuild('boltedJoint');
    const draft = useAppStore.getState().assemblyBoltedJointDraft;
    expect(draft).not.toBeNull();
    expect(draft?.editRecordId).toBeUndefined();
    expect(useAppStore.getState().assemblyBoltedJointPreview).toEqual({ kind: 'issue', issue: { kind: 'jointRecordMissing' } });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
  });

  it('a plate of the recordless joint is not hardware: the tool starts an ordinary new joint without an issue', () => {
    const { document, library, view } = created();
    const { boltedJoints: _records, ...legacy } = document;
    expect(_records).toHaveLength(1);
    reopen(legacy, library, view, 'component-1');
    chooseAssemblyBuild('boltedJoint');
    expect(useAppStore.getState().assemblyBoltedJointDraft).toMatchObject({ picks: [] });
    expect(useAppStore.getState().assemblyBoltedJointDraft?.editRecordId).toBeUndefined();
    expect(useAppStore.getState().assemblyBoltedJointPreview).toBeNull();
    useAppStore.getState().cancelBoltedJoint();
  });

  it('a user mate on the generated bolt: the edit opens prefilled but is refused as constrained and commits nothing', () => {
    const { document, library, view } = created();
    const bolt = boltOf(document);
    // A distance mate between the bolt and plate B, as a saved file could hold it.
    const boltMate: Mate = { id: `mate-${String(document.mates.length + 1)}`, name: 'on bolt', kind: 'distance',
      suppressed: false, flipped: false, value: value(0),
      a: { kind: 'origin', componentId: bolt, element: 'xy' }, b: { kind: 'origin', componentId: 'component-2', element: 'xy' } };
    const constrained: AssemblyDocument = { ...document, mates: [...document.mates, boltMate] };
    const opened = reopen(constrained, library, view, bolt);
    const undo = useAppStore.getState().assemblyUndoStack;
    chooseAssemblyBuild('boltedJoint');
    expect(useAppStore.getState().assemblyBoltedJointDraft).toMatchObject({ editRecordId: document.boltedJoints?.[0]?.id,
      engagementSource: '12', bottomClearanceSource: '2' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toEqual({ kind: 'issue', issue: { kind: 'jointPartsConstrained' } });
    // Changing a field still refuses; nothing is committed.
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '10' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toEqual({ kind: 'issue', issue: { kind: 'jointPartsConstrained' } });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
  });
});
