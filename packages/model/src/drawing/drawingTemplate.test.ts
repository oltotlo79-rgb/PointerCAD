import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from './createDrawingDocument.js';
import { createDrawingTemplate, drawingFromTemplate, validateDrawingTemplate, type DrawingTemplate } from './drawingTemplate.js';

const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '2026-01-01' };
function fixture(): DrawingTemplate {
  const document = createDrawingDocument('old', source);
  return { name: '社内標準', sheet: { ...document.sheet, textHeight: 3.5, scaleOptions: [0.5, 1, 2],
    titleBlockFields: [{ key: 'company', label: '会社名', fixedText: '製作所', widthWeight: 2 }, { key: 'title', label: '名称' }],
    generalTolerance: 'm' }, layers: document.layers };
}
describe('図面ひな形の設定(P8-58)', () => {
  it('表題欄の順・固定文字・字体寸法・縮尺候補・普通公差を残す', () => {
    const template = fixture();
    const result = drawingFromTemplate(template, 'new', { ...source, sourceRef: 'new-source' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.sheet).toEqual(template.sheet);
    expect(result.document.source.sourceRef).toBe('new-source');
    expect(result.document.name).toBe('new');
  });
  it('図・寸法・注記・表・元モデル・風船をひな形へ含めない', () => {
    const document = createDrawingDocument('図面', source);
    const result = createDrawingTemplate({ ...document,
      annotations: [{ id: 'note-1', kind: 'note', text: '保存対象外', position: [10, 10], height: 3.5, layerId: 'note' }],
      tables: [{ id: 'table-1', kind: 'revision', position: [10, 30], columns: ['revision'], rows: [['A']], options: {}, layerId: 'note' }],
    }, 'ひな形');
    expect(result.ok && Object.keys(result.template)).toEqual(['name', 'sheet', 'layers']);
    expect(JSON.stringify(result)).not.toContain('保存対象外');
    expect(JSON.stringify(result)).not.toContain('source-1');
  });
  it('新規図面に空の履歴を用意する', () => {
    const result = drawingFromTemplate(fixture(), 'new', source);
    if (!result.ok) throw new Error(result.reason);
    expect([result.document.views, result.document.dimensions, result.document.annotations,
      result.document.tables, result.document.balloons, result.document.parameters]).toEqual([[], [], [], [], [], []]);
  });
  it('設定のオブジェクトや配列を共有しない', () => {
    const template = fixture();
    const result = drawingFromTemplate(template, 'new', source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.sheet).not.toBe(template.sheet);
    expect(result.document.layers[0]).not.toBe(template.layers[0]);
  });
  it('名前が空なら断る', () => {
    expect(validateDrawingTemplate({ ...fixture(), name: '　' })).toMatchObject({ ok: false, reason: 'emptyName' });
  });
  it('用紙のIDと向きの食い違いを断る', () => {
    const template = fixture();
    expect(validateDrawingTemplate({ ...template, sheet: { ...template.sheet, orientation: 'portrait' } })).toMatchObject({ ok: false, reason: 'invalidPaper' });
  });
  it.each([0, -1, Infinity])('不正な文字の高さ%sを断る', (textHeight) => {
    const template = fixture();
    expect(validateDrawingTemplate({ ...template, sheet: { ...template.sheet, textHeight } })).toMatchObject({ ok: false, reason: 'invalidTextHeight' });
  });
  it('縮尺候補の空欄・重複・無限大を断る', () => {
    const template = fixture();
    for (const scaleOptions of [[], [1, 1], [Infinity]]) {
      expect(validateDrawingTemplate({ ...template, sheet: { ...template.sheet, scaleOptions } })).toMatchObject({ ok: false, reason: 'invalidScale' });
    }
  });
  it('表題欄の重複キーを断る', () => {
    const template = fixture();
    expect(validateDrawingTemplate({ ...template, sheet: { ...template.sheet,
      titleBlockFields: [{ key: 'title', label: '図名' }, { key: 'title', label: '名称' }],
    } })).toMatchObject({ ok: false, reason: 'invalidFields' });
  });
  it('レイヤーの同一IDを断る', () => {
    const template = fixture();
    expect(validateDrawingTemplate({ ...template, layers: [template.layers[0], template.layers[0]] })).toMatchObject({ ok: false, reason: 'invalidLayers' });
  });
  it('同じ入力なら同じ新規図面を作る', () => {
    expect(drawingFromTemplate(fixture(), 'new', source)).toEqual(drawingFromTemplate(fixture(), 'new', source));
  });
});
