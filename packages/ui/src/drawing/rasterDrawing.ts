export type DrawingDpi = 150 | 300 | 600;
export type RasterDrawingFormat = 'png' | 'jpg';
export type RasterDrawingFailure = 'invalidSize' | 'tooLarge' | 'imageFailed' | 'canvasFailed';
export type RasterDrawingResult = { readonly ok: true; readonly bytes: Uint8Array; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: RasterDrawingFailure };
export const DRAWING_JPEG_QUALITY = 0.92;
/** 600dpi A3(69,605,736画素)を含む。実ブラウザの実測後に正式値を確定する。 */
export const DRAWING_RASTER_LIMITS = { dimension: 16_384, pixels: 75_000_000 } as const;

export function drawingRasterSize(widthMm: number, heightMm: number, dpi: DrawingDpi):
  { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: 'invalidSize' | 'tooLarge' } {
  if (![widthMm, heightMm].every((value) => Number.isFinite(value) && value > 0) || ![150, 300, 600].includes(dpi)) {
    return { ok: false, reason: 'invalidSize' };
  }
  const width = Math.round(widthMm * dpi / 25.4), height = Math.round(heightMm * dpi / 25.4);
  if (width < 1 || height < 1) return { ok: false, reason: 'invalidSize' };
  if (width > DRAWING_RASTER_LIMITS.dimension || height > DRAWING_RASTER_LIMITS.dimension
    || width * height > DRAWING_RASTER_LIMITS.pixels) return { ok: false, reason: 'tooLarge' };
  return { ok: true, width, height };
}

/** 外部参照のない共通SVGを画像化する。途中で失敗してもURLと大きいCanvasを保持しない。 */
export async function rasterDrawing(svg: string, widthMm: number, heightMm: number,
  format: RasterDrawingFormat, dpi: DrawingDpi = 300): Promise<RasterDrawingResult> {
  const size = drawingRasterSize(widthMm, heightMm, dpi);
  if (!size.ok) return size;
  let url: string | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let stage: RasterDrawingFailure = 'imageFailed';
  try {
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    await image.decode();
    stage = 'canvasFailed';
    canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) return { ok: false, reason: stage };
    // 透明な紙面をJPEGで黒くしない。PNGも図面の用紙として白く書き出す。
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    const renderedCanvas = canvas;
    const blob = await new Promise<Blob | null>((resolve) => renderedCanvas.toBlob(resolve,
      format === 'jpg' ? 'image/jpeg' : 'image/png', format === 'jpg' ? DRAWING_JPEG_QUALITY : undefined));
    if (blob === null || blob.size === 0 || blob.type !== (format === 'jpg' ? 'image/jpeg' : 'image/png')) {
      return { ok: false, reason: stage };
    }
    return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height };
  } catch { return { ok: false, reason: stage }; }
  finally {
    if (url !== null) URL.revokeObjectURL(url);
    if (canvas !== null) { canvas.width = 0; canvas.height = 0; }
  }
}
