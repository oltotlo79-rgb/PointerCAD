import { MATH_PALETTE_BASIC } from './mathPaletteBasic.js';
import { MATH_PALETTE_CALCULUS } from './mathPaletteCalculus.js';
import { MATH_PALETTE_SETS_LOGIC } from './mathPaletteSetsLogic.js';
import type { MathPaletteCatalogItem, MathPaletteItem } from './mathPaletteGroups.js';

export type {
  MathPaletteArgumentType, MathPaletteCatalogItem, MathPaletteExample, MathPaletteFields, MathPaletteGroup, MathPaletteItem,
  MathPaletteMethod, MathPaletteResultType,
} from './mathPaletteGroups.js';
export { MATH_PALETTE_HELP_TOPIC } from './mathPaletteGroups.js';

/**
 * The future palette/help catalogue starts from the same entries; activation requires acceptance IDs.
 * 分野別の3ファイル（基本→微積分・線形代数・級数→集合・論理・統計・方程式）をこの順に連結する。
 * 公開パレットの表示順は mathPaletteExamples.ts が決める。
 */
export const MATH_PALETTE_DRAFT: readonly MathPaletteCatalogItem[] = [
  ...MATH_PALETTE_BASIC, ...MATH_PALETTE_CALCULUS, ...MATH_PALETTE_SETS_LOGIC,
];

export function searchMathPalette(query: string, entries: readonly MathPaletteItem[]): readonly MathPaletteItem[] {
  const terms = query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/u).filter(Boolean);
  return entries.filter(entry => {
    const content = [entry.label, entry.symbol, entry.id, entry.meaning, ...entry.keywords].join(' ').normalize('NFKC').toLocaleLowerCase('ja');
    return terms.every(term => content.includes(term));
  });
}

export function mathPaletteAvailability(entry: MathPaletteItem, verifiedOperations: ReadonlySet<string>,
  passedAcceptanceIds: ReadonlySet<string>): boolean {
  return entry.acceptanceIds.length > 0 && entry.acceptanceIds.every(id => passedAcceptanceIds.has(id))
    && entry.requiredOperations.every(id => verifiedOperations.has(id));
}
