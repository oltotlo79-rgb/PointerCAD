/**
 * 下絵の読み込み(`addCanvasFromFile`)で、画像を選ぶ・復号する間に文書が変わったときの
 * 採用判定の回帰検査(docs/review-2026-09-28-codex.md R01・§6.1 の1 と同じ型)。
 *
 * 画像を選ぶ窓(DOM の input)と復号(`createImageBitmap`)はこの環境に無いので、その 2 つだけを
 * 手で返す口に差し替える。下絵の置き方(`newSketchCanvas`)とストアは実物を使う。
 */

import { createEmptyPartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecodedCanvasImage, PickedCanvasImage } from '../../file/canvasFile.js';
import { t } from '../../i18n/t.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
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
