import { beforeEach, describe, expect, it } from 'vitest';
import { featureNoteOf, setFeatureNote, type FeatureNoteTarget } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { createFakeRecompute, partWithPoint, resetTestStore, resultFor, tick } from '../store/testing/createTestStore.js';

beforeEach(resetTestStore);
const target: FeatureNoteTarget = { kind: 'sketch-feature', sketchId: 'sketch-1', id: 'point-1' };
const note = () => featureNoteOf(useAppStore.getState().document, target);
function write(text: string) {
  const state = useAppStore.getState(); state.applyDocument(setFeatureNote(state.document, target, text));
}
describe('設計メモを通常の文書編集とUndoへつなぐ', () => {
  it('追加・修正・削除をそれぞれUndo1回で戻し、Redoも同じ文章にする', () => {
    useAppStore.getState().resetDocument(partWithPoint());
    write('最初の理由'); write('変更した理由'); write('');
    expect(note()).toBe('');
    useAppStore.getState().undo(); expect(note()).toBe('変更した理由');
    useAppStore.getState().undo(); expect(note()).toBe('最初の理由');
    useAppStore.getState().undo(); expect(note()).toBe('');
    useAppStore.getState().redo(); expect(note()).toBe('最初の理由');
    useAppStore.getState().redo(); expect(note()).toBe('変更した理由');
    useAppStore.getState().redo(); expect(note()).toBe('');
  });
  it('100回の編集・Undo・Redoで形状依頼を増やさず、タイムラインを保持する', async () => {
    useAppStore.getState().resetDocument(partWithPoint());
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    try {
      fake.calls[0].settle(resultFor(fake.calls[0].document)); await tick();
      const before = useAppStore.getState();
      for (let i = 0; i < 100; i += 1) write(`理由 ${i}`);
      useAppStore.getState().undo(); useAppStore.getState().redo(); await tick();
      const after = useAppStore.getState();
      expect(fake.calls).toHaveLength(1); expect(after.isComputing).toBe(false);
      expect(after.timelineIndex).toBe(before.timelineIndex);
      expect(after.document.sketches).toBe(before.document.sketches);
      expect(note()).toBe('理由 99');
    } finally { detach(); }
  });
  it('対象を消すとメモも消え、Undo1回で対象とメモを同時に復元する', () => {
    useAppStore.getState().resetDocument(partWithPoint()); write('消える対象の説明');
    const original = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...original, sketches: original.sketches.map(sketch => ({ ...sketch, features: [] })) });
    expect(note()).toBe('');
    useAppStore.getState().undo();
    expect(note()).toBe('消える対象の説明');
    expect(useAppStore.getState().document.sketches).toBe(original.sketches);
  });
});
