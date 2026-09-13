import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { createDefaultConfigurations, prepareDocumentMathIdentity, type Parameter } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { acceptNumericMath, evaluateNumericMath, prepareNumericMathCommit } from './numericMathValues.js';
import { createNumericInput, reduceNumericInput, evaluateNumericInput, commitNumericInput } from './numericInput.js';
import { applyNumericTransition } from './commitToStore.js';

beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
  const parameters: readonly Parameter[] = [{ name: '幅', unit: 'mm', description: '', value: expressionValueFromNumber(3) }];
  useAppStore.getState().applyDocument({ ...useAppStore.getState().document, parameters, configurations: createDefaultConfigurations(parameters) });
});
function draft() {
  const original = useAppStore.getState().document, prepared = prepareDocumentMathIdentity(original);
  const id = prepared.parameters[0].mathId;
  if (id === undefined) throw new Error('Missing prepared ID');
  const value: ExpressionValue = { source: 'coef("幅")*2', value: 6, display: '6', mathDefinition: {
    format: 'pointercad-math/1', source: 'coef("幅")*2', inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'operation', operation: 'multiply', operands: [
      { kind: 'symbol', reference: { role: 'coefficient', id, label: '幅' } }, { kind: 'number', decimal: '2' }] },
  } };
  const accepted = acceptNumericMath(value, prepared, [{ id, label: '幅', decimal: '3' }]);
  const state = createNumericInput('point', 'point');
  return { original, prepared, value, accepted, state: { ...state,
    fields: state.fields.map((field, index) => index === 0 ? { ...field, source: accepted.source, typed: false, mathValue: accepted } : field) } };
}

describe('数式の座標下書きは確定した図形と同じUndoへ渡す', () => {
  it('二段入力の途中で係数が変わっても径を既定値へ置き換えず、前の段へ戻って修正できる', () => {
    const { accepted, original } = draft(), first = createNumericInput('spring', 'springShape');
    const input = { ...first, fields: first.fields.map((field, index) => index === 0
      ? { ...field, source: accepted.source, typed: false, mathValue: accepted } : field) };
    const advance = commitNumericInput(input, useAppStore.getState().parameterAnalysis);
    expect(advance.kind).toBe('open');
    if (advance.kind !== 'open') throw new Error('Missing second stage');
    const changed = { variables: new Map([['幅', 4]]), exactVariables: new Map([['幅', '4']]) };
    expect(evaluateNumericInput(advance.state, changed.variables, changed)).toMatchObject({
      canCommit: false, carriedError: { code: 'unknownVariable' },
    });
    expect(commitNumericInput(advance.state, changed).kind).toBe('blocked');
    const previous = advance.state.previousStage;
    if (previous === undefined) throw new Error('Missing repair state');
    expect(previous.fields[0].mathValue).toBe(accepted);
    expect(previous.choices).toBe(input.choices);
    const repaired = reduceNumericInput(previous, { type: 'edit', index: 0, source: '8' });
    const retry = commitNumericInput(repaired, changed);
    if (retry.kind !== 'open') throw new Error('Missing repaired second stage');
    const completed = commitNumericInput(retry.state, changed);
    expect(completed.kind).toBe('solidCommitted');
    if (completed.kind === 'solidCommitted') expect(completed.commit.values.coilDiameter?.value).toBe(8);
    expect(useAppStore.getState().document).toBe(original);
  });
  it('数式を欄へ入れただけではID・文書・履歴を変更せず、閉じても変更しない', () => {
    const { original, state } = draft();
    useAppStore.getState().updateNumericInput(state);
    useAppStore.getState().closeNumericInput();
    expect(useAppStore.getState().document).toBe(original);
    expect(original.mathParameterSerial).toBeUndefined();
    expect(original.parameters[0].mathId).toBeUndefined();
  });
  it('点の確定で式とIDを同時に保存し、Undo1回で元の文書へ戻る', () => {
    const { original, state } = draft();
    useAppStore.getState().updateNumericInput(state);
    const beforeFeatures = useAppStore.getState().sketch.features.length;
    const transition = commitNumericInput(state, useAppStore.getState().parameterAnalysis);
    expect(transition.kind).toBe('committed');
    applyNumericTransition(transition);
    expect(useAppStore.getState().document.parameters[0].mathId).toBe('coefficient:1');
    expect(useAppStore.getState().document.mathParameterSerial).toBe(1);
    expect(useAppStore.getState().sketch.features).toHaveLength(beforeFeatures + 1);
    expect(JSON.stringify(useAppStore.getState().sketch)).toContain('pointercad-math/1');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(original);
  });
  it('手入力・吸着・座標方式変更は前の数式定義を破棄する', () => {
    const { state } = draft();
    for (const next of [reduceNumericInput(state, { type: 'edit', index: 0, source: '8' }),
      reduceNumericInput(state, { type: 'setValues', values: [8] }), reduceNumericInput(state, { type: 'setMode', mode: 'relative' })]) {
      expect(next.fields[0].mathValue).toBeUndefined();
    }
  });
  it('表示がinchでも、数式画面で明示したmmを二重に換算しない', () => {
    const { state } = draft(), analysis = useAppStore.getState().parameterAnalysis;
    const evaluated = evaluateNumericInput(state, analysis.variables, { ...analysis, lengthUnit: 'inch' });
    expect(evaluated.canCommit).toBe(true);
    expect(evaluated.results[0].value).toMatchObject({ value: 6, source: 'coef("幅")*2' });
  });
  it('係数の変更・同じdoubleで異なる精密値・未登録の保存キャッシュを採用しない', () => {
    const { accepted, value } = draft();
    expect(evaluateNumericMath(accepted, new Map([['幅', 4]]), new Map([['幅', '4']])).ok).toBe(false);
    expect(evaluateNumericMath(accepted, new Map([['幅', 3]]), new Map([['幅', '3.00000000000000000001']])).ok).toBe(false);
    expect(evaluateNumericMath(value, new Map([['幅', 3]]), new Map([['幅', '3']])).ok).toBe(false);
  });
  it('別文書・名前変更・ID再割当の下書きを確定できず、準備結果も元を変えない', () => {
    const { original, state } = draft();
    const good = prepareNumericMathCommit(original, state);
    expect(good.ok).toBe(true);
    expect(original.parameters[0].mathId).toBeUndefined();
    for (const candidate of [{ ...original, id: 'another' },
      { ...original, parameters: [{ ...original.parameters[0], name: '別名' }] },
      { ...original, parameters: [{ ...original.parameters[0], mathId: 'coefficient:9' }] }]) {
      expect(prepareNumericMathCommit(candidate, state).ok).toBe(false);
    }
  });
  it('呼出元が保持した値やASTの後書換は採用済みの下書きへ影響しない', () => {
    const { accepted, value } = draft();
    Reflect.set(value, 'value', 100);
    expect(accepted.value).toBe(6);
    expect(Object.isFrozen(accepted.mathDefinition)).toBe(true);
    expect(evaluateNumericMath(accepted, new Map([['幅', 3]]), new Map([['幅', '3']])).ok).toBe(true);
  });
});
