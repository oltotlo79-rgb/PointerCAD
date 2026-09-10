import type { DrawingRenderCurve, DrawingRenderElement } from '../render/renderDrawing.js';
import type { InkBounds, SemanticTextMetrics } from '../render/types.js';
import type { Point2 } from '../types.js';
import type { ToleranceCharacteristic } from './types.js';
import { gdtSymbolGeometry, type GdtSymbol } from './symbolGeometry.js';

export type GdtToken = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'symbol'; readonly symbol: GdtSymbol };
export interface GdtDisplayRow {
  readonly characteristic: ToleranceCharacteristic;
  readonly value: readonly GdtToken[];
  readonly datums: readonly (readonly GdtToken[])[];
}
export interface GdtFrameGeometry {
  readonly curves: readonly DrawingRenderCurve[];
  readonly fills: NonNullable<DrawingRenderElement['fills']>;
  readonly texts: NonNullable<DrawingRenderElement['texts']>;
  readonly bounds: InkBounds;
  readonly rowWidths: readonly number[];
  readonly compartmentWidths: readonly (readonly number[])[];
}
type MeasuredToken = { readonly token: GdtToken; readonly width: number; readonly metrics: SemanticTextMetrics | null };
export type MeasureGdtText = (text: string, sizeMm: number) => SemanticTextMetrics | null;

export function measureGdtTokens(tokens: readonly GdtToken[], height: number, measure: MeasureGdtText): readonly MeasuredToken[] | null {
  const measured: MeasuredToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'symbol') { measured.push({ token, width: 1.4 * height, metrics: null }); continue; }
    if (token.text.length === 0 || token.text.length > 80) return null;
    const metrics = measure(token.text, height), bounds = metrics?.inkBounds;
    if (metrics == null || bounds === undefined || ![metrics.advanceMm, bounds.left, bounds.right, bounds.bottom, bounds.top].every(Number.isFinite)
      || bounds.right <= bounds.left || bounds.top <= bounds.bottom) return null;
    measured.push({ token, width: bounds.right - bounds.left, metrics });
  }
  return measured;
}

/** 第1欄は枠高と同じ幅。他欄は字体の実輪郭と記号幅から作る(ISO7083:1983 §5)。 */
export function gdtFrameGeometry(input: {
  readonly rows: readonly GdtDisplayRow[];
  readonly position: Point2;
  readonly height: number;
  readonly lineWidth?: number;
  readonly measure: MeasureGdtText;
  readonly target?: Point2;
  readonly targetDirection?: Point2;
}): GdtFrameGeometry | null {
  const { rows, position, height, measure } = input, lineWidth = input.lineWidth ?? 0.25;
  if (rows.length < 1 || rows.length > 8 || !Number.isFinite(height) || height < 1 || height > 100
    || !Number.isFinite(lineWidth) || lineWidth <= 0 || lineWidth > height / 4 || !position.every(Number.isFinite)
    || (input.target !== undefined && !input.target.every(Number.isFinite))) return null;
  const frameHeight = 2 * height, padding = Math.max(1, 2 * lineWidth), gap = height * 0.2;
  const curves: DrawingRenderCurve[] = [], fills: NonNullable<DrawingRenderElement['fills']>[number][] = [];
  const texts: NonNullable<DrawingRenderElement['texts']>[number][] = [], rowWidths: number[] = [], compartmentWidths: number[][] = [];
  const line = (from: Point2, to: Point2): void => { curves.push({ kind: 'segment', from, to }); };
  const addSymbol = (symbol: GdtSymbol, center: Point2): boolean => {
    const geometry = gdtSymbolGeometry(symbol, height, center);
    if (geometry === null) return false;
    curves.push(...geometry.curves); fills.push(...geometry.fills); return true;
  };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.datums.length > 3 || row.value.length === 0 || row.value.length > 8 || row.datums.some((cell) => cell.length === 0 || cell.length > 8)) return null;
    const bottom = position[1] + (rows.length - rowIndex - 1) * frameHeight, centerY = bottom + height;
    if (!addSymbol(row.characteristic, [position[0] + height, centerY])) return null;
    const widths = [frameHeight];
    let left = position[0] + frameHeight;
    line([left, bottom], [left, bottom + frameHeight]);
    for (const tokens of [row.value, ...row.datums]) {
      const measured = measureGdtTokens(tokens, height, measure);
      if (measured === null) return null;
      const contentWidth = measured.reduce((sum, token) => sum + token.width, 0) + gap * (measured.length - 1);
      const width = Math.max(frameHeight, contentWidth + 2 * padding);
      let cursor = left + (width - contentWidth) / 2;
      for (const item of measured) {
        if (item.token.kind === 'symbol') {
          if (!addSymbol(item.token.symbol, [cursor + item.width / 2, centerY])) return null;
        } else {
          if (item.metrics === null) return null;
          const bounds = item.metrics.inkBounds;
          texts.push({ text: item.token.text, position: [cursor - bounds.left, centerY - (bounds.bottom + bounds.top) / 2],
            sizeMm: height, anchor: 'start', baseline: 'alphabetic' });
        }
        cursor += item.width + gap;
      }
      left += width; widths.push(width); line([left, bottom], [left, bottom + frameHeight]);
    }
    line([position[0], bottom], [left, bottom]);
    line([position[0], bottom + frameHeight], [left, bottom + frameHeight]);
    line([position[0], bottom], [position[0], bottom + frameHeight]);
    // 絶対座標同士の引き算で桁落ちさせず、紙上の欄幅から寸法を求める。
    rowWidths.push(widths.reduce((sum, width) => sum + width, 0)); compartmentWidths.push(widths);
  }
  const bounds = { left: position[0], right: position[0] + Math.max(...rowWidths), bottom: position[1], top: position[1] + rows.length * frameHeight };
  if (!Object.values(bounds).every(Number.isFinite)) return null;
  if (input.target !== undefined) {
    const y = bounds.top - height, x = input.target[0] <= position[0] + rowWidths[0] / 2 ? bounds.left : bounds.left + rowWidths[0];
    const origin: Point2 = [x, y], delta: Point2 = [origin[0] - input.target[0], origin[1] - input.target[1]], length = Math.hypot(...delta);
    if (length > 1e-7) {
      let u: Point2 = [delta[0] / length, delta[1] / length];
      if (input.targetDirection !== undefined) {
        const [dx, dy] = input.targetDirection, distance = Math.hypot(dx, dy);
        if (!Number.isFinite(distance) || distance < 1e-7) return null;
        const sign = delta[0] * dx + delta[1] * dy >= 0 ? 1 : -1;
        u = [dx / distance * sign, dy / distance * sign];
        const reach = Math.max(height * 3, Math.abs(delta[0] * u[0] + delta[1] * u[1]));
        const knee: Point2 = [input.target[0] + u[0] * reach, input.target[1] + u[1] * reach];
        line(origin, knee); line(knee, input.target);
      } else line(origin, input.target);
      const size = Math.min(height, length / 2);
      const a: Point2 = [input.target[0] + u[0] * size - u[1] * size / 4, input.target[1] + u[1] * size + u[0] * size / 4];
      const b: Point2 = [input.target[0] + u[0] * size + u[1] * size / 4, input.target[1] + u[1] * size - u[0] * size / 4];
      fills.push({ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: input.target }, { kind: 'L', to: a }, { kind: 'L', to: b }, { kind: 'Z' }] }] });
    }
  }
  return { curves, fills, texts, bounds, rowWidths, compartmentWidths };
}
