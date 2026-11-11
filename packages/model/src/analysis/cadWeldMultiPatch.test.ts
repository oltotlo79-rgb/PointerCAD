import { describe, expect, it } from 'vitest';
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { testPlacement } from './beamInputs.testSupport.js';

describe('complete intermittent CAD weld groups', () => {
  it('keeps actual separate intervals and gaps through explicit association roundtrip', () => {
    const f = cadWeldLayerFixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const saved = readCadWeldLayerInputs(JSON.parse(JSON.stringify(f.associations)));
    const before = structuredClone(f.document);
    const result = prepareCadWeldLayers(f.document, f.definition, saved, f.context);
    expect(result.welds.map(w => w.id)).toEqual(['effective-throat', 'effective-throat-1']);
    expect(result.welds.map(w => w.widthM)).toEqual([.005, .005]);
    expect(result.welds[0].centerM[0]).toBeCloseTo(.0125, 12);
    expect(result.welds[1].centerM[0]).toBeCloseTo(.0325, 12);
    expect(result.welds.every(w => w.nodeIdA === 'a-base' && w.nodeIdB === 'b-base')).toBe(true);
    expect(f.document).toEqual(before);
  });
  it('refuses partial saved groups and stale material, pose or suppression of any interval', () => {
    const f = cadWeldLayerFixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    expect(() => prepareCadWeldLayers(f.document, f.definition,
      { ...f.associations, welds: f.associations.welds.slice(0, 1) }, f.context)).toThrow('No silent merging');
    const second = f.associations.welds[1].beadComponentId;
    for (const patch of [{ materialId: 'steel' }, { suppressed: true }, { placement: testPlacement([999, 0, 0]) }]) {
      const document = { ...f.document, components: f.document.components.map(c => c.id === second ? { ...c, ...patch } : c) };
      expect(() => prepareCadWeldLayers(document, f.definition, f.associations, f.context)).toThrow();
    }
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
      welds: f.associations.welds.map((w, i) => i === 1 ? { ...w, effectiveThroatMm: 1 } : w) }, f.context)).toThrow('No silent merging');
  });
  it('refuses physically overlapping intervals even when both stored associations match their bead identities', () => {
    const f = cadWeldLayerFixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const first = f.document.components.find(c => c.id === f.associations.welds[0].beadComponentId);
    if (first === undefined) throw new Error('Missing first interval');
    const secondId = f.associations.welds[1].beadComponentId;
    const document = { ...f.document, components: f.document.components.map(c => c.id === secondId
      ? { ...first, id: secondId } : c) };
    const associations = { ...f.associations, welds: f.associations.welds.map((w, i) => i === 0 ? w
      : { ...f.associations.welds[0], id: w.id, beadComponentId: secondId }) };
    expect(() => prepareCadWeldLayers(document, f.definition, associations, f.context)).toThrow('Overlapping');
  });
});
