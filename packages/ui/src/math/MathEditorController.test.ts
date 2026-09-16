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
import { mathEditorResultText } from './mathEditorResult.js';
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
  it.each(['source', 'angle', 'document', 'close'] as const)('準備中の%s変更で古い計算を終了し、遅い通知を現在の表示へ戻さない', change => {
    const state = fixture(); state.controller.apply();
    const input = state.controller.current(), port = state.sent[0].port, late = port.onmessage;
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'runtime-loading' } });
    expect(state.controller.getSnapshot().phase).toBe('runtime-loading');
    expect(mathEditorResultText(state.controller.getSnapshot())).toMatchObject({ busy: true, hasError: false });
    expect(mathEditorResultText(state.controller.getSnapshot()).message).toContain('準備');
    if (change === 'source') state.controller.sourceChanged('2');
    else if (change === 'angle') state.controller.changeAngleUnit('degree');
    else if (change === 'document') {
      state.changeGeneration(); state.controller.refresh({ documentId: 'part', documentVersion: 2, editorId: 'X' });
    } else state.controller.cancel();
    const snapshot = state.controller.getSnapshot();
    late?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'calculating' } });
    expect(state.controller.getSnapshot()).toBe(snapshot); expect(state.terminated).toHaveLength(1);
    if (change !== 'close') expect(snapshot.phase).toBeNull(); expect(state.applied).toHaveLength(0);
  });
  it('表示方式の変換中にも準備を知らせ、入力変更で計算と準備表示を取り消す', () => {
    const state = fixture(); state.controller.requestNotation('latex');
    const input = state.controller.current(), port = state.sent[0].port;
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'symbolic-import' } });
    expect(state.controller.getSnapshot().phase).toBe('symbolic-import');
    state.controller.sourceChanged('2'); expect(state.controller.getSnapshot().phase).toBeNull();
    expect(state.controller.current().notation).toBe('text'); expect(state.terminated).toHaveLength(1);
  });
  it('長い表示変換の準備中に同じ入力を二重計算せず、終わった新しい表示だけを再計算する', async () => {
    const state = fixture(); state.controller.requestNotation('latex');
    const input = state.controller.current(), port = state.sent[0].port;
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'runtime-loading' } });
    await vi.advanceTimersByTimeAsync(20_000); state.controller.apply();
    expect(state.sent).toHaveLength(1); expect(state.controller.getSnapshot().phase).toBe('runtime-loading');
    expect(state.terminated).toHaveLength(0); expect(state.applied).toHaveLength(0);
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'calculating' } });
    await state.reply(0); await vi.advanceTimersByTimeAsync(120);
    expect(state.controller.current().notation).toBe('latex'); expect(state.sent).toHaveLength(2);
  });
  it('記号挿入の長い表示変換も二重計算せず、変換した入力へ一度だけ挿入する', async () => {
    const state = fixture(), insert = vi.fn(() => true);
    state.controller.insert('\\pi');
    const input = state.controller.current(), port = state.sent[0].port;
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'runtime-loading' } });
    await vi.advanceTimersByTimeAsync(20_000); state.controller.apply();
    expect(state.sent).toHaveLength(1); expect(state.controller.getSnapshot().phase).toBe('runtime-loading');
    expect(state.terminated).toHaveLength(0); expect(state.applied).toHaveLength(0);
    port.onmessage?.({ data: { kind: 'math-phase', serial: 1, identity: input.identity, phase: 'calculating' } });
    await state.reply(0);
    expect(state.controller.current().notation).toBe('latex');
    state.controller.bindInsertion(insert);
    expect(insert).toHaveBeenCalledExactlyOnceWith('\\pi');
    await vi.advanceTimersByTimeAsync(120); expect(state.sent).toHaveLength(2);
  });
  it('記号挿入を取り消した後始末が、新しい入力の準備表示を消さない', async () => {
    const state = fixture(); state.controller.insert('\\pi');
    state.controller.sourceChanged('2'); state.controller.apply();
    const item = state.sent[1];
    item.port.onmessage?.({ data: { kind: 'math-phase', serial: 2, identity: state.controller.current().identity, phase: 'runtime-loading' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.controller.getSnapshot().phase).toBe('runtime-loading');
    expect(state.controller.current()).toMatchObject({ source: '2', notation: 'text' });
    expect(state.terminated).toHaveLength(1); expect(state.applied).toHaveLength(0);
  });
  it('配列の成分選択は原式を保持して再計算し、座標の確定を勝手に行わない', async () => {
    const state = fixture('tensorproduct([1,2],[3,4])');
    state.controller.apply(); await state.reply(0);
    expect(state.controller.getSnapshot().state).toMatchObject({ status: 'evaluated', canApply: false });
    const before = state.controller.current();
    expect(state.controller.chooseResultComponent(before, [2])).toBe(false);
    expect(state.controller.current()).toEqual(before);
    expect(state.controller.chooseResultComponent(before, [2,1])).toBe(true);
    expect(state.controller.current().source).toBe('tensorelement(tensorproduct([1,2],[3,4]),[2,1])');
    expect(state.applied).toHaveLength(0);
    expect(state.controller.chooseResultComponent(before, [1,1])).toBe(false);
    state.controller.apply(); await state.reply(state.sent.length - 1);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0].definition?.source).toBe(state.controller.current().source);
    expect(state.applied[0].evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 6 });
  });
  it.each(['source','angle','document','close'] as const)('%s変更前の配列の成分選択で現在の入力を書き換えない', async change => {
    const state = fixture('tensorproduct([1,2],[3,4])');
    state.controller.apply(); await state.reply(0);
    const before = state.controller.current();
    if (change === 'source') state.controller.sourceChanged('[8,9]');
    else if (change === 'angle') state.controller.changeAngleUnit('degree');
    else if (change === 'document') state.changeGeneration();
    else state.controller.cancel();
    const current = state.controller.current();
    expect(state.controller.chooseResultComponent(before, [2,1])).toBe(false);
    expect(state.controller.current()).toEqual(current);
    expect(state.applied).toHaveLength(0);
  });
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
