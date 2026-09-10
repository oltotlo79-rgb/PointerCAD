import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { readBrepBytes, writeBrepBytes } from '../occt/brepBytes.js';
import type { ImportedMeshData } from '../occt/exchangeShared.js';
import type { ExportMesh } from '../occt/exportMesh.js';
import { buildExportMesh } from '../occt/exportMesh.js';
// 窓口の名前(KernelApi.inspectPrintability)と実体の名前が同じなので、実体は別名で取り込む
// (recomputeSolids と同じ流儀)。
import {
  inspectPrintability as runInspectPrintability,
  type PrintabilityCancelToken,
  type PrintabilityProgressCallback,
} from '../occt/inspectPrintability.js';
import { makeOffsetWire } from '../occt/makeOffsetWire.js';
import { distanceBetween, measureMassProperties } from '../occt/measureShape.js';
import { makePlanarFace } from '../occt/makePlanarFace.js';
import { hiddenLineViewForBodies, type HiddenLineSource } from '../occt/makeHiddenLineViews.js';
import { createAllocations } from '../occt/allocations.js';
import { makeProjection } from '../occt/makeProjection.js';
import { makeSection } from '../occt/makeSection.js';
import { makeSectionShape } from '../occt/makeSectionShape.js';
import { discretizeEdge, makeCurveEdge } from '../occt/makeSketchEdges.js';
import { placeShape } from '../occt/placeBodies.js';
import { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from '../occt/pickSubShape.js';
import { readCafMesh } from '../occt/readCafMesh.js';
import { readStepAssembly } from '../occt/readStepAssembly.js';
import { readStl } from '../occt/readStl.js';
import { hasSolid, measureVolume } from '../occt/solidMesh.js';
import { tessellate } from '../occt/tessellate.js';
import { normalizeBaseName, writeCafMesh } from '../occt/writeCafMesh.js';
import { writeStep } from '../occt/writeStep.js';
import { writeStl } from '../occt/writeStl.js';
import { writeStepAssembly } from '../occt/xcafAssembly.js';
import type { RgbTuple } from '../occt/xcafDocument.js';
import type {
  InterferenceRequest,
  InterferenceResult,
  DrawingKernelCancelToken,
  DrawingBodyInstance,
  DrawingKernelProgressCallback,
  FaceMeshData,
  HiddenLineRequest,
  HiddenLineResult,
  MeasureRequest,
  MeasureResult,
  ShapeExportBrepBody,
  ShapeExportAssembly,
  ShapeExportItem,
  ShapeExportMeshBody,
  ShapeExportMeshQuality,
  ShapeExportRequest,
  ShapeExportResult,
  ShapeImportBody,
  ShapeImportAssembly,
  ShapeImportRequest,
  ShapeImportResult,
  ShapeInspectMeshIdentity,
  ShapeInspectRequest,
  ShapeInspectResult,
  SectionRequest,
  SectionResult,
  SketchOffsetFailure,
  SketchOffsetOutcome,
  SketchOffsetRequest,
  SketchOffsetResult,
  SketchProjectionFailure,
  SketchProjectionOutcome,
  SketchProjectionRequest,
  SketchProjectionResult,
  SketchSectionRequest,
  SketchTessellation,
  SketchTessellationFailure,
  SketchTessellationRequest,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  TessellationOptions,
} from '../types.js';
// 窓口の名前と実体の名前が同じだと読み分けにくいので、実体は別名で取り込む。
import {
  recomputeSolids as runSolidRecompute,
  type CachedSolid,
  type SolidCancelToken,
  type SolidProgressCallback,
} from './recomputeSolids.js';
import { createShapeCache, type AcquireToken, type AcquiringShapeCache, type ShapeCache, type ShapeCacheStats } from './shapeCache.js';
import {
  checkInterference as runCheckInterference, snapshotInterferenceRequest, prepareInterference,
  initialInterferenceResult, interferenceRootFailure, type InterferenceProgressCallback,
} from './checkInterference.js';

const DEFAULT_PART_ID = 'part:current';

/** Comlink でも name は残る。鍵の一覧は checkShapeAvailability から構造化して取得する。 */
export class MissingBodiesError extends Error {
  override readonly name = 'MissingBodiesError';

  constructor(readonly partId: string, readonly missingKeys: readonly string[]) {
    super(MISSING_BODY_MESSAGE);
  }
}

export interface ShapeAvailability {
  readonly partId: string;
  readonly missingKeys: readonly string[];
}

/**
 * 投影・交差(FR-325)のもとになる立体が形状キャッシュに無いとき。
 *
 * 形は `recomputeSolids` が段を作ったときに預けられるので、通常は必ず当たる。
 * 当たらないのは、①その段が作れなかった、②容量(`SHAPE_CACHE_CAPACITY`)を
 * 超えて追い出された、③Worker が作り直されてキャッシュが空になった、のいずれか。
 * どれも「もう一度計算し直せば直る」ので、そう伝える(FR-504、NFR-RE-1)。
 */
const MISSING_BODY_MESSAGE =
  'もとになる立体が見つかりませんでした。もう一度計算し直してください。';

/**
 * 測る形が形状キャッシュに無いとき(FR-1101、FR-1102、§0.a-0.30)。
 *
 * 測定は再計算を起こさない読み取りなので、ここで自分から作り直すことはしない。
 * 呼び出し側(UI)は、再計算の完了を待って**自動で 1 回だけ測り直し**、
 * それでも無ければこの文言をそのまま見せる(§0.a-0.30 の条件)。
 */
const MEASURE_MISSING_SHAPE_MESSAGE = '測れませんでした。もう一度お試しください。';

/** 距離を測るのに対象が 2 つでないとき。 */
const MEASURE_NEEDS_TWO_MESSAGE = '距離を測るには 2 つ選んでください。';

/** 質量特性を測るのに対象が 1 つでないとき。 */
const MEASURE_NEEDS_ONE_MESSAGE = '体積と重心を測るには立体を 1 つ選んでください。';

/**
 * 読み込んだ形へ付ける、画面用の三角形の粗さ(FR-802、P6 §2.8)。
 *
 * **省略と同じ意味の空の指定**にしてある。`tessellate` の既定(線形 0.1mm・角度 0.5rad)は
 * 画面表示の既定そのもので、読み込んだ形も画面に出るところは他のボディと変わらないため、
 * ここで別の粗さを決める理由が無い。書き出しの偏差(FR-803)とは別物で、そちらは
 * 依頼が数で指定する(`ShapeExportRequest` の `deviationMm`)。
 */
const IMPORT_TESSELLATION: TessellationOptions = {};

/**
 * 書き出す立体を鍵から引く(FR-803)。
 *
 * **1 つでも見つからなければ書き出しごと断る。** 一部だけ入ったファイルを渡すと、
 * 利用者は欠けに気づかないまま他の CAD へ持っていくことになる(NFR-UX-5 は
 * 「実行してから失敗させない」)。文言は投影・交差と同じ `MISSING_BODY_MESSAGE` で、
 * 直し方(もう一度計算し直す)も同じである。
 *
 * **形はキャッシュの持ち物**なので、この関数も呼び出し側も解放しない。
 */
function resolveExportShapes(
  cache: ShapeCache<CachedSolid>,
  bodies: readonly ShapeExportItem[],
  partId: string,
): readonly TopoDS_Shape[] {
  const missing = [...new Set(bodies.map((item) => item.bodyKey))].filter((key) => !cache.has(key));
  if (missing.length > 0) {
    throw new MissingBodiesError(partId, missing);
  }
  return bodies.map((item) => {
    const cached = cache.get(item.bodyKey);
    if (cached === undefined) {
      throw new MissingBodiesError(partId, [item.bodyKey]);
    }
    return cached.shape;
  });
}

/** アセンブリ STEP では、共有定義に載ったボディを 1 回ずつ確保する。 */
function exportItemsOf(request: ShapeExportRequest): readonly ShapeExportItem[] {
  if (request.format === 'step' && request.assembly !== undefined) {
    return request.assembly.definitions.flatMap((definition) => definition.bodies);
  }
  return request.bodies;
}

/** 鍵から引いた OCCT の形を、アセンブリ書き手が受ける定義へ同じ順で詰める。 */
function assemblyWithShapes(
  assembly: ShapeExportAssembly,
  shapes: readonly TopoDS_Shape[],
): Parameters<typeof writeStepAssembly>[1] {
  let shapeIndex = 0;
  const definitions = assembly.definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    bodies: definition.bodies.map((body) => ({
      shape: shapes[shapeIndex++],
      name: body.name,
      color: body.color,
      faceColors: body.faceColors,
    })),
  }));
  return { name: assembly.name, definitions, children: assembly.children };
}

/**
 * 読み込んだ形 1 つを、Comlink 越しに渡せる形へ畳む(FR-802、P6 §2.8)。
 *
 * **バイト列を三角形より先に作る。** `tessellate` は `BRepMesh_IncrementalMesh` を通して
 * **形そのものへ三角形を書き込む**ので、順序を逆にすると三角形分割の付いた形が保存され、
 * `.pcad` に入るバイト列が無駄に大きくなる(`occt/brepBytes.ts` の実測: 20³ の箱で
 * 4,494 → 6,931 バイト。`BinTools.Write_3` は三角形分割も一緒に書く)。
 *
 * 渡された形は呼び出し側が解放する(STEP なら `StepReadResult.delete()`、
 * B-rep なら `readBrepBytes` が返した形)。この関数は持ち主にならない。
 */
function toImportBody(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  name: string | null,
  color: RgbTuple | null,
  bodyKind: 'solid' | 'shell',
): ShapeImportBody {
  const brepBytes = writeBrepBytes(oc, shape);
  const volume = measureVolume(oc, shape);
  const surface = tessellate(oc, shape, IMPORT_TESSELLATION);
  return {
    name,
    color,
    bodyKind,
    volume,
    brepBytes,
    triangles: {
      positions: surface.positions,
      normals: surface.normals,
      indices: surface.indices,
      triangleCount: surface.triangleCount,
    },
  };
}

/**
 * 読み込んだ三角形の形 1 つを、Comlink 越しに渡せる形へ畳む(FR-802、P6 §2.8、§0.a-0.23)。
 *
 * **B-rep は作らない。** 三角形から面を張り直すと面が三角形の数だけでき、その上の
 * フィレットも穴あけも実用にならない(§0.a-0.23)。だから `bodyKind` は `'mesh'` で、
 * この枝には `brepBytes` の欄そのものが無い(`ShapeImportBody` の注釈)。
 *
 * **名前と色は `null` にする。** STL には名前も色も無く、OBJ / glTF は持てるが
 * `readCafMesh` が形だけを取り出す作りである(読み込んだ色は当面使わない決定
 * §0.a-0.28 の下では、読む手間に見合わない)。取り込むなら P7 以降。
 *
 * 体積は読み手が三角形から数えた値(発散定理。`occt/exchangeShared.ts` の `computeVolume`)。
 */
function toImportMeshBody(mesh: ImportedMeshData): ShapeImportBody {
  return {
    name: null,
    color: null,
    bodyKind: 'mesh',
    volume: mesh.volume,
    triangles: {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      triangleCount: mesh.triangleCount,
    },
  };
}

/**
 * 書き出す立体ぶんの三角形を、依頼の品質でまとめて作り直す(FR-803、§0.a-0.13)。
 *
 * **形の複製に掛けるので、画面用のキャッシュは 1 枚も汚れない**(`occt/exportMesh.ts`)。
 * 品質の対(長さと角度)は依頼のまま渡す——角度を省いた依頼では
 * `angularDeflectionRad` が `undefined` のまま渡り、`buildExportMesh` の既定
 * (画面用と同じ 0.5rad)に落ちる。
 */
function buildExportMeshes(
  oc: OpenCascadeInstance,
  shapes: readonly TopoDS_Shape[],
  quality: ShapeExportMeshQuality,
): ExportMesh[] {
  return shapes.map((shape) =>
    buildExportMesh(oc, shape, quality.deviationMm, {
      angularDeflectionRad: quality.angularDeflectionRad,
    }),
  );
}

/**
 * 書き出し用の三角形を 1 つの網に連ねる(3D プリント点検、FR-815、タスク42)。
 *
 * **`inspectPrintability`(`occt/inspectPrintability.ts`)は `ExportMesh` を 1 つしか
 * 受け取らない。** 複数ボディを指定したときは、水密性・肉厚とも「ボディをまたいだ
 * 1 つの形」として測ってよい(§0.51 の点検はボディの区別を持たない)ので、ここで
 * 添字をずらしながら連結する(STL の `writeStl.ts` が複数の網を 1 ファイルへ書くのと
 * 同じ考え方だが、あちらはバイト列を直接書くのに対し、ここは 1 本の `ExportMesh` を
 * 組み立てて `inspectPrintability` へそのまま渡す点が違う)。
 */
function mergeExportMeshes(meshes: readonly ExportMesh[]): ExportMesh {
  const [only] = meshes;
  // 1 個だけなら連結の手間もコピーも要らない。
  if (meshes.length === 1 && only !== undefined) {
    return only;
  }
  let vertexTotal = 0;
  let triangleCount = 0;
  for (const mesh of meshes) {
    vertexTotal += mesh.positions.length / 3;
    triangleCount += mesh.triangleCount;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(triangleCount * 3);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset * 3);
    normals.set(mesh.normals, vertexOffset * 3);
    for (let index = 0; index < mesh.indices.length; index += 1) {
      indices[indexOffset + index] = mesh.indices[index] + vertexOffset;
    }
    indexOffset += mesh.indices.length;
    vertexOffset += mesh.positions.length / 3;
  }
  return { positions, normals, indices, triangleCount };
}

/** Worker に残す、直近の再計算で画面へ返した typed array とその世代。 */
interface DisplayMeshEntry extends ShapeInspectMeshIdentity {
  readonly mesh: ExportMesh;
}

/**
 * 再計算の結果から、画面へ返した表示メッシュだけを段の鍵で引ける表にする。
 *
 * `SolidBodyMesh` は `ExportMesh` の 4 欄を包含するので、positions / normals / indices を
 * 写さず同じ typed array を指す。OCCT の形は持たず、次の完了した再計算で表ごと捨てる。
 */
function displayMeshesOf(
  request: SolidRecomputeRequest,
  result: SolidRecomputeResult,
  meshRevision: number,
): ReadonlyMap<string, DisplayMeshEntry> {
  const bodyById = new Map(result.bodies.map((body) => [body.id, body]));
  const displayMeshes = new Map<string, DisplayMeshEntry>();
  for (const step of request.steps) {
    if (!step.visible || displayMeshes.has(step.key)) {
      continue;
    }
    const body = bodyById.get(step.id);
    if (body === undefined) {
      continue;
    }
    displayMeshes.set(step.key, {
      bodyKey: step.key,
      meshRevision,
      triangleCount: body.triangleCount,
      mesh: body,
    });
  }
  return displayMeshes;
}

/** 点検対象を、直近に画面へ返した表示メッシュから依頼順に引く。 */
function resolveDisplayMeshes(
  displayMeshes: ReadonlyMap<string, DisplayMeshEntry>,
  bodies: readonly ShapeExportItem[],
  partId: string,
): readonly DisplayMeshEntry[] {
  return bodies.map((item) => {
    const displayed = displayMeshes.get(item.bodyKey);
    if (displayed === undefined) {
      throw new MissingBodiesError(partId, [item.bodyKey]);
    }
    return displayed;
  });
}

/** UI 側から Comlink 越しに呼べる幾何カーネルの窓口。 */
export interface KernelApi {
  /** スケッチの曲線を折れ線に、閉ループを面にする(FR-309)。 */
  tessellateSketch(
    request: SketchTessellationRequest,
    options?: TessellationOptions,
  ): Promise<SketchTessellation>;
  /**
   * 部品の履歴を先頭から計算し直し、表示用のボディを返す(FR-401〜404、FR-504)。
   *
   * onProgress と cancelToken は Comlink.proxy で包んだ関数を渡す。
   * cancelToken が true を返すと、段と段の間で残りを打ち切って cancelled: true で返る
   * (1 段の演算そのものは途中で止められない。NFR-PF-4)。
   */
  recomputeSolids(
    request: SolidRecomputeRequest,
    options?: TessellationOptions,
    onProgress?: SolidProgressCallback,
    cancelToken?: SolidCancelToken,
  ): Promise<SolidRecomputeResult>;
  /**
   * 輪郭を距離ぶん平行にずらした曲線の列を作る(FR-321、P4 タスク15)。
   *
   * 何件でも 1 回の往復でまとめて頼める(面のテッセレーションと同じ形)。
   * 1 件失敗しても残りは作り、理由を `failures` へ入れて返す(FR-504、NFR-RE-1)。
   * 距離の符号(どちら側へずらすか)は呼び出し側が決める(§0.a-0.22)。
   */
  offsetSketchCurves(request: SketchOffsetRequest): Promise<SketchOffsetOutcome>;
  /**
   * 立体の面・辺の輪郭を作図面へ投影した曲線を作る(FR-325、P4 タスク25・26)。
   *
   * もとの立体は**形状キャッシュの鍵**で指す(B-rep は Comlink 越しに渡せないため)。
   * 鍵は `recomputeSolids` が段ごとに預けたもので、上流が変われば鍵も変わる。
   * 何件でも 1 回の往復でまとめて頼め、1 件失敗しても残りは作る(FR-504、NFR-RE-1)。
   */
  projectSketchCurves(request: SketchProjectionRequest): Promise<SketchProjectionOutcome>;
  /**
   * 立体と作図面の交線(断面の輪郭)を作る(FR-325)。
   * 交わらないときは**失敗ではなく空の結果**を返す(`makeSection.ts` の決め)。
   */
  sectionSketchCurves(request: SketchSectionRequest): Promise<SketchProjectionOutcome>;
  /** 複数の図を1往復で隠線処理する。中止は図と図の間で受け付ける(FR-702)。 */
  hiddenLineViews(
    request: HiddenLineRequest,
    onProgress?: DrawingKernelProgressCallback,
    cancelToken?: DrawingKernelCancelToken,
  ): Promise<HiddenLineResult>;
  /** 半空間で切った形のHLRと切断面との交線をまとめて返す(FR-713)。 */
  sectionViews(
    request: SectionRequest,
    onProgress?: DrawingKernelProgressCallback,
    cancelToken?: DrawingKernelCancelToken,
  ): Promise<SectionResult>;
  /**
   * 覚えてある形を測る(FR-1101、FR-1102、P5 タスク28)。
   *
   * **測定は再計算を起こさない読み取り**(§0.a-0.30)。対象は投影・交差と同じく
   * **形状キャッシュの鍵**(段の `key`)で指し、面・辺・頂点は指紋で選び直す。
   * 選び直しは P3 の部分形状の参照(`occt/pickSubShape.ts` → `matchSubShape.ts`)
   * そのままで、測定のための別の規約は作らない。
   *
   * 鍵が見つからない・指紋に合う面が無い・件数が合わないときは、**投げずに**
   * `{ kind: 'failed' }` を返す(アプリを落とさない。FR-504、NFR-RE-1)。
   */
  measure(request: MeasureRequest): Promise<MeasureResult>;
  /**
   * 覚えてある形をファイルの中身へ書き出す(FR-803、P6 §2.3〜§2.6、タスク10・16)。
   *
   * **形式ごとに口を増やさない**(§0.a-0.2)。STEP / STL / OBJ / glTF / 3MF 用の三角形 /
   * B-rep の切り替えは依頼の `format` で判別し、実装は網羅 `switch` で受ける
   * (`ShapeExportRequest` の表)。対象は投影・測定と同じく**段のキャッシュの鍵**で指す。
   *
   * **要件 FR-803 の 5 形式はすべてこの 1 本から出る。** STEP は `'step'`、STL は `'stl'`
   * (バイナリ / ASCII は `ascii` で切り替え)、OBJ は `'obj'`(`.obj` と `.mtl` の 2 ファイル)、
   * glTF は `'gltf'`(`.glb`)、3MF は `'mesh'` で三角形だけを受け取って `packages/io` が
   * ZIP と XML を組む(§0.a-0.19。io は OCCT を呼べない)。
   *
   * **測定と同じく、これは読み取りだけ**で再計算も鍵の作り直しも起こさない。三角形は
   * 形の複製に掛けるので、画面用のキャッシュは 1 枚も汚れない(`occt/exportMesh.ts`)。
   *
   * 鍵が見つからないとき・OCCT が書けなかったときは**日本語の理由で投げる**
   * (測定と違って結果に「失敗」の枝を作らないのは、書き出しが 1 回 1 ファイルの操作で、
   * 一部だけ書けても利用者には渡せないためである。断りは画面がそのまま見せられる)。
   */
  exportShapes(request: ShapeExportRequest): Promise<ShapeExportResult>;
  /**
   * ファイルの中身から形を読み込む(FR-802、FR-811、P6 §2.3・§2.8、タスク10・16)。
   *
   * 書き出しと同じく**口は 1 本**で、依頼の `format`(STEP / STL / OBJ / glTF / B-rep)で
   * 判別する。返すのは**`.pcad` へ抱き込むバイト列と画面用の三角形**で、形そのものは
   * Worker の中に残さない(`ShapeImportBody` の注釈)。**三角形しか持たない形式
   * (STL / OBJ / glTF)は `bodyKind: 'mesh'` で返り、B-rep のバイト列を持たない**
   * (§0.a-0.23。メッシュ → B-rep の変換はしない)。
   * 読み込んだ形の単位は mm へ換算済み(NFR-RE-3。`ShapeImportResult.unit` の表)。
   *
   * 読めなかったとき・立体が入っていなかったときは**日本語の理由で投げる**
   * (§2.8 の断りの表。画面はその文言をそのまま見せる)。
   */
  importShape(request: ShapeImportRequest): Promise<ShapeImportResult>;
  /**
   * 3D プリント向けの点検(FR-815、NFR-PF-4、P6 §0.51・§2.16、タスク42)。
   *
   * **最小肉厚・オーバーハングの角度・水密性の 3 つを 1 回の呼び出しでまとめて返す**
   * (§0.a-0.30「カーネルを呼ぶ回数を最小にする」)。対象は書き出し・投影と同じく
   * **段のキャッシュの鍵**(`ShapeInspectRequest.bodies` の `bodyKey`)で指し、直近の再計算で
   * 画面へ返した表示メッシュをそのまま使う。別品質で作り直さないので、結果の三角形番号は
   * 画面の同じ番号を指す。複数ボディでは表示メッシュを依頼順に連ねて点検する。
   *
   * onProgress と shouldCancel は Comlink.proxy で包んだ関数を渡す
   * (`recomputeSolids` と同じ形)。中止が効くのは肉厚の段だけ
   * (`inspectPrintability` 本体の注釈。水密性とオーバーハングは 5 万三角形でも
   * 実測 10ms 台で終わるため)。
   *
   * 鍵が形状キャッシュに見つからないときは、書き出し・投影と同じ `MISSING_BODY_MESSAGE`
   * で断る(投げる。書き出しと同じく「一部だけ点検できた」を返さない)。
   *
   * **タスク42 では任意(`?`)にしてあったが、タスク46(43a)で必須へ引き上げた。**
   * 任意のままだと、この口を呼ぶ `KernelBridge.inspectPrintability`(model)が毎回
   * 「実装されているか」を実行時に確かめる分岐を持つことになり、偽の `KernelApi` が
   * 実装を忘れても型検査が黙って通ってしまう(呼び出し側が組み終わるまでの経過措置
   * だった、P5 タスク42a の `HoleStepSpec.entry` と同じ扱い)。**呼び出し側が
   * 組み終わったので、実装漏れを型検査で捕まえる側へ戻す。**
   */
  inspectPrintability(
    request: ShapeInspectRequest,
    onProgress?: PrintabilityProgressCallback,
    shouldCancel?: PrintabilityCancelToken,
  ): Promise<ShapeInspectResult>;
}

/** 寿命を管理する実装の口。既存の計算だけを包む KernelApi の利用者とも互換にする。 */
export interface InterferenceKernelApi extends KernelApi {
  checkInterference(request: InterferenceRequest, onProgress?: InterferenceProgressCallback,
    shouldCancel?: SolidCancelToken, callbackDelivery?: 'message'): Promise<InterferenceResult>;
}

export interface ManagedKernelApi extends InterferenceKernelApi {
  releasePart(partId: string): Promise<void>;
  getShapeCacheStats(): Promise<ShapeCacheStats>;
  /** 欠落時の再計算は model(11a)が行う。例外の独自欄に依存せず Worker 越しに読める。 */
  checkShapeAvailability(partId: string, bodyKeys: readonly string[]): Promise<ShapeAvailability>;
}

interface PartShapes {
  token: AcquireToken | undefined;
  meshes: ReadonlyMap<string, DisplayMeshEntry>;
  revision: number;
  job: symbol;
}

/** 未作成の段も先に確保し、長い履歴の途中でも入力や最終形を追い出さない。 */
function recomputeKeys(request: SolidRecomputeRequest): Set<string> {
  const keys = new Set(request.steps.map((step) => step.key));
  for (const { step } of request.steps) {
    if ('targetKey' in step && typeof step.targetKey === 'string') {
      keys.add(step.targetKey);
    }
    if (step.kind === 'boolean') {
      keys.add(step.toolKey);
    }
    if (step.kind === 'thruSections') {
      for (const section of step.sections) {
        if (section.kind === 'faceQuery') {
          keys.add(section.targetKey);
        }
      }
    }
  }
  for (const query of request.appearanceQueries ?? []) {
    keys.add(query.bodyKey);
  }
  return keys;
}

/**
 * OCCT の読み込み手続きを受け取って、寿命管理を含む KernelApi を組み立てる。
 * ブラウザでは loadOcctForBrowser、Node のテストでは loadOcctForNode を渡す。
 */
export function createKernelApi(loadOcct: () => Promise<OpenCascadeInstance>, shapeCache?: AcquiringShapeCache<CachedSolid>): ManagedKernelApi {
  // 形状キャッシュは窓口 1 つにつき 1 つ。再計算をまたいで残すことで、
  // 変えていないフィーチャーを作り直さずに済ませる(NFR-PF-3)。
  // 掃除は容量 SHAPE_CACHE_CAPACITY の LRU に任せ、retain は呼ばない(2026-09-03 統括判断)。
  const cache = shapeCache ?? createShapeCache<CachedSolid>(
    undefined,
    ({ mesh }) =>
      mesh.positions.byteLength +
      mesh.normals.byteLength +
      mesh.indices.byteLength +
      mesh.edgePositions.byteLength,
  );
  // 形と表示メッシュは同じ部品の次の完了結果まで保持する。配列は複製しない。
  const parts = new Map<string, PartShapes>();

  async function withAcquiredKeys<T>(keys: Iterable<string>, run: () => Promise<T>): Promise<T> {
    const token = cache.acquire(keys);
    try {
      return await run();
    } finally {
      cache.release(token);
    }
  }

  return {
    async checkInterference(request, onProgress, shouldCancel, callbackDelivery): Promise<InterferenceResult> {
      const snapshot = snapshotInterferenceRequest(request);
      const preparation = prepareInterference(snapshot);
      let result = initialInterferenceResult(snapshot, preparation);
      if (result.kind === 'failed' || preparation.jobs.length === 0) return result;
      const needed = new Set(preparation.jobs.flatMap((job) => job.pair));
      const keys = snapshot.components.flatMap((component) =>
        component.kind === 'ready' && needed.has(component.componentId) ? component.bodyKeys : []);
      let phase: 'load' | 'run' = 'load';
      let token: AcquireToken | undefined;
      try {
        token = cache.acquire(keys);
        // acquire直後・最初のawaitより前に旧entryを確定。同key上書きはlease終了までretired。
        const bodies = new Map([...new Set(keys)].map((key) => [key, cache.get(key)]));
        const oc = await loadOcct();
        phase = 'run';
        result = await runCheckInterference(snapshot, oc, bodies, onProgress, shouldCancel, callbackDelivery);
      } catch (error) {
        result = interferenceRootFailure(result, { code: phase === 'load' ? 'kernelUnavailable' : 'unexpectedFailure',
        message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (token !== undefined) try { cache.release(token); } catch (error) {
          const cleanup = error instanceof Error ? error.message : String(error);
          result = interferenceRootFailure(result, result.kind === 'failed'
            ? { ...result.failure, cleanupMessages: [...(result.failure.cleanupMessages ?? []), cleanup] }
            : { code: 'cleanupFailed', message: '使用中の立体を返せませんでした。', cleanupMessages: [cleanup] });
        }
      }
      return result;
    },
    releasePart(partId): Promise<void> {
      const part = parts.get(partId);
      parts.delete(partId);
      if (part?.token !== undefined) {
        cache.release(part.token);
      }
      return Promise.resolve();
    },

    getShapeCacheStats(): Promise<ShapeCacheStats> {
      return Promise.resolve(cache.stats());
    },

    checkShapeAvailability(partId, bodyKeys): Promise<ShapeAvailability> {
      return Promise.resolve({
        partId,
        missingKeys: [...new Set(bodyKeys)].filter((key) => !cache.has(key)),
      });
    },
    async tessellateSketch(sketch, options = {}): Promise<SketchTessellation> {
      const oc = await loadOcct();
      const curvePolylines: Float32Array[] = [];
      const faces: FaceMeshData[] = [];
      const failures: SketchTessellationFailure[] = [];

      for (const curve of sketch.curves) {
        const handle = makeCurveEdge(oc, curve);
        try {
          curvePolylines.push(discretizeEdge(oc, handle.edge, options));
        } finally {
          handle.delete();
        }
      }

      // 面が 1 枚失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const faceRequest of sketch.faces) {
        try {
          const handle = makePlanarFace(oc, faceRequest.curves, options);
          try {
            const surface = tessellate(oc, handle.face, options);
            faces.push({
              id: faceRequest.id,
              positions: surface.positions,
              normals: surface.normals,
              indices: surface.indices,
              triangleCount: surface.triangleCount,
              boundaryPositions: handle.boundaryPositions,
              boundaryEdgeCount: handle.boundaryEdgeCount,
            });
          } finally {
            handle.delete();
          }
        } catch (error) {
          failures.push({
            id: faceRequest.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { curvePolylines, faces, failures };
    },

    async recomputeSolids(
      request,
      options = {},
      onProgress,
      cancelToken,
    ): Promise<SolidRecomputeResult> {
      const partId = request.partId ?? DEFAULT_PART_ID;
      const part: PartShapes = parts.get(partId) ?? {
        token: undefined,
        meshes: new Map<string, DisplayMeshEntry>(),
        revision: 0,
        job: Symbol(),
      };
      const job = Symbol();
      part.job = job;
      parts.set(partId, part);
      return withAcquiredKeys(recomputeKeys(request), async () => {
        const oc = await loadOcct();
        const result = await runSolidRecompute(
          { oc, cache }, request, options, onProgress, cancelToken,
        );
        // 取消・旧job・削除済み部品の結果で現行の最終形を置き換えない。
        if (!result.cancelled && parts.get(partId) === part && part.job === job) {
          const meshes = displayMeshesOf(request, result, part.revision + 1);
          const token = meshes.size === 0 ? undefined : cache.acquire(meshes.keys());
          const previous = part.token;
          part.token = token;
          part.meshes = meshes;
          part.revision += 1;
          if (previous !== undefined) {
            cache.release(previous);
          }
        }
        return result;
      });
    },

    async offsetSketchCurves(request): Promise<SketchOffsetOutcome> {
      const oc = await loadOcct();
      const results: SketchOffsetResult[] = [];
      const failures: SketchOffsetFailure[] = [];

      // 1 件失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
      for (const item of request.items) {
        try {
          const contours = makeOffsetWire(oc, {
            curves: item.curves,
            distance: item.distance,
            joinType: item.joinType,
          });
          results.push({ id: item.id, contours });
        } catch (error) {
          failures.push({
            id: item.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { results, failures };
    },

    async projectSketchCurves(request): Promise<SketchProjectionOutcome> {
      return withAcquiredKeys(request.items.map((item) => item.shapeKey), async () => {
        const oc = await loadOcct();
        const results: SketchProjectionResult[] = [];
        const failures: SketchProjectionFailure[] = [];

        // 1 件失敗しても残りは作る。失敗は理由つきで返す(FR-504、NFR-RE-1)。
        for (const item of request.items) {
          const cached = cache.get(item.shapeKey);
          if (cached === undefined) {
            failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
            continue;
          }
          // 指紋で選び直した面・辺は「新しく作られた形」なので、使い終えたら手放す。
          // 立体そのもの(subShape が null)はキャッシュの持ち物なので手放さない。
          const picked =
            item.subShape === null
              ? null
              : pickSubShape(oc, cached.shape, cached.mesh, item.subShape);
          if (item.subShape !== null && picked === null) {
            failures.push({ id: item.id, message: MISSING_SUB_SHAPE_MESSAGE });
            continue;
          }
          try {
            const curves = makeProjection(oc, {
              source: picked ?? cached.shape,
              plane: item.plane,
            });
            results.push({ id: item.id, curves: curves.curves });
          } catch (error) {
            failures.push({
              id: item.id,
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            picked?.delete();
          }
        }

        return { results, failures };
      });
    },

    async sectionSketchCurves(request): Promise<SketchProjectionOutcome> {
      return withAcquiredKeys(request.items.map((item) => item.shapeKey), async () => {
        const oc = await loadOcct();
        const results: SketchProjectionResult[] = [];
        const failures: SketchProjectionFailure[] = [];

        for (const item of request.items) {
          const cached = cache.get(item.shapeKey);
          if (cached === undefined) {
            failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
            continue;
          }
          try {
            const curves = makeSection(oc, { target: cached.shape, plane: item.plane });
            results.push({ id: item.id, curves: curves.curves });
          } catch (error) {
            failures.push({
              id: item.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return { results, failures };
      });
    },

    async hiddenLineViews(request, onProgress, cancelToken): Promise<HiddenLineResult> {
      return withAcquiredKeys(request.bodyIds, async () => {
        const allocations = createAllocations();
        try {
        const oc = await loadOcct();
        const failures: HiddenLineResult['failures'][number][] = [];
        const inputs: readonly (Pick<DrawingBodyInstance, 'bodyId'> & Partial<DrawingBodyInstance>)[] = request.instances ?? request.bodyIds.map((bodyId) => ({ bodyId }));
        const sources = inputs.flatMap((input): HiddenLineSource[] => {
          const { bodyId } = input;
          const cached = cache.get(bodyId);
          if (cached === undefined || !request.bodyIds.includes(bodyId)) {
            failures.push({ viewId: null, bodyId, message: MISSING_BODY_MESSAGE });
            return [];
          }
          if (input.placement !== undefined) {
            const placed = allocations.keep(placeShape(oc, cached.shape, input.placement));
            return [{ bodyId, occurrenceId: input.occurrenceId, shape: placed.shape }];
          }
          return [{ bodyId, shape: cached.shape }];
        });
        const views: HiddenLineResult['views'][number][] = [];
        for (let index = 0; index < request.views.length; index += 1) {
          const view = request.views[index];
          if (view === undefined) continue;
          if (await cancelToken?.() === true) return { views, failures, cancelled: true };
          const outcome = hiddenLineViewForBodies(oc, {
            viewId: view.id,
            sources,
            origin: view.origin,
            normal: view.normal,
            xDir: view.xDir,
            mode: view.mode,
            includeHidden: view.includeHidden,
          });
          if (outcome.ok) views.push(outcome.result);
          else failures.push({ viewId: view.id, bodyId: null, message: outcome.message });
          await Promise.resolve(onProgress?.({ completed: index + 1, total: request.views.length, viewId: view.id }));
        }
        return { views, failures, cancelled: false };
        } finally { allocations.release(); }
      });
    },

    async sectionViews(request, onProgress, cancelToken): Promise<SectionResult> {
      return withAcquiredKeys(request.bodyIds, async () => {
        const failures: SectionResult['failures'][number][] = [];
        if (await cancelToken?.() === true) {
          return { viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], failures, cancelled: true };
        }
        const oc = await loadOcct();
        const sections: Array<{
          readonly bodyId: string;
          readonly occurrenceId?: string;
          readonly referenceShape: TopoDS_Shape;
          readonly result: Extract<ReturnType<typeof makeSectionShape>, { readonly ok: true }>;
        }> = [];
        const placements = createAllocations();
        try {
          const inputs: readonly (Pick<DrawingBodyInstance, 'bodyId'> & Partial<DrawingBodyInstance>)[] = request.instances ?? request.bodyIds.map((bodyId) => ({ bodyId }));
          for (const input of inputs) {
            const { bodyId } = input;
            const cached = cache.get(bodyId);
            if (cached === undefined || !request.bodyIds.includes(bodyId)) {
              failures.push({ viewId: request.view.id, bodyId, message: MISSING_BODY_MESSAGE });
              continue;
            }
            const placed = input.placement === undefined ? cached.shape : placements.keep(placeShape(oc, cached.shape, input.placement)).shape;
            const outcome = makeSectionShape(oc, {
              target: placed,
              plane: request.plane,
              projectionPlane: {
                origin: request.view.origin, normal: request.view.normal, axisU: request.view.xDir,
              },
              keepSide: request.keepSide,
              kind: request.kind,
              boundary: request.boundary,
            });
            if (outcome.ok) sections.push({ bodyId, occurrenceId: input.occurrenceId, referenceShape: placed, result: outcome });
            else failures.push({ viewId: request.view.id, bodyId, message: outcome.message });
          }
          if (await cancelToken?.() === true) {
            return { viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], failures, cancelled: true };
          }
          const cuttingAreas = sections.flatMap((section) => section.result.cutFaces
            .filter((face) => request.kind === 'revolved' || face.normal.reduce((sum, value, axis) => sum + value * request.view.normal[axis], 0) > 1e-9)
            .map((face) => ({ bodyId: section.bodyId, occurrenceId: section.occurrenceId ?? null,
              point: face.point, normal: face.normal, curves: face.curves })));
          if (request.kind === 'revolved') {
            const visible = sections.flatMap((section) => section.result.cutFaces.flatMap((face) => face.curves.map((curve) => ({
              curve,
              provenance: { kind: 'silhouette' as const, bodyId: section.bodyId, occurrenceId: section.occurrenceId ?? null,
                faceIndex: face.index, generated: 'outline' as const, dimensionTarget: false as const },
            }))));
            await Promise.resolve(onProgress?.({ completed: 1, total: 1, viewId: request.view.id }));
            return { viewId: request.view.id, visible, hidden: [], cuttingCurves: visible.map((item) => item.curve), cuttingAreas, failures, cancelled: false };
          }
          const hlr = hiddenLineViewForBodies(oc, {
            viewId: request.view.id,
            sources: sections.map((section) => ({
              bodyId: section.bodyId,
              occurrenceId: section.occurrenceId,
              shape: section.result.shape,
              referenceShape: section.referenceShape,
            })),
            origin: request.view.origin,
            normal: request.view.normal,
            xDir: request.view.xDir,
            mode: request.view.mode,
            includeHidden: request.view.includeHidden,
          });
          await Promise.resolve(onProgress?.({ completed: 1, total: 1, viewId: request.view.id }));
          return hlr.ok
            ? {
                viewId: request.view.id,
                visible: hlr.result.visible,
                hidden: hlr.result.hidden,
                cuttingCurves: cuttingAreas.flatMap((area) => area.curves),
                cuttingAreas,
                failures,
                cancelled: false,
              }
            : {
                viewId: request.view.id,
                visible: [], hidden: [],
                cuttingCurves: cuttingAreas.flatMap((area) => area.curves),
                cuttingAreas,
                failures: [...failures, { viewId: request.view.id, bodyId: null, message: hlr.message }],
                cancelled: false,
              };
        } finally {
          for (const section of sections) section.result.delete();
          placements.release();
        }
      });
    },

    async measure(request): Promise<MeasureResult> {
      return withAcquiredKeys(request.targets.map((target) => target.bodyKey), async () => {
        const oc = await loadOcct();
        // 選び直した面・辺・頂点は「新しく作られた形」なので、測り終えたら手放す。
        // ボディそのもの(subShape が null)はキャッシュの持ち物なので手放さない。
        const picked: TopoDS_Shape[] = [];
        const placed: ReturnType<typeof placeShape>[] = [];
        const shapes: TopoDS_Shape[] = [];

        try {
          for (const target of request.targets) {
            const cached = cache.get(target.bodyKey);
            if (cached === undefined) {
              return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
            }
            let source = cached.shape;
            if (target.subShape !== null) {
              const subShape = pickSubShape(oc, cached.shape, cached.mesh, target.subShape);
              if (subShape === null) {
                return { kind: 'failed', message: MISSING_SUB_SHAPE_MESSAGE };
              }
              picked.push(subShape);
              source = subShape;
            }
            if (target.placement === undefined) {
              shapes.push(source);
            } else {
              const moved = placeShape(oc, source, target.placement);
              placed.push(moved);
              shapes.push(moved.shape);
            }
          }

          try {
            if (request.kind === 'distance') {
              const [first, second] = shapes;
              if (shapes.length !== 2 || first === undefined || second === undefined) {
                return { kind: 'failed', message: MEASURE_NEEDS_TWO_MESSAGE };
              }
              const found = distanceBetween(oc, first, second);
              return {
                kind: 'distance',
                distance: found.distance,
                pointA: found.pointA,
                pointB: found.pointB,
                inner: found.inner,
              };
            }
            const [only] = shapes;
            if (shapes.length !== 1 || only === undefined) {
              return { kind: 'failed', message: MEASURE_NEEDS_ONE_MESSAGE };
            }
            const properties = measureMassProperties(oc, only);
            return {
              kind: 'massProperties',
              volume: properties.volume,
              area: properties.area,
              centreOfMass: properties.centreOfMass,
              principalMoments: properties.principalMoments,
              principalAxes: properties.principalAxes,
            };
          } catch (error) {
            // OCCT が測れなかった理由はそのまま画面に出せる日本語にしてある(FR-504)。
            return {
              kind: 'failed',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        } finally {
          for (let index = placed.length - 1; index >= 0; index -= 1) placed[index]?.delete();
          for (let index = picked.length - 1; index >= 0; index -= 1) picked[index]?.delete();
        }
      });
    },

    async exportShapes(request): Promise<ShapeExportResult> {
      const exportItems = exportItemsOf(request);
      return withAcquiredKeys(exportItems.map((body) => body.bodyKey), async () => {
        const oc = await loadOcct();
        const shapes = resolveExportShapes(cache, exportItems, request.partId ?? DEFAULT_PART_ID);

        // 網羅 `switch`(`default` を作らない)。形式が増えたら、ここが型検査で落ちる
        // ことで配線し忘れが分かる(`ShapeExportRequest` の注釈)。
        switch (request.format) {
          case 'step': {
            // 立体が 1 つも無いときの断り(「書き出せる立体がありません。」)は
            // `buildXcafDocument` が持っている。ここで先回りして数えないのは、
            // 同じ文言を 2 か所に置かないため(model の `selectExportBodies` も
            // `nothingToExport` で先に断る)。
            const written = request.assembly === undefined
              ? writeStep(
                  oc,
                  request.bodies.map((item, index) => ({
                    shape: shapes[index],
                    name: item.name,
                    color: item.color,
                    // 面ごとの色(P6 タスク7b+13b)。`StepWriteEntry`(= `XcafShapeEntry`)が
                    // 元から持つ欄なので、依頼の欄をそのまま渡すだけでよい。
                    faceColors: item.faceColors,
                  })),
                  { withColors: request.withColors ?? true },
                )
              : writeStepAssembly(oc, assemblyWithShapes(request.assembly, shapes), {
                  withColors: request.withColors ?? true,
                });
            return { format: 'step', bytes: written.bytes, colorWritten: written.colorWritten };
          }
          case 'stl': {
            // STL は三角形の網を 1 つしか持てないので、立体をそのまま順につなぐ(§2.4)。
            // 色は書かない(§0.a-0.15。仕様に無い)ので、依頼の名前と色は使わない。
            const written = writeStl(buildExportMeshes(oc, shapes, request), {
              ascii: request.ascii ?? false,
            });
            return {
              format: 'stl',
              files: [
                { fileName: `${normalizeBaseName(request.baseName)}.stl`, bytes: written.bytes },
              ],
              triangleCount: written.triangleCount,
              droppedTriangleCount: written.droppedTriangleCount,
            };
          }
          // OBJ と glTF は書き手が同じ(`writeCafMesh`)で、違うのは組み立てるファイルだけ。
          // 依頼の `format` がそのまま書き手の `CafMeshFormat` になるので、2 つを 1 つの枝で受ける。
          case 'obj':
          case 'gltf': {
            const meshes = buildExportMeshes(oc, shapes, request);
            const written = writeCafMesh(
              request.bodies.map((item, index) => ({
                mesh: meshes[index],
                name: item.name,
                color: item.color,
                // 面ごとの色(P6 タスク7b+13b)。`meshes[index]` は `buildExportMesh` の
                // 戻りなので `faceRanges` を必ず持ち、`CafMeshBody.faceColors` へそのまま渡せる。
                faceColors: item.faceColors,
              })),
              { format: request.format, baseName: request.baseName },
            );
            return {
              format: request.format,
              files: written.files,
              triangleCount: written.triangleCount,
              droppedTriangleCount: written.droppedTriangleCount,
            };
          }
          case 'mesh': {
            const meshes = buildExportMeshes(oc, shapes, request);
            const bodies: ShapeExportMeshBody[] = request.bodies.map((item, index) => ({
              bodyKey: item.bodyKey,
              // 形の複製に掛けるので、画面用キャッシュの三角形は 1 枚も変わらない(§0.a-0.13)。
              triangles: meshes[index],
            }));
            return { format: 'mesh', bodies };
          }
          case 'brep': {
            const bodies: ShapeExportBrepBody[] = request.bodies.map((item, index) => ({
              bodyKey: item.bodyKey,
              bytes: writeBrepBytes(oc, shapes[index]),
            }));
            return { format: 'brep', bodies };
          }
        }
      });
    },

    async importShape(request): Promise<ShapeImportResult> {
      const oc = await loadOcct();

      // 網羅 `switch`。STL / OBJ の読み込み(タスク16・18)は依頼の union へ 1 つ足すと、
      // ここが型検査で落ちて配線を促す(`ShapeImportRequest` の注釈)。
      switch (request.format) {
        case 'step': {
          // `readStep` が返した形は読み手の持ち物。**必ず `delete()` する**
          // (`rules/06` 10.13 の解放の見分け。忘れると次の読み込みが数倍遅くなる)。
          const read = readStepAssembly(oc, request.bytes, {
            fileName: request.fileName,
            withColors: request.withColors,
          });
          try {
            const assembly: ShapeImportAssembly = {
              name: read.name,
              definitions: read.definitions.map((definition, bodyIndex) => ({
                id: definition.id,
                name: definition.name,
                bodyIndex,
              })),
              children: read.children,
            };
            return {
              bodies: read.definitions.map((body) =>
                // `StepAssemblyDefinition.kind` の型は `SolidBodyKind`(3 種)だが、読み手は
                // **閉じた立体かどうかだけ**で `'solid' | 'shell'` を決めている
                // (`kind: solid ? 'solid' : 'shell'`)ので `'mesh'` にはならない。
                // B-rep を持つ 2 種へここで絞るのは、読み込んだ三角形の形
                // (`bodyKind: 'mesh'`)が B-rep のバイト列を持たない別の枝だから。
                toImportBody(
                  oc,
                  body.shape,
                  body.name,
                  body.color,
                  body.kind === 'solid' ? 'solid' : 'shell',
                ),
              ),
              unit: read.unit,
              unitNames: read.unitNames,
              assembly,
            };
          } finally {
            read.delete();
          }
        }
        case 'brep': {
          // `.pcad` へ抱き込んだバイト列(§0.a-0.9)。名前も色も文書の側が持っているので、
          // ここでは形だけを戻す。単位は内部単位そのもの(mm)で、ファイルの単位は無い。
          const shape = readBrepBytes(oc, request.bytes);
          try {
            return {
              bodies: [
                toImportBody(oc, shape, null, null, hasSolid(oc, shape) ? 'solid' : 'shell'),
              ],
              unit: 'mm',
              unitNames: [],
            };
          } finally {
            shape.delete();
          }
        }
        case 'stl': {
          // **STL に単位は無い**(§0.a-0.6)。数をそのまま mm として取り込み、違ったら
          // 利用者に訊く——訊くのは ui(タスク32)なので、ここは `'other'` と記録するだけ。
          const mesh = readStl(oc, request.bytes, { fileName: request.fileName });
          return { bodies: [toImportMeshBody(mesh)], unit: 'other', unitNames: [] };
        }
        case 'obj': {
          // OBJ も単位を持たない(`FileLengthUnit()` が `-1`。`readCafMesh.ts` の実測)。
          const mesh = readCafMesh(oc, request.bytes, {
            format: 'obj',
            fileName: request.fileName,
          });
          return { bodies: [toImportMeshBody(mesh)], unit: 'other', unitNames: [] };
        }
        case 'gltf': {
          // **glTF は仕様が m と定めている**ので、`readCafMesh` が OCCT に 1000 倍させて
          // mm で受け取っている(`SetSystemLengthUnit(0.001)`。§0.a-0.6)。取り違えようが
          // ないので、利用者に単位を訊く必要が無い(`'mm'` を返す)。
          const mesh = readCafMesh(oc, request.bytes, {
            format: 'gltf',
            fileName: request.fileName,
          });
          return { bodies: [toImportMeshBody(mesh)], unit: 'mm', unitNames: [] };
        }
      }
    },

    async inspectPrintability(request, onProgress, shouldCancel): Promise<ShapeInspectResult> {
      return withAcquiredKeys(request.bodies.map((body) => body.bodyKey), async () => {
        // 別品質で作り直さず、直近に画面へ返した typed array そのものを点検する。
        const partId = request.partId ?? DEFAULT_PART_ID;
        const displayed = resolveDisplayMeshes(
          parts.get(partId)?.meshes ?? new Map<string, DisplayMeshEntry>(),
          request.bodies,
          partId,
        );
        const mesh = mergeExportMeshes(displayed.map((entry) => entry.mesh));
        const result = await runInspectPrintability(
          mesh,
          { minThicknessMm: request.minThicknessMm, overhangAngleDeg: request.overhangAngleDeg },
          { onProgress, shouldCancel },
        );
        return {
          ...result,
          meshes: displayed.map(({ bodyKey, meshRevision: revision, triangleCount }) => ({
            bodyKey,
            meshRevision: revision,
            triangleCount,
          })),
        };
      });
    },
  };
}
