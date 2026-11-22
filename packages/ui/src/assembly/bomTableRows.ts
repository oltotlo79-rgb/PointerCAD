import { magnitudeAtLeast } from '@pointercad/model';
import type { BomColumnId, BomRow } from '@pointercad/model';

import { displayNumber } from '../sketch/numericInputPresentation.js';

/** 表が描く 1 行。model の数値を画面用の文字列へ変えたもの。 */
export interface BomTableRow {
  readonly key: string;
  readonly active: boolean;
  readonly componentIds: readonly string[];
  readonly cells: Readonly<Record<BomColumnId, string>>;
  readonly massTitle: string | undefined;
}

const GRAMS_PER_KILOGRAM = 1000;

/** 表示した g の値で単位を決め、説明には元の g の値を残す。 */
function formatBomMassDetails(grams: number | null): { text: string; full?: string } {
  if (grams === null || !Number.isFinite(grams)) return { text: '' };
  const inGrams = displayNumber(grams);
  const roundedGrams = Number(inGrams.text);
  const text = magnitudeAtLeast(roundedGrams, GRAMS_PER_KILOGRAM)
    ? `${displayNumber(roundedGrams / GRAMS_PER_KILOGRAM).text} kg`
    : `${inGrams.text} g`;
  return { text, full: `${inGrams.full} g` };
}

export function formatBomMass(grams: number | null): string {
  return formatBomMassDetails(grams).text;
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
    const mass = formatBomMassDetails(row.massTotal);
    return {
      key: row.rowKey,
      active: componentIds.some((id) => selected.has(id)),
      componentIds,
      massTitle: mass.full,
      cells: {
        number: String(row.number),
        name: row.name,
        configuration: row.configurationName ?? '',
        quantity: String(row.quantity),
        // 材質の無い族の部品で、行が密度の材質を持たない時は行の材質の表示(既定の鋼と出さない。統括 22:5x の (d))。
        material: row.catalogMaterialLabel ?? materialLabel(row.materialId, row.materialName),
        mass: mass.text,
      },
    };
  });
}
