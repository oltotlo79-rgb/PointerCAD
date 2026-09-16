import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachPartRecompute } from './attachKernel.js';
import { createFakeRecompute, documentWithPoint, resetTestStore, resultFor, tick } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';
import type { UtilityPanel } from './viewSlice.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

const panels: readonly UtilityPanel[] = ['export', 'import', 'comparison', 'functionPlot', 'drawingPrint', 'drawingExport'];

describe('補助画面の終了通知で文書の再計算を止めない', () => {
  it.each(panels)('%sは同じ開閉要求を繰り返しても変更を通知せず、形と履歴を保つ', panel => {
    const initial = useAppStore.getState();
    let notifications = 0;
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1; });
    try {
      initial.setUtilityPanelOpen(panel, false);
      expect(useAppStore.getState()).toBe(initial);
      initial.setUtilityPanelOpen(panel, true);
      const opened = useAppStore.getState();
      opened.setUtilityPanelOpen(panel, true);
      expect(useAppStore.getState()).toBe(opened);
      opened.setUtilityPanelOpen(panel, false);
      const closed = useAppStore.getState();
      closed.setUtilityPanelOpen(panel, false);
      expect(useAppStore.getState()).toBe(closed);
      expect(notifications).toBe(2);
      expect(closed.document).toBe(initial.document);
      expect(closed.canUndo).toBe(initial.canUndo);
    } finally { unsubscribe(); }
  });

  it('別画面へ切り替えた後の古い終了要求では通知を増やさない', () => {
    useAppStore.getState().setUtilityPanelOpen('functionPlot', true);
    useAppStore.getState().setUtilityPanelOpen('export', true);
    const current = useAppStore.getState();
    current.setUtilityPanelOpen('functionPlot', false);
    expect(useAppStore.getState()).toBe(current);
  });

  it.each(['before', 'after'] as const)('文書を監視する画面を再計算の%sに登録しても、確定と結果の反映を一回ずつ終える', async order => {
    const owner = useAppStore.getState().document;
    useAppStore.getState().setUtilityPanelOpen('functionPlot', true);
    let closingNotifications = 0;
    // A document-bound editor requests closure until React removes its observer.
    // Bound the regression itself so a notification loop fails immediately.
    const observe = () => useAppStore.subscribe(state => {
      if (state.document === owner) return;
      if (++closingNotifications > 10) throw new Error('Repeated editor-close notifications');
      state.setUtilityPanelOpen('functionPlot', false);
    });
    let unsubscribe = order === 'before' ? observe() : () => undefined;
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    if (order === 'after') unsubscribe = observe();
    try {
      fake.calls[0].settle(resultFor(fake.calls[0].document)); await tick();
      expect(() => useAppStore.getState().setSketch(documentWithPoint())).not.toThrow();
      expect(fake.calls).toHaveLength(2);
      const requested = useAppStore.getState().requestedGeneration;
      fake.calls[1].settle(resultFor(fake.calls[1].document)); await tick();
      const state = useAppStore.getState();
      expect(fake.calls).toHaveLength(2);
      expect(state.completedGeneration).toBe(requested);
      expect(state.lastOutcome).toBe('success');
      expect(state.isComputing).toBe(false);
      expect(state.utilityPanel).toBeNull();
      expect(state.featureNames).toEqual(['点1']);
      expect(state.canUndo).toBe(true);
    } finally { unsubscribe(); detach(); }
  });
});
