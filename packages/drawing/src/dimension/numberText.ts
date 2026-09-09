/** 表示でだけ丸める。非有限の桁指定は既定値へ戻す。 */
export function dimensionDecimals(decimals = 2): number {
  return Number.isFinite(decimals) ? Math.max(0, Math.min(12, Math.trunc(decimals))) : 2;
}

function trimDecimal(text: string): string {
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/^-0$/, '0');
}

export function dimensionNumberText(value: number, decimals: number): string {
  const threshold = 10 ** -decimals;
  if (value !== 0 && Math.abs(value) < threshold) {
    return `${trimDecimal(threshold.toFixed(decimals))} 未満`;
  }
  return trimDecimal(value.toFixed(decimals));
}

export function signedDimensionNumberText(value: number, decimals: number): string {
  if (value > 0) return `+${dimensionNumberText(value, decimals)}`;
  if (value < 0) return `−${dimensionNumberText(Math.abs(value), decimals)}`;
  return '0';
}
