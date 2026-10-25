import { describe, expect, it } from 'vitest';
import { cadJointContactFixture } from '../../model/src/analysis/cadJointContact.testSupport.js';
import { prepareCadBeamJointContact } from './cadBeamJointContact.js';

describe('simultaneous current CAD shank and weld ownership', () => {
  it('keeps both original connectors and the actual intermittent gap on one geometry', () => {
    const f = cadJointContactFixture(), before = structuredClone(f.document);
    const input = prepareCadBeamJointContact(f.document, f.definition, f.axialBolts, f.associations, f.context);
    expect(input.bolts).toHaveLength(1);
    expect(input.bolts[0]).toMatchObject({ id: 'mixed-shank', nodeIdA: 'a-base', nodeIdB: 'b-base', youngPa: 1e9 });
    expect(input.bolts[0].areaM2).toBeCloseTo(1e-5, 18);
    expect(input.welds.map(w => w.id)).toEqual(['effective-throat', 'effective-throat-1']);
    expect(input.welds.map(w => w.widthM)).toEqual([.005, .005]);
    expect(input.welds[1].centerM[0]-input.welds[0].centerM[0]).toBeCloseTo(.02, 12);
    expect(f.document).toEqual(before);
  });
  it('refuses a stale member of either family without returning the other alone', () => {
    const f = cadJointContactFixture();
    for (const id of [f.axialBolts.bolts[0].boltComponentId, f.associations.welds[1].beadComponentId]) {
      const document = { ...f.document, components: f.document.components.map(c => c.id === id ? { ...c, suppressed: true } : c) };
      expect(() => prepareCadBeamJointContact(document, f.definition, f.axialBolts, f.associations, f.context)).toThrow();
    }
    expect(() => prepareCadBeamJointContact(f.document, f.definition, f.axialBolts,
      { ...f.associations, analysisRevision: f.associations.analysisRevision+1 }, f.context)).toThrow();
    expect(() => prepareCadBeamJointContact(f.document, f.definition,
      { ...f.axialBolts, source: { ...f.axialBolts.source, documentId: 'other' } }, f.associations, f.context)).toThrow();
  });
});
