import { tableLayout, type TableGeometry, type TableLayoutInput } from './tableLayout.js';

interface ParameterRow {
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  readonly description: string;
}

interface ParameterTableInput extends Omit<TableLayoutInput, 'columns' | 'rows'> {
  readonly headings: Readonly<Record<keyof ParameterRow, string>>;
  readonly rows: readonly ParameterRow[];
}

/** 部品から選んだ行を名前順に置く。値と単位は呼び出し側で表示用に整える。 */
export function parameterTable(input: ParameterTableInput): TableGeometry | null {
  const rows = [...input.rows].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return tableLayout({
    ...input,
    columns: [
      { heading: input.headings.name, widthMm: 32 },
      { heading: input.headings.value, widthMm: 28, align: 'end' },
      { heading: input.headings.unit, widthMm: 18, align: 'middle' },
      { heading: input.headings.description, widthMm: 72 },
    ],
    rows: rows.map((row) => [row.name, row.value, row.unit, row.description]),
  });
}
