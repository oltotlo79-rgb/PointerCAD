import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendFeature, createAssemblyDocument, createDrawingDocument,
  createEmptyPartDocument, replaceSketch, type SketchElementRef, type SketchFeature } from '@pointercad/model';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { SCHEMA_MIGRATIONS } from './schema.js';

const savedAt = '2026-09-03T01:23:45.678Z';
const holes: readonly (readonly SketchElementRef[])[] = [[{ featureId: 'inner' }]];

function faceDocument(inner?: readonly (readonly SketchElementRef[])[]) {
  const part = createEmptyPartDocument();
  const rectangle: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(60, 40, 0), construction: false };
  const circle: SketchFeature = { id: 'inner', name: 'inner', kind: 'arc', planeId: 'xy',
    center: absoluteCoordinate(30, 20, 0), radius: { source: '5', value: 5, display: '5' },
    startAngle: { source: '0', value: 0, display: '0' },
    endAngle: { source: '360', value: 360, display: '360' }, construction: false };
  const face = { id: 'face-1', name: 'face', kind: 'face' as const, planeId: 'xy',
    boundary: [{ featureId: rectangle.id }], color: '#eeeeee', ...(inner === undefined ? {} : { holes: inner }) };
  return replaceSketch(part, [rectangle, circle, face].reduce((sketch, feature) => appendFeature(sketch, feature), part.sketches[0]));
}

describe('穴つきの面の保存形式23', () => {
  it('穴なしの版22は開いて保存し直しても1バイトも変わらず、空の穴の欄も書かない', () => {
    const original = serializeDocument(faceDocument(), { savedAt });
    const reopened = parseDocument(original);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(22);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(original);
    expect(serializeDocument(faceDocument([]), { savedAt })).toBe(original);
    expect(original).not.toContain('"holes"');
  });

  it('版23で穴の参照を往復し、版22を名乗った保存は断る', () => {
    const document = { ...faceDocument(holes), schemaVersion: 23 };
    const encoded = serializeDocument(document, { savedAt });
    expect(encoded).toContain('"holes"');
    const reopened = parseDocument(encoded);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.sketches[0].features.at(-1)).toMatchObject({ holes });
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
    expect(() => serializeDocument(faceDocument(holes), { savedAt })).toThrow(/23/);
  });

  it('版22を名乗る穴つきの入力を、欄を捨てる前に断る', () => {
    const document = faceDocument(holes);
    const result = parseDocument(JSON.stringify({ schema: 22, kind: 'part', app: 'PointerCAD', savedAt, document }));
    expect(result).toMatchObject({ ok: false, error: { code: 'notPcad' } });
    if (result.ok) throw new Error('穴が黙って捨てられました');
    expect(result.error.message).toContain('23');
  });

  it('版24は読み(次の版の欄を使った文書の版)、版25は更新を促して断る(M-02 で読める上限を 24 にした)', () => {
    const version24 = parseDocument(serializeDocument({ ...faceDocument(holes), schemaVersion: 24 }, { savedAt }));
    expect(version24).toMatchObject({ ok: true, document: { schemaVersion: 24 } });
    const result = parseDocument(serializeDocument({ ...faceDocument(), schemaVersion: 25 }, { savedAt }));
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
    if (result.ok) throw new Error('新しい版が読めました');
    expect(result.error.message).toContain('アプリを更新');
  });

  it('移行表は2から23まで揃い、22から23・23から24は番号以外を変えない', () => {
    expect(Object.keys(SCHEMA_MIGRATIONS).map(Number).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 22 }, (_, index) => index + 2));
    for (const from of [22, 23]) {
      const migrate = SCHEMA_MIGRATIONS[from];
      if (migrate === undefined) throw new Error(`移行${String(from)}がありません`);
      const raw = { schema: from, document: { schemaVersion: from, custom: ['unchanged'] } };
      expect(migrate(raw)).toEqual({ schema: from + 1, document: { ...raw.document, schemaVersion: from + 1 } });
      expect(raw.schema).toBe(from);
    }
  });

  it('アセンブリと図面も版23・24を読み、版25を断る', () => {
    const assembly = createAssemblyDocument('assembly');
    const drawing = createDrawingDocument('drawing', { sourceRef: 'source', sourceKind: 'part',
      fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' });
    for (const schemaVersion of [23, 24, 25]) {
      const results = [
        readAssemblyDocument(writeAssemblyDocument({ ...assembly, schemaVersion }, { savedAt })),
        parseDrawing(serializeDrawing({ ...drawing, schemaVersion }, { savedAt })),
      ];
      for (const result of results) {
        if (schemaVersion <= 24) expect(result).toMatchObject({ ok: true, document: { schemaVersion } });
        else expect(result).toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
      }
    }
  });
});
