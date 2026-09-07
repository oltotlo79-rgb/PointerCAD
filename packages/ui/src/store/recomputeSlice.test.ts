/** 再計算・進捗。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPointFeature,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  attachPartRecompute,
} from './attachKernel.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  createFakeRecompute,
  resultFor,
  tick,
  documentWithPoint,
  partWithPoint,
  extrudeFeature,
  bodyFor,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('文書の変化に応じた再計算の予約(要件§6.3)', () => {
  it('つないだ直後に今の文書を1回計算し、結果を反映する', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document).toBe(useAppStore.getState().document);
    expect(fake.calls[0].options.generation).toBe(1);

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().documentName).toBe('スケッチ1');
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('計算を1回終えると、幾何カーネルを読み込み終えたと記録する(§0.a-0.23 ⑨)', async () => {
    expect(useAppStore.getState().kernelLoaded).toBe(false);
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    expect(useAppStore.getState().kernelLoaded).toBe(true);
    detach();
  });

  it('文書が変わるたびに計算し、結果をストアへ入れる', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].document).toBe(useAppStore.getState().document);
    // 世代番号は依頼のたびに 1 つ増える(古い応答を捨てる目印、NFR-PF-4)。
    expect(fake.calls[1].options.generation).toBe(2);

    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toEqual(['点1']);
    expect(useAppStore.getState().resolvedSketch.points).toHaveLength(1);
    detach();
  });

  it('計算中に続けて変えても重ねず、最後の文書だけを次に回す(連続入力)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    const first = documentWithPoint();
    const second = appendFeature(first, createPointFeature(first, absoluteCoordinate(4, 5, 6)));
    const third = appendFeature(second, createPointFeature(second, absoluteCoordinate(7, 8, 9)));

    useAppStore.getState().setSketch(first);
    const started = useAppStore.getState().document;
    useAppStore.getState().setSketch(second);
    useAppStore.getState().setSketch(third);
    // 1 本目が終わるまでは次を始めない。
    expect(fake.calls).toHaveLength(2);

    fake.calls[1].settle(resultFor(started));
    await tick();

    // 間に挟まった second は捨て、最新の third だけを計算する。
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    expect(fake.calls[2].document.sketches[0]).toBe(third);
    // 途中の結果では計算中の札を下ろさない。
    expect(useAppStore.getState().isComputing).toBe(true);

    fake.calls[2].settle(resultFor(fake.calls[2].document));
    await tick();

    expect(useAppStore.getState().isComputing).toBe(false);
    expect(useAppStore.getState().featureNames).toHaveLength(3);
    detach();
  });

  it('外した後は文書が変わっても計算しない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    detach();

    useAppStore.getState().setSketch(documentWithPoint());
    await tick();
    expect(fake.calls).toHaveLength(1);
  });

  it('計算が投げたら理由を出して計算中を下ろす(FR-504)', async () => {
    const detach = attachPartRecompute(() => Promise.reject(new Error('計算できません')));
    await tick();
    expect(useAppStore.getState().errorMessage).toBe('計算できません');
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('ボディと失敗と命中数を反映し、進捗は下ろす(FR-504、NFR-PF-3)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 1,
      label: '押し出しextrude-1',
    });
    expect(useAppStore.getState().recomputeProgress).not.toBeNull();

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
      errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
      cacheHits: 3,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0].featureId).toBe('extrude-1');
    expect(state.partErrors).toHaveLength(1);
    expect(state.cacheHits).toBe(3);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
    // ソリッドの失敗はスケッチの控えへ混ぜない(要素 id が違う)。
    expect(state.sketchErrors).toEqual([]);
  });

  it('スケッチの失敗はいま編集しているスケッチの控えへ写す(FR-504)', () => {
    const document = partWithPoint();
    const featureId = document.sketches[0].features[0].id;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      errors: [{ featureId, code: 'kernelFailed', message: '面を作れませんでした: 失敗' }],
    });

    const state = useAppStore.getState();
    expect(state.sketchErrors).toHaveLength(1);
    expect(state.sketchErrors[0].featureId).toBe(featureId);
    expect(state.sketchErrors[0].code).toBe('kernelFailed');
    expect(state.partErrors).toHaveLength(1);
  });
});

describe('進捗と中止(NFR-PF-4、§0.a-0.22)', () => {
  it('計算中の進み具合を受け取って持つ', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    fake.calls[0].options.onProgress?.({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });
    expect(useAppStore.getState().recomputeProgress).toEqual({
      featureId: 'extrude-1',
      index: 2,
      total: 5,
      label: '押し出し1',
    });

    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(useAppStore.getState().recomputeProgress).toBeNull();
    detach();
  });

  it('中止を頼むと、いま走っている計算の shouldCancel が立つ', () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    const shouldCancel = fake.calls[0].options.shouldCancel;
    expect(shouldCancel?.()).toBe(false);
    useAppStore.getState().cancelRecompute();
    expect(shouldCancel?.()).toBe(true);
    detach();
  });

  it('次に始まる計算は前の中止を引きずらない', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    useAppStore.getState().cancelRecompute();
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);

    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
    await tick();
    useAppStore.getState().setSketch(documentWithPoint());

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.shouldCancel?.()).toBe(false);
    detach();
  });

  it('中止された結果では前のボディを消さない(半分だけの形を出さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [bodyFor('extrude-1')],
    });
    expect(useAppStore.getState().bodies).toHaveLength(1);

    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      bodies: [],
      cancelled: true,
    });

    const state = useAppStore.getState();
    expect(state.bodies).toHaveLength(1);
    expect(state.isComputing).toBe(false);
    expect(state.recomputeProgress).toBeNull();
  });

  it('中止を頼んでいないときは何も起きない(例外にならない)', () => {
    useAppStore.getState().cancelRecompute();
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('起動直後は中止の知らせを持たない(タスク25)', () => {
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('中止で終わると知らせが立ち、進捗は下りる(NFR-PF-4、タスク25)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setRecomputeProgress({
      featureId: 'extrude-1',
      index: 0,
      total: 3,
      label: '押し出し1',
    });

    useAppStore
      .getState()
      .applyRecompute(document, { ...resultFor(document), cancelled: true });

    const state = useAppStore.getState();
    expect(state.recomputeCancelled).toBe(true);
    expect(state.recomputeProgress).toBeNull();
    // 中止は失敗ではないので、赤い帯になる errorMessage は立てない。
    expect(state.errorMessage).toBeNull();
  });

  it('最後まで走った計算が終わると中止の知らせは下りる', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().applyRecompute(document, resultFor(document));
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('文書が変わると中止の知らせは消える(時間では消さない)', () => {
    const document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().setSketch(documentWithPoint());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });

  it('元に戻す・やり直す・新しくやり直すでも中止の知らせは消える', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const document = useAppStore.getState().document;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      cancelled: true,
    });
    expect(useAppStore.getState().recomputeCancelled).toBe(true);

    useAppStore.getState().undo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().redo();
    expect(useAppStore.getState().recomputeCancelled).toBe(false);

    useAppStore.getState().applyRecompute(useAppStore.getState().document, {
      ...resultFor(useAppStore.getState().document),
      cancelled: true,
    });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().recomputeCancelled).toBe(false);
  });
});
