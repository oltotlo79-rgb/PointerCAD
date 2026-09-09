import type { DrawingDocument, DrawingSource } from '@pointercad/drawing';
import { resolveDrawingDimensions, type ResolvedDrawingDimension } from './dimensionTarget.js';
import { resolveDrawingWithSource, type DrawingResolutionOptions, type DrawingResolveKernel, type DrawingSourceResolution, type ResolvedDrawing } from './resolveDrawing.js';
import { replaceDrawingSource, type DrawingSourceInput, type DrawingSourceLibrary } from './sourceLibrary.js';

export interface DrawingRefreshOptions extends DrawingResolutionOptions {
  /** ファイル監視結果。異なっていても承諾なしに抱き込みを上書きしない。 */
  readonly externalContentHash?: string;
  /** 再評価した元形状から自動寸法を再生成する。手動の寸法は呼出側も保持する。 */
  readonly regenerateAutoDimensions?: (document: DrawingDocument, source: DrawingSourceResolution) => DrawingDocument | null;
}
export type DrawingRefreshResult =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly document: DrawingDocument; readonly projection: Extract<ResolvedDrawing, { ok: true }>;
      readonly dimensions: readonly ResolvedDrawingDimension[]; readonly unresolvedCount: number;
      readonly sourceChangedExternally: boolean };

/** 利用者が取り込み直す操作を行った場合にだけ、同じ参照鍵の抱き込み文書を差し替える。 */
export async function replaceSource(
  drawing: DrawingDocument, library: DrawingSourceLibrary, input: DrawingSourceInput, importedAt?: string,
): Promise<{ readonly document: DrawingDocument; readonly library: DrawingSourceLibrary } | null> {
  if (!library.sources.some((source) => source.metadata.sourceRef === drawing.source.sourceRef)) return null;
  const next = await replaceDrawingSource(library, drawing.source.sourceRef, input, { importedAt });
  const metadata = next.sources.find((source) => source.metadata.sourceRef === drawing.source.sourceRef)?.metadata;
  return metadata === undefined ? null : { document: { ...drawing, source: metadata }, library: next };
}

export function drawingSourceChangedExternally(source: DrawingSource, contentHash: string | undefined): boolean {
  return contentHash !== undefined && contentHash.length > 0 && contentHash !== source.contentHash;
}

/** 投影と寸法を同じ再評価結果から作る。投影の再利用は既存の方向/内容ハッシュの鍵に従う(P8-39)。 */
export async function refreshDrawing(
  drawing: DrawingDocument, kernel: DrawingResolveKernel, options: DrawingRefreshOptions = {},
): Promise<DrawingRefreshResult> {
  try {
    const source = await kernel.prepareDrawingSource(drawing.source);
    const regenerated = options.regenerateAutoDimensions?.(drawing, source);
    if (regenerated === null) return { ok: false, message: '自動寸法を作り直せませんでした。' };
    const document = regenerated ?? drawing;
    // 自動寸法の再生成が手動の寸法を変更することを境界でも拒否する。
    const originals = drawing.dimensions.filter((dimension) => dimension.origin === 'manual');
    if (originals.some((original) => {
      const next = document.dimensions.find((dimension) => dimension.id === original.id);
      return next === undefined || JSON.stringify(next) !== JSON.stringify(original);
    })) return { ok: false, message: '手動の寸法を保ったまま作り直せませんでした。' };
    const projection = await resolveDrawingWithSource(document, kernel, source, options);
    if (!projection.ok) return projection;
    const dimensions = resolveDrawingDimensions(document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
    return { ok: true, document, projection, dimensions,
      unresolvedCount: dimensions.filter((dimension) => dimension.status === 'unresolved').length,
      sourceChangedExternally: drawingSourceChangedExternally(drawing.source, options.externalContentHash) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '図面を作り直せませんでした。' };
  }
}
