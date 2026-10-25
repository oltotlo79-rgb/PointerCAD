import { evaluateExpression, exactExpressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, createStandardPartSource, createSteelBend, STEEL_PRODUCTS, steelProductOptions,
  type PartDocument, type SteelBendDimensions, type SweepFeature,
} from '@pointercad/model';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { steelBendInputState } from '../../../model/src/assembly/standard/steelBend.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const OPTIONS = { savedAt: '2026-10-24T12:34:00.000Z' };
const cornerArea = 1 - Math.PI / 4;
const angleArea = 564 + cornerArea * (6.5 ** 2 - 2 * 4.5 ** 2);
const angleCentroid = (8292 + cornerArea * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
  - cornerArea * 4.5 ** 2 * 47 - 4.5 ** 3 / 3) / angleArea;

// W01's independent inputs: no planner or section result supplies these lengths or dimensions.
const rows = [
  { key: 'SS400:flatBar:FB 50×6', insideRadius: 30, directions: [0, 90], centroid: 25, pipe: false },
  { key: 'SS400:equalAngle:L 50×50×6', insideRadius: 100, directions: [0, 180], centroid: angleCentroid, pipe: false },
  { key: 'SGP:steelPipe:15A', insideRadius: 30, directions: [45, 90], centroid: 0, pipe: true },
];
const oracleCases = rows.flatMap(row => [60, 120].flatMap((angleDegrees, index) =>
  (['inside', 'outside'] as const).map(radiusConvention => {
    const directionDegrees = row.directions[index];
    const width = row.pipe ? 21.7 : directionDegrees === 90 ? 6 : 50;
    const offset = row.pipe ? 10.85 : directionDegrees === 180 ? row.centroid : directionDegrees === 90 ? 3 : 50 - row.centroid;
    const outsideRadius = row.insideRadius + width;
    const legDimension = radiusConvention === 'inside' ? 'tangent' : angleDegrees === 60 ? 'inside' : 'outside';
    const setback = legDimension === 'tangent' ? 0 : (legDimension === 'inside' ? row.insideRadius : outsideRadius)
      * (angleDegrees === 60 ? 1 / Math.sqrt(3) : Math.sqrt(3));
    const input: SteelBendDimensions = { radius: radiusConvention === 'inside' ? row.insideRadius : outsideRadius,
      radiusConvention, angleDegrees, directionDegrees, firstLeg: 100 + setback, secondLeg: 200 + setback, legDimension };
    return { key: row.key, length: 300 + (row.insideRadius + offset) * angleDegrees * Math.PI / 180, input };
  })));

function owner(document: PartDocument): SweepFeature {
  const feature = document.solids[0];
  if (feature?.kind !== 'sweep') throw new Error('Expected the outer bend sweep');
  return feature;
}

function recipe(document: PartDocument): NonNullable<SweepFeature['steelBend']> {
  const input = owner(document).steelBend;
  if (input === undefined) throw new Error('Missing authored bend input');
  return input;
}

function create(test: { readonly key: string; readonly length: number; readonly input: SteelBendDimensions }): PartDocument {
  const row = STEEL_PRODUCTS.find(product => product.key === test.key);
  if (row === undefined) throw new Error('Missing catalog row');
  const stock = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(test.length) });
  const result = createSteelBend(stock, test.input);
  if (!result.ok) throw new Error(`Bend fixture: ${result.reason}`);
  return result.document;
}

function parsed(text: string): PartDocument {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.document;
}

function withSources(input: SteelBendDimensions): SteelBendDimensions {
  const source = (value: number) => `(${exactExpressionValueFromNumber(value).source}) + 0`;
  return { ...input, sources: { radius: source(input.radius), angleDegrees: source(input.angleDegrees),
    firstLeg: source(input.firstLeg), secondLeg: source(input.secondLeg),
    ...(input.directionDegrees === undefined ? {} : { directionDegrees: source(input.directionDegrees) }) } };
}

function expression(source: string) {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error('Invalid fixture expression');
  return result.value;
}

function checkRoundtrip(document: PartDocument): PartDocument {
  const first = serializeDocument(document, OPTIONS);
  const reopened = parsed(first);
  expect(reopened.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  expect(recipe(reopened)).toEqual(recipe(document));
  expect(serializeDocument(reopened, OPTIONS)).toBe(first);
  const bytes = writePcadFile(document, OPTIONS);
  expect(Object.keys(unzipSync(bytes))).toEqual(['document.json']);
  const file = readPcadFile(bytes);
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  expect(recipe(file.document)).toEqual(recipe(document));
  expect(file.attachments.shapes.size).toBe(0);
  expect(file.attachments.meshes.size).toBe(0);
  expect(writePcadFile(file.document, OPTIONS)).toEqual(bytes);
  return reopened;
}

describe('steel bend authored input persistence', () => {
  it.each(oracleCases)('W01 $key / $input.radiusConvention / $input.angleDegrees / $input.directionDegrees', test => {
    const dimensions = withSources(test.input);
    const document = create({ ...test, input: dimensions });
    const sources = dimensions.sources;
    if (sources?.radius === undefined || sources.angleDegrees === undefined || sources.firstLeg === undefined
      || sources.secondLeg === undefined || sources.directionDegrees === undefined) throw new Error('Missing fixture sources');
    expect(recipe(document)).toEqual({
      id: owner(document).id, generatorRevision: 'steel-bend-1', productKey: test.key, stockSource: document.steelStockSource,
      radiusConvention: dimensions.radiusConvention, legDimension: dimensions.legDimension,
      radius: expression(sources.radius), angleDegrees: expression(sources.angleDegrees),
      firstLeg: expression(sources.firstLeg), secondLeg: expression(sources.secondLeg), directionDegrees: expression(sources.directionDegrees),
    });
    const reopened = checkRoundtrip(document);
    expect(steelBendInputState(reopened)).toEqual({ status: 'original', input: recipe(document) });
    expect(reopened.sketches.map(sketch => [sketch.id, sketch.features.map(feature => feature.id)]))
      .toEqual(document.sketches.map(sketch => [sketch.id, sketch.features.map(feature => feature.id)]));
    expect(reopened.solids.map(feature => feature.id)).toEqual(document.solids.map(feature => feature.id));
    expect(reopened.references.map(feature => feature.id)).toEqual(document.references.map(feature => feature.id));
  });

  const conventions = (['inside', 'outside'] as const).flatMap(radiusConvention =>
    (['tangent', 'inside', 'outside'] as const).flatMap(legDimension => [0, 90].map(directionDegrees =>
      ({ radiusConvention, legDimension, directionDegrees }))));
  it.each(conventions)('all bases: $radiusConvention R / $legDimension legs / $directionDegrees', test => {
    const width = test.directionDegrees === 0 ? 50 : 6;
    const setback = test.legDimension === 'tangent' ? 0 : test.legDimension === 'inside' ? 30 : 30 + width;
    const input: SteelBendDimensions = { ...test, radius: test.radiusConvention === 'inside' ? 30 : 30 + width,
      angleDegrees: 90, firstLeg: 100 + setback, secondLeg: 200 + setback };
    const document = create({ key: rows[0].key, length: 300 + (30 + width / 2) * Math.PI / 2, input });
    expect(steelBendInputState(checkRoundtrip(document)).status).toBe('original');
    expect(recipe(document).radius.value).toBe(input.radius);
    expect(recipe(document).firstLeg.value).toBe(input.firstLeg);
    expect(recipe(document).secondLeg.value).toBe(input.secondLeg);
  });

  it.each([17, 21, 22])('reads legacy envelope %i without inventing original inputs or geometry attachments', schemaVersion => {
    const document = create(oracleCases[0]);
    const solids = document.solids.map(feature => {
      if (feature.kind !== 'sweep') return feature;
      const sweep = { ...feature };
      delete sweep.steelBend;
      return sweep;
    });
    const withoutStock = { ...document };
    delete withoutStock.steelStockSource;
    const legacy: PartDocument = { ...(schemaVersion < 19 ? withoutStock : document), schemaVersion, solids };
    const bytes = writePcadFile(legacy, OPTIONS);
    expect(Object.keys(unzipSync(bytes))).toEqual(['document.json']);
    const result = readPcadFile(bytes);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(owner(result.document).steelBend).toBeUndefined();
    expect(Object.hasOwn(owner(result.document), 'steelBend')).toBe(false);
    expect(steelBendInputState(result.document)).toEqual({ status: 'missing' });
    expect(result.document.solids).toEqual(solids);
    expect(result.document.steelStockSource).toEqual(legacy.steelStockSource);
    expect(result.attachments.shapes.size + result.attachments.meshes.size).toBe(0);
    const current = serializeDocument(result.document, OPTIONS);
    expect(current).not.toContain('steelBend');
    expect(serializeDocument(parsed(current), OPTIONS)).toBe(current);
    expect(Object.keys(unzipSync(writePcadFile(result.document, OPTIONS)))).toEqual(['document.json']);
  });

  it('retains the original recipe but detects a generally edited sketch before and after saving', () => {
    const document = create(oracleCases[0]);
    const edited: PartDocument = { ...document, sketches: document.sketches.map(sketch => sketch.id !== 'steel-bend-path' ? sketch
      : { ...sketch, features: sketch.features.map(feature => feature.kind !== 'arc' ? feature
        : { ...feature, center: absoluteCoordinate(123, 0, 100) }) }) };
    expect(steelBendInputState(document).status).toBe('original');
    expect(steelBendInputState(edited)).toEqual({ status: 'modified', input: recipe(document) });
    expect(steelBendInputState(checkRoundtrip(edited))).toEqual({ status: 'modified', input: recipe(document) });
  });

  it('preserves a noncanonical direction and distinguishes omitted direction from explicit zero', () => {
    for (const directionDegrees of [undefined, 0, 360, -270]) {
      const input: SteelBendDimensions = { radius: 30, radiusConvention: 'inside', angleDegrees: 90,
        firstLeg: 100, secondLeg: 200, legDimension: 'tangent', ...(directionDegrees === undefined ? {} : { directionDegrees }) };
      const length = 300 + (directionDegrees === -270 ? 33 : 55) * Math.PI / 2;
      const reopened = checkRoundtrip(create({ key: rows[0].key, length, input }));
      expect(recipe(reopened).directionDegrees?.value).toBe(directionDegrees);
      expect(steelBendInputState(reopened).status).toBe('original');
    }
  });

  it.each(['generatorRevision', 'productKey', 'id', 'radiusConvention', 'legDimension', 'radius', 'stockSource'])(
    'rejects a malformed %s field rather than silently dropping the recipe', key => {
    const raw: unknown = JSON.parse(serializeDocument(create(oracleCases[0]), OPTIONS));
    if (!isRecord(raw) || !isRecord(raw.document) || !Array.isArray(raw.document.solids)) throw new Error('Invalid fixture envelope');
    const first: unknown = raw.document.solids[0];
    if (!isRecord(first) || !isRecord(first.steelBend)) throw new Error('Invalid fixture recipe');
    first.steelBend[key] = null;
    expect(parseDocument(JSON.stringify(raw)).ok).toBe(false);
    });

  it('preserves unknown recipe revisions without claiming they can be regenerated', () => {
    const document = create(oracleCases[0]);
    const input = { ...recipe(document), generatorRevision: 'steel-bend-future' };
    const future: PartDocument = { ...document, solids: document.solids.map(feature => feature.id !== input.id ? feature
      : { ...owner(document), steelBend: input }) };
    expect(steelBendInputState(checkRoundtrip(future))).toEqual({ status: 'unsupported', input });
  });

  it('does not write an authored recipe into a legacy envelope', () => {
    const document = create(oracleCases[0]);
    expect(() => serializeDocument({ ...document, schemaVersion: 21 }, OPTIONS)).toThrow('Authored steel bend inputs');
  });
});
