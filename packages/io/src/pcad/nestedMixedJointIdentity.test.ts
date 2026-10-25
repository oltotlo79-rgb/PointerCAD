/**
 * EX-01: one nested assembly holds a weld (tee child, repeated as A and B) and a bolt (plate child, repeated as P
 * and Q). Through the actual occurrence commands, a weld edit, save/reopen and Undo/Redo, each connection stays on
 * its intended occurrence. Expected paths, IDs and world coordinates are literals derived from the fixture by hand.
 */
import { expressionValueFromNumber as value } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, appendSolid, buildStandardPartFromSource, commitOccurrenceBoltedJoint,
  commitOccurrenceFilletWeld, commitOccurrenceFilletWeldEdit, createAssemblyDocument, createEmptyPartDocument,
  createPointFeature, createUndoStack, createAssemblyDocumentBundle, partLibraryOfBundle, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY,
  filletWeldSegmentOptions, previewOccurrenceBoltedJoint, previewOccurrenceFilletWeld, previewOccurrenceFilletWeldEdit,
  pushUndo, redo, replaceSketch, resolveAssembly, undo,
  type AssemblyComponent, type AssemblyDocument, type BoltedJointChoices, type FilletWeldEditRequest, type HoleFeature,
  type JointOccurrenceCommandContext, type JointOccurrenceConnection, type OccurrenceHolePick, type OccurrenceWeldPicks,
  type PartLibrary, type Placement, type PrimitiveFeature, type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { BASE_BOX, STANDING_BOX, teeRequest, weldTestPlacement } from '../../../model/src/assembly/welding/filletWeld.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

const A = 'a/溶接,"α', B = 'b/溶接,"β', P = 'p/締結:[]', Q = 'q/締結:"二"';
/** The weld pair is lifted by 200 in Z so its beads cannot be confused with the bolt seats near the origin. */
const LIFT = 200;

function owner(id: string, assemblyRef: string, placement: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'subAssembly', assemblyRef }, placement, fixed, visible: true, suppressed: false };
}
function leaf(id: string, partRef: string, placement: Placement): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef }, placement, fixed: false, visible: true, suppressed: false };
}

async function scene() {
  const box = (name: string, origin: readonly [number, number, number], x: number, y: number, z: number, id = 'extrude-1'): PrimitiveFeature => ({
    id, name, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(origin[0], origin[1], origin[2]) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(x), sizeY: value(y), sizeZ: value(z) } });
  // Plate with one through hole at local (20, 10), same as the nested bolt command test.
  let plate = createEmptyPartDocument();
  const sketch = plate.sketches[0];
  if (sketch === undefined) throw new Error('initial sketch missing');
  const point = createPointFeature(sketch, absoluteCoordinate(20, 10, 0));
  plate = replaceSketch(plate, appendFeature(sketch, point));
  const body = box('plate', [0, 0, -10], 40, 20, 10, 'base-1');
  const faceRef = (bodyFeatureId: string, index: number): SubShapeRef => ({ bodyFeatureId, index,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 800, position: [20, 10, 0], axis: [0, 0, 1], radius: null } });
  const hole: HoleFeature = { id: 'hole-1', name: 'clearance', kind: 'hole', suppressed: false,
    targetFeatureId: body.id, face: faceRef(body.id, 0), centers: [{ sketchId: sketch.id, pointFeatureId: point.id }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
  plate = appendSolid(appendSolid(plate, body), hole);

  const standing = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box('standing', [0, 0, 0], 100, 8, 50)), 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, appendSolid(createEmptyPartDocument(), box('base', [0, 0, 0], 100, 60, 10)), 'b.pcad', 'b.pcad');
  const plates = await embedPart(base.library, plate, 'plate.pcad', 'plate.pcad');
  const tee: AssemblyDocument = { ...createAssemblyDocument('tee child'), components: [
    leaf('standing', standing.partRef, weldTestPlacement([0, 26, 10])), leaf('base', base.partRef, DEFAULT_COMPONENT_PLACEMENT)] };
  const plateChild: AssemblyDocument = { ...createAssemblyDocument('plate child'),
    components: [leaf('plate', plates.partRef, DEFAULT_COMPONENT_PLACEMENT)] };
  const subAssemblies = new Map([['tee', tee], ['plates', plateChild]]);
  const library = { ...plates.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('mixed root'), components: [
    owner(A, 'tee', weldTestPlacement([0, 0, LIFT]), true), owner(B, 'tee', weldTestPlacement([0, 0, LIFT])),
    owner(P, 'plates', DEFAULT_COMPONENT_PLACEMENT), owner(Q, 'plates', weldTestPlacement([0, 20, 0], [1, 0, 0, 0]))] };

  const contextFor = (current: AssemblyDocument): JointOccurrenceCommandContext => {
    const inputs = { document: current, library, subAssemblies };
    return { inputs,
      view: { source: inputs, resolved: resolveAssembly(current, { library, subAssemblies, standardPart: buildStandardPartFromSource }) },
      partDocument: occurrence => occurrence.leafComponent.source.kind === 'part'
        ? library.parts.get(occurrence.leafComponent.source.partRef) ?? null : null,
      resolveFace: (occurrence, reference) => occurrence.leafComponent.id !== 'plate' ? { status: 'missing' }
        : reference.index === 1
          ? { status: 'matched', geometry: { kind: 'face', surfaceKind: 'cylinder', area: 90 * Math.PI,
            position: [20, 10, -5], axis: [0, 0, 1], axisOrigin: [20, 10, -5], cylinderSpan: [-5, 5], radius: 4.5 },
            wall: { status: 'hole', origin: { kind: 'hole-face', featureId: hole.id,
              center: { sketchId: sketch.id, producer: { kind: 'point', featureId: point.id } },
              placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } }
          : { status: 'matched', geometry: { kind: 'face', surfaceKind: 'plane', area: 800,
            position: [20, 10, 0], axis: [0, 0, 1], radius: null }, wall: { status: 'unnamed' } },
      resolveWeldGeometry: (occurrence, ref) => {
        const id = occurrence.leafComponent.id;
        if (id !== 'standing' && id !== 'base') return null;
        return ref.fingerprint.kind === 'edge'
          ? { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }
          : id === 'standing'
            ? { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }
            : { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null };
      },
      bodiesOf: occurrence => occurrence.leafComponent.id === 'standing' ? [STANDING_BOX]
        : occurrence.leafComponent.id === 'base' ? [BASE_BOX] : null,
    };
  };
  const pick = { componentId: 'plate', holeFeatureId: hole.id, holeFace: faceRef(hole.id, 1), matingFace: faceRef(hole.id, 2) };
  const boltPicks: readonly [OccurrenceHolePick, OccurrenceHolePick] = [{ path: [P, 'plate'], pick }, { path: [Q, 'plate'], pick }];
  return { document, contextFor, boltPicks };
}

const request = teeRequest();
const WELD_PICKS: OccurrenceWeldPicks = { first: { path: [A, 'standing'], ref: request.first.face },
  edge: { path: [A, 'standing'], ref: request.edge.edge }, second: { path: [B, 'base'], ref: request.second.face } };
const WELD_CHOICES = { legOnFirst: 8, legOnSecond: 6, materialId: 'aluminum', segments: [{ start: 10, length: 20 }, { start: 50, length: 20 }] };
const BOLT_CHOICES: BoltedJointChoices = { explicitBolt: { nominal: 'M8', threadSeries: 'coarse' },
  dimensionSeries: 'annexJA', headWashers: [], nutWashers: [], minimumProtrusion: 2,
  engagement: 12, blindBottomClearance: 2, lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA',
    lengths: [30], basis: 'perDiameterEvidence', verified: true, source: 'independent test fixture, not JIS availability' }] };
const EDIT: FilletWeldEditRequest = { weldId: 'weld-1', legOnFirst: 5, legOnSecond: 4, materialId: 'steel',
  segments: [{ start: 5, length: 10 }, { start: 40, length: 15 }, { start: 80, length: 10 }] };
const REOPENED_EDIT: FilletWeldEditRequest = { weldId: 'weld-1', legOnFirst: 6, legOnSecond: 5, materialId: 'steel',
  segments: [{ start: 20, length: 30 }] };

const BOLT: JointOccurrenceConnection = { kind: 'bolt', firstPath: [P, 'plate'], secondPath: [Q, 'plate'], componentIds: ['component-3', 'component-4'] };
const weld = (componentIds: readonly string[]): JointOccurrenceConnection =>
  ({ kind: 'weld', firstPath: [A, 'standing'], secondPath: [B, 'base'], componentIds: [...componentIds] });
const ids = (document: AssemblyDocument) => document.components.map(component => component.id);

/** Every bead sits on the lifted A/B seam at its own station; the bolt and nut sit on the P/Q seats. */
function expectOccurrenceGeometry(document: AssemblyDocument, beads: readonly string[], stations: readonly number[], material: string) {
  const at = (id: string) => {
    const component = document.components.find(entry => entry.id === id);
    if (component === undefined) throw new Error(`missing ${id}`);
    return component;
  };
  beads.forEach((id, index) => {
    const bead = at(id), expected = [stations[index] ?? NaN, 34, 10 + LIFT];
    bead.placement.position.forEach((entry, axis) => expect(entry.value).toBeCloseTo(expected[axis] ?? NaN, 10));
    expect(bead.materialId).toBe(material);
    if (bead.source.kind !== 'standardPart') throw new Error('bead is not a standard weld');
    expect(filletWeldSegmentOptions(bead.source.options)?.parts).toEqual([A, B]);
    expect(filletWeldSegmentOptions(bead.source.options)?.weldId).toBe('weld-1');
  });
  expect(['component-3', 'component-4'].map(id => at(id).placement.position.map(entry => entry.value))).toEqual([[20, 10, -10], [20, 10, 10]]);
}

describe('EX-01 nested bolt and weld keep their occurrence identity across edit, save/reopen and Undo/Redo', () => {
  it('keeps the weld on A.standing/B.base and the bolt on P.plate/Q.plate at every step', async () => {
    const f = await scene();
    const owners = [A, B, P, Q];

    // Weld first (beads component-1, component-2), then the bolt (bolt component-3, nut component-4).
    let context = f.contextFor(f.document);
    const weldPreview = previewOccurrenceFilletWeld(context, WELD_PICKS, WELD_CHOICES);
    if (!weldPreview.ok) throw new Error(JSON.stringify(weldPreview));
    const welded = commitOccurrenceFilletWeld(context, WELD_PICKS, WELD_CHOICES, weldPreview);
    if (!welded.ok) throw new Error(welded.reason);
    context = f.contextFor(welded.document);
    const [first, second] = f.boltPicks;
    const boltPreview = previewOccurrenceBoltedJoint(context, first, second, BOLT_CHOICES);
    if (!boltPreview.ok) throw new Error(JSON.stringify(boltPreview));
    const bolted = commitOccurrenceBoltedJoint(context, first, second, BOLT_CHOICES, boltPreview);
    if (!bolted.ok) throw new Error(bolted.reason);
    expect(ids(bolted.document)).toEqual([...owners, 'component-1', 'component-2', 'component-3', 'component-4']);
    expect(bolted.document.jointOccurrenceConnections).toEqual([weld(['component-1', 'component-2']), BOLT]);
    expectOccurrenceGeometry(bolted.document, ['component-1', 'component-2'], [10, 50], 'aluminum');

    // Edit the weld: only its beads are replaced; the bolt record and hardware are the same objects.
    context = f.contextFor(bolted.document);
    const editPreview = previewOccurrenceFilletWeldEdit(context, EDIT);
    if (!editPreview.ok) throw new Error(JSON.stringify(editPreview));
    expect(editPreview.plan.replacedComponentIds).toEqual(['component-1', 'component-2']);
    const edited = commitOccurrenceFilletWeldEdit(context, EDIT, editPreview);
    if (!edited.ok) throw new Error(JSON.stringify(edited));
    const beads = ['component-5', 'component-6', 'component-7'];
    expect(ids(edited.document)).toEqual([...owners, 'component-3', 'component-4', ...beads]);
    expect(edited.document.jointOccurrenceConnections).toEqual([weld(beads), BOLT]);
    expect(edited.document.jointOccurrenceConnections?.[1]).toBe(bolted.document.jointOccurrenceConnections?.[1]);
    expectOccurrenceGeometry(edited.document, beads, [5, 40, 80], 'steel');

    // Undo/Redo before saving returns the exact documents.
    let history = pushUndo(createUndoStack(f.document), welded.document, { now: 0 });
    history = pushUndo(history, bolted.document, { now: 10_000 });
    history = pushUndo(history, edited.document, { now: 20_000 });
    expect(undo(history).present).toBe(bolted.document);
    expect(undo(undo(history)).present).toBe(welded.document);
    expect(redo(undo(undo(history))).present).toBe(bolted.document);
    expect(redo(redo(undo(undo(history)))).present).toBe(edited.document);

    // Save and reopen: the persisted records and owners keep the same occurrence identity.
    const text = writeAssemblyDocument(edited.document, { savedAt: '2026-01-01T00:00:00.000Z' });
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const reopened = opened.document;
    expect(ids(reopened)).toEqual(ids(edited.document));
    expect(reopened.jointOccurrenceConnections).toEqual([weld(beads), BOLT]);
    expect(reopened.components.slice(0, 4).map(component => component.source))
      .toEqual([{ kind: 'subAssembly', assemblyRef: 'tee' }, { kind: 'subAssembly', assemblyRef: 'tee' },
        { kind: 'subAssembly', assemblyRef: 'plates' }, { kind: 'subAssembly', assemblyRef: 'plates' }]);
    expectOccurrenceGeometry(reopened, beads, [5, 40, 80], 'steel');

    // The reopened document is consumable by the same command: edit the weld again, then Undo/Redo.
    context = f.contextFor(reopened);
    const againPreview = previewOccurrenceFilletWeldEdit(context, REOPENED_EDIT);
    if (!againPreview.ok) throw new Error(JSON.stringify(againPreview));
    expect(againPreview.plan.replacedComponentIds).toEqual(beads);
    const again = commitOccurrenceFilletWeldEdit(context, REOPENED_EDIT, againPreview);
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(ids(again.document)).toEqual([...owners, 'component-3', 'component-4', 'component-8']);
    expect(again.document.jointOccurrenceConnections).toEqual([weld(['component-8']), BOLT]);
    expectOccurrenceGeometry(again.document, ['component-8'], [20], 'steel');
    const reopenedHistory = pushUndo(createUndoStack(reopened), again.document, { now: 30_000 });
    expect(undo(reopenedHistory).present).toBe(reopened);
    expect(undo(reopenedHistory).present.jointOccurrenceConnections).toEqual([weld(beads), BOLT]);
    expect(redo(undo(reopenedHistory)).present).toBe(again.document);

    // PERSIST regression candidate: use real bundled source data rather than reusing the original library after JSON reload.
    const originalLibrary = f.contextFor(edited.document).inputs.library;
    const rebound = (document: AssemblyDocument, library: PartLibrary): JointOccurrenceCommandContext => {
      const inputs = { document, library, subAssemblies: library.assemblies ?? new Map<string, AssemblyDocument>() };
      return { ...f.contextFor(document), inputs,
        view: { source: inputs, resolved: resolveAssembly(document,
          { library, subAssemblies: inputs.subAssemblies, standardPart: buildStandardPartFromSource }) },
        partDocument: occurrence => occurrence.leafComponent.source.kind === 'part'
          ? library.parts.get(occurrence.leafComponent.source.partRef) ?? null : null };
    };
    expect(edited.document.schemaVersion).toBeGreaterThan(21);
    for (const schemaVersion of [21, edited.document.schemaVersion]) {
      // Version21 is a root-provenance migration case, not a historical golden archive from an old executable.
      const authored = { ...edited.document, schemaVersion };
      const beforeSave = previewOccurrenceFilletWeldEdit(rebound(authored, originalLibrary), REOPENED_EDIT);
      if (!beforeSave.ok) throw new Error(JSON.stringify(beforeSave));
      const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(authored, originalLibrary),
        { savedAt: '2026-01-01T00:00:00.000Z' });
      const loaded = await readDocumentBundle(bytes, 'assembly');
      if (!loaded.ok || loaded.bundle.kind !== 'assembly') throw new Error(JSON.stringify(loaded));
      const restored = loaded.bundle.document, library = partLibraryOfBundle(loaded.bundle);
      expect(restored.components).toEqual(authored.components);
      expect(restored.jointOccurrenceConnections).toEqual([weld(beads), BOLT]);
      for (const file of originalLibrary.partFiles) {
        const metadata = library.partFiles.find(row => row.ref === file.ref);
        expect(metadata).toMatchObject({ ref: file.ref, contentHash: file.contentHash, attachmentsDigest: file.attachmentsDigest });
        expect(library.parts.get(file.ref)).toEqual(originalLibrary.parts.get(file.ref));
      }
      expect([...(library.assemblies?.keys() ?? [])].sort()).toEqual([...(originalLibrary.assemblies?.keys() ?? [])].sort());
      for (const [ref, document] of originalLibrary.assemblies ?? []) expect(library.assemblies?.get(ref)).toEqual(document);
      const current = rebound(restored, library);
      const preview = previewOccurrenceFilletWeldEdit(current, REOPENED_EDIT);
      if (!preview.ok) throw new Error(JSON.stringify(preview));
      // Geometry/recipe fingerprint remains tied to the restored authored sources and revision metadata.
      expect(preview.stamp.identity).toBe(beforeSave.stamp.identity);
      expect(preview.plan.nominalVolume).toBe(450); // 6*5/2 times30, independently from REOPENED_EDIT.
      const tee = library.assemblies?.get('tee');
      if (tee === undefined) throw new Error('restored tee missing');
      const refs = new Set(tee.components.flatMap(component => component.source.kind === 'part' ? [component.source.partRef] : []));
      const participants = library.partFiles.filter(file => refs.has(file.ref));
      expect(participants).toHaveLength(2);
      for (const file of participants) expect(preview.stamp.identity).toContain(file.contentHash + ':' + file.attachmentsDigest);
      const target = participants[0];
      if (target === undefined) throw new Error('restored revision missing');
      const digest = (target.attachmentsDigest === 'f'.repeat(64) ? 'e' : 'f').repeat(64);
      const changed: PartLibrary = { ...library, partFiles: library.partFiles.map(file =>
        file.ref === target.ref ? { ...file, attachmentsDigest: digest } : file) };
      const revised = rebound(restored, changed);
      const newPreview = previewOccurrenceFilletWeldEdit(revised, REOPENED_EDIT);
      if (!newPreview.ok) throw new Error(JSON.stringify(newPreview));
      expect(newPreview.stamp.identity).not.toBe(preview.stamp.identity);
      expect(commitOccurrenceFilletWeldEdit(revised, REOPENED_EDIT, preview))
        .toEqual({ ok: false, reason: 'preview-changed', rejections: [], document: restored });
      expect(revised.inputs.document).toBe(restored);
    }

  }, 60_000);

  it('keeps a weld-edit stamp stable for equivalent option key order while rejecting changed values and foreign ownership', async () => {
    const f = await scene();
    const initial = f.contextFor(f.document);
    const weldPreview = previewOccurrenceFilletWeld(initial, WELD_PICKS, WELD_CHOICES);
    if (!weldPreview.ok) throw new Error(JSON.stringify(weldPreview));
    const welded = commitOccurrenceFilletWeld(initial, WELD_PICKS, WELD_CHOICES, weldPreview);
    if (!welded.ok) throw new Error(welded.reason);
    const current = f.contextFor(welded.document);
    const before = previewOccurrenceFilletWeldEdit(current, EDIT);
    if (!before.ok) throw new Error(JSON.stringify(before));
    const reordered: AssemblyDocument = { ...welded.document, components: welded.document.components.map(component => {
      if (component.source.kind !== 'standardPart') return component;
      return { ...component, source: { ...component.source,
        options: Object.fromEntries(Object.entries(component.source.options).reverse()) } };
    }) };
    const originalBead = welded.document.components.find(component => component.id === 'component-1');
    const reorderedBead = reordered.components.find(component => component.id === 'component-1');
    if (originalBead?.source.kind !== 'standardPart' || reorderedBead?.source.kind !== 'standardPart') {
      throw new Error('weld source missing');
    }
    expect(reorderedBead.source.options).toEqual(originalBead.source.options);
    expect(JSON.stringify(reorderedBead.source.options)).not.toBe(JSON.stringify(originalBead.source.options));
    const other = f.contextFor(reordered);
    const equivalent = previewOccurrenceFilletWeldEdit(other, EDIT);
    if (!equivalent.ok) throw new Error(JSON.stringify(equivalent));
    expect(equivalent.stamp.identity).toBe(before.stamp.identity);
    // Equivalent semantic identity does not transfer a preview between document owners.
    expect(commitOccurrenceFilletWeldEdit(other, EDIT, before))
      .toEqual({ ok: false, reason: 'preview-changed', rejections: [], document: reordered });
    const changedRequest = { ...EDIT, legOnFirst: 6 };
    const changed = previewOccurrenceFilletWeldEdit(current, changedRequest);
    if (!changed.ok) throw new Error(JSON.stringify(changed));
    expect(before.plan.nominalVolume).toBe(350); // 5*4/2 times (10+15+10).
    expect(changed.plan.nominalVolume).toBe(420); // 6*4/2 times the same35mm.
    expect(changed.stamp.identity).not.toBe(before.stamp.identity);
    expect(commitOccurrenceFilletWeldEdit(current, changedRequest, before))
      .toEqual({ ok: false, reason: 'preview-changed', rejections: [], document: welded.document });
    expect(current.inputs.document).toBe(welded.document);
  }, 60_000);
});
