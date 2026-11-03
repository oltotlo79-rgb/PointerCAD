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
  DrawingLayer,
  DrawingLineType,
  DrawingParameter,
  DrawingSheet,
  DrawingSource,
  DrawingSheetFlatReference,
  DrawingSubShapeFingerprint,
  DrawingSubShapeRef,
  DrawingTable,
  DrawingTitleBlock,
  DrawingView,
  DrawingViewKind,
  Point2,
  Vector3,
} from './types.js';
export type { DrawingClipDefinition, DrawingPlaneDefinition, DrawingViewConstruction } from './view/construction.js';
export type { DatumDefinition, DatumId, DatumReference, DatumReferenceMember, GdtFrameSegment, GdtFeature, GdtShapeTarget,
  GdtToleranceValue, GeometricToleranceFrame, MaterialRequirement, ToleranceCharacteristic, ToleranceZone } from './gdt/types.js';
export { gdtSymbolGeometry } from './gdt/symbolGeometry.js';
export { gdtFrameGeometry, type GdtToken, type GdtDisplayRow } from './gdt/frameGeometry.js';
export { gdtDatumGeometry } from './gdt/datumGeometry.js';
export type { WeldKind, WeldLengthValue, WeldSideSpec, WeldSymbol } from './welding/types.js';
export { weldSymbolGeometry } from './welding/symbolGeometry.js';
export { weldGeometry, type WeldDisplaySide } from './welding/weldGeometry.js';
export type {
  AffineTransform2,
  InkBounds,
  PathCommand,
  RenderDocument,
  RenderPath,
  RenderPrimitive,
  RenderSubpath,
  RenderText,
} from './render/types.js';
export {
  bezierArc,
} from './render/bezierArc.js';
export { DRAWING_FONT_ASSET } from './text/fontAsset.js';
export { createFontStore, type DrawingFont, type FontLoadStatus, type OutlinedText } from './text/fontStore.js';
export { textOutline, type GlyphPathCommand } from './text/textOutline.js';
export { outlineCurves } from './text/outlineCurves.js';
export { toSvg } from './render/toSvg.js';
export { FIT_SYMBOLS, fitTolerance } from './dimension/fitTable.js';
export {
  DEFAULT_GENERAL_TOLERANCE_GRADE,
} from './annotation/generalTolerance.js';
export { drawingSymbol, type DrawingSymbolKind } from './annotation/symbols.js';
export { surfaceFinish, type SurfaceFinishProcess } from './annotation/surfaceFinish.js';
export {
  arrangeDimensions, dragDimensionPlacement,
  type DimensionArrangementItem, type DimensionTextBox,
} from './dimension/placement.js';
export {
  createCenterMarks, hideCenterMark,
  type CenterMark, type CenterMarkSource,
} from './dimension/centerMark.js';
export {
  layoutDimensionTolerance, resolveDimensionTolerance,
} from './dimension/tolerance.js';
export {
  dimensionSeries, drawingViewBasis,
  type DimensionSeriesInput, type DimensionSeriesResult,
  type DrawingViewBasis,
} from './dimension/series.js';

export {
  DEFAULT_PAPER_SIZE_ID,
  PAPER_SIZES,
  paperSizeOf,
  type PaperSize,
} from './paper/paperSize.js';
export {
  createPaperFrame,
  type FrameSegment,
} from './paper/frame.js';
export {
  STANDARD_SCALES,
  autoScale,
} from './layout/scale.js';
export {
  THIRD_ANGLE_DIRECTIONS,
  thirdAngleLayout,
} from './layout/thirdAngle.js';
export {
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_TITLE_BLOCK_HEIGHT_MM,
  formatDrawingScale,
} from './paper/titleBlock.js';
export {
  ISOMETRIC_DIRECTION,
} from './layout/isometric.js';
export {
  moveView,
  snapToAligned,
} from './layout/viewPlacement.js';
export { hatchArea, checkedHatchArea } from './hatch/hatchArea.js';
export { validateDrawingPolygon, MAX_DRAWING_BOUNDARY_POINTS } from './layout/validatePolygon.js';
export { hatchStyle } from './hatch/hatchStyle.js';
export { sectionBoundaryLoops } from './hatch/sectionHatch.js';
export {
  clipCurves,
  drawingRegionContainsPoint,
  type ClipCurve,
  type ClipRegion,
} from './layout/clipRegion.js';
export {
  createDetailView,
} from './layout/detailView.js';
export {
  applyBreak,
  movePointAcrossBreak,
  breakDrawingCurve,
  type BreakSpec,
} from './layout/breakOut.js';

export {
  LINE_DASH_PATTERNS,
  LINE_WIDTHS_MM,
  lineStyleFor,
} from './style/jisStyle.js';
export {
  DEFAULT_DRAWING_LAYERS,
  isValidLayerColor,
  resolveStyle,
} from './style/layers.js';

export type {
  Dimension,
  DimensionKind,
  DimensionMeasurement,
  DimensionPlacement,
  DimensionTarget,
  DimensionTolerance,
} from './dimension/types.js';
export { formatDimension } from './dimension/format.js';
export {
  createArrowTriangle,
  type ArrowTriangle,
} from './dimension/arrow.js';
export {
  createAngleDimensionGeometry,
  createDiameterDimensionGeometry,
  createLinearDimensionGeometry,
  createRadiusDimensionGeometry,
} from './dimension/geometry.js';
export { createProjectedArcLengthDimensionGeometry, type ProjectedArcLengthDimensionGeometry } from './dimension/arcLengthGeometry.js';

export { autoDimension, type AutoDimensionPoint, type AutoDimensionCircle } from './dimension/autoDimension.js';
export { renderDrawing, renderDrawingElements, type DrawingRenderCurve, type DrawingRenderElement, type DrawingRenderView } from './render/renderDrawing.js';

export { createPdf } from './render/pdfWriter.js';
export { toPdf } from './render/toPdf.js';
export { flattenRenderPath } from './render/flattenRenderPath.js';
export { note, type NoteGeometry } from './annotation/note.js';
export { tableLayout, type TableGeometry } from './table/tableLayout.js';
export { bomTable, type BomColumnId } from './table/bomTable.js';
export { drawingPrintOptions, readDrawingPrintOptions, type DrawingPrintOptions } from './paper/printSettings.js';

export { balloon, type BalloonCircle } from './table/balloon.js';
export { holeTable } from './table/holeTable.js';
export { revisionTable } from './table/revisionTable.js';
export type { SubShapeOrigin, CurrentOriginIndex } from './subShapeOrigin.js';


