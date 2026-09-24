import { describe, expect, it, vi } from 'vitest';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathEditorResultText } from './mathEditorResult.js';
import { mathResultAxes, chooseMathResultComponent } from './mathResultComponent.js';
import { MathEditorSession, type MathEditorOutput } from './mathEditorSession.js';
import type { MathEditorSnapshot } from './MathEditorController.js';
const input = { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: '1/3', notation: 'text' as const, angleUnit: 'radian' as const };
function evaluated(evaluation: MathEvaluation): MathEditorSnapshot {
  return { state: { status: 'evaluated', input, output: { input, definition: null, evaluation }, canApply: false }, query: '', problem: null };
}
describe('数学の型と未確定状態を数値の成功と混同しない表示', () => {
  it.each([
    ['im(erf(i))', '= 1.650425758797542876025337729561362443896'],
    ['im(erfc(i))', '= -1.650425758797542876025337729561362443896'],
    ['im(erf(sqrt(-1)))', '= 1.650425758797542876025337729561362443896'],
  ])('%sを実計算・公開返信から読みやすい小数の全文へ表示する', (source, expected) => {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    const view = mathEditorResultText(evaluated(output.evaluation));
    expect(view.message).toBe(expected);
    expect(view.hasError).toBe(false);
  });
  it.each(['zeta(129)', 'zetaderivative(18,2)', '0*zeta(129)', 'component([7,zeta(129)],1)'])('%sの計算上限を公開返信から画面へ伝え、値や内部の例外文にしない', source => {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(output.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
    const view = mathEditorResultText(evaluated(output.evaluation));
    expect(view.message).toBe('計算量の上限に達しました。式や範囲を小さくしてください。');
    expect(view.detail).toBe('');
    expect(view.busy).toBe(false);
  });
  it('展開した式・中心・打切り次数を示し、O記号を数値の誤差上限にしない', () => {
    const number = (decimal: string) => ({ kind: 'number' as const, decimal });
    const expression = { kind: 'operation' as const, operation: 'maclaurin', operands: [
      { kind: 'binder' as const, operation: 'lambda', bindings: [{ variable: { role: 'bound' as const, id: 'local', label: 'x' },
        domain: { kind: 'unrestricted' as const } }], body: number('1') }, number('4')] };
    const evaluation: Extract<MathEvaluation, { kind: 'series' }> = { status: 'value', kind: 'series', expression,
      expansion: { center: number('0'), degree: '4', coefficients: Array.from({ length: 5 }, () => number('1')),
        exact: false, remainderOrder: '5', convergence: { kind: 'disk', radius: number('1') } } };
    const view = mathEditorResultText(evaluated(evaluation));
    expect(view.message).toBe('P4(x) = 1 + x + x^2 + x^3 + x^4');
    expect(view.detail).toContain('O(x^5)');
    expect(view.detail).toContain('数値誤差の上限ではありません');
    expect(view.detail).toContain('|x| < 1');
    expect(view.detail).toContain('境界と範囲外');
    const unknown = mathEditorResultText(evaluated({ ...evaluation,
      expansion: { ...evaluation.expansion, convergence: { kind: 'unknown', radius: null } } }));
    expect(unknown.detail).toContain('収束範囲は未確認');
    expect(unknown.detail).not.toContain('全ての有限');
    const exact = mathEditorResultText(evaluated({ ...evaluation,
      expansion: { ...evaluation.expansion, exact: true, convergence: { kind: 'entire', radius: null } } }));
    expect(exact.detail).toContain('省略項は0');
    expect(exact.detail).not.toContain('O(');
  });
  it.each([['true', '真（成立）'], ['false', '偽（不成立）']] as const)('確定した%sを真偽の結果として表示する', (name, expected) => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'boolean', expression: { kind: 'constant', name } }));
    expect(view.message).toBe(expected);
    expect(view.hasError).toBe(false);
    expect(view.message).not.toMatch(/= [01]/u);
  });
  it('真偽が未確定なら偽として表示しない', () => {
    const view = mathEditorResultText(evaluated({ status: 'unresolved', reason: 'unevaluated', names: [] }));
    expect(view.message).not.toContain('偽');
    expect(view.message).not.toContain('真（');
  });
  it('数値積分の推定値は≈で示し、推定誤差を保証値と呼ばない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'real', decimal: '0.3102683017233811', coordinate: 0.3102683017233811,
      exact: null, approximation: { absoluteError: null, estimatedAbsoluteError: 1e-12 } }));
    expect(view.message).toBe('≈ 0.3102683017233811');
    expect(view.detail).toContain('推定誤差');
    expect(view.detail).toContain('保証値ではありません');
    expect(view.detail).toContain('1e-12');
    expect(view.detail).toContain('誤差上限を確認できません');
  });
  it('誤差不明の数値を誤差0として表示しない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'real', decimal: '0.5', coordinate: 0.5,
      exact: null, approximation: { absoluteError: null } }));
    expect(view.message).toBe('= 0.5');
    expect(view.detail).toContain('誤差上限を確認できません');
  });
  it('網羅されていない解候補には、そのことを添える', () => {
    const view = mathEditorResultText(evaluated({ status: 'multiple', candidates: [{ kind: 'number', decimal: '1' }], exhaustive: false }));
    expect(view.message).toContain('複数');
    expect(view.detail).toContain('候補以外');
  });
  it('複素数を黙って実部だけの座標に見せない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'complex', expression: { kind: 'constant', name: 'imaginary-unit' } }));
    expect(view.message).toContain('複素数');
    expect(view.message).not.toContain('= 0');
  });
  it('計算中と入力待ちを別の状態として表示する', () => {
    const pending = { query: '', problem: null };
    expect(mathEditorResultText({ ...pending, state: { status: 'calculating', input } }).busy).toBe(true);
    expect(mathEditorResultText({ ...pending, state: { status: 'editing', input } }).busy).toBe(false);
  });
});

describe('±・∓の実計算候補の表示と採用', () => {
  it.each([['plusminus(1,2)', '3, -1'], ['minusplus(1,2)', '-1, 3']])('%sの候補と符号選択の案内を表示する', (source, expected) => {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(output.evaluation.status).toBe('multiple');
    const view = mathEditorResultText(evaluated(output.evaluation));
    expect(view.message).toContain('複数');
    expect(view.detail).toContain(expected);
    expect(view.detail).toContain('符号に置き換えて');
    expect(view.detail).not.toContain('候補以外');
    expect(view.hasError).toBe(false);
    expect(view.busy).toBe(false);
  });
  it('ベクトルの候補も選択前には成分を自動採用しない', () => {
    const request = { ...input, source: '[plusminus(1,2),4]', coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(output.evaluation.status).toBe('multiple');
    expect(mathResultAxes(output.evaluation)).toBeNull();
    expect(chooseMathResultComponent(request, output.evaluation, [1])).toBeNull();
  });
  it('編集セッションは適用要求があってもmultipleを拒否し、符号の明示後にだけ採用する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onApply = vi.fn<(output: MathEditorOutput) => void>();
    const session = new MathEditorSession({ initial: { ...input, source: 'plusminus(1,2)' },
      calculate: current => {
        const request = { ...current, coefficients: [] };
        const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
        return Promise.resolve({ input: current, ...decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
          coefficientIds: new Set(), declaredIds: new Set() }).result });
      }, isCurrentDocument: () => true, canApply: () => true, onState: vi.fn(), onApply });
    try {
      session.requestApply();
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ status: 'evaluated', canApply: false });
      expect(onApply).not.toHaveBeenCalled();
      session.update('1-2', 'text', 'radian');
      session.requestApply();
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ status: 'evaluated', canApply: true });
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply.mock.calls[0]?.[0].evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: -1 });
    } finally { session.dispose(); vi.useRealTimers(); }
  });
});

describe('行列の |A| の読み方の候補の表示と採用', () => {
  const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
  /** The real parsed definition; the exact runtime's candidates are checked in the expression package. */
  function output(source: string, evaluation?: MathEvaluation): MathEditorOutput {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const result = decodeMathWorkReply(reply, request, context).result;
    return { input: { ...input, source }, definition: result.definition, evaluation: evaluation ?? result.evaluation };
  }
  const view = (value: MathEditorOutput) => mathEditorResultText({ state: { status: 'evaluated', input: value.input, output: value,
    canApply: false }, query: '', problem: null });
  const number = (decimal: string) => ({ kind: 'number' as const, decimal });
  const root = { kind: 'operation' as const, operation: 'sqrt', operands: [number('30')] };
  const candidates: MathEvaluation = { status: 'multiple', candidates: [number('-2'), root], exhaustive: true };
  it('行列の |A| は行列式・ノルムの順の候補と書き換えの案内を示し、±の案内を出さない', () => {
    const value = output('|[[1,2],[3,4]]|', candidates);
    expect(value.definition?.source).toBe('|[[1,2],[3,4]]|');
    const text = view(value);
    expect(text.message).toContain('複数');
    expect(text.detail.startsWith('行列式・ノルムの順の候補: -2, sqrt(30). 行列の |A| は')).toBe(true);
    expect(text.detail).toContain('det(…)');
    expect(text.detail).toContain('norm([…])');
    expect(text.detail).not.toContain('符号に置き換えて');
    expect(text.hasError).toBe(false);
    expect(mathResultAxes(value.evaluation)).toBeNull();
    expect(chooseMathResultComponent(value.input, value.evaluation, [1])).toBeNull();
  });
  it('±と行列の |A| を含む候補には両方の案内を示す', () => {
    const text = view(output('|[[1,2],[3,4]]|±1', { status: 'multiple', exhaustive: true,
      candidates: [number('-1'), number('-3'), root, root] }));
    expect(text.detail.startsWith('候補: -1, -3')).toBe(true);
    expect(text.detail).toContain('符号に置き換えて');
    expect(text.detail).toContain('det(…)');
  });
  it('実数の絶対値と±の候補には±の案内だけを示す', () => {
    const value = output('|plusminus(1,2)|');
    expect(value.evaluation).toEqual({ status: 'multiple', exhaustive: true, candidates: [number('3'), number('1')] });
    const text = view(value);
    expect(text.detail.startsWith('候補: 3, 1.')).toBe(true);
    expect(text.detail).toContain('符号に置き換えて');
    expect(text.detail).not.toContain('det(…)');
  });
  it('編集セッションは行列の |A| の候補を採用せず、det(…)へ書き換えた式だけを保存用の原式として採用する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onApply = vi.fn<(output: MathEditorOutput) => void>();
    const determinant: MathEvaluation = { status: 'value', kind: 'real', exact: number('-2'), decimal: '-2', coordinate: -2, approximation: null };
    const session = new MathEditorSession({ initial: { ...input, source: '|[[1,2],[3,4]]|' },
      calculate: current => Promise.resolve({ ...output(current.source,
        current.source === 'det([[1,2],[3,4]])' ? determinant : candidates), input: current }),
      isCurrentDocument: () => true, canApply: () => true, onState: vi.fn(), onApply });
    try {
      session.requestApply();
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ status: 'evaluated', canApply: false });
      expect(onApply).not.toHaveBeenCalled();
      session.update('det([[1,2],[3,4]])', 'text', 'radian');
      session.requestApply();
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ status: 'evaluated', canApply: true });
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply.mock.calls[0]?.[0].definition?.source).toBe('det([[1,2],[3,4]])');
      expect(onApply.mock.calls[0]?.[0].definition?.expression).toMatchObject({ kind: 'operation', operation: 'determinant' });
    } finally { session.dispose(); vi.useRealTimers(); }
  });
});

describe('不定積分の結果に積分定数を示し、座標には使わせない(MC-20)', () => {
  const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
  /** The real parsed definition (a binder with an 'unrestricted' domain); the antiderivative value
   * stands in for what the exact runtime returns once it may let the bound variable escape (MC-20 report). */
  function output(source: string, evaluation: MathEvaluation): MathEditorOutput {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const result = decodeMathWorkReply(reply, request, context).result;
    return { input: { ...input, source }, definition: result.definition, evaluation };
  }
  const view = (value: MathEditorOutput) => mathEditorResultText({ state: { status: 'evaluated', input: value.input, output: value,
    canApply: false }, query: '', problem: null });
  const number = (decimal: string) => ({ kind: 'number' as const, decimal });
  const t = { kind: 'symbol' as const, reference: { role: 'declared' as const, id: 't', label: 't' } };
  const antiderivative: MathEvaluation = { status: 'value', kind: 'symbolic',
    expression: { kind: 'operation', operation: 'divide', operands: [
      { kind: 'operation', operation: 'power', operands: [t, number('3')] }, number('3')] } };
  it('integrate(t^2,t)は原始関数＋Cの案内を示し、座標が必要な数式であることを示さない', () => {
    const value = output('integrate(t^2,t)', antiderivative);
    expect(value.definition?.expression).toMatchObject({ kind: 'binder', operation: 'integrate',
      bindings: [{ domain: { kind: 'unrestricted' } }] });
    const text = view(value);
    expect(text.message).toContain('原始関数');
    expect(text.message).toContain('C');
    expect(text.detail).toContain('積分定数');
    expect(text.detail).toContain('座標・成分・係数の数値には使えません');
    expect(text.hasError).toBe(false);
    // The generic scalar-coordinate gate (mathScalarValue) only accepts kind 'real'; 'symbolic' is
    // already refused there, exactly like any other non-numeric result (MC-11/MC-12's precedent).
    if (value.evaluation.status !== 'value') throw new Error('symbolicな評価を期待しています');
    expect(value.evaluation.kind).not.toBe('real');
  });
  it('2*integrate(t^2,t)のように式の内側にある不定積分も検出して原始関数の案内を示す', () => {
    const value = output('2*integrate(t^2,t)', antiderivative);
    expect(value.definition?.expression).toMatchObject({ kind: 'operation', operation: 'multiply' });
    const text = view(value);
    expect(text.message).toContain('原始関数');
  });
  it('定積分integrate(t^2,t,0,3)は積分定数の案内を出さず、従来どおりの実数表示のままにする', () => {
    const value = output('integrate(t^2,t,0,3)', { status: 'value', kind: 'real',
      decimal: '9', coordinate: 9, exact: number('9'), approximation: null });
    expect(value.definition?.expression).toMatchObject({ kind: 'binder', operation: 'integrate',
      bindings: [{ domain: { kind: 'range' } }] });
    const text = view(value);
    expect(text.message).not.toContain('原始関数');
    expect(text.message).toBe('= 9');
  });
  it('不定積分に由来しないsymbolicな結果には、これまでどおり一般の案内を示す', () => {
    const view0 = mathEditorResultText(evaluated({ status: 'value', kind: 'symbolic',
      expression: { kind: 'operation', operation: 'jacobian', operands: [t] } }));
    expect(view0.message).not.toContain('原始関数');
    expect(view0.message).toBe('数式のままの結果です。値を決めるための条件を指定してください。');
  });
});
