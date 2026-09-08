import type { DimensionKind, DimensionTolerance } from './types.js';

export interface FormatDimensionInput {
  /** null は対象を選び直せなかった未解決の寸法。 */
  readonly value: number | null;
  readonly kind: DimensionKind;
  readonly decimals?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly tolerance?: DimensionTolerance;
  readonly reference?: boolean;
}

function trimDecimal(text: string): string {
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/^-0$/, '0');
}

function roundedText(value: number, decimals: number): string {
  const threshold = 10 ** -decimals;
  if (value !== 0 && Math.abs(value) < threshold) {
    return `${trimDecimal(threshold.toFixed(decimals))} 未満`;
  }
  return trimDecimal(value.toFixed(decimals));
}

function signedText(value: number, decimals: number): string {
  if (value > 0) {
    return `+${roundedText(value, decimals)}`;
  }
  if (value < 0) {
    return `−${roundedText(Math.abs(value), decimals)}`;
  }
  return '0';
}

function decorateValue(kind: DimensionKind, value: string): string {
  switch (kind) {
    case 'diameter':
      return `φ${value}`;
    case 'radius':
      return `R${value}`;
    case 'sphereDiameter':
      return `Sφ${value}`;
    case 'sphereRadius':
      return `SR${value}`;
    case 'thickness':
      return `t${value}`;
    case 'arcLength':
      return `⌒${value}`;
    case 'angle':
      return `${value}°`;
    case 'length':
    case 'coordinate':
      return value;
  }
}

/** 測り直した値を表示時にだけ丸め、記号と公差を付ける(FR-706、FR-719、FR-722)。 */
export function formatDimension(input: FormatDimensionInput): string {
  if (input.value === null || !Number.isFinite(input.value)) {
    return '？';
  }
  const decimals = Math.max(0, Math.min(12, Math.trunc(input.decimals ?? 2)));
  let text = `${input.prefix ?? ''}${decorateValue(
    input.kind,
    roundedText(input.value, decimals),
  )}${input.suffix ?? ''}`;
  if (input.tolerance?.kind === 'symmetric') {
    text += `±${roundedText(Math.abs(input.tolerance.value), decimals)}`;
  } else if (input.tolerance?.kind === 'deviation') {
    text += ` ${signedText(input.tolerance.upper, decimals)} / ${signedText(input.tolerance.lower, decimals)}`;
  }
  return input.reference === true ? `(${text})` : text;
}
