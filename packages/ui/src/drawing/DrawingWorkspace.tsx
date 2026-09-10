import { t } from '../i18n/t.js';
import type { MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { DrawingCanvas } from './DrawingCanvas.js';
import { drawingStatusGeometry } from './drawingStatus.js';
export { DrawingToolbar } from './DrawingToolbar.js';
export { DRAWING_TOOL_GROUPS, DRAWING_DIMENSION_KINDS } from './drawingToolbarItems.js';
export { DrawingTree } from '../shell/DrawingTree.js';
export { DrawingPropertyPanel } from './DrawingPropertyPanel.js';

export const DRAWING_TREE_KEYS = [
  'drawing.tree.views', 'drawing.tree.dimensions', 'drawing.tree.annotations',
  'drawing.tree.tables', 'drawing.tree.layers',
] as const satisfies readonly MessageKey[];

export const DRAWING_PROPERTY_KEYS = [
  'drawing.property.sheet', 'drawing.property.view', 'drawing.property.dimension',
  'drawing.property.annotation', 'drawing.property.table', 'drawing.property.layer',
] as const satisfies readonly MessageKey[];

export function DrawingViewport(): React.JSX.Element {
  return <DrawingCanvas />;
}

export function DrawingStatusBar(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const selected = useAppStore((state) => state.drawingSelectedIds);
  const message = useAppStore((state) => state.drawingMessage);
  const fileMessage = useAppStore((state) => state.fileMessage);
  const busy = useAppStore((state) => state.drawingBusy);
  const resolution = useAppStore((state) => state.drawingResolution);
  const geometry = drawingStatusGeometry(drawing, resolution, selected);
  const unresolved = geometry.unresolvedCount ?? 0;
  return (
    <footer className="pcad-statusbar">
      <span className="pcad-statusbar__message" aria-live="polite">
        <span className="pcad-statusbar__text">{fileMessage === null ? message ?? (busy ? t('drawing.status.computing')
          : unresolved > 0 ? t('drawing.dimension.unresolvedCount').replace('{count}', String(unresolved)) : t('drawing.status.ready')) : t(fileMessage.key)}</span>
      </span>
      <span className="pcad-statusbar__spacer" />
      <span className="pcad-statusbar__state" title={geometry.viewName ?? t('drawing.property.sheet')} data-testid="drawing-status-scale">
        {t('drawing.status.scale').replace('{ratio}', geometry.scaleRatio ?? '—')}
      </span>
      <span className="pcad-statusbar__state" title={t('drawing.status.paperHint')} data-testid="drawing-status-paper">
        {geometry.paperLabel ?? '—'}
      </span>
      <span className="pcad-statusbar__state" title={t('drawing.status.unresolvedHint')} data-testid="drawing-status-unresolved">
        {t('drawing.status.unresolved').replace('{count}', geometry.unresolvedCount === null ? '—' : String(geometry.unresolvedCount))}
      </span>
    </footer>
  );
}
