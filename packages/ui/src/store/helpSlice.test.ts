import { beforeEach, describe, expect, it } from 'vitest';
import { contextualHelpTopic } from '../help/helpContext.js';
import { createInitialDocumentState } from './initialDocumentState.js';
import { useAppStore } from './useAppStore.js';

beforeEach(() => useAppStore.setState(createInitialDocumentState()));
describe('ヘルプと文書の分離', () => {
  it('板金の全5操作から説明を開き、入力欄でも同じ章へ戻れる', () => {
    for (const [kind, topic] of [['sheetBase', 'sheet-metal'], ['sheetFlange', 'sheet-metal-flange'],
      ['sheetBend', 'sheet-metal-bend-relief'], ['sheetRelief', 'sheet-metal-bend-relief'], ['sheetUnfold', 'sheet-metal-flat']] as const) {
      useAppStore.getState().openSheetMetalTool(kind);
      const state = useAppStore.getState();
      expect(contextualHelpTopic(state)).toBe(topic); expect(contextualHelpTopic(state, undefined, true)).toBe(topic);
      expect(state.openHelpTopic(topic)).toBe(true); state.closeHelp(); state.closeSheetMetalTool();
    }
  });
  it('ヘルプを開く・切り替える・閉じる操作で文書とUndoを変更しない', () => {
    const before = useAppStore.getState();
    expect(before.openHelpTopic('drawing-section')).toBe(true);
    expect(useAppStore.getState().helpTopicId).toBe('drawing-section');
    expect(before.openHelpTopic('missing')).toBe(false);
    expect(useAppStore.getState().helpTopicId).toBe('drawing-section');
    before.closeHelp(); const after = useAppStore.getState();
    expect(after.helpTopicId).toBeNull(); expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack); expect(after.documentVersion).toBe(before.documentVersion);
  });
  it('文書の初期化で閉じ、F1の明示された対象は入力欄より優先する', () => {
    const state = useAppStore.getState(); state.openHelpTopic('drawing');
    useAppStore.setState(createInitialDocumentState()); const reset = useAppStore.getState();
    expect(reset.helpTopicId).toBeNull(); expect(contextualHelpTopic(reset, 'drawing-section', true)).toBe('drawing-section');
    expect(contextualHelpTopic(reset, 'missing', true)).toBe('numeric-input');
    expect(contextualHelpTopic(reset)).toBe('viewport');
  });
});
