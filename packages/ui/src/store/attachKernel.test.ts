/** 再計算の予約が古い計算を早く止めることの回帰テスト(R-7b、NFR-PF-4)。 */

import { plainText } from '@pointercad/model';
import { failureMessage } from '../i18n/failureMessage.js';
import { partErrorMessage } from '../solid/surfaceBodyFailureText.js';
import {
  appendSolid,
  createAssemblyDocument,
  createDirectKernelBridge,
  createEmptyPartDocument,
  createPrimitiveFeature,
  KERNEL_BROKEN_MESSAGE,
  recomputePart,
} from '@pointercad/model';
import type { SolidFailureReason } from '@pointercad/model';
import { createAutoSaver, createMemoryAutoSaveStorage, readPcadFile } from '@pointercad/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSketchCanvas } from '../file/canvasFile.js';
import { attachAutoSave } from '../file/attachAutoSave.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { attachPartRecompute, currentPcadAttachments } from './attachKernel.js';
import {
  bodyFor,
  createFakeRecompute,
  documentWithPoint,
  partWithThreeSolids,
  resetTestStore,
  resultFor,
  tick,
} from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/** 段階の計算の失敗の符号と、店へ入る文(文言の表の文を写さずに書く。直す前は符号の文字のまま入っていた)。 */
const STAGED_FAILURE_TEXTS: readonly (readonly [SolidFailureReason, string])[] = [
  ['thicken-failed', '閉じた立体を作れませんでした。厚さや厚みを付ける側を見直してください。'],
  // 面による切断と辺からの距離の穴は、0b-2b で計算部の表から文言の表へ移した(ヘルプ cut.md・hole.md に載る文)。
  ['no-intersection', '切断面が対象に届いていません。位置と範囲を見直してください。'],
  ['outside', '辺からの距離の位置が選択面の内側にありません。'],
  ['parallel', '辺からの距離には平行でない2本の辺を選んでください。'],
];

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
      errors: [{ featureId: 'solid-1', code: 'kernelFailed', text: plainText('ソリッドを作れませんでした') }],
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
      errors: [{ featureId: 'solid-1', code: 'workerBroken', text: plainText(KERNEL_BROKEN_MESSAGE) }],
    });
    await tick();

    const state = useAppStore.getState();
    expect(state.completedGeneration).toBe(1);
    expect(state.lastOutcome).toBe('workerBroken');
    detach();
  });

  it('面・投影・ずらしだけが Worker 破損の符号で失敗しても workerBroken になる(0b-1b。前は文の頭に操作名が付き、当たらなかった)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      errors: [{ featureId: 'face-1', code: 'workerBroken', text: plainText(`面を作れませんでした: ${KERNEL_BROKEN_MESSAGE}`) }],
    });
    await tick();

    expect(useAppStore.getState().lastOutcome).toBe('workerBroken');
    detach();
  });

  it('文が Worker 破損の文と同じでも、符号が無ければ workerBroken にしない(0b-1b。文では見分けない)', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle({
      ...resultFor(fake.calls[0].document),
      errors: [{ featureId: 'solid-1', code: 'kernelFailed', text: plainText(KERNEL_BROKEN_MESSAGE) }],
    });
    await tick();

    expect(useAppStore.getState().lastOutcome).toBe('failed');
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

describe('カーネル(OCCT)の読み込みの失敗の頼み直し(FR-504、NFR-RE-1)', () => {
  /** kernel/src/occtLoadError.ts の OCCT_LOAD_ERROR_NAME と同じ値。ずれるとこの検査で頼み直しが起きない。 */
  const LOAD_FAILURE_NAME = 'OcctLoadError';
  const LOAD_FAILURE_TEXT = '形の計算の機能を読み込めませんでした: TypeError: fetch failed';
  type Answer = 'load-failure' | 'runtime-error' | 'success';

  function unused(): never { throw new Error('Unused operation in load retry fixture'); }

  /** 実物の橋・変換・recomputePart・ストアを通し、Worker の窓口の返事だけを順に差し替える。 */
  function attachWithAnswers(answers: readonly Answer[], beforeAnswer: () => void = () => undefined) {
    const empty = createEmptyPartDocument();
    useAppStore.getState().applyDocument(appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), id: 'box-1' }));
    const generations: (number | undefined)[] = [];
    const bridge = createDirectKernelBridge({
      readCachedBodies: unused, functionSketchCurves: unused, tessellateSketch: unused,
      offsetSketchCurves: unused, projectSketchCurves: unused, sectionSketchCurves: unused,
      hiddenLineViews: unused, sectionViews: unused, measure: unused, exportShapes: unused,
      importShape: unused, inspectImportedBrep: unused, inspectPrintability: unused, recognizeSheetMetal: unused,
      recomputeSolids(request) {
        generations.push(request.generation);
        beforeAnswer();
        const answer = answers[generations.length - 1];
        if (answer === 'load-failure') return Promise.reject(Object.assign(new Error(LOAD_FAILURE_TEXT), { name: LOAD_FAILURE_NAME }));
        if (answer !== 'success') return Promise.reject(new RangeError('unreachable'));
        const localMesh = request.localMesh;
        if (localMesh === undefined) throw new Error('Missing production local mesh policy');
        const body = bodyFor('box-1'), mesh = body.mesh;
        const bytes = mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength;
        return Promise.resolve({ bodies: [{ id: 'box-1', positions: mesh.positions, normals: mesh.normals,
          indices: mesh.indices, edgePositions: mesh.edgePositions, triangleCount: mesh.triangleCount,
          faceCount: 0, edgeCount: 0, volume: body.volume, bodyKind: 'solid' as const,
          faces: [], edges: [], vertices: [], threadMarks: [],
          coordinateFrame: { space: 'local' as const, origin: [0, 0, 0] as const, ...localMesh } }],
          failures: [], cacheHits: 0, cancelled: false,
          meshJsAccounting: { status: 'known' as const, limitBytes: localMesh.maximumLiveMeshBytes,
            cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
            retainedReplyBytes: bytes * 2, requestPeakReservedBytes: bytes * 2 },
          meshJsFinalAccounting: { status: 'known' as const, limitBytes: localMesh.maximumLiveMeshBytes,
            cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
            hiddenBackingBytes: 0, displayBackingBytes: bytes, replyBackingBytes: bytes, retainedBackingBytes: bytes, replyCloneReservedBytes: bytes },
        });
      },
    });
    const detach = attachPartRecompute((document, options) => recomputePart(document, bridge, options));
    return { generations, finish: () => { detach(); bridge.dispose(); } };
  }

  it('1 回目の読み込みの失敗は同じ世代で 1 回だけ頼み直し、2 回目の成功で success として完了する', async () => {
    const attached = attachWithAnswers(['load-failure', 'success']);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().lastOutcome).toBe('success'));
      const state = useAppStore.getState();
      expect(attached.generations).toEqual([1, 1]);
      expect(state.completedGeneration).toBe(1);
      expect(state.partErrors).toEqual([]);
      expect(state.bodies.map(body => body.featureId)).toEqual(['box-1']);
    } finally { attached.finish(); }
  });

  it('読み込み以外の Worker の例外は頼み直さず、種類と文を残して failed として完了する', async () => {
    const attached = attachWithAnswers(['runtime-error', 'success']);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().lastOutcome).toBe('failed'));
      expect(attached.generations).toEqual([1]);
      expect(useAppStore.getState().partErrors.map(partErrorMessage))
        .toEqual(['ソリッドを作れませんでした: RangeError: unreachable']);
    } finally { attached.finish(); }
  });

  it('2 回とも読み込めなければ failed として完了し、理由と頼み直した事実が失敗の文に残る', async () => {
    const attached = attachWithAnswers(['load-failure', 'load-failure', 'success']);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().lastOutcome).toBe('failed'));
      expect(attached.generations).toEqual([1, 1]);
      expect(useAppStore.getState().partErrors.map(partErrorMessage))
        .toEqual([`ソリッドを作れませんでした: ${LOAD_FAILURE_TEXT}(読み込みを1回やり直しました)`]);
    } finally { attached.finish(); }
  });

  it('利用者が中止した後の読み込みの失敗は頼み直さず cancelled として完了する', async () => {
    const attached = attachWithAnswers(['load-failure', 'success'], () => { useAppStore.getState().cancelRecompute(); });
    try {
      await vi.waitFor(() => expect(useAppStore.getState().lastOutcome).toBe('cancelled'));
      expect(attached.generations).toEqual([1]);
    } finally { attached.finish(); }
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

describe('段階の計算の失敗の文(0b-2a)', () => {
  // 計算部は面だけのボディ・面による切断・辺からの距離の穴の断りを符号で返す。画面(数を入れる窓・状態の欄・複数面の押し出し)は
  // 店の stagedSolid.errors の文をそのまま出すので、店へ入る時に文言の表の文(ヘルプの cut.md・hole.md・surface-body.md に載る文)になっている事を見る。
  it.each(STAGED_FAILURE_TEXTS)('符号 %s は「%s」で店へ入る', async (reason, text) => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      fake.calls[0].settle(resultFor(fake.calls[0].document));
      await tick();
      useAppStore.setState({ numericInput: createNumericInput('extrude', 'extrudeDistance') });
      const state = useAppStore.getState();
      const featureId = state.document.solids[0].id;
      expect(state.partStager?.stage({ base: state.document, candidate: state.document, finalFeatureId: featureId,
        fingerprint: `failed-${reason}` })).not.toBeNull();
      const call = fake.calls[1];
      call.settle({ ...resultFor(call.document), generation: call.options.generation ?? 0,
        errors: [{ featureId, code: 'kernelFailed', text: plainText(reason), reason }] });
      await tick();
      const staged = useAppStore.getState().stagedSolid;
      expect(staged?.status).toBe('failed');
      expect(staged?.errors.map(error => failureMessage(error.text))).toEqual([text]);
    } finally { detach(); }
  });
});
