import { paperSizeOf, type PaperSeries } from './paperSize.js';

/** 印刷の送り手とdesktopの受け口が共有する用紙情報。余分な印刷設定をIPCから透過しない。 */
export interface DrawingPrintOptions {
  readonly kind: 'drawing';
  readonly mimeType: 'image/svg+xml';
  readonly pageSize: PaperSeries;
  readonly landscape: boolean;
  readonly copies: number;
  readonly widthMm: number;
  readonly heightMm: number;
}
export function drawingPrintOptions(paperSizeId: string, copies = 1): DrawingPrintOptions | null {
  const paper = paperSizeOf(paperSizeId);
  if (paper === undefined || !Number.isInteger(copies) || copies < 1 || copies > 999) return null;
  return { kind: 'drawing', mimeType: 'image/svg+xml', pageSize: paper.series,
    landscape: paper.orientation === 'landscape', copies, widthMm: paper.width, heightMm: paper.height };
}

export function readDrawingPrintOptions(value: unknown): DrawingPrintOptions | null {
  if (value === null || typeof value !== 'object' || !('kind' in value) || value.kind !== 'drawing'
    || !('mimeType' in value) || value.mimeType !== 'image/svg+xml'
    || !('pageSize' in value) || typeof value.pageSize !== 'string'
    || !('landscape' in value) || typeof value.landscape !== 'boolean'
    || !('copies' in value) || typeof value.copies !== 'number'
    || !('widthMm' in value) || !('heightMm' in value)) return null;
  const result = drawingPrintOptions(`${value.pageSize}-${value.landscape ? 'landscape' : 'portrait'}`, value.copies);
  return result === null || result.widthMm !== value.widthMm || result.heightMm !== value.heightMm ? null : result;
}
