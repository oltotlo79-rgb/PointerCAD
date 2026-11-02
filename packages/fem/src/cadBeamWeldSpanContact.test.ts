import { describe, expect, it } from 'vitest';
import { cadWeldSpanFixture } from '../../model/src/analysis/cadWeldSpanLayer.testSupport.js';
import { prepareCadBeamWeldSpanContact } from './cadBeamWeldSpanContact.js';
import { translateBeamWeldSpanContact } from './beamWeldSpanContact.js';

describe('current CAD saved /2 to the dedicated span mesh', () => {
  it.each([false, true])('validates the actual CAD sides and complete numerical mesh mixed=%s', mixed => {
    const f = cadWeldSpanFixture(mixed), before = JSON.stringify(f);
    const value = prepareCadBeamWeldSpanContact(f.document, f.definition, f.associations, f.context);
    const translated = translateBeamWeldSpanContact(value);
    expect(value.schema).toBe('pointercad-weld-span/1');
    expect(value.contact.supports).toEqual(f.definition.supports); expect(value.contact.referenceLoads).toEqual(f.definition.referenceLoads);
    expect(value.contact.loadFactors).toEqual([1, 0, -1]); expect(value.contact.contacts[0]).toMatchObject({ gapM: .01 });
    expect(translated.plan.contact.nodes).toHaveLength(6); expect(translated.plan.contact.originalNodeCount).toBe(4);
    expect(translated.plan.patches[0].first.kind).toBe(mixed ? 'section' : 'span');
    expect(translated.plan.patches[0].second).toEqual({ kind: 'span', memberId: 'b-beam' });
    expect(value.patches[0]).toMatchObject({ youngPa: 1e9, widthM: .01, lengthM: .002, thicknessM: .001 });
    expect(value.contact.geometry.units).toBe('N-mm'); expect(JSON.stringify(f)).toBe(before);
  });
  it('preserves irregular physical intervals and rejects incomplete groups', () => {
    const f = cadWeldSpanFixture(false, [{ start: 2, length: 3 }, { start: 10, length: 5 }]);
    const value = prepareCadBeamWeldSpanContact(f.document, f.definition, f.associations, f.context);
    expect(value.patches.map(p => p.widthM)).toEqual([.003, .005]);
    const partial = { ...f.associations, welds: f.associations.welds.slice(0, 1) };
    expect(() => prepareCadBeamWeldSpanContact(f.document, { ...f.definition, weldLayers: partial }, partial, f.context)).toThrow();
  });
  it('runs numerical element/node and explicit side checks, not just CAD geometry', () => {
    const f = cadWeldSpanFixture();
    expect(() => prepareCadBeamWeldSpanContact(f.document, { ...f.definition,
      contact: { ...f.definition.contact, segmentsPerMember: 33 } }, f.associations, f.context)).toThrow();
    const wrong = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w,
      first: { kind: 'section-node' as const, memberId: 'a-beam', nodeId: 'a-base' } })) };
    expect(() => prepareCadBeamWeldSpanContact(f.document, { ...f.definition, weldLayers: wrong }, wrong, f.context)).toThrow('selected member endpoint section');
    for (const extra of [{ axialBolts: {} }, { initialStrain: {} }]) expect(() => prepareCadBeamWeldSpanContact(f.document, { ...f.definition, ...extra }, f.associations, f.context)).toThrow('does not support');
  });
});
