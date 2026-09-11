import { beforeEach, describe, expect, it } from 'vitest';
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument } from '@pointercad/model';
import type { ExportHandoff } from '../file/openWith.js';
import { useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
const handoff: ExportHandoff = { format: 'step', token: 'saved' };
beforeEach(resetTestStore);
describe('保存成功後の加工案内を文書・実行順から取り違えない', () => {
  it('保存中には出さず、成功しても文書・再計算・Undoを変えない', () => {
    const before = useAppStore.getState(), attempt = before.beginExportHandoff();
    expect(useAppStore.getState().exportHandoff).toBeNull();
    before.finishExportHandoff(attempt, handoff);
    const after = useAppStore.getState();
    expect(after.exportHandoff).toBe(handoff); expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    before.clearExportHandoff(); expect(useAppStore.getState().exportHandoff).toBeNull();
  });
  it('古い完了が新しい書出しや取消・閉じる操作を上書きしない', () => {
    const state = useAppStore.getState(), old = state.beginExportHandoff(), current = state.beginExportHandoff();
    state.finishExportHandoff(old, handoff); expect(useAppStore.getState().exportHandoff).toBeNull();
    state.finishExportHandoff(current, handoff); state.clearExportHandoff();
    state.finishExportHandoff(current, handoff); expect(useAppStore.getState().exportHandoff).toBeNull();
  });
  it.each(['new', 'load', 'assembly', 'drawing'])('%sでは待機中の古い書出しから案内を復活させない', (kind) => {
    const state = useAppStore.getState(), attempt = state.beginExportHandoff();
    state.finishExportHandoff(attempt, handoff);
    if (kind === 'new') state.resetDocument(createEmptyPartDocument());
    else if (kind === 'load') state.applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    else if (kind === 'assembly') state.openAssembly(createAssemblyDocument('次の組立'));
    else state.openDrawing(createDrawingDocument('次の図面', { sourceRef: 'part1', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-11T00:00:00.000Z' }));
    expect(useAppStore.getState().exportHandoff).toBeNull();
    state.finishExportHandoff(attempt, handoff); expect(useAppStore.getState().exportHandoff).toBeNull();
  });
});
