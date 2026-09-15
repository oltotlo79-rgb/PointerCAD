import { beforeEach, describe, expect, it } from 'vitest';
import { createFeatureFolder, moveFeatureFolderMember, removeFeatureFolder, setFeatureNote } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { createFakeRecompute, partWithPoint, resetTestStore, resultFor, tick } from '../store/testing/createTestStore.js';
import { featureFolderLabels } from './featureFolderLabels.js';
import { featureFolderAncestors } from './featureFolderAncestors.js';

beforeEach(resetTestStore);
const target = { kind: 'sketch-feature' as const, sketchId: 'sketch-1', id: 'point-1' };
describe('履歴フォルダの所属だけをUndoで戻し、再計算へ送らない', () => {
  it('検索先のスケッチと行を取り違えず、必要な親フォルダだけを開く', () => {
    const folders = [
      { id: 'outer', name: '本体', children: [{ kind: 'folder' as const, id: 'inner' }] },
      { id: 'inner', name: '形状', children: [{ kind: 'sketch' as const, id: 'first' }] },
      { id: 'other', name: '別の点', children: [{ kind: 'sketch-feature' as const, sketchId: 'second', id: 'point-1' }] },
    ];
    expect([...featureFolderAncestors(folders, { kind: 'sketch-feature', sketchId: 'first', id: 'point-1' })]).toEqual(['inner', 'outer']);
    expect([...featureFolderAncestors(folders, { kind: 'sketch-feature', sketchId: 'second', id: 'point-1' })]).toEqual(['other']);
    expect([...featureFolderAncestors(folders, { kind: 'solid', id: 'point-1' })]).toEqual([]);
  });
  it('計算開始後にメモとフォルダを編集しても、後着の計算結果で上書きされない', async () => {
    useAppStore.getState().resetDocument(partWithPoint());
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    try {
      const pending = fake.calls[0], original = useAppStore.getState().document;
      const noted = setFeatureNote(original, target, '計算を待ちながら書いた設計理由');
      const grouped = moveFeatureFolderMember(createFeatureFolder(noted, '計算中の整理'), target, 'folder-1');
      useAppStore.getState().applyDocument(grouped);
      expect(fake.calls).toHaveLength(1);
      pending.settle(resultFor(pending.document)); await tick();
      const state = useAppStore.getState();
      expect(state.document.featureNotes).toEqual(grouped.featureNotes);
      expect(state.document.featureFolders).toEqual(grouped.featureFolders);
      expect(state.isComputing).toBe(false); expect(fake.calls).toHaveLength(1);
    } finally { detach(); }
  });
  it('100回の移動と畳む表示に使う階層を作っても計算依頼は増えない', async () => {
    useAppStore.getState().resetDocument(createFeatureFolder(partWithPoint(), '点のまとまり'));
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    try {
      fake.calls[0].settle(resultFor(fake.calls[0].document)); await tick();
      const original = useAppStore.getState();
      for (let i = 0; i < 100; i += 1) {
        const state = useAppStore.getState(); state.applyDocument(moveFeatureFolderMember(state.document, target, i % 2 === 0 ? 'folder-1' : null));
      }
      useAppStore.getState().undo(); await tick();
      expect(useAppStore.getState().document.featureFolders?.[0].children).toEqual([target]);
      useAppStore.getState().redo(); await tick();
      expect(useAppStore.getState().document.featureFolders?.[0].children).toEqual([]);
      expect(fake.calls).toHaveLength(1); expect(useAppStore.getState().timelineIndex).toBe(original.timelineIndex);
      expect(useAppStore.getState().document.sketches).toBe(original.document.sketches);
    } finally { detach(); }
  });
  it('フォルダ解除と対象削除をそれぞれ一回のUndoで復元する', () => {
    const document = moveFeatureFolderMember(createFeatureFolder(partWithPoint(), '点'), target, 'folder-1');
    useAppStore.getState().resetDocument(document);
    useAppStore.getState().applyDocument(removeFeatureFolder(document, 'folder-1'));
    expect(useAppStore.getState().document.featureFolders).toEqual([]);
    useAppStore.getState().undo(); expect(useAppStore.getState().document.featureFolders).toEqual(document.featureFolders);
    useAppStore.getState().applyDocument({ ...document, sketches: document.sketches.map(sketch => ({ ...sketch, features: [] })) });
    expect(useAppStore.getState().document.featureFolders?.[0].children).toEqual([]);
    useAppStore.getState().undo(); expect(useAppStore.getState().document.featureFolders).toEqual(document.featureFolders);
    expect(useAppStore.getState().document.sketches).toBe(document.sketches);
  });
  it('同名の兄弟をツリーと移動先で同じ番号にし、別の親なら経路で区別する', () => {
    const labels = featureFolderLabels([
      { id: 'first', name: '加工', children: [{ kind: 'folder', id: 'inner' }] },
      { id: 'second', name: '加工', children: [] },
      { id: 'inner', name: '加工', children: [] },
    ]);
    expect(labels.get('first')).toEqual({ name: '加工 (1)', path: '加工 (1)' });
    expect(labels.get('second')).toEqual({ name: '加工 (2)', path: '加工 (2)' });
    expect(labels.get('inner')).toEqual({ name: '加工', path: '加工 (1) / 加工' });
  });
  it('名前に付けた番号や経路の区切りが、別フォルダの表示と重ならない', () => {
    const labels = featureFolderLabels([
      { id: 'a', name: '加工', children: [{ kind: 'folder', id: 'd' }] },
      { id: 'b', name: '加工', children: [] }, { id: 'c', name: '加工 (1)', children: [] },
      { id: 'd', name: '内側', children: [] }, { id: 'e', name: '加工 (2) / 内側', children: [] },
    ]);
    expect(labels.get('a')?.name).toBe('加工 (2)'); expect(labels.get('b')?.name).toBe('加工 (3)');
    expect(new Set([...labels.values()].map(label => label.path)).size).toBe(labels.size);
  });
});
