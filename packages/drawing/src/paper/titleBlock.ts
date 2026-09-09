import type { Point2 } from '../types.js';
import { drawingSymbol, type SymbolGeometry } from '../annotation/symbols.js';
import { createPaperFrame } from './frame.js';
import type { PaperSize, PaperSizeId } from './paperSize.js';

/** 慣用値。JIS 原典との最終照合は要確認。 */
export const DEFAULT_TITLE_BLOCK_WIDTH_MM = 180;
export const DEFAULT_TITLE_BLOCK_HEIGHT_MM = 56;

export interface TitleBlockFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly fixedText?: string;
  readonly widthWeight?: number;
}

export const DEFAULT_TITLE_BLOCK_FIELDS: readonly TitleBlockFieldDefinition[] = [
  { key: 'title', label: '図名', widthWeight: 3 },
  { key: 'drawingNumber', label: '図番', widthWeight: 2 },
  { key: 'scale', label: '縮尺' },
  { key: 'projection', label: '投影法', fixedText: '第三角法' },
  { key: 'unit', label: '単位', fixedText: 'mm' },
  { key: 'date', label: '日付' },
  { key: 'author', label: '作成者' },
  { key: 'approver', label: '承認者' },
  { key: 'company', label: '会社名' },
  { key: 'mass', label: '質量' },
];

export interface TitleBlockLine {
  readonly from: Point2;
  readonly to: Point2;
}

export interface TitleBlockArc {
  readonly center: Point2;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface TitleBlockCell {
  readonly field: TitleBlockFieldDefinition;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

export type ThirdAngleSymbol = SymbolGeometry;

export interface TitleBlockLayout {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly fields: readonly TitleBlockCell[];
  readonly symbol: ThirdAngleSymbol;
}

export interface CreateTitleBlockInput {
  readonly paper: PaperSize | PaperSizeId;
  readonly fields?: readonly TitleBlockFieldDefinition[];
  readonly widthMm?: number;
  readonly heightMm?: number;
}

export function formatDrawingScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '？';
  if (scale === 1) return '1:1';
  if (scale < 1) return `1:${String(1 / scale)}`;
  return `${String(scale)}:1`;
}

/** 内枠の右下へ、差し替え可能な項目から表題欄を組み立てる(FR-701、FR-725)。 */
export function createTitleBlock(input: CreateTitleBlockInput): TitleBlockLayout | null {
  const frame = createPaperFrame(input.paper);
  const width = input.widthMm ?? DEFAULT_TITLE_BLOCK_WIDTH_MM;
  const height = input.heightMm ?? DEFAULT_TITLE_BLOCK_HEIGHT_MM;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      width > frame.inner.width || height > frame.inner.height) return null;
  const right = frame.inner.right;
  const bottom = frame.inner.bottom;
  const left = right - width;
  const top = bottom + height;
  const symbol = drawingSymbol('thirdAngle', 3.5, [right - 18, bottom + height / 2]);
  if (symbol === null) return null;
  const fields = input.fields ?? DEFAULT_TITLE_BLOCK_FIELDS;
  const totalWeight = fields.reduce((sum, field) => sum + (field.widthWeight ?? 1), 0);
  let cursor = left;
  const cells = fields.map((field, index) => {
    const next = index === fields.length - 1
      ? right
      : cursor + (width * (field.widthWeight ?? 1)) / totalWeight;
    const cell: TitleBlockCell = { field, left: cursor, bottom, right: next, top };
    cursor = next;
    return cell;
  });
  return {
    left, bottom, right, top, width, height, fields: cells,
    symbol,
  };
}
