import { tableLayout, type TableGeometry, type TableLayoutInput } from './tableLayout.js';

export interface DrawingRevisionRow {
  readonly revision: string;
  readonly date: string;
  readonly description: string;
  readonly approvedBy: string;
}
export type RevisionColumnId = keyof DrawingRevisionRow;
export interface RevisionTableInput extends Omit<TableLayoutInput, 'rows' | 'columns'> {
  readonly rows: readonly DrawingRevisionRow[];
  readonly headings: Readonly<Record<RevisionColumnId, string>>;
}

/** 自動採番・現在日時を使わず、利用者が指定した行だけを表示する。 */
export function revisionTable(input: RevisionTableInput): TableGeometry | null {
  return tableLayout({ ...input, columns: [
    { heading: input.headings.revision, widthMm: 14, align: 'middle' },
    { heading: input.headings.date, widthMm: 26, align: 'middle' },
    { heading: input.headings.description, widthMm: 82 },
    { heading: input.headings.approvedBy, widthMm: 28 },
  ], rows: input.rows.map((row) => [row.revision, row.date, row.description, row.approvedBy]) });
}
