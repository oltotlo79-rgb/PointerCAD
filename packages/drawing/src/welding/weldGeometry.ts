import type { DrawingRenderCurve, DrawingRenderElement } from '../render/renderDrawing.js';
import type { InkBounds, SemanticTextMetrics } from '../render/types.js';
import type { Point2 } from '../types.js';
import type { WeldKind, WeldSideSpec } from './types.js';
import { weldSymbolGeometry } from './symbolGeometry.js';

export interface WeldDisplaySide {
  readonly kind: WeldKind;
  readonly side: WeldSideSpec['side'];
  readonly size: string;
  readonly length: string;
  readonly rootGap: string;
  readonly grooveAngle: string;
  readonly contour: WeldSideSpec['contour'];
  readonly finish: '' | 'G' | 'M' | 'C' | 'P';
}
export interface WeldGeometry {
  readonly curves: readonly DrawingRenderCurve[];
  readonly fills: NonNullable<DrawingRenderElement['fills']>;
  readonly texts: NonNullable<DrawingRenderElement['texts']>;
  /** 基線と文字の操作領域。矢の対象まで広げると部品選択を妨げるため含めない。 */
  readonly bounds: InkBounds;
  readonly baseline: { readonly from: Point2; readonly to: Point2 };
}
type Measure = (text: string, height: number) => SemanticTextMetrics | null;

/** 全出力で共有するSystem Bの紙上mm幾何。文字の実輪郭を基線・記号から離す。 */
export function weldGeometry(input: {
  readonly sides: readonly WeldDisplaySide[]; readonly position: Point2; readonly target: Point2; readonly height: number;
  readonly allAround: boolean; readonly fieldWeld: boolean; readonly tail: string; readonly closedTail?: boolean;
  readonly arrowBendOffset?: Point2; readonly measure: Measure;
}): WeldGeometry | null {
  const { sides, position, target, height: h, measure } = input;
  if (sides.length < 1 || sides.length > 2 || !Number.isFinite(h) || h < 1 || h > 100
    || ![...position, ...target, ...(input.arrowBendOffset ?? [])].every(Number.isFinite) || input.tail.length > 2000
    || new Set(sides.map((side) => side.side)).size !== sides.length
    || (sides.some((side) => side.side === 'center') && sides.length !== 1)) return null;
  const curves: DrawingRenderCurve[] = [], fills: NonNullable<DrawingRenderElement['fills']>[number][] = [];
  const texts: NonNullable<DrawingRenderElement['texts']>[number][] = [];
  const metrics = (text: string): SemanticTextMetrics | null => {
    if (text.length === 0) return null;
    const result = measure(text, h), b = result?.inkBounds;
    return result === null || b === undefined || ![result.advanceMm, b.left, b.right, b.bottom, b.top].every(Number.isFinite)
      || b.right <= b.left || b.top <= b.bottom ? null : result;
  };
  const width = (value: SemanticTextMetrics | null): number => value === null ? 0 : value.inkBounds.right - value.inkBounds.left;
  const measured = sides.map((side) => {
    const gap = metrics(side.rootGap);
    return { side, size: metrics(side.size), length: metrics(side.length), gap,
      glyphHeight: side.rootGap === '' ? h : Math.max(h, (width(gap) + 0.7 * h) / 0.6) };
  });
  if (measured.some(({ side, size, length, gap }) => (side.size !== '' && size === null) || (side.length !== '' && length === null)
    || (side.rootGap !== '' && gap === null))) return null;
  const sizeWidth = Math.max(...measured.map((item) => width(item.size))), lengthWidth = Math.max(...measured.map((item) => width(item.length)));
  const glyphHeight = Math.max(...measured.map((item) => item.glyphHeight));
  // 基線を対象から離れる方向へ伸ばす。字と基本記号は鏡像にせず、左右の寸法の意味を保つ。
  const [x, y] = position, direction = target[0] > x ? -1 : 1;
  const baselineWidth = 2.5 * h + 2 * glyphHeight + sizeWidth + lengthWidth;
  const endX = x + direction * baselineWidth, left = Math.min(x, endX);
  const symbolX = left + 1.5 * h + glyphHeight + sizeWidth;
  const bounds = { left: left - h, bottom: y - 2 * h, right: Math.max(x, endX) + h, top: y + 2 * h };
  const line = (from: Point2, to: Point2): void => { curves.push({ kind: 'segment', from, to }); };
  const textAt = (text: string, left: number, middleY: number): boolean => {
    if (text.length === 0) return true;
    const measuredText = metrics(text); if (measuredText === null) return false;
    const b = measuredText.inkBounds, baselineY = middleY - (b.bottom + b.top) / 2;
    texts.push({ text, sizeMm: h, position: [left - b.left, baselineY], anchor: 'start', baseline: 'alphabetic' });
    bounds.left = Math.min(bounds.left, left); bounds.right = Math.max(bounds.right, left + b.right - b.left);
    bounds.bottom = Math.min(bounds.bottom, baselineY + b.bottom); bounds.top = Math.max(bounds.top, baselineY + b.top);
    return true;
  };
  for (const { side, size, gap, glyphHeight: gh } of measured) {
    const geometry = weldSymbolGeometry(side.kind, side.side, gh, [symbolX, y]); if (geometry === null) return null;
    curves.push(...geometry);
    // 表5の抵抗スポット/シームは記号だけを基線中央にし、数値は下へ離す。
    const sign = side.side === 'arrow' ? -1 : 1, middleY = y + (side.side === 'center' ? -1 : sign) * gh * 0.8;
    bounds.bottom = Math.min(bounds.bottom, y + Math.min(0, sign * gh * 1.4));
    bounds.top = Math.max(bounds.top, y + Math.max(0, sign * gh * 1.4));
    if (!textAt(side.size, symbolX - gh - 0.2 * h - width(size), middleY) || !textAt(side.length, symbolX + gh + 0.2 * h, middleY)) return null;
    // ルート間隔を基本記号の内側、開先角度をその外側へ。小字にせず記号領域を確保する。
    if (side.rootGap !== '') {
      const bias = side.kind === 'bevelButt' || side.kind === 'jButt' ? -0.15 * gh : 0;
      if (!textAt(side.rootGap, symbolX + bias - width(gap) / 2, y + sign * gh * 0.95)) return null;
    }
    let outer = 1.4 * gh + 0.7 * h;
    if (side.grooveAngle !== '') {
      const angle = metrics(side.grooveAngle); if (angle === null) return null;
      if (!textAt(side.grooveAngle, symbolX - width(angle) / 2, y + sign * outer)) return null;
      outer += h * 1.5;
    }
    if (side.contour !== 'none') {
      const cy = y + sign * outer, points: Point2[] = [];
      for (let index = 0; index <= 16; index++) {
        const t = index / 16, bulge = side.contour === 'flush' ? 0 : Math.sin(t * Math.PI) * h * 0.25 * (side.contour === 'convex' ? 1 : -1);
        points.push([symbolX + (t - 0.5) * 1.7 * h, cy + sign * bulge]);
      }
      curves.push({ kind: 'polyline', points, closed: false });
      bounds.bottom = Math.min(bounds.bottom, cy - h * 0.25); bounds.top = Math.max(bounds.top, cy + h * 0.25);
      if (side.finish !== '' && !textAt(side.finish, symbolX - h * 0.3, cy + sign * h)) return null;
    } else if (side.finish !== '') return null;
  }
  line(position, [endX, y]);
  if (input.allAround) curves.push({ kind: 'arc', center: position, radius: h * 0.55, startAngle: 0, endAngle: Math.PI * 2 });
  if (input.fieldWeld) {
    line(position, [x, y + 3 * h]);
    curves.push({ kind: 'polyline', points: [[x, y + 3 * h], [x + 1.3 * h, y + 2.55 * h], [x, y + 2.1 * h]], closed: false });
    bounds.top = Math.max(bounds.top, y + 3 * h);
  }
  const tail = input.tail.trim();
  if (input.closedTail && tail.length === 0) return null;
  if (tail.length > 0) {
    const rows: string[] = [];
    for (const paragraph of tail.split(/\r?\n/)) {
      let row = '';
      for (const character of paragraph) {
        const value = metrics(row + character);
        if (value === null && character.trim() !== '') return null;
        if (row.length > 0 && width(value) > 24 * h) { rows.push(row); row = character; } else row += character;
      }
      rows.push(row);
    }
    const halfHeight = Math.max(h, rows.length * h * 0.75);
    const tailWidth = Math.max(...rows.map((row) => width(metrics(row.trim()))));
    const textX = direction > 0 ? endX + 1.7 * h : endX - 1.7 * h - tailWidth;
    for (let index = 0; index < rows.length; index++) {
      if (!textAt(rows[index].trim(), textX, y + (rows.length - 1 - index * 2) * h * 0.75)) return null;
    }
    line([endX, y], [endX + direction * h, y + halfHeight]); line([endX, y], [endX + direction * h, y - halfHeight]);
    if (input.closedTail) {
      const outside = direction > 0 ? bounds.right + h * 0.7 : bounds.left - h * 0.7;
      line([endX + direction * h, y + halfHeight], [outside, y + halfHeight]); line([outside, y + halfHeight], [outside, y - halfHeight]);
      line([outside, y - halfHeight], [endX + direction * h, y - halfHeight]);
      bounds.left = Math.min(bounds.left, outside); bounds.right = Math.max(bounds.right, outside);
    }
    bounds.bottom = Math.min(bounds.bottom, y - halfHeight); bounds.top = Math.max(bounds.top, y + halfHeight);
  }
  const bend: Point2 = input.arrowBendOffset === undefined ? position : [x + input.arrowBendOffset[0], y + input.arrowBendOffset[1]];
  const dx = bend[0] - target[0], dy = bend[1] - target[1], distance = Math.hypot(dx, dy);
  if (distance < h * 0.5 || !Object.values(bounds).every(Number.isFinite)) return null;
  if (input.arrowBendOffset !== undefined) line(position, bend);
  line(bend, target);
  const ux = dx / distance, uy = dy / distance, size = Math.min(h, distance / 2);
  const a: Point2 = [target[0] + size * (ux - uy / 4), target[1] + size * (uy + ux / 4)];
  const b: Point2 = [target[0] + size * (ux + uy / 4), target[1] + size * (uy - ux / 4)];
  fills.push({ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: target }, { kind: 'L', to: a }, { kind: 'L', to: b }, { kind: 'Z' }] }] });
  return { curves, fills, texts, bounds, baseline: { from: position, to: [endX, y] } };
}
