export { resolveGdtFeature, type ResolvedGdtFeature } from './drawing/gdt.js';
export { compatibleGdtSizeDimensions } from './drawing/gdtAttachment.js';
export { drawingMedianPlaneFeature } from './drawing/gdtMedianPlane.js';
export { dimensionAngleDirections } from './drawing/dimensionAngle.js';
export { drawingDimensionPaperEnds } from './drawing/dimensionTarget.js';
export { GDT_RULES, defaultGdtToleranceZone, datumMembers, resolveDrawingDatums, resolveGdtFrame, gdtFrameDisplayRows, resolveDrawingGdt,
  type DrawingGdtResolution, type GdtIssue, type GdtRule, type ResolvedDatum, type ResolvedFrameSegment, type ResolvedGdtFrame } from './drawing/gdtValidation.js';
export { drawingManufacturingIds, nextDatumLabel, putDrawingDatum, putDrawingGdtFrame, moveDrawingManufacturing,
  type DrawingGdtEditResult } from './drawing/gdtEdit.js';
export { duplicateDrawingGdt, type DrawingGdtCopyResult } from './drawing/gdtCopy.js';
export { resolveWeldSymbol, resolveDrawingWelds, putDrawingWeld, type WeldIssue, type ResolvedWeldSide, type ResolvedWeldSymbol } from './drawing/welding.js';
export { weldDisplaySides } from './drawing/weldDisplay.js';
export type { DatumDefinition, DatumId, DatumReference, GdtFrameSegment, GdtFeature, GeometricToleranceFrame,
  MaterialRequirement, ToleranceCharacteristic, ToleranceZone } from './drawing/gdt.js';
export type { GdtShapeTarget, GdtToleranceValue, WeldKind, WeldLengthValue, WeldSideSpec, WeldSymbol } from '@pointercad/drawing';
export {
  createDirectKernelBridge,
  createDirectInterferenceKernelBridge,
  type InterferenceKernelBridge,
  type AssemblyInterferenceInput,
  type AssemblyInterferenceOptions,
  type AssemblyInterferencePairId,
  type AssemblyInterferencePair,
  type AssemblyInterferencePairFailure,
  type AssemblyInterferenceProgress,
  type AssemblyInterferenceMesh,
  type AssemblyInterferenceReport,
  type AssemblyInterferenceResult,
  type AssemblyInterferenceRootFailure,
  createKernelBridge,
  createKernelHealth,
  KERNEL_BROKEN_MESSAGE,
  rematchSubShapeRef,
  selectSubShape,
  selectMateTargetGeometry,
  // 角の丸め・面取りの形を求める同期の純関数(FR-323、P4 タスク18・19)。ui の予告表示
  // (`cornerCommands.ts`)が、確定に使うのとまったく同じ式で形を先に見せるために使う。
  // 式の正本は kernel 側の 1 か所だけなので、写して 2 か所に持つことはしない。
  sketchChamferGeometry,
  sketchFilletGeometry,
  // 書き出し・読み込みの口(FR-802〜804、P6 タスク32b)。**ui は kernel を輸入できない**
  // (依存の向きは ui → model → kernel)ので、依頼と結果の言葉をここで受け渡す。
  type ExportColor,
  type ExportedFile,
  type ExportedMeshBody,
  type ImportedBody,
  type ImportedTriangles,
  type KernelBridge,
  type DrawingKernelBridge,
  type DrawingOperationOptions,
  type DrawingOperationProgress,
  type KernelHealth,
  type MateSubShapeGeometry,
  type PartCancelToken,
  type PartProgress,
  type PartProgressCallback,
  type SketchChamferGeometry,
  type SketchCornerPlane,
  type SketchCornerSegment,
  type SketchFaceFailure,
  type SketchFilletGeometry,
  type SketchOffsetContour,
  type SketchOffsetEntry,
  type SketchOffsetFailure,
  type SketchOffsetRequestItem,
  type SketchOffsetResult,
  type SketchProjectionEntry,
  type SketchProjectionFailure,
  type SketchProjectionRequestItem,
  type SketchProjectionResult,
  type SketchTessellationOutcome,
  type ShapeExportBody,
  type ShapeExportFormat,
  type ShapeExportOptions,
  type ShapeExportOutcome,
  type ShapeImportOptions,
  type ShapeImportOutcome,
  type SolidBody,
  type SolidBodyFailure,
  type SolidBodyMeshData,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SolidRecomputeOptions,
  type SolidRecomputeOutcome,
  type SolidVertexEntry,
  type ThreadMarkEntry,
} from './kernelBridge.js';
export type { Vec3 } from './sketch/vec3.js';
export {
  addVec3, cleanZeroVec3, crossVec3, distanceVec3, dotVec3, isSamePoint, lengthVec3,
  lerpVec3, mirrorVec3, normalizeVec3, ORIGIN, rotateAboutAxis, rotateDirection, scaleVec3,
  SKETCH_TOLERANCE_MM, subVec3,
} from './sketch/vec3.js';
export type { BaseWorkPlaneId, WorkPlane, WorkPlaneId } from './sketch/planeMath.js';
export {
  baseWorkPlane, DEFAULT_WORK_PLANE_ID, degreesToRadians, directionInPlane, distanceToPlane,
  FREE_WORK_PLANE_ID, isBaseWorkPlaneId, isFreeWorkPlaneId, planeAxesFor, planeToWorld,
  polarOffset, projectOntoPlane, radiansToDegrees, tiltedDirection, WORK_PLANE_IDS, WORK_PLANES,
  WORLD_AXIS_DIRECTIONS, worldToPlane,
} from './sketch/planeMath.js';
export type {
  AxisFrame, AxisSpec, PlaneErrorKey, PlaneOutcome, PlaneResolveContext, PlaneSpec,
  ResolvedPlane, ResolvedSubShape,
} from './geometry/planeSpec.js';
export {
  planeFromNormal, planeSpecKeyText, resolvePlaneSpec, subShapeFromFingerprint,
} from './geometry/planeSpec.js';
/** 3D スケッチの 3 点(始点・終点・通過点)の円弧(FR-330、P4 タスク36)。 */
export type { ArcThroughPointsResult } from './geometry/arcThroughPoints.js';
export { arcThroughPoints } from './geometry/arcThroughPoints.js';
export type {
  CoordinateInput, CopyPlacement, FreeArcOrientation, MirrorBasis, OffsetContourShape,
  OffsetCornerKind, OffsetSide,
  PendingOffset, PendingProjection, PointArrayLayout, PointReference, ProjectionSource,
  ResolvedArc,
  ResolvedCurve, ResolvedEllipse,
  ResolvedFace, ResolvedPoint, ResolvedSegment, ResolvedSketch, ResolvedSpline, SketchArcFeature,
  SketchCopyFeature,
  SketchDocument, SketchElementRef, SketchEllipseFeature, SketchError, SketchErrorCode,
  SketchFaceFeature, SketchFaceMesh, SketchFeature, SketchFeatureKind, SketchLineFeature,
  SketchMesh, SketchOffsetFeature, SketchPointArrayFeature, SketchPointFeature,
  SketchPlaneSectionFeature, SketchPolygonFeature, SketchProjectedCurveFeature,
  SketchRectangleFeature, SketchSlotFeature, SketchSplineFeature,
} from './sketch/types.js';
export { projectionBodyFeatureId } from './sketch/types.js';
/** 拘束(FR-313、P4b タスク4)。型と、変数の切り出し・自由度の数え方。 */
export type {
  ConstraintTarget, SketchConstraint, SketchConstraintKind,
} from './sketch/constraints/types.js';
export {
  CONSTRAINT_EQUATION_COUNTS, constraintEquationCount, constraintTargets,
  SKETCH_CONSTRAINT_KINDS, sketchConstraints,
} from './sketch/constraints/types.js';
export type {
  ConstraintVariable, DegreesOfFreedomCount, FrozenReason, ImplicitCircleEquation, RadiusKind,
  VariableSet,
} from './sketch/constraints/variables.js';
export {
  canonicalPointKey, collectVariables, constraintPointKey, countDegreesOfFreedom,
  curveEndpointKeys, featureIdOfPointKey, MAX_CONSTRAINT_VARIABLES, pointComponentKey,
  pointValueAt, radiusComponentKey, radiusValueAt, variableComponentKey,
} from './sketch/constraints/variables.js';
/** 拘束の残差とヤコビアン(FR-313、P4b タスク5)。 */
export type {
  ResidualReport, ResidualRow, ResidualSkipReason, SkippedResidual,
} from './sketch/constraints/residuals.js';
export {
  buildResidualReport, buildResiduals, IMPLICIT_CONSTRAINT_ID_PREFIX, implicitEquationId,
  isImplicitConstraintId,
} from './sketch/constraints/residuals.js';
/** 連立の解き方(FR-313、NFR-PF-2、P4b タスク6)。行列の道具と Levenberg–Marquardt。 */
export type {
  LinearizedRow, QrDecomposition, SolveIterationRecord, SolveOptions, SolveOutcome, SolveStopReason,
} from './sketch/constraints/solve.js';
export {
  CONSTRAINT_INITIAL_DAMPING, CONSTRAINT_MAX_ITERATIONS, CONSTRAINT_TOLERANCE, matrixRank,
  qrDecomposition, solveLeastSquares, solveLevenbergMarquardt, solveLinearSystem,
} from './sketch/constraints/solve.js';
/** 拘束の診断(足りない・足しすぎ・矛盾。FR-313、NFR-UX-5、P4b タスク7)。 */
export type {
  ConflictingConstraint, ConstraintDiagnosis, ConstraintDiagnosisMessage,
  ConstraintDiagnosisMessageKind, DiagnoseOptions, RedundantConstraint, RedundantReason,
} from './sketch/constraints/diagnose.js';
export {
  CONFLICT_REPORT_LIMIT, CONSTRAINT_TOO_MANY_MESSAGE, diagnoseConstraints, remainingMessage,
} from './sketch/constraints/diagnose.js';
/** 3 段の解決への差し込み(FR-313、FR-504、P4b タスク8)。拘束を解いてから解決し直す。 */
export type {
  ConstrainedSketch, ConstrainedSolveOptions,
} from './sketch/constraints/solveSketch.js';
export {
  CONSTRAINT_FREE_SKETCH_MESSAGE, CONSTRAINT_UNSOLVED_MESSAGE, DRAG_PIN_WEIGHT,
  resolveConstrainedSketch,
} from './sketch/constraints/solveSketch.js';
export {
  absoluteCoordinate, appendFeature, createEmptySketchDocument, createPointFeature,
  DEFAULT_FACE_COLOR, findFeature, nextFeatureId, nextFeatureName, removeFeature, replaceFeature,
} from './sketch/createSketchDocument.js';
export type { ResolveContext, ResolveOutcome } from './sketch/resolveCoordinate.js';
export {
  resolveCoordinate, resolvePointReference, vertexKey,
} from './sketch/resolveCoordinate.js';
/** 球面上の点(FR-431、P5 タスク19)。 */
export type { ResolvedSphere } from './sketch/resolveCoordinate.js';
export {
  LATITUDE_RANGE_MESSAGE, MISSING_SPHERE_MESSAGE, sphereGridPosition,
} from './sketch/resolveCoordinate.js';
export type { SketchResolveOptions } from './sketch/resolveSketch.js';
export {
  arcPointAt, azimuthToEllipseParameter, curveEnd, curveStart, ellipsePointAt, fitPlaneNormal,
  isFullCircle, isFullEllipse, isPlanar, MAX_POINT_ARRAY_COUNT, resolveSketch,
} from './sketch/resolveSketch.js';
export type {
  CurveChain, CurveChainOptions, CurveChainOutcome, CurveEvaluator, CurveIntersection,
} from './sketch/intersectionMath.js';
export {
  curveEvaluator, curveIntersections, curveParameterNear, curvePointAt, FULL_TURN,
  INTERSECTION_TOLERANCE_MM, isClosedCurve, segmentSegmentIntersection, traceCurveChain,
} from './sketch/intersectionMath.js';
export type { ExtendRequest, TrimErrorKey, TrimOutcome, TrimRequest } from './sketch/trimExtend.js';
export {
  explodeCompoundFeature, extendCurve, nearestCurveEnd, parseElementId, trimCurve,
} from './sketch/trimExtend.js';
export type {
  SketchChamferRequest, SketchCornerElements, SketchCornerErrorKey, SketchCornerOutcome,
  SketchFilletRequest,
} from './sketch/cornerCommands.js';
export { chamferCorner, filletCorner } from './sketch/cornerCommands.js';
export type { CopyOutcome, CopySourceLookup, SketchTransform } from './sketch/copyMath.js';
export {
  checkCopyCount, circularArrayTransforms, collectCopySource, linearArrayTransforms,
  MAX_COPY_COUNT, MIN_COPY_COUNT, mirrorTransform, resolveCopyFeature, resolveCopyTransforms,
  transformCurve, transformDirection, transformPoint, translateTransform,
} from './sketch/copyMath.js';
export type { SplineCurveData } from './sketch/splineMath.js';
export {
  hasDuplicateSplinePoint, MAX_SPLINE_POINTS, MIN_CLOSED_SPLINE_POINTS, MIN_SPLINE_POINTS,
  sampleSpline, sampleSplineCurve, splineCurveData, splineDegree, splinePointAt,
  SPLINE_SEGMENTS_PER_SPAN,
} from './sketch/splineMath.js';
export type {
  AxisShift, CoordinateShift, FeatureShiftPlan, OriginShift, ShiftAxes,
} from './sketch/shiftCoordinate.js';
export {
  normalShiftAxis, originShiftFromPosition, planeShiftAxes, shiftCoordinateInput,
  shiftExpression, shiftSketchDocument, shiftSketchFeature, worldShiftAxes,
} from './sketch/shiftCoordinate.js';
export type { OriginTarget } from './part/shiftOrigin.js';
export { originShiftFor, shiftOrigin } from './part/shiftOrigin.js';
export type { SketchRecomputeOptions, SketchRecomputeResult } from './sketch/recomputeSketch.js';
export { recomputeSketch, reevaluateDocument } from './sketch/recomputeSketch.js';
export type { OffsetCache, OffsetKeyMaterial } from './sketch/offsetMath.js';
export {
  closedOffsetDistance, createOffsetCache, offsetCacheKey, offsetDisplacement, offsetSideOf,
  OFFSET_CACHE_CAPACITY,
} from './sketch/offsetMath.js';
export type { ProjectionCache, ProjectionKeyMaterial } from './sketch/projectionMath.js';
export {
  createProjectionCache, projectionCacheKey, PROJECTION_CACHE_CAPACITY,
} from './sketch/projectionMath.js';
export type { SubShapeCache } from './part/subShapeCache.js';
export { createSubShapeCache } from './part/subShapeCache.js';
export type { MetricThreadSize, ThreadSeries } from './thread/metricThread.js';
export {
  DEFAULT_THREAD_DESIGNATION, findMetricThread, METRIC_THREAD_DESIGNATIONS, METRIC_THREADS,
  metricThreadPitch, threadMinorDiameter, threadPitchDiameter, threadTriangleHeight,
} from './thread/metricThread.js';
export type {
  BooleanFeature, BooleanOperation, ChamferFeature, ChamferSize, ExtrudeFeature,
  FilletFeature, HoleDepth, HoleFeature, PartDocument, PatternDirection,
  PatternFeature, PatternPlacement, ReferenceAxisDefinition, ReferenceAxisFeature,
  ReferenceCoordinateSystemFeature, ReferenceFeature, ReferenceFeatureKind,
  ReferencePlaneFeature, ReferencePointDefinition, ReferencePointFeature,
  RevolveAxis, RevolveFeature, SewFeature, SketchFaceRef,
  SketchLineRef, SketchPointRef, SolidFeature, SolidFeatureKind, SpringDerived, SpringFeature,
  SpringHandedness, ThreadHoleFeature,
  ThreadRepresentation,
} from './part/types.js';
/** パラメータ表(名前を付けた数値。FR-207、P4b タスク2)。 */
export type {
  Parameter, ParameterAnalysis, ParameterFailure, ParameterOrder, ParameterUnit,
} from './parameters/types.js';
export { PARAMETER_UNITS } from './parameters/types.js';
export {
  addParameter, analyzeParameters, nextParameterName, PARAMETER_LABEL, parameterDependencies,
  parameterEvaluationOrder, referencesTo, removeParameter, renameParameter, reorderParameters,
  replaceParameter,
} from './parameters/parameterTable.js';
/** 図面文書の生成・採番・参照元・レイヤー編集(P8 タスク4・7)。 */
export type {
  Annotation,
  Balloon,
  Dimension,
  DimensionTarget,
  DrawingPlaneDefinition,
  DrawingClipDefinition,
  DrawingViewConstruction,
  DrawingDocument,
  DrawingElementStyle,
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
  Point2 as DrawingPoint2,
  Vector3 as DrawingVector3,
} from '@pointercad/drawing';
export {
  DRAWING_SCHEMA_VERSION,
  appendDrawingAnnotation,
  appendDrawingBalloon,
  appendDrawingDimension,
  appendDrawingLayer,
  appendDrawingTable,
  appendDrawingView,
  createDrawingDocument,
  nextDrawingAnnotationId,
  nextDrawingBalloonId,
  nextDrawingDimensionId,
  nextDrawingLayerId,
  nextDrawingTableId,
  nextDrawingViewId,
} from './drawing/createDrawingDocument.js';
export type {
  DrawingSourceDocument,
  DrawingSourceInput,
  DrawingSourceLibrary,
  EmbeddedDrawingSource,
  EmbedDrawingSourceOptions,
  EmbedDrawingSourceResult,
} from './drawing/sourceLibrary.js';
export {
  canonicalDrawingSourceText,
  drawingSourceContentHash,
  drawingSourceInputHash,
  drawingSourceInputOf,
  drawingSourceDocumentOf,
  embedDrawingSource,
  emptyDrawingSourceLibrary,
  replaceDrawingSource,
} from './drawing/sourceLibrary.js';
export type {
  DrawingLayerEditResult,
  NewDrawingLayer,
  RemoveDrawingLayerResult,
} from './drawing/layerEdit.js';
export {
  DUPLICATE_DRAWING_LAYER_NAME_MESSAGE,
  INVALID_DRAWING_LAYER_COLOR_MESSAGE,
  addDrawingLayer,
  removeDrawingLayer,
  reorderDrawingLayer,
  replaceDrawingLayer,
} from './drawing/layerEdit.js';
export type {
  CuttingLineArrow,
  CuttingLineGeometry,
  CuttingLineSegment,
  SectionSpec,
} from './drawing/sectionSpec.js';
export {
  createCuttingLine,
  sectionLetter,
  validateSectionSpec,
} from './drawing/sectionSpec.js';
export type {
  AuxiliaryDirectionOutcome,
  DrawingDirection,
} from './drawing/viewDirection.js';
export {
  auxiliaryDirectionFromPlane,
  auxiliaryPlacementDirection,
  createPartialProjection,
  resolveAuxiliaryDirection,
} from './drawing/viewDirection.js';
export type {
  DrawingProjectionCurve,
  DrawingProjectionRequest,
  DrawingProjectionResult,
  DrawingSectionRequest,
  DrawingSectionResult,
  DrawingResolutionOptions,
  DrawingResolveKernel,
  DrawingSourceResolution,
  DrawingInstance,
  ResolvedDrawing,
  ResolvedDrawingCurve,
  ResolvedDrawingView,
} from './drawing/resolveDrawing.js';
export {
  clearDrawingProjectionCache,
  createDrawingResolveKernel,
  resolveDrawing,
} from './drawing/resolveDrawing.js';
export type {
  EdgeCurveKind, FaceSurfaceKind, SubShapeFingerprint, SubShapeKind, SubShapeRef,
} from './geometry/subShapeRef.js';
export {
  dedupeSubShapeRefs, fingerprintKeyText, isSameSubShape, subShapeKindOf,
} from './geometry/subShapeRef.js';
export type { SolidLabelKey } from './part/createPartDocument.js';
export {
  addSketch, appendReference, appendSolid, consumedBodyIds, consumedTargetsOf,
  createEmptyPartDocument, createSketchFor,
  DEFAULT_CHAMFER_ANGLE_DEGREES, DEFAULT_CHAMFER_DISTANCE_MM, DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM, DEFAULT_HOLE_DEPTH_MM, DEFAULT_HOLE_DIAMETER_MM, DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM, DEFAULT_SEW_TOLERANCE_MM, DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM, DEFAULT_SPRING_TURNS, DEFAULT_SPRING_WIRE_DIAMETER_MM, findReference,
  findSketch,
  findSolid, isMachiningFeature, isPatternSource, liveBodyIds, MAX_PATTERN_COUNT, MAX_SPRING_TURNS,
  nextReferenceId, nextReferenceName, nextSketchId, nextSketchName, nextSolidId, nextSolidName,
  PART_SCHEMA_VERSION,
  REFERENCE_LABELS, removeReference, removeSketch, removeSolid, replaceReference, replaceSketch,
  replaceSolid,
  setActiveSketch, SKETCH_LABEL, SOLID_LABELS,
} from './part/createPartDocument.js';
/*
 * ひな形(FR-814、P6 §2.10、タスク27)。**画面(`packages/ui` のタスク33)から呼ぶので
 * ここへ並べる。** 中身は文書だけを見る純関数で、ファイルの読み書きにも画面にも触れない。
 */
export type {
  DocumentFromTemplateOptions, OpenTemplateResult, PartTemplate, TemplateFileContents,
  TemplateFromDocumentOptions, TemplateNotice, TemplateRefusal, ToolDefaults,
} from './part/templates.js';
export {
  createEmptyPartTemplate, DEFAULT_CIRCLE_RADIUS_MM, DEFAULT_EXTRUDE_DISTANCE_MM,
  DEFAULT_TEMPLATE_LENGTH_UNIT, DEFAULT_TOOL_DEFAULTS, documentFromTemplate, openTemplate,
  templateFromDocument, TOOL_DEFAULT_KEYS,
} from './part/templates.js';
export type {
  ReferenceError, ReferenceErrorCode, ReferenceResolveDeps, ReferenceResolver,
  ResolvedReferenceAxis, ResolvedReferenceCoordinateSystem, ResolvedReferencePlane,
  ResolvedReferencePoint, ResolvedReferences,
} from './part/resolveReferences.js';
export {
  createReferenceResolver, workPlaneFromResolved,
} from './part/resolveReferences.js';
export type {
  BooleanKeyMaterial, ChamferKeyMaterial, ExtrudeKeyMaterial, FilletKeyMaterial, HoleKeyMaterial,
  KeyArc, KeyCurve, KeyEllipse, KeySegment, KeySpline, KeySubShape, KeyTransform, KeyVec3,
  RevolveKeyMaterial, SewKeyMaterial, SolidStepKeyMaterial, SpringKeyMaterial, ThreadKeyMaterial,
} from './part/cacheKey.js';
export { cacheKeyFor, hash64, KEY_DECIMALS } from './part/cacheKey.js';
export type {
  HoleCentersOutcome, MachiningTargetOutcome, PartError, PartErrorCode, ResolvedPart,
  ResolvedPartSketch, ResolvedProjection, ResolvedSolidStep, ResolvePartOptions,
  RevolveAxisFrame, RigidTransform, SolidStepPlan,
  SubShapeQueryPlan,
} from './part/resolvePart.js';
export {
  referencedSketchIds,
  resolveHoleCenters, resolveMachiningTarget, resolvePart, resolvePatternTransforms,
  resolveRevolveAxis, resolveSpringLength, resolveSpringOrigin, resolveTiltedDirection,
  translateCurve,
} from './part/resolvePart.js';
/**
 * タイムライン(FR-507)と途中までの文書(FR-506、ロールバック。P4b タスク9)。
 * 帯の並び・依存グラフ・並べ替えの可否・つまみの位置での差し込み。
 */
export type {
  MoveCheck, ReorderOutcome, ReorderRefusal, TimelineEntry, TimelineSection,
} from './part/timelineOrder.js';
export {
  buildTimeline, canMoveHistoryItem, dependenciesOf, documentUpTo, historyDependencies,
  insertPositionAt, moveHistoryItem, reorderTimeline, timelineIndexOf,
} from './part/timelineOrder.js';
export type {
  PartRecomputeError, PartRecomputeOptions, PartRecomputeResult, PartSketchResult,
} from './part/recomputePart.js';
export { recomputePart } from './part/recomputePart.js';
export { resolveConstrainedAssembly, type ConstrainedAssemblyResult } from './assembly/resolveConstrainedAssembly.js';
export { drawingSourceCenter } from './drawing/sourceCenter.js';
/**
 * 部品文書の全式の評価し直し(FR-207、FR-502、P4b タスク3)。
 * パラメータ表の値を 1 か所変えると、参照している全ての欄が追従する仕組みの入口。
 */
export type {
  AppliedParameters, ExpressionOwner, PartReevaluation, ReevaluationFailure,
} from './part/reevaluatePart.js';
export {
  applyParameters, collectExpressionOwners, collectExpressionSources, reevaluatePartDocument,
  renameVariableInPartDocument,
} from './part/reevaluatePart.js';
export type { PushUndoOptions, UndoStack } from './history/undoStack.js';
export {
  canRedo, canUndo, createUndoStack, pushUndo, redo, undo, UNDO_COALESCE_MS, UNDO_LIMIT,
} from './history/undoStack.js';
/** 外観(FR-1106〜1110、P5 タスク1・2)。 */
export { affectsShape } from './part/documentChange.js';
export type {
  AppearanceEntry, AppearancePattern, AppearancePresetId, AppearanceSpec, AppearanceTable,
  AppearanceTarget, WoodSpecies,
} from './appearance/types.js';
export {
  assignAppearance, bodyAppearanceOf, clearAppearance, emptyAppearanceTable,
  isSameAppearanceTarget, nextAppearanceId, pruneAppearance, removeAppearance,
} from './appearance/appearanceTable.js';
export type { MaterialPreset, WoodSpeciesInfo } from './appearance/materialPresets.js';
export {
  appearanceFromPreset, DEFAULT_APPEARANCE, densityMaterialFor, findMaterialPreset,
  MATERIAL_PRESETS, WOOD_SPECIES,
} from './appearance/materialPresets.js';
export type { DensityMaterial } from './appearance/densityMaterials.js';
export {
  DEFAULT_DENSITY_MATERIAL_ID, DENSITY_MATERIALS, findDensityMaterial,
} from './appearance/densityMaterials.js';
export {
  appearanceOf, assignBodyAppearance, assignFaceAppearance, clearDocumentAppearance,
  pruneDocumentAppearance, removeDocumentAppearance, resolveAppearanceFor,
} from './appearance/documentAppearance.js';
/** 外観の橋渡し(P5 タスク4)。 */
export type {
  AppearanceFaceRequest, AppearanceMatchEntry, SolidBodyKind,
} from './kernelBridge.js';
/** 基本形状(FR-429、P5 タスク15)。 */
export type {
  PrimitiveFeature, PrimitiveShape, PrimitiveShapeKind, SolidOrigin,
} from './part/types.js';
export type {
  PrimitiveKeyMaterial, PrimitiveShapeKeyMaterial,
} from './part/cacheKey.js';
export {
  createPrimitiveFeature, defaultPrimitiveOrigin, defaultPrimitiveShape,
  DEFAULT_BOX_SIZE_MM, DEFAULT_CONE_BOTTOM_RADIUS_MM, DEFAULT_CONE_HEIGHT_MM,
  DEFAULT_CONE_TOP_RADIUS_MM, DEFAULT_CYLINDER_HEIGHT_MM, DEFAULT_CYLINDER_RADIUS_MM,
  DEFAULT_PRIMITIVE_AXIS, DEFAULT_SPHERE_RADIUS_MM, DEFAULT_TORUS_MAJOR_RADIUS_MM,
  DEFAULT_TORUS_MINOR_RADIUS_MM,
} from './part/createPartDocument.js';
/** 測定(FR-1101、FR-1102、P5 タスク29)。 */
export type { MeasureOutcome, MeasureTarget } from './kernelBridge.js';
/**
 * 3D プリント向けの点検(FR-815、計画書 P6 §0.51・§0.53・§2.16、タスク42・46)。
 *
 * **ui は kernel を輸入できない**(依存の向きは `ui → model → kernel`)ので、点検の依頼と
 * 結果の言葉をここで受け渡す。三角形ごとの真偽は 1 ビットずつ詰まっており、読み出しの
 * `readPrintabilityFlag` は**カーネルの純関数をそのまま輸出し直す**(同じビットの並べ方を
 * 2 か所に持たない。`sketchFilletGeometry` と同じ扱い)。しきい値の既定も同じ理由で
 * カーネルの値をそのまま出す。
 */
export type {
  PrintabilityOptions, PrintabilityOutcome, PrintabilityPhase, PrintabilityProgressCallback,
  PrintabilityProgressView, PrintabilityReport, PrintabilitySummary,
} from './kernelBridge.js';
export {
  DEFAULT_MIN_THICKNESS_MM, DEFAULT_OVERHANG_ANGLE_DEG, DISPLAY_MESH_QUALITY,
  readPrintabilityFlag,
} from './kernelBridge.js';
export {
  formatLength, formatMass, GRAM_PER_CM3_TO_GRAM_PER_MM3, inertiaWithDensity, massFromVolume,
} from './measure/massProperties.js';
/**
 * 面をつなぐ(罫線面 FR-430)・ロフト(FR-410)。P5 タスク25。
 * 段は 1 種類(`thruSections`)で、フィーチャーだけが 2 種類に分かれる(§0.a-0.25)。
 */
export type {
  LoftFeature, RuledFeature, RuledSection, RuledSphereSegments,
} from './part/types.js';
export type {
  ThruSectionKeyMaterial, ThruSectionsKeyMaterial,
} from './part/cacheKey.js';
export type { ThruSectionPlan } from './part/resolvePart.js';
export {
  DEFAULT_RULED_SPHERE_SEGMENTS, DEFAULT_RULED_TWIST, RULED_SPHERE_SEGMENT_CHOICES,
} from './part/createPartDocument.js';
/**
 * P5 の Should 群(FR-401、FR-409、FR-415、FR-417、FR-419〜425、FR-427、FR-428)。
 * P5 計画書 §2.11、タスク43。**型と既定値だけ**で、解決はタスク45・46、鍵の材料はタスク44。
 *
 * 押し出しの終端・傾き・薄板(FR-415・FR-401・FR-416)と穴の入口(FR-422)は
 * 既存のフィーチャーの省略できる欄なので、読む側は必ず `extrudeShapingOf` /
 * `holeEntryOf` を通す(既定値をここ以外へ写さない)。
 */
export type {
  DraftFeature, EmbossFeature, ExtrudeEnd, HoleEntry, MirrorFeature, MirrorPlane,
  RibFeature, RibSide, ScaleFactor, ScaleFeature, SketchCurveRef, SurfaceFeature,
  SurfaceOperation, SweepFeature, ThicknessSide, ThreadShaftFeature, TransformFeature,
} from './part/types.js';
export type { ExtrudeShaping } from './part/createPartDocument.js';
export {
  DEFAULT_COUNTERBORE_DEPTH_MM, DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES, DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_DRAFT_ANGLE_DEGREES, DEFAULT_EMBOSS_HEIGHT_MM, DEFAULT_EMBOSS_RAISED,
  DEFAULT_EXTRUDE_END, DEFAULT_EXTRUDE_THICKNESS_MM, DEFAULT_HOLE_ENTRY,
  DEFAULT_MIRROR_PLANE_ID, DEFAULT_RIB_EXTEND_TO_BODY, DEFAULT_RIB_SIDE,
  DEFAULT_RIB_THICKNESS_MM, DEFAULT_SCALE_FACTOR, DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM, DEFAULT_SWEEP_FRENET, DEFAULT_TAPER_ANGLE_DEGREES,
  DEFAULT_THICKNESS_SIDE, DEFAULT_THREAD_SHAFT_FROM_END, DEFAULT_THREAD_SHAFT_LENGTH_MM,
  DEFAULT_THREAD_SHAFT_MODELED, DEFAULT_TRANSFORM_ROTATION_DEGREES, DEFAULT_TRANSLATION_MM,
  extrudeShapingOf, holeEntryOf,
  MAX_DRAFT_ANGLE_DEGREES, MAX_SCALE, MAX_TAPER_ANGLE_DEGREES, MIN_SCALE,
} from './part/createPartDocument.js';
/**
 * P5 の Should 群の鍵の材料と段(FR-401、FR-415〜FR-419、FR-424、FR-428、FR-432。タスク45)。
 *
 * 鍵の材料 16 件は**タスク44 が作ったもの**で、輸出だけがこのタスクに残っていた
 * (`docs/報告記録.md` 2026-09-05 20:04 の t45 への申し送り)。ui とその場入力が
 * 「同じ形なら同じ鍵」を確かめられるように、`SolidStepKeyMaterial` の枝をすべて出す。
 *
 * 段の側は、タスク45 が解決した 4 種(抜き勾配・ミラー・移動/回転・拡大縮小)と、
 * 押し出しに足した終端・薄板の型を出す。段の union(`SolidStepPlan`)そのものは
 * P2 から輸出していないので、ここでも出さない(kernelBridge が唯一の読み手)。
 */
export type {
  CutKeyMaterial, DraftKeyMaterial, EmbossKeyMaterial, ExtrudeEndKeyMaterial,
  FilletRadiusKeyMaterial, HoleEntryKeyMaterial, MirrorKeyMaterial, RibKeyMaterial,
  ScaleKeyMaterial, ShellKeyMaterial, SurfaceKeyMaterial, SurfaceShapeKeyMaterial,
  SweepKeyMaterial, ThinExtrudeKeyMaterial, ThreadShaftKeyMaterial, TransformKeyMaterial,
} from './part/cacheKey.js';
export type { ExtrudeEndPlan, ThinExtrudePlan } from './part/resolvePart.js';
/**
 * P5 タスク46: スイープ・リブ・エンボス・ざぐり/皿もみ・外ねじ・点集合パターン・曲面
 * (FR-409、FR-420〜423、FR-425、FR-428)と、Could 群から前倒しした
 * くり抜き(FR-418)・可変半径フィレット(FR-426)。
 *
 * **`ShellFeature` は新しい保存形**なので型を出す。可変半径は `FilletFeature` に
 * 省略できる欄 `radiusEnd` を足しただけなので、読む側のための口
 * (`filletRadiusOf` / `FilletRadius`)と既定値だけを出す(既定を各所へ写さない。
 * `extrudeShapingOf` / `holeEntryOf` とまったく同じ約束)。
 *
 * 段の型(`SolidStepPlan`)は P2 から輸出していないので、ここでも出さない。
 * ただし**段の欄の型**(入口の形・丸める半径・曲面の作り方)は、ui とその場入力が
 * 「同じ形なら同じ段」を確かめられるように出す(`ExtrudeEndPlan` と同じ扱い)。
 */
export type { ShellFeature } from './part/types.js';
export type { FilletRadius } from './part/createPartDocument.js';
export {
  DEFAULT_FILLET_RADIUS_END_MM, DEFAULT_SHELL_OUTWARD, DEFAULT_SHELL_THICKNESS_MM,
  DEFAULT_SURFACE_OFFSET_MM, filletRadiusOf,
} from './part/createPartDocument.js';
export type {
  FilletRadiusPlan, HoleEntryPlan, SurfaceShapePlan,
} from './part/resolvePart.js';
/**
 * 点の参照(`PointReference`)が指すスケッチの id(FR-325 の順序の制約、タスク46)。
 * 拡大縮小の中心と点集合パターンの点だけは参照からスケッチを読めないので、
 * 全スケッチを id で探すこの口を通す(`referencedSketchIds` の第 2 引数も同じ材料)。
 */
export { sketchIdOfPointReference } from './part/resolvePart.js';
/**
 * 平面による切断(FR-432、P5 計画書 §2.9b、タスク27c)。分割(FR-424)もこれで満たす
 * (§0.a-0.60)。
 *
 * **`CutFeature` は新しい保存形**なので型を出す(`ShellFeature` と同じ扱い)。
 * 切断面の型 `PlaneSpec` と解決 `resolvePlaneSpec` は**任意の作業平面(FR-328)と
 * 共有するもの**で、P4 タスク9 の時点からここで輸出済みである(§0.a-0.56。切断のために
 * 新しく足す平面の型は無い)。残す側の既定はコマンド(タスク27e)とプロパティ
 * (タスク27f)が写さずに読めるよう、既定値の正本をここから出す。
 *
 * 鍵の材料 `CutKeyMaterial` はタスク44 が作り、タスク45 が輸出済み。段の型
 * (`SolidStepPlan`)は P2 から輸出していないので、切断でも出さない。
 */
export type { CutFeature } from './part/types.js';
export { DEFAULT_CUT_KEEP } from './part/createPartDocument.js';
/**
 * `SolidFeatureKind` の実行時の一覧(P5 仕上げ (h)、`docs/報告記録.md` 2026-09-05 23:08 の
 * t47 指摘③)。`packages/io` の妥当性検査はこれを輸入する(このタスクで置き換え済み)。
 * `packages/ui` の自前の一覧の置き換えは後続タスクの担当。
 */
export { SOLID_FEATURE_KINDS } from './part/createPartDocument.js';
/**
 * 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
 *
 * 文書の型(`ImportedSolidFeature` / `ImportedMeshFeature` / `ImportedSource`)は
 * `packages/io` が `.pcad` へ読み書きし(タスク21)、`packages/ui` がツリーとプロパティへ
 * 出す(タスク32)。**形そのもの(B-rep / 三角形)は ZIP の別エントリ**にあり、
 * ここから出る型には 1 バイトも入らない(§0.a-0.9)。
 *
 * `ImportedShapeBytes` は再計算へバイト列を渡す口、`ResolvedMeshBody` は
 * 「段にならないボディ」の解決結果、`IMPORTED_MESH_TARGET_MESSAGE` は
 * 「三角形の形は加工できない」の断りの文言(§0.a-0.23。model が正本)である。
 */
export type {
  ImportedMeshFeature, ImportedSolidFeature, ImportedSource, ImportedSourceFormat,
} from './part/types.js';
export type { ImportedShapeBytes, ResolvedMeshBody } from './part/resolvePart.js';
export { IMPORTED_MESH_TARGET_MESSAGE } from './part/resolvePart.js';
export type { ImportedSolidKeyMaterial } from './part/cacheKey.js';
/**
 * 表示と入力の長さの単位(FR-811、FR-814、P6 タスク1)。**内部は mm 固定**(NFR-RE-3)で、
 * ここにあるのは表示と入力の境目で使う純関数だけ。文書には単位を保存しない。
 *
 * `parseDisplayInput` が返すのは**式の文字列**(値ではない)。表示が inch のとき、単位を
 * 書かない入力を `(…)in` で包む(§0.a-0.63)。包むかどうかの判定は
 * `@pointercad/expression` の字句に任せてあり、単位の綴りはあちらの 1 か所だけにある。
 *
 * `nonLengthVariables` は `evaluateExpression` の同名の選択肢へ渡す集合を作る。
 * **文書全体の評価(`applyParameters`)へ配線するかは統括の判断待ち**なので、ここでは
 * 純関数を出すだけにしてある。
 */
export type { LengthUnit } from './units/length.js';
export {
  DEFAULT_INCH_DENOMINATOR, formatDisplayLength, fromDisplayLength, INCH_DISPLAY_DIGITS,
  LENGTH_UNITS, MM_PER_INCH, nonLengthVariables, normalizeInchQuotes, parseDisplayInput,
  toDisplayLength, toFractionalInch,
} from './units/length.js';
/**
 * 新しく付けるパラメータ名の検査(P6 §0.a-0.1、統括の決定)。長さの単位の綴り
 * (`mm` / `in` / `"`)を**これから打つ名前としてだけ**断る。既存の文書に同じ名前が
 * あっても読み込みは通す(`checkVariableName` は変えていない)。
 */
export type { NewParameterNameIssue } from './parameters/parameterTable.js';
export {
  checkNewParameterName, isLengthUnitName, LENGTH_UNIT_NAME_MESSAGE,
} from './parameters/parameterTable.js';
/**
 * 書き出し・読み込みの型と、書き出す対象の決め方(FR-803、FR-804、FR-427、P6 タスク2)。
 *
 * **`ExportFormat` / `ImportFormat` / `EXPORT_FORMATS` / `IMPORT_FORMATS` / `canRoundTrip` の
 * 正本はここ**である。P2 が `packages/io` に置いた同じ 5 つは、P6 でこの再輸出に置き換えた
 * (二重定義にしない。io は model に依存しているので依存方向に反しない)。
 *
 * 断りと警告は**文字列のキー**(`ExportNoticeKey`)で返し、日本語の文言は持たない
 * (NFR-MA-5。文言は `packages/ui` の `ja.json`)。エラーコードの体系は増やしていない。
 *
 * **DXF は `ExportFormat` に入っていない。** DXF へ書き出すのは平らなスケッチの線であって
 * 立体ではない(§0.a-0.34)ため、依頼の形が別になる。ただし「なめらかさが効くか」だけは
 * 形式の性質なので、`usesTriangles` / `exportDeviationMm` は `FileKind` で受けて DXF も答える。
 */
export type {
  ExportFormat, ExportMeshQuality, ExportNoticeKey, ExportOutcome, ExportQuality, ExportRequest,
  ExportRequestOptions, ExportScope, ExportSelection, FileKind, ImportFormat,
} from './exchange/types.js';
export {
  createExportRequest, DEFAULT_EXPORT_ASCII, DEFAULT_EXPORT_QUALITY, DEFAULT_EXPORT_SCOPE,
  DEFAULT_EXPORT_WITH_COLORS, EXPORT_DEVIATION_MM, EXPORT_FORMATS, EXPORT_MESH_QUALITY,
  EXPORT_QUALITIES, FILE_KINDS, IMPORT_FORMATS,
} from './exchange/types.js';
export {
  acceptsMeshBody, acceptsShellBody, canRoundTrip, carriesColor, checkExportBodyKind,
  exportDeviationMm, exportMeshQuality, selectExportBodies, usesTriangles,
} from './exchange/exportPart.js';

/**
 * 外観 → 書き出しの色の写し(FR-1106、要件§12、計画書 P6 §2.5・§2.5.1、タスク15)。
 *
 * **色だけ**を写す(柄・透過率・光沢・粗さは書き出さない。§0.a-0.22)。色は **sRGB の
 * 0〜1** で出し、glTF の `baseColorFactor` が要る線形への変換は kernel が持つ。
 *
 * 立体ごと(`bodyColorsFor`)と面ごと(`faceColorsFor`)を**別々の表**で返す。XCAF は
 * 形そのものと面のラベルへ別々に色を付ける(§2.5.1)ためで、**面の割り当てが立体より
 * 優先する**という P5 の順は、配線が「面の表を先に見て、無ければ立体の表」と読むことで
 * 成り立つ。面の通し番号は P5 の `appearanceMatches` から取り、照合をやり直さない。
 */
export type { RgbColor } from './exchange/exportColors.js';
export {
  bodyColorsFor, DEFAULT_EXPORT_COLOR, faceColorsFor, parseHexColor, rgbTupleOf,
} from './exchange/exportColors.js';

/**
 * DXF ↔ スケッチの写し(FR-813、FR-301〜318、FR-202、計画書 P6 §2.7・§0.a-0.32〜0.34、
 * タスク26)。
 *
 * **新しい `SketchFeature` の種類を 1 つも作らない。** DXF の 5 種は既にある
 * `point` / `line` / `arc` / `ellipse` / `spline` へ写る(円は「開始 0 度・終了 360 度の
 * 円弧」、多角形と `INSERT` は `packages/io` の段で線分・円弧へ開かれている)。
 *
 * `SketchDxfEntity` は **`packages/io` の `DxfEntity` と欄が 1 対 1 に同じ**型で、
 * 構造的部分型でそのまま受け渡せる。**`model` は `io` へ依存できない**(依存の向きは
 * `model → kernel / expression` の一方向。`io` のほうが `model` に依存している)ので、
 * 同じ形の型をこちらにも置いてある(`exchange/dxfTypes.ts` の注釈)。**両者がずれて
 * いないことの検査は `io` 側**(あちらは両方の型を輸入できる)。
 *
 * 座標の式は既存の `expressionValueFromNumber`(有効数字 12 桁)で作り、吸い付いた座標を
 * 保存するときと同じ書式にそろえてある(統括の決定 2026-09-06)。案内の文言
 * (平面から外れた・取り込めなかった件数・次数の高い曲線)の**正本はこの層**で、
 * `ja.json` には持たない(計画書 §2.8「文言の正本の層」)。
 *
 * `dxfToSketch` は単位の換算(inch は 25.4 倍)と案内の組み立てまでを行い、`sketchToDxf` は
 * **構築線を書き出さず、平らでない形を `DXF_NOT_PLANAR_MESSAGE` で断る。** どちらも
 * 画面を持たない純関数で、作図面の選ばせ方・単位の訊き方・案内の出し方は
 * `packages/ui`(タスク32)の仕事。
 */
export type {
  SketchDxfArcEntity, SketchDxfEllipseEntity, SketchDxfEntity, SketchDxfEntityBase,
  SketchDxfLengthUnit, SketchDxfLineEntity, SketchDxfPoint2d, SketchDxfPointEntity,
  SketchDxfSplineEntity,
} from './exchange/dxfTypes.js';
export type { DxfToSketchOptions, DxfToSketchResult } from './exchange/dxfToSketch.js';
export {
  DXF_SPLINE_DEGREE_REDUCED_MESSAGE, dxfDroppedEntitiesMessage, dxfOffPlaneMessage, dxfToSketch,
  MAX_SUPPORTED_SPLINE_DEGREE,
} from './exchange/dxfToSketch.js';
export type { SketchToDxfInput, SketchToDxfResult } from './exchange/sketchToDxf.js';
export {
  DXF_NOT_PLANAR_MESSAGE, ellipseParameterToAzimuth, sketchToDxf,
} from './exchange/sketchToDxf.js';

/**
 * 選択セット(FR-112、計画書 P6 §0.a-0.44・§2.13、タスク37)。
 *
 * `PartDocument.selectionSets` に持つ「名前を付けた選んだ組」で、要素の型
 * `SelectionMember` は**立体・面・辺・頂点の独自の型**である(外観の `AppearanceTarget`
 * とは別。2026-09-06 の利用者の決定でセットに面以外も入れられるようにした、タスク50)。
 * 判定 `isSameSelectionMember` も独自。
 *
 * **形に影響しない**(`affectsShape` が偽)ので、セットを足しても消しても再計算は走らない。
 */
export type { SelectionMember, SelectionSet } from './part/types.js';
export type {
  CreateSelectionSetResult, PruneSelectionSetsResult, RenameSelectionSetResult,
  SelectionSetRefusal,
} from './part/selectionSets.js';
export {
  addSelectionSetMembers, createSelectionSet, findSelectionSet, isSameSelectionMember,
  nextSelectionSetId, pruneSelectionSets, removeSelectionSet, removeSelectionSetMembers,
  renameSelectionSet,
} from './part/selectionSets.js';

/**
 * 下絵の画像(FR-332、計画書 P6 §0.a-0.45・§0.a-0.46・§2.14、タスク38)。
 *
 * `PartDocument.canvases` に持つ「作図面に貼った画像」で、バイト列は `.pcad` の ZIP の
 * 別エントリ(`canvases/<imageId>.png`)へ入る。**画像を保存するのは `rules/04` の
 * 承認済みの例外**(導出できないため。§0.a-0.45 の例外③)。
 *
 * 受け付けは PNG / JPEG だけ・1 枚 8MB まで(`checkCanvasImage`)で、断りの日本語は
 * この層が持つ(上限の数を知っているのがこの層だけのため。§2.8「文言の正本の層」)。
 * 寸法合わせ(`scaleFromTwoPoints`)は 2 点の画素の距離と実寸から mm/画素を出す純関数。
 */
export type { SketchCanvas } from './part/types.js';
export type {
  CanvasImageFormat, CanvasImageRefusal, CanvasPixelPoint, CanvasScaleRefusal, CanvasSizeMm,
  CheckCanvasImageResult, ScaleFromTwoPointsResult,
} from './sketch/canvas.js';
export {
  CANVAS_INVALID_LENGTH_MESSAGE, CANVAS_SAME_POINT_MESSAGE, CANVAS_TOO_LARGE_MESSAGE,
  CANVAS_UNSUPPORTED_FORMAT_MESSAGE, canvasSizeFromScale, checkCanvasImage, detectImageFormat,
  MAX_CANVAS_IMAGE_BYTES, nextCanvasId, removeCanvas, scaleFromTwoPoints, setCanvasVisible,
} from './sketch/canvas.js';

/**
 * 拘束の自動推定(FR-333、FR-313、計画書 P6 §0.a-0.48〜0.50・§2.15、タスク40)。
 *
 * 線を引いている最中に「水平・垂直・一致・接線・平行」を推定して予告するための純関数で、
 * 画面の縮尺は引数(`pixelsPerMillimetre`)で受け取るので DOM にも three.js にも触れない。
 *
 * **しきい値の正本はここ**(`inferConstraints.ts` の 2 つの定数)。とくに
 * `INFER_COINCIDENT_RADIUS_PIXELS` は ui の `PICK_RADIUS_PIXELS`(= 6)と同じ値だが、
 * 依存方向(`apps → ui → model`)の都合で ui から借りられないため model 側を正本にし、
 * **ui はこの輸出を読む**(同じ数を 2 か所に書かない。`rules/04-設計の規律.md`)。
 *
 * 印を描くのと、確定して拘束を足す配線は ui の役目(タスク41)。
 */
export type {
  DraftSegment, InferConstraintsOptions, InferenceElements, InferredConstraint,
  InferredConstraintKind, PlanePoint,
} from './sketch/inferConstraints.js';
export {
  constraintFromInference, INFER_ANGLE_TOLERANCE_DEGREES, INFER_COINCIDENT_RADIUS_PIXELS,
  inferConstraints, INFERENCE_PRIORITY, inferredConstraintTargets, MAX_INFERRED_CONSTRAINTS,
} from './sketch/inferConstraints.js';

/**
 * アセンブリの配置の数学(FR-601、計画書 P7 §2.4、タスク2)。
 *
 * 置いた部品 1 つの「どこに・どちら向きに」を位置 3 数 + 四元数 4 数で持ち、点・向きへ
 * 掛ける・入れ子で合成する・既存の `RigidTransform`(軸+角)へ写す、までの純関数。
 * **符号を `w >= 0` へ揃える正規化は `normalizeQuaternion` の 1 か所だけ**(§0.54 の
 * 決定性)。OCCT にも three にも触れないので、Node の Vitest だけで検査できる。
 */
export type { AxisAngle, Quaternion, RigidPlacement } from './assembly/placementMath.js';
export {
  applyPlacementToDirection, applyPlacementToPoint, composePlacement, exponentialMap,
  IDENTITY_PLACEMENT, IDENTITY_QUATERNION, multiplyQuaternion, normalizeQuaternion,
  placementToRigidTransform, QUATERNION_TOLERANCE, quaternionFromAxisAngle, quaternionToAxisAngle,
  rotateVector,
} from './assembly/placementMath.js';

/**
 * アセンブリ文書(FR-601、FR-602、FR-605、FR-606、FR-611、FR-613。
 * 計画書 P7 §2.2、タスク1)。
 *
 * 部品文書(`PartDocument`)と並ぶもう 1 つの保存の単位で、**部品を参照して置いたもの**
 * (`AssemblyComponent`)・合致(`Mate`)・ジョイント(`Joint`)・分解のステップ
 * (`PresentationStep`)・パラメータ・部品表の設定を持つ。**部品の形も合致の解も保存しない**
 * (§0.a-0.4、§0.a-0.6)ので、開くたびに部品ごとに 1 回だけ作り、解き直す。
 *
 * 版は部品と同じ系列にする(`ASSEMBLY_SCHEMA_VERSION` = `PART_SCHEMA_VERSION`。§0.a-0.2)。
 * 置く・消す・固定・表示の履歴操作は `assembly/assemblyEdit.ts`(タスク7)が足す。
 */
export type {
  AssemblyComponent, AssemblyDocument, BomColumnId, BomSettings, BomSortKey, ComponentSource,
  Joint, JointKind, Mate, MateKind, MateTarget, OriginElement, Placement, PresentationStep,
  StandardCatalogId,
} from './assembly/types.js';
export {
  ASSEMBLY_SCHEMA_VERSION, BOM_COLUMN_IDS, BOM_SORT_KEYS, createAssemblyDocument,
  DEFAULT_ASSEMBLY_NAME, DEFAULT_BOM_SETTINGS, DEFAULT_COMPONENT_PLACEMENT, JOINT_KINDS,
  MATE_KINDS, nextComponentId, nextJointId, nextMateId, nextPresentationStepId,
  STANDARD_CATALOG_IDS,
} from './assembly/createAssemblyDocument.js';

/**
 * 抱き込んだ部品文書の出し入れと内容ハッシュ(FR-601、要件§8。計画書 P7 §2.3、タスク4)。
 *
 * アセンブリ文書と**対で持ち回る**入れ物(`PartLibrary`)で、「どのファイルから・いつ・
 * どの中身を取り込んだか」に加え、再導出できない読み込み形・メッシュ・下絵を持つ。
 * 内容ハッシュは**文書だけ**を決定的に文字列にして SHA-256 を取るので、保存し直しただけでは
 * 変わらない(封筒の `savedAt` を含まない)。**同じ文書と添付を 2 回抱き込まない**(`embedPart` が
 * 既存の `partRef` を返す)。元のファイルを追いかけた結果の文言は上の層が持つ(§2.12)。
 */
export type {
  EmbeddedPartAttachments, EmbeddedPartFile, EmbeddedPartMesh, EmbedPartOptions, EmbedPartResult,
  PartLibrary,
} from './assembly/partLibrary.js';
export {
  assemblyOf, attachmentsDigestOf, canonicalPartDocumentText, CONTENT_HASH_ALGORITHM, contentHashOf,
  embedPart, emptyEmbeddedPartAttachments, EMPTY_PART_LIBRARY, nextPartRef, PART_REF_PREFIX,
  partAttachmentsOf, partFileOf, partOf, replacePartDocument, staleParts,
} from './assembly/partLibrary.js';

/**
 * アセンブリの解決(FR-601、FR-606、NFR-PF-3。計画書 P7 §2.3、タスク6)。
 *
 * アセンブリ文書を「部品ごとの再計算の依頼(`ResolvedPart`)」と「インスタンスごとの配置
 * (数に直した `RigidPlacement`)」へ直す**カーネルを呼ばない純関数**。**同じ部品は 1 回だけ**
 * 解決し、全インスタンスで形を使い回す(§0.a-0.4。インスタンスごとに作り直すと §2.13-6 の
 * 上限 5 秒を割る)。部品が引けない・位置が数にならないは投げずに `errors` へ積む(FR-504)。
 */
export type {
  AssemblyError, AssemblyErrorCode, ResolveAssemblyOptions, ResolvedAssembly, ResolvedSubAssembly,
  StandardPartSource,
} from './assembly/resolveAssembly.js';
export {
  assemblyVariables, assemblyExpressionContext, INVALID_PLACEMENT_MESSAGE, MISSING_PART_MESSAGE,
  MAX_SUB_ASSEMBLY_DEPTH, MISSING_STANDARD_SIZE_MESSAGE, partKeyOf, resolveAssembly,
  SUB_ASSEMBLY_CYCLE_MESSAGE, SUB_ASSEMBLY_DEPTH_MESSAGE,
} from './assembly/resolveAssembly.js';

export type { SubAssemblyProblem } from './assembly/subAssembly.js';
export { detectCycle, detectSubAssemblyProblem, resolveSubAssembly } from './assembly/subAssembly.js';

export type {
  ReplacementPlan, ReplacementResolvedData,
} from './assembly/replaceComponent.js';
export { applyReplacement, planReplacement } from './assembly/replaceComponent.js';

export type {
  AssemblyMassBody, AssemblyMassProperties, AssemblyMassResolvedData,
  MaterialBearingPartDocument,
} from './assembly/massProperties.js';
export {
  assemblyMassProperties, materialOf, PARTIAL_ASSEMBLY_MASS_MESSAGE,
} from './assembly/massProperties.js';

/** 部品表の純粋な集計(FR-611、P7 §2.10・§2.10.1)。 */
export type {
  BomBody, BomResolvedData, BomRow, BomSubAssemblyData,
} from './assembly/bom.js';
export { buildBom, bomPartName } from './assembly/bom.js';

/** JIS規格部品の寸法表・出典・普通の部品文書を組む台本(P7 タスク27〜29)。 */
export type {
  BearingSeries, ChannelRow, DeepGrooveBallBearingRow, EqualAngleRow, FastenerDimensionSeries,
  HBeamRow, HexBoltRow, HexNutRow, PanHeadScrewRow, PlainWasherRow, SectionRow,
  SocketHeadCapScrewRow, SpringWasherRow,
  StandardDimensionRow, StandardTableSource,
} from './assembly/standard/types.js';
export {
  STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION,
} from './assembly/standard/types.js';
export {
  findHexBolt, findHexNut, findPanHeadScrew, findPlainWasher, findSocketHeadCapScrew,
  findSpringWasher,
  HEX_BOLT_NOMINAL_LENGTHS, HEX_BOLT_SOURCE, HEX_BOLT_TABLE, HEX_NUT_SOURCE, HEX_NUT_TABLE,
  PAN_HEAD_SCREW_SOURCE, PAN_HEAD_SCREW_TABLE, PLAIN_WASHER_SOURCE, PLAIN_WASHER_TABLE,
  SOCKET_HEAD_CAP_SCREW_SOURCE,
  SOCKET_HEAD_CAP_SCREW_TABLE, SPRING_WASHER_SOURCE, SPRING_WASHER_TABLE,
} from './assembly/standard/fasteners.js';
export {
  bearingBoreFromDesignation, bearingSizes, DEEP_GROOVE_BALL_BEARINGS,
  DEEP_GROOVE_BALL_BEARING_SOURCE, findDeepGrooveBallBearing,
} from './assembly/standard/bearings.js';
export {
  CHANNEL_TABLE, EQUAL_ANGLE_TABLE, findChannel, findEqualAngle, findHBeam, H_BEAM_TABLE,
  sectionMassFromArea, STRUCTURAL_SECTION_SOURCE,
} from './assembly/standard/sections.js';
export {
  buildStandardPart, buildStandardPartFromSource, changeStandardSize, createStandardPartSource,
  DEFAULT_STANDARD_FASTENER_LENGTH, DEFAULT_STANDARD_SECTION_LENGTH,
  STANDARD_PART_UNAVAILABLE_MESSAGE, standardPartNominalVolume,
} from './assembly/standard/buildStandardPart.js';

/**
 * 部品を置く・消す・固定・表示の履歴操作(FR-601、FR-602、FR-505、FR-605、FR-606。
 * 計画書 P7 タスク7)。
 *
 * **すべて新しい文書を返す純関数**なので、Undo / Redo は `history/undoStack.ts` が
 * そのまま効く(1 回の操作 = 1 段)。**最初に置いた部品は自動で固定**(§0.a-0.7)、
 * 名前の既定は `<部品名>:<n>`(§0.a-0.8)。**部品を消すと、その部品を指していた合致・
 * ジョイント・分解のステップも一緒に消える**(指し先の無い合致を残さないため)。
 */
export type { CreateComponentOptions } from './assembly/assemblyEdit.js';
export {
  addComponent, COMPONENT_NAME_SEPARATOR, createComponentFor, DEFAULT_COMPONENT_LABEL,
  findComponent, moveComponent, nextComponentName, removeComponent, renameComponent,
  replaceComponent, setComponentAppearance, setComponentSuppressed, setFixed, setVisible,
} from './assembly/assemblyEdit.js';

/**
 * 合致の対象の解決(FR-603、FR-609、FR-329。計画書 P7 タスク12、§2.5.2)。
 *
 * 合致とジョイントが指している「どのインスタンスの、どの部分形状か」を、残差が要る
 * **世界座標の点と向き**(と円筒の半径)へ直す**カーネルを呼ばない純関数**。位置・軸・半径は
 * 保存された指紋(`SubShapeRef`)から取り、部品の配置を掛けて世界座標へ直す。
 * **曲面(球面など)・軸の取れない形・見つからない部品は、対象を消さずに理由を返す**
 * (投げない。FR-504。文言は計画書 §2.12 のまま)。
 */
export type {
  MateTargetErrorCode, MateTargetKind, MateTargetOutcome, ResolveMateTargetOptions,
  ResolvedMateTarget,
} from './assembly/constraints/mateTargets.js';
export {
  MISSING_AXIS_MESSAGE, MISSING_MATE_TARGET_MESSAGE, resolveMateTarget, UNUSABLE_FACE_MESSAGE,
} from './assembly/constraints/mateTargets.js';

/**
 * 合致の変数と自由度・連結成分(FR-603、FR-602、FR-604。計画書 P7 タスク13、§2.5.1・§2.5.3)。
 *
 * ソルバーが動かしてよい数を、**動かせる部品 1 つにつき 6 つ**(平行移動の増分 3 + いまの
 * 向きからの小さな回転 3)、`components` の順で並べる**純関数**。固定(FR-602)と抑制は
 * 変数を持たず、非表示は持つ(見えなくても組み立ての一部)。変数が上限 600(動かせる部品
 * 100 個)を超えたら印を立て、解く側が断る。合致とジョイントでつながった部品を
 * **連結成分ごとに分ける**(固定へつながる辺は無視する)ので、塊ごとに別々の連立を解ける。
 * 合致の距離・角度は**アセンブリのパラメータ表**(`assemblyVariables`)で数にする。
 */
export type {
  CountMateDegreesOfFreedomOptions, FrozenComponentReason, MateComponentGroup,
  MateDegreesOfFreedom, MateVariable, MateVariableAxis, MateVariableSet, SkippedMate,
} from './assembly/constraints/mateVariables.js';
export {
  coincidentEquationCount, collectMateVariables, countMateDegreesOfFreedom, jointEquationCount,
  MATE_VARIABLE_AXES, MATE_VARIABLES_PER_COMPONENT, mateComponentGroups, mateEquationCount,
  mateValueOf, MAX_ASSEMBLY_VARIABLES, MAX_MOVABLE_COMPONENTS, TOO_MANY_COMPONENTS_MESSAGE,
} from './assembly/constraints/mateVariables.js';
export { importedShapeOf, type ImportedShape } from './part/types.js';
export type {
  MonitoredKernelBridge, KernelOperationStatus, KernelOperationCounts,
  AssemblyKernelBridge, ShapeAvailability,
} from './kernelBridge.js';
export {
  createPartDocumentBundle,
  createAssemblyDocumentBundle,
  partLibraryOfBundle,
  type DocumentBundle,
  type EmbeddedAssemblyDocumentBundle,
  type EmbeddedDocumentBundle,
  type PartDocumentBundle,
  type AssemblyDocumentBundle,
} from './assembly/documentBundle.js';
export * from './assembly/constraints/mateResiduals.js';
export * from './assembly/constraints/solveRigid.js';
export * from './assembly/constraints/solveMates.js';

export * from './assembly/joints/jointFrames.js';
export * from './assembly/joints/jointResiduals.js';
export * from './assembly/joints/driveJoint.js';
export * from './assembly/presentation.js';

export { drawingDimensionContext, drawingModelPointToPaper, resolvedDimensionView, drawingTargetFromProjection, resolveDimensionTarget, resolveDrawingDimensions,
  resolveDrawingAnnotationTarget, type ResolvedDimensionTarget, type DrawingDimensionInstance, type DimensionResolveContext, type ResolvedDrawingDimension } from './drawing/dimensionTarget.js';
export { suggestDimensionKind, type SuggestedDimensionKind } from './drawing/dimensionKind.js';
export { machiningSymbols, type MachiningFeature, type MachiningNote, type MachiningNoteToken } from './drawing/machiningSymbols.js';
export { refreshDrawing, replaceSource, drawingSourceChangedExternally, type DrawingRefreshOptions, type DrawingRefreshResult } from './drawing/refreshDrawing.js';
export { resolveViewConstructions, type ConstructedDrawingView, type DrawingConstructionResult } from './drawing/viewConstruction.js';
export { resolveDrawingPlane } from './drawing/resolveDrawingPlane.js';
export { unfoldDrawingPick, drawingSectionRetainsPoint } from './drawing/viewPickFrame.js';

export { textFeature, type TextFeatureInput, type TextFeatureResult } from './sketch/textFeature.js';

export { drawingToDxf, type DrawingDxfGeometry, type DrawingDxfConversionOptions } from './exchange/drawingToDxf.js';
export type { DrawingDxfEntity, DrawingDxfLayer, DrawingDxfLineType, DrawingDxfOptions } from './exchange/drawingDxfTypes.js';

export * from './part/namedViews.js';
export * from './part/configurations.js';
export * from './part/configurationDefaults.js';

export * from './drawing/drawingTemplate.js';
export * from './drawing/holeSchedule.js';
export * from './drawing/resolveHoleSchedule.js';
