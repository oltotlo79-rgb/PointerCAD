export {
  createDirectKernelBridge,
  createKernelBridge,
  createKernelHealth,
  KERNEL_BROKEN_MESSAGE,
  selectSubShape,
  // 角の丸め・面取りの形を求める同期の純関数(FR-323、P4 タスク18・19)。ui の予告表示
  // (`cornerCommands.ts`)が、確定に使うのとまったく同じ式で形を先に見せるために使う。
  // 式の正本は kernel 側の 1 か所だけなので、写して 2 か所に持つことはしない。
  sketchChamferGeometry,
  sketchFilletGeometry,
  type KernelBridge,
  type KernelHealth,
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
  ExportFormat, ExportNoticeKey, ExportOutcome, ExportQuality, ExportRequest,
  ExportRequestOptions, ExportScope, ExportSelection, FileKind, ImportFormat,
} from './exchange/types.js';
export {
  createExportRequest, DEFAULT_EXPORT_ASCII, DEFAULT_EXPORT_QUALITY, DEFAULT_EXPORT_SCOPE,
  DEFAULT_EXPORT_WITH_COLORS, EXPORT_DEVIATION_MM, EXPORT_FORMATS, EXPORT_QUALITIES,
  FILE_KINDS, IMPORT_FORMATS,
} from './exchange/types.js';
export {
  acceptsMeshBody, acceptsShellBody, canRoundTrip, carriesColor, checkExportBodyKind,
  exportDeviationMm, selectExportBodies, usesTriangles,
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
