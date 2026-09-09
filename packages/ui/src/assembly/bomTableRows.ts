import type { BomColumnId, BomRow } from '@pointercad/model';

/** 表が描く 1 行。model の数値を画面用の文字列へ変えたもの。 */
export interface BomTableRow {
  readonly key: string;
  readonly active: boolean;
  readonly componentIds: readonly string[];
  readonly cells: Readonly<Record<BomColumnId, string>>;
}

/** 部品表だけの表示規約: 小数2桁、1000g以上はkg。計算値そのものは丸めない。 */
export function formatBomMass(grams: number | null): string {
  if (grams === null || !Number.isFinite(grams)) return '';
  const normalized = Object.is(grams, -0) ? 0 : grams;
  return Math.abs(normalized) >= 1000
    ? `${(normalized / 1000).toFixed(2)} kg`
    : `${normalized.toFixed(2)} g`;
}

/** 入れ子の部品は画面に存在する最上位インスタンスを選び、同じIDを重ねない。 */
export function bomSelectionIds(row: BomRow): readonly string[] {
  const ids = row.occurrencePaths
    .map((path) => path[0])
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids.length === 0 ? row.componentIds : ids)];
}

/** model の集計行を、選択との対応と表示書式を持つ表の行へ直す純関数。 */
export function bomTableRows(
  rows: readonly BomRow[],
  selection: readonly string[],
  materialLabel: (materialId: string, fallback: string) => string = (_id, fallback) => fallback,
): readonly BomTableRow[] {
  const selected = new Set(selection);
  return rows.map((row) => {
    const componentIds = bomSelectionIds(row);
    return {
      key: row.rowKey,
      active: componentIds.some((id) => selected.has(id)),
      componentIds,
      cells: {
        number: String(row.number),
        name: row.name,
        configuration: row.configurationName ?? '',
        quantity: String(row.quantity),
        material: materialLabel(row.materialId, row.materialName),
        mass: formatBomMass(row.massTotal),
      },
    };
  });
}
