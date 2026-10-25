import { describe, expect, it } from 'vitest';
import { placementFingerprint } from '../assembly/fastening/frames.js';
import type { AssemblyDocument } from '../assembly/types.js';
import { testPlacement } from './beamInputs.testSupport.js';
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { childOwnedWeldFixture, WELDED_CHILD_REF } from './cadWeldLayerChildOwned.testSupport.js';

/**
 * Independent world oracle. Child-local endpoints are those of the legacy top-level fixture (a at (0,0,6):
 * base (25,3,6); b rotated -90 deg about x at (0,6,6): base (25,6,3)). P1 adds (100,0,0). P2 applies
 * R_z(+90): (x,y,z) -> (-y,x,z), then adds (0,200,0). Layer vectors transform the same way (positions in m).
 */
const p1 = (v: readonly number[]) => [(v[0] ?? NaN) + 100, v[1] ?? NaN, v[2] ?? NaN];
const p2 = (v: readonly number[]) => [-(v[1] ?? NaN), (v[0] ?? NaN) + 200, v[2] ?? NaN];
const r2 = (v: readonly number[]) => [-(v[1] ?? NaN), v[0] ?? NaN, v[2] ?? NaN];
const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 9));
};
const withChild = (f: ReturnType<typeof childOwnedWeldFixture>, child: AssemblyDocument) =>
  ({ ...f.context, assemblyOptions: { subAssemblies: new Map([[WELDED_CHILD_REF, child]]) } });

describe('child-owned weld group placed twice as the same welded child', () => {
  it('prepares one layer per occurrence with exact world endpoints and transforms, equal to the legacy layer moved once', () => {
    const f = childOwnedWeldFixture();
    // Preconditions: the child really owns one bead group and the root holds only the two occurrences.
    expect(f.beads).toHaveLength(1);
    expect(f.document.components.map(c => c.id)).toEqual(['P1', 'P2']);
    expect(f.document.jointOccurrenceConnections ?? []).toEqual([]);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.context);
    const node = (id: string) => result.geometry.nodes.find(n => n.id === id)?.position;
    close(node('p1a-base'), p1([25, 3, 6])); close(node('p1b-base'), p1([25, 6, 3]));
    close(node('p2a-base'), p2([25, 3, 6])); close(node('p2b-base'), p2([25, 6, 3]));
    const legacy = prepareCadWeldLayers(f.top.document, f.top.definition, f.top.associations, f.top.context).welds[0];
    if (legacy === undefined) throw new Error('legacy layer missing');
    expect(result.welds.map(w => [w.id, w.nodeIdA, w.nodeIdB])).toEqual([['p1-throat-0', 'p1a-base', 'p1b-base'], ['p2-throat-0', 'p2a-base', 'p2b-base']]);
    const [first, second] = result.welds;
    if (first === undefined || second === undefined) throw new Error('layers missing');
    close(first.centerM, p1(legacy.centerM.map(v => v * 1000)).map(v => v / 1000));
    close(first.normal, legacy.normal); close(first.along, legacy.along);
    close(second.centerM, p2(legacy.centerM.map(v => v * 1000)).map(v => v / 1000));
    close(second.normal, r2(legacy.normal)); close(second.along, r2(legacy.along));
    for (const layer of result.welds) {
      expect([layer.widthM, layer.lengthM, layer.thicknessM, layer.youngPa, layer.poisson])
        .toEqual([legacy.widthM, legacy.lengthM, legacy.thicknessM, legacy.youngPa, legacy.poisson]);
    }
  });

  it('refuses endpoints given in the opposite order of the child weldParts', () => {
    const f = childOwnedWeldFixture();
    const swapped = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w, first: w.second, second: w.first })) };
    expect(swapped.welds[0]?.first.memberId).toBe('p1b-beam');
    expect(() => prepareCadWeldLayers(f.document, f.definition, swapped, f.context)).toThrow(/recorded by the child-owned group/);
  });

  it('refuses a bead that would join members of two different occurrences of the repeated child', () => {
    const f = childOwnedWeldFixture();
    const crossed = { ...f.associations, welds: f.associations.welds.map(w => w.id === 'p1-throat-0'
      ? { ...w, second: { memberId: 'p2b-beam', nodeId: 'p2b-base' } } : w) };
    expect(crossed.welds[0]?.second.memberId).toBe('p2b-beam');
    expect(() => prepareCadWeldLayers(f.document, f.definition, crossed, f.context)).toThrow();
  });

  it('refuses associations that cover only part of the child bead group', () => {
    const f = childOwnedWeldFixture([{ start: 5, length: 10 }, { start: 30, length: 10 }]);
    expect(f.beads).toHaveLength(2);
    const partial = { ...f.associations, welds: f.associations.welds.filter(w => w.id !== 'p1-throat-1') };
    expect(partial.welds).toHaveLength(3);
    expect(() => prepareCadWeldLayers(f.document, f.definition, partial, f.context)).toThrow(/No silent merging/);
  });

  it('refuses a child bead moved away from the recorded placement', () => {
    const f = childOwnedWeldFixture();
    const beadId = f.beads[0]?.id ?? '';
    const moved: AssemblyDocument = { ...f.child, components: f.child.components.map(c => c.id === beadId ? { ...c, placement: testPlacement([1, 0, 0]) } : c) };
    const movedBead = moved.components.find(c => c.id === beadId);
    expect(movedBead === undefined ? '' : placementFingerprint(movedBead.placement)).not.toBe(f.associations.welds[0]?.expectedPlacementKey);
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, withChild(f, moved))).toThrow();
  });

  it('refuses a child bead whose source is no longer a fillet weld', () => {
    const f = childOwnedWeldFixture();
    const beadId = f.beads[0]?.id ?? '';
    const wrongKind: AssemblyDocument = { ...f.child, components: f.child.components.map(c => c.id === beadId
      ? { ...c, source: { kind: 'part' as const, partRef: 'not-a-weld' } } : c) };
    expect(wrongKind.components.find(c => c.id === beadId)?.source.kind).toBe('part');
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, withChild(f, wrongKind))).toThrow();
  });

  it('refuses a suppressed second occurrence', () => {
    const f = childOwnedWeldFixture();
    const suppressed = { ...f.document, components: f.document.components.map(c => c.id === 'P2' ? { ...c, suppressed: true } : c) };
    expect(suppressed.components.find(c => c.id === 'P2')?.suppressed).toBe(true);
    expect(() => prepareCadWeldLayers(suppressed, f.definition, f.associations, f.context)).toThrow();
  });

  it('refuses a second occurrence replaced by another child definition', () => {
    const f = childOwnedWeldFixture();
    const replaced = { ...f.document, components: f.document.components.map(c => c.id === 'P2'
      ? { ...c, source: { kind: 'subAssembly' as const, assemblyRef: 'other-cell' } } : c) };
    const p2c = replaced.components.find(c => c.id === 'P2');
    expect(p2c?.source.kind === 'subAssembly' ? p2c.source.assemblyRef : '').toBe('other-cell');
    expect(() => prepareCadWeldLayers(replaced, f.definition, f.associations, f.context)).toThrow();
  });

  it('keeps the legacy top-level weld layer unchanged', () => {
    const f = childOwnedWeldFixture();
    expect(prepareCadWeldLayers(f.top.document, f.top.definition, f.top.associations, f.top.context).welds).toHaveLength(1);
  });
});
