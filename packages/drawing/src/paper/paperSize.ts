export type PaperSeries = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';
export type PaperOrientation = 'landscape' | 'portrait';
export type PaperSizeId = `${PaperSeries}-${PaperOrientation}`;

export interface PaperSize {
  readonly id: PaperSizeId;
  readonly label: string;
  /** 幅(mm)。 */
  readonly width: number;
  /** 高さ(mm)。 */
  readonly height: number;
  readonly series: PaperSeries;
  readonly orientation: PaperOrientation;
}

/* 出典候補: JIS P 0138 の A列仕上寸法。原典未照合のため要確認。 */
const SERIES_DIMENSIONS: Readonly<Record<PaperSeries, readonly [number, number]>> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
};

function paperSize(series: PaperSeries, orientation: PaperOrientation): PaperSize {
  const [shortSide, longSide] = SERIES_DIMENSIONS[series];
  return {
    id: `${series}-${orientation}`,
    label: `${series} ${orientation === 'landscape' ? '横' : '縦'}`,
    width: orientation === 'landscape' ? longSide : shortSide,
    height: orientation === 'landscape' ? shortSide : longSide,
    series,
    orientation,
  };
}

/** A0〜A4 の縦横 10 種。既存の A3横・A4横・A4縦の値は維持する。 */
export const PAPER_SIZES: readonly PaperSize[] = (
  ['A0', 'A1', 'A2', 'A3', 'A4'] as const
).flatMap((series) => [paperSize(series, 'landscape'), paperSize(series, 'portrait')]);

/** A3 横を既定とする(FR-701)。 */
export const DEFAULT_PAPER_SIZE_ID: PaperSizeId = 'A3-landscape';

/** 知らない id なら undefined を返し、呼び出し側が理由を表示できるようにする。 */
export function paperSizeOf(id: string): PaperSize | undefined {
  return PAPER_SIZES.find((paper) => paper.id === id);
}
