import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathEditorResultText } from './mathEditorResult.js';
import type { MathEditorSnapshot } from './MathEditorController.js';

afterEach(() => { vi.restoreAllMocks(); });

const input = { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: '1+2', notation: 'text' as const, angleUnit: 'radian' as const };
function evaluated(evaluation: MathEvaluation): MathEditorSnapshot {
  return { state: { status: 'evaluated', input, output: { input, definition: null, evaluation }, canApply: false }, query: '', problem: null };
}
/** Calculate in the Worker entry with a replaced clock: each of the first `slowBoxes` evaluation boxes takes 201ms. */
async function screen(source: string, slowBoxes: number) {
  let now = 0, remaining = slowBoxes;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const backend = createMathBackend();
  const slow: MathExecutionBackend = { ...backend, box: expression => {
    if (remaining > 0) { remaining -= 1; now += 201; }
    return backend.box(expression);
  } };
  const request = { ...input, source, coefficients: [] };
  const reply = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
    backend: slow, engine: { evaluate: () => Promise.reject(new Error('The exact engine must not run')) }, shouldStop: () => undefined });
  const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
  return { evaluation: output.evaluation, view: mathEditorResultText(evaluated(output.evaluation)) };
}

describe('時間の上限による停止を画面で計算量の上限と区別する', () => {
  it('計算し直しても時間の上限で止まった式は、計算時間の上限の文を出して値にしない', async () => {
    const { evaluation, view } = await screen('1+2', Number.POSITIVE_INFINITY);
    expect(evaluation).toEqual({ status: 'stopped', reason: 'deadline' });
    expect(view.message).toBe('計算時間の上限に達しました。式や範囲を小さくしてください。');
    expect(view.message).not.toContain('計算量');
    expect(view.detail).toBe('');
    expect(view.busy).toBe(false);
  });

  it('1回目だけ時間の上限で止まった式は、自動で計算し直した値を出す', async () => {
    const { evaluation, view } = await screen('1+2', 1);
    expect(evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
    expect(view.message).toBe('= 3');
  });

  it('手順・構造の上限は計算し直さず、これまでどおり計算量の上限の文を出す', async () => {
    const { evaluation, view } = await screen('zeta(129)', 0);
    expect(evaluation).toEqual({ status: 'stopped', reason: 'budget' });
    expect(view.message).toBe('計算量の上限に達しました。式や範囲を小さくしてください。');
  });
});
