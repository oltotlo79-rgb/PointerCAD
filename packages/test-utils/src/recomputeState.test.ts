import { describe, expect, it } from 'vitest';
import { recomputeTerminalOutcome, type RecomputeState } from './recomputeState.js';

const finished: RecomputeState = { isComputing: false, requestedGeneration: 8, completedGeneration: 8, lastOutcome: 'success' };
describe('再計算の最新世代の失敗を待機中と取り違えない', () => {
  it.each(['success', 'failed', 'workerBroken'] as const)('%sで完了した最新世代を直ちに返す', lastOutcome => {
    expect(recomputeTerminalOutcome({ ...finished, lastOutcome }, 7)).toBe(lastOutcome);
  });
  it.each(['success', 'failed', 'workerBroken'] as const)('以前の世代の%sは今回の結末にしない', lastOutcome => {
    expect(recomputeTerminalOutcome({ ...finished, lastOutcome }, 8)).toBe('waiting');
    expect(recomputeTerminalOutcome({ ...finished, requestedGeneration: 9, lastOutcome }, 7)).toBe('waiting');
  });
  it('未取得・計算中・取消・未実行を合格にしない', () => {
    expect(recomputeTerminalOutcome(null, 7)).toBe('waiting');
    expect(recomputeTerminalOutcome({ ...finished, isComputing: true }, 7)).toBe('waiting');
    expect(recomputeTerminalOutcome({ ...finished, lastOutcome: 'cancelled' }, 7)).toBe('waiting');
    expect(recomputeTerminalOutcome({ ...finished, lastOutcome: 'idle' }, 7)).toBe('waiting');
  });
});
