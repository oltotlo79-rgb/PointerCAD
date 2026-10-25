import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { PartDocument } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { CoordinateInput, SketchFeature } from '../../sketch/types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { createStandardPartSource } from './buildStandardPart.js';
import { createSteelBend } from './steelBend.js';
import type { SteelBendDimensions } from './steelBendGeometry.js';
import { STEEL_PRODUCTS, steelLength, steelProductOptions } from './steelCatalog.js';
import { steelFinishedLength } from './steelFinishedLength.js';

/*
 * Hand-derived bends of the sourced FB 50x6 flat bar (task168). Inside radius 30 and the section's own inside offset
 * (half the bend-direction width: 25 in the default plane, 3 at 90 degrees) give the centreline radius 55 or 33; the
 * 90 degree turn adds r * pi / 2 to the 100 mm and 200 mm tangent legs. The same path is reached through the outside
 * radius 80 (= 30 + 50) and through outside-dimensioned legs (setback 80 * tan 45 = 80: 180 and 280 mm).
 */
const TANGENT: SteelBendDimensions = { radius: 30, radiusConvention: 'inside', angleDegrees: 90,
  firstLeg: 100, secondLeg: 200, legDimension: 'tangent' };
const FLAT = 300 + 55 * Math.PI / 2;
const ON_EDGE = 300 + 33 * Math.PI / 2;

function source(length: number): StandardPartSource {
  const row = STEEL_PRODUCTS.find(candidate => candidate.key === 'SS400:flatBar:FB 50×6');
  if (row === undefined) throw new Error('Missing sourced fixture');
  return createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(length) });
}
function bend(length: number, dimensions: SteelBendDimensions): { readonly document: PartDocument; readonly source: StandardPartSource } {
  const stock = source(length);
  const result = createSteelBend(stock, dimensions);
  if (!result.ok) throw new Error(`fixture: ${result.reason}`);
  return { document: result.document, source: stock };
}
function stockOf(length: number): number {
  const parsed = steelLength(String(length));
  if (parsed === null) throw new Error('fixture: stock');
  return parsed.value;
}
function point(input: CoordinateInput): readonly [number, number, number] {
  if (input.mode !== 'absolute') throw new Error('fixture: generator coordinates are absolute');
  return [input.x.value, input.y.value, input.z.value];
}
/** Replaces one feature of the saved path, leaving every other sketch, solid, reference and parameter untouched. */
function editPath(document: PartDocument, id: string, edit: (feature: SketchFeature) => SketchFeature): PartDocument {
  return { ...document, sketches: document.sketches.map(sketch => sketch.id !== 'steel-bend-path' ? sketch
    : { ...sketch, features: sketch.features.map(feature => feature.id === id ? edit(feature) : feature) }) };
}

describe('finished length of an unmachined createSteelBend part', () => {
  it('keeps every valid generated bend: default and rotated plane, inside or outside radius, tangent or outside legs', () => {
    const cases: readonly (readonly [number, SteelBendDimensions])[] = [
      [FLAT, TANGENT],
      [FLAT, { ...TANGENT, radius: 80, radiusConvention: 'outside' }],
      [FLAT, { ...TANGENT, firstLeg: 180, secondLeg: 280, legDimension: 'outside' }],
      [ON_EDGE, { ...TANGENT, directionDegrees: 90 }],
    ];
    for (const [length, dimensions] of cases) {
      const { document, source: stock } = bend(length, dimensions);
      expect(steelFinishedLength(document, stock), JSON.stringify(dimensions)).toBe(stockOf(length));
    }
  });

  it('refuses edited paths that keep the leg lengths, the arc radius and turn and the stock length', () => {
    const { document, source: stock } = bend(FLAT, TANGENT);
    const reversed = editPath(document, 'first-leg', feature => feature.kind !== 'line' ? feature
      : { ...feature, from: feature.to, to: feature.from });
    const movedCentre = editPath(document, 'bend-arc', feature => {
      if (feature.kind !== 'arc') return feature;
      const [x, y, z] = point(feature.center);
      return { ...feature, center: absoluteCoordinate(x + 10, y, z) };
    });
    // The 200 mm second leg turned to run on along +Z from its start: same length, no longer tangent to the arc end.
    const kinked = editPath(document, 'second-leg', feature => {
      if (feature.kind !== 'line') return feature;
      const [x, y, z] = point(feature.from);
      return { ...feature, to: absoluteCoordinate(x, y, z + 200) };
    });
    for (const [name, edited] of [['reversed first leg', reversed], ['moved arc centre', movedCentre], ['kinked second leg', kinked]] as const) {
      expect(steelFinishedLength(edited, stock), name).toBeNull();
    }
  });

  it('refuses a path coordinate whose saved source is not a plain number for its stored value', () => {
    const { document, source: stock } = bend(FLAT, TANGENT);
    const unparsable = editPath(document, 'first-leg', feature => {
      if (feature.kind !== 'line' || feature.to.mode !== 'absolute') return feature;
      return { ...feature, to: { ...feature.to, z: { ...expressionValueFromNumber(feature.to.z.value), source: 'leg' } } };
    });
    expect(steelFinishedLength(unparsable, stock)).toBeNull();
  });
});

describe('authored steel bend inputs remain distinguishable from general sketch edits', () => {
  it('recognizes the generated recipe and preserves its source expressions and unrounded inputs', async () => {
    const { steelBendInputState } = await import('./steelBend.js');
    const dimensions = { ...TANGENT, sources: { radius: '10 + 20', angleDegrees: '180 / 2', firstLeg: '50 * 2', secondLeg: '100 * 2' } };
    const { document, source: stock } = bend(FLAT, dimensions);
    const state = steelBendInputState(document);
    expect(state.status).toBe('original');
    if (state.status === 'missing') throw new Error('Expected authored inputs');
    expect(state.input.stockSource).toEqual(stock);
    expect(state.input.radius).toEqual({ source: '10 + 20', value: 30, display: '30' });
    expect(state.input.angleDegrees.source).toBe('180 / 2');
    expect(state.input.directionDegrees).toBeUndefined();
    expect(state.input.firstLeg.source).toBe('50 * 2');
    expect(state.input.secondLeg.source).toBe('100 * 2');
    expect(steelBendInputState({ ...document, id: 'saved-part', name: 'Renamed bend' })).toEqual(state);
  });

  it('detects path, section and expression edits even while original inputs are still present', async () => {
    const { steelBendInputState } = await import('./steelBend.js');
    const { document } = bend(FLAT, TANGENT);
    const reversed = editPath(document, 'first-leg', feature => feature.kind !== 'line' ? feature
      : { ...feature, from: feature.to, to: feature.from });
    const changedSource = editPath(document, 'bend-arc', feature => feature.kind !== 'arc' ? feature
      : { ...feature, radius: { ...feature.radius, source: 'radius' } });
    const changedSection: PartDocument = { ...document, sketches: document.sketches.map(sketch => sketch.id !== 'steel-bend-section-0' ? sketch
      : { ...sketch, features: sketch.features.map(feature => feature.kind !== 'line' ? feature
        : { ...feature, from: absoluteCoordinate(1, 2, 3) }) }) };
    for (const edited of [reversed, changedSource, changedSection]) {
      const state = steelBendInputState(edited);
      expect(state.status).toBe('modified');
      expect(edited.solids).toEqual(document.solids);
    }
    // Restoring the source history (as Undo does) restores the correspondence, without a persisted status flag.
    expect(steelBendInputState({ ...reversed, sketches: document.sketches }).status).toBe('original');
  });

  it('never accepts a duplicate owner, a changed stable ID or changed provenance as the original bend', async () => {
    const { steelBendInputState } = await import('./steelBend.js');
    const { document } = bend(FLAT, TANGENT);
    const first = document.solids[0];
    if (first?.kind !== 'sweep' || first.steelBend === undefined) throw new Error('Missing fixture input');
    expect(steelBendInputState({ ...document, solids: [...document.solids, { ...first, id: 'other-sweep' }] }).status).toBe('modified');
    expect(steelBendInputState({ ...document, solids: [{ ...first, id: 'changed-sweep' }] }).status).toBe('modified');
    expect(steelBendInputState({ ...document, steelStockSource: { ...first.steelBend.stockSource,
      options: { ...first.steelBend.stockSource.options, length: '1000' } } }).status).toBe('modified');
    expect(steelBendInputState({ ...document, solids: [{ ...first,
      steelBend: { ...first.steelBend, generatorRevision: 'steel-bend-future' } }] }).status).toBe('unsupported');
  });

  it('rejects inconsistent source expressions instead of storing an invented original input', () => {
    const stock = source(FLAT);
    for (const sources of [{ radius: '31' }, { angleDegrees: 'angle' }, { directionDegrees: '0' }]) {
      expect(createSteelBend(stock, { ...TANGENT, sources })).toEqual({ ok: false, reason: 'invalidExpression' });
    }
  });
});

describe('finished length is independent of optional authored bend inputs', () => {
  it('keeps the same proved length and rejects edited geometry with or without the recipe', async () => {
    const { steelBendInputState } = await import('./steelBend.js');
    const cases: readonly (readonly [number, SteelBendDimensions])[] = [
      [FLAT, TANGENT],
      [FLAT, { ...TANGENT, radius: 80, radiusConvention: 'outside',
        firstLeg: 180, secondLeg: 280, legDimension: 'outside',
        sources: { radius: '40 * 2', angleDegrees: '180 / 2', firstLeg: '100 + 80', secondLeg: '200 + 80' } }],
      [ON_EDGE, { ...TANGENT, directionDegrees: 90 }],
    ];
    for (const [length, dimensions] of cases) {
      const { document, source: stock } = bend(length, dimensions);
      const before = structuredClone(document);
      const legacy: PartDocument = { ...document, solids: document.solids.map(feature => {
        if (feature.kind !== 'sweep') return feature;
        const sweep = { ...feature };
        delete sweep.steelBend;
        return sweep;
      }) };
      expect(steelBendInputState(document).status).toBe('original');
      expect(steelBendInputState(legacy)).toEqual({ status: 'missing' });
      expect(steelFinishedLength(document, stock)).toBe(stockOf(length));
      expect(steelFinishedLength(legacy, stock)).toBe(stockOf(length));
      for (const part of [document, legacy]) {
        const reversed = editPath(part, 'first-leg', feature => feature.kind !== 'line' ? feature
          : { ...feature, from: feature.to, to: feature.from });
        expect(steelFinishedLength(reversed, stock)).toBeNull();
        expect(steelFinishedLength({ ...part, sketches: part.sketches.filter(sketch => sketch.id !== 'steel-bend-section-0') }, stock)).toBeNull();
      }
      expect(document).toEqual(before);
    }
  });
});
