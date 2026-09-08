import type { DrawingLineType } from '../types.js';

/** 出典候補: JIS Z 8312。原典未照合のため要確認。 */
export const LINE_WIDTHS_MM = { thin: 0.25, thick: 0.5, extraThick: 1 } as const;

/** 出典候補: JIS Z 8312。線と空白の長さ(mm)は原典未照合のため要確認。 */
export const LINE_DASH_PATTERNS = {
  solid: [] as readonly number[],
  dashed: [3, 1] as const,
  chain: [10, 1, 1, 1] as const,
  chain2: [10, 1, 1, 1, 1, 1] as const,
  zigzag: [] as readonly number[],
} satisfies Readonly<Record<DrawingLineType, readonly number[]>>;

/** 出典候補: JIS Z 8313。文字高さの系列(mm)は原典未照合のため要確認。 */
export const TEXT_HEIGHTS_MM = [2.5, 3.5, 5, 7, 10, 14, 20] as const;
export const DEFAULT_DIMENSION_TEXT_HEIGHT_MM = 3.5;
export const DEFAULT_ANNOTATION_TEXT_HEIGHT_MM = 3.5;
export const DEFAULT_DRAWING_NUMBER_HEIGHT_MM = 7;

/** 出典候補: JIS Z 8317 / JIS B 0001。原典未照合のため要確認。 */
export const ARROW_LENGTH_MM = 3.5;
export const ARROW_INCLUDED_ANGLE_DEGREES = 15;
export const ARROW_WIDTH_MM = 2 * ARROW_LENGTH_MM * Math.tan(Math.PI / 24);

/** 寸法線周りの慣用値。原典未照合のため要確認。 */
export const DIMENSION_EXTENSION_GAP_MM = 1;
export const DIMENSION_EXTENSION_OVER_MM = 2;
export const DIMENSION_LINE_SPACING_MM = 8;

export type DrawingLineUsage =
  | 'outline'
  | 'hidden'
  | 'center'
  | 'cutting'
  | 'dimension'
  | 'extension'
  | 'leader'
  | 'hatching'
  | 'phantom'
  | 'break';

export interface LineStyle {
  readonly widthMm: number;
  readonly lineType: DrawingLineType;
}

/** 用途に対する線の既定を 1 か所で返す(FR-707)。 */
export function lineStyleFor(usage: DrawingLineUsage): LineStyle {
  switch (usage) {
    case 'outline':
      return { widthMm: LINE_WIDTHS_MM.thick, lineType: 'solid' };
    case 'hidden':
      return { widthMm: LINE_WIDTHS_MM.thin, lineType: 'dashed' };
    case 'center':
    case 'cutting':
      return { widthMm: LINE_WIDTHS_MM.thin, lineType: 'chain' };
    case 'phantom':
      return { widthMm: LINE_WIDTHS_MM.thin, lineType: 'chain2' };
    case 'break':
      return { widthMm: LINE_WIDTHS_MM.thin, lineType: 'zigzag' };
    case 'dimension':
    case 'extension':
    case 'leader':
    case 'hatching':
      return { widthMm: LINE_WIDTHS_MM.thin, lineType: 'solid' };
  }
}
