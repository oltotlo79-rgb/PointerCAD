import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import { affectsShape } from '../part/documentChange.js';
import type { PartDocument } from '../part/types.js';
import { checkFeatureFolders, createFeatureFolder, FEATURE_FOLDER_MAX_DEPTH, moveFeatureFolderMember,
  pruneRemovedFolderMembers, removeFeatureFolder, renameFeatureFolder, type FeatureFolder } from './featureFolders.js';

function fixture(): PartDocument {
  const empty = createEmptyPartDocument();
  return { ...empty, solids: [{ ...createPrimitiveFeature(empty, 'box'), id: 'box-1' }] };
}
const box = { kind: 'solid' as const, id: 'box-1' };
const folder = (id: string) => ({ kind: 'folder' as const, id });

describe('履歴のフォルダは図形の計算順序から独立して所属を保持する', () => {
  it('作成・所属変更・入れ子・名前変更でも図形と履歴の順序を変えない', () => {
    const original = fixture(), first = createFeatureFolder(original, '本体');
    const second = createFeatureFolder(first, '加工', 'folder-1');
    const grouped = moveFeatureFolderMember(second, box, 'folder-2');
    const renamed = renameFeatureFolder(grouped, 'folder-2', '穴の加工');
    expect(renamed.featureFolders).toEqual([
      { id: 'folder-1', name: '本体', children: [folder('folder-2')] },
      { id: 'folder-2', name: '穴の加工', children: [box] },
    ]);
    expect(original.featureFolders).toBeUndefined();
    expect(renamed.solids).toBe(original.solids); expect(renamed.sketches).toBe(original.sketches);
    expect(renamed.references).toBe(original.references); expect(affectsShape(original, renamed)).toBe(false);
    expect(moveFeatureFolderMember(renamed, box, 'folder-2')).toBe(renamed);
    expect(renameFeatureFolder(renamed, 'folder-2', '穴の加工')).toBe(renamed);
  });
  it('子孫への移動と自分への移動を拒否し、元の所属を保持する', () => {
    const original = createFeatureFolder(createFeatureFolder(fixture(), '親'), '子', 'folder-1');
    expect(() => moveFeatureFolderMember(original, folder('folder-1'), 'folder-2')).toThrow('cycle');
    expect(() => moveFeatureFolderMember(original, folder('folder-1'), 'folder-1')).toThrow('cycle');
    expect(original.featureFolders?.[0].children).toEqual([folder('folder-2')]);
    expect(checkFeatureFolders(original.featureFolders ?? [])).toEqual({ ok: true });
  });
  it('同じ名前はIDで区別し、異なる所属へ移動しても重複表示用の記録を作らない', () => {
    const original = createFeatureFolder(createFeatureFolder(fixture(), '加工'), '加工');
    const first = moveFeatureFolderMember(original, box, 'folder-1');
    const second = moveFeatureFolderMember(first, box, 'folder-2');
    expect(second.featureFolders?.[0].children).toEqual([]);
    expect(second.featureFolders?.[1].children).toEqual([box]);
    expect(moveFeatureFolderMember(second, box, null).featureFolders?.every(item => item.children.length === 0)).toBe(true);
  });
  it('フォルダ解除は中身を親へ戻し、図形も子のフォルダも消さない', () => {
    let original = createFeatureFolder(createFeatureFolder(fixture(), '外側'), '中間', 'folder-1');
    original = createFeatureFolder(original, '内側', 'folder-2');
    original = moveFeatureFolderMember(original, box, 'folder-2');
    const removed = removeFeatureFolder(original, 'folder-2');
    expect(removed.featureFolders).toEqual([
      { id: 'folder-1', name: '外側', children: [folder('folder-3'), box] },
      { id: 'folder-3', name: '内側', children: [] },
    ]);
    expect(removed.solids).toBe(original.solids);
    const rootRemoved = removeFeatureFolder(removed, 'folder-1');
    expect(rootRemoved.featureFolders).toEqual([{ id: 'folder-3', name: '内側', children: [] }]);
    expect(rootRemoved.solids).toBe(original.solids);
  });
  it('消した図形の所属だけを同じ編集で外し、読込み時に既に孤立していた情報は保つ', () => {
    const original = moveFeatureFolderMember(createFeatureFolder(fixture(), '加工'), box, 'folder-1');
    const deleted = pruneRemovedFolderMembers(original, { ...original, solids: [] });
    expect(deleted.featureFolders?.[0].children).toEqual([]);
    expect(original.featureFolders?.[0].children).toEqual([box]);
    const orphan: PartDocument = { ...original, solids: [] };
    expect(pruneRemovedFolderMembers(orphan, { ...orphan, solids: [] }).featureFolders).toBe(orphan.featureFolders);
  });
  it('新規の移動先・対象・空の名前を確認してから変更する', () => {
    const original = createFeatureFolder(fixture(), '加工');
    expect(() => moveFeatureFolderMember(original, box, 'missing')).toThrow('missing-folder');
    expect(() => moveFeatureFolderMember(original, { ...box, id: 'missing' }, 'folder-1')).toThrow('missing-feature');
    expect(() => createFeatureFolder(original, ' ')).toThrow('invalid-folder');
    expect(() => renameFeatureFolder(original, 'folder-1', 'あ'.repeat(129))).toThrow('invalid-folder');
    expect(original.featureFolders).toEqual([{ id: 'folder-1', name: '加工', children: [] }]);
  });
  it('重複所属・失われた親子・根のない循環を保存時にも検出する', () => {
    expect(checkFeatureFolders([{ id: 'a', name: 'A', children: [box, box] }])).toEqual({ ok: false, problem: 'duplicate-member' });
    expect(checkFeatureFolders([{ id: 'a', name: 'A', children: [folder('missing')] }])).toEqual({ ok: false, problem: 'missing-folder' });
    expect(checkFeatureFolders([{ id: 'a', name: 'A', children: [folder('b')] }, { id: 'b', name: 'B', children: [folder('a')] }])).toEqual({ ok: false, problem: 'cycle' });
  });
  it('深さの上限は保存配列の順に影響されず、過大な入れ子を再帰前に拒否する', () => {
    const chain = (count: number): FeatureFolder[] => Array.from({ length: count }, (_, index) => ({
      id: String(index), name: String(index), children: index + 1 < count ? [folder(String(index + 1))] : [],
    }));
    expect(checkFeatureFolders(chain(FEATURE_FOLDER_MAX_DEPTH))).toEqual({ ok: true });
    expect(checkFeatureFolders(chain(FEATURE_FOLDER_MAX_DEPTH).reverse())).toEqual({ ok: true });
    expect(checkFeatureFolders(chain(FEATURE_FOLDER_MAX_DEPTH + 1))).toEqual({ ok: false, problem: 'too-deep' });
    expect(checkFeatureFolders(chain(FEATURE_FOLDER_MAX_DEPTH + 1).reverse())).toEqual({ ok: false, problem: 'too-deep' });
  });
});
