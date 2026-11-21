import { PART_EXAMPLES, type PartExampleId } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartFileDeps } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { openPartExample, openPartExamples } from './openPartExample.js';
import { PART_EXAMPLE_ENTRIES } from './partExampleEntries.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

const PART_ID = /^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Answers the discard question with a fixed reply and remembers every question asked. */
function fakeDeps(answer: boolean): { readonly deps: PartFileDeps; readonly confirmed: readonly string[] } {
  const confirmed: string[] = [];
  return { confirmed, deps: {
    captureThumbnail: () => null,
    confirmDiscard: (key) => { confirmed.push(key); return Promise.resolve(answer); },
    recentFilesStorage: null,
  } };
}

function exampleOf(id: PartExampleId) {
  const example = PART_EXAMPLES.find(entry => entry.id === id);
  if (example === undefined) throw new Error(`作例 ${id} がありません`);
  return example;
}

describe('作例を開く(J-06b)', () => {
  it('一覧を開くのは補助画面の欄だけで、文書と履歴を変えない', () => {
    const before = useAppStore.getState();
    openPartExamples();
    const state = useAppStore.getState();
    expect(state.utilityPanel).toBe('examples');
    expect(state.document).toBe(before.document);
    expect(state.documentVersion).toBe(before.documentVersion);
    expect(state.canUndo).toBe(false);
  });

  it.each(PART_EXAMPLES.map(example => example.id))(
    '%s は新規と同じく、新しい id・保存先なし・履歴なしの部品として開き、名前は作例の名前', async id => {
      const before = useAppStore.getState();
      const fake = fakeDeps(false);
      await openPartExample(id, fake.deps);
      const state = useAppStore.getState();
      // 何も描いていない部品からは、失うものが無いので確認しない(新規と同じ)。
      expect(fake.confirmed).toEqual([]);
      expect(state.document).toEqual({ ...exampleOf(id).create(), id: state.document.id, name: t(PART_EXAMPLE_ENTRIES[id].nameKey) });
      expect(state.document.id).toMatch(PART_ID);
      expect(state.document.id).not.toBe(before.document.id);
      expect(state.fileName).toBeNull();
      expect(state.savedDocument).toBeNull();
      expect(state.undoStack.past).toEqual([]);
      expect(state.canUndo).toBe(false);
      expect(state.documentVersion).toBe(before.documentVersion + 1);
    });

  it('保存していない変更があれば新規と同じく確認し、断られたら今の部品を変えない', async () => {
    useAppStore.getState().applyDocument(exampleOf('plateWithHole').create());
    const before = useAppStore.getState();
    const fake = fakeDeps(false);
    await openPartExample('flange', fake.deps);
    expect(fake.confirmed).toEqual(['file.discardConfirm']);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().documentVersion).toBe(before.documentVersion);
  });

  it('了承すると作例へ差し替わり、前の部品の履歴は持ち越さない', async () => {
    useAppStore.getState().applyDocument(exampleOf('plateWithHole').create());
    const fake = fakeDeps(true);
    await openPartExample('spring', fake.deps);
    const state = useAppStore.getState();
    expect(fake.confirmed).toEqual(['file.discardConfirm']);
    expect(state.document.solids.map(feature => feature.kind)).toEqual(['spring']);
    expect(state.document.name).toBe(t('examples.spring.name'));
    expect(state.canUndo).toBe(false);
  });
});
