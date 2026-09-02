/**
 * 図面生成(要件 FR-7xx)。投影・寸法・JIS スタイル・SVG 生成は P6 で実装する。
 * P0 では用紙の既定値だけを定義する。
 */

export interface PaperSize {
  readonly id: 'A3-landscape' | 'A4-landscape' | 'A4-portrait';
  readonly label: string;
  /** 幅(mm)。 */
  readonly width: number;
  /** 高さ(mm)。 */
  readonly height: number;
}

/** A3 横を既定とする(FR-701)。 */
export const PAPER_SIZES: readonly PaperSize[] = [
  { id: 'A3-landscape', label: 'A3 横', width: 420, height: 297 },
  { id: 'A4-landscape', label: 'A4 横', width: 297, height: 210 },
  { id: 'A4-portrait', label: 'A4 縦', width: 210, height: 297 },
];

export const DEFAULT_PAPER_SIZE_ID = 'A3-landscape';

/** JIS の標準縮尺系列(FR-703)。 */
export const STANDARD_SCALES: readonly number[] = [
  1 / 10, 1 / 5, 1 / 2, 1, 2, 5, 10,
];
