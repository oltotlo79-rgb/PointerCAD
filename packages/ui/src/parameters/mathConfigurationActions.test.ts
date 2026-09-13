import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultConfigurations, evaluateDocumentMath, prepareDocumentMathIdentity, type Parameter } from '@pointercad/model';
import { MathWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import {
  createMathBackend,
  executeMathWorkRequest,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { runMathConfigurationAction } from './mathConfigurationActions.js';
import { runMathParameterRename } from './mathParameterActions.js';
import { commitRenameParameter, parameterUsageCounts, commitRemoveParameter, parameterRowsOf, commitReplaceParameter } from './parameterCommands.js';

const backend = createMathBackend();
const clients: MathWorkerClient[] = [];
beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
  const value: Parameter['value'] = { source: '2^3', value: 8, display: '8', mathDefinition: {
    format: 'pointercad-math/1', source: '2^3', angleUnit: 'degree', inputNotation: 'text',
    expression: { kind: 'operation', operation: 'power', operands: [{ kind: 'number', decimal: '2' }, { kind: 'number', decimal: '3' }] },
  } };
  const parameters: readonly Parameter[] = [{ name: '幅', mathId: 'coefficient:1', unit: 'mm', description: '', value }];
  const document = prepareDocumentMathIdentity({ ...useAppStore.getState().document, parameters, configurations: createDefaultConfigurations(parameters) });
  useAppStore.getState().applyDocument(document);
});
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); });

function transport(hold = false) {
  let terminated = 0;
  const sent: { readonly port: MathWorkerPort; readonly value: unknown }[] = [];
  const client = new MathWorkerClient({
    createWorker: () => {
      const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        terminate: () => { terminated += 1; },
        postMessage: value => {
          sent.push({ port, value });
          if (!hold) queueMicrotask(() => port.onmessage?.({ data: executeMathWorkRequest(value, backend) }));
        },
      };
      return port;
    },
    decodeReply: (value, request) => decodeMathWorkReply(value, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }),
  });
  clients.push(client);
  return { client, sent, terminated: () => terminated };
}

describe('数学を含む構成操作は現在の文書へUndo1回で適用する', () => {
  it('係数変更後の欄は保存キャッシュではなく実エンジンの現在の解析値を表示する', async () => {
    const original = useAppStore.getState().document;
    const base: Parameter = { name: '係数', unit: 'mm', description: '', mathId: 'coefficient:2', value: { source: '3', value: 3, display: '3' } };
    const dependent: Parameter = { ...original.parameters[0], value: { source: 'coef("係数")*2', value: 6, display: '6',
      mathDefinition: { format: 'pointercad-math/1', source: 'coef("係数")*2', inputNotation: 'text', angleUnit: 'degree',
        expression: { kind: 'operation', operation: 'multiply', operands: [
          { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:2', label: '係数' } }, { kind: 'number', decimal: '2' }] } } } };
    const parameters = [base, dependent], document = { ...original, parameters, configurations: createDefaultConfigurations(parameters) };
    const edited = commitReplaceParameter(document, '係数', { value: { source: '4', value: 3, display: '3' } });
    if (!edited.ok) throw new Error(edited.message);
    expect(edited.document.parameters[1].value.value).toBe(6);
    const channel = transport(), evaluated = await evaluateDocumentMath(edited.document,
      { client: channel.client, identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true });
    if (!evaluated.ok) throw new Error(JSON.stringify(evaluated.failures));
    expect(parameterRowsOf(edited.document, evaluated.analysis)[1]).toMatchObject({ value: 8, source: 'coef("係数")*2', failureMessage: null });
    expect(edited.document.parameters[1].value.value).toBe(6);
  });
  it('数学係数の改名も一括適用し、Undoで名前と全構成のキーが戻る', async () => {
    const before = useAppStore.getState().document, channel = transport();
    expect(commitRenameParameter(before, '幅', '横幅')).toMatchObject({ ok: false, reason: 'requiresMathWorker' });
    expect(await runMathParameterRename('幅', '横幅', { createClient: () => channel.client })).toEqual({ ok: true });
    expect(useAppStore.getState().parameterAnalysis.variables.get('横幅')).toBe(8);
    expect(useAppStore.getState().document.configurations[0].mathDefinitions?.横幅).toBeDefined();
    expect(useAppStore.getState().document.configurations[0].mathDefinitions).not.toHaveProperty('幅');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before);
  });
  it('未選択構成にだけ残る数学係数参照も使用件数に数え削除を断る', () => {
    const initial = useAppStore.getState().document;
    const definition: NonNullable<Parameter['value']['mathDefinition']> = { format: 'pointercad-math/1', inputNotation: 'latex',
      source: '\\mathrm{幅}', angleUnit: 'degree', expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:1', label: '幅' } } };
    const document = { ...initial, parameters: [...initial.parameters, { ...initial.parameters[0], name: 'B', mathId: 'coefficient:2' }],
      configurations: [...initial.configurations, { id: 'saved', name: '未選択', values: { 幅: '8', B: definition.source }, mathDefinitions: { B: definition } }] };
    expect(parameterUsageCounts(document).get('幅')).toBe(1);
    expect(commitRemoveParameter(document, '幅')).toMatchObject({ ok: false, reason: 'referenced' });
  });
  it('改名中に取消したらWorkerを解放し元の文書を維持する', async () => {
    const before = useAppStore.getState().document, channel = transport(true), abort = new AbortController();
    const pending = runMathParameterRename('幅', '横幅', { signal: abort.signal, createClient: () => channel.client });
    await Promise.resolve();
    abort.abort();
    expect((await pending).ok).toBe(false);
    expect(useAppStore.getState().document).toBe(before);
    expect(channel.terminated()).toBe(1);
  });
  it('実Worker手順の評価後に構成を追加し、数学係数の解析値も更新する', async () => {
    const before = useAppStore.getState().document, channel = transport();
    expect(await runMathConfigurationAction({ kind: 'create', name: '数式の構成' }, { createClient: () => channel.client })).toEqual({ ok: true });
    expect(useAppStore.getState().document.configurations).toHaveLength(2);
    const id = useAppStore.getState().document.configurations[1].id;
    const next = transport();
    expect(await runMathConfigurationAction({ kind: 'activate', id }, { createClient: () => next.client })).toEqual({ ok: true });
    expect(useAppStore.getState().parameterAnalysis.variables.get('幅')).toBe(8);
    expect(useAppStore.getState().parameterAnalysis.failures).toEqual([]);
    expect(channel.terminated()).toBe(1);
    expect(next.terminated()).toBe(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.activeConfigurationId).toBe(before.activeConfigurationId);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before);
  });
  it.each(['cancel', 'edit'] as const)('%s中の古い返信は文書を上書きしない', async mode => {
    const original = useAppStore.getState().document, channel = transport(true), controller = new AbortController();
    const pending = runMathConfigurationAction({ kind: 'create', name: '古い結果' }, { signal: controller.signal, createClient: () => channel.client });
    // Evaluation yields at the parameter boundary before the first Worker request is queued.
    await Promise.resolve();
    if (mode === 'cancel') controller.abort();
    else useAppStore.getState().applyDocument({ ...original, name: '新しい編集' });
    const current = useAppStore.getState().document;
    expect((await pending).ok).toBe(false);
    for (const item of channel.sent) item.port.onmessage?.({ data: executeMathWorkRequest(item.value, backend) });
    expect(useAppStore.getState().document).toBe(current);
    expect(channel.terminated()).toBe(1);
  });
  it('中止済みの操作はWorkerも文書変更も開始しない', async () => {
    const before = useAppStore.getState().document, controller = new AbortController(); controller.abort();
    expect((await runMathConfigurationAction({ kind: 'create', name: '中止' }, { signal: controller.signal,
      createClient: () => { throw new Error('Must not create worker'); } })).ok).toBe(false);
    expect(useAppStore.getState().document).toBe(before);
  });
});
