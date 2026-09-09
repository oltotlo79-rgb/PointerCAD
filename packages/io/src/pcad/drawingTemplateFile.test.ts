import { describe, expect, it } from 'vitest';
import { createDrawingDocument, createDrawingTemplate, drawingFromTemplate, type DrawingTemplate } from '@pointercad/model';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { readDrawingTemplateFile, writeDrawingTemplateFile } from './drawingTemplateFile.js';
import { parseDrawingTemplate, serializeDrawingTemplate } from './drawingTemplateJson.js';
import { serializeDrawing } from './drawingJson.js';
import { PCAD_DRAWING_TEMPLATE_KIND, PCAD_SCHEMA_VERSION } from './schema.js';

const savedAt = '2026-09-10T00:00:00.000Z';
const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: savedAt };
function fixture(): DrawingTemplate {
  const document = createDrawingDocument('図面', source);
  return { name: '製作標準', sheet: { ...document.sheet, textHeight: 2.5, scaleOptions: [0.5, 1, 2], generalTolerance: 'm',
    titleBlockFields: [{ key: 'company', label: '会社', fixedText: '製作所', widthWeight: 2 }, { key: 'title', label: '名称' }] },
    layers: document.layers.map((layer, index) => ({ ...layer, lineWidth: 0.1 + index / 10 })) };
}

describe('図面ひな形.pcadtの保存と互換(P8-58)', () => {
  it('設定だけをZIPのdocument.jsonへ格納し、kindを部品と分ける', () => {
    const entries = unzipSync(writeDrawingTemplateFile(fixture(), savedAt));
    expect(Object.keys(entries)).toEqual(['document.json']);
    const raw: unknown = JSON.parse(strFromU8(entries['document.json']));
    expect(raw).toMatchObject({ kind: 'drawingTemplate', schema: PCAD_SCHEMA_VERSION, savedAt });
    expect(strFromU8(entries['document.json'])).not.toContain('source-1');
  });
  it('表題欄の順・固定文字・字体寸法・縮尺候補・普通公差・線幅を往復する', () => {
    expect(readDrawingTemplateFile(writeDrawingTemplateFile(fixture(), savedAt))).toEqual({ ok: true, template: fixture(), savedAt });
  });
  it('同じ入力を2回書くとZIPの時刻も含め全バイトが一致する', () => {
    expect(writeDrawingTemplateFile(fixture(), savedAt)).toEqual(writeDrawingTemplateFile(fixture(), savedAt));
  });
  it('新規図面の投影図・寸法・注記・表・風船はすべて空', () => {
    const result = readDrawingTemplateFile(writeDrawingTemplateFile(fixture(), savedAt));
    if (!result.ok) throw new Error(result.error.message);
    const opened = drawingFromTemplate(result.template, '新規', { ...source, sourceRef: 'new' });
    if (!opened.ok) throw new Error(opened.reason);
    expect([opened.document.views, opened.document.dimensions, opened.document.annotations, opened.document.tables, opened.document.balloons]).toEqual([[], [], [], [], []]);
    expect(opened.document.source.sourceRef).toBe('new');
  });
  it('旧版9の図面全体を持つひな形から設定だけを取り出す', () => {
    const document = { ...createDrawingDocument('旧標準', source), schemaVersion: 9,
      annotations: [{ id: 'note-1', kind: 'note' as const, text: 'モデル専用の注記', position: [20, 30] as const, height: 3.5, layerId: 'layer-5' }] };
    const parsed = parseDrawingTemplate(serializeDrawing(document, { kind: PCAD_DRAWING_TEMPLATE_KIND, savedAt }));
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('モデル専用の注記');
    expect(JSON.stringify(parsed)).not.toContain('source-1');
  });
  it('部品ひな形を図面用として受け取らない', () => {
    expect(parseDrawingTemplate(serializeDrawingTemplate(fixture(), savedAt).replace('drawingTemplate', 'partTemplate')))
      .toMatchObject({ ok: false, error: { code: 'unsupportedKind' } });
  });
  it('未来の版は理由を返す', () => {
    expect(parseDrawingTemplate(serializeDrawingTemplate(fixture(), savedAt).replace(`"schema": ${PCAD_SCHEMA_VERSION}`, '"schema": 999')))
      .toMatchObject({ ok: false, error: { code: 'unsupportedVersion' } });
  });
  it('壊れたJSONを断る', () => expect(parseDrawingTemplate('{')).toMatchObject({ ok: false, error: { code: 'invalidJson' } }));
  it('ZIPでない入力を断る', () => expect(readDrawingTemplateFile(strToU8('plain'))).toMatchObject({ ok: false, error: { code: 'notZip' } }));
  it('設定のないZIPを断る', () => expect(readDrawingTemplateFile(zipSync({ 'other.txt': strToU8('x') })))
    .toMatchObject({ ok: false, error: { code: 'missingDocument' } }));
  it('不正UTF8を文字置換で開かない', () => expect(readDrawingTemplateFile(zipSync({ 'document.json': new Uint8Array([0xc3, 0x28]) })))
    .toMatchObject({ ok: false, error: { code: 'invalidTemplate' } }));
  it('有限でない値は書出し前と読込後の両方で断る', () => {
    const template = fixture();
    expect(() => writeDrawingTemplateFile({ ...template, sheet: { ...template.sheet, scale: Infinity } }, savedAt)).toThrow();
    expect(parseDrawingTemplate(serializeDrawingTemplate(template, savedAt).replace('"scale": 1', '"scale": 1e400'))).toMatchObject({ ok: false });
  });
  it('縮尺候補の重複と負の字体寸法は受け入れない', () => {
    const template = fixture();
    expect(() => serializeDrawingTemplate({ ...template, sheet: { ...template.sheet, scaleOptions: [1, 1] } }, savedAt)).toThrow();
    expect(parseDrawingTemplate(serializeDrawingTemplate(template, savedAt).replace('"textHeight": 2.5', '"textHeight": -1'))).toMatchObject({ ok: false });
  });
  it('図面から取り出すと元の参照モデルと図は保存されない', () => {
    const result = createDrawingTemplate(createDrawingDocument('図面', source), '標準');
    if (!result.ok) throw new Error(result.reason);
    expect(Object.keys(result.template)).toEqual(['name', 'sheet', 'layers']);
  });
});
