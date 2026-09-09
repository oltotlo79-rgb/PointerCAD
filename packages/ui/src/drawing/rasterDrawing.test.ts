import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWING_JPEG_QUALITY, drawingRasterSize, rasterDrawing } from './rasterDrawing.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm"/>';
describe('図面画像の実寸・解像度・失敗時の解放(P8-47)', () => {
  const drawImage = vi.fn(), fillRect = vi.fn(), decode = vi.fn<() => Promise<void>>();
  const createObjectUrl = vi.fn(() => 'blob:drawing'), revokeObjectUrl = vi.fn();
  const toBlob = vi.fn<(callback: BlobCallback, type?: string, quality?: number) => void>();
  const context = { fillStyle: '', drawImage, fillRect };
  const canvas = { width: 0, height: 0, toBlob, getContext: vi.fn(() => context) };
  let decodedSource = '';
  beforeEach(() => {
    vi.clearAllMocks(); context.fillStyle = ''; canvas.width = 0; canvas.height = 0; decodedSource = '';
    decode.mockResolvedValue(); canvas.getContext.mockReturnValue(context);
    toBlob.mockImplementation((callback, type) => callback(new Blob([new Uint8Array([1, 2, 3])], { type })));
    vi.stubGlobal('Image', class { src = ''; decode() { decodedSource = this.src; return decode(); } });
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectUrl); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([[150, 2480, 1754], [300, 4961, 3508], [600, 9921, 7016]] as const)('A3横%d dpiは%d×%d画素', (dpi, width, height) => {
    expect(drawingRasterSize(420, 297, dpi)).toEqual({ ok: true, width, height });
  });
  it('縦向きは画素の幅と高さが入れ替わる', () => { expect(drawingRasterSize(297, 420, 300)).toEqual({ ok: true, width: 3508, height: 4961 }); });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('不正な用紙幅%sを断る', (width) => {
    expect(drawingRasterSize(width, 297, 300)).toEqual({ ok: false, reason: 'invalidSize' });
  });
  it('単辺の上限を超える長い用紙をCanvas作成前に断る', async () => {
    expect(await rasterDrawing(svg, 10000, 10, 'png', 600)).toEqual({ ok: false, reason: 'tooLarge' }); expect(createObjectUrl).not.toHaveBeenCalled();
  });
  it('辺ごとの上限内でも総画素の上限を守る', () => { expect(drawingRasterSize(500, 500, 600)).toEqual({ ok: false, reason: 'tooLarge' }); });
  it('PNGを白い用紙に描き、実寸の画素数で保存する', async () => {
    const result = await rasterDrawing(svg, 420, 297, 'png', 150);
    expect(result).toMatchObject({ ok: true, width: 2480, height: 1754 }); expect(decodedSource).toBe('blob:drawing');
    expect(context.fillStyle).toBe('#ffffff'); expect(fillRect).toHaveBeenCalledWith(0, 0, 2480, 1754);
    expect(drawImage.mock.invocationCallOrder[0]).toBeGreaterThan(fillRect.mock.invocationCallOrder[0]);
    expect(toBlob.mock.calls[0].slice(1)).toEqual(['image/png', undefined]);
  });
  it('JPEGは品質0.92を渡す', async () => {
    expect((await rasterDrawing(svg, 420, 297, 'jpg')).ok).toBe(true);
    expect(DRAWING_JPEG_QUALITY).toBe(0.92); expect(toBlob.mock.calls[0].slice(1)).toEqual(['image/jpeg', 0.92]);
  });
  it('成功後はBlob URLと大きいCanvasを解放する', async () => {
    await rasterDrawing(svg, 420, 297, 'png'); expect(revokeObjectUrl).toHaveBeenCalledWith('blob:drawing');
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });
  it('画像を読めない場合もURLを解放する', async () => {
    decode.mockRejectedValue(new Error('decode')); expect(await rasterDrawing(svg, 420, 297, 'png')).toEqual({ ok: false, reason: 'imageFailed' });
    expect(revokeObjectUrl).toHaveBeenCalledOnce(); expect(toBlob).not.toHaveBeenCalled();
  });
  it('空の画像Blobを成功にしない', async () => {
    toBlob.mockImplementation((callback) => callback(null));
    expect(await rasterDrawing(svg, 420, 297, 'png')).toEqual({ ok: false, reason: 'canvasFailed' }); expect(canvas.width).toBe(0);
  });
  it('要求と違う画像形式への暗黙の代替を拒否する', async () => {
    toBlob.mockImplementation((callback) => callback(new Blob(['x'], { type: 'image/png' })));
    expect(await rasterDrawing(svg, 420, 297, 'jpg')).toEqual({ ok: false, reason: 'canvasFailed' });
  });
});
