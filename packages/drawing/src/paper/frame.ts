import type { Point2 } from '../types.js';
import { paperSizeOf, type PaperSize, type PaperSizeId } from './paperSize.js';

export interface FrameSegment {
  readonly from: Point2;
  readonly to: Point2;
  readonly widthMm: number;
}

export interface FrameRectangle {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PaperFrame {
  readonly inner: FrameRectangle;
  readonly border: readonly FrameSegment[];
  readonly centerMarks: readonly FrameSegment[];
}

const FRAME_WIDTH_MM = 0.5;
/* 出典候補: JIS Z 8311。とじ代20mm・他10mm・中心マーク5mmは原典未照合のため要確認。 */
const BINDING_MARGIN_MM = 20;
const OTHER_MARGIN_MM = 10;
const CENTER_MARK_INSET_MM = 5;

function resolvePaper(paper: PaperSize | PaperSizeId): PaperSize {
  if (typeof paper !== 'string') {
    return paper;
  }
  const found = paperSizeOf(paper);
  if (found === undefined) {
    throw new Error(`知らない用紙です: ${paper}`);
  }
  return found;
}

/** 内枠と4辺の中心マークを素の線分で作る(FR-725)。 */
export function createPaperFrame(paperInput: PaperSize | PaperSizeId): PaperFrame {
  const paper = resolvePaper(paperInput);
  const inner: FrameRectangle = {
    left: BINDING_MARGIN_MM,
    bottom: OTHER_MARGIN_MM,
    right: paper.width - OTHER_MARGIN_MM,
    top: paper.height - OTHER_MARGIN_MM,
    width: paper.width - BINDING_MARGIN_MM - OTHER_MARGIN_MM,
    height: paper.height - 2 * OTHER_MARGIN_MM,
  };
  const border: readonly FrameSegment[] = [
    { from: [inner.left, inner.bottom], to: [inner.right, inner.bottom], widthMm: FRAME_WIDTH_MM },
    { from: [inner.right, inner.bottom], to: [inner.right, inner.top], widthMm: FRAME_WIDTH_MM },
    { from: [inner.right, inner.top], to: [inner.left, inner.top], widthMm: FRAME_WIDTH_MM },
    { from: [inner.left, inner.top], to: [inner.left, inner.bottom], widthMm: FRAME_WIDTH_MM },
  ];
  const middleX = paper.width / 2;
  const middleY = paper.height / 2;
  const centerMarks: readonly FrameSegment[] = [
    {
      from: [middleX, paper.height],
      to: [middleX, inner.top - CENTER_MARK_INSET_MM],
      widthMm: FRAME_WIDTH_MM,
    },
    {
      from: [middleX, 0],
      to: [middleX, inner.bottom + CENTER_MARK_INSET_MM],
      widthMm: FRAME_WIDTH_MM,
    },
    {
      from: [0, middleY],
      to: [inner.left + CENTER_MARK_INSET_MM, middleY],
      widthMm: FRAME_WIDTH_MM,
    },
    {
      from: [paper.width, middleY],
      to: [inner.right - CENTER_MARK_INSET_MM, middleY],
      widthMm: FRAME_WIDTH_MM,
    },
  ];
  return { inner, border, centerMarks };
}
