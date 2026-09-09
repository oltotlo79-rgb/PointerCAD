import { expressionValueFromNumber } from '@pointercad/expression';
import { createConfiguration, createDefaultConfigurations, createDrawingDocument, type PartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { runConfigurationAction } from './configurationActions.js';
import { commitAddParameter, commitRemoveParameter, commitRenameParameter, commitReplaceParameter, type ParameterCommandOutcome } from './parameterCommands.js';

const state = () => useAppStore.getState();
const parameter = (name: string, value: number) => ({ name, value: expressionValueFromNumber(value), unit: 'mm' as const, description: '' });
function apply(result: ParameterCommandOutcome): void {
  if (!result.ok) throw new Error(result.message);
  state().applyDocument(result.document);
}
function id(name: string): string {
  const found = state().document.configurations.find((configuration) => configuration.name === name);
  if (found === undefined) throw new Error('Missing configuration');
  return found.id;
}
function smallAndLarge(): { small: string; large: string } {
  expect(runConfigurationAction({ kind: 'create', name: '小' }).ok).toBe(true);
  const small = id('小');
  apply(commitReplaceParameter(state().document, '幅', parameter('幅', 20)));
  return { small, large: state().document.configurations[0].id };
}

describe('設計表の操作とUndo(P8-63)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    const parameters = [parameter('幅', 10)];
    const document: PartDocument = { ...state().document, parameters,
      configurations: createDefaultConfigurations(parameters), activeConfigurationId: 'configuration-1' };
    state().applyDocument(document);
  });
  it('現在の式を複製して構成を追加する', () => {
    const before = state().document;
    expect(runConfigurationAction({ kind: 'create', name: '小' })).toEqual({ ok: true });
    expect(state().document.configurations[1]).toMatchObject({ name: '小', values: { 幅: '10' } });
    expect(state().document.activeConfigurationId).toBe(before.activeConfigurationId);
  });
  it('構成切替でパラメータの式と値が追従する', () => {
    const { small } = smallAndLarge();
    expect(runConfigurationAction({ kind: 'activate', id: small })).toEqual({ ok: true });
    expect(state().document.parameters[0].value).toMatchObject({ source: '10', value: 10 });
    expect(state().parameterAnalysis.variables.get('幅')).toBe(10);
  });
  it('切替をUndo1回で戻せ、Redoで再現できる', () => {
    const { small, large } = smallAndLarge();
    runConfigurationAction({ kind: 'activate', id: small });
    state().undo();
    expect(state().document.activeConfigurationId).toBe(large);
    expect(state().document.parameters[0].value.value).toBe(20);
    state().redo();
    expect(state().document.activeConfigurationId).toBe(small);
    expect(state().document.parameters[0].value.value).toBe(10);
  });
  it('重複名で文書を変更しない', () => {
    const before = state().document;
    expect(runConfigurationAction({ kind: 'create', name: '既定' })).toEqual({ ok: false, reason: 'duplicateName' });
    expect(state().document).toBe(before);
  });
  it('削除済みIDへの操作で別の構成を変更しない', () => {
    const before = state().document;
    expect(runConfigurationAction({ kind: 'activate', id: 'missing' })).toEqual({ ok: false, reason: 'notFound' });
    expect(state().document).toBe(before);
  });
  it('改名をUndo1回で戻せる', () => {
    const initial = id('既定');
    runConfigurationAction({ kind: 'rename', id: initial, name: '大' });
    expect(state().document.configurations[0].name).toBe('大');
    state().undo();
    expect(state().document.configurations[0].name).toBe('既定');
  });
  it('最後の構成を消すと選択なしになり、Undoで戻る', () => {
    runConfigurationAction({ kind: 'delete', id: id('既定') });
    expect(state().document.configurations).toEqual([]);
    expect(state().document.activeConfigurationId).toBeNull();
    state().undo();
    expect(state().document.configurations).toHaveLength(1);
    expect(state().document.activeConfigurationId).toBe('configuration-1');
  });
  it('図面を開いているときに隠れた部品を変更しない', () => {
    const before = state().document;
    state().openDrawing(createDrawingDocument('図', { sourceRef: 'part', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '' }));
    expect(runConfigurationAction({ kind: 'create', name: '隠れた変更' })).toEqual({ ok: false, reason: 'partRequired' });
    expect(state().document).toBe(before);
  });
  it('別構成だけで参照されるパラメータも削除を断る', () => {
    apply(commitAddParameter(state().document, parameter('穴径', 3)));
    const configured = createConfiguration(state().document, '参照あり', { 穴径: '幅/2' });
    if (!configured.ok) throw new Error(configured.reason);
    state().applyDocument(configured.document);
    expect(commitRemoveParameter(state().document, '幅')).toMatchObject({ ok: false, reason: 'referenced' });
  });
  it('通常のパラメータ改名は全構成へ追従しUndo1回で戻る', () => {
    smallAndLarge();
    apply(commitRenameParameter(state().document, '幅', '横幅'));
    expect(state().document.configurations.map((configuration) => configuration.values)).toEqual([{ 横幅: '20' }, { 横幅: '10' }]);
    state().undo();
    expect(state().document.configurations.map((configuration) => configuration.values)).toEqual([{ 幅: '20' }, { 幅: '10' }]);
  });
  it('パラメータ追加を構成切替で失わない', () => {
    const { small } = smallAndLarge();
    apply(commitAddParameter(state().document, parameter('厚み', 3)));
    runConfigurationAction({ kind: 'activate', id: small });
    expect(state().document.parameters.map((entry) => [entry.name, entry.value.value])).toEqual([['幅', 10], ['厚み', 3]]);
  });
  it('同じ構成を選び直してUndoの段を増やさない', () => {
    const { small, large } = smallAndLarge();
    runConfigurationAction({ kind: 'activate', id: small });
    runConfigurationAction({ kind: 'activate', id: small });
    state().undo();
    expect(state().document.activeConfigurationId).toBe(large);
  });
});
