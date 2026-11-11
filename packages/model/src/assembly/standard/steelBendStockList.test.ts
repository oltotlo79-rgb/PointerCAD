import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { CutFeature, PartDocument } from '../../part/types.js';
import type { SketchFeature } from '../../sketch/types.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { embedPart, EMPTY_PART_LIBRARY, replacePartDocument } from '../partLibrary.js';
import type { AssemblyComponent } from '../types.js';
import { createStandardPartSource } from './buildStandardPart.js';
import { createSteelBend } from './steelBend.js';
import type { SteelBendDimensions } from './steelBendGeometry.js';
import { STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';
import { buildSteelStockList } from './steelStockList.js';

/** The bent part's finished (developed) length in the cut list, table, CSV and drawing. Expected lengths are the
 * independent centroid-path closed forms legs + R_c * angle (R_c = inside radius + centroid offset towards the centre),
 * never read from the plan. Before this proof every createSteelBend part was listed as "finished unknown". */
const dimensions: SteelBendDimensions = { radius: 30, radiusConvention: 'inside', angleDegrees: 90,
  firstLeg: 100, secondLeg: 200, legDimension: 'tangent' };
function bent(key: string, length: number, extra: Partial<SteelBendDimensions> = {}): PartDocument {
  const row = STEEL_PRODUCTS.find(candidate => candidate.key === key);
  if (row === undefined) throw new Error('Missing sourced fixture');
  const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(length) });
  const result = createSteelBend(source, { ...dimensions, ...extra });
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}
function component(id: string): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'bent' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false };
}
const assembly = { ...createAssemblyDocument('root'), components: [component('a'), component('b')] };
const listed = (part: PartDocument) => buildSteelStockList(assembly, new Map(), new Map([['bent', part]])).rows;
const flatLength = 300 + 55 * Math.PI / 2;            // FB 50×6 towards +X: R_c = 30 + 50 / 2
const flatThinLength = 300 + 33 * Math.PI / 2;        // FB 50×6 towards 90 degrees: R_c = 30 + 6 / 2
const pipeLength = 300 + (30 + 10.85) * Math.PI / 2;  // SGP 15A, outside diameter 21.7: R_c = 30 + 21.7 / 2

describe('finished length of an unmachined steel bend', () => {
  it('lists the developed centroid length for flat bar, direction-rotated flat bar and hollow pipe bends', () => {
    const cases: readonly (readonly [PartDocument, number])[] = [
      [bent('SS400:flatBar:FB 50×6', flatLength), flatLength],
      [bent('SS400:flatBar:FB 50×6', flatThinLength, { directionDegrees: 90 }), flatThinLength],
      [bent('SGP:steelPipe:15A', pipeLength, { directionDegrees: 270 }), pipeLength],
    ];
    for (const [part, expected] of cases) {
      const rows = listed(part);
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(2);
      expect(rows[0].finishedLengthMm).toBe(rows[0].lengthMm);
      expect(Math.abs((rows[0].finishedLengthMm ?? Number.NaN) - expected) / expected).toBeLessThan(1e-12);
      expect(rows[0].totalLengthMm).toBe(2 * rows[0].lengthMm);
    }
  });

  it('keeps the finished length through the saved part library and a cloned reopen', async () => {
    const part = bent('SS400:flatBar:FB 50×6', flatLength);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'bend.pcad', 'bend.pcad');
    const saved = embedded.library.parts.get(embedded.partRef);
    if (saved === undefined) throw new Error('Missing saved bend');
    expect(listed(structuredClone(saved))).toEqual(listed(part));
    expect(listed(saved)[0].finishedLengthMm).toBe(listed(part)[0].lengthMm);
  });

  it('stays unproved, keeping the purchased length, after a cut, an edited radius, an edited section or a forged plane', async () => {
    const part = bent('SS400:flatBar:FB 50×6', flatThinLength, { directionDegrees: 90 });
    const purchased = listed(part)[0].lengthMm;
    const cut: CutFeature = { id: 'cut-1', name: 'cut-1', kind: 'cut', suppressed: false, targetFeatureId: 'steel-bend-sweep-0',
      pairedWith: null, plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(50) }, keep: 'positive' };
    const edit = (sketchId: string, featureId: string, change: (feature: SketchFeature) => SketchFeature): PartDocument => ({
      ...part, sketches: part.sketches.map(sketch => sketch.id !== sketchId ? sketch
        : { ...sketch, features: sketch.features.map(feature => feature.id === featureId ? change(feature) : feature) }) });
    const radius = edit('steel-bend-path', 'bend-arc', feature => feature.kind === 'arc'
      ? { ...feature, radius: { source: '40', value: 40, display: '40' } } : feature);
    const section = edit('steel-bend-section-0', 'edge-1', feature => feature.kind === 'line' && feature.to.mode === 'absolute'
      ? { ...feature, to: { ...feature.to, x: expressionValueFromNumber(60) } } : feature);
    const reference = part.references[0];
    if (reference?.kind !== 'referencePlane' || reference.plane.kind !== 'tilted') throw new Error('Missing bend plane');
    const forged: PartDocument = { ...part, references: [{ ...reference, plane: { ...reference.plane, angle: expressionValueFromNumber(0) } }] };
    for (const changed of [{ ...part, solids: [...part.solids, cut] }, radius, section, forged]) {
      expect(listed(changed).map(row => [row.lengthMm, row.finishedLengthMm, row.quantity])).toEqual([[purchased, null, 2]]);
    }
    // Undo of the radius edit restores the proved length; no edit mutated the bend.
    const embedded = await embedPart(EMPTY_PART_LIBRARY, radius, 'b.pcad', 'b.pcad');
    const library = await replacePartDocument(embedded.library, embedded.partRef, part);
    const restored = library.parts.get(embedded.partRef);
    if (restored === undefined) throw new Error('Missing restored bend');
    expect(listed(restored)[0].finishedLengthMm).toBe(purchased);
  });
});
