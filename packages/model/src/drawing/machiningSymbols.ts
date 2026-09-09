import { formatDimension, type DrawingSymbolKind } from '@pointercad/drawing';
import { findMetricThread } from '../thread/metricThread.js';
import type { ChamferFeature, HoleEntry, HoleFeature, ThreadHoleFeature, ThreadShaftFeature } from '../part/types.js';

export type MachiningFeature = HoleFeature | ThreadHoleFeature | ThreadShaftFeature | ChamferFeature;
export type MachiningNoteToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'symbol'; readonly symbol: DrawingSymbolKind };
export interface MachiningNote {
  readonly featureId: string;
  readonly tokens: readonly MachiningNoteToken[];
}
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function text(value: string): MachiningNoteToken { return { kind: 'text', text: value }; }
function symbol(value: DrawingSymbolKind): MachiningNoteToken { return { kind: 'symbol', symbol: value }; }
function number(value: number): string { return formatDimension({ value, kind: 'length', decimals: 6 }); }
function entryTokens(entry: HoleEntry | undefined, holeDiameter: number): readonly MachiningNoteToken[] | null {
  if (entry === undefined || entry.kind === 'plain') return [];
  if (!positive(entry.diameter.value) || entry.diameter.value < holeDiameter) return null;
  if (entry.kind === 'counterbore') {
    return positive(entry.depth.value) ? [symbol('counterbore'), text(`φ${number(entry.diameter.value)}`), symbol('depth'), text(number(entry.depth.value))] : null;
  }
  if (!positive(entry.angle.value) || entry.angle.value >= 180) return null;
  const angle = entry.angle.value === 90 ? '' : `×${number(entry.angle.value)}°`;
  return [symbol('countersink'), text(`φ${number(entry.diameter.value)}${angle}`)];
}

/** フィーチャーの現在の式の値から注記を作る。記号の字体への依存は持たない(P8-33)。 */
export function machiningSymbols(feature: MachiningFeature, options: {
  /** 等距離/2距離の面取りは、対象面から解決した角度を与えた場合だけC表記にする。 */
  readonly chamferAngleDegrees?: number;
} = {}): MachiningNote | null {
  if (feature.suppressed) return null;
  const tokens: MachiningNoteToken[] = [];
  if (feature.kind === 'chamfer') {
    const size = feature.size;
    const angle = size.kind === 'distanceAngle' ? size.angle.value : options.chamferAngleDegrees;
    const distance = size.kind === 'twoDistances' ? size.distance1.value : size.distance.value;
    if (!positive(distance) || (angle !== undefined && (!positive(angle) || angle >= 90))) return null;
    if (size.kind === 'twoDistances' && !positive(size.distance2.value)) return null;
    if (angle !== undefined && Math.abs(angle - 45) < 1e-9
      && (size.kind !== 'twoDistances' || size.distance1.value === size.distance2.value)) tokens.push(text(`C${number(distance)}`));
    else if (size.kind === 'distanceAngle') tokens.push(text(`${number(distance)}×${number(size.angle.value)}°`));
    else tokens.push(text(`${number(distance)}×${number(size.kind === 'equal' ? distance : size.distance2.value)}`));
    return { featureId: feature.id, tokens };
  }
  let holeDiameter: number;
  if (feature.kind === 'hole') {
    holeDiameter = feature.diameter.value;
    if (!positive(holeDiameter)) return null;
    tokens.push(text(`φ${number(holeDiameter)}`));
  } else {
    const designation = feature.kind === 'threadHole' ? feature.designation : feature.nominal;
    const size = findMetricThread(designation);
    if (size === undefined || !positive(feature.pitch.value)) return null;
    // モデルはピッチの式編集を許す。表の既定値で現在の形状のピッチを上書きしない。
    tokens.push(text(`${size.designation}×${number(feature.pitch.value)}`));
    holeDiameter = size.diameter;
    if (feature.kind === 'threadShaft') return { featureId: feature.id, tokens };
  }
  if (feature.depth.kind === 'blind') {
    if (!positive(feature.depth.depth.value)) return null;
    tokens.push(symbol('depth'), text(number(feature.depth.depth.value)));
  }
  const entry = entryTokens(feature.entry, holeDiameter);
  return entry === null ? null : { featureId: feature.id, tokens: [...tokens, ...entry] };
}
