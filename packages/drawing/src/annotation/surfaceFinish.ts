import type { Point2 } from '../types.js';
import type { SemanticTextMetrics } from '../render/types.js';
import { createArrowTriangle, type ArrowTriangle } from '../dimension/arrow.js';
import type { ArcGeometry, DimensionLineSegment } from '../dimension/geometry.js';
import { dimensionNumberText } from '../dimension/numberText.js';
import type { SymbolGeometry, SymbolText } from './symbols.js';

export type SurfaceFinishProcess = 'basic' | 'removal' | 'noRemoval';
export interface SurfaceFinishInput {
  readonly process: SurfaceFinishProcess;
  readonly parameter: 'Ra' | 'Rz';
  readonly value: number;
  /** 紙面上の記号の下端。まとめて指示では呼出側が用紙の隅を指定する。 */
  readonly position: Point2;
  readonly sizeMm?: number;
  readonly target?: Point2;
  readonly general?: boolean;
  /** まとめ指示の括弧位置には実字体の測定値が必要。文字数で幅を推定しない。 */
  readonly measureText?: (text: string, sizeMm: number) => SemanticTextMetrics | null;
}
export interface SurfaceFinishGeometry extends SymbolGeometry {
  readonly leaderLines: readonly DimensionLineSegment[];
  readonly leaderArrow: ArrowTriangle | null;
  readonly general: boolean;
}

/** JIS B 0031/B 0601の基本・横棒・丸の区別とRa/Rzの意味:
 * https://jp.meviy.misumi-ec.com/info/ja/howto/54355/
 * 記号の60°、高さ2倍、字の左配置・間隔はP8 §0.27の慣用値(原典との照合は要確認)。 */
export function surfaceFinish(input: SurfaceFinishInput): SurfaceFinishGeometry | null {
  const size = input.sizeMm ?? 3.5;
  if (!Number.isFinite(input.value) || input.value < 0 || !Number.isFinite(size) || size <= 0
    || !input.position.every(Number.isFinite) || (input.target !== undefined && !input.target.every(Number.isFinite))
    || !['basic', 'removal', 'noRemoval'].includes(input.process) || !['Ra', 'Rz'].includes(input.parameter)) return null;
  const height = size * 2;
  const p = (x: number, y: number): Point2 => [input.position[0] + x, input.position[1] + y];
  const halfWidth = height / (2 * Math.sqrt(3));
  const lines: DimensionLineSegment[] = [
    { from: p(-halfWidth, height / 2), to: input.position },
    { from: input.position, to: p(halfWidth * 2, height) },
  ];
  const arcs: ArcGeometry[] = [];
  if (input.process === 'removal') lines.push({ from: p(-halfWidth, height / 2), to: p(halfWidth, height / 2) });
  if (input.process === 'noRemoval') arcs.push({ center: p(0, height / 3), radius: height / 6, startAngle: 0, endAngle: 2 * Math.PI });
  const text = `${input.parameter} ${dimensionNumberText(input.value, 6)}`;
  const textRight = -halfWidth - size / 2;
  const texts: SymbolText[] = [{ text, position: p(textRight, height / 2), sizeMm: size, anchor: 'end', baseline: 'bottom' }];
  const general = input.general === true;
  if (general) {
    const metrics = input.measureText?.(text, size) ?? null;
    if (metrics === null || !Number.isFinite(metrics.advanceMm) || metrics.advanceMm < 0
      || !Object.values(metrics.inkBounds).every(Number.isFinite)) return null;
    const left = textRight - metrics.advanceMm + Math.min(0, metrics.inkBounds.left);
    texts.push({ text: '(', position: p(left - size / 2, height / 2), sizeMm: height, anchor: 'end', baseline: 'middle' },
      { text: ')', position: p(halfWidth * 2 + size / 2, height / 2), sizeMm: height, anchor: 'start', baseline: 'middle' });
  }
  const leaderLines: DimensionLineSegment[] = [];
  let leaderArrow: ArrowTriangle | null = null;
  if (!general && input.target !== undefined) {
    const elbow: Point2 = [input.position[0], input.target[1]];
    const points = [input.target, elbow, input.position];
    for (let i = 0; i < 2; i += 1) {
      if (points[i][0] !== points[i + 1][0] || points[i][1] !== points[i + 1][1]) leaderLines.push({ from: points[i], to: points[i + 1] });
    }
    const first = leaderLines[0];
    if (first !== undefined) leaderArrow = createArrowTriangle(input.target, [first.from[0] - first.to[0], first.from[1] - first.to[1]]);
  }
  return { lines, arcs, centerLines: [], texts, leaderLines, leaderArrow, general };
}
