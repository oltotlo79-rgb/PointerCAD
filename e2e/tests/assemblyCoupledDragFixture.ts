import { writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPrimitiveFeature, embedPart,
  EMPTY_PART_LIBRARY, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type Joint, type MateTarget,
  type PartDocument, type Placement, type PrimitiveShapeKind,
} from '../../packages/model/src/index.js';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';

/**
 * EX12 coupled drag host fixture (task014 drag-coverage-r1, successor of the drag-r1 fixture): an ordinary valid .pcada
 * without any cross-level coupling (the flow creates the gear through the visible form). Written numbers are the
 * independent expectations:
 * - fixed `ground` (box) at the origin; `wheel` (cylinder) at the origin on the revolute `gear-drive` (wheel = a,
 *   ground = b, origin z axes); `handle` (sphere, radius 10 about its origin) at (50, 0, 0) on the slider `handle-slide`
 *   along the wheel's x axis (handle x = a, wheel x = b), so a drag can only turn the wheel about z and slide the handle
 *   along the turned x axis: the handle reaches any point of the plane z = 0;
 * - the leaf `drag-leaf` (fixed `leaf-base`, `leaf-arm` on the revolute `leaf-turn`, moving = a, origin z axes, limited
 *   to [-40, 40] degrees) placed as `unit` at (0, 0, 100) turned +90 degrees about x and fixed: the leaf z axis is the
 *   world -y axis there;
 * - a free part `loose` (sphere) at (0, -60, 0) without any joint (an ordinary placement drag).
 * All drag points are inside the home view (cameraMath HOME_ORBIT). The saved time is historical fixture data.
 */
export const DRAG_SAVED_AT = '2026-09-01T00:00:00.000Z';
export const DRAG_JOINTS = ['gear-drive', 'handle-slide'] as const;
export const DRAG_WRITTEN: Readonly<Record<string, readonly [number, number, number]>> = {
  ground: [0, 0, 0], wheel: [0, 0, 0], handle: [50, 0, 0], unit: [0, 0, 100], loose: [0, -60, 0],
};
export const DRAG_UNIT_ROTATION: readonly [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
export const DRAG_TURN_LIMIT_DEG = 40;
const KINDS: readonly PrimitiveShapeKind[] = ['box', 'cylinder', 'sphere'];

function placement(name: string): Placement {
  const [x, y, z] = DRAG_WRITTEN[name] ?? [Number.NaN, Number.NaN, Number.NaN];
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
    rotation: name === 'unit' ? [...DRAG_UNIT_ROTATION] : [0, 0, 0, 1] };
}
const AT_ORIGIN: Placement = { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)],
  rotation: [0, 0, 0, 1] };
function component(id: string, source: ComponentSource, at: Placement, fixed: boolean): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
const origin = (componentId: string, element: 'x' | 'z'): MateTarget => ({ kind: 'origin', componentId, element });
function joint(id: string, kind: Joint['kind'], a: MateTarget, b: MateTarget, limit: number | null): Joint {
  const bound = (value: number) => ({ ...expressionValueFromNumber(value), source: String(value) });
  return { id, name: id, kind, a, b, minValue: limit === null ? null : bound(-limit), maxValue: limit === null ? null : bound(limit),
    suppressed: false };
}
function part(index: number): PartDocument {
  const empty = { ...createEmptyPartDocument(), name: `drag-part-${String(index + 1)}` };
  return appendSolid(empty, createPrimitiveFeature(empty, KINDS[index] ?? 'box'));
}

export async function assemblyCoupledDragFile(): Promise<Uint8Array> {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (let index = 0; index < KINDS.length; index += 1) {
    const embedded = await embedPart(library, part(index), `drag-part-${String(index + 1)}.pcad`, '', { importedAt: DRAG_SAVED_AT });
    library = embedded.library;
    refs.push(embedded.partRef);
  }
  const ref = (index: number): ComponentSource => {
    const value = refs[index];
    if (value === undefined) throw new Error('missing part reference');
    return { kind: 'part', partRef: value };
  };
  const leaf: AssemblyDocument = { ...createAssemblyDocument('drag-leaf'),
    components: [component('leaf-base', ref(0), AT_ORIGIN, true), component('leaf-arm', ref(1), AT_ORIGIN, false)],
    joints: [joint('leaf-turn', 'revolute', origin('leaf-arm', 'z'), origin('leaf-base', 'z'), DRAG_TURN_LIMIT_DEG)] };
  library = { ...library, assemblies: new Map([['drag-leaf-ref', leaf]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('coupled-drag'),
    components: [component('ground', ref(0), placement('ground'), true), component('wheel', ref(1), placement('wheel'), false),
      component('handle', ref(2), placement('handle'), false),
      component('unit', { kind: 'subAssembly', assemblyRef: 'drag-leaf-ref' }, placement('unit'), true),
      component('loose', ref(2), placement('loose'), false)],
    joints: [joint('gear-drive', 'revolute', origin('wheel', 'z'), origin('ground', 'z'), null),
      joint('handle-slide', 'slider', origin('handle', 'x'), origin('wheel', 'x'), null)] };
  return writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: DRAG_SAVED_AT });
}
