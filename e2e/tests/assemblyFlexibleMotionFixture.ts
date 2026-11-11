import { writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPrimitiveFeature, embedPart,
  EMPTY_PART_LIBRARY, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type PartDocument, type Placement,
  type PrimitiveShapeKind,
} from '../../packages/model/src/index.js';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';

/**
 * EX12 flexible subassembly host fixture (task012 flexible-r2). Persisted inputs only; the written coordinates are the
 * independent expectations of the flow. The leaf assembly (fixed `leaf-base`, free `leaf-arm` on the slider
 * `leaf-slide` along the origin z axes) is placed as `inner` at (0, 0, 50) in the middle assembly (with its own fixed
 * `mid-base`), and the middle assembly is placed twice in the parent: `outer-a` at the origin and `outer-b` at
 * (300, 0, 0). Component ids equal the names, so tree row ids and occurrence paths are `outer-a/inner` etc.
 * The saved time is historical fixture data, not an execution clock.
 */
export const FLEXIBLE_SAVED_AT = '2026-09-01T00:00:00.000Z';
export const FLEXIBLE_JOINT = 'leaf-slide';
export const FLEXIBLE_TOP: Readonly<Record<string, readonly [number, number, number]>> = { 'outer-a': [0, 0, 0], 'outer-b': [300, 0, 0] };
/** Written world position of the leaf parts of outer-a/inner before any drive (outer-a origin + inner (0, 0, 50)). */
export const FLEXIBLE_LEAF_Z = 50;
const KINDS: readonly PrimitiveShapeKind[] = ['box', 'cylinder', 'sphere'];

function placement([x, y, z]: readonly [number, number, number]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: readonly [number, number, number], fixed: boolean): AssemblyComponent {
  return { id, name: id, source, placement: placement(at), fixed, visible: true, suppressed: false };
}
function part(index: number): PartDocument {
  const empty = { ...createEmptyPartDocument(), name: `flexible-part-${String(index + 1)}` };
  return appendSolid(empty, createPrimitiveFeature(empty, KINDS[index] ?? 'box'));
}

export async function assemblyFlexibleMotionFile(): Promise<Uint8Array> {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (let index = 0; index < KINDS.length; index += 1) {
    const embedded = await embedPart(library, part(index), `flexible-part-${String(index + 1)}.pcad`, '', { importedAt: FLEXIBLE_SAVED_AT });
    library = embedded.library;
    refs.push(embedded.partRef);
  }
  const ref = (index: number): ComponentSource => {
    const value = refs[index];
    if (value === undefined) throw new Error('missing part reference');
    return { kind: 'part', partRef: value };
  };
  const leaf: AssemblyDocument = { ...createAssemblyDocument('flexible-leaf'),
    components: [component('leaf-base', ref(0), [0, 0, 0], true), component('leaf-arm', ref(1), [0, 0, 0], false)],
    joints: [{ id: FLEXIBLE_JOINT, name: FLEXIBLE_JOINT, kind: 'slider',
      a: { kind: 'origin', componentId: 'leaf-arm', element: 'z' }, b: { kind: 'origin', componentId: 'leaf-base', element: 'z' },
      minValue: null, maxValue: null, suppressed: false }] };
  const mid: AssemblyDocument = { ...createAssemblyDocument('flexible-mid'),
    components: [component('mid-base', ref(2), [0, 0, 0], true),
      component('inner', { kind: 'subAssembly', assemblyRef: 'flexible-leaf-ref' }, [0, 0, FLEXIBLE_LEAF_Z], false)] };
  library = { ...library, assemblies: new Map([['flexible-leaf-ref', leaf], ['flexible-mid-ref', mid]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('flexible-motion'),
    components: Object.entries(FLEXIBLE_TOP).map(([id, at]) => component(id, { kind: 'subAssembly', assemblyRef: 'flexible-mid-ref' }, at, false)) };
  return writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: FLEXIBLE_SAVED_AT });
}
