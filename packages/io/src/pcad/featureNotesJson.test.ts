import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createEmptyPartDocument, DEFAULT_COMPONENT_PLACEMENT, setFeatureNote, FEATURE_NOTE_MAX_LENGTH, type AssemblyDocument } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { readPcadFile, writePcadFile, readPcadaFile, writePcadaFile } from './pcadFile.js';

function sample() {
  const document = createEmptyPartDocument();
  return setFeatureNote(document, { kind: 'sketch', id: document.activeSketchId }, '加工前の注意\n<script>文字として残す</script>  ');
}
function envelope() {
  const value: unknown = JSON.parse(serializeDocument(sample()));
  if (!isRecord(value) || !isRecord(value.document)) throw new Error('Unexpected document');
  return { root: value, body: value.document };
}
describe('設計メモの保存と版14からの互換性', () => {
  it('改行・日本語・HTML記号・末尾空白をそのまま保存して読む', () => {
    const original = sample(), parsed = parseDocument(serializeDocument(original));
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.document).toEqual(original);
    expect(parsed.document.featureNotes).not.toBe(original.featureNotes);
  });
  it('実際の圧縮された部品ファイルにも文章を保持する', () => {
    const original = sample(), parsed = readPcadFile(writePcadFile(original));
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.document).toEqual(original);
  });
  it('組立に抱き込んだ部品も、元のメモと対象を保持して保存・読込みする', async () => {
    const original = sample(), savedAt = '2026-09-15T00:00:00.000Z';
    const assembly: AssemblyDocument = { ...createAssemblyDocument('メモ付き組立'), components: [{
      id: 'component-1', name: 'メモ付き部品', source: { kind: 'part', partRef: 'part-1' },
      placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: true, visible: true, suppressed: false,
    }] };
    const bytes = await writePcadaFile(assembly, { savedAt, parts: new Map([['part-1', original]]), partFiles: [{
      ref: 'part-1', fileName: 'メモ付き部品.pcad', path: 'メモ付き部品.pcad', contentHash: 'fixture', importedAt: savedAt,
    }] });
    const parsed = await readPcadaFile(bytes);
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.parts.get('part-1')).toEqual(original);
  });
  it('版14のメモが無いファイルを、形を変えず現行版へ持ち上げる', () => {
    const { root, body } = envelope();
    root.schema = 14; body.schemaVersion = 14; delete body.featureNotes;
    const parsed = parseDocument(JSON.stringify(root));
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(parsed.document.featureNotes).toBeUndefined();
    expect(parsed.document.sketches).toEqual(sample().sketches);
  });
  it.each([null, {}, [{ target: { kind: 'solid', id: '' }, text: '残す' }],
    [{ target: { kind: 'unknown', id: 'x' }, text: '残す' }],
    [{ target: { kind: 'sketch-feature', id: 'point-1' }, text: '所属が無い' }],
    [{ target: { kind: 'solid', id: 'box-1' }, text: 2 }],
    [{ target: { kind: 'solid', id: 'box-1' }, text: 'x'.repeat(FEATURE_NOTE_MAX_LENGTH + 1) }],
    [{ target: { kind: 'solid', id: 'box-1' }, text: '一つ目' }, { target: { kind: 'solid', id: 'box-1' }, text: '二つ目' }],
  ].map(invalid => ({ invalid })))('壊れたメモを成功扱いで削除せず、読込みを拒否する: %#', ({ invalid }) => {
    const { root, body } = envelope(); body.featureNotes = invalid;
    expect(parseDocument(JSON.stringify(root))).toMatchObject({ ok: false });
  });
  it('古い版に不正なメモが既にあっても空配列へ置き換えて隠さない', () => {
    const { root, body } = envelope(); root.schema = 14; body.schemaVersion = 14; body.featureNotes = null;
    expect(parseDocument(JSON.stringify(root))).toMatchObject({ ok: false });
  });
});
