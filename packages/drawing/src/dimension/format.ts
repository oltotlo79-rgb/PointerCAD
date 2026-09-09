import type { DimensionKind, DimensionTolerance } from './types.js';
import { dimensionDecimals, dimensionNumberText as roundedText, signedDimensionNumberText as signedText } from './numberText.js';
import { resolveDimensionTolerance } from './tolerance.js';

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
  const decimals = dimensionDecimals(input.decimals);
  const tolerance = input.tolerance === undefined ? undefined : resolveDimensionTolerance(input.tolerance);
  if (tolerance === null) return '？';
  let text = `${input.prefix ?? ''}${decorateValue(
    input.kind,
    roundedText(input.value, decimals),
  )}${input.suffix ?? ''}`;
  if (tolerance?.kind === 'symmetric') {
    text += `±${roundedText(tolerance.value, decimals)}`;
  } else if (tolerance?.kind === 'deviation') {
    text += ` ${signedText(tolerance.upper, decimals)} / ${signedText(tolerance.lower, decimals)}`;
  }
  return input.reference === true ? `(${text})` : text;
}
