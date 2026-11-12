export type { BoxParameters, TessellationOptions } from './types.js';
export type { SheetBaseStepSpec } from './types.js';
export type { SheetMetalBaseInput } from './occt/makeSheetMetalBase.js';
export type { SheetMetalBendFrame } from './occt/makeSheetMetalBend.js';
export type { SheetMetalFlangeInput } from './occt/makeSheetMetalFlange.js';
export type { SheetMetalProfileFlangeInput } from './occt/makeSheetMetalProfileFlange.js';
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
// 輪郭のオフセット(FR-321)。Worker 越しの依頼と結果。
export type {
  OffsetJoinType,
  SketchOffsetItem,
  SketchOffsetOutcome,
} from './types.js';
// 投影・交差(FR-325)。Worker 越しの依頼と結果、作図面と 2 次元の曲線。
export type {
  PlaneArc,
  PlaneCurve,
  PlanePolyline,
  PlaneSegment,
  SketchPlaneFrame,
  SketchProjectionItem,
  SketchProjectionOutcome,
  SketchSectionItem,
  Vec2Tuple,
} from './types.js';
export { makeProjection, orderPlaneCurves, planeBasisOf, projectPointToPlane } from './occt/makeProjection.js';
export { makeSection } from './occt/makeSection.js';
export { functionCurvePolylines } from './occt/functionCurvePolylines.js';
export {
  hiddenLineView,
  hiddenLineViewForBodies,
  NO_DRAWABLE_SOLID_MESSAGE,
} from './occt/makeHiddenLineViews.js';
export {
  makeSectionShape,
  NO_SECTION_AT_POSITION_MESSAGE,
} from './occt/makeSectionShape.js';
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
// 外観の面の照合(FR-1106)。model 側(kernelBridge.ts)が
// 割り当ての指紋を AppearanceQuery へ詰め替えて渡し、AppearanceMatch を受け取る。
export type { AppearanceMatch, AppearanceQuery } from './types.js';
// 基本形状(FR-429)。段の依頼の型と 5 種の作り手。
// model 側(resolvePart.ts)が PrimitiveStepSpec を組み立てて段に乗せる。
export type { PrimitiveStepSpec } from './types.js';
// 基準点を「立体の頂点」にする追補(FR-429)。頂点の選び直しは
// 部分形状の指紋の採点(matchVertex)をそのまま使い、対象は消費しない。
export {
  boxCornerOrigin,
  makePrimitive,
  offsetFromVertex,
  primitiveAxes,
  readAxesFrame,
  resolvePrimitiveOrigin,
  MISSING_PRIMITIVE_VERTEX_MESSAGE,
  PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE,
} from './occt/makePrimitive.js';
// 罫線面(FR-430)とロフト(FR-410)。段の依頼の型と作り手、
// 球への外接直線の純関数(OCCT を使わないので model / 検査からそのまま呼べる)。
// model 側(resolvePart.ts)が ThruSectionsStepSpec を組み立てて段に乗せる。
// `SphereSegmentCount`(24 / 48 / 72)は ui の「なめらかさ」の 3 択と
// model の欄が同じ型を使うために輸出する(3 か所で数を書き写さない)。
export type { SphereSegmentCount, ThruSectionSpec, ThruSectionsStepSpec } from './types.js';
export { makeThruSections } from './occt/makeThruSections.js';
export {
  tangentConeThroughCircle,
  tangentPointOnSphere,
  type TangentCone,
} from './occt/sphereTangent.js';
// Should 群・Could 群(FR-401、FR-409、FR-415〜FR-428、FR-432)。
//
// 段の依頼の型と、その作り手。model 側(`kernelBridge.ts` の `toSolidStepSpec`)
// がこれらを組み立てて段に乗せる。**依頼の型は作り手の依頼(`*Input`)の
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
  HoleEntrySpec,
  MirrorStepSpec,
  RibStepSpec,
  ScaleStepSpec,
  ShellStepSpec,
  SurfaceInput,
  SurfaceStepSpec,
  SweepStepSpec,
  ThinExtrudeSide,
  ThreadShaftStepSpec,
  TransformStepSpec,
} from './types.js';
export { makeCut, type CutInput } from './occt/makeCut.js';
export { makeDraft, draftStatusName, type DraftInput } from './occt/makeDraft.js';
export {
  editSolidFace,
  MIN_FACE_OFFSET_MM,
} from './occt/editSolidFace.js';
export { moveSolidHole } from './occt/moveSolidHole.js';
export { makeEmboss, type EmbossInput } from './occt/makeEmboss.js';
export { makeRib, type RibInput } from './occt/makeRib.js';
export { makeShell } from './occt/makeShell.js';
export { makeSurface, isShellShape } from './occt/makeSurface.js';
export { makeSweep, type SweepInput } from './occt/makeSweep.js';
export { makeThinExtrude } from './occt/makeThinExtrude.js';
export { makeThreadShaft, type ThreadShaftInput } from './occt/makeThread.js';
export {
  makeVariableFillet,
} from './occt/makeVariableFillet.js';
export {
  makeMirrorTransform,
  mirrorShape,
  scaleShape,
  type MirrorPlaneSpec,
  type ScaleSpec,
} from './occt/transformShape.js';
// 加工フィーチャー(FR-405〜408、FR-411、FR-412、FR-414)の型。
// 段の依頼(*StepSpec)と、部分形状の一覧・指紋(SolidFaceInfo 等・SubShapeQuery)を輸出する。
// model 側(kernelBridge.ts)がこれらを取り込んで詰め替える。
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
// 楕円・スプラインの稜線(FR-318、FR-317)。makeCurveEdge が振り分ける。
export { makeEllipseEdge, type EllipseSpec } from './occt/makeEllipseEdge.js';
export {
  bsplineDataForSpline,
  makeSplineEdge,
  splineDegree,
  type SplineSpec,
} from './occt/makeSplineEdge.js';
// スケッチの角の丸め・面取り(FR-323)。**OCCT を呼ばない純関数**なので、
// Worker を往復させず model 側(kernelBridge.ts)がそのまま呼ぶ。
// OCCT の ChFi2d を使わないと決めた理由は makeSketchFillet2d.ts の冒頭にある。
export {
  makeSketchFillet,
  type SketchFilletResult,
  type SketchFilletSpec,
} from './occt/makeSketchFillet2d.js';
export {
  makeSketchChamfer,
} from './occt/makeSketchChamfer2d.js';
export { tessellate, type FaceTriangleRange, type SurfaceMesh } from './occt/tessellate.js';
export {
  ANALYSIS_NODE_EDGE,
  ANALYSIS_NODE_FACE,
  ANALYSIS_NODE_VERTEX,
  AnalysisBoundaryError,
  analysisMeshBuffers,
  auditBoundary,
  buildAnalysisSurfaceMesh,
} from './occt/analysisSurfaceMesh.js';
export { extractEdges, type EdgeLines, type EdgeSegmentRange } from './occt/extractEdges.js';
export {
  buildSolidBodyMesh,
  hasSolid,
  isValidShape,
  measureArea,
  measureVolume,
} from './occt/solidMesh.js';
// 測定と質量特性(FR-1101、FR-1102)。Worker 越しの依頼と結果は
// `measure`(kernelApi)が受け、純関数は model 側の橋からも使える。
export type { MeasureRequest, MeasureResult, MeasureTargetSpec } from './types.js';
// **密度を引数に取る版(旧 `massProperties` / `ShapeMassProperties` /
// `GRAM_PER_CM3_TO_GRAM_PER_MM3`)は輸出しない。** 質量への密度の掛け算は model の
// `measure/massProperties.ts` の 1 か所だけで行う(kernel には置かない)。
export {
  angleBetween,
  distanceBetween,
  edgeLength,
  measureMassProperties,
  DISTANCE_FAILED_MESSAGE,
  MASS_PROPERTIES_FAILED_MESSAGE,
  type ShapeDistance,
} from './occt/measureShape.js';
export { makeExtrudeSolid, makeRevolveSolid } from './occt/makeSolidSweep.js';
export { sewSolid } from './occt/sewSolid.js';
export { booleanOp } from './occt/booleanOp.js';
// 確保の入れ物。makeHole.ts 等の加工の作り手が使い回す。
export { createAllocations, type Allocations, type OcctDeletable } from './occt/allocations.js';
// 面・辺・頂点の一覧と素性。
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
// 部分形状の指紋の採点。OCCT を使わない純関数。
export {
  MATCH_WEIGHT_AXIS,
  MATCH_WEIGHT_INDEX,
  MATCH_WEIGHT_POSITION,
  MATCH_WEIGHT_SIZE,
  MATCH_WEIGHT_VERTEX_INDEX,
  MATCH_WEIGHT_VERTEX_POSITION,
  SUB_SHAPE_MATCH_THRESHOLD,
  SUB_SHAPE_AMBIGUITY_MARGIN,
  resolveSubShapeCandidates,
  resolveFaceReference,
  resolveEdgeReference,
  resolveVertexReference,
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
// 穴・ねじ穴(FR-405、FR-406)。
export { makeHole, makeHoleTools, resolveHoleFrame, type HoleFrame } from './occt/makeHole.js';
export { makeThreadCut, makeThreadHole, threadSweepRadius } from './occt/makeThread.js';
// R 面取り・C 面取り(FR-407、FR-408)。
export { makeFillet, resolveFilletEdges } from './occt/makeFillet.js';
export { makeChamfer } from './occt/makeChamfer.js';
// らせん(ねじの実らせんとばねが共用)。
export {
  helixArcLength,
  helixAxisFrame,
  helixParameterLength,
  helixStartFrame,
  makeHelixEdge,
  makeHelixWire,
  type HelixSpec,
} from './occt/makeHelix.js';
// ばね(FR-414)。
export { makeSpring, makeSpringProfile } from './occt/makeSpring.js';
export { makeFunctionCurve } from './occt/makeFunctionCurve.js';
export { makeFunctionSurface } from './occt/makeFunctionSurface.js';
export { makeFunctionSurfaceBodies } from './occt/makeFunctionSurfaceBodies.js';
export type { FunctionSurfaceBodies } from './occt/classifyFunctionSurface.js';
export { MAX_FUNCTION_SURFACE_FACES, MAX_FUNCTION_SURFACE_VERTICES, type FunctionSurfaceGeometrySpec, type FunctionSurfaceInput } from './occt/functionSurfaceGeometrySpec.js';
export { clipFunctionShape, FUNCTION_CLIP_BOUND_TOLERANCE, type FunctionClipBox } from './occt/clipFunctionShape.js';
// 剛体変換(パターン、FR-411、FR-412)。
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
export { createKernelApi, type KernelApi, type ManagedKernelApi, type MaterialComparisonKernelApi } from './worker/kernelApi.js';
export type { AnalysisBoundaryKernelApi } from './worker/kernelApi.js';
export { createRuntimePhaseJournal, type RuntimePhaseJournalSnapshot } from './worker/runtimePhaseJournal.js';
export type { MaterialComparisonRequest } from './worker/compareCachedMaterials.js';
export type { MaterialComparisonOutcome } from './worker/compareMaterialBodies.js';
export type {
  HiddenLineRequest,
  HiddenLineResult,
  SectionRequest,
  SectionResult,
} from './types.js';
export type {
  InterferenceComponentSpec,
  InterferencePair,
  InterferenceProgress,
  InterferenceRequest,
  InterferenceResult,
} from './types.js';
export { createKernelWorker } from './client/createKernelWorker.js';
// ---------------------------------------------------------------------------
// 入出力(FR-802、FR-803、FR-804)。
//
// **`packages/io` はここから取り込まない**(依存方向は io → kernel を持たない)。
// 取り込むのは `packages/model` の橋(`kernelBridge.ts`)と、Worker を持たない
// 検査である。断りの文言をすべて輸出してあるのは、**画面が同じ文言を書き写さずに
// 引き当てられるようにする**ため(NFR-MA-5)。
// ---------------------------------------------------------------------------
// 仮想ファイルの出し入れ。OCCT の読み書きは名前しか取らないので、
// WASM の中のファイル置き場を経由してバイト列にする。
export {
  withVirtualFile,
  withVirtualFileInput,
} from './occt/virtualFile.js';
// XCAF の文書。STEP / OBJ / glTF が共用する、名前と色を持てる入れ物。
export {
  buildXcafDocument,
} from './occt/xcafDocument.js';
// 面ごとの色。STEP(`writeStep.ts`)と OBJ / glTF(`writeCafMesh.ts`)
// の両方が使う表と、その検査・断りの文言。
export {
  applyFaceColors,
  checkExportColor,
  faceColorNotFoundMessage,
} from './occt/xcafFaceColors.js';
// STEP の書き出しと読み込み。
export {
  writeStep,
  writeXcafStepDocument,
} from './occt/writeStep.js';
export {
  writeStepAssembly,
  ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE,
  ASSEMBLY_DUPLICATE_NODE_MESSAGE,
  ASSEMBLY_EMPTY_DEFINITION_MESSAGE,
  ASSEMBLY_EMPTY_NODE_MESSAGE,
  ASSEMBLY_MISSING_DEFINITION_MESSAGE,
  ASSEMBLY_NO_SHAPE_MESSAGE,
} from './occt/xcafAssembly.js';
export {
  readStep,
  STEP_NO_SHAPE_MESSAGE,
  STEP_NO_SOLID_MESSAGE,
  STEP_READ_FAILED_MESSAGE,
} from './occt/readStep.js';
export {
  readStepAssembly,
  placementFromStepLocation,
  STEP_ASSEMBLY_COMPONENT_MESSAGE,
  STEP_ASSEMBLY_CYCLE_MESSAGE,
} from './occt/readStepAssembly.js';
// B-rep ↔ バイト列。読み込んだ形を `.pcad` へ抱き込む。
export {
  readBrepBytes,
  writeBrepBytes,
  BREP_EMPTY_SHAPE_MESSAGE,
  BREP_READ_FAILED_MESSAGE,
  BREP_WRITE_FAILED_MESSAGE,
} from './occt/brepBytes.js';
// 書き出し用の三角形の作り直し。画面用のキャッシュを汚さない。
export {
  buildExportMesh,
  EXPORT_ANGULAR_DEFLECTION_MESSAGE,
  EXPORT_COPY_FAILED_MESSAGE,
  EXPORT_DEFLECTION_MESSAGE,
  type ExportMesh,
} from './occt/exportMesh.js';
// 入出力で 2 つ以上のファイルが共用するもの(1 か所へ寄せた)。
// 断りの文言・三角形の束の型・法線と体積の計算は**ここが正本**で、`readStl.ts` /
// `readCafMesh.ts` は形式ごとの名前で中継しているだけ(同じ文言を 2 か所に置かない)。
export {
  INVALID_EXPORT_COLOR_MESSAGE,
  MESH_MAX_TRIANGLE_COUNT,
  MESH_NO_FACE_MESSAGE,
  MESH_NO_SHAPE_MESSAGE,
  MESH_READ_FAILED_MESSAGE,
  computeVertexNormals,
  computeVolume,
  meshTooLargeMessage,
  type ImportedMeshData,
} from './occt/exchangeShared.js';
// STL の書き出し。三角形の網を受け取り、バイト列を JS で組む純関数。
// `forEachExportTriangle` は STL / OBJ / glTF / 3MF が共用する三角形のたどり方で、
// 面積 0 の三角形を落とす判定(`DEGENERATE_CROSS_LENGTH_MM2`)もここが 1 か所の正本。
export {
  DEGENERATE_CROSS_LENGTH_MM2,
  forEachExportTriangle,
  writeStl,
} from './occt/writeStl.js';
// OBJ / glTF(.glb)の書き出し。立体ごとの色つき、これも純関数。
export {
  writeCafMesh,
  DEFAULT_BODY_COLOR,
  MESH_NO_FACE_RANGES_MESSAGE,
} from './occt/writeCafMesh.js';
// STL の読み込み。断りの文言は共有の置き場の中継(上の注釈)。
export {
  readStl,
  startsWithBytes,
  STL_MAX_TRIANGLE_COUNT,
  STL_NO_FACE_MESSAGE,
  STL_READ_FAILED_MESSAGE,
  stlTooLargeMessage,
} from './occt/readStl.js';
// OBJ / glTF の読み込み。glTF は m から mm へ直して返す。
export {
  readCafMesh,
  CAF_MESH_MAX_TRIANGLE_COUNT,
  CAF_MESH_NO_SHAPE_MESSAGE,
  CAF_MESH_READ_FAILED_MESSAGE,
  cafMeshTooLargeMessage,
} from './occt/readCafMesh.js';
// Worker 越しの書き出し・読み込みの依頼と結果。**口は 1 本ずつ**で、
// 形式は依頼の中の `format` で判別する。
export type {
  ShapeExportFile,
  ShapeExportItem,
  ShapeExportMeshBody,
  ShapeExportMeshQuality,
  ShapeExportRequest,
  ShapeExportResult,
  ShapeImportBody,
  ShapeImportRequest,
  ShapeImportResult,
} from './types.js';
// 読み込んだ形のベースボディの段(FR-802)。model 側が
// `shapeRef` を鍵にしてこの段を組み立てる。
export type { ImportedSolidStepSpec } from './types.js';
// 3D プリント向けの点検(FR-815、NFR-PF-4)。
//
// 依頼の型(`ShapeInspectRequest`)は書き出しと同じ鍵の一覧を使い回すので `types.ts` から、
// 点検そのものの型と純関数は `occt/inspectPrintability.ts` が正本なのでそこから輸出する。
// **`inspectPrintability` という名前は `KernelApi` のメソッド名とも同じだが、衝突しない。**
// メソッドは `KernelApi` インターフェース経由(`api.inspectPrintability(...)`)でしか
// 呼ばれず、トップレベルの輸出には現れない(`KernelApi` 型そのものしか輸出しない)ため、
// ここで輸出するのは occt 側の純関数そのままでよい。
export type { ShapeInspectRequest } from './types.js';
export {
  inspectPrintability,
  printabilityFlagByteLength,
  readPrintabilityFlag,
  BUILD_PLATE_TOLERANCE_MM,
  DEFAULT_MIN_THICKNESS_MM,
  DEFAULT_OVERHANG_ANGLE_DEG,
  PRINTABILITY_MIN_THICKNESS_MESSAGE,
  PRINTABILITY_NO_TRIANGLE_MESSAGE,
  PRINTABILITY_OVERHANG_ANGLE_MESSAGE,
  type PrintabilityProgress,
  type PrintabilityResult,
} from './occt/inspectPrintability.js';
// 配置つきの立体の組み立てと境界箱(FR-601、FR-615)。
//
// 配置の型(`PlacementSpec` / `QuaternionTuple`)は段の依頼と同じく `types.ts` が正本で、
// 形を置く手続きと境界箱は `occt/placeBodies.ts` が正本。**四元数 → gp_Trsf の橋は
// `makePlacementTransform` 1 か所だけ**なので、輸出もそこからの 1 経路だけにする。
export type { PlacementSpec } from './types.js';
export {
  IDENTITY_PLACEMENT,
  boundingBoxOf,
  boundingBoxRange,
  boundingBoxesOverlap,
  makePlacementTransform,
  placeShape,
  transformedBoundingBox,
} from './occt/placeBodies.js';
export type {
  SubShapeOrigin,
  CurrentOriginIndex,
} from './subShapeOrigin.js';

export type { PointProducerAnchor } from './subShapeOrigin.js';

export {
  makeSurfaceCut,
  SurfaceCutError,
} from './occt/makeSurfaceCut.js';
export { rotateSolidFace } from './occt/rotateSolidFace.js';

export type { HoleTranslateStepSpec } from './types.js';
