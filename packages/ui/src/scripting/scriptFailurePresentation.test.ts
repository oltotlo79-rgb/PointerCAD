import { describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { runScript, scriptErrorText } from './scriptActions.js';

describe('自動作図の実行結果の表示と開発者記録', () => {
  it.each([
    { kind: 'timeout', reason: 'totalTimeout', expected: '実行全体の上限90秒を超えました。' },
    { kind: 'timeout', reason: 'runtimeTimeout', expected: '処理時間の上限5秒を超えました。' },
    { kind: 'console', reason: 'tooManyLogBytes', expected: '表示する記録の上限1MiBを超えました。記録を減らしてください。' },
    { kind: 'command', reason: 'tooManyCommandBytes', expected: '操作の内容が上限8MiBを超えました。処理を分けてください。' },
    { kind: 'worker', reason: 'internal', expected: '内部の誤りが起きました。' },
  ] as const)('$reason の表示を解決する', ({ kind, reason, expected }) => {
    expect(scriptErrorText({ kind, reason, location: null })).toBe(expected);
  });

  it('実行器の失敗は元の例外を一度だけ記録し、画面には内部失敗の理由を渡す', async () => {
    resetTestStore();
    const error = new Error('script runtime detail');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      scriptPanelOpen: true, scriptRequestId: null, scriptController: null,
      scriptDraft: { scriptId: 'test', name: '自動作図', icon: 'code', source: 'work()', modules: [],
        seed: '1', time: '2026-09-11T00:00:00Z' },
      scriptExecutor: () => Promise.reject(error),
    });
    try {
      await runScript();
      const { scriptError, scriptPhase } = useAppStore.getState();
      expect(scriptPhase).toBe('failed');
      expect(scriptError).toEqual({ kind: 'worker', reason: 'internal', location: null });
      expect(log).toHaveBeenCalledExactlyOnceWith('PointerCAD script', error);
    } finally { log.mockRestore(); }
  });
});
