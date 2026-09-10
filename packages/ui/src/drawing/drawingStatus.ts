import { paperSizeOf, type DrawingDocument } from '@pointercad/drawing';
import type { DrawingRefreshResult } from '@pointercad/model';

/** 表示だけの縮尺比。非標準値を丸めて別の縮尺として表示しない。 */
export function drawingScaleRatio(scale: number): string | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const reciprocal = 1 / scale;
  return scale < 1 && Number.isSafeInteger(reciprocal) ? `1:${reciprocal}` : `${scale}:1`;
}

export interface DrawingStatusGeometry {
  readonly scaleRatio: string | null;
  readonly viewName: string | null;
  readonly paperLabel: string | null;
  /** nullは現在の文書の再評価待ち。未解決0件とは区別する。 */
  readonly unresolvedCount: number | null;
}

export function drawingStatusGeometry(
  drawing: DrawingDocument | null,
  resolution: DrawingRefreshResult | null,
  selectedIds: readonly string[],
): DrawingStatusGeometry {
  if (drawing === null) return { scaleRatio: null, viewName: null, paperLabel: null, unresolvedCount: null };
  const ids = new Set(selectedIds);
  const views = drawing.views.filter((view) => ids.has(view.id));
  const view = views.length === 1 ? views[0] : undefined;
  const current = resolution?.ok === true && resolution.document === drawing ? resolution : null;
  const resolvedView = view === undefined ? undefined : current?.projection.viewFrames?.get(view.id)?.view;
  return {
    scaleRatio: view?.construction?.kind === 'detail' && current === null ? null
      : drawingScaleRatio(resolvedView?.scale ?? view?.scale ?? drawing.sheet.scale),
    viewName: view?.name ?? null,
    paperLabel: paperSizeOf(drawing.sheet.paperSizeId)?.label ?? null,
    unresolvedCount: resolution?.ok === true && resolution.document === drawing ? resolution.unresolvedCount : null,
  };
}
