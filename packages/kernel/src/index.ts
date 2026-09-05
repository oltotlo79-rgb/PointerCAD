export type { BoxParameters, MeshData, TessellationOptions } from './types.js';
export type {
  ArcSpec,
  CurveSpec,
  EllipseCurveSpec,
  SegmentSpec,
  SplineCurveSpec,
  Vec3Tuple,
} from './types.js';
export type {
  FaceMeshData,
  PlanarFaceRequest,
  SketchTessellation,
  SketchTessellationFailure,
  SketchTessellationRequest,
} from './types.js';
// 輪郭のオフセット(FR-321、P4 タスク15)。Worker 越しの依頼と結果。
export type {
  OffsetContour,
  OffsetJoinType,
  SketchOffsetFailure,
  SketchOffsetItem,
  SketchOffsetOutcome,
  SketchOffsetRequest,
  SketchOffsetResult,
} from './types.js';
// 投影・交差(FR-325、P4 タスク25・26)。Worker 越しの依頼と結果、作図面と 2 次元の曲線。
export type {
  PlaneArc,
  PlaneCurve,
  PlanePolyline,
  PlaneSegment,
  SketchPlaneFrame,
  SketchProjectionFailure,
  SketchProjectionItem,
  SketchProjectionOutcome,
  SketchProjectionRequest,
  SketchProjectionResult,
  SketchSectionItem,
  SketchSectionRequest,
  Vec2Tuple,
} from './types.js';
export { makeProjection, orderPlaneCurves, planeBasisOf, projectPointToPlane } from './occt/makeProjection.js';
export { makeSection } from './occt/makeSection.js';
export { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from './occt/pickSubShape.js';
// ソリッド(立体)の依頼と結果(FR-401〜404)。Comlink 越しに渡せる素の値だけで書いてある。
export type {
  BooleanOperation,
  BooleanStepSpec,
  ExtrudeStepSpec,
  RevolveStepSpec,
  SewStepSpec,
  SolidBodyKind,
  SolidBodyMesh,
  SolidProgress,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  SolidStepFailure,
  SolidStepRequest,
  SolidStepSpec,
} from './types.js';
export { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION } from './types.js';
// 外観の面の照合(FR-1106、P5 §2.2.3、タスク3)。model 側(kernelBridge.ts、タスク4)が
// 割り当ての指紋を AppearanceQuery へ詰め替えて渡し、AppearanceMatch を受け取る。
export type { AppearanceMatch, AppearanceQuery } from './types.js';
// 基本形状(FR-429、P5 §2.7、タスク13・14)。段の依頼の型と 5 種の作り手。
// model 側(resolvePart.ts、タスク16)が PrimitiveStepSpec を組み立てて段に乗せる。
export type { PrimitiveShapeSpec, PrimitiveStepSpec } from './types.js';
// 基準点を「立体の頂点」にする追補(FR-429、§0.a-0.18、タスク14b)。頂点の選び直しは
// P3 の指紋の採点(matchVertex)をそのまま使い、対象は消費しない。
export {
  boxCornerOrigin,
  makePrimitive,
  offsetFromVertex,
  primitiveAxes,
  readAxesFrame,
  resolvePrimitiveOrigin,
  MISSING_PRIMITIVE_VERTEX_MESSAGE,
  PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE,
  type AxesFrame,
} from './occt/makePrimitive.js';
// 罫線面(FR-430)とロフト(FR-410、P5 §2.9、タスク23・24)。段の依頼の型と作り手、
// 球への外接直線の純関数(OCCT を使わないので model / 検査からそのまま呼べる)。
// model 側(resolvePart.ts、タスク25)が ThruSectionsStepSpec を組み立てて段に乗せる。
// `SphereSegmentCount`(24 / 48 / 72)は ui の「なめらかさ」の 3 択(タスク27)と
// model の欄(タスク25)が同じ型を使うために輸出する(3 か所で数を書き写さない)。
export type { SphereSegmentCount, ThruSectionSpec, ThruSectionsStepSpec } from './types.js';
export { makeThruSections } from './occt/makeThruSections.js';
export {
  tangentConeThroughCircle,
  tangentPointOnSphere,
  type TangentCone,
} from './occt/sphereTangent.js';
// P5 の Should 群・Could 群(FR-401、FR-409、FR-415〜FR-428、FR-432。タスク42a)。
//
// 段の依頼の型と、その作り手。model 側(`kernelBridge.ts` の `toSolidStepSpec`、
// タスク45・46)がこれらを組み立てて段に乗せる。**依頼の型は作り手の依頼(`*Input`)の
// 上位互換**にしてあるので、欄の名前と意味は作り手のファイルの注釈が正本である。
//
// `ExtrudeEndSpec` / `ThinExtrudeSide` / `HoleEntrySpec` / `SurfaceInput` は
// `types.ts` が作り手から取り込んで輸出し直しているものを、ここでも中継する
// (`OffsetJoinType` と同じ流儀。同じ約束を 2 か所に書かない)。
export type {
  ConstantFilletStepSpec,
  CutStepSpec,
  DraftStepSpec,
  EmbossStepSpec,
  ExtrudeEndSpec,
  FilletRadiusSpec,
  HoleEntrySpec,
  MirrorStepSpec,
  RibStepSpec,
  ScaleStepSpec,
  ShellStepSpec,
  SurfaceInput,
  SurfaceStepSpec,
  SweepStepSpec,
  ThinExtrudeSide,
  ThinExtrudeSpec,
  ThreadShaftStepSpec,
  TransformStepSpec,
} from './types.js';
export { makeCut, type CutInput } from './occt/makeCut.js';
export { makeDraft, draftStatusName, type DraftInput } from './occt/makeDraft.js';
export { makeEmboss, type EmbossInput } from './occt/makeEmboss.js';
export { makeRib, type RibInput } from './occt/makeRib.js';
export { makeShell, type ShellInput } from './occt/makeShell.js';
export { makeSurface, isShellShape, type SurfaceResult } from './occt/makeSurface.js';
export { makeSweep, type SweepInput } from './occt/makeSweep.js';
export { makeThinExtrude, type ThinExtrudeInput } from './occt/makeThinExtrude.js';
export { makeThreadShaft, type ThreadShaftInput } from './occt/makeThread.js';
export {
  makeVariableFillet,
  type VariableFilletInput,
  type VariableFilletTarget,
} from './occt/makeVariableFillet.js';
export {
  makeMirrorTransform,
  mirrorShape,
  scaleShape,
  type MirrorPlaneSpec,
  type ScaleSpec,
} from './occt/transformShape.js';
// 加工フィーチャー(FR-405〜408、FR-411、FR-412、FR-414)の型(計画書 §2.8)。
// 段の依頼(*StepSpec)と、部分形状の一覧・指紋(SolidFaceInfo 等・SubShapeQuery)を輸出する。
// model 側(kernelBridge.ts、タスク17)がこれらを取り込んで詰め替える。
export type {
  ChamferSizeSpec,
  ChamferStepSpec,
  EdgeCurveKind,
  FaceSurfaceKind,
  FilletStepSpec,
  HoleStepSpec,
  RigidTransformSpec,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidVertexInfo,
  SpringStepSpec,
  SubShapeKind,
  SubShapeQuery,
  ThreadCutSpec,
  ThreadMarkInfo,
  ThreadMarkSpec,
  ThreadStepSpec,
} from './types.js';
export { makeBox, type OcctShapeHandle } from './occt/makeBox.js';
export { makePlanarFace, type OcctFaceHandle } from './occt/makePlanarFace.js';
export {
  discretizeEdge,
  makeArcEdge,
  makeCurveEdge,
  makeSegmentEdge,
  type OcctEdgeHandle,
} from './occt/makeSketchEdges.js';
// 楕円・スプラインの稜線(FR-318、FR-317、タスク7・8)。makeCurveEdge が振り分ける(タスク5)。
export { makeEllipseEdge, type EllipseSpec } from './occt/makeEllipseEdge.js';
export {
  bsplineDataForSpline,
  makeSplineEdge,
  splineDegree,
  type BSplineData,
  type SplineSpec,
} from './occt/makeSplineEdge.js';
// スケッチの角の丸め・面取り(FR-323、タスク19)。**OCCT を呼ばない純関数**なので、
// Worker を往復させず model 側(kernelBridge.ts、タスク18)がそのまま呼ぶ。
// OCCT の ChFi2d を使わないと決めた理由は makeSketchFillet2d.ts の冒頭にある。
export {
  makeSketchFillet,
  type SketchFilletPlaneSpec,
  type SketchFilletResult,
  type SketchFilletSpec,
} from './occt/makeSketchFillet2d.js';
export {
  makeSketchChamfer,
  type SketchChamferResult,
  type SketchChamferSpec,
} from './occt/makeSketchChamfer2d.js';
export { tessellate, type FaceTriangleRange, type SurfaceMesh } from './occt/tessellate.js';
export { extractEdges, type EdgeLines, type EdgeSegmentRange } from './occt/extractEdges.js';
export {
  buildSolidBodyMesh,
  hasSolid,
  isValidShape,
  measureArea,
  measureVolume,
} from './occt/solidMesh.js';
// 測定と質量特性(FR-1101、FR-1102、P5 §2.10、タスク28)。Worker 越しの依頼と結果は
// `measure`(kernelApi)が受け、純関数は model 側の橋(タスク29)からも使える。
export type { MeasureRequest, MeasureResult, MeasureTargetSpec } from './types.js';
export {
  angleBetween,
  distanceBetween,
  edgeLength,
  massProperties,
  measureMassProperties,
  DISTANCE_FAILED_MESSAGE,
  GRAM_PER_CM3_TO_GRAM_PER_MM3,
  MASS_PROPERTIES_FAILED_MESSAGE,
  type ShapeDistance,
  type ShapeMassProperties,
  type ShapeVolumeProperties,
} from './occt/measureShape.js';
export { makeExtrudeSolid, makeRevolveSolid } from './occt/makeSolidSweep.js';
export { sewSolid } from './occt/sewSolid.js';
export { booleanOp } from './occt/booleanOp.js';
// 確保の入れ物(計画書 P3 §2.12、タスク2)。makeHole.ts 等の加工の作り手が使い回す。
export { createAllocations, type Allocations, type OcctDeletable } from './occt/allocations.js';
// 面・辺・頂点の一覧と素性(計画書 §2.2、タスク4)。
export {
  boundingDiagonal,
  collectSubShapes,
  edgeAt,
  edgesTouchingVertex,
  faceAt,
  facesTouchingEdge,
  vertexAt,
  type SubShapeTables,
} from './occt/subShapes.js';
// 部分形状の指紋の採点(計画書 §2.2.3、§0.a-0.4、タスク5)。OCCT を使わない純関数。
export {
  MATCH_WEIGHT_AXIS,
  MATCH_WEIGHT_INDEX,
  MATCH_WEIGHT_POSITION,
  MATCH_WEIGHT_SIZE,
  MATCH_WEIGHT_VERTEX_INDEX,
  MATCH_WEIGHT_VERTEX_POSITION,
  SUB_SHAPE_MATCH_THRESHOLD,
  matchEdge,
  matchFace,
  matchVertex,
  scoreAxis,
  scoreEdge,
  scoreFace,
  scorePosition,
  scoreSize,
  scoreVertex,
  type MatchScoreParts,
  type SubShapeMatch,
} from './occt/matchSubShape.js';
// 穴・ねじ穴(FR-405、FR-406、タスク6・9)。
export { makeHole, makeHoleTools, resolveHoleFrame, type HoleFrame } from './occt/makeHole.js';
export { makeThreadCut, makeThreadHole, threadSweepRadius } from './occt/makeThread.js';
// R 面取り・C 面取り(FR-407、FR-408、タスク7・8)。
export { makeFillet, resolveFilletEdges } from './occt/makeFillet.js';
export { makeChamfer } from './occt/makeChamfer.js';
// らせん(ねじの実らせんとばねが共用、計画書 §2.7b.3、タスク9)。
export {
  helixArcLength,
  helixAxisFrame,
  helixParameterLength,
  helixStartFrame,
  makeHelixEdge,
  makeHelixWire,
  type HelixAxisFrame,
  type HelixSpec,
} from './occt/makeHelix.js';
// ばね(FR-414、タスク9b)。
export { makeSpring, makeSpringProfile } from './occt/makeSpring.js';
// 剛体変換(パターン、FR-411、FR-412、タスク9)。
export {
  IDENTITY_TRANSFORM,
  applyTransformToDirection,
  applyTransformToPoint,
  isIdentityTransform,
  makeCompound,
  makeTransform,
  transformShape,
  transformsOrIdentity,
} from './occt/transformShape.js';
export {
  createShapeCache,
  SHAPE_CACHE_CAPACITY,
  type ShapeCache,
  type ShapeCacheEntry,
  type ShapeCacheStats,
} from './worker/shapeCache.js';
export {
  matchAppearances,
  recomputeSolids,
  type CachedSolid,
  type SolidCancelToken,
  type SolidProgressCallback,
  type SolidRecomputeDeps,
} from './worker/recomputeSolids.js';
export { createKernelApi, type KernelApi } from './worker/kernelApi.js';
export { createKernelWorker } from './client/createKernelWorker.js';
