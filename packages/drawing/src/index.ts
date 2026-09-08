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
