import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { newSketchCanvas } from '../file/canvasFile.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { canvasActionState, canvasOpacityValue, type CanvasImageLoad } from './canvasActionState.js';

beforeEach(resetTestStore);
const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 800, height: 400 }, 'canvas-1');
const bytes = Uint8Array.of(1, 2, 3);
const state = () => useAppStore.getState();

describe('下絵の操作を実ストアの最新状態で判定する', () => {
  it('消えた下絵・画像なし・読込中・失敗・使用可能を区別する', () => {
    expect(canvasActionState(state(), canvas.id).status).toBe('gone');
    state().applyDocument({ ...state().document, canvases: [canvas] });
    expect(canvasActionState(state(), canvas.id).status).toBe('missing');
    state().setCanvasImages(new Map([[canvas.imageId, bytes]]));
    expect(canvasActionState(state(), canvas.id).status).toBe('loading');
    const failed: CanvasImageLoad = { documentId: state().activeDocumentId, bytes, request: {}, status: 'failed' };
    state().setCanvasImageLoad(canvas.imageId, failed, failed);
    expect(canvasActionState(state(), canvas.id).status).toBe('failed');
    state().setCanvasPixelSize(canvas.imageId, { width: 800, height: 400 });
    expect(canvasActionState(state(), canvas.id)).toEqual({ status: 'ready', reason: null, size: { width: 800, height: 400 } });
    const before = state(); state().startCanvasScale(canvas.id);
    expect(state().canvasScale?.canvasId).toBe(canvas.id);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
  });

  it('別文書からの旧成功・失敗と旧ボタンによる寸法合わせを拒否する', () => {
    state().addCanvas(canvas, bytes);
    const previousId = state().activeDocumentId;
    const old: CanvasImageLoad = { documentId: previousId, bytes, request: {}, status: 'ready', size: { width: 800, height: 400 } };
    state().setCanvasImageLoad(canvas.imageId, old, old);
    state().applyDocument({ ...createEmptyPartDocument(), canvases: [canvas] }, { replacesDocument: true });
    expect(canvasActionState(state(), canvas.id).status).toBe('stale');
    const before = state();
    state().setCanvasImageLoad(canvas.imageId, old, old);
    const failure: CanvasImageLoad = { ...old, status: 'failed' };
    state().setCanvasImageLoad(canvas.imageId, failure, failure);
    expect(state().canvasImageLoads).toBe(before.canvasImageLoads);
    state().startCanvasScale(canvas.id, previousId);
    expect(state().canvasScale).toBeNull(); expect(state().undoStack).toBe(before.undoStack);
  });

  it('表示後に画像を差し替えた寸法合わせを拒否し、再試行は失敗中にだけ受ける', () => {
    state().addCanvas(canvas, bytes); state().setCanvasPixelSize(canvas.imageId, { width: 800, height: 400 });
    state().startCanvasScale(canvas.id); state().addCanvasScalePoint([0, 0]); state().addCanvasScalePoint([50, 0]);
    const staleScale = state().canvasScale;
    state().setCanvasImages(new Map([[canvas.imageId, Uint8Array.of(9)]]));
    state().setCanvasPixelSize(canvas.imageId, { width: 800, height: 400 });
    useAppStore.setState({ canvasScale: staleScale });
    const before = state();
    expect(state().applyCanvasScale(200, { width: 800, height: 400 })).toBe(false);
    state().retryCanvasImage(canvas.id);
    expect(state().canvasImageRetries).toBe(before.canvasImageRetries);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
  });

  it('同じ下絵番号の別画像に旧ボタンの寸法合わせ・再試行を適用しない', () => {
    state().addCanvas(canvas, bytes); state().removeCanvas(canvas.id);
    const replacement = newSketchCanvas([], 'xy', 'B.png', { width: 200, height: 100 }, 'replacement-image');
    state().addCanvas(replacement, bytes); state().setCanvasPixelSize(replacement.imageId, { width: 200, height: 100 });
    const before = state();
    expect(canvasActionState(before, canvas.id, before.activeDocumentId, canvas.imageId).status).toBe('stale');
    before.startCanvasScale(canvas.id, before.activeDocumentId, canvas.imageId);
    state().retryCanvasImage(canvas.id, before.activeDocumentId, canvas.imageId);
    expect(state().canvasScale).toBeNull(); expect(state().canvasImageRetries).toBe(before.canvasImageRetries);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
  });
});

describe('濃さの途中入力', () => {
  it.each(['', ' ', '.', '0.', '-', 'あ', '1.1', '-0.1', 'Infinity', '1e0', 'NaN'])('%jは確定できない', source => {
    expect(canvasOpacityValue(source)).toBeNull();
  });
  it.each([['0', 0], ['1', 1], ['0.25', 0.25], ['.5', 0.5], [' 0.75 ', 0.75]] as const)('%sを確定できる', (source, expected) => {
    expect(canvasOpacityValue(source)).toBe(expected);
  });
});
