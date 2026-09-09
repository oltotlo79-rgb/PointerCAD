import type { Point2 } from '../types.js';
import { note, type NoteGeometry } from '../annotation/note.js';
import { tableLayout, type TableGeometry, type TableLayoutInput } from './tableLayout.js';

/** modelが穴フィーチャーから解決した行。描画層からmodelをimportしない。 */
export interface DrawingHoleRow {
  readonly id: string;
  readonly symbol: string;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
  /** nullは貫通。未解決値をnullへ変換しない。 */
  readonly depth: number | null;
}
export type HoleColumnId = 'symbol' | 'x' | 'y' | 'diameter' | 'depth';
export interface HoleTableInput extends Omit<TableLayoutInput, 'rows' | 'columns'> {
  readonly rows: readonly DrawingHoleRow[];
  readonly headings: Readonly<Record<HoleColumnId, string>>;
  readonly formatLength: (value: number) => string;
  readonly throughText: string;
  readonly callouts?: readonly { readonly rowId: string; readonly target: Point2; readonly position: Point2 }[];
}
export interface HoleTableGeometry extends TableGeometry {
  readonly rowIds: readonly string[];
  readonly callouts: readonly { readonly rowId: string; readonly geometry: NoteGeometry }[];
}

export function holeTable(input: HoleTableInput): HoleTableGeometry | null {
  if (new Set(input.rows.map((row) => row.id)).size !== input.rows.length
    || new Set(input.rows.map((row) => row.symbol)).size !== input.rows.length
    || input.rows.some((row) => row.id === '' || !/^[A-Z]+[1-9][0-9]*$/u.test(row.symbol)
      || ![row.x, row.y, row.diameter].every(Number.isFinite) || row.diameter <= 0
      || (row.depth !== null && (!Number.isFinite(row.depth) || row.depth <= 0)))) return null;
  const columns = [
    { heading: input.headings.symbol, widthMm: 14, align: 'middle' },
    { heading: input.headings.x, widthMm: 22, align: 'end' },
    { heading: input.headings.y, widthMm: 22, align: 'end' },
    { heading: input.headings.diameter, widthMm: 22, align: 'end' },
    { heading: input.headings.depth, widthMm: 24, align: 'end' },
  ] as const;
  const rows = input.rows.map((row) => [row.symbol, input.formatLength(row.x), input.formatLength(row.y),
    `φ${input.formatLength(row.diameter)}`, row.depth === null ? input.throughText : input.formatLength(row.depth)]);
  const geometry = tableLayout({ ...input, columns, rows });
  if (geometry === null) return null;
  const byId = new Map(input.rows.map((row) => [row.id, row]));
  const callouts: { rowId: string; geometry: NoteGeometry }[] = [];
  for (const callout of input.callouts ?? []) {
    const row = byId.get(callout.rowId);
    if (row === undefined) return null;
    const placed = note({ text: row.symbol, position: callout.position, heightMm: input.textHeightMm,
      leader: { target: callout.target, end: 'arrow' }, measureText: input.measureText });
    if (placed === null) return null;
    callouts.push({ rowId: row.id, geometry: placed });
  }
  return { ...geometry, rowIds: input.rows.map((row) => row.id), callouts };
}
