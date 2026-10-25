import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyFilletWeld, buildStandardPartFromSource, EMPTY_PART_LIBRARY, filletWeldSegmentOptions, partKeyOf, planFilletWeldEdit,
  prepareCadWeldLayers, resolveAssembly, weldPlacementFingerprint, weldSegmentsOf,
  type AssemblyDocument, type PartLibrary,
} from '@pointercad/model';
import { readPcadaFile, writePcadaFile } from '@pointercad/io';
import { childOwnedWeldFixture, WELDED_CHILD_REF } from '../../../model/src/analysis/cadWeldLayerChildOwned.testSupport.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(resetTestStore);

/**
 * One edit of the weld group owned by the welded child that the root places twice (P1 translated, P2 rotated +90 deg
 * about z and translated). There is no store command that edits a bead stored inside a child definition: the edit is
 * made by the public model commands on the child document, and the child is put back into the library through the
 * store's public applyAssembly (one Undo step). Undo and Redo are the store's own undoAssembly/redoAssembly.
 */
const WELD = 'weld-1';
const ORIGINAL = { start: 20, length: 10 } as const;
const EDITED = { start: 10, length: 20 } as const;

function editChildWeld(child: AssemblyDocument, bodies: ReturnType<typeof childOwnedWeldFixture>['context']['bodies']): AssemblyDocument {
  const plan = planFilletWeldEdit(child, { weldId: WELD, legOnSecond: 3, legOnFirst: 4, segments: [EDITED], materialId: 'aluminum' },
    new Map(), owner => bodies.get(partKeyOf(owner.source)) ?? null);
  if (!plan.ok) throw new Error('child weld edit plan refused: ' + JSON.stringify(plan.rejections));
  const applied = applyFilletWeld(child, plan.plan, new Map());
  if (!applied.ok) throw new Error('child weld edit apply refused: ' + JSON.stringify(applied.rejections));
  return applied.document;
}

/** What the group is, read independently of any helper under test: interval, owners and identity of each bead. */
function groupOf(child: AssemblyDocument | undefined) {
  if (child === undefined) throw new Error('welded child missing from the library');
  return (weldSegmentsOf(child).get(WELD) ?? []).map(bead => {
    const options = bead.source.kind === 'standardPart' ? filletWeldSegmentOptions(bead.source.options) : null;
    if (options === null) throw new Error('bead options unreadable');
    return { id: bead.id, station: options.station, length: options.length, parts: [...options.parts],
      partKey: partKeyOf(bead.source), placement: weldPlacementFingerprint(bead.placement),
      materialId: bead.materialId, rigidGroupId: bead.rigidGroupId };
  });
}

/** The two welded child members, which the edit must leave in place. */
function membersOf(child: AssemblyDocument | undefined) {
  if (child === undefined) throw new Error('welded child missing from the library');
  return ['a', 'b'].map(id => {
    const row = child.components.find(c => c.id === id);
    if (row === undefined) throw new Error('welded member missing: ' + id);
    return { id, partKey: partKeyOf(row.source), placement: weldPlacementFingerprint(row.placement), suppressed: row.suppressed };
  });
}

function rootRows(document: AssemblyDocument | null) {
  if (document === null) throw new Error('assembly missing');
  return document.components.map(row => ({ id: row.id, source: row.source, placement: weldPlacementFingerprint(row.placement),
    suppressed: row.suppressed }));
}

/** World bead origins of each repeated occurrence, from the real resolver (no parent composed twice). */
function worldBeadOrigins(document: AssemblyDocument, library: PartLibrary, beadId: string) {
  const resolved = resolveAssembly(document, { library, subAssemblies: library.assemblies, standardPart: buildStandardPartFromSource });
  return ['P1', 'P2'].map(occurrence => {
    const nested = resolved.subAssemblies?.get(occurrence);
    const pose = nested?.resolved.placements.get(beadId);
    if (nested === undefined || pose === undefined) throw new Error('bead not resolved in occurrence ' + occurrence);
    return { occurrence, assembly: nested.assembly, position: [...pose.position] };
  });
}

function expectTransformedOccurrences(document: AssemblyDocument, library: PartLibrary, beadId: string): void {
  const child = library.assemblies?.get(WELDED_CHILD_REF);
  if (child === undefined) throw new Error('welded child missing from the library');
  const local = resolveAssembly(child, { standardPart: buildStandardPartFromSource }).placements.get(beadId)?.position;
  if (local === undefined) throw new Error('bead not resolved in the child');
  const [p1, p2] = worldBeadOrigins(document, library, beadId);
  // Both occurrences read the SAME child definition from the library.
  expect(p1?.assembly).toBe(child);
  expect(p2?.assembly).toBe(child);
  // P1: translate (100,0,0). P2: R_z(+90) maps (x,y,z) to (-y,x,z), then translate (0,200,0).
  const expected = [[local[0] + 100, local[1], local[2]], [-local[1], local[0] + 200, local[2]]];
  for (const [index, world] of [p1, p2].entries()) {
    for (let axis = 0; axis < 3; axis += 1) expect(world?.position[axis]).toBeCloseTo(expected[index]?.[axis] ?? Number.NaN, 9);
  }
  expect(Math.hypot(...[0, 1, 2].map(i => (p1?.position[i] ?? 0) - (p2?.position[i] ?? 0)))).toBeGreaterThan(1);
}

function libraryWith(library: PartLibrary, child: AssemblyDocument): PartLibrary {
  return { ...library, assemblies: new Map<string, AssemblyDocument>([...(library.assemblies ?? []), [WELDED_CHILD_REF, child]]) };
}

function openFixture() {
  const f = childOwnedWeldFixture();
  const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: f.subAssemblies };
  useAppStore.getState().openAssembly(f.document, library);
  return { f, library };
}

function adapterContext(f: ReturnType<typeof childOwnedWeldFixture>, library: PartLibrary) {
  return { ...f.context, assemblyOptions: { subAssemblies: library.assemblies } };
}

describe('one edit of a repeated child-owned weld group through the store history', () => {
  it('changes only the child bead group, then undoAssembly and redoAssembly restore each exact state', () => {
    const { f, library } = openFixture();
    const before = useAppStore.getState();
    const originalGroup = groupOf(before.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF));
    // Fixture precondition: one child-owned bead on the child's own members a, b at the original interval.
    expect(originalGroup.map(bead => [bead.station, bead.length, bead.parts])).toStrictEqual([[ORIGINAL.start, ORIGINAL.length, ['a', 'b']]]);
    expect(before.assembly?.components.some(row => row.source.kind === 'standardPart')).toBe(false);
    expect(before.assemblyUndoStack?.past).toHaveLength(0);
    expect(prepareCadWeldLayers(f.document, f.definition, f.associations, adapterContext(f, library)).welds).toHaveLength(2);

    const edited = editChildWeld(f.child, f.context.bodies);
    const editedLibrary = libraryWith(before.assemblyLibrary, edited);
    if (before.assembly === null) throw new Error('assembly missing');
    useAppStore.getState().applyAssembly(before.assembly, editedLibrary);

    const after = useAppStore.getState();
    const editedGroup = groupOf(after.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF));
    // The edit really changed the intended state: a new interval and a new bead identity, still owned by the child.
    expect(editedGroup.map(bead => [bead.station, bead.length, bead.parts])).toStrictEqual([[EDITED.start, EDITED.length, ['a', 'b']]]);
    expect(editedGroup.map(bead => bead.id)).not.toContain(originalGroup[0]?.id);
    expect(after.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(edited);
    expect(after.assemblyUndoStack?.past).toHaveLength(1);
    expect(after.canUndo).toBe(true);
    // Siblings: the root rows and the welded child members are retained; the root still holds no bead.
    expect(after.assembly).toBe(before.assembly);
    expect(rootRows(after.assembly)).toStrictEqual(rootRows(before.assembly));
    expect(membersOf(edited)).toStrictEqual(membersOf(f.child));
    const editedBead = editedGroup[0]?.id;
    if (editedBead === undefined || after.assembly === null) throw new Error('edited bead missing');
    expectTransformedOccurrences(after.assembly, after.assemblyLibrary, editedBead);
    // The saved associations name the replaced bead: refused, never silently mapped to the new bead.
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, adapterContext(f, after.assemblyLibrary)))
      .toThrow('Current unique top-level occurrence required');

    useAppStore.getState().undoAssembly();
    const undone = useAppStore.getState();
    expect(undone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(f.child);
    expect(undone.assembly).toBe(before.assembly);
    expect(groupOf(undone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF))).toStrictEqual(originalGroup);
    expect(undone.assemblyUndoStack?.past).toHaveLength(0);
    expect(undone.assemblyUndoStack?.future).toHaveLength(1);
    expect(undone.canRedo).toBe(true);
    const originalBead = originalGroup[0]?.id;
    if (originalBead === undefined || undone.assembly === null) throw new Error('original bead missing');
    expectTransformedOccurrences(undone.assembly, undone.assemblyLibrary, originalBead);
    expect(prepareCadWeldLayers(f.document, f.definition, f.associations, adapterContext(f, undone.assemblyLibrary)).welds).toHaveLength(2);

    useAppStore.getState().redoAssembly();
    const redone = useAppStore.getState();
    expect(redone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(edited);
    expect(groupOf(redone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF))).toStrictEqual(editedGroup);
    expect(redone.assemblyUndoStack?.past).toHaveLength(1);
    expect(redone.assemblyUndoStack?.future).toHaveLength(0);
    expect(rootRows(redone.assembly)).toStrictEqual(rootRows(before.assembly));
    if (redone.assembly === null) throw new Error('assembly missing');
    expectTransformedOccurrences(redone.assembly, redone.assemblyLibrary, editedBead);
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, adapterContext(f, redone.assemblyLibrary)))
      .toThrow('Current unique top-level occurrence required');
  });

  it('saves the edited store state as PCADA and reopens the same child-owned group for both occurrences', async () => {
    const { f } = openFixture();
    const opened = useAppStore.getState();
    if (opened.assembly === null) throw new Error('assembly missing');
    const edited = editChildWeld(f.child, f.context.bodies);
    useAppStore.getState().applyAssembly(opened.assembly, libraryWith(opened.assemblyLibrary, edited));
    const saved = useAppStore.getState();
    if (saved.assembly === null) throw new Error('assembly missing');

    const bytes = await writePcadaFile(saved.assembly, { assemblies: saved.assemblyLibrary.assemblies, savedAt: '2026-10-18T00:00:00.000Z' });
    const read = await readPcadaFile(bytes);
    if (!read.ok) throw new Error('PCADA reread refused: ' + JSON.stringify(read.error));
    expect([...read.assemblies.keys()]).toStrictEqual([WELDED_CHILD_REF]);
    useAppStore.getState().openAssembly(read.document, { ...EMPTY_PART_LIBRARY, assemblies: read.assemblies });
    const reopened = useAppStore.getState();
    const reopenedChild = reopened.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF);

    // Independent expectations: the reread group equals the edited in-memory group field by field.
    expect(groupOf(reopenedChild)).toStrictEqual(groupOf(edited));
    expect(groupOf(reopenedChild).map(bead => [bead.station, bead.length, bead.parts])).toStrictEqual([[EDITED.start, EDITED.length, ['a', 'b']]]);
    expect(membersOf(reopenedChild)).toStrictEqual(membersOf(f.child));
    expect(rootRows(reopened.assembly)).toStrictEqual(rootRows(saved.assembly));
    expect(reopened.assembly?.components.some(row => row.source.kind === 'standardPart')).toBe(false);
    const bead = groupOf(reopenedChild)[0]?.id;
    if (bead === undefined || reopened.assembly === null) throw new Error('reread bead missing');
    expectTransformedOccurrences(reopened.assembly, reopened.assemblyLibrary, bead);
    // A reopened file starts a new history; the edit is the saved state, not an undoable step.
    expect(reopened.assemblyUndoStack?.past).toHaveLength(0);
    expect(() => prepareCadWeldLayers(reopened.assembly ?? f.document, f.definition, f.associations,
      adapterContext(f, reopened.assemblyLibrary))).toThrow('Current unique top-level occurrence required');
  });

  it('round-trips the unedited state so the saved associations of both occurrences are still accepted', async () => {
    const { f, library } = openFixture();
    const bytes = await writePcadaFile(f.document, { assemblies: library.assemblies, savedAt: '2026-10-18T00:00:00.000Z' });
    const read = await readPcadaFile(bytes);
    if (!read.ok) throw new Error('PCADA reread refused: ' + JSON.stringify(read.error));
    const reread: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: read.assemblies };
    expect(groupOf(read.assemblies.get(WELDED_CHILD_REF))).toStrictEqual(groupOf(f.child));
    expect(read.document.id).toBe(f.document.id);
    const prepared = prepareCadWeldLayers(read.document, f.definition, f.associations, adapterContext(f, reread));
    expect(prepared.welds.map(weld => weld.id)).toStrictEqual(f.associations.welds.map(weld => weld.id));
  });
});
