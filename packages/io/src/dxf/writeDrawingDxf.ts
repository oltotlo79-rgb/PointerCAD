import { drawingToDxf } from '@pointercad/model';
import { writeDxfDocument } from './writeDxf.js';

export interface DrawingDxfResult {
  readonly text: string;
  readonly skippedPrimitiveCount: number;
  readonly flattenedCurveCount: number;
  readonly approximatedColorCount: number;
  readonly outlinedTextCount: number;
  readonly lineWidthsPreserved: false;
}

/** 幾何の変換は model、R12 の符号化は io に集約する。 */
export function writeDrawingDxf(...input: Parameters<typeof drawingToDxf>): DrawingDxfResult {
  const converted = drawingToDxf(...input);
  const written = writeDxfDocument(converted.entities, converted.options);
  return { text: written.text, skippedPrimitiveCount: converted.skippedPrimitiveCount,
    flattenedCurveCount: converted.flattenedCurveCount, approximatedColorCount: converted.approximatedColorCount,
    outlinedTextCount: converted.outlinedTextCount, lineWidthsPreserved: false };
}
