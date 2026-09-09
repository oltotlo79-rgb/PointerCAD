import { FIT_ROWS, FIT_SYMBOLS } from './fitTableData.js';
import { formatDimension } from './format.js';
import { signedDimensionNumberText } from './numberText.js';

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

/** はめあい記号と、必要時だけ上下許容差を併記する。 */
export function formatFit(sizeMm: number, symbol: string, showDeviation = false, decimals = 2): string | null {
  const tolerance = fitTolerance(sizeMm, symbol);
  if (tolerance === null) return null;
  const text = `${formatDimension({ value: sizeMm, kind: 'diameter', decimals })}${symbol}`;
  // js6の半µmも消さない。寸法本体の桁数とは別の、原表の精度で表示する。
  return showDeviation ? `${text}(${signedDimensionNumberText(tolerance.upper, 4)} / ${signedDimensionNumberText(tolerance.lower, 4)})` : text;
}
