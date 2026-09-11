import { createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { readSheetUnfolds, serializeSheetUnfold } from './codecs/sheetUnfold.js';
import { parseDocument, serializeDocument } from './documentJson.js';

const definition = { sourceFeatureId: 'flange-1', fixedPanelId: 'panel-2', seamConnectionIds: ['seam-a'] };
describe('板金の展開定義の保存と移行', () => {
  it('固定面・継ぎ目を往復し、表示や導出形状は保存しない', () => {
    const document = { ...createEmptyPartDocument(), sheetUnfolds: [{ ...definition, displayMode: 'flat', mesh: [1, 2, 3] }] };
    const encoded = serializeDocument(document);
    expect(encoded).not.toContain('displayMode'); expect(encoded).not.toContain('mesh');
    const decoded = parseDocument(encoded); if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
    expect(decoded.document.sheetUnfolds).toEqual([definition]);
    expect(serializeSheetUnfold({ ...definition, seamConnectionIds: ['z', 'a'] }).seamConnectionIds).toEqual(['a', 'z']);
  });
  it('版11は空定義へ移行するが、版12の欠落や旧版の壊れた既存欄は黙って補わない', () => {
    const document = createEmptyPartDocument();
    const old = { schema: 11, kind: 'part', app: 'PointerCAD', savedAt: '2026-09-11T00:00:00Z',
      document: { ...document, schemaVersion: 11, sheetUnfolds: undefined } };
    const migrated = parseDocument(JSON.stringify(old)); if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
    expect(migrated.document.sheetUnfolds).toEqual([]); expect(migrated.document.schemaVersion).toBe(13);
    expect(parseDocument(JSON.stringify({ ...old, schema: 12, document: { ...old.document, schemaVersion: 12 } })).ok).toBe(false);
    expect(parseDocument(JSON.stringify({ ...old, document: { ...old.document, sheetUnfolds: null } })).ok).toBe(false);
  });
  it.each([null, {}, [{ ...definition, sourceFeatureId: '' }], [{ ...definition, fixedPanelId: '' }],
    [{ ...definition, seamConnectionIds: ['same', 'same'] }], [{ ...definition, seamConnectionIds: [null] }], [definition, definition]])('不正な定義を場所付きで断る: %j', (sheetUnfolds) => {
    const result = readSheetUnfolds({ sheetUnfolds }, 'document'); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.path).toContain('document.sheetUnfolds');
  });
});
