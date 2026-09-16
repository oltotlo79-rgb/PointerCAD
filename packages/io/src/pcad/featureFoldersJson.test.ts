import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createFeatureFolder, moveFeatureFolderMember, setFeatureNote,
  templateFromDocument, DEFAULT_TOOL_DEFAULTS } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { isRecord } from './guards.js';

function sample() {
  const empty = createEmptyPartDocument(), target = { kind: 'sketch' as const, id: empty.activeSketchId };
  const noted = setFeatureNote(empty, target, 'この作図面の設計理由');
  const first = createFeatureFolder(noted, '本体'), second = createFeatureFolder(first, '下書き', 'folder-1');
  return moveFeatureFolderMember(second, target, 'folder-2');
}
function envelope() {
  const raw: unknown = JSON.parse(serializeDocument(sample()));
  if (!isRecord(raw) || !isRecord(raw.document)) throw new Error('Invalid fixture');
  return { root: raw, document: raw.document };
}
describe('履歴のメモ・フォルダを現在の書式で保持する', () => {
  it('入れ子とメモを一つの部品ファイルへ保存し、実際の圧縮・読込みを往復する', () => {
    const original = sample(), result = readPcadFile(writePcadFile(original));
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
    expect(result.document).toEqual(original);
    expect(result.document.featureFolders).not.toBe(original.featureFolders);
  });
  it('版14の文書にフォルダが無ければ新しい空の所属を捏造しない', () => {
    const { root, document } = envelope(); root.schema = 14; document.schemaVersion = 14; delete document.featureFolders; delete document.featureNotes;
    const result = parseDocument(JSON.stringify(root));
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
    expect(result.document.featureFolders).toBeUndefined(); expect(result.document.featureNotes).toBeUndefined();
    expect(result.document.sketches).toEqual(sample().sketches);
  });
  it.each([null, {}, [{ id: 'a', name: '', children: [] }], [{ id: 'a', name: 'A', children: null }],
    [{ id: 'a', name: 'A', children: [{ kind: 'folder', id: 'a' }] }],
    [{ id: 'a', name: 'A', children: [{ kind: 'folder', id: 'missing' }] }],
    [{ id: 'a', name: 'A', children: [{ kind: 'unknown', id: 'x' }] }],
    [{ id: 'a', name: 'A', children: [{ kind: 'sketch-feature', id: 'x' }] }],
    [{ id: 'a', name: 'A', children: [] }, { id: 'a', name: 'B', children: [] }],
  ].map(value => ({ value })))('壊れた所属を空にして成功扱いせず、読込みを拒否する: %#', ({ value }) => {
    const { root, document } = envelope(); document.featureFolders = value;
    expect(parseDocument(JSON.stringify(root))).toMatchObject({ ok: false });
  });
  it('所属先を失ったファイルは、新規の同ID図形へ付け替える前に読込みを拒否する', () => {
    const { root, document } = envelope(); document.featureFolders = [{ id: 'a', name: '復旧用', children: [{ kind: 'solid', id: 'missing' }] }];
    const result = parseDocument(JSON.stringify(root));
    expect(result).toMatchObject({ ok: false });
    const original = sample();
    expect(() => serializeDocument({ ...original, featureFolders: [{ id: 'a', name: '復旧用', children: [{ kind: 'solid', id: 'missing' }] }] })).toThrow();
    expect(original.featureFolders).toHaveLength(2);
  });
  it('メモの対象が失われた場合も、新しい同IDの図形へ付け替えない', () => {
    const { root, document } = envelope();
    document.featureNotes = [{ target: { kind: 'sketch', id: 'missing' }, text: '別の図形に付けない' }];
    expect(parseDocument(JSON.stringify(root))).toMatchObject({ ok: false });
    const original = sample();
    expect(() => serializeDocument({ ...original, featureNotes: [{ target: { kind: 'sketch', id: 'missing' }, text: '別の図形に付けない' }] })).toThrow();
  });
  it('ひな形は履歴に付いたメモと所属も外し、新規文書へ元の情報を誤って残さない', () => {
    const original = sample(), template = templateFromDocument(original, { lengthUnit: 'mm', toolDefaults: DEFAULT_TOOL_DEFAULTS });
    expect(template.document.featureFolders).toEqual([]); expect(template.document.featureNotes).toEqual([]);
    const result = readPcadFile(writePcadFile(template.document, { kind: 'partTemplate' }));
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
    expect(result.document.featureFolders).toEqual([]); expect(result.document.featureNotes).toEqual([]);
    expect(original.featureFolders).toHaveLength(2);
  });
});
