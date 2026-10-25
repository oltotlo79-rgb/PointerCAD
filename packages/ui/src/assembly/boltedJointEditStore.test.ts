import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  createSubShapeReference, emptyEmbeddedPartAttachments, partKeyOf, resolveAssembly, threadMinorDiameter,
  type AssemblyDocument, type HoleFeature, type MateTarget, type OriginBinding, type PartDocument, type PartLibrary,
  type SolidBody, type SolidFaceEntry, type SubShapeRef, type ThreadHoleFeature,
} from '@pointercad/model';
import { writeAssemblyDocument } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';

import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { deleteAssemblyComponents } from './placeComponentActions.js';

/*
 * Editing a committed flat bolted joint through the real store (EX-06). The fixture is a private copy of
 * boltedJointDraft.test.ts (86077a85) fixtures(): plate A 28 mm with a 9 mm through hole at x 20, plate B with an M8
 * blind tapped hole (drill 20, thread 16); the new-joint default series is main (M8 b1 22).
 * Hand-derived expectations:
 *   create  : grip 28, engagement 12, bottom clearance 2 -> 40 <= L <= 42 -> M8 x 40 (as the existing draft test).
 *   edit    : plain washer M8 (t 1.6) under the head, engagement 10 -> grip 29.6, 39.6 <= L <= 43.6 -> 40; shank 18 <= 29.6.
 *   refused : engagement 15 > usable 16 - 2 = 14 -> blindBottoming; nothing changes.
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
  let document = createAssemblyDocument('締結を直す');
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

/** The recompute publishes the shown shapes for the current document (the plates' bodies are unchanged). */
function republish(view: AssemblyView): void {
  const current = useAppStore.getState().assembly;
  if (current === null) throw new Error('assembly missing');
  useAppStore.setState({ assemblyView: { ...view, sourceDocument: current }, isComputing: false });
}

function hardware(document: AssemblyDocument | null): (readonly [string, string | null])[] {
  return (document?.components ?? []).flatMap((component) => component.source.kind === 'standardPart'
    ? [[component.source.catalog, component.source.options.length ?? null] as const] : []);
}

function committed(): { readonly view: AssemblyView; readonly created: AssemblyDocument } {
  const { document, library, view, picks } = fixtures();
  useAppStore.getState().openAssembly(document, library);
  republish(view);
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  for (const target of picks) expect(useAppStore.getState().pickBoltedJointFace(target)).toBe(true);
  useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12', bottomClearanceSource: '2' });
  expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
  const created = useAppStore.getState().assembly;
  if (created === null) throw new Error('commit failed');
  republish(view);
  return { view, created };
}

beforeEach(() => { resetTestStore(); });

describe('EX-06 editing a committed bolted joint through the store', () => {
  it('creating records the joint; selecting its bolt opens the edit prefilled; cancel changes nothing', () => {
    const { created } = committed();
    expect(hardware(created)).toEqual([['hexBolt', '40']]);
    const record = created.boltedJoints?.[0];
    expect(record?.choices).toEqual({ dimensionSeries: 'main', engagement: 12, blindBottomClearance: 2, minimumProtrusion: 0,
      headWashers: [], nutWashers: [] });
    const boltId = record?.componentIds[0] ?? '';
    useAppStore.getState().setSelection([boltId]);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    expect(useAppStore.getState().assemblyBoltedJointDraft).toMatchObject({ editRecordId: record?.id, picks: [],
      dimensionSeries: 'main', nominal: '', engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '0',
      headWashers: [], nutWashers: [] });
    // The unchanged record previews the same M8 x 40.
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan', result: { ok: true, plan: { boltLength: 40 } } });
    const undo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assembly).toBe(created);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
  });

  it('an edit replaces the hardware in one Undo step; Redo restores the edit; the record keeps the new choices', () => {
    const { view, created } = committed();
    useAppStore.getState().setSelection(['component-1']);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ headWashers: ['plainWasher'], engagementSource: '10' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan',
      result: { ok: true, plan: { boltLength: 40, gripLength: 29.6 } } });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
    const edited = useAppStore.getState().assembly;
    expect(hardware(edited)).toEqual([['plainWasher', null], ['hexBolt', '40']]);
    // The plates are the same components; the old bolt id is not reused by the new parts.
    expect(edited?.components.slice(0, 2)).toEqual(created.components.slice(0, 2));
    const oldBolt = created.boltedJoints?.[0]?.componentIds[0];
    expect(edited?.components.some((component) => component.id === oldBolt)).toBe(false);
    expect(edited?.boltedJoints?.[0]).toMatchObject({ id: created.boltedJoints?.[0]?.id,
      choices: { engagement: 10, headWashers: ['plainWasher'] } });
    expect(edited?.boltedJoints?.[0]?.componentIds).toHaveLength(2);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toEqual(created);
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assembly).toEqual(edited);
    // A refused edit (engagement 15 bottoms out) shows the planner reason and cannot be committed.
    republish(view);
    useAppStore.getState().setSelection(['component-2']);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '15' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan',
      result: { ok: false, rejections: [{ code: 'blindBottoming' }] } });
    const before = useAppStore.getState().assembly;
    const undo = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().commitBoltedJoint()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
  });

  it('the menu entry opens the edit for the selected bolt (the selection is read before the mate draft is cleared)', () => {
    const { created } = committed();
    const boltId = created.boltedJoints?.[0]?.componentIds[0] ?? '';
    useAppStore.getState().setSelection([boltId]);
    chooseAssemblyBuild('boltedJoint');
    expect(useAppStore.getState().assemblyBoltedJointDraft?.editRecordId).toBe(created.boltedJoints?.[0]?.id);
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assembly).toBe(created);
  });

  it('「締結を外す」 drops the record, so selecting the former bolt starts a new joint instead of an edit', () => {
    const { created } = committed();
    const boltId = created.boltedJoints?.[0]?.componentIds[0] ?? '';
    useAppStore.getState().setSelection([boltId]);
    chooseAssemblyBuild('releaseFastening');
    const released = useAppStore.getState().assembly;
    expect(released).not.toBe(created);
    expect(released?.components.every((component) => component.rigidGroupId === undefined)).toBe(true);
    expect(released?.boltedJoints ?? []).toEqual([]);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toEqual(created);
    useAppStore.getState().redoAssembly();
    useAppStore.getState().setSelection([boltId]);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    expect(useAppStore.getState().assemblyBoltedJointDraft?.editRecordId).toBeUndefined();
  });
});

/*
 * EX-06.UNDO through the store with the fixture above. The compared bytes are the file the user would save
 * (writeAssemblyDocument with a fixed savedAt), so "unchanged" covers the whole saved document, not one field.
 * - a new joint is one Undo step back to the exact bytes before it; Redo gives back the exact bytes and the same ids;
 * - refused commits (an M10 bolt in the M8 tapped hole, an engagement that bottoms out, a plan made before plate A's
 *   file changed) and a cancel keep the exact bytes and the same Undo stack;
 * - an edit and a delete of the bolt are one Undo step each back to the exact bytes, and Redo restores bytes and ids.
 */

const SAVED_AT = '2026-10-24T00:00:00.000Z';

function savedBytes(document: AssemblyDocument | null): string {
  if (document === null) throw new Error('assembly missing');
  return writeAssemblyDocument(document, { savedAt: SAVED_AT });
}

function componentIds(document: AssemblyDocument | null): readonly string[] {
  return (document?.components ?? []).map((component) => component.id);
}

/** Opens the fixture as a file would (fresh history), publishes its shapes and picks the four faces of a new joint. */
function pickedNewJoint(): { readonly library: PartLibrary; readonly opened: string } {
  const { document, library, view, picks } = fixtures();
  useAppStore.getState().openAssembly(document, library);
  republish(view);
  const opened = savedBytes(useAppStore.getState().assembly);
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  for (const target of picks) expect(useAppStore.getState().pickBoltedJointFace(target)).toBe(true);
  return { library, opened };
}

/** A refused commit applies nothing: the saved bytes are the same and the Undo stack is the same object. */
function expectRefusedCommit(bytes: string): void {
  const undo = useAppStore.getState().assemblyUndoStack;
  expect(useAppStore.getState().commitBoltedJoint()).toBe(false);
  expect(savedBytes(useAppStore.getState().assembly)).toBe(bytes);
  expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
}

describe('EX-06.UNDO the saved bytes and ids through the store', () => {
  it('a new joint is one Undo step back to the exact bytes; Redo gives back the exact bytes and the same ids', () => {
    const { opened } = pickedNewJoint();
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12', bottomClearanceSource: '2' });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
    const created = useAppStore.getState().assembly;
    const joint = savedBytes(created);
    expect(joint).not.toBe(opened);
    expect(componentIds(created)).toEqual(['component-1', 'component-2', 'component-3']);
    expect(created?.boltedJoints?.map((record) => [record.id, record.componentIds])).toEqual([['bolted-joint-1', ['component-3']]]);
    useAppStore.getState().undoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(opened);
    expect(componentIds(useAppStore.getState().assembly)).toEqual(['component-1', 'component-2']);
    useAppStore.getState().redoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(joint);
    expect(componentIds(useAppStore.getState().assembly)).toEqual(['component-1', 'component-2', 'component-3']);
    expect(useAppStore.getState().assembly?.boltedJoints).toEqual(created?.boltedJoints);
  });

  it('an incompatible bolt, a bottoming engagement, a plan made before the part changed and a cancel keep the exact bytes and the Undo stack', () => {
    const { library, opened } = pickedNewJoint();
    // An M10 bolt in the M8 tapped hole: the planner refuses and the commit changes nothing.
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12', bottomClearanceSource: '2', nominal: 'M10' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan',
      result: { ok: false, rejections: [{ code: 'nominalMismatch' }] } });
    expectRefusedCommit(opened);
    // Engagement 15 > usable thread 16 - 2 = 14: the bolt would bottom out.
    useAppStore.getState().updateBoltedJointDraft({ nominal: '', engagementSource: '15' });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan',
      result: { ok: false, rejections: [{ code: 'blindBottoming' }] } });
    expectRefusedCommit(opened);
    // A valid preview, then plate A's file is imported again with other contents (a new revision) before the commit:
    // the previewed plan no longer matches, so nothing is added and the window shows the current plan instead.
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12' });
    const previewed = useAppStore.getState().assemblyBoltedJointPreview;
    if (previewed?.kind !== 'plan' || !previewed.result.ok) throw new Error(JSON.stringify(previewed));
    useAppStore.setState({ assemblyLibrary: { ...library, partFiles: library.partFiles.map((file) =>
      (file.ref === 'plate-a' ? { ...file, contentHash: 'revision-plate-a-2' } : file)) } });
    expectRefusedCommit(opened);
    const refreshed = useAppStore.getState().assemblyBoltedJointPreview;
    if (refreshed?.kind !== 'plan' || !refreshed.result.ok) throw new Error(JSON.stringify(refreshed));
    expect(refreshed.result.plan.sourceIdentities).not.toEqual(previewed.result.plan.sourceIdentities);
    // Cancelling the draft keeps the exact bytes and the history as well.
    const undo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('a cancelled edit keeps the exact bytes; an edit and a delete of the bolt are one Undo step each back to the exact bytes, and Redo restores bytes and ids', () => {
    const { created } = committed();
    const joint = savedBytes(created);
    useAppStore.getState().setSelection(['component-1']);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '10' });
    const undo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().cancelBoltedJoint();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(joint);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
    // The edit of the test above (plain washer under the head, engagement 10): the washer and the new bolt get new ids.
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ headWashers: ['plainWasher'], engagementSource: '10' });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
    const edited = useAppStore.getState().assembly;
    const editedBytes = savedBytes(edited);
    expect(componentIds(edited)).toEqual(['component-1', 'component-2', 'component-4', 'component-5']);
    useAppStore.getState().undoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(joint);
    expect(componentIds(useAppStore.getState().assembly)).toEqual(['component-1', 'component-2', 'component-3']);
    useAppStore.getState().redoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(editedBytes);
    // Deleting the new bolt drops the record with it (the joint can no longer be edited); the plates and the washer
    // stay in their group. One Undo step returns the exact edited bytes.
    deleteAssemblyComponents(['component-5']);
    const deleted = useAppStore.getState().assembly;
    expect(componentIds(deleted)).toEqual(['component-1', 'component-2', 'component-4']);
    expect(deleted?.boltedJoints ?? []).toEqual([]);
    expect(deleted?.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1', 'fastening-1']);
    useAppStore.getState().undoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(editedBytes);
    useAppStore.getState().redoAssembly();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(savedBytes(deleted));
  });
});
