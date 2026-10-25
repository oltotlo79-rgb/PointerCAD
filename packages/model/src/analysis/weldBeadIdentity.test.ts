import { describe, expect, it } from 'vitest';
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { childOwnedWeldFixture } from './cadWeldLayerChildOwned.testSupport.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';

const DUPLICATE = 'Distinct members and unique physical bead associations required';

/** The physical bead is (occurrence prefix, child-local bead id): repeated children reuse the id, nothing else may. */
describe('physical weld bead identity of saved associations', () => {
  it('reads and prepares one association per occurrence of the same child-local bead', () => {
    const f = childOwnedWeldFixture();
    // Fixture precondition: both occurrences really name the same child-local bead id.
    expect(new Set(f.associations.welds.map((weld) => weld.beadComponentId)).size).toBe(1);
    expect(readCadWeldLayerInputs(f.associations).welds).toHaveLength(2);
    expect(prepareCadWeldLayers(f.document, f.definition, f.associations, f.context).welds).toHaveLength(2);
  });

  it('still refuses a second association of the same top-level bead', () => {
    const f = cadWeldLayerFixture();
    const first = f.associations.welds[0];
    if (first === undefined) throw new Error('fixture association missing');
    const duplicated = { ...f.associations, welds: [first, { ...first, id: 'effective-throat-copy' }] };
    expect(() => prepareCadWeldLayers(f.document, f.definition, duplicated, f.context)).toThrow(DUPLICATE);
  });

  it('refuses a second association of the same top-level bead with reversed members', () => {
    const f = cadWeldLayerFixture();
    const first = f.associations.welds[0];
    if (first === undefined) throw new Error('fixture association missing');
    const reversed = { ...first, id: 'effective-throat-reversed', first: first.second, second: first.first };
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations, welds: [first, reversed] }, f.context))
      .toThrow(DUPLICATE);
  });

  it('refuses two associations of the same child bead in the same occurrence, also with reversed members', () => {
    const f = childOwnedWeldFixture();
    const first = f.associations.welds[0];
    if (first === undefined) throw new Error('fixture association missing');
    const same = { ...first, id: 'p1-throat-copy' };
    const reversed = { ...first, id: 'p1-throat-reversed', first: first.second, second: first.first };
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations, welds: [...f.associations.welds, same] }, f.context))
      .toThrow(DUPLICATE);
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations, welds: [...f.associations.welds, reversed] }, f.context))
      .toThrow(DUPLICATE);
  });

  it('keeps saved associations stored but refuses them once the CAD source stamp changes after a geometry edit', () => {
    const f = childOwnedWeldFixture();
    const edited = { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: `${f.context.currentSource.geometryRevision}+edit` } };
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, edited))
      .toThrow('Analysis associations do not match the current CAD revision');
    // The stored associations are untouched by the refusal (nothing remapped or deleted).
    expect(f.associations.welds.map((weld) => weld.id)).toStrictEqual(['p1-throat-0', 'p2-throat-0']);
  });
});
