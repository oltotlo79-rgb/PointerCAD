/**
 * 下絵の読み込み(`addCanvasFromFile`)で、画像を選ぶ・復号する間に文書が変わったときの
 * 採用判定の回帰検査(docs/review-2026-09-28-codex.md R01・§6.1 の1 と同じ型)。
 *
 * 画像を選ぶ窓(DOM の input)と復号(`createImageBitmap`)はこの環境に無いので、その 2 つだけを
 * 手で返す口に差し替える。下絵の置き方(`newSketchCanvas`)とストアは実物を使う。
 */

import { createEmptyPartDocument } from '@pointercad/model';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecodedCanvasImage, PickedCanvasImage } from '../../file/canvasFile.js';
import { t } from '../../i18n/t.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { currentPcadAttachments } from '../../store/attachKernel.js';
import { createCanvasImageCache } from '../../viewport/createCanvasImageCache.js';
import { addCanvasFromFile } from './lookToolActions.js';

const dom = vi.hoisted(() => ({
  picks: [] as { resolve: (value: PickedCanvasImage | null) => void }[],
  decodes: [] as { resolve: (value: DecodedCanvasImage) => void }[],
}));

vi.mock('../../file/canvasFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../file/canvasFile.js')>();
  return {
    ...actual,
    pickCanvasImage: () => new Promise<PickedCanvasImage | null>((resolve) => { dom.picks.push({ resolve }); }),
    decodeCanvasImage: () => new Promise<DecodedCanvasImage>((resolve) => { dom.decodes.push({ resolve }); }),
  };
});

/** PNG の先頭 8 バイト(形式の判定に使う署名)と中身の 1 バイト。 */
const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);

beforeEach(() => {
  resetTestStore();
  dom.picks.length = 0;
  dom.decodes.length = 0;
});

async function pickAndReachDecode(index: number, fileName = 'under.png'): Promise<void> {
  await vi.waitFor(() => { expect(dom.picks.length).toBeGreaterThan(index); });
  dom.picks[index]?.resolve({ fileName, bytes: PNG_BYTES });
  await vi.waitFor(() => { expect(dom.decodes.length).toBeGreaterThan(index); });
}

function renamePart(name: string): void {
  const state = useAppStore.getState();
  state.applyDocument({ ...state.document, name }, { coalesceKey: 'name' });
}

describe('下絵を読み込む間の文書の変化', () => {
  it('表示キャッシュが復号中でも追加前に確認した画素で寸法合わせを始める', async () => {
    const cache = createCanvasImageCache({
      readSource: () => {
        const state = useAppStore.getState();
        return { documentId: state.activeDocumentId, canvases: state.document.canvases,
          images: state.canvases, retries: state.canvasImageRetries };
      },
      publish: () => undefined,
      setLoad: (id, owner, load) => { useAppStore.getState().setCanvasImageLoad(id, owner, load); },
      reportInvalid: message => { throw new Error(message); },
    });
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.document !== previous.document || next.canvases !== previous.canvases) cache.sync();
    });
    try {
      const adding = addCanvasFromFile(); await pickAndReachDecode(0);
      // Closing a real ImageBitmap sets its dimensions to zero.
      const decoded = { width: 200, height: 100, close: vi.fn(() => { decoded.width = 0; decoded.height = 0; }) };
      dom.decodes[0].resolve(decoded); await adding;
      expect(dom.decodes).toHaveLength(2);
      const state = useAppStore.getState(), canvas = state.document.canvases[0];
      expect(state.canvasScale?.canvasId).toBe(canvas.id);
      expect(state.canvasPixelSizes.get(canvas.imageId)).toEqual({ width: 200, height: 100 });
      expect(state.canvasImageLoads.get(canvas.imageId)?.status).toBe('ready');
      expect(decoded.close).toHaveBeenCalledTimes(1);
      const displayed = { width: 200, height: 100, close: vi.fn() };
      dom.decodes[1].resolve(displayed); await Promise.resolve();
      expect(useAppStore.getState().canvasScale?.canvasId).toBe(canvas.id);
      expect(useAppStore.getState().document).toBe(state.document);
      expect(useAppStore.getState().undoStack).toBe(state.undoStack);
      cache.dispose(); expect(displayed.close).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); cache.dispose(); }
  });

  it.each([0, 1])('既存 %i 枚に続く最大番号を削除して追加しても Undo・Redo・保存で画像を取り違えない', async (retainedCount) => {
    const originalBytes = PNG_BYTES.slice();
    const replacementBytes = PNG_BYTES.slice();
    replacementBytes[replacementBytes.length - 1] = 99;
    async function add(index: number, name: string, bytes: Uint8Array, width: number): Promise<void> {
      const adding = addCanvasFromFile();
      dom.picks[index]?.resolve({ fileName: name, bytes });
      await vi.waitFor(() => { expect(dom.decodes).toHaveLength(index + 1); });
      dom.decodes[index]?.resolve({ width, height: 100 });
      await adding;
    }
    if (retainedCount > 0) await add(0, '残す下絵.png', PNG_BYTES.slice(), 100);
    const retained = useAppStore.getState().document.canvases;
    await add(retainedCount, 'A.png', originalBytes, 200);
    const original = useAppStore.getState().document.canvases[retainedCount];
    useAppStore.getState().removeCanvas(original.id);
    await add(retainedCount + 1, 'B.png', replacementBytes, 300);
    const replacement = useAppStore.getState().document.canvases[retainedCount];
    expect(replacement.id).toBe(original.id);
    useAppStore.getState().undo();
    useAppStore.getState().undo();
    const restored = useAppStore.getState();
    expect(restored.document.canvases).toEqual([...retained, original]);
    expect(restored.canvases.get(original.imageId)).toEqual(originalBytes);
    expect(replacement.imageId).not.toBe(original.imageId);
    const read = readPcadFile(writePcadFile(restored.document, { attachments: currentPcadAttachments() }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Part round trip failed');
    expect(read.attachments.canvases.get(original.imageId)).toEqual(originalBytes);
    expect(read.attachments.canvases.size).toBe(retainedCount + 1);
    useAppStore.getState().redo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.canvases).toEqual([...retained, replacement]);
    expect(useAppStore.getState().canvases.get(replacement.imageId)).toEqual(replacementBytes);
    expect(useAppStore.getState().canvases.get(original.imageId)).toEqual(originalBytes);
  });

  it('何も変わらなければ、いまの作図面へ貼って寸法合わせを始める', async () => {
    const adding = addCanvasFromFile();
    await pickAndReachDecode(0);
    dom.decodes[0]?.resolve({ width: 200, height: 100 });
    await adding;
    const after = useAppStore.getState();
    expect(after.document.canvases).toHaveLength(1);
    expect(after.canvases.size).toBe(1);
    expect(after.canvasScale).not.toBeNull();
    expect(after.canvasMessage).toBeNull();
  });

  it('画像を選ぶ間に別の文書へ切り替えたら、切り替えた先へ貼らずに理由を出す', async () => {
    const adding = addCanvasFromFile();
    await vi.waitFor(() => { expect(dom.picks).toHaveLength(1); });
    useAppStore.getState().resetDocument({ ...createEmptyPartDocument(), id: 'switched', name: 'B' });
    const switched = useAppStore.getState();
    await pickAndReachDecode(0);
    dom.decodes[0]?.resolve({ width: 200, height: 100 });
    await adding;
    const after = useAppStore.getState();
    expect(after.document).toBe(switched.document);
    expect(after.undoStack).toBe(switched.undoStack);
    expect(after.canvases.size).toBe(0);
    expect(after.canvasScale).toBeNull();
    expect(after.canvasMessage).toBe(t('canvas.documentChanged'));
  });

  it('復号の間に同じ文書を(版の番号が増えない形で)編集したら貼らずに理由を出す', async () => {
    const adding = addCanvasFromFile();
    await pickAndReachDecode(0);
    const version = useAppStore.getState().documentVersion;
    renamePart('復号の間の編集');
    const edited = useAppStore.getState();
    expect(edited.documentVersion).toBe(version);
    dom.decodes[0]?.resolve({ width: 200, height: 100 });
    await adding;
    const after = useAppStore.getState();
    expect(after.document).toBe(edited.document);
    expect(after.undoStack).toBe(edited.undoStack);
    expect(after.canvases.size).toBe(0);
    expect(after.canvasMessage).toBe(t('canvas.documentChanged'));
  });

  it('続けて読み込み直したら、先の画像は黙って捨てて後の画像だけを貼る', async () => {
    const first = addCanvasFromFile();
    await pickAndReachDecode(0, 'first.png');
    const second = addCanvasFromFile();
    await pickAndReachDecode(1, 'second.png');
    dom.decodes[0]?.resolve({ width: 10, height: 10 });
    await first;
    expect(useAppStore.getState().canvases.size).toBe(0);
    expect(useAppStore.getState().canvasMessage).toBeNull();
    dom.decodes[1]?.resolve({ width: 20, height: 20 });
    await second;
    const after = useAppStore.getState();
    expect(after.document.canvases).toHaveLength(1);
    expect(after.document.canvases[0]?.name).toBe('second.png');
  });
});
