import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildStandardPartFromSource, EMPTY_PART_LIBRARY, filletWeldSegmentOptions, partKeyOf, prepareCadWeldLayers, resolveAssembly,
  weldPlacementFingerprint, weldSegmentsOf, type AssemblyComponent, type AssemblyDocument, type PartLibrary,
} from '@pointercad/model';
import { readPcadaFile, writePcadaFile } from '@pointercad/io';
import { childOwnedWeldFixture, WELDED_CHILD_REF } from '../../../model/src/analysis/cadWeldLayerChildOwned.testSupport.js';
import { testComponent, testPlacement } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { beamUiFixture } from '../beam/beam.testSupport.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(resetTestStore);

/**
 * Decision B: a weld group stored in a child DEFINITION placed twice (P1 translated, P2 rotated +90 deg about z and
 * translated) is edited through the public store commands beginChildFilletWeldEdit / updateFilletWeldDraft /
 * commitChildFilletWeldEdit. The edit changes the shared definition, so the commit needs the explicit 'definition'
 * scope and the current affected-placement count. An unrelated root sibling S must stay untouched.
 */
const WELD = 'weld-1';

function setup(mutate: (document: AssemblyDocument) => AssemblyDocument = (document) => document) {
  const f = childOwnedWeldFixture();
  const sibling: AssemblyComponent = { ...testComponent('S', '30'), placement: testPlacement([-300, 0, 0]) };
  const document = mutate({ ...f.document, components: [...f.document.components, sibling] });
  const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: f.subAssemblies };
  const resolved = resolveAssembly(document, { library, subAssemblies: f.subAssemblies, standardPart: buildStandardPartFromSource });
  const ui = beamUiFixture();
  if (ui.state.assemblyView === null) throw new Error('UI fixture view missing');
  useAppStore.getState().openAssembly(document, library);
  // The completed CAD publication the weld editor reads: the same document, its resolution and the actual bar bodies.
  useAppStore.setState({ assemblyView: { ...ui.state.assemblyView, sourceDocument: document, resolved, bodies: f.context.bodies } });
  const bead = f.beads[0]?.id;
  if (bead === undefined) throw new Error('fixture bead missing');
  return { f, document, library, sibling, bead };
}

function groupOf(child: AssemblyDocument | undefined) {
  if (child === undefined) throw new Error('welded child missing');
  return (weldSegmentsOf(child).get(WELD) ?? []).map((bead) => {
    const options = bead.source.kind === 'standardPart' ? filletWeldSegmentOptions(bead.source.options) : null;
    if (options === null) throw new Error('bead options unreadable');
    return { id: bead.id, station: options.station, length: options.length, parts: [...options.parts],
      partKey: partKeyOf(bead.source), placement: weldPlacementFingerprint(bead.placement), materialId: bead.materialId };
  });
}

function rowOf(document: AssemblyDocument | null, id: string) {
  const row = document?.components.find((component) => component.id === id);
  if (row === undefined) throw new Error('row missing: ' + id);
  return { id: row.id, source: row.source, placement: weldPlacementFingerprint(row.placement), suppressed: row.suppressed };
}

/** World bead origins of P1 and P2 from the real resolver, compared with independent expectations from the child. */
function expectBothOccurrences(document: AssemblyDocument, library: PartLibrary, beadId: string): void {
  const child = library.assemblies?.get(WELDED_CHILD_REF);
  if (child === undefined) throw new Error('welded child missing');
  const local = resolveAssembly(child, { standardPart: buildStandardPartFromSource }).placements.get(beadId)?.position;
  const resolved = resolveAssembly(document, { library, subAssemblies: library.assemblies, standardPart: buildStandardPartFromSource });
  const p1 = resolved.subAssemblies?.get('P1'), p2 = resolved.subAssemblies?.get('P2');
  const w1 = p1?.resolved.placements.get(beadId)?.position, w2 = p2?.resolved.placements.get(beadId)?.position;
  if (local === undefined || w1 === undefined || w2 === undefined) throw new Error('bead not resolved');
  expect(p1?.assembly).toBe(child);
  expect(p2?.assembly).toBe(child);
  // P1: translate (100,0,0). P2: R_z(+90) maps (x,y,z) to (-y,x,z), then translate (0,200,0).
  const e1 = [local[0] + 100, local[1], local[2]], e2 = [-local[1], local[0] + 200, local[2]];
  for (let axis = 0; axis < 3; axis += 1) {
    expect(w1[axis]).toBeCloseTo(e1[axis] ?? Number.NaN, 9);
    expect(w2[axis]).toBeCloseTo(e2[axis] ?? Number.NaN, 9);
  }
}

function beginAndEdit(bead: string): void {
  expect(useAppStore.getState().beginChildFilletWeldEdit(['P1', bead])).toBe(true);
  useAppStore.getState().updateFilletWeldDraft({ startSource: '10', lengthsSource: '20' });
  const preview = useAppStore.getState().assemblyFilletWeldPreview;
  expect(preview?.kind === 'plan' && preview.result.ok).toBe(true);
}

const confirmed = (affectedPlacements: number) => ({ scope: 'definition' as const, assemblyRef: WELDED_CHILD_REF, affectedPlacements });

describe('public child-definition weld edit with explicit shared-definition scope', () => {
  it('shows the shared placement count and refuses without confirmation, with a wrong count or through the plain commit', () => {
    const { f, bead } = setup();
    beginAndEdit(bead);
    const target = useAppStore.getState().assemblyChildWeldEdit;
    expect(target?.assemblyRef).toBe(WELDED_CHILD_REF);
    expect(target?.affectedPlacements).toBe(2);
    expect(target?.path).toStrictEqual(['P1', bead]);
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect(useAppStore.getState().commitChildFilletWeldEdit(null)).toBe(false);
    expect(useAppStore.getState().commitChildFilletWeldEdit(confirmed(1))).toBe(false);
    expect(useAppStore.getState().commitChildFilletWeldEdit({ ...confirmed(2), assemblyRef: 'other' })).toBe(false);
    const after = useAppStore.getState();
    expect(after.assemblyUndoStack?.past).toHaveLength(0);
    expect(after.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(f.child);
  });

  it('refuses a suppressed, missing or non-weld path before any draft', () => {
    const { bead } = setup((document) => ({ ...document, components: document.components.map((row) =>
      row.id === 'P1' ? { ...row, suppressed: true } : row) }));
    expect(useAppStore.getState().beginChildFilletWeldEdit(['P1', bead])).toBe(false);
    expect(useAppStore.getState().beginChildFilletWeldEdit(['P9', bead])).toBe(false);
    expect(useAppStore.getState().beginChildFilletWeldEdit(['P2', 'a'])).toBe(false);
    expect(useAppStore.getState().beginChildFilletWeldEdit([bead])).toBe(false);
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    expect(useAppStore.getState().assemblyChildWeldEdit).toBeNull();
  });

  it('refuses a definition replaced after the edit began, without changing the document or history', () => {
    const { f, bead } = setup();
    beginAndEdit(bead);
    const replaced: AssemblyDocument = { ...f.child, name: 'replaced definition' };
    const state = useAppStore.getState();
    useAppStore.setState({ assemblyLibrary: { ...state.assemblyLibrary, assemblies: new Map([[WELDED_CHILD_REF, replaced]]) } });
    expect(useAppStore.getState().commitChildFilletWeldEdit(confirmed(2))).toBe(false);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
    expect(useAppStore.getState().assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(replaced);
  });

  it('commits one Undo step that changes both placements, keeps the sibling, and Undo/Redo restore each state', () => {
    const { f, document, sibling, bead } = setup();
    const originalGroup = groupOf(f.child);
    expect(originalGroup.map((row) => [row.station, row.length, row.parts])).toStrictEqual([[20, 10, ['a', 'b']]]);
    beginAndEdit(bead);
    expect(useAppStore.getState().commitChildFilletWeldEdit(confirmed(2))).toBe(true);

    const after = useAppStore.getState();
    const edited = after.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF);
    const editedGroup = groupOf(edited);
    expect(editedGroup.map((row) => [row.station, row.length, row.parts])).toStrictEqual([[10, 20, ['a', 'b']]]);
    expect(editedGroup.map((row) => row.id)).not.toContain(bead);
    expect(after.assemblyUndoStack?.past).toHaveLength(1);
    expect(after.assemblyChildWeldEdit).toBeNull();
    expect(after.assembly).toBe(document);
    expect(rowOf(after.assembly, 'S')).toStrictEqual(rowOf(document, sibling.id));
    expect(after.assembly?.components.some((row) => row.source.kind === 'standardPart' && row.source.catalog === 'filletWeld')).toBe(false);
    const editedBead = editedGroup[0]?.id;
    if (editedBead === undefined || after.assembly === null || edited === undefined) throw new Error('edited bead missing');
    expectBothOccurrences(after.assembly, after.assemblyLibrary, editedBead);
    // Dependent saved associations name the replaced bead: refused, never silently reused for the new bead.
    expect(() => prepareCadWeldLayers(after.assembly ?? document, f.definition, f.associations,
      { ...f.context, assemblyOptions: { subAssemblies: after.assemblyLibrary.assemblies } }))
      .toThrow('Current unique top-level occurrence required');

    useAppStore.getState().undoAssembly();
    const undone = useAppStore.getState();
    expect(undone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(f.child);
    expect(groupOf(undone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF))).toStrictEqual(originalGroup);
    expect(undone.assemblyUndoStack?.future).toHaveLength(1);
    if (undone.assembly === null) throw new Error('assembly missing');
    expectBothOccurrences(undone.assembly, undone.assemblyLibrary, bead);
    expect(rowOf(undone.assembly, 'S')).toStrictEqual(rowOf(document, sibling.id));

    useAppStore.getState().redoAssembly();
    const redone = useAppStore.getState();
    expect(redone.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)).toBe(edited);
    expect(redone.assemblyUndoStack?.past).toHaveLength(1);
    expect(redone.assemblyUndoStack?.future).toHaveLength(0);
    if (redone.assembly === null) throw new Error('assembly missing');
    expectBothOccurrences(redone.assembly, redone.assemblyLibrary, editedBead);
  });

  it('saves the committed shared-definition edit as PCADA and reopens the same group, IDs and sibling', async () => {
    const { f, sibling, bead } = setup();
    beginAndEdit(bead);
    expect(useAppStore.getState().commitChildFilletWeldEdit(confirmed(2))).toBe(true);
    const saved = useAppStore.getState();
    if (saved.assembly === null) throw new Error('assembly missing');
    const bytes = await writePcadaFile(saved.assembly, { assemblies: saved.assemblyLibrary.assemblies, savedAt: '2026-10-18T00:00:00.000Z' });
    const read = await readPcadaFile(bytes);
    if (!read.ok) throw new Error('PCADA reread refused: ' + JSON.stringify(read.error));
    const reread: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: read.assemblies };
    expect(groupOf(read.assemblies.get(WELDED_CHILD_REF))).toStrictEqual(groupOf(saved.assemblyLibrary.assemblies?.get(WELDED_CHILD_REF)));
    expect(rowOf(read.document, 'S')).toStrictEqual(rowOf(saved.assembly, sibling.id));
    expect(rowOf(read.document, 'P1')).toStrictEqual(rowOf(saved.assembly, 'P1'));
    expect(rowOf(read.document, 'P2')).toStrictEqual(rowOf(saved.assembly, 'P2'));
    const editedBead = groupOf(read.assemblies.get(WELDED_CHILD_REF))[0]?.id;
    if (editedBead === undefined) throw new Error('reread bead missing');
    expectBothOccurrences(read.document, reread, editedBead);
    expect(f.child.components.some((row) => row.id === bead)).toBe(true);
  });
});
