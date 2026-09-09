import { tableLayout, type TableColumn, type TableGeometry, type TableLayoutInput } from './tableLayout.js';

/** P7 buildBomの実在する戻り値から表示に必要な欄だけを受け取る。modelには依存しない。 */
export interface DrawingBomRow {
  readonly rowKey: string;
  readonly number: number;
  readonly name: string;
  readonly configurationName?: string | null;
  readonly quantity: number;
  readonly materialName: string;
  readonly massEach: number | null;
}
export type BomColumnId = 'number' | 'name' | 'quantity' | 'material' | 'mass' | 'configuration';
export interface BomTableInput extends Omit<TableLayoutInput, 'rows' | 'columns'> {
  readonly rows: readonly DrawingBomRow[];
  readonly columns?: readonly BomColumnId[];
  readonly headings: Readonly<Record<BomColumnId, string>>;
  readonly columnWidths?: Partial<Readonly<Record<BomColumnId, number>>>;
  readonly direction?: 'bottomToTop' | 'topToBottom';
  readonly sortBy?: 'number' | 'name' | 'quantity' | 'mass';
  readonly sortDescending?: boolean;
  readonly formatMass: (mass: number) => string;
  readonly unknownMassText: string;
}
export interface BomTableGeometry extends TableGeometry {
  readonly columnIds: readonly BomColumnId[];
  readonly rowKeys: readonly string[];
  /** 不明な質量を0として合算しない。 */
  readonly totalMass: number | null;
}
const defaults: readonly BomColumnId[] = ['number', 'name', 'quantity', 'material', 'mass'];
const widths: Readonly<Record<BomColumnId, number>> = { number: 12, name: 50, quantity: 15, material: 28, mass: 20, configuration: 30 };

export function bomTable(input: BomTableInput): BomTableGeometry | null {
  const columnIds = input.columns ?? defaults;
  const direction = input.direction ?? 'bottomToTop';
  const sortBy = input.sortBy ?? 'number';
  if (columnIds.length === 0 || new Set(columnIds).size !== columnIds.length
    || columnIds.some((id) => !Object.hasOwn(widths, id)) || !['bottomToTop', 'topToBottom'].includes(direction)
    || !['number', 'name', 'quantity', 'mass'].includes(sortBy)
    || new Set(input.rows.map((row) => row.rowKey)).size !== input.rows.length
    || new Set(input.rows.map((row) => row.number)).size !== input.rows.length
    || input.rows.some((row) => row.rowKey.length === 0 || !Number.isInteger(row.number) || row.number < 1
      || !Number.isInteger(row.quantity) || row.quantity < 1
      || (row.massEach !== null && (!Number.isFinite(row.massEach) || row.massEach < 0
        || !Number.isFinite(row.massEach * row.quantity))))) return null;
  const rows = [...input.rows].sort((a, b) => {
    let difference: number;
    switch (sortBy) {
      case 'name': difference = a.name < b.name ? -1 : a.name > b.name ? 1 : 0; break;
      case 'quantity': difference = a.quantity - b.quantity; break;
      case 'mass': {
        const first = a.massEach === null ? null : a.massEach * a.quantity;
        const second = b.massEach === null ? null : b.massEach * b.quantity;
        if (first === null || second === null) return first === second ? a.number - b.number : first === null ? 1 : -1;
        difference = first - second; break;
      }
      default: difference = a.number - b.number;
    }
    return difference === 0 ? a.number - b.number : difference * (input.sortDescending === true ? -1 : 1);
  });
  if (direction === 'bottomToTop') rows.reverse();
  const columns: TableColumn[] = columnIds.map((id) => ({
    heading: input.headings[id], widthMm: input.columnWidths?.[id] ?? widths[id],
    align: id === 'number' || id === 'quantity' || id === 'mass' ? 'end' : 'start',
  }));
  const values = rows.map((row) => columnIds.map((id) => {
    switch (id) {
      case 'number': return String(row.number);
      case 'name': return row.name;
      case 'configuration': return row.configurationName ?? '';
      case 'quantity': return String(row.quantity);
      case 'material': return row.materialName;
      case 'mass': return row.massEach === null ? input.unknownMassText : input.formatMass(row.massEach);
    }
  }));
  const geometry = tableLayout({ ...input, columns, rows: values });
  if (geometry === null) return null;
  const totalMass = input.rows.some((row) => row.massEach === null) ? null
    : input.rows.reduce((total, row) => total + (row.massEach ?? 0) * row.quantity, 0);
  if (totalMass !== null && !Number.isFinite(totalMass)) return null;
  return { ...geometry, columnIds: [...columnIds], rowKeys: rows.map((row) => row.rowKey), totalMass };
}
