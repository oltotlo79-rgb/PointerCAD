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
export {
  hiddenLineView,
  hiddenLineViewForBodies,
  NO_DRAWABLE_SOLID_MESSAGE,
  type HiddenLineBodiesSpec,
  type HiddenLineSource,
  type HiddenLineViewOutcome,
  type HiddenLineViewSpec,
} from './occt/makeHiddenLineViews.js';
export {
  makeSectionShape,
  NO_SECTION_AT_POSITION_MESSAGE,
  type CutFaceInfo,
  type SectionShapeOutcome,
  type SectionShapeSpec,
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
// **密度を引数に取る版(旧 `massProperties` / `ShapeMassProperties` /
// `GRAM_PER_CM3_TO_GRAM_PER_MM3`)は輸出しない。** 質量への密度の掛け算は model の
// `measure/massProperties.ts` の 1 か所だけで行う(§0.a-0.78、タスク42b で kernel から削除)。
export {
  angleBetween,
  distanceBetween,
  edgeLength,
  measureMassProperties,
  DISTANCE_FAILED_MESSAGE,
  MASS_PROPERTIES_FAILED_MESSAGE,
  type ShapeDistance,
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
export { createKernelApi, type KernelApi, type ManagedKernelApi, type InterferenceKernelApi } from './worker/kernelApi.js';
export type {
  DrawingKernelCancelToken,
  DrawingBodyInstance,
  DrawingKernelFailure,
  DrawingKernelProgress,
  DrawingKernelProgressCallback,
  HiddenLineCurve,
  HiddenLineMode,
  HiddenLineProvenance,
  HiddenLineRequest,
  HiddenLineResult,
  HiddenLineViewRequest,
  HiddenLineViewResult,
  SectionRequest,
  SectionResult,
} from './types.js';
export type {
  InterferenceComponentSpec, InterferenceFailureCode, InterferenceInputCode, InterferenceMesh,
  InterferencePair, InterferencePairFailure, InterferencePairId, InterferenceProgress,
  InterferenceReport, InterferenceRequest, InterferenceResult, InterferenceRootFailure, InterferenceSkip,
} from './types.js';
export { createKernelWorker } from './client/createKernelWorker.js';
// ---------------------------------------------------------------------------
// 入出力(FR-802、FR-803、FR-804。P6 タスク6〜11、タスク10 でまとめて輸出した)。
//
// **`packages/io` はここから取り込まない**(依存方向は io → kernel を持たない。§0.a-0.2)。
// 取り込むのは `packages/model` の橋(`kernelBridge.ts`、タスク20)と、Worker を持たない
// 検査である。断りの文言をすべて輸出してあるのは、**画面が同じ文言を書き写さずに
// 引き当てられるようにする**ため(NFR-MA-5)。
// ---------------------------------------------------------------------------
// 仮想ファイルの出し入れ(§2.2、タスク6)。OCCT の読み書きは名前しか取らないので、
// WASM の中のファイル置き場を経由してバイト列にする。
export {
  withVirtualFile,
  withVirtualFileInput,
  type VirtualFileOutput,
} from './occt/virtualFile.js';
// XCAF の文書(§2.5、タスク7)。STEP / OBJ / glTF が共用する、名前と色を持てる入れ物。
export {
  buildXcafDocument,
  type RgbTuple,
  type XcafDocument,
  type XcafDocumentOptions,
  type XcafShapeEntry,
} from './occt/xcafDocument.js';
// 面ごとの色(§2.5.1、タスク7b+13b)。STEP(`writeStep.ts`)と OBJ / glTF(`writeCafMesh.ts`)
// の両方が使う表と、その検査・断りの文言。
export {
  applyFaceColors,
  checkExportColor,
  faceColorNotFoundMessage,
  type FaceColorMap,
} from './occt/xcafFaceColors.js';
// STEP の書き出し(§2.3、タスク7)と読み込み(§2.3・§2.9、タスク8)。
export {
  writeStep,
  writeXcafStepDocument,
  type StepWriteEntry,
  type StepWriteOptions,
  type StepWriteResult,
} from './occt/writeStep.js';
export {
  writeStepAssembly,
  ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE,
  ASSEMBLY_DUPLICATE_NODE_MESSAGE,
  ASSEMBLY_EMPTY_DEFINITION_MESSAGE,
  ASSEMBLY_EMPTY_NODE_MESSAGE,
  ASSEMBLY_MISSING_DEFINITION_MESSAGE,
  ASSEMBLY_NO_SHAPE_MESSAGE,
  type XcafAssemblyDefinition,
  type XcafAssemblySpec,
  type XcafAssemblyWriteOptions,
} from './occt/xcafAssembly.js';
export {
  readStep,
  STEP_NO_SHAPE_MESSAGE,
  STEP_NO_SOLID_MESSAGE,
  STEP_READ_FAILED_MESSAGE,
  type StepFileLengthUnit,
  type StepReadBody,
  type StepReadOptions,
  type StepReadResult,
} from './occt/readStep.js';
export {
  readStepAssembly,
  placementFromStepLocation,
  STEP_ASSEMBLY_COMPONENT_MESSAGE,
  STEP_ASSEMBLY_CYCLE_MESSAGE,
  type StepAssemblyDefinition,
  type StepAssemblyReadResult,
} from './occt/readStepAssembly.js';
// B-rep ↔ バイト列(§0.a-0.9・§0.a-0.10、タスク9)。読み込んだ形を `.pcad` へ抱き込む。
export {
  readBrepBytes,
  writeBrepBytes,
  BREP_EMPTY_SHAPE_MESSAGE,
  BREP_READ_FAILED_MESSAGE,
  BREP_WRITE_FAILED_MESSAGE,
} from './occt/brepBytes.js';
// 書き出し用の三角形の作り直し(§0.a-0.13、タスク11)。画面用のキャッシュを汚さない。
export {
  buildExportMesh,
  EXPORT_ANGULAR_DEFLECTION_MESSAGE,
  EXPORT_COPY_FAILED_MESSAGE,
  EXPORT_DEFLECTION_MESSAGE,
  type ExportMesh,
  type ExportMeshOptions,
} from './occt/exportMesh.js';
// 入出力で 2 つ以上のファイルが共用するもの(タスク16 で 1 か所へ寄せた)。
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
// STL の書き出し(§2.4、タスク12)。三角形の網を受け取り、バイト列を JS で組む純関数。
// `forEachExportTriangle` は STL / OBJ / glTF / 3MF が共用する三角形のたどり方で、
// 面積 0 の三角形を落とす判定(`DEGENERATE_CROSS_LENGTH_MM2`)もここが 1 か所の正本。
export {
  DEGENERATE_CROSS_LENGTH_MM2,
  forEachExportTriangle,
  writeStl,
  type ExportTriangle,
  type StlWriteOptions,
  type StlWriteResult,
} from './occt/writeStl.js';
// OBJ / glTF(.glb)の書き出し(§2.4・§2.5、タスク13)。立体ごとの色つき、これも純関数。
export {
  writeCafMesh,
  DEFAULT_BODY_COLOR,
  MESH_NO_FACE_RANGES_MESSAGE,
  type CafMeshBody,
  type CafMeshFile,
  type CafMeshWriteOptions,
  type CafMeshWriteResult,
} from './occt/writeCafMesh.js';
// STL の読み込み(§2.8、タスク17)。断りの文言は共有の置き場の中継(上の注釈)。
export {
  readStl,
  STL_MAX_TRIANGLE_COUNT,
  STL_NO_FACE_MESSAGE,
  STL_READ_FAILED_MESSAGE,
  stlTooLargeMessage,
  type StlReadOptions,
} from './occt/readStl.js';
// OBJ / glTF の読み込み(§2.8、タスク18)。glTF は m から mm へ直して返す。
export {
  readCafMesh,
  CAF_MESH_MAX_TRIANGLE_COUNT,
  CAF_MESH_NO_SHAPE_MESSAGE,
  CAF_MESH_READ_FAILED_MESSAGE,
  cafMeshTooLargeMessage,
  type CafMeshFormat,
  type CafMeshReadOptions,
} from './occt/readCafMesh.js';
// Worker 越しの書き出し・読み込みの依頼と結果(タスク10・16)。**口は 1 本ずつ**で、
// 形式は依頼の中の `format` で判別する(§0.a-0.2)。
export type {
  ShapeExportBrepBody,
  ShapeExportAssembly,
  ShapeExportAssemblyDefinition,
  ShapeExportFile,
  ShapeExportItem,
  ShapeExportMeshBody,
  ShapeExportMeshQuality,
  ShapeExportRequest,
  ShapeExportResult,
  ShapeImportBody,
  ShapeImportAssembly,
  ShapeImportAssemblyDefinition,
  ShapeImportRequest,
  ShapeImportResult,
  ShapeAssemblyNode,
} from './types.js';
// 読み込んだ形のベースボディの段(FR-802、§2.8、タスク10)。model 側(タスク20)が
// `shapeRef` を鍵にしてこの段を組み立てる。
export type { ImportedSolidStepSpec } from './types.js';
// 3D プリント向けの点検(FR-815、NFR-PF-4、P6 §0.51・§2.16、タスク42)。
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
  type PrintabilityCancelToken,
  type PrintabilityHooks,
  type PrintabilityOptions,
  type PrintabilityPhase,
  type PrintabilityProgress,
  type PrintabilityProgressCallback,
  type PrintabilityResult,
  type PrintabilitySummary,
} from './occt/inspectPrintability.js';
// 配置つきの立体の組み立てと境界箱(FR-601、FR-615、P7 §2.4、タスク8)。
//
// 配置の型(`PlacementSpec` / `QuaternionTuple`)は段の依頼と同じく `types.ts` が正本で、
// 形を置く手続きと境界箱は `occt/placeBodies.ts` が正本。**四元数 → gp_Trsf の橋は
// `makePlacementTransform` 1 か所だけ**なので、輸出もそこからの 1 経路だけにする。
export type { PlacementSpec, QuaternionTuple } from './types.js';
export {
  IDENTITY_PLACEMENT,
  boundingBoxOf,
  boundingBoxRange,
  boundingBoxesOverlap,
  makePlacementTransform,
  placeShape,
  transformedBoundingBox,
  type BoundingBoxRange,
  type OcctBoxHandle,
} from './occt/placeBodies.js';
