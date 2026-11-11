import { describe, expect, it } from 'vitest';
import { prepareCadWeldLayers, prepareCadWeldSpanLayers } from './cadWeldLayer.js';
import { cadWeldSpanFixture } from './cadWeldSpanLayer.testSupport.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { testPlacement } from './beamInputs.testSupport.js';
import { placementFingerprint } from '../assembly/fastening/frames.js';

describe('explicit saved span sides in current CAD', () => {
  it.each([false, true])('keeps actual members and explicit sides without changing document or saved bytes mixed=%s', mixed => {
    const f = cadWeldSpanFixture(mixed), before = JSON.stringify(f);
    const p = prepareCadWeldSpanLayers(f.document, f.definition, f.associations, f.context), w = p.welds[0];
    expect(w.first).toEqual(f.associations.welds[0].first); expect(w.second).toEqual(f.associations.welds[0].second);
    expect(w).not.toHaveProperty('nodeIdA'); expect(w.second).not.toHaveProperty('nodeId');
    expect(w.widthM).toBe(.01); expect(w.lengthM).toBe(.002); expect(w.thicknessM).toBe(.001);
    expect(w.youngPa).toBe(1e9); expect(w.poisson).toBe(.25);
    expect(w.widthM*w.lengthM).toBe(20e-6);
    // Straight root station is 5..15 mm; world along is X (mixed) or Z (parallel).
    expect(w.centerM[mixed ? 0 : 2]).toBeCloseTo(.01, 12);
    expect(w.along[mixed ? 0 : 2]).toBeCloseTo(1, 12);
    // Independent 3/4/5 throat direction (.8,.6) times half the declared 2 mm.
    const center = mixed ? [.01, .0068, .0066] : [.0434, .0068, .01];
    const normal = mixed ? [0, .6, -.8] : [.8, .6, 0];
    center.forEach((v, i) => expect(w.centerM[i]).toBeCloseTo(v, 12));
    normal.forEach((v, i) => expect(w.normal[i]).toBeCloseTo(v, 12));
    expect(JSON.stringify(f)).toBe(before);
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, f.context)).toThrow();
  });
  it('keeps every irregular original interval, the gaps, and complete side identity', () => {
    const f = cadWeldSpanFixture(false, [{ start: 2, length: 3 }, { start: 10, length: 5 }]);
    const p = prepareCadWeldSpanLayers(f.document, f.definition, f.associations, f.context);
    expect(p.welds.map(w => w.widthM)).toEqual([.003, .005]);
    p.welds.forEach((w, i) => expect(w.centerM[2]).toBeCloseTo([.0035, .0125][i], 12));
    const partial = { ...f.associations, welds: f.associations.welds.slice(0, 1) };
    expect(() => prepareCadWeldSpanLayers(f.document, { ...f.definition, weldLayers: partial }, partial, f.context)).toThrow('No silent merging');
    const wrong = { ...f.associations, welds: f.associations.welds.map((w, i) => i ? { ...w, first: { kind: 'section-node' as const, memberId: 'a-beam', nodeId: 'a-base' } } : w) };
    expect(() => prepareCadWeldSpanLayers(f.document, { ...f.definition, weldLayers: wrong }, wrong, f.context)).toThrow('No silent merging');
  });
  it('does not convert a remote section into a span', () => {
    const f = cadWeldSpanFixture(true), saved = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w,
      first: { kind: 'section-node' as const, memberId: 'a-beam', nodeId: 'a-tip' } })) };
    expect(() => prepareCadWeldSpanLayers(f.document, { ...f.definition, weldLayers: saved }, saved, f.context)).toThrow('selected member endpoint section');
  });
  it('refuses a bead beyond the finite member without clamping it', () => {
    const f = cadWeldSpanFixture(), bead = f.document.components.find(c => c.id === f.associations.welds[0].beadComponentId);
    if (bead === undefined) throw new Error('Fixture bead missing');
    // A moved bead changes the current footprint and must be rejected, even if the saved pose pin is refreshed.
    const moved = { ...bead, placement: testPlacement([50, 6, 30], bead.placement.rotation) };
    const document = { ...f.document, components: f.document.components.map(c => c.id === bead.id ? moved : c) };
    const saved = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w, expectedPlacementKey: placementFingerprint(moved.placement) })) };
    expect(() => prepareCadWeldSpanLayers(document, { ...f.definition, weldLayers: saved }, saved, f.context)).toThrow();
  });
  it.each(['source', 'part', 'pose', 'material', 'suppression', 'occurrence', 'saved'] as const)('rejects changed %s evidence', reason => {
    const f = cadWeldSpanFixture();
    if (reason === 'source') {
      expect(() => prepareCadWeldSpanLayers(f.document, f.definition, f.associations, { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: 'other' } })).toThrow(); return;
    }
    if (reason === 'occurrence') {
      const definition = { ...f.definition, members: f.definition.members.map((m, i) => i ? { ...m, occurrencePath: ['a'] } : m) };
      expect(() => prepareCadWeldSpanLayers(f.document, definition, f.associations, f.context)).toThrow(); return;
    }
    const saved = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w,
      ...(reason === 'part' ? { expectedPartKey: 'changed' } : reason === 'pose' ? { expectedPlacementKey: 'changed' }
        : reason === 'material' ? { expectedMaterialId: 'steel' } : reason === 'saved' ? { effectiveThroatMm: 3 } : {}) })) };
    const document = reason === 'suppression' ? { ...f.document, components: f.document.components.map(c => c.id === saved.welds[0].beadComponentId ? { ...c, suppressed: true } : c) } : f.document;
    expect(() => prepareCadWeldSpanLayers(document, { ...f.definition, weldLayers: saved }, saved, f.context)).toThrow();
  });
  it('refuses disagreement between saved associations and the current definition, missing footprint and unsupported combinations', () => {
    const f = cadWeldSpanFixture();
    const saved = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w, youngMPa: 900 })) };
    expect(() => prepareCadWeldSpanLayers(f.document, f.definition, saved, f.context)).toThrow('match the current definition');
    expect(() => prepareCadWeldSpanLayers(f.document, f.definition, f.associations, { ...f.context, bodies: new Map() })).toThrow();
    for (const extra of [{ axialBolts: {} }, { initialStrain: {} }]) expect(() => prepareCadWeldSpanLayers(f.document, { ...f.definition, ...extra }, f.associations, f.context)).toThrow('does not support');
    const old = cadWeldLayerFixture();
    expect(() => prepareCadWeldSpanLayers(old.document, old.definition, old.associations, old.context)).toThrow();
    expect(prepareCadWeldLayers(old.document, old.definition, old.associations, old.context).welds[0]).toHaveProperty('nodeIdA', 'a-base');
  });
});
