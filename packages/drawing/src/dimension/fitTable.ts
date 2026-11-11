import { FIT_ROWS, FIT_SYMBOLS } from './fitTableData.js';

export { FIT_SYMBOLS, type FitSymbol } from './fitTableData.js';

export interface FitTolerance {
  /** mm。原表のµmをAPI境界で換算する。 */
  readonly upper: number;
  readonly lower: number;
}

/** JIS B 0401-2の供給表を引く。大文字と小文字は穴・軸を区別する。 */
export function fitTolerance(sizeMm: number, symbol: string): FitTolerance | null {
  if (!Number.isFinite(sizeMm) || sizeMm < 1 || sizeMm > 500) return null;
  const index = FIT_SYMBOLS.findIndex((candidate) => candidate === symbol);
  if (index < 0) return null;
  const row = FIT_ROWS.find((candidate) => sizeMm > candidate.over && sizeMm <= candidate.upTo);
  if (row === undefined) return null;
  const deviation = row.deviations[index];
  return { upper: deviation[0] / 1000, lower: deviation[1] / 1000 };
}
