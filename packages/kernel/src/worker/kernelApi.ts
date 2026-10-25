import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createRuntimePhaseJournal, type RuntimePhaseJournalSnapshot } from './runtimePhaseJournal.js';

import { readBrepBytes, writeBrepBytes } from '../occt/brepBytes.js';
import type { ImportedMeshData } from '../occt/exchangeShared.js';
import type { ExportMesh } from '../occt/exportMesh.js';
import { buildExportMesh } from '../occt/exportMesh.js';
import { buildRequestExportMeshes } from './exportMeshReuse.js';
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
import { functionCurvePolylines, type FunctionCurveSketchResult } from '../occt/functionCurvePolylines.js';
import type { FunctionCurveGeometrySpec } from '../occt/makeFunctionCurve.js';
import { makeSectionShape } from '../occt/makeSectionShape.js';
import { discretizeEdge, makeCurveEdge } from '../occt/makeSketchEdges.js';
import { placeShape } from '../occt/placeBodies.js';
import { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from '../occt/pickSubShape.js';
import { readCafMesh } from '../occt/readCafMesh.js';
import { readStepAssembly } from '../occt/readStepAssembly.js';
import { readStl } from '../occt/readStl.js';
import { measureVolume } from '../occt/solidMesh.js';
import { measureClosedBodyVolume, shapeBodyKind, type CadBodyKind } from '../occt/shapeBodyKind.js';
import { tessellate } from '../occt/tessellate.js';
import * as Comlink from 'comlink';
import { AnalysisBoundaryError, analysisMeshBuffers, buildAnalysisSurfaceMesh,
  type AnalysisSurfaceMeshRequest, type AnalysisSurfaceMeshResult } from '../occt/analysisSurfaceMesh.js';
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
  SolidBodyMesh,
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
  MeshJsFinalAccounting,
  TessellationOptions,
} from '../types.js';
// 窓口の名前と実体の名前が同じだと読み分けにくいので、実体は別名で取り込む。
import {
  recomputeSolids as runSolidRecompute,
  recomputeEmptySolids,
  solidMeshBuffers,
  localCachedReferenceMesh,
  type CachedSolid,
  type SolidCancelToken,
  type SolidProgressCallback,
} from './recomputeSolids.js';
import { createShapeCache, finalMeshJsAccounting, meshBackingBytes, type AcquireToken, type AcquiringShapeCache,
  type ShapeCache, type ShapeCacheStats } from './shapeCache.js';
import { withinReplyOriginBudget } from './originBudget.js';
import { ExportWorkBudget, checkedExportAdd, checkedExportMultiply,
  exportSerializationReserve, EXPORT_TRIANGLE_LIMIT } from './exportWorkLimits.js';
import {
  checkInterference as runCheckInterference, snapshotInterferenceRequest, prepareInterference,
  initialInterferenceResult, interferenceRootFailure, type InterferenceProgressCallback,
} from './checkInterference.js';

import { compareCachedMaterials, type MaterialComparisonRequest } from './compareCachedMaterials.js';
import type { MaterialComparisonOutcome } from './compareMaterialBodies.js';
import { withKernelMemory } from './kernelMemory.js';

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
  bodyKind: CadBodyKind,
): ShapeImportBody {
  const brepBytes = writeBrepBytes(oc, shape);
  const volume = bodyKind === 'mixed' ? measureClosedBodyVolume(oc, shape, solid => measureVolume(oc, solid))
    : bodyKind === 'shell' ? 0 : measureVolume(oc, shape);
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
  work: ExportWorkBudget,
): ExportMesh[] {
  return buildRequestExportMeshes(shapes, work, (shape) =>
    buildExportMesh(oc, shape, quality.deviationMm, {
      angularDeflectionRad: quality.angularDeflectionRad,
      admission: {
        remainingTriangles: work.remainingTriangles,
        remainingJsBytes: work.remainingJsBytes,
        checkDeadline: () => work.checkDeadline(),
      },
    }));
}

function exportMetadataCodeUnits(request: ShapeExportRequest): number {
  let total = 'baseName' in request ? request.baseName?.length ?? 0 : 0;
  for (const body of request.bodies) {
    total = checkedExportAdd(total, body.name?.length ?? 0);
    total = checkedExportAdd(total, checkedExportMultiply(body.faceColors?.size ?? 0, 16));
  }
  return total;
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

/**
 * Worker に残す、直近の再計算で画面へ返した typed array とその世代。
 * 稜線の配列も同じ body が持ち続けるので、保持量の会計では 4 つの配列を数える。
 */
interface DisplayMeshEntry extends ShapeInspectMeshIdentity {
  readonly mesh: SolidBodyMesh;
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


/** Dispatch ownership has no native objects, mesh arrays or document pointers. */
export interface CurrentMeshOwner {
  readonly dispatchId: string;
  readonly partId: string;
  readonly generation: number;
  readonly kind: 'display' | 'hidden';
  readonly steps: readonly { readonly id: string; readonly key: string }[];
}
export interface CurrentMeshQuery {
  readonly observationId: string;
  readonly limitBytes: number;
  readonly expectedOwners: readonly CurrentMeshOwner[];
  readonly expectedEpoch?: { readonly cache: number; readonly owners: number };
}
export type CurrentMeshObservation =
  | { readonly status: 'unknown'; readonly observationId: string; readonly reason: string }
  | { readonly status: 'known'; readonly observationId: string;
      readonly epoch: { readonly cache: number; readonly owners: number };
      readonly owners: readonly CurrentMeshOwner[];
      readonly reading: Extract<MeshJsFinalAccounting, { readonly status: 'known' }>;
      readonly hiddenBackingBytes: number;
      readonly coverage: 'current-solid-worker-backings'; };
export type PartOwnershipObservation =
  | { readonly status: 'current'; readonly owner: CurrentMeshOwner; readonly epoch: { readonly cache: number; readonly owners: number } }
  | { readonly status: 'absent' | 'stale-owner' }
  | { readonly status: 'unavailable'; readonly reason: string };
export type PartReleaseDisposition =
  | { readonly status: 'released' | 'absent' | 'stale-owner' }
  | { readonly status: 'cleanup-failed' | 'unavailable'; readonly reason: string };
export type MeshReplyAdmission = (metadata: {
  readonly owner: CurrentMeshOwner;
  readonly replyBackingBytes: number;
  readonly workerRetainedBackingBytes: number;
}) => boolean | Promise<boolean>;
export interface ReferenceMeshLeaseRequest {
  readonly owner: CurrentMeshOwner;
  readonly limitBytes: number;
  readonly localMesh?: SolidRecomputeRequest['localMesh'];
}
function sameCurrentMeshOwner(a: CurrentMeshOwner, b: CurrentMeshOwner): boolean {
  return a.dispatchId === b.dispatchId && a.partId === b.partId && a.generation === b.generation
    && a.kind === b.kind && a.steps.length === b.steps.length
    && a.steps.every((step, index) => step.id === b.steps[index]?.id && step.key === b.steps[index]?.key);
}
function capturedCurrentMeshOwner(owner: CurrentMeshOwner): CurrentMeshOwner {
  return { ...owner, steps: owner.steps.map(step => ({ ...step })) };
}

export type KernelRuntimePhase = 'native-build-start' | 'native-build-return' | 'native-build-throw'
  | 'native-build-cancelled' | 'geometry-cancel-check' | 'geometry-cancel-request'
  | 'geometry-cancel-check-throw' | 'reply-preclone' | 'reply-admission-rejected' | 'owner-rejected';
export interface KernelRuntimePhaseRecord {
  readonly seq: number;
  readonly phase: KernelRuntimePhase;
  readonly dispatchId: string | null;
  readonly partId: string | null;
  readonly generation: number | null;
  readonly kind: 'display' | 'hidden' | null;
  readonly epochMs: number | null;
  readonly monoMs: number | null;
}
export interface KernelRuntimePhaseSnapshot {
  readonly capacity: 256;
  readonly lastSeq: number;
  readonly dropped: number;
  readonly clockDiscontinuities: number;
  readonly missingOwners: number;
  readonly ownerConflicts: number;
  readonly records: readonly KernelRuntimePhaseRecord[];
  readonly coverage: 'runSolidRecompute-call-plus-admission-preclone';
  readonly unobserved: readonly ['internal-native-subcalls', 'exact-serialization', 'driver-upload', 'physical-resident'];
}
/** runSolidRecompute call envelope + admission preclone, not internal Wasm/C++ API timestamps.
 * Bounded primitive metadata only: no mesh/native/proxy/body/document lifetime ownership. */
export function createKernelPhaseObserver(clock: () => { epochMs: number; monoMs: number } =
  () => ({ epochMs: Date.now(), monoMs: performance.now() })) {
  const records: KernelRuntimePhaseRecord[] = [];
  const journal = createRuntimePhaseJournal<KernelRuntimePhaseRecord>();
  let lastSeq = 0, dropped = 0, clockDiscontinuities = 0, missingOwners = 0, ownerConflicts = 0;
  let previous: { epochMs: number; monoMs: number } | null = null;
  return {
    beginCapture: (nonce: string): void => { journal.begin(nonce, lastSeq); },
    readCapture: (nonce: string, acknowledge: number | null) => journal.read(nonce, acknowledge),
    endCapture: (nonce: string): void => { journal.end(nonce); },
    record(phase: KernelRuntimePhase, owner: CurrentMeshOwner | undefined): void {
      const valid = owner !== undefined && typeof owner.dispatchId === 'string' && owner.dispatchId.length > 0
        && owner.dispatchId.length <= 512 && typeof owner.partId === 'string' && owner.partId.length > 0
        && owner.partId.length <= 512 && Number.isSafeInteger(owner.generation) && owner.generation >= 0
        && (owner.kind === 'display' || owner.kind === 'hidden');
      const dispatchId = valid ? owner.dispatchId : null;
      const partId = valid ? owner.partId : null;
      const generation = valid ? owner.generation : null;
      const kind = valid ? owner.kind : null;
      if (!valid) missingOwners += 1;
      if (dispatchId !== null && records.some(record => record.dispatchId === dispatchId
        && (record.partId !== partId || record.generation !== generation || record.kind !== kind))) ownerConflicts += 1;
      let time: { epochMs: number; monoMs: number } | null = null;
      try { time = clock(); } catch { /* Diagnostic clock failure cannot change geometry behavior. */ }
      const validClock = time !== null && Number.isFinite(time.epochMs) && Number.isFinite(time.monoMs)
        && time.epochMs >= 0 && time.monoMs >= 0;
      if (!validClock || (previous !== null && time !== null && (time.monoMs < previous.monoMs
        || Math.abs((time.epochMs - previous.epochMs) - (time.monoMs - previous.monoMs)) > 1000))) clockDiscontinuities += 1;
      if (validClock && time !== null) previous = { epochMs: time.epochMs, monoMs: time.monoMs };
      if (!Number.isSafeInteger(lastSeq + 1)) { dropped += 1; return; }
      records.push(Object.freeze({ seq: ++lastSeq, phase, dispatchId, partId, generation, kind,
        epochMs: validClock && time !== null ? time.epochMs : null,
        monoMs: validClock && time !== null ? time.monoMs : null }));
      const recorded = records.at(-1);
      if (recorded !== undefined) journal.record(recorded);
      if (records.length > 256) { records.shift(); dropped += 1; }
    },
    snapshot(): KernelRuntimePhaseSnapshot {
      return Object.freeze({ capacity: 256, lastSeq, dropped, clockDiscontinuities, missingOwners, ownerConflicts,
        records: Object.freeze([...records]), coverage: 'runSolidRecompute-call-plus-admission-preclone',
        unobserved: ['internal-native-subcalls', 'exact-serialization', 'driver-upload', 'physical-resident'] as const });
    },
  };
}

/** UI 側から Comlink 越しに呼べる幾何カーネルの窓口。 */
export interface KernelApi {
  /** Read-only snapshot (not a destructive drain); never awaited on the native recomputation critical path. */
  readRuntimePhases?(): Promise<KernelRuntimePhaseSnapshot>;
  beginRuntimePhaseCapture?(nonce: string): Promise<void>;
  readRuntimePhaseCapture?(nonce: string, acknowledge: number | null): Promise<RuntimePhaseJournalSnapshot<KernelRuntimePhaseRecord>>;
  endRuntimePhaseCapture?(nonce: string): Promise<void>;
  /** Read already computed topology without replacing a part's displayed meshes or rebuilding shapes. */
  readCachedBodies(items: readonly { readonly id: string; readonly key: string }[], lease?: ReferenceMeshLeaseRequest, admitReply?: MeshReplyAdmission): Promise<SolidRecomputeResult>;
  /** Optional on historical mocks; unsupported observations are unknown. */
  readCurrentMeshAccounting?(query: CurrentMeshQuery): Promise<CurrentMeshObservation>;
  readPartOwnership?(owner: CurrentMeshOwner): Promise<PartOwnershipObservation>;
  releaseOwnedPart?(owner: CurrentMeshOwner, expectedEpoch: { readonly cache: number; readonly owners: number }): Promise<PartReleaseDisposition>;
  releaseReferenceMeshLease?(owner: CurrentMeshOwner): Promise<{ readonly released: boolean; readonly absent?: boolean }>;
  acknowledgeMeshReply?(owner: CurrentMeshOwner): Promise<{ readonly acknowledged: boolean; readonly absent?: boolean }>;
  /** Build and clip certified chords, then return every surviving corner in double precision. */
  functionSketchCurves(request: FunctionCurveGeometrySpec): Promise<FunctionCurveSketchResult>;
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
   *
   * 返信には、計算を終えた時点の計算部のメモリの量(`memory`)を添える(NFR-PF-6)。
   * 取り消した計算でも添えるので、画面は上限に近いことを中止の後も知らせ続けられる。
   */
  recomputeSolids(
    request: SolidRecomputeRequest,
    options?: TessellationOptions,
    onProgress?: SolidProgressCallback,
    cancelToken?: SolidCancelToken,
    owner?: CurrentMeshOwner,
    admitReply?: MeshReplyAdmission,
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

export interface MaterialComparisonKernelApi extends ManagedKernelApi {
  compareMaterials(request: MaterialComparisonRequest, shouldCancel?: SolidCancelToken): Promise<MaterialComparisonOutcome>;
}

/**
 * Analysis boundary of one cached body (`occt/analysisSurfaceMesh.ts`): a topology-connected double-precision
 * triangulation with a face address per triangle. It meshes a copy of the cached shape, so cached display meshes and
 * their triangulation are never changed; refusals are returned as `kind: 'failed'` with a stable code.
 */
export interface AnalysisBoundaryKernelApi extends MaterialComparisonKernelApi {
  buildAnalysisSurfaceMesh(request: AnalysisSurfaceMeshRequest): Promise<AnalysisSurfaceMeshResult>;
}

interface PartShapes {
  token: AcquireToken | undefined;
  meshes: ReadonlyMap<string, DisplayMeshEntry>;
  revision: number;
  job: symbol;
  owner?: CurrentMeshOwner;
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
 * 現在のメッシュの会計 1 回が数える記録（表示の部品・隠れた貸出し・期待する持ち主）1 件あたりに充てる容量。
 * recomputeSolids.ts の返信 1 件の固定の管理情報と同じ 4,096 バイトで、会計の容量 limitBytes（上限 512MiB）から
 * 件数の上限を決める（512MiB なら 131,072 件）。上限は残す。以前の固定の 128 件は、異なる部品定義が 128 を
 * 超える組立（EX-12 の 1,000 定義）の公開を metadata-capacity で必ず断っていた。
 */
const MESH_ACCOUNTING_RECORD_BYTES = 4096;

/**
 * OCCT の読み込み手続きを受け取って、寿命管理を含む KernelApi を組み立てる。
 * ブラウザでは loadOcctForBrowser、Node のテストでは loadOcctForNode を渡す。
 */
export function createKernelApi(loadInstance: () => Promise<OpenCascadeInstance>,
  shapeCache?: AcquiringShapeCache<CachedSolid>,
  exportTriangleLimit = EXPORT_TRIANGLE_LIMIT): AnalysisBoundaryKernelApi {
  let loadedOcct: OpenCascadeInstance | undefined;
  const loadOcct = (): Promise<OpenCascadeInstance> => loadInstance().then(instance => {
    loadedOcct = instance;
    return instance;
  });
  // 形状キャッシュは窓口 1 つにつき 1 つ。再計算をまたいで残すことで、
  // 変えていないフィーチャーを作り直さずに済ませる(NFR-PF-3)。
  // 掃除は容量 SHAPE_CACHE_CAPACITY の LRU に任せ、retain は呼ばない(2026-09-03 統括判断)。
  // 数値の callback は従来の診断(meshBytes)のまま残し、保持量の会計は配列の実体
  // (ArrayBuffer)を明示して渡す。同じ実体を指す複数の view・複数の body は 1 回だけ数える。
  const cache = shapeCache ?? createShapeCache<CachedSolid>(
    undefined,
    ({ mesh }) =>
      mesh.positions.byteLength +
      mesh.normals.byteLength +
      mesh.indices.byteLength +
      mesh.edgePositions.byteLength,
    ({ mesh }) => solidMeshBuffers(mesh),
  );
  // 形と表示メッシュは同じ部品の次の完了結果まで保持する。配列は複製しない。
  const phases = createKernelPhaseObserver();
  const parts = new Map<string, PartShapes>();
  const hiddenLeases = new Map<string, { readonly owner: CurrentMeshOwner; readonly token: AcquireToken;
    bodies: readonly SolidBodyMesh[] }>();
  const pendingHiddenDispatches = new Set<string>();
  const pendingReplies = new Map<string, { readonly owner: CurrentMeshOwner; readonly bodies: readonly SolidBodyMesh[] }>();
  let ownerEpoch = 0, activeAccountingRequests = 0;
  const changedOwner = (): void => { ownerEpoch = Number.isSafeInteger(ownerEpoch + 1) ? ownerEpoch + 1 : Number.NaN; };
  function* hiddenMeshBuffers(): Generator<ArrayBufferLike> {
    for (const lease of hiddenLeases.values()) for (const body of lease.bodies) yield* solidMeshBuffers(body);
  }
  function* pendingReplyBuffers(): Generator<ArrayBufferLike> {
    for (const reply of pendingReplies.values()) for (const body of reply.bodies) yield* solidMeshBuffers(body);
  }
  function* retainedMeshBuffers(): Generator<ArrayBufferLike> { yield* displayMeshBuffers(); yield* hiddenMeshBuffers(); yield* pendingReplyBuffers(); }
  async function prepareManagedReply(owner: CurrentMeshOwner | undefined, result: SolidRecomputeResult,
    admitReply: MeshReplyAdmission | undefined): Promise<SolidRecomputeResult> {
    if (owner === undefined || admitReply === undefined) return result; // legacy path cannot certify host clone coverage
    if (pendingReplies.size >= 128 || pendingReplies.has(owner.dispatchId)) throw new RangeError('Pending reply metadata capacity');
    pendingReplies.set(owner.dispatchId, { owner: capturedCurrentMeshOwner(owner), bodies: result.bodies }); changedOwner();
    try {
      const reading = finalMeshJsAccounting(cache.meshBufferSnapshot?.() ?? { status: 'unknown', reason: 'callback-missing' },
        displayMeshBuffers(), result.bodies.flatMap(body => solidMeshBuffers(body)), 512 * 1024 * 1024,
        [...hiddenMeshBuffers(), ...pendingReplyBuffers()]);
      if (reading.status !== 'known' || !await admitReply({ owner: capturedCurrentMeshOwner(owner),
        replyBackingBytes: reading.replyBackingBytes, workerRetainedBackingBytes: reading.retainedBackingBytes }))
        { phases.record('reply-admission-rejected', owner); throw new RangeError('Global pre-clone mesh reply admission refused'); }
      phases.record('reply-preclone', owner);
      return result;
    } catch (error) {
      // The RPC has not returned mesh arrays, so no Comlink result clone has happened.
      pendingReplies.delete(owner.dispatchId); changedOwner(); throw error;
    }
  }
  function ownerMatchesRequest(owner: CurrentMeshOwner, request: SolidRecomputeRequest): boolean {
    return owner.kind === 'display' && owner.partId === (request.partId ?? DEFAULT_PART_ID)
      && owner.generation === (request.generation ?? 0) && owner.dispatchId.length > 0
      && owner.steps.length === request.steps.length
      && owner.steps.every((step, index) => step.id === request.steps[index]?.id && step.key === request.steps[index]?.key);
  }

  /** Every part's adopted display arrays, including a part whose newer job was cancelled. */
  function* displayMeshBuffers(): Generator<ArrayBufferLike> {
    for (const part of parts.values()) {
      for (const entry of part.meshes.values()) yield* solidMeshBuffers(entry.mesh);
    }
  }

  async function withAcquiredKeys<T>(keys: Iterable<string>, run: () => Promise<T>): Promise<T> {
    activeAccountingRequests += 1;
    let token: AcquireToken | undefined;
    try {
      token = cache.acquire(keys);
      return await run();
    } finally {
      try { if (token !== undefined) cache.release(token); } finally { activeAccountingRequests -= 1; }
    }
  }

  function cleanupFailures(): number | null {
    try {
      const value = cache.cleanupFailureCount?.();
      return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  }
  function partOwnership(owner: CurrentMeshOwner): PartOwnershipObservation {
    if (owner.kind !== 'display' || owner.dispatchId.length === 0) return { status: 'unavailable', reason: 'invalid-display-owner' };
    if (activeAccountingRequests !== 0) return { status: 'unavailable', reason: 'active-request' };
    const cacheEpoch = cache.meshOwnershipEpoch?.();
    if (cacheEpoch === undefined || cacheEpoch === null || !Number.isSafeInteger(ownerEpoch)) return { status: 'unavailable', reason: 'epoch-unavailable' };
    const part = parts.get(owner.partId);
    if (part === undefined) {
      const failures = cleanupFailures();
      if (failures === null) return { status: 'unavailable', reason: 'cleanup-metadata-unavailable' };
      return failures === 0 ? { status: 'absent' } : { status: 'unavailable', reason: 'native-cleanup-failed' };
    }
    if (part.owner === undefined || !sameCurrentMeshOwner(part.owner, owner)) return { status: 'stale-owner' };
    return { status: 'current', owner: capturedCurrentMeshOwner(part.owner), epoch: { cache: cacheEpoch, owners: ownerEpoch } };
  }
  function releaseActualPart(partId: string): void {
    const part = parts.get(partId);
    if (part === undefined) return;
    try { if (part.token !== undefined) cache.release(part.token); }
    catch (error) {
      const failed = part.token === undefined ? undefined : cache.failedReleaseBuffers?.(part.token);
      if (failed !== undefined) {
        const held = new Set(failed);
        part.meshes = new Map([...part.meshes].filter(([, entry]) => solidMeshBuffers(entry.mesh)
          .some(buffer => buffer instanceof ArrayBuffer && held.has(buffer))));
        changedOwner();
      }
      // An external pre-mutation throw keeps the complete owner; an internal opaque
      // partial failure keeps its failed token/backings. Neither repeats successful native frees.
      throw error;
    }
    parts.delete(partId); changedOwner();
  }
  return {
    readRuntimePhases: () => Promise.resolve(phases.snapshot()),
    beginRuntimePhaseCapture: nonce => { phases.beginCapture(nonce); return Promise.resolve(); },
    readRuntimePhaseCapture: (nonce, acknowledge) => Promise.resolve(phases.readCapture(nonce, acknowledge)),
    endRuntimePhaseCapture: nonce => { phases.endCapture(nonce); return Promise.resolve(); },
    readPartOwnership(owner) { return Promise.resolve(partOwnership(owner)); },
    releaseOwnedPart(owner, expectedEpoch) {
      const current = partOwnership(owner);
      if (current.status !== 'current') return Promise.resolve(current);
      if (current.epoch.cache !== expectedEpoch.cache || current.epoch.owners !== expectedEpoch.owners)
        return Promise.resolve({ status: 'unavailable', reason: 'epoch-changed' });
      // No asynchronous boundary between exact owner/epoch validation and the actual cache return.
      try { releaseActualPart(owner.partId); return Promise.resolve({ status: 'released' }); }
      catch { return Promise.resolve({ status: 'cleanup-failed', reason: 'actual-cache-release-failed' }); }
    },
    readCurrentMeshAccounting(query): Promise<CurrentMeshObservation> {
      const refuse = (reason: string): Promise<CurrentMeshObservation> => Promise.resolve({
        status: 'unknown', observationId: query.observationId, reason });
      const cacheEpoch = cache.meshOwnershipEpoch?.();
      if (query.observationId.length === 0 || !Number.isSafeInteger(query.limitBytes)
      || query.limitBytes <= 0 || query.limitBytes > 512 * 1024 * 1024) return refuse('invalid-query');
      if (activeAccountingRequests !== 0 || pendingHiddenDispatches.size !== 0) return refuse('active-request');
      const cleanupCount = cleanupFailures();
      if (cleanupCount === null) return refuse('cleanup-metadata-unavailable');
      if (cleanupCount > 0) return refuse('native-cleanup-failed');
      if (pendingReplies.size !== 0) return refuse('unacknowledged-reply');
      if (cacheEpoch === undefined || cacheEpoch === null || !Number.isSafeInteger(ownerEpoch)) return refuse('epoch-unavailable');
      if (query.expectedEpoch !== undefined && (query.expectedEpoch.cache !== cacheEpoch
        || query.expectedEpoch.owners !== ownerEpoch)) return refuse('epoch-changed');
      const recordLimit = Math.floor(query.limitBytes / MESH_ACCOUNTING_RECORD_BYTES);
      if (parts.size + hiddenLeases.size > recordLimit || query.expectedOwners.length > recordLimit) return refuse('metadata-capacity');
      const owners: CurrentMeshOwner[] = [];
      for (const part of parts.values()) {
        if (part.meshes.size > 0 && part.owner === undefined) return refuse('unbound-display-owner');
        if (part.owner !== undefined) owners.push(capturedCurrentMeshOwner(part.owner));
      }
      for (const lease of hiddenLeases.values()) owners.push(capturedCurrentMeshOwner(lease.owner));
      if (query.expectedOwners.some(expected => owners.filter(owner => sameCurrentMeshOwner(owner, expected)).length !== 1))
        return refuse('owner-mismatch');
      const reading = finalMeshJsAccounting(cache.meshBufferSnapshot?.() ?? { status: 'unknown', reason: 'callback-missing' },
        displayMeshBuffers(), [], query.limitBytes, hiddenMeshBuffers());
      if (reading.status !== 'known') return refuse(reading.reason);
      if (cache.meshOwnershipEpoch?.() !== cacheEpoch) return refuse('epoch-changed');
      return Promise.resolve({ status: 'known', observationId: query.observationId,
        epoch: { cache: cacheEpoch, owners: ownerEpoch }, owners, reading,
        hiddenBackingBytes: meshBackingBytes(hiddenMeshBuffers()), coverage: 'current-solid-worker-backings' });
    },
    acknowledgeMeshReply(owner) {
      const reply = pendingReplies.get(owner.dispatchId);
      if (reply === undefined) return Promise.resolve({ acknowledged: false, absent: true });
      if (!sameCurrentMeshOwner(reply.owner, owner)) return Promise.resolve({ acknowledged: false });
      pendingReplies.delete(owner.dispatchId); changedOwner();
      return Promise.resolve({ acknowledged: true });
    },
    releaseReferenceMeshLease(owner) {
      const lease = hiddenLeases.get(owner.dispatchId);
      if (lease === undefined) return Promise.resolve({ released: false, absent: true });
      if (!sameCurrentMeshOwner(lease.owner, owner)) return Promise.resolve({ released: false });
      try { cache.release(lease.token); }
      catch (error) {
        // Internal partial failure provides only failed backing owners; external pre-release
        // throws have no disposition proof and keep the complete lease for a safe retry.
        const failed = cache.failedReleaseBuffers?.(lease.token);
        if (failed !== undefined) {
          const held = new Set(failed);
          lease.bodies = lease.bodies.filter(body => solidMeshBuffers(body).some(buffer => buffer instanceof ArrayBuffer && held.has(buffer)));
          changedOwner();
        }
        throw error;
      }
      hiddenLeases.delete(owner.dispatchId); changedOwner();
      return Promise.resolve({ released: true });
    },
    async readCachedBodies(items, lease, admitReply): Promise<SolidRecomputeResult> {
      if (lease !== undefined && (hiddenLeases.size + pendingHiddenDispatches.size >= 128
        || hiddenLeases.has(lease.owner.dispatchId) || pendingHiddenDispatches.has(lease.owner.dispatchId)
        || lease.owner.kind !== 'hidden' || lease.owner.dispatchId.length === 0
        || !Number.isSafeInteger(lease.limitBytes) || lease.limitBytes <= 0 || lease.limitBytes > 512 * 1024 * 1024
        || lease.owner.steps.length !== items.length
        || !items.every((item, index) => item.id === lease.owner.steps[index]?.id && item.key === lease.owner.steps[index]?.key)))
        return Promise.reject(new RangeError('Invalid reference mesh lease'));
      const token = lease === undefined ? undefined : cache.acquire(items.map(item => item.key));
      if (lease !== undefined) pendingHiddenDispatches.add(lease.owner.dispatchId);
      try {
      // Acquire protects these exact entries across native loading and concurrent key replacement.
      const captured = new Map(items.map(item => [item.key, cache.get(item.key)]));
      const oc = lease?.localMesh === undefined ? undefined : await loadOcct();
      if (lease !== undefined && hiddenLeases.has(lease.owner.dispatchId)) {
        throw new RangeError('Reference mesh owner already published');
      }
      const bodies: SolidRecomputeResult['bodies'][number][] = [];
      const failures: SolidRecomputeResult['failures'][number][] = [];
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      for (const item of items) {
        const cached = item.id.length > 0 && counts.get(item.id) === 1 ? captured.get(item.key) : undefined;
        if (cached === undefined || (cached.mesh.origins?.state === 'tracked' && cached.mesh.id !== item.id)) {
          failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
        }
        else bodies.push(lease?.localMesh === undefined || oc === undefined
          ? { ...cached.mesh, id: item.id }
          : localCachedReferenceMesh(oc, cache, cached, item.id,
            { ...lease.localMesh, maximumLiveMeshBytes: Math.min(lease.limitBytes, lease.localMesh.maximumLiveMeshBytes) },
            () => retainedMeshBuffers(), bodies));
      }
      const result = { bodies: withinReplyOriginBudget(bodies), failures,
        cacheHits: bodies.length, cancelled: false, appearanceMatches: [] };
      if (lease !== undefined && token !== undefined) {
        const final = finalMeshJsAccounting(cache.meshBufferSnapshot?.() ?? { status: 'unknown', reason: 'callback-missing' },
          displayMeshBuffers(), result.bodies.flatMap(body => solidMeshBuffers(body)), lease.limitBytes, hiddenMeshBuffers());
        if (final.status !== 'known' || final.retainedBackingBytes + final.replyCloneReservedBytes > lease.limitBytes) {
          throw new RangeError('Reference mesh backing budget unavailable');
        }
        hiddenLeases.set(lease.owner.dispatchId, { owner: capturedCurrentMeshOwner(lease.owner), token, bodies: result.bodies });
        changedOwner();
      }
      return await prepareManagedReply(lease?.owner, result, admitReply);
      } catch (error) {
        if (token !== undefined) {
          try { cache.release(token); }
          catch (cleanup) {
            if (lease !== undefined) {
              const retained = hiddenLeases.get(lease.owner.dispatchId);
              if (retained === undefined) {
                hiddenLeases.set(lease.owner.dispatchId, { owner: capturedCurrentMeshOwner(lease.owner), token, bodies: [] });
                changedOwner();
              } else {
                const failed = cache.failedReleaseBuffers?.(token);
                if (failed !== undefined) {
                  const held = new Set(failed);
                  retained.bodies = retained.bodies.filter(body => solidMeshBuffers(body).some(buffer => buffer instanceof ArrayBuffer && held.has(buffer)));
                  changedOwner();
                }
              }
            }
            return Promise.reject(new AggregateError([error, cleanup], 'Reference mesh lease cleanup failed'));
          }
        }
        if (lease !== undefined && hiddenLeases.delete(lease.owner.dispatchId)) changedOwner();
        return Promise.reject(error instanceof Error ? error : new Error('Reference mesh read failed', { cause: error }));
      } finally {
        if (lease !== undefined) pendingHiddenDispatches.delete(lease.owner.dispatchId);
      }
    },
    compareMaterials(request, shouldCancel) { return compareCachedMaterials(request, cache, loadOcct, shouldCancel); },
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
      releaseActualPart(partId);
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
      owner,
      admitReply,
    ): Promise<SolidRecomputeResult> {
      if (owner !== undefined && !ownerMatchesRequest(owner, request)) {
        phases.record('owner-rejected', owner);
        throw new RangeError('Dispatch mesh owner mismatch');
      }
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
      const result = await withAcquiredKeys(recomputeKeys(request), async () => {
        const functionLoadStarted = performance.now();
        // Empty requests still rotate display ownership and take real final receipts.
        // They need neither a first OCCT load nor a fabricated WASM-memory reading.
        const oc = request.steps.length === 0 ? undefined : await loadOcct();
        if (request.steps.some(step => step.step.kind === 'functionSurface')) {
          console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'load', elapsedMs: performance.now() - functionLoadStarted, generation: request.generation }));
        }
        const observedCancel: SolidCancelToken | undefined = cancelToken === undefined ? undefined : () => {
          phases.record('geometry-cancel-check', owner);
          try {
            const cancelled = cancelToken();
            if (typeof cancelled === 'boolean') {
              if (cancelled) phases.record('geometry-cancel-request', owner);
            } else {
              // Observe settlement without replacing the caller's original Promise or adding a native await.
              void cancelled.then(value => { if (value) phases.record('geometry-cancel-request', owner); },
                () => { phases.record('geometry-cancel-check-throw', owner); });
            }
            return cancelled;
          } catch (error) { phases.record('geometry-cancel-check-throw', owner); throw error; }
        };
        phases.record('native-build-start', owner);
        let computed: SolidRecomputeResult;
        try {
          computed = oc === undefined
            ? recomputeEmptySolids({ cache, retainedMeshBuffers }, request)
            : await runSolidRecompute(
              { oc, cache, retainedMeshBuffers }, request, options, onProgress, observedCancel,
            );
          phases.record(computed.cancelled ? 'native-build-cancelled' : 'native-build-return', owner);
        } catch (error) { phases.record('native-build-throw', owner); throw error; }
        // 取消・旧job・削除済み部品の結果で現行の最終形を置き換えない。
        if (!computed.cancelled && parts.get(partId) === part && part.job === job) {
          const meshes = displayMeshesOf(request, computed, part.revision + 1);
          const token = meshes.size === 0 ? undefined : cache.acquire(meshes.keys());
          const previous = part.token;
          part.token = token;
          part.meshes = meshes;
          if (owner === undefined) delete part.owner; else part.owner = capturedCurrentMeshOwner(owner);
          changedOwner();
          part.revision += 1;
          if (previous !== undefined) {
            cache.release(previous);
          }
        }
        // 計算ごとの返信に計算部のメモリの量を添える(NFR-PF-6)。取り消した計算でも添える。
        const memoryInstance = oc ?? loadedOcct;
        return memoryInstance === undefined ? computed : withKernelMemory(computed, memoryInstance);
      });
      // The request token is released only in withAcquiredKeys' finally. Sampling inside it,
      // even right after the display-token rotation, would still count request-protected and
      // retired shapes, so the final accounting is a separate contract taken here.
      const preResult = result.meshJsAccounting;
      if (request.localMesh === undefined || preResult === undefined) return prepareManagedReply(owner, result, admitReply);
      return prepareManagedReply(owner, {
        ...result,
        meshJsFinalAccounting: finalMeshJsAccounting(
          cache.meshBufferSnapshot?.() ?? { status: 'unknown', reason: 'callback-missing' },
          displayMeshBuffers(),
          result.bodies.flatMap((body) => solidMeshBuffers(body)),
          preResult.limitBytes,
          hiddenMeshBuffers(),
        ),
      }, admitReply);
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

    async functionSketchCurves(request): Promise<FunctionCurveSketchResult> {
      return functionCurvePolylines(await loadOcct(), request);
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
            const curves = makeSection(oc, { target: cached.shape, plane: item.plane, curveToleranceMm: item.curveToleranceMm });
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
      const work = new ExportWorkBudget(() => performance.now(), exportTriangleLimit);
      const exportItems = exportItemsOf(request);
      return withAcquiredKeys(exportItems.map((body) => body.bodyKey), async () => {
        work.checkDeadline();
        const oc = await loadOcct();
        work.checkDeadline();
        const shapes = resolveExportShapes(cache, exportItems, request.partId ?? DEFAULT_PART_ID);
        work.checkDeadline();

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
            work.admitNativeOutput(written.bytes.byteLength);
            return { format: 'step', bytes: written.bytes, colorWritten: written.colorWritten };
          }
          case 'stl': {
            // STL は三角形の網を 1 つしか持てないので、立体をそのまま順につなぐ(§2.4)。
            // 色は書かない(§0.a-0.15。仕様に無い)ので、依頼の名前と色は使わない。
            const meshes = buildExportMeshes(oc, shapes, request, work);
            work.reserveOutput(exportSerializationReserve(request.ascii ? 'stl-ascii' : 'stl-binary',
              work.triangleCount, meshes.length, exportMetadataCodeUnits(request)));
            const written = writeStl(meshes, {
              ascii: request.ascii ?? false,
            });
            work.verifySerializedOutput(written.bytes.byteLength);
            if (shapes.length > 0 && written.triangleCount === 0) {
              throw new Error('STL に書き出せる面がありません。原点に近い位置へ移動するか、STEP を使ってください。');
            }
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
            const meshes = buildExportMeshes(oc, shapes, request, work);
            work.reserveOutput(exportSerializationReserve(request.format, work.triangleCount,
              meshes.length, exportMetadataCodeUnits(request)));
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
            work.verifySerializedOutput(written.files.reduce((sum, file) =>
              checkedExportAdd(sum, file.bytes.byteLength), 0));
            return {
              format: request.format,
              files: written.files,
              triangleCount: written.triangleCount,
              droppedTriangleCount: written.droppedTriangleCount,
            };
          }
          case 'mesh': {
            const meshes = buildExportMeshes(oc, shapes, request, work);
            work.checkDeadline();
            const bodies: ShapeExportMeshBody[] = request.bodies.map((item, index) => ({
              bodyKey: item.bodyKey,
              // 形の複製に掛けるので、画面用キャッシュの三角形は 1 枚も変わらない(§0.a-0.13)。
              triangles: meshes[index],
            }));
            return { format: 'mesh', bodies };
          }
          case 'brep': {
            const bodies: ShapeExportBrepBody[] = [];
            for (const [index, item] of request.bodies.entries()) {
              work.checkDeadline();
              const bytes = writeBrepBytes(oc, shapes[index]);
              work.admitNativeOutput(bytes.byteLength);
              bodies.push({ bodyKey: item.bodyKey, bytes });
            }
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
                // 読み手が検出した開面との混在を、そのまま保存と表示へ渡す。
                toImportBody(
                  oc,
                  body.shape,
                  body.name,
                  body.color,
                  body.kind,
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
                toImportBody(oc, shape, null, null, shapeBodyKind(oc, shape)),
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

    async buildAnalysisSurfaceMesh(request): Promise<AnalysisSurfaceMeshResult> {
      const bodyKey = request.bodyKey;
      // Explicit FEM material request only: the existing finite request budget (same triangle limit, existing
      // deadline) starts on arrival and is checked in-worker; no function crosses the cloned request. Native calls
      // stay synchronous, so the deadline is observed between them, not inside them.
      const materialWork = request.materialValidation === 'native-solid'
        ? new ExportWorkBudget(() => performance.now(), exportTriangleLimit) : undefined;
      return withAcquiredKeys([bodyKey], async () => {
        const oc = await loadOcct();
        const cached = cache.get(bodyKey);
        if (cached === undefined) {
          return { kind: 'failed', bodyKey, code: 'missing-body', message: MISSING_BODY_MESSAGE, faceIndex: null };
        }
        try {
          const mesh = buildAnalysisSurfaceMesh(oc, cached.shape, {
            linearDeflection: request.linearDeflection, angularDeflection: request.angularDeflection,
            boundary: request.boundary, maximumTriangles: exportTriangleLimit,
            ...(request.materialValidation === undefined ? {} : { materialValidation: request.materialValidation }),
            ...(request.freeformRefinement === undefined ? {} : { freeformRefinement: request.freeformRefinement }),
          }, materialWork === undefined ? undefined : () => { materialWork.checkDeadline(); });
          // Face addresses must be the cached body's addresses (the display faces the origin table refers to).
          if (mesh.faces.length !== cached.mesh.faceCount) {
            return { kind: 'failed', bodyKey, code: 'face-table-mismatch',
              message: '解析用の境界の面の数が表示中のボディと一致しません。再計算してからやり直してください。', faceIndex: null };
          }
          const result: AnalysisSurfaceMeshResult = { kind: 'mesh', bodyKey, mesh };
          // The reply owns fresh arrays only; analysisMeshBuffers refuses any retained display/cache backing.
          return Comlink.transfer(result, analysisMeshBuffers(mesh,
            [...retainedMeshBuffers(), ...solidMeshBuffers(cached.mesh)]));
        } catch (error) {
          if (error instanceof AnalysisBoundaryError) {
            return { kind: 'failed', bodyKey, code: error.code, message: error.message, faceIndex: error.faceIndex };
          }
          throw error;
        }
      });
    },
  };
}
