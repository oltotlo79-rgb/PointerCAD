/** 再計算の予約が古い計算を早く止めることの回帰テスト(R-7b、NFR-PF-4)。 */

import { createAssemblyDocument, KERNEL_BROKEN_MESSAGE } from '@pointercad/model';
import { createAutoSaver, createMemoryAutoSaveStorage, readPcadFile } from '@pointercad/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSketchCanvas } from '../file/canvasFile.js';
import { attachAutoSave } from '../file/attachAutoSave.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { attachPartRecompute, currentPcadAttachments } from './attachKernel.js';
import {
  createFakeRecompute,
  documentWithPoint,
  partWithThreeSolids,
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

describe('下絵の保存スナップショットと復元用保存', () => {
  function addImage() {
    const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
    const bytes = Uint8Array.of(1, 2, 3);
    useAppStore.getState().addCanvas(canvas, bytes);
    return { canvas, bytes };
  }

  it('指定した保存文書の参照を使い、現在の削除状態と保存の対象を混同しない', () => {
    const { canvas, bytes } = addImage();
    const snapshot = useAppStore.getState().document;
    useAppStore.getState().removeCanvas(canvas.id);
    expect(currentPcadAttachments().canvases.size).toBe(0);
    expect(currentPcadAttachments(snapshot).canvases.get(canvas.imageId)).toBe(bytes);
    useAppStore.getState().undo();
    expect(currentPcadAttachments().canvases.get(canvas.imageId)).toBe(bytes);
  });

  it('実ストアから復元用ZIPを作る経路でも削除資産を除き、Undoで元画像が戻る', async () => {
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: '編集中の部品' });
    const storage = createMemoryAutoSaveStorage();
    let timer: (() => void) | undefined;
    const saver = createAutoSaver({ storage,
      setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; } });
    const detach = attachAutoSave({ saver, bundleParts: true, visibility: null });
    try {
      const { canvas, bytes } = addImage();
      useAppStore.getState().removeCanvas(canvas.id);
      timer?.();
      await vi.waitFor(async () => { expect(await storage.listRecords()).toHaveLength(1); });
      const deletedZip = (await storage.listRecords())[0].bytes;
      const deleted = readPcadFile(deletedZip);
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) throw new Error('Recovery could not be read');
      expect(deleted.attachments.canvases.size).toBe(0);
      expect(Buffer.from(deletedZip).includes(Buffer.from('canvases/canvas-1.png'))).toBe(false);
      useAppStore.getState().undo(); timer?.();
      await vi.waitFor(async () => {
        const restored = readPcadFile((await storage.listRecords())[0].bytes);
        expect(restored.ok).toBe(true);
        if (!restored.ok) throw new Error('Restored recovery could not be read');
        expect(restored.attachments.canvases.get(canvas.imageId)).toEqual(bytes);
      });
    } finally { detach(); saver.stop(); }
  });
});

describe('新しい文書による実行中の再計算の取消(R-7b、NFR-PF-4)', () => {
  it('通常の最初の計算と編集後の計算へ局所原点と512MiBの上限を渡す', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      expect(fake.calls[0].options.localMesh).toEqual({
        maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024,
      });
      useAppStore.getState().setSketch(documentWithPoint());
      expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
      fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
      await tick();
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1].options.localMesh).toEqual(fake.calls[0].options.localMesh);
      expect(fake.calls[1].options.localMesh).not.toBe(fake.calls[0].options.localMesh);
      expect(fake.calls[1].options.generation).toBe(2);
      expect(fake.calls[1].options.shouldCancel?.()).toBe(false);
    } finally { detach(); }
  });

  it('requests local mesh for both prefix and end views and cancels the previous view', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      expect(useAppStore.getState().timelineIndex).toBe(0);
      expect(fake.calls[0].document.solids).toHaveLength(1);
      expect(fake.calls[0].options.localMesh).toEqual({
        maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024,
      });
      useAppStore.getState().setTimelineIndex(null);
      expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
      fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cancelled: true });
      await tick();
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1].document.solids).toHaveLength(3);
      expect(fake.calls[1].options.localMesh).toEqual({
        maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024,
      });
    } finally { detach(); }
  });

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

it('forwards current mesh attachments and discards a reply after attachment replacement', async () => {
  const first = new Map(useAppStore.getState().importedMeshes);
  useAppStore.setState({ importedMeshes: first });
  const fake = createFakeRecompute();
  const detach = attachPartRecompute(fake.recompute);
  try {
    expect(fake.calls[0].options.importedMeshes).toBe(first);
    const second = new Map(first);
    useAppStore.setState({ importedMeshes: second });
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), cacheHits: 987 });
    await tick();
    expect(useAppStore.getState().cacheHits).not.toBe(987);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.importedMeshes).toBe(second);
    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), generation: fake.calls[1].options.generation ?? 0 });
    await tick();
    expect(useAppStore.getState().lastOutcome).toBe('success');
  } finally { detach(); }
});

it('passes the owned mesh table to staged work and cancels it after replacement', async () => {
  useAppStore.getState().applyDocument(partWithThreeSolids());
  const fake = createFakeRecompute();
  const detach = attachPartRecompute(fake.recompute);
  try {
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    useAppStore.setState({ numericInput: createNumericInput('extrude', 'extrudeDistance') });
    const state = useAppStore.getState();
    const staged = state.partStager?.stage({ base: state.document, candidate: state.document,
      finalFeatureId: state.document.solids[0].id, fingerprint: 'mesh-table' });
    expect(staged).not.toBeNull();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.importedMeshes).toBe(state.importedMeshes);
    useAppStore.setState({ importedMeshes: new Map(state.importedMeshes) });
    expect(fake.calls[1].options.shouldCancel?.()).toBe(true);
    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), cancelled: true });
    await tick();
    expect(useAppStore.getState().stagedSolid?.status).not.toBe('ready');
  } finally { detach(); }
});
