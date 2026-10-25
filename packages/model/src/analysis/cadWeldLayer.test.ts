import { describe, expect, it } from 'vitest';
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { testPlacement } from './beamInputs.testSupport.js';

describe('current CAD effective weld layer boundary', () => {
  it('derives actual triangular throat frame and SI compliance from the two owned endpoint sections', () => {
    const f = cadWeldLayerFixture(), before = structuredClone(f.document);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.context), w = result.welds[0];
    // Actual 3-4-5 triangle: available altitude=12/5 mm. Declared effective width2 mm.
    // Root-to-foot direction local(.8,.6), localZ maps worldX; root at(worldY6,Z6).
    expect(w.centerM[0]).toBeCloseTo(.025, 12);
    expect(w.centerM[1]).toBeCloseTo(.0068, 12);
    expect(w.centerM[2]).toBeCloseTo(.0066, 12);
    expect(w.normal[0]).toBeCloseTo(0, 12); expect(w.normal[1]).toBeCloseTo(.6, 12); expect(w.normal[2]).toBeCloseTo(-.8, 12);
    expect(w.along[0]).toBeCloseTo(1, 12);
    expect(w.youngPa*w.widthM*w.lengthM/w.thicknessM).toBeCloseTo(2e7, 6);
    expect(w.nodeIdA).toBe('a-base'); expect(w.nodeIdB).toBe('b-base');
    expect(f.document).toEqual(before);
  });
  it('roundtrips explicit associations and rejects unsupported, duplicate or sparse data', () => {
    const f = cadWeldLayerFixture();
    expect(readCadWeldLayerInputs(JSON.parse(JSON.stringify(f.associations)))).toEqual(f.associations);
    for (const patch of [{ yieldMPa: 250 }, { complianceLengthMm: 0 }, { effectiveThroatMm: Infinity }, { poisson: .5 }]) {
      expect(() => readCadWeldLayerInputs({ ...f.associations, welds: [{ ...f.associations.welds[0], ...patch }] })).toThrow();
    }
    expect(() => readCadWeldLayerInputs({ ...f.associations, welds: new Array(1) })).toThrow();
  });
  it('rejects stale source/material/placement and wrong member ownership or remote endpoint', () => {
    const f = cadWeldLayerFixture();
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations,
      { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: 'changed' } })).toThrow();
    for (const patch of [{ materialId: 'steel' }, { suppressed: true }, { placement: testPlacement([999, 0, 0]) }]) {
      const document = { ...f.document, components: f.document.components.map(c => c.id === f.beadId ? { ...c, ...patch } : c) };
      expect(() => prepareCadWeldLayers(document, f.definition, f.associations, f.context)).toThrow();
    }
    for (const first of [{ memberId: 'a-beam', nodeId: 'b-base' }, { memberId: 'a-beam', nodeId: 'a-tip' }]) {
      expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
        welds: [{ ...f.associations.welds[0], first }] }, f.context)).toThrow();
    }
  });
  it('refuses missing actual body evidence and a throat wider than the real triangle', () => {
    const f = cadWeldLayerFixture();
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, { ...f.context, bodies: new Map() })).toThrow('CAD bodies');
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
      welds: [{ ...f.associations.welds[0], effectiveThroatMm: 2.5 }] }, f.context)).toThrow('altitude');
    const bead = f.document.components.find(c => c.id === f.beadId);
    if (bead === undefined) throw new Error('Missing fixture bead');
    const doubled = { ...f.document, components: [...f.document.components, { ...bead, id: 'extra-bead' }] };
    expect(() => prepareCadWeldLayers(doubled, f.definition, f.associations, f.context)).toThrow('silent merging');
  });
});
