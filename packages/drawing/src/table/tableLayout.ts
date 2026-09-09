import type { Point2 } from '../types.js';
import type { SemanticTextMetrics } from '../render/types.js';
import type { DimensionLineSegment } from '../dimension/geometry.js';
import type { SymbolText } from '../annotation/symbols.js';

export interface TableColumn {
  readonly heading: string;
  readonly widthMm: number;
  readonly align?: 'start' | 'middle' | 'end';
}
export interface TableLayoutInput {
  /** 表の左上。行は紙の下向きへ増える。 */
  readonly position: Point2;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly rowHeightMm?: number;
  readonly textHeightMm?: number;
  readonly bounds: { readonly left: number; readonly bottom: number; readonly right: number; readonly top: number };
  readonly measureText: (text: string, heightMm: number) => SemanticTextMetrics | null;
}
export interface TableGeometry {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly rowHeights: readonly number[];
  readonly lines: readonly (DimensionLineSegment & { readonly widthMm: number })[];
  readonly texts: readonly SymbolText[];
}

/** 枠を描く前に全セルを実字体で折り返し、行高と用紙内への収まりを確定する。 */
export function tableLayout(input: TableLayoutInput): TableGeometry | null {
  const rowHeight = input.rowHeightMm ?? 8;
  const textHeight = input.textHeightMm ?? 3.5;
  const { bounds, columns } = input;
  if (!input.position.every(Number.isFinite) || !Object.values(bounds).every(Number.isFinite)
    || bounds.left >= bounds.right || bounds.bottom >= bounds.top || columns.length === 0
    || !Number.isFinite(rowHeight) || rowHeight <= 0 || !Number.isFinite(textHeight) || textHeight <= 0
    || columns.some((column) => !Number.isFinite(column.widthMm) || column.widthMm <= 2
      || !['start', 'middle', 'end'].includes(column.align ?? 'start'))
    || input.rows.some((row) => row.length !== columns.length)) return null;
  const [left, top] = input.position;
  const widthMm = columns.reduce((sum, column) => sum + column.widthMm, 0);
  if (left < bounds.left || left + widthMm > bounds.right || top > bounds.top) return null;
  const measure = (text: string): SemanticTextMetrics | null => {
    const value = input.measureText(text, textHeight);
    return value !== null && Number.isFinite(value.advanceMm) && value.advanceMm >= 0
      && Object.values(value.inkBounds).every(Number.isFinite)
      && value.inkBounds.left <= value.inkBounds.right && value.inkBounds.bottom <= value.inkBounds.top ? value : null;
  };
  const wrap = (text: string, width: number): { text: string; metrics: SemanticTextMetrics }[] | null => {
    const result: { text: string; metrics: SemanticTextMetrics }[] = [];
    for (const paragraph of text.replace(/\r\n?/gu, '\n').split('\n')) {
      let line = '';
      for (const character of Array.from(paragraph)) {
        const measured = measure(line + character);
        if (measured === null) return null;
        if (measured.inkBounds.right - measured.inkBounds.left <= width) { line += character; continue; }
        if (line.length === 0) return null;
        const previous = measure(line), single = measure(character);
        if (previous === null || single === null || single.inkBounds.right - single.inkBounds.left > width) return null;
        result.push({ text: line, metrics: previous });
        line = character;
      }
      const last = measure(line);
      if (last === null) return null;
      result.push({ text: line, metrics: last });
    }
    return result;
  };
  const rows = [columns.map((column) => column.heading), ...input.rows];
  const texts: SymbolText[] = [];
  const rowHeights: number[] = [];
  let y = top;
  for (const row of rows) {
    const cells = row.map((text, index) => wrap(text, columns[index].widthMm - 2));
    if (cells.some((cell) => cell === null)) return null;
    const rowSize = Math.max(rowHeight, ...cells.map((cell) => cell === null ? 0
      : (cell.length - 1) * textHeight * 1.4 + Math.max(...cell.map((line) => line.metrics.inkBounds.top - line.metrics.inkBounds.bottom)) + 2));
    rowHeights.push(rowSize);
    let x = left;
    for (const [index, cell] of cells.entries()) {
      if (cell === null) return null;
      const column = columns[index];
      const anchor = column.align ?? 'start';
      for (const [lineIndex, line] of cell.entries()) {
        const inkWidth = line.metrics.inkBounds.right - line.metrics.inkBounds.left;
        const inkLeft = anchor === 'end' ? x + column.widthMm - 1 - inkWidth
          : anchor === 'middle' ? x + (column.widthMm - inkWidth) / 2 : x + 1;
        const anchorOffset = anchor === 'end' ? line.metrics.advanceMm : anchor === 'middle' ? line.metrics.advanceMm / 2 : 0;
        texts.push({ text: line.text, position: [inkLeft - line.metrics.inkBounds.left + anchorOffset,
          y - rowSize / 2 + ((cell.length - 1) / 2 - lineIndex) * textHeight * 1.4],
        sizeMm: textHeight, anchor, baseline: 'middle' });
      }
      x += column.widthMm;
    }
    y -= rowSize;
  }
  if (y < bounds.bottom) return null;
  const lines: (DimensionLineSegment & { readonly widthMm: number })[] = [];
  let lineY = top;
  for (let index = 0; index <= rows.length; index += 1) {
    lines.push({ from: [left, lineY], to: [left + widthMm, lineY], widthMm: index === 0 || index === rows.length ? 0.5 : 0.25 });
    lineY -= rowHeights[index] ?? 0;
  }
  let lineX = left;
  for (let index = 0; index <= columns.length; index += 1) {
    lines.push({ from: [lineX, y], to: [lineX, top], widthMm: index === 0 || index === columns.length ? 0.5 : 0.25 });
    lineX += columns[index]?.widthMm ?? 0;
  }
  return { widthMm, heightMm: top - y, rowHeights, lines, texts };
}
