import { expressionValueFromNumber } from '@pointercad/expression';
import { readAssemblyDocument, writeAssemblyDocument } from '@pointercad/io';
import {
  absoluteCoordinate, appendFeature, appendSolid, buildStandardPartFromSource, createAssemblyDocument, createEmptyPartDocument,
  createPointFeature, createSubShapeReference, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY, replaceSketch,
  resolveAssembly, weldSegmentsOf,
  type AssemblyComponent, type AssemblyDocument, type HoleFaceOrigin, type HoleFeature, type PartLibrary, type Placement,
  type PrimitiveFeature, type SolidBody, type SubShapeRef,
} from '@pointercad/model';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_BOX, STANDING_BOX, weldTestPlacement } from '../../../model/src/assembly/welding/filletWeld.testSupport.js';
import { t } from '../i18n/t.js';
import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry, type AssemblyOccurrencePath } from '../viewport/createAssemblyLayer.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { BoltedJointPopover } from './BoltedJointPopover.js';
import { FilletWeldPopover } from './FilletWeldPopover.js';

interface FormProps {
  readonly children?: React.ReactNode;
  readonly 'data-testid'?: string;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
}

/** Render a real popover and collect its fields and submit handler (no preview, command or commit is replaced). */
function rendered(popover: () => React.JSX.Element | null) {
  const fields = new Map<string, FormProps>();
  let onSubmit: FormProps['onSubmit'];
  const walk = (node: React.ReactNode): void => {
    if (!isValidElement<FormProps>(node)) return;
    if (node.props.onSubmit !== undefined) onSubmit = node.props.onSubmit;
    const id = node.props['data-testid'];
    if (id !== undefined) fields.set(id, node.props);
    React.Children.forEach(node.props.children, walk);
  };
  function Host(): React.JSX.Element | null {
    const tree = popover();
    walk(tree);
    return tree;
  }
  const html = renderToStaticMarkup(<Host />);
  if (onSubmit === undefined) throw new Error('Form submit handler is missing');
  return { html, onSubmit, fields };
}

function submit(popover: () => React.JSX.Element | null): void {
  const preventDefault = vi.fn();
  rendered(popover).onSubmit({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
}

function typeWeld(id: string, value: string): void {
  const onChange = rendered(FilletWeldPopover).fields.get(id)?.onChange;
  if (onChange === undefined) throw new Error(`Field is missing: ${id}`);
  onChange({ currentTarget: { value } });
}

const value = expressionValueFromNumber;
/** Two occurrences of one reused child assembly; ids keep separators and quotes so paths are never split from display strings. */
const A = 'A/child,"1', B = 'B/child,"2';
const flipped: Placement = { position: [value(0), value(20), value(0)], rotation: [1, 0, 0, 0] };
const BOLT_FIRST: AssemblyOccurrencePath = [A, 'plate'];
const BOLT_SECOND: AssemblyOccurrencePath = [B, 'plate'];
const WELD_FIRST: AssemblyOccurrencePath = [A, 'standing'];
const WELD_SECOND: AssemblyOccurrencePath = ['base'];

function boxPart(name: string, x: number, y: number, z: number) {
  const feature: PrimitiveFeature = { id: 'extrude-1', name, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(x), sizeY: value(y), sizeZ: value(z) } };
  return appendSolid(createEmptyPartDocument(), feature);
}

/** r16 plate: 40 x 20 x 10 at z -10..0 with a 9 mm through hole at (20, 10), and its tracked solved body. */
function plate() {
  let part = createEmptyPartDocument();
  const sketch = part.sketches[0];
  if (sketch === undefined) throw new Error('initial sketch');
  const point = createPointFeature(sketch, absoluteCoordinate(20, 10, 0));
  part = replaceSketch(part, appendFeature(sketch, point));
  const base: PrimitiveFeature = { id: 'base-1', name: 'plate', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -10) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(40), sizeY: value(20), sizeZ: value(10) } };
  const entry: SubShapeRef = { bodyFeatureId: base.id, index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 800, position: [20, 10, 0], axis: [0, 0, 1], radius: null } };
  const hole: HoleFeature = { id: 'hole-1', name: 'clearance', kind: 'hole', suppressed: false,
    targetFeatureId: base.id, face: entry, centers: [{ sketchId: sketch.id, pointFeatureId: point.id }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
  const origin: HoleFaceOrigin = { kind: 'hole-face', featureId: hole.id,
    center: { sketchId: sketch.id, producer: { kind: 'point', featureId: point.id } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' };
  const body: SolidBody = { featureId: hole.id, bodyKind: 'solid', isValid: true, volume: 8000 - 202.5 * Math.PI,
    faces: [
      { index: 0, surfaceKind: 'plane', area: 800, centroid: [20, 10, -10], axis: [0, 0, -1], radius: null,
        triangleOffset: 0, triangleCount: 0 },
      { index: 1, surfaceKind: 'cylinder', area: 90 * Math.PI, centroid: [20, 10, -5], axis: [0, 0, 1],
        axisOrigin: [20, 10, -5], cylinderSpan: [-5, 5], cylinderExterior: false, radius: 4.5,
        triangleOffset: 0, triangleCount: 0 },
      { index: 2, surfaceKind: 'plane', area: 800, centroid: [20, 10, 0], axis: [0, 0, 1], radius: null,
        triangleOffset: 0, triangleCount: 0 },
    ], edges: [], vertices: [], threadMarks: [],
    mesh: { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
      edgePositions: new Float32Array(0), triangleCount: 0 },
    origins: { version: 1, state: 'tracked', bindings: [
      { state: 'unique', current: { kind: 'face', index: 1 }, origin: { version: 1, shapeKind: 'face', identity: origin } },
      { state: 'unique', current: { kind: 'face', index: 2 }, origin: { version: 1, shapeKind: 'face',
        identity: { kind: 'box-face', featureId: base.id, role: 'top' } } },
    ] } };
  return { part: appendSolid(appendSolid(part, base), hole), body };
}

function withEdgeSegments(body: SolidBody): SolidBody {
  return { ...body, edges: body.edges.map((edge, index) => ({ ...edge, segmentOffset: index, segmentCount: 1 })),
    mesh: { ...body.mesh, edgePositions: new Float32Array(body.edges.flatMap((edge) => [...edge.start, ...edge.end])) } };
}

/** Child 'child' (leaves 'plate' and 'standing') reused by occurrences A and B; root leaf 'base' carries the weld. */
async function openLifecycle() {
  const plateFixture = plate();
  const standingPart = boxPart('standing', 100, 8, 50), basePart = boxPart('base', 100, 60, 10);
  const plateEmbedded = await embedPart(EMPTY_PART_LIBRARY, plateFixture.part, 'plate.pcad', 'plate.pcad');
  const standing = await embedPart(plateEmbedded.library, standingPart, 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, basePart, 'b.pcad', 'b.pcad');
  const leaf = (id: string, partRef: string, placement: Placement): AssemblyComponent => ({
    id, name: id, source: { kind: 'part', partRef }, placement, fixed: false, visible: true, suppressed: false });
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [
    leaf('plate', plateEmbedded.partRef, DEFAULT_COMPONENT_PLACEMENT), leaf('standing', standing.partRef, weldTestPlacement([0, 26, 10]))] };
  const owner = (id: string, placement: Placement): AssemblyComponent => ({ id, name: id, placement,
    source: { kind: 'subAssembly', assemblyRef: 'child' }, fixed: false, visible: true, suppressed: false });
  const document: AssemblyDocument = { ...createAssemblyDocument('root'), components: [
    owner(A, DEFAULT_COMPONENT_PLACEMENT), owner(B, flipped), leaf('base', base.partRef, DEFAULT_COMPONENT_PLACEMENT)] };
  const library: PartLibrary = { ...base.library, assemblies: new Map([['child', child]]) };
  useAppStore.getState().openAssembly(document, library);
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('Opened assembly missing');
  const sourceObjects = [child, plateFixture.part, standingPart, basePart] as const;
  return { opened, child, plateBody: plateFixture.body, sourceObjects, sources: JSON.stringify(sourceObjects), siblingB: opened.components[1] };
}

/** Publish the solved view of the current store document with the production standard-part resolver. */
function publishSolvedView(plateBody: SolidBody): ReadonlyMap<string, string> {
  const state = useAppStore.getState();
  const document = state.assembly;
  if (document === null) throw new Error('Assembly is missing');
  const source = jointOccurrenceInputsOf(document, state.assemblyLibrary);
  const resolved = resolveAssembly(document, { library: state.assemblyLibrary, subAssemblies: source.subAssemblies,
    standardPart: buildStandardPartFromSource });
  expect(resolved.errors).toEqual([]);
  const flat = flattenAssemblyGeometry(document, resolved);
  const keys = new Map<string, string>();
  for (const component of flat.components) {
    const path = flat.occurrencePaths?.get(component.id);
    const key = flat.partKeys.get(component.id);
    if (path !== undefined && path !== null && key !== undefined) keys.set(JSON.stringify(path), key);
  }
  const key = (path: AssemblyOccurrencePath): string => {
    const found = keys.get(JSON.stringify(path));
    if (found === undefined) throw new Error(`Leaf part is missing: ${JSON.stringify(path)}`);
    return found;
  };
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document, source, resolved,
    bodies: new Map([[key(BOLT_FIRST), [plateBody]], [key(WELD_FIRST), [withEdgeSegments(STANDING_BOX)]],
      [key(WELD_SECOND), [withEdgeSegments(BASE_BOX)]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  return keys;
}

function faceRef(body: SolidBody, index: number): SubShapeRef {
  const ref = createSubShapeReference(body, 'face', index);
  if (ref === null) throw new Error('face reference');
  return ref;
}

function weldRef(body: SolidBody, kind: 'face' | 'edge', index: number): SubShapeRef {
  const ref = subShapeRefOf([withEdgeSegments(body)], subShapeElementId('extrude-1', kind, index));
  if (ref === null) throw new Error(`Cannot create subshape reference: ${kind} ${String(index)}`);
  return ref;
}

/** Nested M8 bolt between the two plate occurrences through the real store and bolt popover. */
function createBolt(plateBody: SolidBody, keys: ReadonlyMap<string, string>): AssemblyDocument {
  const plateKey = keys.get(JSON.stringify(BOLT_FIRST));
  if (plateKey === undefined) throw new Error('plate key');
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
    engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
  for (const [path, index] of [[BOLT_FIRST, 1], [BOLT_FIRST, 2], [BOLT_SECOND, 1], [BOLT_SECOND, 2]] as const) {
    expect(useAppStore.getState().pickNestedBoltedJointTarget({ kind: 'jointOccurrence', path, partKey: plateKey,
      ref: faceRef(plateBody, index) })).toBe(true);
  }
  const ready = useAppStore.getState().assemblyNestedBoltPreview;
  if (ready?.kind !== 'plan' || !ready.result.ok) throw new Error(JSON.stringify(ready));
  // Two 10 mm plates: grip 20, M8 bolt length 30.
  expect([ready.result.plan.nominal, ready.result.plan.boltLength, ready.result.plan.gripLength]).toEqual(['M8', 30, 20]);
  submit(BoltedJointPopover);
  const bolted = useAppStore.getState().assembly;
  if (bolted === null) throw new Error('Bolted assembly is missing');
  return bolted;
}

/** Nested fillet weld from occurrence A's standing plate to the root base (Root72 path: legs 6 x 8, start 10, length 20). */
function createWeld(): AssemblyDocument {
  chooseAssemblyBuild('filletWeld');
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: WELD_FIRST, ref: weldRef(STANDING_BOX, 'face', 3) })).toBe(true);
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: WELD_FIRST, ref: weldRef(STANDING_BOX, 'edge', 2) })).toBe(true);
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: WELD_SECOND, ref: weldRef(BASE_BOX, 'face', 5) })).toBe(true);
  typeWeld('fillet-weld-leg-second', '6');
  typeWeld('fillet-weld-leg-first', '8');
  typeWeld('fillet-weld-start', '10');
  typeWeld('fillet-weld-lengths', '20');
  typeWeld('fillet-weld-material', 'aluminum');
  const created = useAppStore.getState().assemblyNestedWeldPreview;
  if (created?.kind !== 'plan' || !created.result.ok) throw new Error(JSON.stringify(created));
  // 6 x 8 / 2 x 20 = 480 mm3.
  expect(created.result.plan.nominalVolume).toBe(480);
  submit(FilletWeldPopover);
  const welded = useAppStore.getState().assembly;
  if (welded === null) throw new Error('Welded assembly is missing');
  return welded;
}

function beadOf(document: AssemblyDocument) {
  const bead = weldSegmentsOf(document).get('weld-1')?.[0];
  if (bead === undefined) throw new Error('Weld bead is missing');
  return bead;
}

function positions(document: AssemblyDocument, ids: readonly string[]): number[][] {
  return ids.map((id) => {
    const component = document.components.find((item) => item.id === id);
    if (component === undefined) throw new Error(`Component missing: ${id}`);
    return component.placement.position.map((entry) => entry.value);
  });
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('nested bolt and weld lifecycle on occurrences of one reused child assembly', () => {
  it('creates, edits, saves, reopens and removes only the intended association with exact Undo/Redo', async () => {
    const f = await openLifecycle();
    const keys = publishSolvedView(f.plateBody);

    const bolted = createBolt(f.plateBody, keys);
    const boltIds = bolted.components.filter((component) => !f.opened.components.some((old) => old.id === component.id))
      .map((component) => component.id);
    // Bolt head below occurrence A's plate (z -10), nut above occurrence B's flipped plate (z 10).
    expect(positions(bolted, boltIds)).toEqual([[20, 10, -10], [20, 10, 10]]);
    const boltConnection = { kind: 'bolt', firstPath: BOLT_FIRST, secondPath: BOLT_SECOND, componentIds: boltIds };
    expect(bolted.jointOccurrenceConnections).toEqual([boltConnection]);

    publishSolvedView(f.plateBody);
    const welded = createWeld();
    const bead = beadOf(welded);
    expect(bead.source.kind === 'standardPart' ? bead.source.size : null).toBe('6x8');
    // Weld line origin (0, 34, 10) plus start 10 along x.
    expect(bead.placement.position.map((entry) => entry.value)).toEqual([10, 34, 10]);
    const weldConnection = { kind: 'weld', firstPath: WELD_FIRST, secondPath: WELD_SECOND, componentIds: [bead.id] };
    expect(welded.jointOccurrenceConnections).toEqual([boltConnection, weldConnection]);
    expect(positions(welded, boltIds)).toEqual([[20, 10, -10], [20, 10, 10]]);

    // Edit only the weld: legs 6 x 4 -> 240 mm3; the bolt association and parts stay identical.
    useAppStore.getState().setSelection([bead.id]);
    publishSolvedView(f.plateBody);
    chooseAssemblyBuild('filletWeld');
    typeWeld('fillet-weld-leg-first', '4');
    const changed = useAppStore.getState().assemblyNestedWeldPreview;
    if (changed?.kind !== 'edit' || !changed.result.ok) throw new Error(JSON.stringify(changed));
    expect(changed.result.plan.nominalVolume).toBe(240);
    submit(FilletWeldPopover);
    const edited = useAppStore.getState().assembly;
    if (edited === null || edited === welded) throw new Error('Edit commit did not change the assembly');
    const editedBead = beadOf(edited);
    expect(editedBead.id).not.toBe(bead.id);
    expect(editedBead.source.kind === 'standardPart' ? editedBead.source.size : null).toBe('6x4');
    expect(editedBead.placement.position.map((entry) => entry.value)).toEqual([10, 34, 10]);
    expect(edited.jointOccurrenceConnections).toEqual([boltConnection,
      { kind: 'weld', firstPath: WELD_FIRST, secondPath: WELD_SECOND, componentIds: [editedBead.id] }]);
    expect(boltIds.map((id) => edited.components.find((component) => component.id === id)))
      .toEqual(boltIds.map((id) => welded.components.find((component) => component.id === id)));
    // The nested bolt rigidly joins both motion owners (A and B) with its generated parts (jointOccurrenceSelection
    // appendJointOccurrenceComponents -> joinRigidGroup); the weld joins A's existing group, and the weld edit never
    // touches B. So B differs from the opened occurrence by exactly that one rigid-group id and nothing else.
    expect(f.siblingB).not.toHaveProperty('rigidGroupId');
    const boltGroup = bolted.components.find((component) => component.id === boltIds[0])?.rigidGroupId;
    if (boltGroup === undefined || !boltGroup.startsWith('fastening-')) throw new Error(`bolt rigid group: ${String(boltGroup)}`);
    expect(bolted.components.filter((component) => component.rigidGroupId === boltGroup).map((component) => component.id))
      .toEqual([A, B, ...boltIds]);
    expect(welded.components.filter((component) => component.rigidGroupId === boltGroup).map((component) => component.id))
      .toEqual([A, B, 'base', ...boltIds, bead.id]);
    const expectedB = { ...f.siblingB, rigidGroupId: boltGroup };
    expect(bolted.components[1]).toEqual(expectedB);
    expect(welded.components[1]).toEqual(expectedB);
    expect(edited.components[1]).toEqual(expectedB);

    // Undo walks back edit -> weld -> bolt to the opened document; Redo restores each step.
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(welded);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(bolted);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.opened);
    useAppStore.getState().redo();
    useAppStore.getState().redo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);

    // Save and parse through the real IO; associations and placements survive exactly.
    const text = writeAssemblyDocument(edited, { savedAt: '2026-10-16T00:00:00.000Z' });
    const parsed = readAssemblyDocument(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    expect(parsed.document.jointOccurrenceConnections).toEqual(edited.jointOccurrenceConnections);
    expect(positions(parsed.document, [...boltIds, editedBead.id])).toEqual([[20, 10, -10], [20, 10, 10], [10, 34, 10]]);
    const library = useAppStore.getState().assemblyLibrary;
    useAppStore.getState().openAssembly(parsed.document, library);
    const reopened = useAppStore.getState().assembly;
    if (reopened === null) throw new Error('Reopened assembly missing');
    publishSolvedView(f.plateBody);

    // Remove only the weld after reopening; the bolt survives; Undo/Redo restore exactly.
    useAppStore.getState().setSelection([beadOf(reopened).id]);
    publishSolvedView(f.plateBody);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().removeFilletWeldDraft()).toBe(true);
    const removed = useAppStore.getState().assembly;
    if (removed === null) throw new Error('Removed assembly missing');
    expect(removed.jointOccurrenceConnections).toEqual([boltConnection]);
    expect(removed.components.map((component) => component.id)).toEqual([A, B, 'base', ...boltIds]);
    expect(positions(removed, boltIds)).toEqual([[20, 10, -10], [20, 10, 10]]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(reopened);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(removed);

    // Shared child assembly and source parts are never modified by any step.
    expect(JSON.stringify(f.sourceObjects)).toBe(f.sources);
    expect(useAppStore.getState().assemblyLibrary.assemblies?.get('child')).toBe(f.child);
  });

  it('refuses stale and suppressed occurrences without mutation, and cancel leaves document and history unchanged', async () => {
    const f = await openLifecycle();
    const keys = publishSolvedView(f.plateBody);
    const plateKey = keys.get(JSON.stringify(BOLT_FIRST));
    if (plateKey === undefined) throw new Error('plate key');
    const initialUndo = useAppStore.getState().assemblyUndoStack;

    // Cancel after one pick.
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    expect(useAppStore.getState().pickNestedBoltedJointTarget({ kind: 'jointOccurrence', path: BOLT_FIRST, partKey: plateKey,
      ref: faceRef(f.plateBody, 1) })).toBe(true);
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assemblyNestedBoltDraft).toBeNull();
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
    expect(useAppStore.getState().assembly).toBe(f.opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);

    // Stale: the attachment revision changes after the preview; confirm refuses and explains in the locale text.
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
      engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
    for (const [path, index] of [[BOLT_FIRST, 1], [BOLT_FIRST, 2], [BOLT_SECOND, 1], [BOLT_SECOND, 2]] as const) {
      expect(useAppStore.getState().pickNestedBoltedJointTarget({ kind: 'jointOccurrence', path, partKey: plateKey,
        ref: faceRef(f.plateBody, index) })).toBe(true);
    }
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    const library = useAppStore.getState().assemblyLibrary;
    const changed = { ...library, partFiles: library.partFiles.map((file) => ({ ...file, attachmentsDigest: 'changed' })) };
    useAppStore.setState({ assemblyView: { ...view, source: jointOccurrenceInputsOf(f.opened, changed) } });
    submit(BoltedJointPopover);
    expect(useAppStore.getState().assembly).toBe(f.opened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
    expect(rendered(BoltedJointPopover).html).toContain(t('assembly.boltedJoint.nested.occurrence'));
    useAppStore.getState().cancelBoltedJoint();

    // Suppressed sibling occurrence B: the nested bolt cannot be planned and nothing changes.
    const suppressed: AssemblyDocument = { ...f.opened,
      components: f.opened.components.map((component) => component.id === B ? { ...component, suppressed: true } : component) };
    useAppStore.getState().openAssembly(suppressed, library);
    const reopened = useAppStore.getState().assembly;
    if (reopened === null) throw new Error('Reopened assembly missing');
    publishSolvedView(f.plateBody);
    const suppressedUndo = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
      engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
    for (const [path, index] of [[BOLT_FIRST, 1], [BOLT_FIRST, 2], [BOLT_SECOND, 1], [BOLT_SECOND, 2]] as const) {
      useAppStore.getState().pickNestedBoltedJointTarget({ kind: 'jointOccurrence', path, partKey: plateKey, ref: faceRef(f.plateBody, index) });
    }
    expect(useAppStore.getState().assemblyNestedBoltPreview?.kind).not.toBe('plan');
    submit(BoltedJointPopover);
    expect(useAppStore.getState().assembly).toBe(reopened);
    expect(useAppStore.getState().assemblyUndoStack).toBe(suppressedUndo);
    expect(JSON.stringify(f.sourceObjects)).toBe(f.sources);
  });
});
