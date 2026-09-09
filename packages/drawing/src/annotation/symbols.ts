import type { Point2 } from '../types.js';
import type { ArcGeometry, DimensionLineSegment } from '../dimension/geometry.js';

export type DrawingSymbolKind = 'thirdAngle' | 'depth' | 'counterbore' | 'countersink' | 'square' | 'arcLength' | 'sphere';
export interface SymbolText {
  readonly text: string;
  readonly position: Point2;
  readonly sizeMm: number;
  readonly anchor: 'start' | 'middle' | 'end';
  readonly baseline: 'alphabetic' | 'middle' | 'bottom' | 'top';
}
export interface SymbolGeometry {
  readonly lines: readonly DimensionLineSegment[];
  readonly arcs: readonly ArcGeometry[];
  /** 輪郭と区別し、中心線の線種で描く。 */
  readonly centerLines: readonly DimensionLineSegment[];
  readonly texts: readonly SymbolText[];
}

/** 第三角法の配置: SOLIDWORKS公式ヘルプ「Customizing a Symbol」。
 * https://help.solidworks.com/2018/english/SolidWorks/sldworks/t_customizing_a_symbol.htm
 * 同心円を左、小径端を左にした円錐台を右へ置く。20×8mmは慣用値(要確認)。
 * 深さ/ざぐり/皿もみの形: MISUMI JIS B 0001:2010抜粋。
 * https://sg.misumi-ec.com/tech-info/categories/technical_data/td01/g0049.html
 * 深さは上横棒・縦棒・矢印の両翼の4線。旧計画の2線では記号を表せない。
 * 比率・寸法は規格原典との照合が未完了のため、すべて慣用値・要確認。 */
export function drawingSymbol(kind: DrawingSymbolKind, sizeMm = 3.5, origin: Point2 = [0, 0]): SymbolGeometry | null {
  if (!Number.isFinite(sizeMm) || sizeMm <= 0 || !origin.every(Number.isFinite)) return null;
  const lines: DimensionLineSegment[] = [];
  const arcs: ArcGeometry[] = [];
  const centerLines: DimensionLineSegment[] = [];
  const texts: SymbolText[] = [];
  const p = (x: number, y: number, referenceSize = 1): Point2 => [origin[0] + x * (sizeMm / referenceSize), origin[1] + y * (sizeMm / referenceSize)];
  const line = (x0: number, y0: number, x1: number, y1: number, referenceSize = 1): DimensionLineSegment => ({
    from: p(x0, y0, referenceSize), to: p(x1, y1, referenceSize),
  });
  switch (kind) {
    case 'thirdAngle': {
      // mmの座標へ拡大率を一度だけ掛ける。1/3.5の往復で基準寸法を丸めない。
      lines.push(line(0, -2, 0, 2, 3.5), line(0, 2, 10, 4, 3.5),
        line(10, 4, 10, -4, 3.5), line(10, -4, 0, -2, 3.5));
      for (const radius of [2, 4]) {
        for (const start of [0, Math.PI]) arcs.push({ center: p(-6, 0, 3.5), radius: radius * (sizeMm / 3.5), startAngle: start, endAngle: start + Math.PI });
      }
      centerLines.push(line(-10, 0, 10, 0, 3.5), line(-6, -4, -6, 4, 3.5));
      break;
    }
    case 'depth':
      lines.push(line(0, 1, 1, 1), line(0.5, 1, 0.5, 0), line(0, 0.5, 0.5, 0), line(0.5, 0, 1, 0.5));
      break;
    case 'counterbore':
      lines.push(line(0, 1, 0, 0), line(0, 0, 1, 0), line(1, 0, 1, 1));
      break;
    case 'countersink':
      lines.push(line(0, 1, 0.5, 0.5), line(0.5, 0.5, 1, 1));
      break;
    case 'square':
      lines.push(line(0, 0, 1, 0), line(1, 0, 1, 1), line(1, 1, 0, 1), line(0, 1, 0, 0));
      break;
    case 'arcLength':
      arcs.push({ center: p(0.5, 0), radius: sizeMm / 2, startAngle: 0, endAngle: Math.PI });
      break;
    case 'sphere':
      texts.push({ text: 'S', position: origin, sizeMm, anchor: 'start', baseline: 'alphabetic' });
      break;
    default: return null;
  }
  return { lines, arcs, centerLines, texts };
}
