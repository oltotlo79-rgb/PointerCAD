import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mathScalarExpression } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathNode, type MathVariableScope } from '@pointercad/expression/math/contracts';
import type { MathWorkerClient, MathWorkRequest } from '@pointercad/expression/math/client';
import { createMathBackend, executeExactMathWorkRequest, executeMathWorkRequest,
  type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { createEmptyPartDocument } from '@pointercad/model';
import { mathEditorResultText } from './mathEditorResult.js';
import { chooseMathResultComponent, mathResultAxes } from './mathResultComponent.js';
import { MathEditorSession, type MathEditorOutput } from './mathEditorSession.js';
import { editFunctionField, evaluateFunctionPlotDraft, functionPlotDraft, type FunctionPlotDraft } from '../functionPlot/functionPlotDraft.js';
import { t } from '../i18n/t.js';

/**
 * MC-20: the answer to a whole-formula indefinite integral is the family F+C, delivered as a 'function'
 * (a lambda over the integral's own variable). Every value below comes from the real exact runtime's
 * reply, not from a hand-written node, so the display is checked on what the runtime actually returns.
 */
const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_integrals_test.py', import.meta.url));
type Pending = { readonly input: { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' };
  readonly resolve: (value: unknown) => void; readonly reject: (reason: Error) => void };
/** Like the product engine, one prepared runtime serves every request made in the same turn. */
function batchEngine(): { readonly evaluate: (expression: MathNode, angleUnit: 'degree' | 'radian') => Promise<unknown> } {
  let pending: Pending[] = [];
  const flush = (): void => {
    const batch = pending;
    pending = [];
    try {
      const run = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
        input: JSON.stringify(batch.map(item => item.input)), encoding: 'utf8', timeout: 150_000, maxBuffer: 4_000_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
      if (run.status !== 0 || run.error !== undefined) throw new Error(run.stderr || run.error?.message);
      const replies: unknown = JSON.parse(run.stdout);
      if (!Array.isArray(replies) || replies.length !== batch.length) throw new Error('計算の返信数が不正です。');
      batch.forEach((item, index) => { item.resolve(replies[index]); });
    } catch (error) {
      for (const item of batch) item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { evaluate: (expression, angleUnit) => new Promise((resolve, reject) => {
    if (pending.length === 0) setImmediate(flush);
    pending.push({ input: { expression, angleUnit }, resolve, reject });
  }) };
}

const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
function request(source: string): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 1 }, source,
    notation: 'text', angleUnit: 'radian', coefficients: [] };
}
const SOURCES = {
  square: 'integrate(t^2,t)', zero: 'integrate(0,t)', reciprocal: 'integrate(1/t,t)', named: 'integrate(C^2,C)',
  definite: 'integrate(t^2,t,0,3)',
  // MC-20c: a shifted denominator still surfaces natural-log inside the antiderivative body (ln(-1 + t)).
  shiftedReciprocal: 'integrate(1/(t-1),t)',
} as const;
const outputs = new Map<keyof typeof SOURCES, MathEditorOutput>();
function recorded(key: keyof typeof SOURCES): MathEditorOutput {
  const value = outputs.get(key);
  if (value === undefined) throw new Error(`計算していない入力です: ${key}`);
  return value;
}
const view = (output: MathEditorOutput) => mathEditorResultText({ state: { status: 'evaluated', input: output.input, output,
  canApply: false }, query: '', problem: null });
let backend: MathExecutionBackend;
beforeAll(async () => {
  backend = createMathBackend();
  const engine = batchEngine(), keys = Object.keys(SOURCES) as (keyof typeof SOURCES)[];
  const replies = await Promise.all(keys.map(key => executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: request(SOURCES[key]) },
    { backend, engine, shouldStop: () => undefined })));
  keys.forEach((key, index) => {
    const input = request(SOURCES[key]), result = decodeMathWorkReply(replies[index], input, context).result;
    outputs.set(key, { input: { identity: input.identity, source: input.source, notation: input.notation, angleUnit: input.angleUnit },
      definition: result.definition, evaluation: result.evaluation });
  });
}, 180_000);

describe('不定積分の実計算の答えを原始関数＋積分定数として表示する(MC-20)', () => {
  it.each([
    ['square', '原始関数: 1/3 * t^3 + C', false],
    ['zero', '原始関数: 0 + C', false],
    ['reciprocal', '原始関数: ln(t) + C', true],
    // MC-20c: a shifted denominator's antiderivative still contains natural-log (ln(-1 + t)), so it too gets the note.
    ['shiftedReciprocal', '原始関数: ln(-1 + t) + C', true],
  ] as const)('%sの実計算の答えを「%s」と表示し、座標・成分・係数に使えない理由を添える', (key, message, hasLn) => {
    const output = recorded(key);
    expect(output.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    const text = view(output);
    // MC-20c: only an antiderivative written with ln gets the real-range reading note (ln|…| + C); it never
    // changes the answer's message, only appends one sentence to the detail (統括 2026-09-24 案(b)).
    const detail = hasLn ? `${t('math.indefiniteIntegral.hint')} ${t('math.indefiniteIntegral.lnRealNote')}` : t('math.indefiniteIntegral.hint');
    expect(text).toEqual({ message, detail, hasError: false, busy: false });
    expect(text.detail).toContain('座標・成分・係数の数値には使えません');
    expect(text.detail.includes('ln|')).toBe(hasLn);
  });
  it('原始関数にlnを含むときだけ実数の範囲での読み替えの注記を添える(MC-20c)', () => {
    // integrate(1/t,t) と integrate(1/(t-1),t) はどちらも原始関数にlnを含むため注記が付く。
    expect(view(recorded('reciprocal')).detail).toContain(t('math.indefiniteIntegral.lnRealNote'));
    expect(view(recorded('shiftedReciprocal')).detail).toContain(t('math.indefiniteIntegral.lnRealNote'));
    // integrate(t^2,t) と integrate(0,t) はlnを含まないため注記は付かない。
    expect(view(recorded('square')).detail).not.toContain(t('math.indefiniteIntegral.lnRealNote'));
    expect(view(recorded('zero')).detail).not.toContain(t('math.indefiniteIntegral.lnRealNote'));
  });
  it('積分の変数がCのときは積分定数をKと書き、変数と取り違えない', () => {
    const text = view(recorded('named'));
    expect(text.message).toBe('原始関数: 1/3 * C^3 + K');
    expect(text.detail).toBe(t('math.indefiniteIntegral.hintConstantK'));
    expect(text.detail).toContain('積分定数K');
  });
  it('定積分の答えは従来どおり数値として表示し、原始関数の案内を出さない', () => {
    const text = view(recorded('definite'));
    expect(text.message).toBe('= 9');
    expect(text.message).not.toContain('原始関数');
    expect(mathScalarExpression(recorded('definite')).ok).toBe(true);
  });
});

describe('不定積分の答えを座標・成分・係数・関数の式として使わせない(MC-20)', () => {
  it.each(['square', 'zero', 'reciprocal', 'named', 'shiftedReciprocal'] as const)('%sの答えは座標・係数の値にならず、成分も選べない', key => {
    const output = recorded(key);
    expect(mathScalarExpression(output)).toEqual({ ok: false, message: 'この欄には一意に決まる実数が必要です。式と条件を確認してください。' });
    expect(mathResultAxes(output.evaluation)).toBeNull();
    expect(chooseMathResultComponent(output.input, output.evaluation, [1])).toBeNull();
  });
  it('座標・係数の編集画面は、適用を求められても不定積分の答えを適用しない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = recorded('square'), onApply = vi.fn<(output: MathEditorOutput) => void>();
    // The same acceptance rule as the coordinate and coefficient editor (MathExpressionDialog).
    const session = new MathEditorSession({ initial: answer.input, calculate: current => Promise.resolve({ ...answer, input: current }),
      isCurrentDocument: () => true, canApply: output => mathScalarExpression(output).ok, onState: vi.fn(), onApply });
    try {
      session.requestApply();
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ status: 'evaluated', canApply: false });
      expect(onApply).not.toHaveBeenCalled();
    } finally { session.dispose(); vi.useRealTimers(); }
  });

  const INDEFINITE_IN_FUNCTION = '不定積分は積分定数が定まらない関数の集まりのため、関数の式には使えません。原始関数を式で書き、積分定数を決めてください（例 integrate(X^2,X) の代わりに X^3/3+1）。';
  const scope: MathVariableScope = { axes: ['X'], parameters: [] };
  it('関数の式の編集画面では、不定積分を使えない理由と代わりの書き方を示して適用させない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onApply = vi.fn<(output: MathEditorOutput) => void>();
    const session = new MathEditorSession({ initial: { ...request('integrate(X^2,X)'), identity: { ...request('').identity, editorId: 'function-Y' } },
      calculate: current => {
        const input: MathWorkRequest = { ...current, coefficients: [], functionScope: scope };
        const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
        return Promise.resolve({ input: current, ...decodeMathWorkReply(reply, input, context).result });
      },
      // The same acceptance rule as the function formula editor (MathExpressionDialog, kind="function").
      isCurrentDocument: () => true, canApply: output => output.definition !== null && output.evaluation.status === 'value'
        && output.evaluation.kind === 'function', onState: vi.fn(), onApply });
    try {
      session.requestApply();
      await vi.runAllTimersAsync();
      const state = session.snapshot;
      if (state.status !== 'evaluated') throw new Error(JSON.stringify(state));
      expect(state.canApply).toBe(false);
      expect(onApply).not.toHaveBeenCalled();
      expect(mathEditorResultText({ state, query: '', problem: null })).toEqual({ message: INDEFINITE_IN_FUNCTION, detail: '', hasError: true, busy: false });
    } finally { session.dispose(); vi.useRealTimers(); }
  });

  const client = (): Pick<MathWorkerClient, 'evaluate'> => ({ evaluate: input => Promise.resolve({
    status: 'result', identity: input.identity,
    result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend), input,
      { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(input.coefficients.map(item => item.id)), declaredIds: new Set() }).result }) });
  function withOutput(source: string): FunctionPlotDraft {
    const draft = functionPlotDraft(), scalar = (value: string) => ({ source: value, angleUnit: 'degree' as const });
    const filled = { ...draft, scalars: { ...draft.scalars, 'X.min': scalar('-2'), 'X.max': scalar('2'),
      'Y.min': scalar('-4'), 'Y.max': scalar('4'), 'Z.min': scalar('-1'), 'Z.max': scalar('1') } };
    return { ...filled, outputs: { ...filled.outputs, Y: editFunctionField(filled.outputs.Y, source) } };
  }
  it('関数作図の画面の関数の式の欄に、不定積分を使えない理由と代わりの書き方を出す', async () => {
    const refused = await evaluateFunctionPlotDraft(createEmptyPartDocument(), 1, withOutput('integrate(X^2,X)'), client(),
      new AbortController().signal, () => true);
    if (refused.ok) throw new Error('不定積分の関数の式が確定しました。');
    expect(refused.fields.get('Y')).toBe(INDEFINITE_IN_FUNCTION);
    expect([...refused.fields.keys()]).toEqual(['Y']);
    // The suggested form, the antiderivative written out with a chosen constant, is accepted as the function formula.
    const accepted = await evaluateFunctionPlotDraft(createEmptyPartDocument(), 1, withOutput('X^3/3+1'), client(),
      new AbortController().signal, () => true);
    if (!accepted.ok) throw new Error(JSON.stringify([...accepted.fields]));
    expect(accepted.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'X^3/3+1' } } });
  });
});
