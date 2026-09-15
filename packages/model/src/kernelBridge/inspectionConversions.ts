/** 点検の依頼・結果・進捗だけを変換する。通信と既定の精度は呼出元が所有する。 */
import type { KernelApi, PrintabilityProgress, ShapeExportItem, ShapeInspectRequest } from '@pointercad/kernel';
import type { ExportMeshQuality } from '../exchange/types.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { PrintabilityOptions, PrintabilityOutcome, PrintabilityProgressCallback } from './analysisContracts.js';
import { toShapeExportItems } from './exchangeConversions.js';

/** 点検の依頼をカーネルの言葉へ詰め替える。 */
export function toShapeInspectRequest(
  items: readonly ShapeExportItem[],
  options: PrintabilityOptions,
  defaultQuality: ExportMeshQuality,
): ShapeInspectRequest {
  const quality = options.meshQuality ?? defaultQuality;
  return {
    partId: options.partId,
    bodies: items,
    deviationMm: quality.deviationMm,
    angularDeflectionRad: quality.angularDeflectionRad,
    minThicknessMm: options.minThicknessMm,
    overhangAngleDeg: options.overhangAngleDeg,
  };
}

/** 点検では名前と色を使わない。鍵の欠落の判断は書き出しと共用する。 */
export function toShapeInspectItems(
  steps: readonly ResolvedSolidStep[],
  bodies: readonly string[],
): readonly ShapeExportItem[] | null {
  return toShapeExportItems(
    steps,
    bodies.map((featureId) => ({ featureId, name: null, color: null })),
  );
}

/** 直結とWorkerの両方で、同じ4欄の進捗をmodelの形式へ写す。 */
export function printabilityProgressOf(
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

type KernelPrintabilityResult = Awaited<ReturnType<KernelApi['inspectPrintability']>>;

/** 点検の結果をmodelの言葉へ詰め替え、表示メッシュの同一性と取消を保持する。 */
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
