import { beforeEach, describe, expect, it } from 'vitest';
import { appendSolid } from '@pointercad/model';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { commitNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { bodyFor, extrudeFeature, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { advanceTutorial, openTutorial, pauseTutorial } from './tutorialActions.js';

function settled(): void {
  const state = useAppStore.getState();
  state.applyRecompute(state.document, resultFor(state.document));
  useAppStore.setState({ isComputing: false, requestedGeneration: 1, completedGeneration: 1, lastOutcome: 'success' });
}
function enter(): void {
  const state = useAppStore.getState(), input = state.numericInput;
  if (input === null) throw new Error('input missing');
  applyNumericTransition(commitNumericInput(input));
  settled();
}
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ tutorialSession: null, tutorialOpen: false, viewportSize: [760, 623] });
  settled();
});

describe('初回案内は通常の作図を通り、途中入力・失敗・別文書を保護する', () => {
  it('案内を中断して開き直しても入力と連続作図の設定を保つ', () => {
    openTutorial(); expect(advanceTutorial()).toBe(true);
    const state = useAppStore.getState(), input = state.numericInput;
    if (input === null) throw new Error('input missing');
    state.updateNumericInput(reduceNumericInput(input, { type: 'edit', index: 0, source: '12/2' }));
    const before = useAppStore.getState();
    pauseTutorial(); openTutorial();
    expect(useAppStore.getState().numericInput).toBe(before.numericInput);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().chaining).toBe(before.chaining);
  });
  it('通常のEnterで点と輪郭を作り、面の確定はUndo一回で戻る', () => {
    openTutorial(); advanceTutorial(); enter();
    expect(useAppStore.getState().numericInput).toBeNull();
    advanceTutorial(); enter(); enter();
    const beforeFace = useAppStore.getState().document;
    expect(advanceTutorial()).toBe(true); settled();
    expect(useAppStore.getState().sketch.features.map(item => item.kind)).toEqual(['point', 'rectangle', 'face']);
    useAppStore.getState().undo(); settled();
    expect(useAppStore.getState().document).toEqual(beforeFace);
  });
  it.each(['failed', 'cancelled', 'workerBroken'] as const)('%sの計算を成功と数えない', lastOutcome => {
    openTutorial(); const before = useAppStore.getState();
    useAppStore.setState({ lastOutcome });
    expect(advanceTutorial()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().numericInput).toBeNull();
  });
  it('同じIDで新規を開いても古い案内を自動実行しない', () => {
    openTutorial(); const before = useAppStore.getState();
    useAppStore.setState({ documentVersion: before.documentVersion + 1 });
    expect(advanceTutorial()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
  });
  it('穴の面は実際の高さから選び、先頭の面番号を決め打ちしない', () => {
    openTutorial(); advanceTutorial(); enter(); advanceTutorial(); enter(); enter(); advanceTutorial(); settled();
    const state = useAppStore.getState(), session = state.tutorialSession;
    if (session === null) throw new Error('session missing');
    state.applyDocument(appendSolid(state.document, extrudeFeature(session.extrudeId))); settled();
    const face = { surfaceKind: 'plane' as const, area: 2400, axis: [0, 0, 1] as const,
      radius: null, triangleOffset: 0, triangleCount: 2 };
    useAppStore.setState({ bodies: [{ ...bodyFor(session.extrudeId), faces: [
      { ...face, index: 1, centroid: [0, 0, 0] }, { ...face, index: 7, centroid: [0, 0, 8] },
    ] }] });
    expect(advanceTutorial()).toBe(true);
    expect(useAppStore.getState().selection).toEqual([session.extrudeId + '#face:7', session.pointId]);
    expect(useAppStore.getState().numericInput?.toolId).toBe('hole');
  });
});
