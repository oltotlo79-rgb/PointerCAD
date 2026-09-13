import { afterEach, describe, expect, it, vi } from 'vitest';
import { MathWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import {
  createMathBackend,
  executeMathWorkRequest,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import { MathEditorController } from './MathEditorController.js';
import type { MathEditorOutput } from './mathEditorSession.js';

const backend = createMathBackend();
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.useRealTimers(); });
function fixture(source = '1/3') {
  vi.useFakeTimers();
  const sent: { value: unknown; port: MathWorkerPort }[] = [];
  const terminated: MathWorkerPort[] = [];
  const applied: MathEditorOutput[] = [];
  let generation = 1;
  const client = new MathWorkerClient({
    createWorker: () => {
      const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        postMessage: value => { sent.push({ value, port }); },
        terminate: () => { terminated.push(port); },
      };
      return port;
    },
    decodeReply: (value, request) => decodeMathWorkReply(value, request, {
      operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
    }),
  });
  const cancel = vi.fn();
  const controller = new MathEditorController({ client,
    initial: { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
      source, notation: 'text', angleUnit: 'radian' },
    requestFor: input => ({ ...input, coefficients: [] }),
    isCurrentDocument: identity => identity.documentVersion === generation,
    canApply: output => output.evaluation.status === 'value' && output.evaluation.kind === 'real',
    onApply: output => { applied.push(output); }, onCancel: cancel, onMoveOut: () => undefined,
  });
  cleanup.push(() => controller.dispose());
  async function reply(index: number) {
    const item = sent[index];
    if (item === undefined) throw new Error('Expected an actual queued request');
    item.port.onmessage?.({ data: executeMathWorkRequest(item.value, backend) });
    await vi.advanceTimersByTimeAsync(0);
  }
  return { controller, sent, terminated, applied, cancel, reply, changeGeneration: () => { generation += 1; } };
}
describe('数式画面の確定・変換・文書世代を1つの制御に接続する', () => {
  it('確定操作は現在の入力の検証済み原式を返す', async () => {
    const state = fixture();
    state.controller.apply();
    await state.reply(0);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0].definition?.source).toBe('1/3');
    expect(state.applied[0].evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 1/3 });
  });
  it('書き換える前の確定要求と返信で新しい式を確定しない', async () => {
    const state = fixture();
    state.controller.apply();
    state.controller.sourceChanged('2');
    await state.reply(0);
    expect(state.applied).toHaveLength(0);
    expect(state.terminated).toHaveLength(1);
    state.controller.apply();
    await state.reply(1);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0].definition?.source).toBe('2');
  });
  it('変換中に別の文書世代へ移ったら元の入力を保持する', async () => {
    const state = fixture();
    state.controller.requestNotation('latex');
    state.changeGeneration();
    state.controller.refresh({ documentId: 'part', documentVersion: 2, editorId: 'X' });
    await state.reply(0);
    expect(state.controller.current()).toMatchObject({ source: '1/3', notation: 'text' });
    expect(state.applied).toHaveLength(0);
  });
  it('構造入力への切替はWorkerの検証済み表示だけを採用する', async () => {
    const state = fixture();
    state.controller.requestNotation('latex');
    await state.reply(0);
    expect(state.controller.current().notation).toBe('latex');
    expect(state.controller.current().source).toContain('frac');
    expect(state.applied).toHaveLength(0);
  });
  it('閉じた画面の計算を終了し、遅い返信や再度の確定を無視する', async () => {
    const state = fixture();
    state.controller.apply();
    state.controller.cancel();
    await state.reply(0);
    state.controller.apply();
    expect(state.terminated).toHaveLength(1);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.applied).toHaveLength(0);
  });
  it.each([
    'component(linearsolve([[2,1],[1,-1]],[5,1]),1)',
    'component(qrq([[3,0],[4,5]]),1,1)',
    '( 1 / 3 )',
  ])('表示だけを往復しても原式%sの綴り・括弧・空白を保持し、確定時に再検証する', async source => {
    const state = fixture(source);
    state.controller.requestNotation('latex');
    await state.reply(0);
    expect(state.controller.current().notation).toBe('latex');
    const structured = state.controller.current().source;
    for (let i = 0; i < 3; i++) {
      state.controller.requestNotation('text');
      expect(state.controller.current()).toMatchObject({ source, notation: 'text' });
      state.controller.requestNotation('latex');
      expect(state.controller.current()).toMatchObject({ source: structured, notation: 'latex' });
    }
    state.controller.requestNotation('text');
    expect(state.applied).toHaveLength(0);
    state.controller.apply();
    await state.reply(state.sent.length - 1);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0].definition?.source).toBe(source);
    expect(state.applied[0].evaluation).toMatchObject({ status: 'value', kind: 'real' });
  });
  it('構造入力を編集した後は古い原式を復活させず、新しい式を変換して確定する', async () => {
    const state = fixture();
    state.controller.requestNotation('latex'); await state.reply(0);
    state.controller.sourceChanged('\\frac{7}{2}');
    state.controller.requestNotation('text'); await state.reply(state.sent.length - 1);
    expect(state.controller.current().notation).toBe('text');
    expect(state.controller.current().source).not.toBe('1/3');
    state.controller.apply(); await state.reply(state.sent.length - 1);
    expect(state.applied[0].evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3.5 });
  });
  it.each(['angle', 'document'] as const)('%sの変更後は以前の表示変換を使い回さない', async change => {
    const state = fixture();
    state.controller.requestNotation('latex'); await state.reply(0);
    if (change === 'angle') state.controller.changeAngleUnit('degree');
    else {
      state.changeGeneration();
      state.controller.refresh({ documentId: 'part', documentVersion: 2, editorId: 'X' });
    }
    const before = state.sent.length;
    state.controller.requestNotation('text');
    expect(state.sent).toHaveLength(before + 1);
    await state.reply(before);
    expect(state.controller.current().notation).toBe('text');
    if (change === 'angle') expect(state.controller.current().angleUnit).toBe('degree');
    else expect(state.controller.current().identity.documentVersion).toBe(2);
  });
});
