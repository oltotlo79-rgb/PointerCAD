/**
 * 図面生成(要件 FR-7xx)。図面文書・投影・寸法・JIS スタイル・出力は P8 で実装する。
 * このパッケージは他の PointerCAD パッケージへ依存しない純粋ロジックとする。
 */

export type {
  Annotation,
  Balloon,
  DrawingDocument,
  DrawingElementStyle,
  DrawingExpressionValue,
  DrawingFrameSettings,
  DrawingLayer,
  DrawingLineType,
  DrawingParameter,
  DrawingSheet,
  DrawingSource,
  DrawingSubShapeFingerprint,
  DrawingSubShapeRef,
  DrawingTable,
  DrawingTitleBlock,
  DrawingView,
  DrawingViewKind,
  Point2,
  Vector3,
} from './types.js';
export type {
  AffineTransform2,
  InkBounds,
  PathCommand,
  RenderClip,
  RenderDocument,
  RenderPath,
  RenderPrimitive,
  RenderStroke,
  RenderSubpath,
  RenderText,
  SemanticTextMetrics,
} from './render/types.js';
export {
  DEFAULT_ARC_TOLERANCE_MM, bezierArc, cubicBezierPoint, measureBezierRadialError,
  type BezierArc, type CubicBezierSegment,
} from './render/bezierArc.js';
export { DRAWING_FONT_ASSET } from './text/fontAsset.js';
export { createFontStore, parseDrawingFont, type DrawingFont, type FontLoadStatus, type OutlinedText } from './text/fontStore.js';
export { outlineInkBounds, textOutline, type GlyphPathCommand, type TextOutlineGeometry } from './text/textOutline.js';
export { outlineCurves, type OutlineContour, type OutlineCurve } from './text/outlineCurves.js';
export { toSvg, type SvgOptions } from './render/toSvg.js';
export { FIT_SYMBOLS, fitTolerance, formatFit, type FitSymbol, type FitTolerance } from './dimension/fitTable.js';
export {
  DEFAULT_GENERAL_TOLERANCE_GRADE, GENERAL_TOLERANCE_GRADES, generalToleranceNote,
  type GeneralToleranceGrade, type GeneralToleranceNote,
} from './annotation/generalTolerance.js';
export { drawingSymbol, type DrawingSymbolKind, type SymbolGeometry, type SymbolText } from './annotation/symbols.js';
export { surfaceFinish, type SurfaceFinishGeometry, type SurfaceFinishInput, type SurfaceFinishProcess } from './annotation/surfaceFinish.js';
export {
  arrangeDimensions, dragDimensionPlacement,
  type DimensionArrangementItem, type DimensionArrangementResult, type DimensionTextBox,
} from './dimension/placement.js';
export {
  CENTER_MARK_EXTENSION_MM, createCenterMarks, hideCenterMark,
  type CenterMark, type CenterMarkSource, type CenterMarkView,
} from './dimension/centerMark.js';
export {
  TOLERANCE_TEXT_HEIGHT_RATIO, layoutDimensionTolerance, resolveDimensionTolerance,
  type MeasureDimensionText, type ResolvedDimensionTolerance, type ToleranceTextLayout, type ToleranceTextRun,
} from './dimension/tolerance.js';
export {
  dimensionSeries, drawingViewBasis,
  type CoordinateDimensionRow, type DimensionSeriesInput, type DimensionSeriesPoint, type DimensionSeriesResult,
  type DrawingViewBasis, type ProgressiveDimensionTick, type SeriesDimension,
} from './dimension/series.js';

export {
  DEFAULT_PAPER_SIZE_ID,
  PAPER_SIZES,
  paperSizeOf,
  type PaperOrientation,
  type PaperSeries,
  type PaperSize,
  type PaperSizeId,
} from './paper/paperSize.js';
export {
  createPaperFrame,
  type FrameRectangle,
  type FrameSegment,
  type PaperFrame,
} from './paper/frame.js';
export {
  STANDARD_SCALES,
  autoScale,
  type AutoScaleInput,
  type AutoScalePaperBounds,
} from './layout/scale.js';
export {
  THIRD_ANGLE_DIRECTIONS,
  thirdAngleLayout,
  type OrthographicViewName,
  type SheetLayoutArea,
  type ThirdAngleLayout,
  type ThirdAngleLayoutInput,
  type ViewDirection,
} from './layout/thirdAngle.js';
export {
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_TITLE_BLOCK_HEIGHT_MM,
  DEFAULT_TITLE_BLOCK_WIDTH_MM,
  createTitleBlock,
  formatDrawingScale,
  type CreateTitleBlockInput,
  type ThirdAngleSymbol,
  type TitleBlockArc,
  type TitleBlockCell,
  type TitleBlockFieldDefinition,
  type TitleBlockLayout,
  type TitleBlockLine,
} from './paper/titleBlock.js';
export {
  ISOMETRIC_DIRECTION,
  ISOMETRIC_X_DIRECTION,
  isometricViewDirection,
} from './layout/isometric.js';
export {
  VIEW_ALIGNMENT_TOLERANCE_MM,
  effectiveViewScale,
  moveView,
  snapToAligned,
  viewTitle,
  type ViewAlignmentGuide,
} from './layout/viewPlacement.js';
export { hatchArea, type HatchAreaInput, type HatchSegment } from './hatch/hatchArea.js';
export { hatchStyle, type HatchStyle } from './hatch/hatchStyle.js';
export {
  clipCurves,
  regionContainsAnyCurvePoint,
  type ClipCurve,
  type ClipRegion,
} from './layout/clipRegion.js';
export {
  createDetailView,
  type DetailCurve,
  type DetailViewInput,
  type DetailViewResult,
} from './layout/detailView.js';
export {
  applyBreak,
  type BreakLine,
  type BreakResult,
  type BreakSpec,
} from './layout/breakOut.js';

export {
  ARROW_INCLUDED_ANGLE_DEGREES,
  ARROW_LENGTH_MM,
  ARROW_WIDTH_MM,
  DEFAULT_ANNOTATION_TEXT_HEIGHT_MM,
  DEFAULT_DIMENSION_TEXT_HEIGHT_MM,
  DEFAULT_DRAWING_NUMBER_HEIGHT_MM,
  DIMENSION_EXTENSION_GAP_MM,
  DIMENSION_EXTENSION_OVER_MM,
  DIMENSION_LINE_SPACING_MM,
  LINE_DASH_PATTERNS,
  LINE_WIDTHS_MM,
  TEXT_HEIGHTS_MM,
  lineStyleFor,
  type DrawingLineUsage,
  type LineStyle,
} from './style/jisStyle.js';
export {
  DEFAULT_DRAWING_LAYERS,
  isElementPrintable,
  isElementVisible,
  isValidLayerColor,
  resolveStyle,
  type LayerStyledElement,
  type ResolvedDrawingStyle,
} from './style/layers.js';

export type {
  Dimension,
  DimensionKind,
  DimensionMeasurement,
  DimensionPlacement,
  DimensionTarget,
  DimensionTolerance,
} from './dimension/types.js';
export { formatDimension, type FormatDimensionInput } from './dimension/format.js';
export {
  blackDot,
  createArrowTriangle,
  shouldUseOutwardArrows,
  type ArrowTriangle,
  type BlackDot,
} from './dimension/arrow.js';
export {
  createAngleDimensionGeometry,
  createArcLengthDimensionGeometry,
  createDiameterDimensionGeometry,
  createLinearDimensionGeometry,
  createRadiusDimensionGeometry,
  type AngleDimensionGeometry,
  type ArcGeometry,
  type ArcLengthDimensionGeometry,
  type DiameterDimensionGeometry,
  type DimensionLineSegment,
  type LinearDimensionGeometry,
  type RadiusDimensionGeometry,
} from './dimension/geometry.js';

export { autoDimension, type AutoDimensionInput, type AutoDimensionPoint, type AutoDimensionCircle, type AutoDimensionResult } from './dimension/autoDimension.js';
export { renderDrawing, type DrawingRenderCurve, type DrawingRenderElement, type DrawingRenderView, type RenderDrawingOptions,
  type DrawingRenderIssue, type DrawingRenderResult } from './render/renderDrawing.js';

export { createPdf, PDF_POINTS_PER_MM, type PdfOptions, type PdfResult } from './render/pdfWriter.js';
export { toPdf } from './render/toPdf.js';
export { flattenRenderPath, type FlattenedRenderPath } from './render/flattenRenderPath.js';
export { note, type NoteInput, type NoteGeometry } from './annotation/note.js';
export { tableLayout, type TableColumn, type TableLayoutInput, type TableGeometry } from './table/tableLayout.js';
export { bomTable, type DrawingBomRow, type BomColumnId, type BomTableInput, type BomTableGeometry } from './table/bomTable.js';
export { drawingPrintOptions, readDrawingPrintOptions, type DrawingPrintOptions } from './paper/printSettings.js';
