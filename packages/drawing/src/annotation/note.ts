import type { Point2 } from '../types.js';
import type { SemanticTextMetrics } from '../render/types.js';
import { blackDot, createArrowTriangle, type ArrowTriangle } from '../dimension/arrow.js';
import type { DimensionLineSegment } from '../dimension/geometry.js';
import type { SymbolText } from './symbols.js';

export interface NoteInput {
  readonly text: string;
  /** 先頭行の墨の左下。複数行はこの位置から下へ並べる。 */
  readonly position: Point2;
  readonly heightMm?: number;
  readonly leader?: { readonly target: Point2; readonly end: 'arrow' | 'dot' };
  readonly measureText: (text: string, sizeMm: number) => SemanticTextMetrics | null;
}
export interface NoteGeometry {
  readonly texts: readonly SymbolText[];
  readonly lines: readonly DimensionLineSegment[];
  readonly arrow: ArrowTriangle | null;
  readonly dot: { readonly center: Point2; readonly radius: number } | null;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** 行送り1.4倍と受け線の余白2mmはP8-50の慣用値。文字幅は実字体で測る。 */
export function note(input: NoteInput): NoteGeometry | null {
  const size = input.heightMm ?? 3.5;
  if (!Number.isFinite(size) || size <= 0 || !input.position.every(Number.isFinite)
    || (input.leader !== undefined && (!input.leader.target.every(Number.isFinite)
      || !['arrow', 'dot'].includes(input.leader.end)))) return null;
  if (input.text.length === 0) return { texts: [], lines: [], arrow: null, dot: null, widthMm: 0, heightMm: 0 };
  const rows = input.text.replace(/\r\n?/gu, '\n').split('\n');
  const texts: SymbolText[] = [];
  let widthMm = 0;
  let inkHeight = 0;
  for (const [index, text] of rows.entries()) {
    const metrics = input.measureText(text, size);
    if (metrics === null || !Number.isFinite(metrics.advanceMm) || metrics.advanceMm < 0
      || !Object.values(metrics.inkBounds).every(Number.isFinite)
      || metrics.inkBounds.right < metrics.inkBounds.left || metrics.inkBounds.top < metrics.inkBounds.bottom) return null;
    widthMm = Math.max(widthMm, metrics.advanceMm, metrics.inkBounds.right - metrics.inkBounds.left);
    inkHeight = Math.max(inkHeight, metrics.inkBounds.top - metrics.inkBounds.bottom);
    texts.push({ text, position: [input.position[0] - metrics.inkBounds.left, input.position[1] - index * size * 1.4],
      sizeMm: size, anchor: 'start', baseline: 'bottom' });
  }
  const heightMm = (rows.length - 1) * size * 1.4 + inkHeight;
  const lines: DimensionLineSegment[] = [];
  let arrow: ArrowTriangle | null = null;
  let dot: NoteGeometry['dot'] = null;
  if (input.leader !== undefined) {
    const { target } = input.leader;
    const y = input.position[1] - (rows.length - 1) * size * 1.4 - 1;
    const fromRight = target[0] > input.position[0] + widthMm / 2;
    const elbow: Point2 = [input.position[0] + (fromRight ? widthMm + 1 : -1), y];
    const end: Point2 = [input.position[0] + (fromRight ? -1 : widthMm + 1), y];
    if (target[0] === elbow[0] && target[1] === elbow[1]) return null;
    lines.push({ from: target, to: elbow }, { from: elbow, to: end });
    if (input.leader.end === 'dot') dot = blackDot(target);
    else arrow = createArrowTriangle(target, [target[0] - elbow[0], target[1] - elbow[1]]);
  }
  return { texts, lines, arrow, dot, widthMm, heightMm };
}
