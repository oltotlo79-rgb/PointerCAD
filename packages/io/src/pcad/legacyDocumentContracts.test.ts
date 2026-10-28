import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { resolveSketch } from '@pointercad/model';
import { migrateToCurrentSchema, parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { SCHEMA_MIGRATIONS } from './schema.js';

const SAVED_AT = '2026-09-03T01:23:45.678Z';
const VERSIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const expression = (source: string, value: number) => ({ source, value, display: String(value) });
const origin = () => ({ mode: 'absolute', x: expression('0', 0), y: expression('0', 0), z: expression('0', 0) });

/** The existing inline v3 fixtures are legacyLine/legacyPointArray in documentJson.test.ts.
 * Rebuild their historical field layout without a current document factory or serializer.
 * The additional 3+7 expression has the independently known value 10 mm.
 * Later required fields are present only from their documented introduction version. */
function oldPart(version: number): Record<string, unknown> {
  const line = { id: 'line-1', kind: 'line', name: '線分1', planeId: 'xy', from: origin(),
    to: { ...origin(), x: expression('3+7', 10) }, ...(version >= 4 ? { construction: false } : {}) };
  const layout = { base: origin(), azimuth: expression('0', 0), spacing: expression('10', 10), count: expression('3', 3) };
  const array = { id: 'pointArray-1', kind: 'pointArray', name: '点列1', planeId: 'xy',
    ...(version >= 4 ? { layout: { kind: 'linear', ...layout } } : layout) };
  return {
    id: 'part-1', name: '旧版の部品', schemaVersion: version, activeSketchId: 'sketch-1', solids: [],
    sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: version >= 3 ? [line, array] : [line] }],
    ...(version >= 4 ? { references: [] } : {}),
    ...(version >= 5 ? { parameters: [{ name: '板厚', value: expression('3+7', 10), unit: 'mm', description: '元の式' }] } : {}),
    ...(version >= 6 ? { appearance: { entries: [] } } : {}),
    ...(version >= 7 ? { selectionSets: [], canvases: [] } : {}),
    ...(version >= 10 ? { namedViews: [], configurations: [{ id: 'config-old', name: '旧設定', values: { 板厚: '3+7' } }],
      activeConfigurationId: 'config-old' } : {}),
    ...(version >= 12 ? { sheetUnfolds: [] } : {}),
  };
}

function envelope(version: number, document: Record<string, unknown> = oldPart(version), kind = 'part') {
  return { schema: version, kind, app: 'PointerCAD', savedAt: SAVED_AT, document };
}

function openedPart(raw: unknown) {
  const opened = parseDocument(JSON.stringify(raw));
  if (!opened.ok) throw new Error(`legacy part: ${opened.error.code} ${opened.error.message}`);
  return opened;
}

function assertPartMeaning(document: ReturnType<typeof openedPart>['document'], version: number) {
  expect(document.schemaVersion).toBe(22);
  expect([document.id, document.activeSketchId, document.sketches[0].id]).toEqual(['part-1', 'sketch-1', 'sketch-1']);
  const line = document.sketches[0].features[0];
  if (line.kind !== 'line' || line.to.mode !== 'absolute') throw new Error('legacy line identity lost');
  expect(line.id).toBe('line-1');
  expect(line.construction).toBe(false);
  expect(line.to.x).toEqual({ source: '3+7', value: 10, display: '10' });
  if (version >= 3) {
    const array = document.sketches[0].features[1];
    if (array.kind !== 'pointArray') throw new Error('legacy point array lost');
    expect(array.id).toBe('pointArray-1');
    expect(array.layout.kind).toBe('linear');
    // Three points, base 0 and spacing 10: these coordinates are not computed by a second migration/serializer.
    expect(resolveSketch(document.sketches[0]).points.filter(point => point.featureId === 'pointArray-1')
      .map(point => point.position)).toEqual([[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
  }
  expect(document.references).toEqual([]);
  expect(document.appearance.entries).toEqual([]);
  expect(document.selectionSets).toEqual([]);
  expect(document.canvases).toEqual([]);
  expect(document.sheetUnfolds).toEqual([]);
  expect(document.parameters).toEqual(version >= 5
    ? [{ name: '板厚', value: { source: '3+7', value: 10, display: '10' }, unit: 'mm', description: '元の式' }]
    : []);
  for (const absent of ['featureNotes', 'unresolvedMathProblems', 'mathGeometry', 'mathParameterSerial',
    'steelStockSource', 'beamAnalysisInputs', 'patternSlotHighWater']) expect(Object.hasOwn(document, absent)).toBe(false);
  if (version >= 10) {
    expect(document.activeConfigurationId).toBe('config-old');
    expect(document.configurations).toEqual([{ id: 'config-old', name: '旧設定', values: { 板厚: '3+7' } }]);
  } else {
    expect(document.namedViews).toHaveLength(4);
    expect(document.configurations[0].values).toEqual(version >= 5 ? { 板厚: '3+7' } : {});
  }
}

describe('legacy saved-document contracts with independently derived meanings', () => {
  it.each(VERSIONS)('reads historical part schema%s through every remaining migration and current JSON/ZIP boundaries', version => {
    const raw = envelope(version);
    const original = JSON.stringify(raw);
    const opened = openedPart(raw);
    assertPartMeaning(opened.document, version);
    expect(JSON.stringify(raw)).toBe(original);
    const archive = readPcadFile(zipSync({ 'document.json': strToU8(original) }));
    if (!archive.ok) throw new Error(`legacy ZIP: ${archive.error.code}`);
    assertPartMeaning(archive.document, version);
    const currentText = serializeDocument(opened.document, { savedAt: SAVED_AT });
    expect(currentText).toContain('"schema": 22');
    assertPartMeaning(openedPart(JSON.parse(currentText) as unknown).document, version);
    const currentZip = readPcadFile(writePcadFile(opened.document, { savedAt: SAVED_AT }));
    if (!currentZip.ok) throw new Error('current ZIP round trip rejected');
    assertPartMeaning(currentZip.document, version);
  });

  it.each(VERSIONS)('rejects structural corruption and mismatch; a repairable old cache cannot become geometry at schema%s', version => {
    expect(parseDocument(JSON.stringify(envelope(version, { ...oldPart(version), schemaVersion: version + 1 }))))
      .toMatchObject({ ok: false, error: { code: 'versionMismatch' } });
    const text = JSON.stringify(envelope(version));
    expect(text).toContain('"source":"3+7","value":10');
    const corrupt = text.replace('"source":"3+7"', '"source":123');
    expect(parseDocument(corrupt)).toMatchObject({ ok: false, error: { code: 'invalidField' } });
    expect(readPcadFile(zipSync({ 'document.json': strToU8(corrupt) })))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
    // FR-504 deliberately keeps an old invalid cached value so its original source remains editable.
    // guards.ts readExpressionItem and documentJson.test.ts's existing NaN regressions specify this.
    const invalidCache = text.replace('"source":"3+7","value":10', '"source":"3+7","value":1e999');
    const opened = parseDocument(invalidCache);
    if (!opened.ok) throw new Error('repairable legacy expression source lost');
    const line = opened.document.sketches[0].features[0];
    if (line.kind !== 'line' || line.to.mode !== 'absolute') throw new Error('legacy line lost');
    expect(line.to.x.source).toBe('3+7');
    expect(Number.isFinite(line.to.x.value)).toBe(false);
    const resolved = resolveSketch(opened.document.sketches[0]);
    expect(resolved.errors).toContainEqual(expect.objectContaining({ featureId: 'line-1', code: 'invalidValue' }));
    expect(resolved.segments.some(segment => segment.featureId === 'line-1')).toBe(false);
    const archive = readPcadFile(zipSync({ 'document.json': strToU8(invalidCache) }));
    expect(archive.ok).toBe(true);
  });

  it('refuses unsupported schema1 and future schema23 without relabelling them as current', () => {
    expect(parseDocument(JSON.stringify(envelope(1)))).toMatchObject({ ok: false, error: { code: 'unsupportedOldVersion' } });
    expect(parseDocument(JSON.stringify(envelope(23)))).toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
  });

  it('does not repair present malformed optional contracts while migrating old documents', () => {
    for (const [version, field] of [[14, 'featureNotes'], [15, 'unresolvedMathProblems'], [16, 'mathGeometry'],
      [17, 'patternSlotHighWater'], [18, 'steelStockSource'], [19, 'beamAnalysisInputs']] as const) {
      expect(parseDocument(JSON.stringify(envelope(version, { ...oldPart(version), [field]: 'corrupt' }))))
        .toMatchObject({ ok: false, error: { code: 'invalidField' } });
    }
  });

  it('keeps an explicit bad loft smoothing value for rejection rather than inventing a valid default', () => {
    const migrate = SCHEMA_MIGRATIONS[12];
    if (migrate === undefined) throw new Error('missing migration12');
    expect(migrate(envelope(12, { ...oldPart(12), solids: [{ id: 'loft-old', kind: 'loft' }] })))
      .toMatchObject({ schema: 13, document: { solids: [{ id: 'loft-old', smooth: false }] } });
    expect(migrate(envelope(12, { ...oldPart(12), solids: [{ id: 'loft-old', kind: 'loft', smooth: 'corrupt' }] })))
      .toMatchObject({ document: { solids: [{ smooth: 'corrupt' }] } });
  });

  it('keeps legacy template inch display separate from internal millimetres and preserves raw tool expressions', () => {
    const defaults = { extrudeDistance: '1/2in', holeDiameter: '8.5', filletRadius: '板厚', chamferDistance: '0.5', circleRadius: '12' };
    const raw = { ...envelope(7, oldPart(7), 'partTemplate'), lengthUnit: 'inch', toolDefaults: defaults };
    const opened = openedPart(raw);
    expect(opened.kind).toBe('partTemplate');
    expect(opened.lengthUnit).toBe('inch');
    expect(opened.toolDefaults).toEqual(defaults);
    assertPartMeaning(opened.document, 7);
    const text = serializeDocument(opened.document, { savedAt: SAVED_AT, kind: 'partTemplate', lengthUnit: 'inch', toolDefaults: defaults });
    expect(parseDocument(text)).toMatchObject({ ok: true, kind: 'partTemplate', lengthUnit: 'inch', toolDefaults: defaults });
    expect(openedPart(envelope(7, oldPart(7), 'partTemplate')).lengthUnit).toBeUndefined();
    expect(openedPart(envelope(7, oldPart(7), 'partTemplate')).toolDefaults).toBeUndefined();
    expect(parseDocument(JSON.stringify({ ...raw, lengthUnit: 'cm' }))).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it('retains schema8 assembly identity, parameter units and expressions through schema22', () => {
    // Assembly starts at schema8. The defensive migration7 assembly branch is not a historical fixture.
    const document = { id: 'assembly-1', name: '旧組立', schemaVersion: 8, components: [], mates: [], joints: [], presentation: [],
      parameters: [{ name: '板厚', value: { source: '12', value: 12, display: '12' }, unit: 'mm', description: '板の厚み' }],
      bom: { columns: ['name', 'quantity'], sortBy: 'name', expandSubAssemblies: true } };
    const raw = { ...envelope(8, document, 'assembly'), partFiles: [] };
    const opened = readAssemblyDocument(JSON.stringify(raw));
    if (!opened.ok) throw new Error(`legacy assembly: ${opened.error.code}`);
    expect(opened.document).toMatchObject({ id: 'assembly-1', schemaVersion: 22, components: [],
      parameters: [{ name: '板厚', unit: 'mm', value: { source: '12', value: 12, display: '12' } }] });
    expect(Object.hasOwn(opened.document, 'jointOccurrenceConnections')).toBe(false);
    const again = readAssemblyDocument(writeAssemblyDocument(opened.document, { savedAt: SAVED_AT }));
    expect(again).toMatchObject({ ok: true, document: opened.document });
    expect(readAssemblyDocument(JSON.stringify({ ...raw, schema: 23 })))
      .toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
    expect(readAssemblyDocument(JSON.stringify({ ...raw, document: { ...document, schemaVersion: 9 } })))
      .toMatchObject({ ok: false, error: { code: 'versionMismatch' } });
  });

  it.each(['drawing', 'drawingTemplate'])('retains schema9 %s source, paper units and omitted manufacturing definitions', kind => {
    const document = { id: 'drawing-1', name: '旧図面', schemaVersion: 9,
      source: { sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: './part.pcad', contentHash: 'abc123', importedAt: SAVED_AT },
      sheet: { paperSizeId: 'A3-landscape', orientation: 'landscape', scale: 0.5, projectionMethod: 'third', frame: { visible: true },
        titleBlock: { title: '旧図面', drawingNumber: 'A-1', revision: '', author: '', date: '', material: '' } },
      views: [], dimensions: [], annotations: [{ id: 'note-1', kind: 'note', text: '注記', position: [20, 30], height: 3.5, layerId: 'layer-5' }],
      tables: [], balloons: [], layers: [], parameters: [] };
    const raw = envelope(9, document, kind);
    const opened = parseDrawing(JSON.stringify(raw));
    if (!opened.ok) throw new Error(`legacy drawing: ${opened.error.code}`);
    expect(opened).toMatchObject({ kind, document: { id: 'drawing-1', schemaVersion: 22,
      source: { sourceRef: 'source-1', contentHash: 'abc123' }, sheet: { scale: 0.5 },
      annotations: [{ id: 'note-1', position: [20, 30], height: 3.5 }], datums: [], gdtFrames: [], weldSymbols: [] } });
    expect(parseDrawing(serializeDrawing(opened.document, { savedAt: SAVED_AT, kind: opened.kind })))
      .toMatchObject({ ok: true, kind, document: opened.document });
    expect(parseDrawing(JSON.stringify({ ...raw, schema: 23 })))
      .toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
    expect(parseDrawing(JSON.stringify({ ...raw, document: { ...document, schemaVersion: 10 } })))
      .toMatchObject({ ok: false, error: { code: 'versionMismatch' } });
  });

  it('a missing migration chain is rejected rather than claiming compatibility with schema1', () => {
    expect(migrateToCurrentSchema(envelope(1), 1)).toBeNull();
  });
});
