import { expressionValueFromNumber } from '@pointercad/expression';
import type { CutFeature, PartDocument } from '../../part/types.js';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { steelProductOptions, STEEL_PRODUCTS } from './steelCatalog.js';
import { buildSteelStockList } from './steelStockList.js';

/** Purchased stock 1000 mm from the existing sourced catalog rows; no new grade, size or density. */
function purchasedPart(key: string): PartDocument {
  const row = STEEL_PRODUCTS.find(candidate => candidate.key === key);
  if (row === undefined) throw new Error(`Missing sourced product ${key}`);
  const part = buildStandardPartFromSource(createStandardPartSource(row.catalog, row.size,
    { ...steelProductOptions(row), length: '1000' }));
  if (part === null) throw new Error(`Generator refused ${key}`);
  return part;
}
/** The axial stock length edited in the part file (every generated extrude/cylinder, as for the pipe's two tubes). */
function withAxialLength(part: PartDocument, value: number): PartDocument {
  let edits = 0;
  const solids = part.solids.map(feature => {
    if (feature.kind === 'extrude') {
      edits += 1;
      return { ...feature, distance: { ...feature.distance, source: String(value), value, display: String(value) } };
    }
    if (feature.kind === 'primitive' && feature.shape.kind === 'cylinder') {
      edits += 1;
      return { ...feature, shape: { ...feature.shape,
        height: { ...feature.shape.height, source: String(value), value, display: String(value) } } };
    }
    return feature;
  });
  if (edits === 0) throw new Error('Unexpected generated stock history');
  return { ...part, solids };
}
function cut(part: PartDocument, z: number): PartDocument {
  const target = part.solids.at(-1)?.id;
  if (target === undefined) throw new Error('Missing stock solid');
  const feature: CutFeature = { id: 'cut-1', name: 'cut-1', kind: 'cut', suppressed: false, targetFeatureId: target,
    pairedWith: null, plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(z) }, keep: 'negative' };
  return { ...part, solids: [...part.solids, feature] };
}
function row(part: PartDocument) {
  const assembly = { ...createAssemblyDocument('root'), components: [{ id: 'bar', name: 'bar',
    source: { kind: 'part' as const, partRef: 'bar' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false }] };
  const list = buildSteelStockList(assembly, new Map(), new Map([['bar', part]]));
  expect(list.rows).toHaveLength(1);
  return list.rows[0];
}

describe('finished length never exceeds the purchased stock', () => {
  it.each(['SS400:flatBar:FB 50×6', 'S45C:roundBar:φ25', 'SGP:steelPipe:25A'])(
    '%s: a part lengthened past its 1000 mm stock is not reported as finished; shorter and cut lengths stay proved',
    key => {
      const part = purchasedPart(key);
      expect(part.steelStockSource?.options.length).toBe('1000');
      // Valid existing choices are not refused.
      expect([row(part).lengthMm, row(part).finishedLengthMm]).toEqual([1000, 1000]);
      expect(row(withAxialLength(part, 500)).finishedLengthMm).toBe(500);
      expect(row(withAxialLength(part, 1000)).finishedLengthMm).toBe(1000);
      // A 1200 mm model cut back to 900 mm can still come from the 1000 mm stock.
      expect(row(cut(withAxialLength(part, 1200), 900)).finishedLengthMm).toBe(900);
      // Invalid: 1500 mm or 1200 cut to 1100 mm cannot be cut from 1000 mm stock.
      for (const lengthened of [withAxialLength(part, 1500), cut(withAxialLength(part, 1200), 1100)]) {
        const result = row(lengthened);
        expect(result.finishedLengthMm).toBeNull();
        expect([result.lengthMm, result.quantity, result.totalLengthMm]).toEqual([1000, 1, 1000]);
        expect(lengthened.steelStockSource).toEqual(part.steelStockSource);
      }
      // Restoring the original history restores the proved length.
      expect(row(part).finishedLengthMm).toBe(1000);
    });
});
