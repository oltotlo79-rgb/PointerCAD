/**
 * Root drag/motion overlay on nested occurrences (UNEXECUTED until Root runs it). Child solved placements are already
 * world placements; only the change from the solved root frame to the preview root frame is applied, once, to that
 * root's descendants. Expected positions come from hand algebra on the fixture placements.
 */
import {
  addComponent, createAssemblyDocument, createComponentFor,
  type AssemblyComponent, type AssemblyDocument, type ComponentSource, type ResolvedAssembly, type RigidPlacement,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { flattenAssemblyGeometry } from './createAssemblyLayer.js';

const IDENTITY = [0, 0, 0, 1] as const;
/** Rz(+90deg) as [x, y, z, w]: (x, y, z) -> (-y, x, z). */
const QUARTER_Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
const at = (x: number, y: number, z: number, rotation: readonly [number, number, number, number] = IDENTITY): RigidPlacement =>
  ({ position: [x, y, z], rotation: [...rotation] });

function documentOf(name: string, entries: readonly (readonly [string, ComponentSource])[]): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const [id, source] of entries) {
    const component: AssemblyComponent = { ...createComponentFor(document, source, {}), id };
    document = addComponent(document, component);
  }
  return document;
}

const GRAND = documentOf('grand', [['pin', { kind: 'part', partRef: 'pin-part' }]]);
const CHILD = documentOf('child', [['plate', { kind: 'part', partRef: 'plate-part' }],
  ['inner', { kind: 'subAssembly', assemblyRef: 'grand' }]]);
const ROOT = documentOf('root', [['A', { kind: 'subAssembly', assemblyRef: 'child' }],
  ['B', { kind: 'subAssembly', assemblyRef: 'child' }], ['base', { kind: 'part', partRef: 'base-part' }]]);

/**
 * World placements of one child occurrence whose root sits at `origin` (identity rotation): plate local (1, 0, 0),
 * inner local (0, 2, 0), pin local (0, 0, 3) inside inner.
 */
function childAt(origin: readonly [number, number, number]): ResolvedAssembly {
  const [x, y, z] = origin;
  const inner = at(x, y + 2, z);
  const grand: ResolvedAssembly = { parts: new Map(), errors: [], partKeys: new Map([['pin', 'pin-part']]),
    placements: new Map([['pin', at(x, y + 2, z + 3)]]) };
  return { parts: new Map(), errors: [], partKeys: new Map([['plate', 'plate-part'], ['inner', 'grand']]),
    placements: new Map([['plate', at(x + 1, y, z)], ['inner', inner]]),
    subAssemblies: new Map([['inner', { componentId: 'inner', assemblyRef: 'grand', assembly: GRAND, placement: inner, resolved: grand }]]) };
}

function solvedRoot(): ResolvedAssembly {
  const a = at(10, 0, 0), b = at(0, 20, 0);
  return { parts: new Map(), errors: [], partKeys: new Map([['A', 'child'], ['B', 'child'], ['base', 'base-part']]),
    placements: new Map([['A', a], ['B', b], ['base', at(0, 0, 0)]]),
    subAssemblies: new Map([
      ['A', { componentId: 'A', assemblyRef: 'child', assembly: CHILD, placement: a, resolved: childAt([10, 0, 0]) }],
      ['B', { componentId: 'B', assemblyRef: 'child', assembly: CHILD, placement: b, resolved: childAt([0, 20, 0]) }],
    ]) };
}

function expectNear(actual: RigidPlacement | undefined, position: readonly number[], rotation: readonly number[]): void {
  if (actual === undefined) throw new Error('Placement missing');
  position.forEach((value, axis) => expect(actual.position[axis]).toBeCloseTo(value, 9));
  rotation.forEach((value, axis) => expect(actual.rotation[axis]).toBeCloseTo(value, 9));
}

const ROWS = ['A/plate', 'A/inner/pin', 'B/plate', 'B/inner/pin', 'base'];

describe('a root drag overlay moves that root sub-assembly descendants once', () => {
  it('no overlay: every row keeps the solved world placement object', () => {
    const resolved = solvedRoot();
    const flat = flattenAssemblyGeometry(ROOT, resolved);
    expect(flat.components.map((component) => component.id)).toEqual(ROWS);
    expect(flat.placements.get('A/plate')).toBe(resolved.subAssemblies?.get('A')?.resolved.placements.get('plate'));
    expect(flat.placements.get('B/inner/pin')).toBe(
      resolved.subAssemblies?.get('B')?.resolved.subAssemblies?.get('inner')?.resolved.placements.get('pin'));
    // An overlay that only copies the same values (new objects) is not a move either.
    const copied = new Map([...resolved.placements].map(([id, placement]) => [id, { ...placement }]));
    const same = flattenAssemblyGeometry(ROOT, resolved, copied);
    for (const row of ROWS.filter((id) => id !== 'base')) expect(same.placements.get(row)).toBe(flat.placements.get(row));
  });

  it('a non-identity preview of root A moves A child and grandchild by the root change only; B and base stay', () => {
    const resolved = solvedRoot();
    // Preview A at (100, 0, 0) turned Rz(90); solved A was (10, 0, 0) unrotated.
    const preview = new Map(resolved.placements).set('A', at(100, 0, 0, QUARTER_Z));
    const flat = flattenAssemblyGeometry(ROOT, resolved, preview);
    // Local offsets from the solved A frame: plate (1, 0, 0), pin (0, 2, 3). Rz(90) maps them to (0, 1, 0) and (-2, 0, 3).
    expectNear(flat.placements.get('A/plate'), [100, 1, 0], QUARTER_Z);
    expectNear(flat.placements.get('A/inner/pin'), [98, 0, 3], QUARTER_Z);
    // The repeated child under B is independent of A's preview: the same solved objects.
    expect(flat.placements.get('B/plate')).toBe(resolved.subAssemblies?.get('B')?.resolved.placements.get('plate'));
    expect(flat.placements.get('B/inner/pin')).toBe(
      resolved.subAssemblies?.get('B')?.resolved.subAssemblies?.get('inner')?.resolved.placements.get('pin'));
    expect(flat.placements.get('base')).toBe(resolved.placements.get('base'));
    // Inputs are not written: the solved maps still hold the original A frame.
    expectNear(resolved.subAssemblies?.get('A')?.resolved.placements.get('plate'), [11, 0, 0], IDENTITY);
    // Rows, part keys and occurrence paths are unchanged by the preview.
    expect(flat.components.map((component) => component.id)).toEqual(ROWS);
    expect(flat.partKeys.get('A/inner/pin')).toBe('pin-part');
    expect(flat.occurrencePaths?.get('A/inner/pin')).toEqual(['A', 'inner', 'pin']);
  });

  it('cancelling the preview (no override again) restores the solved display exactly', () => {
    const resolved = solvedRoot();
    flattenAssemblyGeometry(ROOT, resolved, new Map(resolved.placements).set('A', at(100, 0, 0, QUARTER_Z)));
    const restored = flattenAssemblyGeometry(ROOT, resolved);
    expect(restored.placements.get('A/plate')).toBe(resolved.subAssemblies?.get('A')?.resolved.placements.get('plate'));
    expectNear(restored.placements.get('A/inner/pin'), [10, 2, 3], IDENTITY);
  });

  it('a committed move re-solved at the preview pose draws where the preview drew (no jump)', () => {
    const before = solvedRoot();
    const preview = new Map(before.placements).set('A', at(100, 0, 0, QUARTER_Z));
    const previewed = flattenAssemblyGeometry(ROOT, before, preview);
    // After commit the publisher composes A's children at the new root pose (task85): world = new root ∘ local.
    // Locals plate (1, 0, 0), inner (0, 2, 0), pin (0, 2, 3) under Rz(90) at (100, 0, 0).
    const moved = at(100, 0, 0, QUARTER_Z);
    const inner = at(98, 0, 0, QUARTER_Z);
    const plate = at(100, 1, 0, QUARTER_Z);
    const pin = at(98, 0, 3, QUARTER_Z);
    const after: ResolvedAssembly = { ...before, placements: new Map(before.placements).set('A', moved),
      subAssemblies: new Map(before.subAssemblies).set('A', { componentId: 'A', assemblyRef: 'child', assembly: CHILD,
        placement: moved, resolved: { parts: new Map(), errors: [], partKeys: new Map([['plate', 'plate-part'], ['inner', 'grand']]),
          placements: new Map([['plate', plate], ['inner', inner]]),
          subAssemblies: new Map([['inner', { componentId: 'inner', assemblyRef: 'grand', assembly: GRAND, placement: inner,
            resolved: { parts: new Map(), errors: [], partKeys: new Map([['pin', 'pin-part']]), placements: new Map([['pin', pin]]) } }]]) } }) };
    const committed = flattenAssemblyGeometry(ROOT, after);
    for (const row of ['A/plate', 'A/inner/pin']) {
      const shown = previewed.placements.get(row);
      if (shown === undefined) throw new Error(`${row} missing`);
      expectNear(committed.placements.get(row), shown.position, shown.rotation);
    }
  });
});
