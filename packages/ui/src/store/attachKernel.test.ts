/** 再計算の予約が古い計算を早く止めることの回帰テスト(R-7b、NFR-PF-4)。 */

import { createAssemblyDocument, KERNEL_BROKEN_MESSAGE } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { attachPartRecompute } from './attachKernel.js';
import {
  createFakeRecompute,
  documentWithPoint,
  resetTestStore,
  resultFor,
  tick,
} from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({
    requestedGeneration: 0,
    completedGeneration: 0,
    lastOutcome: 'idle',
  });
});

describe('新しい文書による実行中の再計算の取消(R-7b、NFR-PF-4)', () => {
  it('アセンブリを開いている間は part の再計算を始めない', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('assembly'));
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    expect(fake.calls).toHaveLength(0);
    useAppStore.getState().closeAssembly();
    expect(fake.calls).toHaveLength(1);
    detach();
  });

  it('アセンブリへの切替前の part 応答を適用しない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    useAppStore.getState().openAssembly(createAssemblyDocument('assembly'));
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cacheHits: 100 });
    await tick();
    expect(useAppStore.getState().cacheHits).toBe(0);
    detach();
  });
  it('接続時の最初の依頼を requestedGeneration 1 として記録する', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    const state = useAppStore.getState();
    expect(state.requestedGeneration).toBe(1);
    expect(state.completedGeneration).toBe(0);
    expect(state.lastOutcome).toBe('idle');
    detach();
  });

  it('計算中に新しい文書を予約すると、実行中の shouldCancel が真になる', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    const runningShouldCancel = fake.calls[0].options.shouldCancel;

    expect(runningShouldCancel?.()).toBe(false);
    useAppStore.getState().setSketch(documentWithPoint());
    expect(runningShouldCancel?.()).toBe(true);
    detach();
  });

  it('予約した次の計算が始まると、その計算の shouldCancel は偽になる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    useAppStore.getState().setSketch(documentWithPoint());
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.shouldCancel?.()).toBe(false);
    detach();
  });

  it('利用者が中止を頼んだときは従来どおり shouldCancel が真になる', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    const shouldCancel = fake.calls[0].options.shouldCancel;

    expect(shouldCancel?.()).toBe(false);
    useAppStore.getState().cancelRecompute();
    expect(shouldCancel?.()).toBe(true);
    detach();
  });

  it('新しい文書で置き換えた取消は中止表示を出さず、新しい結果を適用する', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    useAppStore.getState().setSketch(documentWithPoint());
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();

    expect(useAppStore.getState().recomputeCancelled).toBe(false);
    expect(useAppStore.getState().requestedGeneration).toBe(2);
    expect(useAppStore.getState().completedGeneration).toBe(1);
    expect(useAppStore.getState().lastOutcome).toBe('cancelled');
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    const state = useAppStore.getState();
    expect(state.recomputeCancelled).toBe(false);
    expect(state.featureNames).toEqual(['点1']);
    expect(state.isComputing).toBe(false);
    detach();
  });

  it('通常のカーネル失敗は failed として完了する', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      errors: [{ featureId: 'solid-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
    });
    await tick();

    const state = useAppStore.getState();
    expect(state.completedGeneration).toBe(1);
    expect(state.lastOutcome).toBe('failed');
    detach();
  });

  it('Worker 破損の理由で終わった世代は workerBroken になる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      errors: [{ featureId: 'solid-1', code: 'kernelFailed', message: KERNEL_BROKEN_MESSAGE }],
    });
    await tick();

    const state = useAppStore.getState();
    expect(state.completedGeneration).toBe(1);
    expect(state.lastOutcome).toBe('workerBroken');
    detach();
  });

  it('予約も利用者の中止も無ければ shouldCancel は偽のまま', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    const shouldCancel = fake.calls[0].options.shouldCancel;

    expect(shouldCancel?.()).toBe(false);
    expect(shouldCancel?.()).toBe(false);
    detach();
  });
});
