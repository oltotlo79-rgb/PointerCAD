import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRunResult, ScriptRequest } from '@pointercad/model/scripting';
import { createPrimitiveFeature, appendSolid, createEmptyPartDocument } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { createFakeRecompute, resetTestStore, resultFor, tick } from '../store/testing/createTestStore.js';
import { openScriptPanel, runScript } from './scriptActions.js';

beforeEach(() => {
  resetTestStore(); useAppStore.getState().cancelScript();
  useAppStore.setState({ scriptPanelOpen: true, scriptLibraryState: 'ready', scriptLibrary: [], scriptMessage: null, scriptError: null,
    scriptPhase: 'idle', scriptRequestId: null, scriptController: null, scriptExecutor: null,
    scriptDraft: { scriptId: 'test', name: 'テスト', icon: 'code', source: 'work()', modules: [], seed: '1', time: '2026-09-11T00:00:00Z' } });
});
function fakeExecutor() {
  let settle: ((result: ScriptRunResult) => void) | undefined;
  const calls: { request: ScriptRequest; signal: AbortSignal }[] = [];
  useAppStore.setState({ scriptExecutor: (request, signal) => new Promise<ScriptRunResult>(resolve => { calls.push({ request, signal }); settle = resolve; }) });
  const finish = (result: ScriptRunResult): void => { if (settle === undefined) throw new Error('not called'); settle(result); };
  return { calls, finish };
}
function success(request: ScriptRequest) {
  const document = appendSolid(request.document, createPrimitiveFeature(request.document, 'box'));
  const release = vi.fn(() => Promise.resolve());
  return { result: { ok: true, prepared: { base: request.document, document, result: resultFor(document), release }, console: [], commandCount: 1,
    initializationMs: 1, javascriptMs: 1, cadMs: 1 } satisfies ScriptRunResult, release, document };
}
describe('自動作図の原子的適用と寿命', () => {
  it('強度計算から自動作図へ切り替えると新しいパネルが現れ、文書と下書きを保つ', () => {
    const { document, scriptDraft, undoStack } = useAppStore.getState();
    useAppStore.getState().toggleStrength();
    expect(useAppStore.getState().strengthSession).not.toBeNull();
    openScriptPanel();
    const state = useAppStore.getState();
    expect(state.strengthSession).toBeNull();
    expect(state.scriptPanelOpen).toBe(true);
    expect(state.document).toBe(document);
    expect(state.scriptDraft).toBe(scriptDraft);
    expect(state.undoStack).toBe(undoStack);
  });
  it('別の作図道具へ切り替えると実行を中止し、下書きを残してプロパティを戻す', async () => {
    const fake = fakeExecutor(), pending = runScript();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const draft = useAppStore.getState().scriptDraft;
    useAppStore.getState().openSheetMetalTool('sheetBase');
    expect(fake.calls[0].signal.aborted).toBe(true);
    expect(useAppStore.getState().scriptPanelOpen).toBe(false);
    expect(useAppStore.getState().scriptDraft).toBe(draft);
    expect(useAppStore.getState().sheetMetalTool?.kind).toBe('sheetBase');
    const prepared = success(fake.calls[0].request); fake.finish(prepared.result); await pending;
    expect(useAppStore.getState().undoStack.past).toHaveLength(0);
    expect(prepared.release).toHaveBeenCalledTimes(1);
  });
  it('成功1回でUndo1段、通常再計算の完了まで一時所有先を保つ', async () => {
    const fake = fakeExecutor(), normal = createFakeRecompute(), detach = attachPartRecompute(normal.recompute);
    try {
      const original = useAppStore.getState().document;
      const pending = runScript(); await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      const prepared = success(fake.calls[0].request); fake.finish(prepared.result); await pending;
      expect(useAppStore.getState().document).toBe(prepared.document); expect(useAppStore.getState().undoStack.past).toHaveLength(1);
      expect(prepared.release).not.toHaveBeenCalled();
      const current = normal.calls.at(-1); if (current === undefined) throw new Error('no recompute');
      current.settle(resultFor(current.document)); await tick();
      expect(prepared.release).toHaveBeenCalledTimes(1);
      useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(original);
    } finally { detach(); }
  });
  it.each(['document', 'code', 'timeline', 'units'])('%sが変わった後の旧成功を捨て、Undoを増やさず所有先を返す', async change => {
    const fake = fakeExecutor(), pending = runScript(); await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const prepared = success(fake.calls[0].request);
    const state = useAppStore.getState();
    if (change === 'document') state.resetDocument(createEmptyPartDocument());
    if (change === 'code' && state.scriptDraft !== null) state.setScriptDraft({ ...state.scriptDraft, source: 'changed()' });
    if (change === 'timeline') useAppStore.setState({ timelineIndex: 0 });
    if (change === 'units') useAppStore.setState({ displaySettings: { ...state.displaySettings, lengthUnit: 'inch' } });
    const current = useAppStore.getState().document, undo = useAppStore.getState().undoStack;
    expect(fake.calls[0].signal.aborted).toBe(true);
    fake.finish(prepared.result); await pending; await tick();
    expect(useAppStore.getState().document).toBe(current); expect(useAppStore.getState().undoStack).toBe(undo);
    expect(prepared.release).toHaveBeenCalledTimes(1); expect(useAppStore.getState().scriptError?.kind).toBe('stale');
  });
  it('取消表示はカーネル待ちに依存せず、旧結果が新しい実行を上書きしない', async () => {
    const old = fakeExecutor(), pending = runScript(); await vi.waitFor(() => expect(old.calls).toHaveLength(1));
    useAppStore.getState().cancelScript(); expect(useAppStore.getState().scriptPhase).toBe('cancelled');
    const next = fakeExecutor(), latest = runScript(); await vi.waitFor(() => expect(next.calls).toHaveLength(1));
    const prepared = success(old.calls[0].request); old.finish(prepared.result); await pending;
    expect(useAppStore.getState().scriptRequestId).toBe(next.calls[0].request.requestId); expect(prepared.release).toHaveBeenCalledTimes(1);
    next.finish({ ok: true, prepared: null, console: [{ level: 'info', text: 'next' }], commandCount: 0, initializationMs: 0, javascriptMs: 1, cadMs: 0 }); await latest;
    expect(useAppStore.getState().scriptConsole[0]?.text).toBe('next'); expect(useAppStore.getState().undoStack.past).toHaveLength(0);
  });
  it('CAD失敗は文書差分・Undo増分0で、理由と行を残す', async () => {
    const fake = fakeExecutor(), original = useAppStore.getState().document, pending = runScript();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.finish({ ok: false, error: { kind: 'cad', message: '未閉鎖', location: { file: 'helpers.js', line: 2, column: 1 } }, console: [] }); await pending;
    expect(useAppStore.getState().document).toBe(original); expect(useAppStore.getState().undoStack.past).toHaveLength(0);
    expect(useAppStore.getState().scriptError?.location).toEqual({ file: 'helpers.js', line: 2, column: 1 });
  });
});
