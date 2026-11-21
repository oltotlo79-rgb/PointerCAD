import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingDocument, type DrawingTable } from '@pointercad/model';
import { parseDrawing, serializeDrawing } from './drawingJson.js';

const savedAt = '2026-09-09T00:00:00.000Z';
const parameterTable: DrawingTable = {
  id: 'parameter-1', kind: 'parameter', position: [20, 30], columns: ['名前', '値', '単位', '説明'],
  options: { scope: 'function' }, layerId: 'layer-7',
};

function revisionDrawing(): DrawingDocument {
  const base = createDrawingDocument('部品図', {
    sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: './part.pcad', contentHash: 'abc123', importedAt: savedAt,
  });
  return { ...base, tables: [{
    id: 'table-1', kind: 'revision', position: [300, 20], columns: ['版', '内容'],
    rows: [['A', '初版']], options: { showHeader: true }, layerId: 'layer-7',
  }] };
}

describe('図面の係数の表と保存形式の版24', () => {
  it('版24で係数の表の定義を往復する', () => {
    const base = revisionDrawing();
    const document: DrawingDocument = { ...base, schemaVersion: 24, tables: [...base.tables, parameterTable] };
    const encoded = serializeDrawing(document, { savedAt });
    expect(encoded).toContain('"schema": 24');
    const reopened = parseDrawing(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).toEqual(document);
    expect(serializeDrawing(reopened.document, { savedAt })).toBe(encoded);
  });

  it.each([21, 22, 23])('版%iを名乗る係数の表は読む時も書く時も断る', (schemaVersion) => {
    const document: DrawingDocument = { ...revisionDrawing(), schemaVersion: 24, tables: [parameterTable] };
    expect(() => serializeDrawing({ ...document, schemaVersion }, { savedAt }))
      .toThrow(new RangeError('係数の表を保存するには保存形式の版24が必要です。'));
    const encoded = serializeDrawing(document, { savedAt })
      .replace('"schema": 24', `"schema": ${String(schemaVersion)}`)
      .replace('"schemaVersion": 24', `"schemaVersion": ${String(schemaVersion)}`);
    expect(parseDrawing(encoded)).toMatchObject({
      ok: false, error: { code: 'notPcad', message: '係数の表を読むには保存形式の版24が必要です。' },
    });
  });

  it('知らない表の種類は版24でも断る', () => {
    const document: DrawingDocument = { ...revisionDrawing(), schemaVersion: 24, tables: [parameterTable] };
    const encoded = serializeDrawing(document, { savedAt });
    expect(parseDrawing(encoded.replace('"kind": "parameter"', '"kind": "unknownTable"')))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it('従来の改訂欄だけを持つ図面は版22の保存バイトを保つ', () => {
    const document = revisionDrawing();
    expect(document.schemaVersion).toBe(22);
    const encoded = serializeDrawing(document, { savedAt });
    // 変更前の書き出し順、既定の層と版22から固定した UTF-8 バイトの指紋。
    expect(createHash('sha256').update(encoded, 'utf8').digest('hex')).toBe('9c12b407ddbca7be94ec5ee325a90b279cb172aa99e13f361b333154cac3237d');
    const reopened = parseDrawing(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(22);
    expect(serializeDrawing(reopened.document, { savedAt })).toBe(encoded);
  });
});
