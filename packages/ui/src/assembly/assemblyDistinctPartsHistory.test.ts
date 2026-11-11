/**
 * EX12 1000 distinct parts through the actual store history and .pcada bundle (UNEXECUTED until Root runs it).
 * open (reopened file) -> move one occurrence -> edit the shared child definition's mate -> save/reopen ->
 * Undo/Redo. Uses the real io writer/reader (writeDocumentBundle/readDocumentBundle) and the public store actions
 * openAssembly/applyAssembly/undoAssembly/redoAssembly (assemblySlice.ts L133-146). No kernel: parts are box
 * primitives checked as saved definitions, not recomputed solids.
 */
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import {
  absoluteCoordinate, addComponent, appendSolid, createAssemblyDocument, createAssemblyDocumentBundle,
  createComponentFor, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, moveComponent, partLibraryOfBundle,
  type AssemblyDocument, type Mate, type PartDocument, type PartLibrary, type PrimitiveFeature,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';

beforeEach(resetTestStore);

const SAVED_AT = '2026-10-18T00:00:00.000Z';
const COUNT = 1000;
const MOVED = 500;
const ev = (value: number) => ({ source: String(value), display: String(value), value });
/** Fixture zero convention: only +0. JSON cannot carry -0, so z is 0 - index (+0 for index 0), never -index. */
function positionOf(index: number): readonly [number, number, number] { return [index, 2 * index, 0 - index]; }
function rotationOf(index: number): readonly [number, number, number, number] {
  return [0, 0, Math.sin(index / 2000), Math.cos(index / 2000)];
}
function placementOf(position: readonly [number, number, number], rotation: readonly [number, number, number, number]) {
  return { position: [ev(position[0]), ev(position[1]), ev(position[2])], rotation: [...rotation] } as const;
}

function boxPart(index: number): PartDocument {
  const box: PrimitiveFeature = { id: 'box-1', name: `box ${String(index)}`, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: ev(index + 1), sizeY: ev(2 + index / 10), sizeZ: ev(3 + (index % 7)) } };
  return appendSolid({ ...createEmptyPartDocument(), id: `definition-${String(index)}`, name: `definition ${String(index)}` }, box);
}

function distanceMate(child: AssemblyDocument, value: number): Mate {
  return { id: 'mate-1', name: 'child distance', kind: 'distance',
    a: { kind: 'origin', componentId: child.components[0].id, element: 'origin' },
    b: { kind: 'origin', componentId: child.components[1].id, element: 'origin' },
    value: ev(value), flipped: false, suppressed: false };
}

async function savedFile(): Promise<{ readonly bytes: Uint8Array; readonly refs: readonly string[] }> {
  let library: PartLibrary = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (let index = 0; index < COUNT; index += 1) {
    const embedded = await embedPart(library, boxPart(index), `p${String(index)}.pcad`, `p${String(index)}.pcad`);
    library = embedded.library; refs.push(embedded.partRef);
  }
  let child = createAssemblyDocument('child');
  child = addComponent(child, createComponentFor(child, { kind: 'part', partRef: refs[0] }));
  child = addComponent(child, createComponentFor(child, { kind: 'part', partRef: refs[1] }, { placement: placementOf([4, 0, 0], [0, 0, 0, 1]) }));
  child = { ...child, components: child.components.map((component, index) => (index === 0 ? { ...component, fixed: true } : component)),
    mates: [distanceMate(child, 6)] };
  library = { ...library, assemblies: new Map([['child-ref', child]]) };
  let document = createAssemblyDocument('distinct');
  for (let index = 0; index < COUNT; index += 1) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: refs[index] },
      { placement: placementOf(positionOf(index), rotationOf(index)) }));
  }
  document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' },
    { placement: placementOf([500, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' },
    { placement: placementOf([0, 500, 0], [0, 0, 0, 1]) }));
  return { bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: SAVED_AT }), refs };
}

async function reopen(bytes: Uint8Array) {
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(read.ok ? 'assembly bundle expected' : read.error.message);
  return { document: read.bundle.document, library: partLibraryOfBundle(read.bundle) };
}

function positions(document: AssemblyDocument | null, index: number): readonly number[] {
  const component = document?.components[index];
  if (component === undefined) throw new Error(`component ${String(index)} missing`);
  return component.placement.position.map((value) => value.value);
}

describe('1000 distinct parts: move, shared child edit, save/reopen and Undo/Redo through the store', () => {
  it('keeps each step exact, never leaks into the opened input and restores the same objects', async () => {
    const file = await savedFile();
    const opened = await reopen(file.bytes);
    const openedChild = opened.library.assemblies?.get('child-ref');
    if (openedChild === undefined) throw new Error('child definition missing');
    useAppStore.getState().openAssembly(opened.document, opened.library);

    // Step 1: move occurrence 500 only.
    const moved = moveComponent(opened.document, opened.document.components[MOVED].id, placementOf([7, 8, 9], [0, 0, 0, 1]));
    useAppStore.getState().applyAssembly(moved);
    // Step 2: edit the shared child definition (mate 6 -> 9); both occurrences reference it by ref.
    const editedChild: AssemblyDocument = { ...openedChild, mates: [distanceMate(openedChild, 9)] };
    const editedLibrary: PartLibrary = { ...opened.library, assemblies: new Map([['child-ref', editedChild]]) };
    useAppStore.getState().applyAssembly(moved, editedLibrary);

    // The opened input is unchanged.
    expect(positions(opened.document, MOVED)).toEqual([...positionOf(MOVED)]);
    expect(opened.library.assemblies?.get('child-ref')).toBe(openedChild);
    expect(openedChild.mates[0].value?.value).toBe(6);

    // Save the edited store state with the real writer and reopen it.
    const state = useAppStore.getState();
    if (state.assembly === null) throw new Error('assembly missing');
    const saved = await writeDocumentBundle(createAssemblyDocumentBundle(state.assembly, state.assemblyLibrary), { savedAt: SAVED_AT });
    const again = await reopen(saved);
    expect(positions(again.document, MOVED)).toEqual([7, 8, 9]);
    for (const index of [0, 1, 499, 501, 999]) expect(positions(again.document, index)).toEqual([...positionOf(index)]);
    for (const index of [0, 499, 999]) {
      expect(again.document.components[index].source).toEqual({ kind: 'part', partRef: file.refs[index] });
      const solid = again.library.parts.get(file.refs[index])?.solids[0];
      expect(solid?.kind === 'primitive' && solid.shape.kind === 'box' ? solid.shape.sizeX.value : null).toBe(index + 1);
    }
    expect(again.library.assemblies?.get('child-ref')?.mates[0].value?.value).toBe(9);
    expect(again.document.components.slice(COUNT).map((component) => component.source))
      .toEqual([{ kind: 'subAssembly', assemblyRef: 'child-ref' }, { kind: 'subAssembly', assemblyRef: 'child-ref' }]);

    // Undo the child edit: library returns to the opened object, the move stays.
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assemblyLibrary.assemblies?.get('child-ref')).toBe(openedChild);
    expect(useAppStore.getState().assembly).toBe(moved);
    // Undo the move: the opened document object itself.
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toBe(opened.document);
    expect(useAppStore.getState().assemblyLibrary).toBe(opened.library);
    // Redo both: the same edited objects, not copies.
    useAppStore.getState().redoAssembly();
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assembly).toBe(moved);
    expect(useAppStore.getState().assemblyLibrary).toBe(editedLibrary);
  }, 300_000);

  it('a truncated .pcada is refused and leaves the open document untouched', async () => {
    const file = await savedFile();
    const opened = await reopen(file.bytes);
    useAppStore.getState().openAssembly(opened.document, opened.library);
    const truncated = await readDocumentBundle(file.bytes.slice(0, Math.floor(file.bytes.length / 2)), 'assembly');
    expect(truncated.ok).toBe(false);
    expect(useAppStore.getState().assembly).toBe(opened.document);
    expect(useAppStore.getState().assemblyLibrary).toBe(opened.library);
  }, 300_000);
});
