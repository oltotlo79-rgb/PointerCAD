import type { DrawingRenderView } from '@pointercad/drawing';
import type { DrawingProjectionCurve, ResolvedDrawingView } from '@pointercad/model';

function curveOwner(viewId: string, item: DrawingProjectionCurve): string {
  const occurrence = item.provenance.occurrenceId;
  return typeof occurrence === 'string' && occurrence !== ''
    ? `projection:${JSON.stringify([viewId, occurrence])}` : viewId;
}

/** 組図の各線を配置IDへ関連付ける。見た目と線の順序は全出力で共通。 */
export function drawingProjectionRenderViews(views: readonly ResolvedDrawingView[]): readonly DrawingRenderView[] {
  return views.map((view) => ({ viewId: view.viewId, cuttingCurves: view.cuttingCurves,
    visible: view.visible.map((item) => ({ curve: item.curve, ownerId: curveOwner(view.viewId, item) })),
    hidden: view.hidden.map((item) => ({ curve: item.curve, ownerId: curveOwner(view.viewId, item) })) }));
}

/** 表の行は全ビューの同じ配置を、ビューの選択はその図だけを強調する。 */
export function selectedDrawingProjectionOwners(views: readonly ResolvedDrawingView[], selectedIds: readonly string[]): ReadonlySet<string> {
  const selected = new Set(selectedIds), owners = new Set(selectedIds);
  for (const view of views) for (const item of [...view.visible, ...view.hidden]) {
    const occurrence = item.provenance.occurrenceId;
    if (selected.has(view.viewId) || typeof occurrence === 'string' && selected.has(`component:${occurrence}`)) {
      owners.add(curveOwner(view.viewId, item));
    }
  }
  return owners;
}
