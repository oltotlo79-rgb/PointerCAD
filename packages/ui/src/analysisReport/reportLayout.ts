import type { OutlinedText, RenderDocument, RenderPath, RenderPrimitive, RenderText } from '@pointercad/drawing';
import { t } from '../i18n/t.js';

export type OutlineText = (text: string, sizeMm: number) => OutlinedText;

export interface ReportTable {
  readonly id: string;
  readonly title?: string;
  readonly widths: readonly number[];
  readonly headings?: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ReportFigure {
  readonly caption: string;
  readonly paths: (left: number, bottom: number, width: number, height: number) => readonly RenderPath[];
}

const WIDTH = 210, HEIGHT = 297, MARGIN = 15;
const BODY_WIDTH = WIDTH - 2 * MARGIN;
const FIGURE_HEIGHT = 44;
/** The box the figure draws in (paper mm): the body width and the figure height, less 1 mm on each side. */
export const REPORT_FIGURE_SIZE = { width: BODY_WIDTH - 2, height: FIGURE_HEIGHT - 2 } as const;
const CELL_PADDING = 0.8;
const identity = [1, 0, 0, 1, 0, 0] as const;

interface Line { readonly runs: readonly RenderText[]; readonly height: number }

function run(text: string, size: number, ownerId: string, outline: OutlineText): RenderText {
  const shaped = outline(text, size);
  if (shaped.status !== 'ready' || shaped.metrics === null) throw new Error(t('drawing.error.fontFailed'));
  return { kind: 'text', text, position: [0, 0], angle: 0, anchor: 'start', baseline: 'top',
    metrics: shaped.metrics, outline: shaped.subpaths, fill: '#171717', clip: null, transform: identity,
    ownerId, layerId: 'text' };
}

function inkWidth({ metrics }: RenderText): number {
  return Math.max(metrics.advanceMm, metrics.inkBounds.right) - Math.min(0, metrics.inkBounds.left);
}

/** Measure shaped runs, including bearings. Bound the first probe so a long reference is never shaped in full just to wrap it. */
function wrap(text: string, width: number, size: number, owner: string, outline: OutlineText): (RenderText | null)[] {
  const lines: (RenderText | null)[] = [];
  for (const paragraph of text.replaceAll('\t', '    ').split(/\r\n|[\r\n]/u)) {
    const chars = Array.from(paragraph);
    if (chars.length === 0) lines.push(null);
    for (let at = 0; at < chars.length;) {
      const shape = (length: number): RenderText => run(chars.slice(at, at + length).join(''), size, owner, outline);
      const remaining = chars.length - at;
      let high = Math.min(remaining, Math.ceil(width / size) + 1);
      let candidate = shape(high);
      while (high < remaining && inkWidth(candidate) <= width) {
        high = Math.min(remaining, high * 2);
        candidate = shape(high);
      }
      if (inkWidth(candidate) > width) {
        let low = 0;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (inkWidth(shape(middle)) <= width) low = middle;
          else high = middle;
        }
        if (low === 0) throw new Error(t('analysisReport.layoutLimit'));
        high = low;
        candidate = shape(high);
      }
      lines.push(candidate);
      at += high;
    }
  }
  return lines;
}

function rowLines(values: readonly string[], widths: readonly number[], size: number, owner: string, outline: OutlineText): Line[] {
  let x = MARGIN;
  const cells = values.map((text, index) => {
    const left = x + CELL_PADDING;
    x += widths[index];
    return { left, lines: wrap(text, widths[index] - 2 * CELL_PADDING, size, owner, outline) };
  });
  return Array.from({ length: Math.max(...cells.map(cell => cell.lines.length)) }, (_, line) => {
    const runs: RenderText[] = [];
    let height = size;
    for (const cell of cells) {
      const item = cell.lines[line];
      if (item == null) continue;
      const ink = item.metrics.inkBounds;
      runs.push({ ...item, position: [cell.left - Math.min(0, ink.left), 0] });
      height = Math.max(height, ink.top - ink.bottom);
    }
    return { runs, height: height + 1.5 };
  });
}

const totalHeight = (lines: readonly Line[]): number => lines.reduce((sum, line) => sum + line.height, 0);

function tableFragments(heights: readonly number[], remaining: number, fresh: number): number {
  let count = 1;
  for (const height of heights) {
    if (height > fresh) return Infinity; // A single row can continue over several pages.
    if (height > remaining) { count += 1; remaining = fresh; }
    remaining -= height;
  }
  return count;
}

/**
 * A4 portrait, in paper mm from the bottom left. All mutable cursors and arrays belong to this invocation.
 * Shared by the beam and the solid static reports (J-03c): headers, tables split over pages, and one figure at the end.
 */
export function layoutAnalysisReport(header: (page: number) => readonly string[], tables: readonly ReportTable[],
  figure: ReportFigure, outline: OutlineText): readonly RenderDocument[] {
  const pages: RenderDocument[] = [];
  let primitives: RenderPrimitive[] = [];
  let top = 0, bodyTop = 0;
  const put = (line: Line): void => {
    for (const item of line.runs) primitives.push({ ...item, position: [item.position[0], top - 0.65] });
    top -= line.height;
  };
  const page = (): void => {
    top = HEIGHT - MARGIN;
    primitives = [];
    pages.push({ widthMm: WIDTH, heightMm: HEIGHT, primitives });
    header(pages.length).forEach((text, index) => {
      rowLines([text], [BODY_WIDTH], index === 0 ? 4.4 : 3, 'header/' + index, outline).forEach(put);
    });
    top -= 2;
    bodyTop = top;
  };
  page();
  for (const table of tables) {
    const headings = [
      ...(table.title === undefined ? [] : rowLines([table.title], [BODY_WIDTH], 3.6, table.id + '/title', outline)),
      ...(table.headings === undefined ? [] : rowLines(table.headings, table.widths, 2.9, table.id + '/head', outline)),
    ];
    const rows = table.rows.map((cells, index) => rowLines(cells, table.widths, 3, table.id + '/' + index, outline));
    const headerHeight = totalHeight(headings);
    const fresh = bodyTop - MARGIN - headerHeight;
    const remaining = top - MARGIN - headerHeight;
    const heights = rows.map(totalHeight);
    const firstRow = heights[0] ?? 0;
    const minimum = firstRow > fresh ? (rows[0]?.[0]?.height ?? 0) : firstRow;
    // Start a long table here if it still fits in the same number of fragments as on a fresh page.
    const fullPages = tableFragments(heights, fresh, fresh);
    if (remaining < minimum ||
      (fullPages > 1 && tableFragments(heights, remaining, fresh) > fullPages)) page();
    const begin = (): void => {
      if (top - MARGIN < headerHeight + (rows[0]?.[0]?.height ?? 0)) throw new Error(t('analysisReport.layoutLimit'));
      headings.forEach(put);
    };
    begin();
    for (const lines of rows) {
      const height = totalHeight(lines);
      if (height <= bodyTop - MARGIN - headerHeight && height > top - MARGIN) { page(); begin(); }
      for (const line of lines) {
        if (line.height > top - MARGIN) { page(); begin(); }
        if (line.height > top - MARGIN) throw new Error(t('analysisReport.layoutLimit'));
        put(line);
      }
    }
    top -= 2;
  }
  const caption = rowLines([figure.caption], [BODY_WIDTH], 3.6, 'figure/title', outline);
  const figureHeight = FIGURE_HEIGHT + totalHeight(caption);
  if (top - MARGIN < figureHeight) page();
  if (top - MARGIN < figureHeight) throw new Error(t('analysisReport.layoutLimit'));
  caption.forEach(put);
  primitives.push(...figure.paths(MARGIN + 1, top - FIGURE_HEIGHT + 1, REPORT_FIGURE_SIZE.width, REPORT_FIGURE_SIZE.height));
  return pages;
}
