import { createPaperFrame } from '../paper/frame.js';
import { paperSizeOf, type PaperOrientation, type PaperSizeId } from '../paper/paperSize.js';

/** JIS の推奨縮尺列候補。原典未照合のため要確認。既存7値をすべて含む(FR-703)。 */
export const STANDARD_SCALES: readonly number[] = [
  1 / 100, 1 / 50, 1 / 20, 1 / 10, 1 / 5, 1 / 2, 1, 2, 5, 10, 20,
];

export interface AutoScalePaperBounds {
  readonly width: number;
  readonly height: number;
}

export interface AutoScaleInput {
  readonly paperSizeId: PaperSizeId;
  readonly orientation: PaperOrientation;
  readonly titleBlockHeight: number;
  /** モデル境界箱の W(X), D(Y), H(Z)。 */
  readonly extents: readonly [number, number, number];
  /** 図の間隔(mm)。縮尺を掛けない。 */
  readonly gap: number;
  /** 寸法・文字・表まで含む最終境界を検査する任意の口。 */
  readonly finalBoundsAtScale?: (scale: number) => AutoScalePaperBounds;
}

/** 三面図が収まる最大の標準縮尺。収まる値が無ければ null(FR-703)。 */
export function autoScale(input: AutoScaleInput): number | null {
  const series = input.paperSizeId.slice(0, 2);
  const paper = paperSizeOf(`${series}-${input.orientation}`);
  if (paper === undefined) {
    return null;
  }
  const frame = createPaperFrame(paper);
  const availableWidth = frame.inner.width;
  const availableHeight = frame.inner.height - input.titleBlockHeight;
  const [width, depth, height] = input.extents;
  if (
    width < 0 || depth < 0 || height < 0 || input.gap < 0 ||
    availableWidth <= input.gap || availableHeight <= input.gap
  ) {
    return null;
  }

  // 2026-09-07 訂正: 紙上で一定の gap は分子から引き、モデル寸法だけを縮尺倍する。
  const maximum = Math.min(
    (availableWidth - input.gap) / (width + depth),
    (availableHeight - input.gap) / (height + depth),
  );
  for (let index = STANDARD_SCALES.length - 1; index >= 0; index -= 1) {
    const candidate = STANDARD_SCALES[index];
    if (candidate > maximum) {
      continue;
    }
    const finalBounds = input.finalBoundsAtScale?.(candidate);
    if (
      finalBounds !== undefined &&
      (finalBounds.width > availableWidth || finalBounds.height > availableHeight)
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}
