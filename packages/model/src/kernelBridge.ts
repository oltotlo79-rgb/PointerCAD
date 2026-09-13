/**
 * model から幾何カーネルへの唯一の接点(計画書 docs/plans/P1-式とスケッチ.md タスク12、
 * docs/plans/P3-加工フィーチャー.md タスク17)。
 *
 * @pointercad/kernel の型はこの入口と kernelBridge/ 内の変換処理で使い、外へは model の型で返す
 * (P0 §0.11、rules/04-設計の規律.md の依存方向)。Workerの接続と実行はこの入口が所有し、変換処理は通信しない。
 */

import {
  createKernelWorker,
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  makeSketchChamfer,
  makeSketchFillet,
  type createKernelApi,
  matchEdge,
  matchFace,
  matchVertex,
  type AppearanceMatch,
  type AppearanceQuery,
  type FaceMeshData,
  type KernelApi,
  type ManagedKernelApi,
  type InterferenceComponentSpec,
  type InterferenceRequest,
  type InterferenceResult,
  type InterferenceProgress,
  type OffsetJoinType,
  type PlaneCurve,
  type PrintabilityProgress,
  type ShapeExportItem,
  type ShapeInspectRequest,
  type SketchOffsetItem,
  type SketchOffsetOutcome,
  type SketchPlaneFrame,
  type SketchProjectionItem,
  type SketchProjectionOutcome,
  type SketchSectionItem,
  type SketchTessellationFailure,
  type SolidBodyMesh,
  type SolidProgress,
  type SolidRecomputeRequest,
  type SolidRecomputeResult,
  type Vec2Tuple,
} from '@pointercad/kernel';
import * as Comlink from 'comlink';
import { readFunctionCurveGeometry, type FunctionKernelBridge } from './functionGeometry/functionCurveGeometry.js';
import type {
  DrawingProjectionResult,
  DrawingSectionResult,
} from './drawing/resolveDrawing.js';

import type { ExportMeshQuality } from './exchange/types.js';
import type { ResolvedSubShape } from './geometry/planeSpec.js';
import type {
  SubShapeRef,
} from './geometry/subShapeRef.js';
import type { ResolvedSolidStep } from './part/resolvePart.js';

import type { WorkPlane } from './sketch/planeMath.js';

import type {
  OffsetCornerKind,
  ResolvedCurve,
  ResolvedFace,
  SketchFaceMesh,
} from './sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from './sketch/vec3.js';

import { toCurveSpec, toFaceRequest, fromCurveSpec } from './kernelBridge/curveConversions.js';
import { toSubShapeQuery } from './kernelBridge/subShapeQuery.js';
import { toMeasureRequest, toMeasureOutcome } from './kernelBridge/measureConversions.js';
import { toShapeExportItems, toShapeExportRequest, toShapeExportOutcome, toShapeImportRequest, toShapeImportOutcome } from './kernelBridge/exchangeConversions.js';
import { toSolidStepRequest } from './kernelBridge/solidRequests.js';
import type {
  SketchFaceFailure,
  SketchTessellationOutcome,
  SketchOffsetRequestItem,
  SketchOffsetEntry,
  SketchOffsetFailure,
  SketchOffsetResult,
  SketchProjectionRequestItem,
  SketchProjectionEntry,
  SketchProjectionFailure,
  SketchProjectionResult,
  SketchCornerSegment,
  SketchCornerPlane,
  SketchFilletGeometry,
  SketchChamferGeometry,
} from './kernelBridge/sketchContracts.js';
export type {
  SketchFaceFailure,
  SketchTessellationOutcome,
  SketchOffsetRequestItem,
  SketchOffsetContour,
  SketchOffsetEntry,
  SketchOffsetFailure,
  SketchOffsetResult,
  SketchProjectionRequestItem,
  SketchProjectionEntry,
  SketchProjectionFailure,
  SketchProjectionResult,
  SketchCornerSegment,
  SketchCornerPlane,
  SketchFilletGeometry,
  SketchChamferGeometry,
  SolidBodyMeshData,
} from './kernelBridge/sketchContracts.js';
import type {
  AppearanceFaceRequest,
  AppearanceMatchEntry,
  SolidBody,
  SolidBodyFailure,
  SolidRecomputeOutcome,
  PartProgressCallback,
  PartCancelToken,
  SolidRecomputeOptions,
  MateSubShapeGeometry,
} from './kernelBridge/solidContracts.js';
export type {
  SolidFaceEntry,
  SolidEdgeEntry,
  SolidVertexEntry,
  ThreadMarkEntry,
  SolidBodyKind,
  AppearanceFaceRequest,
  AppearanceMatchEntry,
  SolidBody,
  SolidBodyFailure,
  SolidRecomputeOutcome,
  PartProgress,
  PartProgressCallback,
  PartCancelToken,
  SolidRecomputeOptions,
  MateSubShapeGeometry,
} from './kernelBridge/solidContracts.js';
import type {
  MeasureOutcome,
  PrintabilityProgressCallback,
  PrintabilityOutcome,
  PrintabilityOptions,
} from './kernelBridge/analysisContracts.js';
import type { ShapeExportOutcome, ShapeImportOutcome } from './kernelBridge/exchangeContracts.js';
export type {
  MeasureTarget,
  MeasureOutcome,
  PrintabilityPhase,
  PrintabilityProgressView,
  PrintabilityProgressCallback,
  PrintabilitySummary,
  PrintabilityReport,
  PrintabilityMeshIdentity,
  PrintabilityOutcome,
  PrintabilityOptions,
} from './kernelBridge/analysisContracts.js';
export type {
  ExportColor,
  ShapeExportBody,
  ShapeExportFormat,
  ShapeExportOptions,
  ExportedFile,
  ExportedMeshBody,
  ShapeExportOutcome,
  ShapeImportOptions,
  ImportedTriangles,
  ImportedBody,
  ShapeImportOutcome,
} from './kernelBridge/exchangeContracts.js';
import type {
  KernelBridge,
  KernelHealth,
  KernelOperationStatus,
  ShapeAvailability,
  AssemblyKernelBridge,
  AssemblyInterferenceInput,
  AssemblyInterferencePairId,
  AssemblyInterferenceOptions,
  AssemblyInterferenceProgress,
  AssemblyInterferenceReport,
  AssemblyInterferenceRootFailure,
  AssemblyInterferenceResult,
  InterferenceKernelBridge,
  MonitoredKernelBridge,
  DrawingOperationProgress,
  DrawingKernelBridge,
} from './kernelBridge/bridgeContracts.js';
export type {
  KernelBridge,
  KernelHealth,
  KernelOperationStatus,
  KernelOperationCounts,
  ShapeAvailability,
  AssemblyKernelBridge,
  AssemblyInterferenceInput,
  AssemblyInterferencePairId,
  AssemblyInterferenceOptions,
  AssemblyInterferenceProgress,
  AssemblyInterferenceMesh,
  AssemblyInterferencePair,
  AssemblyInterferencePairFailure,
  AssemblyInterferenceReport,
  AssemblyInterferenceRootFailure,
  AssemblyInterferenceResult,
  InterferenceKernelBridge,
  MonitoredKernelBridge,
  DrawingOperationOptions,
  DrawingOperationProgress,
  DrawingKernelBridge,
} from './kernelBridge/bridgeContracts.js';
export { toCurveSpec, toFaceRequest, fromCurveSpec } from './kernelBridge/curveConversions.js';
export { toSolidStepRequest } from './kernelBridge/solidRequests.js';

/**
 * 角を丸めた形を求める(FR-323)。角として成り立たないとき、半径が線の長さに
 * 収まらないときは日本語の `Error` を投げる(呼び出し側が断りへ直す)。
 */
export function sketchFilletGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  plane: SketchCornerPlane,
  radius: number,
): SketchFilletGeometry {
  return makeSketchFillet({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    plane,
    radius,
  });
}

/**
 * 角を面取りした形を求める(FR-323)。作図面を取らないのは、面取りの結果が
 * 2 つの絶対座標だけで決まるため(kernel の `makeSketchChamfer2d.ts` の注釈)。
 */
export function sketchChamferGeometry(
  line1: SketchCornerSegment,
  line2: SketchCornerSegment,
  distance1: number,
  distance2: number,
): SketchChamferGeometry {
  return makeSketchChamfer({
    line1: { kind: 'segment', from: line1.from, to: line1.to },
    line2: { kind: 'segment', from: line2.from, to: line2.to },
    distance1,
    distance2,
  });
}

/**
 * 対象の立体を作ったフィーチャーの id が、いま渡された `steps` の中に見つからなかったとき
 * (§0.a-0.30)。
 *
 * kernel(`worker/kernelApi.ts` の `MEASURE_MISSING_SHAPE_MESSAGE`)が形状キャッシュに
 * 鍵が無かったときに返すのと**同じ日本語**。kernel はこの文字列を輸出していない
 * (`KernelApi` の実装の中だけの定数)ので、断りの文言を 1 つに揃えるためここへ複製する。
 * **測定は再計算を起こさない読み取り**(§0.a-0.30)なので、鍵が引けない対象があるときは
 * カーネルを呼ばずにここで断る(古い・存在しない鍵で問い合わせて紛らわしい失敗を返させない)。
 */
const MEASURE_MISSING_SHAPE_MESSAGE = '測れませんでした。もう一度お試しください。';

/**
 * 書き出す立体の段の鍵が引けなかったとき。
 *
 * kernel(`worker/kernelApi.ts` の `MISSING_BODY_MESSAGE`)が形状キャッシュに鍵が無かった
 * ときに返すのと**同じ日本語**。kernel はこの文字列を輸出していないので、断りの文言を
 * 1 つに揃えるためここへ複製する(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱い)。
 * **1 つでも引けなければ書き出しごと断る**——一部だけ入ったファイルを渡すと、利用者は
 * 欠けに気づかないまま他の CAD へ持っていくことになる(NFR-UX-5)。
 */
const EXPORT_MISSING_SHAPE_MESSAGE = 'もとになる立体が見つかりませんでした。もう一度計算し直してください。';

/** カーネルが投げた理由を、そのまま画面へ出せる 1 行にする(文言の正本はカーネル側)。 */
function toFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * 3D プリント向けの点検(FR-815、P6 §0.51・§0.53・§2.16、タスク46 = 43a)
 * ------------------------------------------------------------------ */

/**
 * 従来の点検依頼が使っていた、画面の一般既定と同じ細かさの対。
 *
 * 現在の Worker は点検に実際の表示メッシュを使い、この値では再メッシュ化しない。
 * 値を残すのは公開済みの依頼との互換と、粗さの定数を 1 か所から参照するためである。
 *
 * **数はカーネルの既定(`DEFAULT_LINEAR_DEFLECTION` / `DEFAULT_ANGULAR_DEFLECTION`)を
 * そのまま引く**——書き写すと、画面側の既定を変えたときにここだけ古くなる。
 * 書き出しの 3 択(`EXPORT_MESH_QUALITY`)にこの対は無い(`normal` は角度が 0.2 で、
 * 書き出しの精度のために画面より細かい)ので、別に 1 つ置いてある。
 */
export const DISPLAY_MESH_QUALITY: ExportMeshQuality = {
  deviationMm: DEFAULT_LINEAR_DEFLECTION,
  angularDeflectionRad: DEFAULT_ANGULAR_DEFLECTION,
};

/**
 * 点検の三角形ごとの真偽の読み出しと、しきい値の既定を**カーネルからそのまま出し直す**。
 *
 * このファイルの決まりは「kernel の**型**を外へ出さない」(冒頭の注釈)で、値の写しを
 * 禁じてはいない。ここで出し直すのは次の 3 つだけである。
 *
 * - `readPrintabilityFlag`: 詰めたビットの並べ方(下位ビットから)を知る唯一の関数。
 *   ui が同じ式を書き写すと、並べ方を変えたときに片方だけ古くなる
 *   (`sketchFilletGeometry` を model が写さずカーネルの式を使うのと同じ判断)。
 * - `DEFAULT_MIN_THICKNESS_MM` / `DEFAULT_OVERHANG_ANGLE_DEG`: 判定のしきい値の既定。
 *   プロパティ欄の初期値に要るが、数を写すと**画面に出る値と実際に使う値が食い違う**。
 *
 * どれも素の数と純関数で、`TopoDS_Shape` のようなカーネル固有の型は 1 つも通らない。
 */
export {
  DEFAULT_MIN_THICKNESS_MM,
  DEFAULT_OVERHANG_ANGLE_DEG,
  readPrintabilityFlag,
} from '@pointercad/kernel';

/**
 * 点検する立体が 1 つも指定されていないとき。
 *
 * カーネルは三角形が 0 枚のときに `PRINTABILITY_NO_TRIANGLE_MESSAGE`(「点検できる形が
 * ありません。」)で断るが、**立体を 1 つも渡さないなら Worker を起こす意味が無い**ので
 * 同じ日本語をここで返す(測定の `MEASURE_MISSING_SHAPE_MESSAGE` と同じ扱いで、
 * 文言をそろえるために複製する)。
 */
const PRINTABILITY_NO_BODY_MESSAGE = '点検できる形がありません。';

/** 点検の依頼をカーネルの言葉へ詰め替える。 */
function toShapeInspectRequest(
  items: readonly ShapeExportItem[],
  options: PrintabilityOptions,
): ShapeInspectRequest {
  const quality = options.meshQuality ?? DISPLAY_MESH_QUALITY;
  return {
    partId: options.partId,
    bodies: items,
    deviationMm: quality.deviationMm,
    angularDeflectionRad: quality.angularDeflectionRad,
    minThicknessMm: options.minThicknessMm,
    overhangAngleDeg: options.overhangAngleDeg,
  };
}

/**
 * 点検する立体を、書き出しと同じ「段の鍵の一覧」へ引き直す。
 *
 * **名前も色も点検では使わない**(`ShapeInspectRequest` の注釈)ので `null` を入れる。
 * 引き直しそのものは書き出しと同じ関数(`toShapeExportItems`)に任せる——鍵が引けない
 * ときの判断を 2 か所に書かないため。
 */
function toShapeInspectItems(
  steps: readonly ResolvedSolidStep[],
  bodies: readonly string[],
): readonly ShapeExportItem[] | null {
  return toShapeExportItems(
    steps,
    bodies.map((featureId) => ({ featureId, name: null, color: null })),
  );
}

/**
 * 点検の進捗を model の言葉へ写す(Comlink を通らない直結の橋のぶん)。
 *
 * Worker 版は `toPrintabilityProgressProxy` が同じ写しを Comlink.proxy で包んで行う。
 * 写しそのものを 2 か所に書かないよう、包まない版をここに置いてあちらから使う。
 */
function printabilityProgressOf(
  onProgress: PrintabilityProgressCallback | undefined,
): ((progress: PrintabilityProgress) => void) | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  return (progress: PrintabilityProgress) => {
    onProgress({
      phase: progress.phase,
      processed: progress.processed,
      total: progress.total,
      ratio: progress.ratio,
    });
  };
}

/** 点検の結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。 */
type KernelPrintabilityResult = Awaited<ReturnType<KernelApi['inspectPrintability']>>;

export function toPrintabilityOutcome(result: KernelPrintabilityResult): PrintabilityOutcome {
  return {
    kind: 'inspected',
    report: {
      triangleCount: result.triangleCount,
      thinTriangles: result.thinTriangles,
      overhangTriangles: result.overhangTriangles,
      openEdgeTriangles: result.openEdgeTriangles,
      meshes: result.meshes,
      summary: {
        triangleCount: result.summary.triangleCount,
        degenerateCount: result.summary.degenerateCount,
        inspectedTriangleCount: result.summary.inspectedTriangleCount,
        thinCount: result.summary.thinCount,
        overhangCount: result.summary.overhangCount,
        openEdgeCount: result.summary.openEdgeCount,
        openEdgeTriangleCount: result.summary.openEdgeTriangleCount,
        watertight: result.summary.watertight,
        minThicknessFoundMm: result.summary.minThicknessFoundMm,
        minThicknessMm: result.summary.minThicknessMm,
        overhangAngleDeg: result.summary.overhangAngleDeg,
        cellSizeMm: result.summary.cellSizeMm,
      },
      cancelled: result.cancelled,
    },
  };
}

/** 角の作り方(model の言葉)をカーネルの言葉へ直す。 */
function toJoinType(corner: OffsetCornerKind): OffsetJoinType {
  return corner === 'sharp' ? 'intersection' : 'arc';
}

/** オフセット 1 件の依頼をカーネルの言葉へ直す。 */
function toOffsetItem(request: SketchOffsetRequestItem): SketchOffsetItem {
  return {
    id: request.featureId,
    curves: request.curves.map((curve) => toCurveSpec(curve)),
    distance: request.distance,
    joinType: toJoinType(request.corner),
  };
}

/** オフセットが返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_OFFSET_MESSAGE = 'カーネルからオフセットの結果が返りませんでした。';

/**
 * オフセットの結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は、理由を補って失敗として扱う(FR-504。
 * 面の詰め替え `toOutcome` と同じ書き方)。
 */
export function toOffsetResult(
  requests: readonly SketchOffsetRequestItem[],
  outcome: SketchOffsetOutcome,
): SketchOffsetResult {
  const results: SketchOffsetEntry[] = outcome.results.map((result) => ({
    featureId: result.id,
    contours: result.contours.map((contour) => ({
      curves: contour.curves.map((curve) => fromCurveSpec(curve, result.id)),
      closed: contour.closed,
    })),
  }));
  const failures: SketchOffsetFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_OFFSET_MESSAGE });
    }
  }

  return { results, failures };
}

/* ------------------------------------------------------------------ *
 * 投影・交差の詰め替え(FR-325、P4 タスク25)
 * ------------------------------------------------------------------ */

/** 作図面の 2 次元座標をワールド座標へ戻す。第 2 軸は `WorkPlane.axisV`(= 法線 × 第 1 軸)。 */
function planePointToWorld(plane: WorkPlane, uv: Vec2Tuple): Vec3 {
  return addVec3(
    plane.origin,
    addVec3(scaleVec3(plane.axisU, uv[0]), scaleVec3(plane.axisV, uv[1])),
  );
}

/**
 * カーネルが返した作図面の上の曲線を、model の解決済みの曲線へ戻す(FR-325)。
 *
 * - 線分・円弧は形のまま残る(投影のほとんどの用途がここに入る。`makeProjection.ts`)。
 * - 点列(傾いた円・楕円・自由曲線)は**通過点のスプライン**として受ける。
 *   `ResolvedSpline` は通過点しか持たない型なので、そのまま詰められる
 *   (`fromCurveSpec` の注釈が予告していた「B スプラインが返る道」がこれ)。
 *
 * 円弧の角度は「第 1 軸から第 2 軸へ回る向きが正」で、`ResolvedArc` の約束と同じ
 * (`makeProjection.ts` の `PlaneArc` の注釈)。そのまま渡してよい。
 */
export function fromPlaneCurve(
  curve: PlaneCurve,
  plane: WorkPlane,
  featureId: string,
): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return {
        kind: 'segment',
        featureId,
        from: planePointToWorld(plane, curve.from),
        to: planePointToWorld(plane, curve.to),
      };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: planePointToWorld(plane, curve.center),
        normal: plane.normal,
        xAxis: plane.axisU,
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'polyline':
      return {
        kind: 'spline',
        featureId,
        mode: 'interpolate',
        points: curve.points.map((point) => planePointToWorld(plane, point)),
        closed: curve.closed,
      };
  }
}

/** 作図面を kernel の言葉へ直す。第 2 軸は kernel が「法線 × 第 1 軸」で作り直す。 */
function toPlaneFrame(plane: WorkPlane): SketchPlaneFrame {
  return { origin: plane.origin, axisU: plane.axisU, normal: plane.normal };
}

/** 投影の依頼をカーネルの言葉へ直す。 */
function toProjectionItem(request: SketchProjectionRequestItem): SketchProjectionItem {
  return {
    id: request.featureId,
    shapeKey: request.bodyKey,
    subShape: request.source === null ? null : toSubShapeQuery(request.source),
    plane: toPlaneFrame(request.plane),
  };
}

/** 交差の依頼をカーネルの言葉へ直す(切るのは立体そのものなので指紋は渡さない)。 */
function toSectionItem(request: SketchProjectionRequestItem): SketchSectionItem {
  return {
    id: request.featureId,
    ...(request.curveToleranceMm === undefined ? {} : { curveToleranceMm: request.curveToleranceMm }),
    shapeKey: request.bodyKey,
    plane: toPlaneFrame(request.plane),
  };
}

/** 投影・交差が返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_PROJECTION_MESSAGE = 'カーネルから投影・交差の結果が返りませんでした。';

/**
 * 投影・交差の結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は理由を補って失敗にする(`toOffsetResult` と同じ)。
 */
export function toProjectionResult(
  requests: readonly SketchProjectionRequestItem[],
  outcome: SketchProjectionOutcome,
): SketchProjectionResult {
  const planeByFeature = new Map(requests.map((request) => [request.featureId, request.plane]));
  const preciseFeatures = new Set(requests.filter((request) => request.curveToleranceMm !== undefined).map((request) => request.featureId));
  const results: SketchProjectionEntry[] = [];
  const failures: SketchProjectionFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  for (const result of outcome.results) {
    const plane = planeByFeature.get(result.id);
    if (plane === undefined) {
      // 頼んでいない id が返ることは無いが、返ってきても黙って捨てず理由を残す。
      failures.push({ featureId: result.id, message: MISSING_PROJECTION_MESSAGE });
      continue;
    }
    results.push({
      featureId: result.id,
      curves: result.curves.flatMap((curve) => {
        if (curve.kind !== 'polyline' || !preciseFeatures.has(result.id)) return [fromPlaneCurve(curve, plane, result.id)];
        // 精密出力の折線を補間スプラインへ読み替えない。受け取った弦をそのまま保持する。
        return curve.points.slice(0, curve.closed ? undefined : -1).map((point, index) => fromPlaneCurve({
          kind: 'segment', from: point, to: curve.points[(index + 1) % curve.points.length],
        }, plane, result.id));
      }),
    });
  }

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_PROJECTION_MESSAGE });
    }
  }

  return { results, failures };
}

/* ------------------------------------------------------------------ *
 * 外観の面の照合(FR-1106、P5 §2.2.3、タスク4)
 * ------------------------------------------------------------------ */

/**
 * 外観を割り当てた面を、カーネルへの照合の依頼へ詰め替える(§2.2.3)。
 *
 * **依頼が 1 件も無ければ空配列を返す。** カーネルは空なら照合の段そのものを飛ばし、
 * 物差し(境界箱の対角長)を測るための OCCT の呼び出しも 1 回も行わない
 * (§0.a-0.54「外観の追加で所要を増やさない」)。
 *
 * 次の 2 つは依頼に乗せずに落とす。落とした割り当ては `toAppearanceMatches` が
 * `faceIndex: null`(= 見つからない)で必ず補うので、件数は依頼元と食い違わない。
 *
 * - **段が見つからない割り当て**: そのフィーチャーが履歴から消えた、抑制された、
 *   ブーリアンに消費された場合。鍵が引けないので照合しようがない。
 * - **面以外の指紋**: 外観は面にしか付かない(`AppearanceTarget`)が、指紋の型は
 *   辺・頂点も表せるので、種類で守る(カーネルも面以外は断る)。
 */
export function toAppearanceQueries(
  steps: readonly ResolvedSolidStep[],
  requests: readonly AppearanceFaceRequest[],
): readonly AppearanceQuery[] {
  if (requests.length === 0) {
    return [];
  }
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const queries: AppearanceQuery[] = [];
  for (const request of requests) {
    const bodyKey = keyByFeatureId.get(request.bodyFeatureId);
    if (bodyKey === undefined || request.ref.fingerprint.kind !== 'face') {
      continue;
    }
    queries.push({ id: request.id, bodyKey, query: toSubShapeQuery(request.ref) });
  }
  return queries;
}

/**
 * 照合の結果を model の言葉へ詰め替える(§2.2.3)。
 *
 * **戻りは依頼(`requests`)と同じ並び・同じ件数**で、依頼に乗せなかったもの・
 * カーネルが返さなかったものは `faceIndex: null` で補う。呼び出し側(ui)は
 * 「見つからない割り当てが n 件」を数えるだけでよく、どこで落ちたかを気にしなくて済む。
 *
 * ボディの id は**文書側の値をそのまま返す**。カーネルは面の属するボディが
 * 見つからないときに空文字を返す約束だが、見つかったときの値は「段の id = ボディの id」
 * (§0.a-0.5)より必ず `request.bodyFeatureId` と同じなので、空文字を外へ出す意味が無い。
 */
export function toAppearanceMatches(
  requests: readonly AppearanceFaceRequest[],
  matches: readonly AppearanceMatch[] | undefined,
): readonly AppearanceMatchEntry[] {
  if (requests.length === 0) {
    return [];
  }
  const faceIndexById = new Map((matches ?? []).map((match) => [match.id, match.faceIndex]));
  return requests.map((request) => ({
    id: request.id,
    bodyFeatureId: request.bodyFeatureId,
    faceIndex: faceIndexById.get(request.id) ?? null,
  }));
}

/**
 * 立体の再計算の依頼を 1 つ組み立てる(Worker 版と直結版で同じものを使う)。
 *
 * ## 段ごとの三角形分割の粗さ(§2.13、§0.a-0.54)について
 *
 * `SolidStepRequest.tessellation` にはここでは何も入れず、**粗さの規則はカーネルに
 * 1 か所だけ置いたままにする**(`recomputeSolids.ts` の `isRelaxableSweepStep`。
 * ばねと実らせんのねじ穴を 0.15 / 0.7 へ緩める、P3 仕上げ (a) の実測)。
 * 同じ規則を model にも書くと 2 か所になり、片方だけ直したときに食い違うため。
 * カーネルは「段ごとの指定 > 全体の指定 > 段の種類の既定」の順で選ぶので、ここで
 * 値を添えるとカーネルの既定の方が負けてしまう。基本形状(球・トーラス)を緩める案は
 * **効き目が無いことがタスク14 で実測された**(球 r10 は 0.8 を添えても 978 枚のまま)
 * ので入れない。利用者が粗さを選べるようにする段になったら、その値だけをここへ通す。
 */
function toSolidRecomputeRequest(
  steps: readonly ResolvedSolidStep[],
  options: SolidRecomputeOptions,
): SolidRecomputeRequest {
  return {
    partId: options.partId,
    steps: steps.map((step) => toSolidStepRequest(step)),
    generation: options.generation ?? 0,
    appearanceQueries: toAppearanceQueries(steps, options.appearance ?? []),
    measureAreas: options.measureAreas ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * 部分形状の選び直し(FR-325・FR-328〜330 の上流追従、P4 タスク25)— 同期の純関数
 * ------------------------------------------------------------------ */

/**
 * 位置の点を部品の大きさで割るための長さ(境界箱の対角長の半分)。
 *
 * カーネル側(`makeHole.ts` 等)は `boundingDiagonal`(OCCT の `Bnd_Box`)で測るが、
 * model は B-rep を持たないので**三角形の頂点の並び**から同じ量を測る。
 * 三角形は形の表面を覆っているので、境界箱は実用上ほぼ一致する(曲面では
 * 近似の分だけわずかに小さく出るが、位置の点は 0〜1 の連続な値で、しきい値
 * (`SUB_SHAPE_MATCH_THRESHOLD`)の判定がこの差で覆るほど敏感ではない)。
 */
function matchScaleOf(body: SolidBody): number {
  const positions = body.mesh.positions;
  if (positions.length < 3) {
    return 0;
  }
  const low: [number, number, number] = [positions[0], positions[1], positions[2]];
  const high: [number, number, number] = [positions[0], positions[1], positions[2]];
  for (let index = 3; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) * 0.5;
}

/**
 * 指紋に最も近い面・辺・頂点を、いまのボディの中から選び直す(FR-325、FR-330、タスク25)。
 *
 * 採点は kernel の `matchFace` / `matchEdge` / `matchVertex`(OCCT を使わない純関数)を
 * そのまま使うので、**重み・しきい値・同点の決め方は加工フィーチャーと完全に同じ**である
 * (§0.a-0.4)。この関数を通すと、スケッチの頂点参照・作業平面・基準ジオメトリが
 * 「保存された指紋の位置」ではなく「いまの形の位置」を見るようになる。
 *
 * 届かなければ null(呼び出し側が `missingSubShape` で断る、FR-504)。
 * Worker を通らない同期の純関数なので、`KernelBridge` のメソッドにはしない
 * (`sketchFilletGeometry` と同じ扱い、このファイルの §「なぜ Worker を往復しないのか」)。
 */
export function selectSubShape(body: SolidBody, reference: SubShapeRef): ResolvedSubShape | null {
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'face',
        position: found.centroid,
        axis: found.axis,
        surfaceKind: found.surfaceKind,
        curveKind: null,
      };
    }
    case 'edge': {
      const match = matchEdge(body.edges, query, scale);
      const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'edge',
        position: found.midpoint,
        axis: found.axis,
        surfaceKind: null,
        curveKind: found.curveKind,
      };
    }
    case 'vertex': {
      const match = matchVertex(body.vertices, query, scale);
      const found =
        match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
      if (found === undefined) {
        return null;
      }
      return {
        kind: 'vertex',
        position: found.position,
        axis: null,
        surfaceKind: null,
        curveKind: null,
      };
    }
  }
}

/**
 * 合致のため、現在の形から種類・大きさ・重心・解析軸上点を選び直す(P7-14b)。
 * selectSubShape と同じ kernel の採点を使い、重心を解析点で置き換えない。
 * body は部品座標の形。アセンブリの配置は resolveMateTarget が1回だけ掛ける。
 */
export function selectMateTargetGeometry(
  body: SolidBody,
  reference: SubShapeRef,
): MateSubShapeGeometry | null {
  if (body.featureId !== reference.bodyFeatureId) return null;
  const query = toSubShapeQuery(reference);
  const scale = matchScaleOf(body);
  switch (query.kind) {
    case 'face': {
      const match = matchFace(body.faces, query, scale);
      const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
      if (found === undefined) return null;
      return {
        kind: 'face',
        surfaceKind: found.surfaceKind,
        area: found.area,
        position: found.centroid,
        axis: found.axis,
        radius: found.radius,
        ...(found.axisOrigin == null ? {} : { axisOrigin: found.axisOrigin }),
      };
    }
    case 'edge': {
      const match = matchEdge(body.edges, query, scale);
      const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
      if (found === undefined) return null;
      return {
        kind: 'edge',
        curveKind: found.curveKind,
        length: found.length,
        position: found.midpoint,
        axis: found.axis,
        radius: found.radius,
        ...(found.axisOrigin == null ? {} : { axisOrigin: found.axisOrigin }),
      };
    }
    case 'vertex': {
      const match = matchVertex(body.vertices, query, scale);
      const found =
        match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
      return found === undefined ? null : { kind: 'vertex', position: found.position };
    }
  }
}

/**
 * 部品を差し替えた後のボディから、保存し直せる部分形状参照を作る(FR-614)。
 * 採点・しきい値・同点時の選択は `selectSubShape` と同じ kernel の純関数を使う。
 * 見つからなければ元の参照を消さずに残せるよう `null` を返す。
 */
export function rematchSubShapeRef(
  bodies: readonly SolidBody[],
  reference: SubShapeRef,
): SubShapeRef | null {
  const preferred = bodies.filter((body) => body.featureId === reference.bodyFeatureId);
  const candidates = preferred.length > 0 ? preferred : bodies;
  const query = toSubShapeQuery(reference);
  for (const body of candidates) {
    const scale = matchScaleOf(body);
    switch (query.kind) {
      case 'face': {
        const match = matchFace(body.faces, query, scale);
        const found = match === null ? undefined : body.faces.find((face) => face.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: {
              kind: 'face', surfaceKind: found.surfaceKind, area: found.area,
              position: found.centroid, axis: found.axis, radius: found.radius,
            },
          };
        }
        break;
      }
      case 'edge': {
        const match = matchEdge(body.edges, query, scale);
        const found = match === null ? undefined : body.edges.find((edge) => edge.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: {
              kind: 'edge', curveKind: found.curveKind, length: found.length,
              position: found.midpoint, axis: found.axis, radius: found.radius,
            },
          };
        }
        break;
      }
      case 'vertex': {
        const match = matchVertex(body.vertices, query, scale);
        const found = match === null ? undefined : body.vertices.find((vertex) => vertex.index === match.index);
        if (found !== undefined) {
          return {
            bodyFeatureId: body.featureId,
            index: found.index,
            fingerprint: { kind: 'vertex', position: found.position },
          };
        }
        break;
      }
    }
  }
  return null;
}

/** 立体が消えたとき(画面に出すはずの段の結果も理由も返らなかったとき)に付ける理由。 */
const MISSING_BODY_MESSAGE = 'カーネルから立体が返りませんでした。';

/**
 * カーネルの結果を model のボディへ詰め替える。妥当性の判定は SolidBody.isValid の注釈のとおり。
 * `faces` / `edges` / `vertices` / `threadMarks` は kernel の一覧と欄の名前・形が同じなので
 * (計画書 §2.8)、詰め替えは配列をそのまま渡すだけで済む(model 独自の型として持つのは
 * `SolidFaceEntry` 等の型そのものを kernel から再輸出しないためで、値の変形は要らない)。
 */
function toSolidBody(mesh: SolidBodyMesh): SolidBody {
  return {
    featureId: mesh.id,
    mesh: {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      edgePositions: mesh.edgePositions,
      triangleCount: mesh.triangleCount,
    },
    volume: mesh.volume,
    // 表面積は依頼が求めたときだけカーネルが測る(SolidRecomputeOptions.measureAreas)。
    // 測っていなければ欄ごと空のまま渡し、0 と偽らない。
    area: mesh.area,
    // 形の種類はカーネルの必須の欄(§0.a-0.77、タスク42b)なので、そのまま写す。
    // 判定は kernel の `hasSolid` そのままで、体積では決めない(体積 8000 の開いた殻がある)。
    bodyKind: mesh.bodyKind,
    isValid: mesh.triangleCount > 0 && Number.isFinite(mesh.volume) && (mesh.bodyKind === 'shell' || mesh.volume > 0),
    faces: mesh.faces,
    edges: mesh.edges,
    vertices: mesh.vertices,
    threadMarks: mesh.threadMarks,
  };
}

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 画面に出すはずの段(visible)なのにボディも理由も返らなかったものは、
 * 黙って消えないよう理由を補って失敗として扱う(FR-504。面の詰め替えと同じ書き方)。
 */
export function toSolidOutcome(
  steps: readonly ResolvedSolidStep[],
  result: SolidRecomputeResult,
  appearance: readonly AppearanceFaceRequest[] = [],
): SolidRecomputeOutcome {
  const bodies = result.bodies.map((mesh) => toSolidBody(mesh));
  const collected: SolidBodyFailure[] = result.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  const reported = new Set<string>(bodies.map((body) => body.featureId));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const step of steps) {
    // 途中で打ち切られた段は「まだ計算していない」だけなので、失敗にしない(NFR-PF-4)。
    if (step.visible && !reported.has(step.featureId) && !result.cancelled) {
      collected.push({ featureId: step.featureId, message: MISSING_BODY_MESSAGE });
    }
  }

  return {
    bodies,
    failures: collected,
    cacheHits: result.cacheHits,
    cancelled: result.cancelled,
    appearanceMatches: toAppearanceMatches(appearance, result.appearanceMatches),
  };
}

/** 1ジョブが貸すcallbackと、その輸送に使ったportの所有者。 */
interface KernelCallbackScope {
  readonly active: boolean;
  proxy<T extends object>(callback: T): T;
  serialize(callback: object): [MessagePort, Transferable[]];
  size(): number;
  close(): void;
}

const callbackOwners = new WeakMap<object, KernelCallbackScope>();
let callbackHandlerInstalled = false;

/** Worker側の標準proxy読み手を保ち、こちらが所有するportだけをジョブ終了時に閉じる。 */
function installCallbackHandler(): void {
  if (callbackHandlerInstalled) return;
  const original = Comlink.transferHandlers.get('proxy');
  if (original === undefined) throw new Error('Comlink proxy transfer handler is unavailable');
  Comlink.transferHandlers.set('proxy', {
    canHandle: original.canHandle.bind(original),
    deserialize: original.deserialize.bind(original),
    serialize(value: unknown) {
      if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
        const owner = callbackOwners.get(value);
        if (owner !== undefined) return owner.serialize(value);
      }
      return original.serialize(value);
    },
  });
  callbackHandlerInstalled = true;
}

function createKernelCallbackScope(onClose: () => void): KernelCallbackScope {
  installCallbackHandler();
  const callbacks = new Set<object>();
  const cleanups = new Set<() => void>();
  let active = true;
  const scope: KernelCallbackScope = {
    get active() { return active; },
    proxy(callback) {
      callbacks.add(callback);
      callbackOwners.set(callback, scope);
      return Comlink.proxy(callback);
    },
    serialize(callback) {
      const { port1, port2 } = new MessageChannel();
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const endpoint: Comlink.Endpoint = {
        postMessage: (message: unknown, transfer?: Transferable[]) => {
          if (active) port1.postMessage(message, transfer ?? []);
        },
        addEventListener: (type, listener) => {
          listeners.add(listener);
          port1.addEventListener(type, listener);
        },
        removeEventListener: (type, listener) => {
          listeners.delete(listener);
          port1.removeEventListener(type, listener);
        },
        start: () => port1.start(),
      };
      Comlink.expose(callback, endpoint);
      cleanups.add(() => {
        for (const listener of listeners) port1.removeEventListener('message', listener);
        listeners.clear();
        port1.close();
        port2.close();
      });
      return [port2, [port2]];
    },
    size: () => callbacks.size,
    close() {
      if (!active) return;
      active = false;
      for (const callback of callbacks) callbackOwners.delete(callback);
      callbacks.clear();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      onClose();
    },
  };
  return scope;
}

/** 進捗をComlinkで渡せる関数にし、終了後の遅れて届いた通知を捨てる。 */
function toProgressProxy(
  onProgress: PartProgressCallback | undefined,
  scope: KernelCallbackScope,
): ((progress: SolidProgress) => void) | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  return scope.proxy((progress: SolidProgress) => {
    if (!scope.active) return;
    onProgress({
      featureId: progress.stepId,
      index: progress.index,
      total: progress.total,
      label: progress.label,
    });
  });
}

/**
 * 点検の進捗を受け取る関数を Comlink.proxy で包む(`toProgressProxy` と同じ理由)。
 *
 * 写しそのもの(kernel の値 → model の 4 欄)は `printabilityProgressOf` が持つ。
 * **写さずにそのまま渡すことはしない**——kernel の値をそのまま外へ出すと、あとで
 * カーネル側に欄が増えたときに model の型に無い欄が混ざる(`toSolidBody` と同じ扱い)。
 */
function toPrintabilityProgressProxy(
  onProgress: PrintabilityProgressCallback | undefined,
  scope: KernelCallbackScope,
): ((progress: PrintabilityProgress) => void) | undefined {
  const copy = printabilityProgressOf(onProgress);
  return copy === undefined ? undefined : scope.proxy((progress: PrintabilityProgress) => {
    if (scope.active) copy(progress);
  });
}

declare global {
  interface Window {
    /**
     * **検査専用の口**(P5、NFR-PF-4 の E2E)。アプリはこの値を 1 か所も書かない。
     *
     * 正の数を入れておくと、立体の**段と段の間**(カーネルが中止を尋ねてくるところ)で
     * 毎回この ms だけ待ってから答える。頁の外(Playwright)から入れるためだけにあり、
     * 入っていなければ(通常の道では `undefined`)待ちは 1 ミリ秒も挟まらない。
     */
    pcadDebugStepDelayMs?: number;
  }
}

/**
 * 段と段の間に挟む検査専用の待ち(ms)。入っていなければ 0(= 待たない)。
 *
 * Node の検査や Worker の中には `window` が無いので、まず有無を見る。
 */
function debugStepDelayMs(): number {
  if (typeof window === 'undefined') {
    return 0;
  }
  const value = window.pcadDebugStepDelayMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/**
 * 中止を尋ねる関数も同じ理由で Comlink.proxy で包む(§1.2-5)。
 *
 * ここに**検査専用の遅延の口**(`window.pcadDebugStepDelayMs`)を 1 つだけ挟んである。
 * カーネルは段と段の間でこの関数を `await` して答えを待つ(`recomputeSolids` の
 * 「中止の口が渡されているときだけ制御を譲る」)ので、ここで待つと**計算そのものが
 * その ms だけ延びる**。長い計算(NFR-PF-4 の帯と「中止」)を機械の速さに頼らず作れる。
 * CPU を絞って長い計算を作る手は、共有の遅いランナーでは検査が時間切れになった
 * (rules/06 10.14)。値が入っていない通常の道では `shouldCancel()` をそのまま返し、
 * 約束(Promise)すら作らない。
 */
function toCancelProxy(
  shouldCancel: PartCancelToken | undefined,
  scope: KernelCallbackScope,
): (() => boolean | Promise<boolean>) | undefined {
  if (shouldCancel === undefined) {
    return undefined;
  }
  return scope.proxy(() => {
    if (!scope.active) return true;
    const delayMs = debugStepDelayMs();
    if (delayMs === 0) {
      return shouldCancel();
    }
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(!scope.active || shouldCancel());
      }, delayMs);
    });
  });
}

/** 面が消えたとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_FACE_MESSAGE = 'カーネルから面が返りませんでした。';

/** 色が引けないときの塗り色。解決済みの面には必ず色があるので、通常は使わない。 */
const FALLBACK_FACE_COLOR = '#ffffff';

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 依頼したのに面もエラーも返らなかった id は、理由を補って失敗として扱う(FR-504)。
 */
function toOutcome(
  faces: readonly ResolvedFace[],
  meshes: readonly FaceMeshData[],
  failures: readonly SketchTessellationFailure[],
): SketchTessellationOutcome {
  const colorByFeature = new Map(faces.map((face) => [face.featureId, face.color]));
  const built: SketchFaceMesh[] = meshes.map((mesh) => ({
    featureId: mesh.id,
    color: colorByFeature.get(mesh.id) ?? FALLBACK_FACE_COLOR,
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    // 線分1本あたり 6 要素(始点 xyz + 終点 xyz)の並び(docs/報告記録.md 2026-09-02 21:03)。
    boundaryPositions: mesh.boundaryPositions,
  }));

  const reported = new Set<string>(built.map((mesh) => mesh.featureId));
  const collected: SketchFaceFailure[] = failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const face of faces) {
    if (!reported.has(face.featureId)) {
      collected.push({ featureId: face.featureId, message: MISSING_FACE_MESSAGE });
    }
  }

  return { mesh: { faces: built }, failures: collected };
}

/**
 * Worker が壊れたときに利用者へ見せる理由(NFR-RE-1、§2.9、§0.a-0.19)。
 * OCCT の C++ 側が `abort()` すると WASM ごと止まり、以後どの依頼にも応答しなくなる。
 * この場合いまの再計算はやり直せないので、値を戻すよう案内する。
 */
export const KERNEL_BROKEN_MESSAGE =
  'カーネルが止まりました。値を元に戻してから、もう一度お試しください。';

export function createKernelHealth(): KernelHealth {
  let broken = false;
  return {
    get broken(): boolean {
      return broken;
    },
    markBroken(): void {
      broken = true;
    },
    reset(): void {
      broken = false;
    },
  };
}

type InterruptedStatus = 'cancelled' | 'workerBroken';
type BrokenRace<T> =
  | { readonly kind: 'response'; readonly result: T }
  | { readonly kind: InterruptedStatus };

interface KernelConnection {
  readonly worker: Worker;
  readonly remote: Comlink.Remote<ReturnType<typeof createKernelApi>>;
  readonly waiters: Set<() => void>;
  readonly counts: Record<KernelOperationStatus, number>;
  readonly results: WeakMap<object, KernelOperationStatus>;
  readonly handleBroken: () => void;
  readonly closeTransport: () => void;
  interruption: InterruptedStatus | null;
  closed: boolean;
}

function interruptKernelConnection(connection: KernelConnection, kind: InterruptedStatus): void {
  connection.interruption ??= kind;
  const waiting = [...connection.waiters];
  connection.waiters.clear();
  for (const notify of waiting) notify();
}

function createKernelConnection(
  onBroken: () => void,
  counts: Record<KernelOperationStatus, number>,
  results: WeakMap<object, KernelOperationStatus>,
): KernelConnection {
  const worker = createKernelWorker();
  const localReplies = new EventTarget();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const endpoint: Comlink.Endpoint = {
    postMessage(message: unknown, transfer?: Transferable[]) {
      // Comlink 4のreleaseProxyはvoidを返し、内部Promiseを呼出側ではcatchできない。
      // 終了するWorkerへRELEASEを送らず、その後始末だけをローカルで決着する。
      if (connection.closed && typeof message === 'object' && message !== null
        && 'type' in message && message.type === 'RELEASE' && 'id' in message) {
        localReplies.dispatchEvent(new MessageEvent('message', { data: { id: message.id, type: 'RAW', value: undefined } }));
        return;
      }
      worker.postMessage(message, transfer ?? []);
    },
    addEventListener(type, listener) { listeners.add(listener); worker.addEventListener(type, listener); localReplies.addEventListener(type, listener); },
    removeEventListener(type, listener) { listeners.delete(listener); worker.removeEventListener(type, listener); localReplies.removeEventListener(type, listener); },
  };
  const connection: KernelConnection = {
    worker,
    remote: Comlink.wrap<ReturnType<typeof createKernelApi>>(endpoint),
    waiters: new Set(),
    counts,
    results,
    interruption: null,
    closed: false,
    closeTransport() {
      for (const listener of listeners) { worker.removeEventListener('message', listener); localReplies.removeEventListener('message', listener); }
      listeners.clear();
    },
    handleBroken: () => {
      if (connection.closed) return;
      onBroken();
      interruptKernelConnection(connection, 'workerBroken');
    },
  };
  worker.addEventListener('error', connection.handleBroken);
  worker.addEventListener('messageerror', connection.handleBroken);
  return connection;
}

function operationStatus(result: unknown): KernelOperationStatus {
  if (typeof result === 'object' && result !== null) {
    if (('cancelled' in result && result.cancelled === true) ||
        ('kind' in result && result.kind === 'cancelled')) return 'cancelled';
    if (('kind' in result && result.kind === 'failed') ||
        ('failures' in result && Array.isArray(result.failures) && result.failures.length > 0)) {
      return 'failed';
    }
  }
  return 'success';
}

/** 返す値を変えず、文書や結果の寿命を延ばさないWeakMapに決着理由を添える。 */
function rememberOperation<T>(connection: KernelConnection, status: KernelOperationStatus, result: T): T {
  connection.counts[status] += 1;
  if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
    connection.results.set(result, status);
  }
  return result;
}

/**
 * Workerが黙ったまま壊れても全RPCを決着させる(§2.9)。共有Promiseのthenは使わず、
 * 呼び出しごとの通知を登録する。同期送信失敗もfinallyを通し、通知とcallbackを解放する。
 * 破損・disposeは既存のrefuseの値で返す。決着理由はoperationStatus(result)で区別する。
 */
async function raceWithBroken<T>(
  connection: KernelConnection,
  request: () => Promise<T>,
  refuse: () => T,
  callbacks?: KernelCallbackScope,
): Promise<T> {
  let notify: () => void = () => undefined;
  try {
    if (connection.interruption !== null) {
      return rememberOperation(connection, connection.interruption, refuse());
    }
    const interrupted = new Promise<BrokenRace<T>>((resolve) => {
      notify = () => resolve({ kind: connection.interruption ?? 'workerBroken' });
      connection.waiters.add(notify);
    });
    const race = await Promise.race<BrokenRace<T>>([
      request().then((result) => ({ kind: 'response', result })),
      interrupted,
    ]);
    if (race.kind !== 'response') {
      return rememberOperation(connection, race.kind, refuse());
    }
    return rememberOperation(connection, operationStatus(race.result), race.result);
  } catch (error: unknown) {
    rememberOperation(connection, 'failed', error);
    throw error;
  } finally {
    connection.waiters.delete(notify);
    callbacks?.close();
  }
}

/**
 * 壊れたときの断りの一覧。**依頼した 1 件ごとに 1 つ**、理由は `KERNEL_BROKEN_MESSAGE`。
 * 面・オフセット・投影・断面はどれも「1 件失敗しても残りは返す」形(FR-504)なので、
 * 全件をこの理由の失敗にすれば、呼び手は普段の失敗と同じ道で画面へ出せる。
 */
function brokenFailures(
  items: readonly { readonly featureId: string }[],
): readonly { readonly featureId: string; readonly message: string }[] {
  return items.map((item) => ({ featureId: item.featureId, message: KERNEL_BROKEN_MESSAGE }));
}

/** 接続を締める。壊れた Worker への解放要求が失敗しても、後始末は続ける(NFR-RE-1)。 */
function closeKernelConnection(connection: KernelConnection): void {
  if (connection.closed) return;
  connection.closed = true;
  interruptKernelConnection(connection, 'cancelled');
  connection.worker.removeEventListener('error', connection.handleBroken);
  connection.worker.removeEventListener('messageerror', connection.handleBroken);
  try {
    connection.remote[Comlink.releaseProxy]();
  } catch {
    // Worker がすでに応答しない状態では解放の要求自体が失敗しうるが、
    // 呼び出し側は必ず worker.terminate() へ進むので実害は無い。
  }
  connection.closeTransport();
  connection.worker.terminate();
}

/** 保存配置へ後退せず、現在表示されている世界配置と完了body群をawait前に写す。 */
function toInterferenceRequest(input: AssemblyInterferenceInput, options: AssemblyInterferenceOptions): InterferenceRequest {
  return {
    requestId: input.requestId,
    components: input.components.map((component): InterferenceComponentSpec => {
      const componentId = component.id;
      if (component.suppressed) return { kind: 'excluded', componentId, reason: 'suppressed' };
      if (!component.visible) return { kind: 'excluded', componentId, reason: 'hidden' };
      const partKey = input.resolved.partKeys.get(componentId);
      const part = partKey === undefined ? undefined : input.resolved.parts.get(partKey);
      if (partKey === undefined || part === undefined || part.errors.length > 0) return {
        kind: 'unavailable', componentId, code: 'unresolvedPart', message: '部品の計算結果がありません。',
      };
      const placement = input.placements.get(componentId);
      if (placement === undefined) return { kind: 'unavailable', componentId, code: 'invalidPlacement', message: '部品の現在の位置がありません。' };
      const completed = input.bodies.get(partKey);
      if (completed === undefined || part.liveBodyIds.length === 0) return { kind: 'unavailable', componentId,
        code: 'missingBody', message: '部品の立体の計算が完了していません。' };
      const bodyKeys: string[] = [];
      for (const id of part.liveBodyIds) {
        const body = completed.find((entry) => entry.featureId === id);
        const step = part.steps.find((entry) => entry.featureId === id && entry.visible);
        if (body === undefined) return { kind: 'unavailable', componentId, code: 'missingBody',
          message: '部品の立体の計算が完了していません。', ...(step === undefined ? {} : { missingKeys: [step.key] }) };
        if (body.bodyKind !== 'solid') return { kind: 'unavailable', componentId, code: 'unsupportedBody', message: '面や三角形だけの部品は調べられません。' };
        if (step === undefined || !body.isValid) return { kind: 'unavailable', componentId, code: 'missingBody', message: '部品の立体を取得できません。' };
        bodyKeys.push(step.key);
      }
      return { kind: 'ready', componentId, bodyKeys: [...new Set(bodyKeys)].sort(), placement: {
        position: [...placement.position],
        rotation: [...placement.rotation],
      } };
    }),
    ...(options.pairs === undefined ? {} : { pairs: options.pairs.map(([a, b]): AssemblyInterferencePairId => [a, b]) }),
    ...(options.ignoredPairs === undefined ? {} : { ignoredPairs: options.ignoredPairs.map(([a, b]): AssemblyInterferencePairId => [a, b]) }),
  };
}

function interferenceProgressOf(progress: InterferenceProgress): AssemblyInterferenceProgress {
  return { requestId: progress.requestId, phase: progress.phase, completedPairs: progress.completedPairs,
    totalPairs: progress.totalPairs, completedComponents: progress.completedComponents, totalComponents: progress.totalComponents,
    ...(progress.currentPair === undefined ? {} : { currentPair: [progress.currentPair[0], progress.currentPair[1]] }) };
}

function toInterferenceResult(result: InterferenceResult): AssemblyInterferenceResult {
  const report: AssemblyInterferenceReport = {
    requestId: result.requestId, totalPairCount: result.totalPairCount, checkedPairCount: result.checkedPairCount,
    skippedPairCount: result.skippedPairCount, pendingPairCount: result.pendingPairCount, cancelled: result.cancelled,
    pairs: result.pairs.map((pair) => ({ aComponentId: pair.aComponentId, bComponentId: pair.bComponentId,
      volume: pair.volume, mesh: { positions: pair.mesh.positions, normals: pair.mesh.normals,
        indices: pair.mesh.indices, triangleCount: pair.mesh.triangleCount } })),
    failures: result.failures.map((failure) => ({ pair: [failure.pair[0], failure.pair[1]], stage: failure.stage,
      code: failure.code, message: failure.message,
      ...(failure.missingKeys === undefined ? {} : { missingKeys: [...failure.missingKeys] }),
      ...(failure.cleanupMessages === undefined ? {} : { cleanupMessages: [...failure.cleanupMessages] }) })),
    skips: result.skips.map((skip) => ({ pair: [skip.pair[0], skip.pair[1]], reason: skip.reason })),
  };
  return result.kind === 'checked' ? { ...report, kind: 'checked', failure: null }
    : { ...report, kind: 'failed', failure: { code: result.failure.code, message: result.failure.message,
      ...(result.failure.cleanupMessages === undefined ? {} : { cleanupMessages: [...result.failure.cleanupMessages] }) } };
}

/** 輸送自体が決着しなかった組はpending。計算済み・clearを捏造しない。 */
function refusedInterference(request: InterferenceRequest, failure: AssemblyInterferenceRootFailure, cancelled = false): AssemblyInterferenceResult {
  const total = request.pairs === undefined ? request.components.length * (request.components.length - 1) / 2
    : new Set(request.pairs.map(([a, b]) => JSON.stringify([a, b].sort()))).size;
  const report: AssemblyInterferenceReport = { requestId: request.requestId, pairs: [], failures: [], skips: [],
    totalPairCount: total, checkedPairCount: 0, skippedPairCount: 0, pendingPairCount: total, cancelled };
  return cancelled ? { ...report, kind: 'checked', failure: null } : { ...report, kind: 'failed', failure };
}

export function createKernelBridge(): MonitoredKernelBridge & DrawingKernelBridge & FunctionKernelBridge {
  const health = createKernelHealth();
  const counts: Record<KernelOperationStatus, number> = {
    success: 0, failed: 0, cancelled: 0, workerBroken: 0,
  };
  const callbackScopes = new Set<KernelCallbackScope>();
  const results = new WeakMap<object, KernelOperationStatus>();
  let disposed = false;
  let connection = createKernelConnection(() => health.markBroken(), counts, results);
  function callbackScope(): KernelCallbackScope {
    const scope = createKernelCallbackScope(() => callbackScopes.delete(scope));
    callbackScopes.add(scope);
    return scope;
  }

  /**
   * 壊れた Worker を締めて作り直す(§2.9、§0.a-0.19)。形状キャッシュは Worker の中にあるので
   * 作り直すと空になり、次の再計算は全段作り直しになる(遅くなるが落ちない、この限界は
   * `KernelBridge.recomputeSolids` の doc comment にも書いた)。
   */
  function restart(): void {
    closeKernelConnection(connection);
    health.reset();
    connection = createKernelConnection(() => health.markBroken(), counts, results);
  }

  return {
    pendingWaiters: () => connection.waiters.size,
    async hiddenLineViews(request, options = {}) {
      if (health.broken && !disposed) restart();
      const active = connection;
      const failed = (): DrawingProjectionResult => ({ views: [], cancelled: false,
        failures: [{ viewId: null, bodyId: null, message: KERNEL_BROKEN_MESSAGE }] });
      const callbacks = callbackScope();
      const progress = options.onProgress;
      return raceWithBroken(active, () => active.remote.hiddenLineViews(request,
        progress === undefined ? undefined : callbacks.proxy((value: DrawingOperationProgress) => { if (callbacks.active) progress(value); }),
        toCancelProxy(options.shouldCancel, callbacks)).catch(failed), failed, callbacks);
    },
    async sectionViews(request, options = {}) {
      if (health.broken && !disposed) restart();
      const active = connection;
      const failed = (): DrawingSectionResult => ({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], cancelled: false,
        failures: [{ viewId: request.view.id, bodyId: null, message: KERNEL_BROKEN_MESSAGE }] });
      const callbacks = callbackScope();
      const progress = options.onProgress;
      return raceWithBroken(active, () => active.remote.sectionViews(request,
        progress === undefined ? undefined : callbacks.proxy((value: DrawingOperationProgress) => { if (callbacks.active) progress(value); }),
        toCancelProxy(options.shouldCancel, callbacks)).catch(failed), failed, callbacks);
    },
    operationCounts: () => ({ ...counts }),
    operationStatus: (result) =>
      (typeof result === 'object' && result !== null) || typeof result === 'function'
        ? results.get(result) : undefined,
    pendingCallbacks: () => [...callbackScopes].reduce((sum, scope) => sum + scope.size(), 0),
    async checkInterference(input, options = {}): Promise<AssemblyInterferenceResult> {
      const request = toInterferenceRequest(input, options);
      const active = connection;
      const callbacks = callbackScope();
      const onProgress = options.onProgress;
      const progress = onProgress === undefined ? undefined : callbacks.proxy((value: InterferenceProgress) => {
        if (callbacks.active) onProgress(interferenceProgressOf(value));
      });
      return raceWithBroken(active, async () => {
        try {
          return toInterferenceResult(await active.remote.checkInterference(request, progress,
            toCancelProxy(options.shouldCancel ?? (() => false), callbacks), 'message'));
        } catch (error) {
          return refusedInterference(request, { code: 'rpcFailed', message: toFailureMessage(error) });
        }
      }, () => refusedInterference(request, { code: 'workerBroken', message: KERNEL_BROKEN_MESSAGE },
        active.interruption === 'cancelled'), callbacks);
    },
    async releasePart(partId): Promise<void> {
      const active = connection;
      return raceWithBroken(active, () => active.remote.releasePart(partId), () => undefined);
    },
    async checkShapeAvailability(partId, bodyKeys): Promise<ShapeAvailability> {
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.checkShapeAvailability(partId, bodyKeys),
        () => ({ partId, missingKeys: [...new Set(bodyKeys)] }),
      );
    },
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      // 線・円弧の折れ線は UI が自前で作るので、カーネルへは面だけを頼む
      // (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
      return raceWithBroken(
        active,
        () => active.remote
          .tessellateSketch({
            curves: [],
            faces: faces.map((face) => toFaceRequest(face)),
          })
          .then((result) => toOutcome(faces, result.faces, result.failures)),
        // 面は 1 枚も作れていないので、頼んだ全部を壊れた理由の失敗にする(FR-504)。
        () => ({ mesh: { faces: [] }, failures: brokenFailures(faces) }),
      );
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      const request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      const callbacks = callbackScope();
      // 第 2 引数は全体のテッセレーションの粗さ。段の種類ごとの既定はカーネルが持っており
      // (toSolidRecomputeRequest の注釈)、ここで値を渡すとその既定が負けるので undefined。
      return raceWithBroken(
        active,
        () => active.remote
          .recomputeSolids(
            request,
            undefined,
            toProgressProxy(options.onProgress, callbacks),
            toCancelProxy(options.shouldCancel, callbacks),
          )
          .then((result) => toSolidOutcome(steps, result, options.appearance ?? [])),
        // Worker がこの依頼の途中で壊れた。拒否せずに理由つきの失敗として解決する
        // (recomputePart.ts が kernelFailed として拾う。§0.a-0.19「拒否しない」)。
        // 消費されて画面に出ないはずの段(visible: false)は、成功しても失敗しても
        // 利用者には見えないので失敗に数えない(toSolidOutcome の扱いと揃える)。
        () => ({
          bodies: [],
          failures: brokenFailures(steps.filter((step) => step.visible)),
          cacheHits: 0,
          cancelled: false,
          // 照合そのものを行えていないので空で返す。ここで全件を「見つからない」にすると、
          // 段の失敗の警告に「色を付けた面が見つかりません」を重ねてしまう(FR-504)。
          appearanceMatches: [],
        }),
        callbacks,
      );
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .offsetSketchCurves({ items: requests.map((request) => toOffsetItem(request)) })
          .then((outcome) => toOffsetResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async functionSketchCurves(input) {
      if (health.broken && !disposed) restart();
      const active = connection;
      return raceWithBroken(active,
        () => active.remote.functionSketchCurves({ components: input.components, bounds: input.bounds,
          ...(input.bezier === undefined ? {} : { bezier: input.bezier }) })
          .then((outcome) => readFunctionCurveGeometry(outcome, input)),
        () => ({ status: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .projectSketchCurves({ items: requests.map((request) => toProjectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote
          .sectionSketchCurves({ items: requests.map((request) => toSectionItem(request)) })
          .then((outcome) => toProjectionResult(requests, outcome)),
        () => ({ results: [], failures: brokenFailures(requests) }),
      );
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、Worker を起こさずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.measure(request).then((result) => toMeasureOutcome(result)),
        // 測定の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.exportShapes(toShapeExportRequest(items, options)).then(
          (result) => toShapeExportOutcome(result, options),
          // カーネルが断ったとき(鍵が消えていた・書けなかった)は理由をそのまま持ち回る。
          // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        // 書き出しの結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      return raceWithBroken(
        active,
        () => active.remote.importShape(toShapeImportRequest(options)).then(
          (result) => toShapeImportOutcome(result),
          (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
        ),
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
      );
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        // 点検する形が 1 つも無いので Worker を起こさない(§0.a-0.30)。
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、Worker を起こさずここで断る(測定と同じ)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      // 前の依頼の途中で Worker が壊れていたら、今回の依頼を出す前に作り直す(§2.9)。
      if (health.broken && !disposed) {
        restart();
      }
      const active = connection;
      const callbacks = callbackScope();
      return raceWithBroken(
        active,
        () => active.remote
          .inspectPrintability(
            toShapeInspectRequest(items, options),
            toPrintabilityProgressProxy(options.onProgress, callbacks),
            toCancelProxy(options.shouldCancel, callbacks),
          )
          .then(
            (result) => toPrintabilityOutcome(result),
            // カーネルが断ったとき(鍵が消えていた・三角形が 0 枚)は理由をそのまま持ち回る。
            // **拒否のまま競わせない**——拒否は `raceWithBroken` を素通りしてしまうため。
            (error: unknown) => ({ kind: 'failed', message: toFailureMessage(error) }),
          ),
        // 点検の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている断り
        // (`kind: 'failed'`。理由の文はそのまま画面へ出る)で解決する。
        () => ({ kind: 'failed', message: KERNEL_BROKEN_MESSAGE }),
        callbacks,
      );
    },

    dispose(): void {
      disposed = true;
      closeKernelConnection(connection);
      for (const scope of callbackScopes) scope.close();
    },
  };
}

type PartLifetimeApi = KernelApi & Pick<AssemblyKernelBridge, 'releasePart' | 'checkShapeAvailability'>;

/** Node統合検査用。基底の旧overload/fakeへ新しい必須能力を要求しない。 */
export function createDirectInterferenceKernelBridge(api: ManagedKernelApi): InterferenceKernelBridge {
  const bridge = createDirectKernelBridge(api);
  let disposed = false;
  return {
    ...bridge,
    async checkInterference(input, options = {}): Promise<AssemblyInterferenceResult> {
      const request = toInterferenceRequest(input, options);
      const onProgress = options.onProgress;
      const shouldCancel = options.shouldCancel;
      try {
        return toInterferenceResult(await api.checkInterference(request,
          onProgress === undefined ? undefined : (progress) => { if (!disposed) onProgress(interferenceProgressOf(progress)); },
          () => disposed || (shouldCancel?.() ?? false)));
      } catch (error) { return refusedInterference(request, { code: 'rpcFailed', message: toFailureMessage(error) }); }
    },
    dispose() { disposed = true; bridge.dispose(); },
  };
}

function hasPartLifetime(api: KernelApi): api is PartLifetimeApi {
  return 'releasePart' in api && typeof api.releasePart === 'function' &&
    'checkShapeAvailability' in api && typeof api.checkShapeAvailability === 'function';
}

/**
 * Worker を通さず、同じプロセスの `KernelApi` へ直につなぐ橋(P4 タスク25)。
 *
 * **本番では使わない。** ブラウザ・Electron は必ず `createKernelBridge`(Worker 版)を使う
 * (幾何カーネルは Web Worker 上で動かす、rules/04・NFR-PF-4)。この関数があるのは、
 * **Node の検査で「部品文書の経路が実カーネルで最後まで通る」ことを確かめる**ためである
 * (t21 の教訓: 偽の橋だけでは配線もれが見つからない。`docs/報告記録.md` 2026-09-04 21:05)。
 *
 * Worker が無いので壊れの検知・作り直し(§2.9)は持たない。`dispose` も何もしない
 * (形状キャッシュは渡された `KernelApi` の持ち物で、寿命は呼び出し側が決める)。
 */
export function createDirectKernelBridge(api: PartLifetimeApi): AssemblyKernelBridge & DrawingKernelBridge & FunctionKernelBridge;
export function createDirectKernelBridge(api: KernelApi): KernelBridge & DrawingKernelBridge & FunctionKernelBridge;
export function createDirectKernelBridge(api: KernelApi): KernelBridge & DrawingKernelBridge & FunctionKernelBridge {
  return {
    async functionSketchCurves(input) {
      return readFunctionCurveGeometry(await api.functionSketchCurves({ components: input.components, bounds: input.bounds,
        ...(input.bezier === undefined ? {} : { bezier: input.bezier }) }), input);
    },
    hiddenLineViews: (request, options = {}) => api.hiddenLineViews(request, options.onProgress, options.shouldCancel),
    sectionViews: (request, options = {}) => api.sectionViews(request, options.onProgress, options.shouldCancel),
    ...(hasPartLifetime(api) ? {
      releasePart: (partId: string) => api.releasePart(partId),
      checkShapeAvailability: (partId: string, bodyKeys: readonly string[]) =>
        api.checkShapeAvailability(partId, bodyKeys),
    } : {}),
    async tessellateSketchFaces(faces): Promise<SketchTessellationOutcome> {
      if (faces.length === 0) {
        return { mesh: { faces: [] }, failures: [] };
      }
      const result = await api.tessellateSketch({
        curves: [],
        faces: faces.map((face) => toFaceRequest(face)),
      });
      return toOutcome(faces, result.faces, result.failures);
    },

    async recomputeSolids(steps, options = {}): Promise<SolidRecomputeOutcome> {
      if (steps.length === 0) {
        return { bodies: [], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
      }
      const request: SolidRecomputeRequest = toSolidRecomputeRequest(steps, options);
      // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
      const result = await api.recomputeSolids(
        request,
        undefined,
        options.onProgress === undefined
          ? undefined
          : (progress: SolidProgress) =>
              options.onProgress?.({
                featureId: progress.stepId,
                index: progress.index,
                total: progress.total,
                label: progress.label,
              }),
        options.shouldCancel,
      );
      return toSolidOutcome(steps, result, options.appearance ?? []);
    },

    async offsetSketchCurves(requests): Promise<SketchOffsetResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.offsetSketchCurves({
        items: requests.map((request) => toOffsetItem(request)),
      });
      return toOffsetResult(requests, outcome);
    },

    async projectSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.projectSketchCurves({
        items: requests.map((request) => toProjectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async sectionSketchCurves(requests): Promise<SketchProjectionResult> {
      if (requests.length === 0) {
        return { results: [], failures: [] };
      }
      const outcome = await api.sectionSketchCurves({
        items: requests.map((request) => toSectionItem(request)),
      });
      return toProjectionResult(requests, outcome);
    },

    async measure(steps, targets, kind): Promise<MeasureOutcome> {
      const request = toMeasureRequest(steps, targets, kind);
      if (request === null) {
        // 鍵が引けない対象があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: MEASURE_MISSING_SHAPE_MESSAGE };
      }
      const result = await api.measure(request);
      return toMeasureOutcome(result);
    },

    async exportShapes(steps, options): Promise<ShapeExportOutcome> {
      const items = toShapeExportItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(NFR-UX-5)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        return toShapeExportOutcome(
          await api.exportShapes(toShapeExportRequest(items, options)),
          options,
        );
      } catch (error) {
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async importShape(options): Promise<ShapeImportOutcome> {
      try {
        return toShapeImportOutcome(await api.importShape(toShapeImportRequest(options)));
      } catch (error) {
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    async inspectPrintability(steps, options): Promise<PrintabilityOutcome> {
      if (options.bodies.length === 0) {
        return { kind: 'failed', message: PRINTABILITY_NO_BODY_MESSAGE };
      }
      const items = toShapeInspectItems(steps, options.bodies);
      if (items === null) {
        // 鍵が引けない立体があるので、カーネルを呼ばずここで断る(§0.a-0.30)。
        return { kind: 'failed', message: EXPORT_MISSING_SHAPE_MESSAGE };
      }
      try {
        // Comlink を通らないので、進捗・中止の関数は proxy で包まずそのまま渡せる。
        return toPrintabilityOutcome(
          await api.inspectPrintability(
            toShapeInspectRequest(items, options),
            printabilityProgressOf(options.onProgress),
            options.shouldCancel,
          ),
        );
      } catch (error) {
        // Worker 版と同じく、断りは投げずに理由つきの失敗で返す(NFR-RE-1)。
        return { kind: 'failed', message: toFailureMessage(error) };
      }
    },

    dispose(): void {
      // Worker を持たないので閉じるものが無い。
    },
  };
}
